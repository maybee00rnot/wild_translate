import {
    eventSource,
    event_types,
    messageFormatting,
    saveSettingsDebounced,
    generateRaw,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

const extensionName = 'inline-translator';
const generateRawUnsafe = /** @type {any} */ (generateRaw);

// ---------- defaults ----------

const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'llm',
    translatorService: 'google',
    deeplApiKey: '',
    targetLang: 'ru',
    translateArabic: true,
    translateCjk: true,
    translateLatin: true,
    translateOther: true,
    whitelist: 'HP, MP, XP, Lv, EXP, NPC, PvP, PvE, DnD, OOC, IC, PM, DM, GM',
    skipCodeBlocks: true,
    skipTags: true,
    showIndicator: true,
    connectionProfileId: '',
};

// ---------- script classification ----------

const WORD_RE = /[\p{L}\p{M}'’\-]+/gu;
const LETTER_RE = /\p{L}/u;
const CYRILLIC_LETTER_RE = /\p{Script=Cyrillic}/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
const ARABIC_LETTER_RE = /\p{Script=Arabic}/u;
const CJK_LETTER_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const MAX_TOKEN_CALLS_PER_SENTENCE = 5;

// ---------- state ----------

let currentAbortController = null;
const inProgress = new Set();
let debugLog = [];
const DEBUG_LOG_LIMIT = 50;

// ---------- settings ----------

function getSettings() {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    const s = extension_settings[extensionName];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function getWhitelist() {
    return getSettings().whitelist
        .split(',')
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
}

function isWhitelisted(word) {
    return getWhitelist().includes(String(word).toLowerCase());
}

// ---------- connection profile helpers ----------

function getCurrentProfileName() {
    try {
        const cm = extension_settings?.connectionManager;
        if (!cm || !cm.selectedProfile) return '';
        const profile = cm.profiles?.find((p) => p.id === cm.selectedProfile);
        return profile ? profile.name : '';
    } catch { return ''; }
}

function getExtensionProfileId() {
    return extension_settings[extensionName]?.connectionProfileId || '';
}

function getExtensionProfileName() {
    const id = getExtensionProfileId();
    if (!id) return '';
    const profile = extension_settings?.connectionManager?.profiles?.find(
        (p) => p.id === id,
    );
    return profile?.name || '';
}

async function switchProfile(profileName) {
    const cm = extension_settings?.connectionManager;
    if (!cm || !cm.profiles) return;
    const profilesSelect = document.getElementById('connection_profiles');
    if (!profilesSelect) return;
    let targetId = '';
    if (profileName) {
        const profile = cm.profiles.find((p) => p.name === profileName);
        if (profile) targetId = profile.id;
    }
    const awaitPromise = new Promise((resolve) => {
        const onLoaded = () => {
            eventSource.removeListener(event_types.CONNECTION_PROFILE_LOADED, onLoaded);
            resolve();
        };
        eventSource.on(event_types.CONNECTION_PROFILE_LOADED, onLoaded);
        setTimeout(() => {
            eventSource.removeListener(event_types.CONNECTION_PROFILE_LOADED, onLoaded);
            resolve();
        }, 5000);
    });
    /** @type {HTMLSelectElement} */ (profilesSelect).value = targetId;
    profilesSelect.dispatchEvent(new Event('change'));
    await awaitPromise;
    await new Promise((r) => setTimeout(r, 500));
}

function updateProfilesList() {
    const select = $('#it-connection-profile');
    if (!select.length) return;
    const savedId = getExtensionProfileId();
    select.empty().append('<option value="">Same as current (fast)</option>');
    try {
        const cm = extension_settings?.connectionManager;
        if (cm && cm.profiles) {
            for (const p of cm.profiles) {
                select.append($('<option></option>').val(p.id).text(p.name));
            }
        }
    } catch { /* ignore */ }
    select.val(savedId);
}

// ---------- detection ----------

function wordHasForeignLetter(word) {
    for (const ch of word) {
        if (LETTER_RE.test(ch) && !CYRILLIC_LETTER_RE.test(ch)) return true;
    }
    return false;
}

function classifyForeignWord(word) {
    const hasCyr = CYRILLIC_LETTER_RE.test(word);
    const hasLat = LATIN_LETTER_RE.test(word);
    const hasAra = ARABIC_LETTER_RE.test(word);
    const hasCjk = CJK_LETTER_RE.test(word);
    const foreignCount = [hasLat, hasAra, hasCjk].filter(Boolean).length;
    if (hasCyr) return 'mixed';
    if (foreignCount > 1) return 'multi';
    if (hasLat) return 'latin';
    if (hasAra) return 'arabic';
    if (hasCjk) return 'cjk';
    return 'other';
}

function extractForeignTokensInSentence(sentence) {
    const s = getSettings();
    const tokens = [];
    for (const m of sentence.matchAll(WORD_RE)) {
        const word = m[0];
        if (!wordHasForeignLetter(word)) continue;
        if (isWhitelisted(word)) continue;

        const script = classifyForeignWord(word);
        if (script === 'latin' && !s.translateLatin) continue;
        if (script === 'arabic' && !s.translateArabic) continue;
        if (script === 'cjk' && !s.translateCjk) continue;
        if (script === 'other' && !s.translateOther) continue;

        tokens.push({ text: word, index: m.index, script });
    }
    return tokens;
}

function sentenceNeedsTranslation(text) {
    if (!text) return false;
    return extractForeignTokensInSentence(text).length > 0;
}

function needsTranslation(text) {
    return sentenceNeedsTranslation(text);
}

// ---------- tag protection ----------

/**
 * Двухпроходная защита тегов:
 *  1) все парные блоки <tag ...>…</tag> целиком (тег + содержимое);
 *  2) оставшиеся одиночные/самозакрывающиеся <tag ...> / <tag ... /> в тексте.
 * Возвращает массив сегментов: {type: 'text'|'protected', content}.
 */
function segmentText(text) {
    const s = getSettings();
    if (!s.skipTags) return [{ type: 'text', content: text }];

    // Pass 1: paired blocks
    const pairedRe = /<(\w+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
    const parts = [];
    let lastIdx = 0;
    let match;
    while ((match = pairedRe.exec(text)) !== null) {
        if (match.index > lastIdx) {
            parts.push({ type: 'text', content: text.slice(lastIdx, match.index) });
        }
        parts.push({ type: 'protected', content: match[0] });
        lastIdx = pairedRe.lastIndex;
    }
    if (lastIdx < text.length) {
        parts.push({ type: 'text', content: text.slice(lastIdx) });
    }
    if (parts.length === 0) parts.push({ type: 'text', content: text });

    // Pass 2: leftover standalone tags inside text parts
    const refined = [];
    for (const seg of parts) {
        if (seg.type === 'protected') { refined.push(seg); continue; }
        const sub = seg.content;
        const tagRe = /<\w+(?:\s[^>]*)?\/?>/gi;
        let pos = 0;
        let m;
        while ((m = tagRe.exec(sub)) !== null) {
            if (m.index > pos) refined.push({ type: 'text', content: sub.slice(pos, m.index) });
            refined.push({ type: 'protected', content: m[0] });
            pos = tagRe.lastIndex;
        }
        if (pos < sub.length) refined.push({ type: 'text', content: sub.slice(pos) });
    }

    if (refined.length === 0) refined.push({ type: 'text', content: text });
    return refined;
}

// ---------- sentence splitting ----------

function splitSentences(text) {
    const parts = text.match(/[^.!?…]+[.!?…]+["'»)\]]?\s*|[^.!?…]+$/g);
    return parts || [text];
}

function findTranslatableSentences(text) {
    const s = getSettings();
    const sentences = splitSentences(text);
    const result = [];
    let inCode = false;

    for (const part of sentences) {
        if (s.skipCodeBlocks) {
            const codeCount = (part.match(/```/g) || []).length;
            if (inCode) {
                if (codeCount % 2 === 1) inCode = false;
                continue;
            }
            if (codeCount % 2 === 1) { inCode = true; continue; }
        }
        const lead = part.match(/^\s*/)[0];
        const trail = part.match(/\s*$/)[0];
        const core = part.slice(lead.length, part.length - trail.length);
        if (core && sentenceNeedsTranslation(core)) {
            result.push({ full: part, lead, trail, core });
        }
    }
    return result;
}

// ---------- LLM translation ----------

function parseLLMTranslations(raw, count) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const data = JSON.parse(s.slice(start, end + 1));
            if (Array.isArray(data.translations) && data.translations.length === count) {
                return data.translations.map(String);
            }
        } catch { /* fallthrough */ }
    }
    const lines = raw
        .split('\n')
        .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
        .filter(Boolean);
    if (lines.length >= count) return lines.slice(0, count);
    if (lines.length === 1 && count === 1) return lines;
    return null;
}

async function safeGenerateRaw(promptText) {
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    let result;
    try {
        if (generateRawUnsafe.length === 1) {
            result = await generateRawUnsafe({ prompt: promptText, signal });
        } else {
            result = await generateRawUnsafe(promptText, undefined, true, true);
        }
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.error(`${extensionName}: generateRaw failed`, err);
        throw err;
    }
    return String(result || '').trim();
}

function buildLLMPrompt(items) {
    const list = items.map((it, i) => `${i + 1}. ${it}`).join('\n');
    return `Ты — переводчик, встроенный в русскоязычный ролевой чат. Модель иногда вставляет в русский текст иноязычные вставки. Это может быть ЛЮБОЙ язык (английский, китайский, японский, арабский, корейский, греческий, иврит и т.п.), и в одном предложении могут встретиться вставки с РАЗНЫХ языков одновременно.

Твоя задача — вернуть ТО ЖЕ САМОЕ предложение, но с переведёнными на русский ТОЛЬКО теми частями, которые НЕ на русском. Каждую иноязычную вставку обрабатывай независимо от остальных.

КРИТИЧЕСКИ ВАЖНО:
- НЕ перефразируй русский текст.
- НЕ меняй порядок слов.
- НЕ меняй пунктуацию.
- НЕ добавляй и не убирай ничего, кроме замены иноязычных фрагментов.
- Слова, которые уже на русском, должны остаться точно такими же.
- Если в предложении смешаны кириллица и другой алфавит внутри одного слова (например, "приمثلهрно") — восстанови это слово по контексту как осмысленное русское.
- Имена персонажей и неологизмы оставляй без изменений.
- Если иноязычных слов нет — верни предложение без изменений.
- Всё предложение передаётся только для контекста.

Верни СТРОГО валидный JSON без markdown-обёртки, без комментариев:
{"translations": ["изменённое предложение 1", "изменённое предложение 2", ...]}

Массив должен содержать ровно ${items.length} элементов, в том же порядке.

Предложения:
${list}`;
}

async function translateSentencesViaLLM(text, sentences) {
    const items = sentences.map((s) => s.core);
    const prompt = buildLLMPrompt(items);
    const response = await safeGenerateRaw(prompt);
    const translations = parseLLMTranslations(response, items.length);
    if (!translations) throw new Error('LLM вернула невалидный JSON');

    let cursor = 0;
    let out = '';
    const log = [];
    for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        const idx = text.indexOf(s.full, cursor);
        if (idx === -1) continue;
        out += text.slice(cursor, idx);
        const tr = String(translations[i] || '').trim();
        const replacement = s.lead + (tr || s.core) + s.trail;
        out += replacement;
        log.push({ original: s.core, translated: tr || s.core });
        cursor = idx + s.full.length;
    }
    out += text.slice(cursor);
    return { result: out, log };
}

// ---------- Translator APIs ----------

async function translateViaGoogle(text, targetLang) {
    const endpoints = [
        {
            url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`,
            parse: (d) => Array.isArray(d) && Array.isArray(d[0])
                ? d[0].map((p) => p[0]).join('')
                : null,
        },
        {
            url: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${encodeURIComponent(targetLang)}&q=${encodeURIComponent(text)}`,
            parse: (d) => Array.isArray(d) && typeof d[0] === 'string' ? d.join('') : null,
        },
    ];
    let lastError = null;
    for (const ep of endpoints) {
        try {
            const res = await fetch(ep.url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const parsed = ep.parse(data);
            if (parsed) return parsed;
            throw new Error('Непредвиденный формат ответа');
        } catch (e) {
            lastError = e;
        }
    }
    try {
        const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${encodeURIComponent(targetLang)}`);
        if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
        const data = await res.json();
        if (data.responseStatus === 200 && data.responseData?.translatedText) {
            return data.responseData.translatedText;
        }
        throw new Error('MyMemory: нет перевода');
    } catch (e) {
        throw new Error(`Все Google endpoints и MyMemory не сработали (${lastError?.message || ''} / ${e.message})`);
    }
}

async function translateViaDeepL(text, targetLang, apiKey) {
    const res = await fetch('https://api-free.deepl.com/v2/translate', {
        method: 'POST',
        headers: {
            'Authorization': `DeepL-Auth-Key ${apiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ text, target_lang: targetLang.toUpperCase() }),
    });
    if (!res.ok) throw new Error(`DeepL: ${res.status}`);
    const data = await res.json();
    return data.translations?.[0]?.text ?? '';
}

async function translateViaLingva(text, targetLang) {
    const instances = [
        'https://lingva.ml',
        'https://lingva.garudalinux.org',
        'https://translate.plausibility.cloud',
    ];
    let lastError = null;
    for (const base of instances) {
        try {
            const res = await fetch(`${base}/api/v1/auto/${encodeURIComponent(targetLang)}/${encodeURIComponent(text)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.translation) return data.translation;
            throw new Error('Пустой ответ');
        } catch (e) {
            lastError = e;
        }
    }
    throw new Error(`Все Lingva-инстансы недоступны (${lastError?.message || ''})`);
}

async function translateSingle(text) {
    const s = getSettings();
    if (s.translatorService === 'google') return translateViaGoogle(text, s.targetLang);
    if (s.translatorService === 'deepl') return translateViaDeepL(text, s.targetLang, s.deeplApiKey);
    if (s.translatorService === 'lingva') return translateViaLingva(text, s.targetLang);
    throw new Error('Неизвестный сервис перевода');
}

// ---------- translator-mode sentence processing ----------

async function translateSentencesViaTranslator(text, sentences) {
    let cursor = 0;
    let out = '';
    const log = [];

    for (const s of sentences) {
        const idx = text.indexOf(s.full, cursor);
        if (idx === -1) continue;
        out += text.slice(cursor, idx);

        const tokens = extractForeignTokensInSentence(s.core);
        if (tokens.length === 0) {
            out += s.full;
            cursor = idx + s.full.length;
            continue;
        }

        const hasMixed = tokens.some((t) => t.script === 'mixed');
        const hasMulti = tokens.some((t) => t.script === 'multi');

        if (tokens.length > MAX_TOKEN_CALLS_PER_SENTENCE || hasMixed || hasMulti) {
            try {
                const tr = await translateSingle(s.core);
                const cleaned = String(tr || '').trim() || s.core;
                const replacement = s.lead + cleaned + s.trail;
                out += replacement;
                log.push({
                    original: s.core,
                    translated: cleaned,
                    note: hasMixed ? 'mixed-word → whole sentence'
                        : hasMulti ? 'multi-script word → whole sentence'
                        : 'too many tokens → whole sentence',
                });
            } catch (e) {
                out += s.full;
                log.push({ original: s.core, translated: s.core, error: e.message });
            }
            cursor = idx + s.full.length;
            continue;
        }

        let newCore = '';
        let tokCursor = 0;
        let anyError = null;
        for (const tok of tokens) {
            if (tok.index < tokCursor) continue;
            newCore += s.core.slice(tokCursor, tok.index);
            try {
                const tr = await translateSingle(tok.text);
                newCore += (tr && String(tr).trim()) ? String(tr).trim() : tok.text;
            } catch (e) {
                newCore += tok.text;
                anyError = e.message;
            }
            tokCursor = tok.index + tok.text.length;
        }
        newCore += s.core.slice(tokCursor);

        const replacement = s.lead + newCore + s.trail;
        out += replacement;
        log.push({
            original: s.core,
            translated: newCore,
            error: anyError,
        });
        cursor = idx + s.full.length;
    }
    out += text.slice(cursor);
    return { result: out, log };
}

// ---------- top-level translation ----------

async function translateText(text) {
    const s = getSettings();
    const segments = segmentText(text);
    const parts = [];
    const log = [];

    for (const seg of segments) {
        if (seg.type !== 'text') {
            parts.push(seg.content);
            continue;
        }
        const sentences = findTranslatableSentences(seg.content);
        if (!sentences.length) {
            parts.push(seg.content);
            continue;
        }
        if (s.mode === 'llm') {
            const { result, log: entries } = await translateSentencesViaLLM(seg.content, sentences);
            parts.push(result);
            log.push(...entries);
        } else {
            const { result, log: entries } = await translateSentencesViaTranslator(seg.content, sentences);
            parts.push(result);
            log.push(...entries);
        }
    }
    return { newText: parts.join(''), log };
}

// ---------- message processing ----------

async function processMessage(mesId) {
    const s = getSettings();
    if (!s.enabled) return;
    if (inProgress.has(mesId)) return;

    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return;
    if (msg.is_user || msg.is_system) return;

    const swipeId = msg.swipe_id ?? 0;
    msg.extra = msg.extra || {};
    const translatedSwipes = msg.extra.itTranslatedSwipes || [];
    if (translatedSwipes.includes(swipeId)) return;

    const originalText = msg.mes;
    if (!originalText || !needsTranslation(originalText)) return;

    inProgress.add(mesId);
    const $mes = $(`.mes[mesid="${mesId}"]`);
    if (s.showIndicator) $mes.addClass('it-translating');

    const targetProfileName = getExtensionProfileName();
    const originalProfileName = targetProfileName ? getCurrentProfileName() : '';
    const needsProfileSwitch = s.mode === 'llm'
        && targetProfileName
        && targetProfileName !== originalProfileName;

    try {
        if (needsProfileSwitch) {
            console.log(`${extensionName}: Switching to "${targetProfileName}" for translation`);
            await switchProfile(targetProfileName);
        }

        const { newText, log } = await translateText(originalText);

        for (const entry of log) pushDebugEntry(entry);

        if (newText !== originalText) {
            msg.mes = newText;
            if (Array.isArray(msg.swipes) && msg.swipes[swipeId] !== undefined) {
                msg.swipes[swipeId] = newText;
            }
            msg.extra.itTranslatedSwipes = [...translatedSwipes, swipeId];
            if (ctx.saveChat) await ctx.saveChat();
            refreshMessageText(mesId);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            toastr.info('Перевод отменён');
        } else {
            console.error(`[${extensionName}] Ошибка:`, err);
            toastr.error(`Перевод не удался: ${err.message}`);
            pushDebugEntry({
                original: originalText.slice(0, 200) + (originalText.length > 200 ? '…' : ''),
                translated: originalText.slice(0, 200) + (originalText.length > 200 ? '…' : ''),
                error: err.message,
            });
        }
    } finally {
        if (needsProfileSwitch && originalProfileName !== undefined) {
            try { await switchProfile(originalProfileName); }
            catch (e) { console.warn(`${extensionName}: не удалось вернуть профиль`, e); }
        }
        $mes.removeClass('it-translating');
        inProgress.delete(mesId);
    }
}

function refreshMessageText(mesId) {
    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return;
    const $text = $(`.mes[mesid="${mesId}"] .mes_text`);
    if (!$text.length) return;
    try {
        if (typeof messageFormatting === 'function') {
            const html = messageFormatting(msg.mes, msg.name, msg.is_system, msg.is_user, msg.extra?.media);
            $text.html(html);
        } else {
            $text.text(msg.mes);
        }
    } catch (e) {
        console.error(`${extensionName}: ошибка перерисовки`, e);
        $text.text(msg.mes);
    }
}

// ---------- debug log ----------

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

function pushDebugEntry(entry) {
    debugLog.unshift({
        time: Date.now(),
        mode: getSettings().mode,
        ...entry,
    });
    if (debugLog.length > DEBUG_LOG_LIMIT) debugLog.pop();
    renderDebugLog();
}

function renderDebugLog() {
    const $log = $('#it-debug-log');
    if (!$log.length) return;
    if (debugLog.length === 0) {
        $log.html('<div class="it-debug-empty">Пока пусто. Здесь появятся замены.</div>');
        return;
    }
    const html = debugLog.map((e) => {
        const time = new Date(e.time).toLocaleTimeString();
        const modeLabel = e.mode === 'llm' ? 'LLM' : 'API';
        const errHtml = e.error ? `<div class="it-debug-error">⚠ ${escapeHtml(e.error)}</div>` : '';
        const noteHtml = e.note ? `<div class="it-debug-note">ℹ ${escapeHtml(e.note)}</div>` : '';
        return `<div class="it-debug-entry">
            <div class="it-debug-meta">[${time}] ${modeLabel}</div>
            <div class="it-debug-original">− ${escapeHtml(e.original)}</div>
            <div class="it-debug-translated">+ ${escapeHtml(e.translated)}</div>
            ${noteHtml}${errHtml}
        </div>`;
    }).join('');
    $log.html(html);
}

// ---------- UI ----------

function updateConditionalVisibility() {
    const s = getSettings();
    $('.it-translator-only').toggle(s.mode === 'translator');
    $('.it-deepl-only').toggle(s.mode === 'translator' && s.translatorService === 'deepl');
    $('.it-profile-hint').toggle(s.mode === 'llm');
}

function getSettingsHtml() {
    return `
    <div id="it-settings" class="it-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Inline Translator</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="ec-setting-row">
                    <label class="checkbox_label">
                        <input type="checkbox" id="it_enabled">
                        <span>Включить</span>
                    </label>
                </div>

                <div class="ec-setting-row">
                    <label for="it_mode">Режим:</label>
                    <select id="it_mode" class="text_pole">
                        <option value="llm">Нейросеть (LLM)</option>
                        <option value="translator">Переводчик (API)</option>
                    </select>
                </div>

                <div class="ec-setting-row it-profile-hint">
                    <label for="it-connection-profile">API-профиль:</label>
                    <select id="it-connection-profile" class="text_pole">
                        <option value="">Same as current (fast)</option>
                    </select>
                </div>
                <div class="ec-setting-row it-profile-hint" style="opacity:0.55; font-size:0.8em; padding-left:4px;">
                    Отдельный профиль = отдельная модель под перевод, но с задержкой из-за переключения.
                </div>

                <div class="ec-setting-row it-translator-only">
                    <label for="it_service">Сервис:</label>
                    <select id="it_service" class="text_pole">
                        <option value="google">Google Translate (бесплатно)</option>
                        <option value="deepl">DeepL (нужен ключ)</option>
                        <option value="lingva">Lingva (бесплатный прокси)</option>
                    </select>
                </div>

                <div class="ec-setting-row it-deepl-only">
                    <label for="it_deepl_key">DeepL ключ:</label>
                    <input type="password" id="it_deepl_key" class="text_pole" placeholder="xxxxxxxx-xxxx-...">
                </div>

                <div class="ec-setting-row">
                    <label for="it_lang">Язык перевода:</label>
                    <input type="text" id="it_lang" class="text_pole" maxlength="5" style="max-width:90px;">
                </div>

                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_arabic"><span>Переводить арабский</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_cjk"><span>Переводить CJK</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_latin"><span>Переводить латиницу</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_other"><span>Переводить прочие не-кириллические языки (греческий, иврит, тайский...)</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_skip_code"><span>Пропускать код-блоки</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_skip_tags"><span>Игнорировать текст внутри &lt;тегов&gt; (включая &lt;think&gt; и структурные блоки)</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_indicator"><span>Индикатор перевода</span></label>
                </div>

                <div class="ec-setting-row" style="flex-direction:column; align-items:stretch;">
                    <label for="it_whitelist">Игнор-лист (через запятую):</label>
                    <textarea id="it_whitelist" class="text_pole" rows="2"></textarea>
                </div>

                <div class="it-debug-section">
                    <div class="ec-setting-row" style="justify-content:space-between;">
                        <b>Debug</b>
                        <button id="it-debug-clear" class="menu_button" style="padding:2px 10px; font-size:0.8em;">Clear</button>
                    </div>
                    <div id="it-debug-log"></div>
                </div>

            </div>
        </div>
    </div>`;
}

function bindEvents() {
    const s = getSettings();

    $(document).on('change', '#it_enabled', function () {
        s.enabled = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('change', '#it_mode', function () {
        s.mode = $(this).val(); saveSettingsDebounced(); updateConditionalVisibility();
    });
    $(document).on('change', '#it_service', function () {
        s.translatorService = $(this).val(); saveSettingsDebounced(); updateConditionalVisibility();
    });
    $(document).on('change', '#it-connection-profile', function () {
        s.connectionProfileId = $(this).val() || ''; saveSettingsDebounced();
    });
    $(document).on('input', '#it_deepl_key', function () {
        s.deeplApiKey = $(this).val(); saveSettingsDebounced();
    });
    $(document).on('input', '#it_lang', function () {
        s.targetLang = $(this).val().trim() || 'ru'; saveSettingsDebounced();
    });
    $(document).on('change', '#it_arabic', function () {
        s.translateArabic = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('change', '#it_cjk', function () {
        s.translateCjk = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('change', '#it_latin', function () {
        s.translateLatin = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('change', '#it_other', function () {
        s.translateOther = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('change', '#it_skip_code', function () {
        s.skipCodeBlocks = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('change', '#it_skip_tags', function () {
        s.skipTags = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('change', '#it_indicator', function () {
        s.showIndicator = $(this).prop('checked'); saveSettingsDebounced();
    });
    $(document).on('input', '#it_whitelist', function () {
        s.whitelist = $(this).val(); saveSettingsDebounced();
    });
    $(document).on('click', '#it-debug-clear', function () {
        debugLog = []; renderDebugLog();
    });
}

function loadSettingsUI() {
    const s = getSettings();
    $('#it_enabled').prop('checked', s.enabled);
    $('#it_mode').val(s.mode);
    $('#it_service').val(s.translatorService);
    $('#it_deepl_key').val(s.deeplApiKey);
    $('#it_lang').val(s.targetLang);
    $('#it_arabic').prop('checked', s.translateArabic);
    $('#it_cjk').prop('checked', s.translateCjk);
    $('#it_latin').prop('checked', s.translateLatin);
    $('#it_other').prop('checked', s.translateOther);
    $('#it_skip_code').prop('checked', s.skipCodeBlocks);
    $('#it_skip_tags').prop('checked', s.skipTags);
    $('#it_indicator').prop('checked', s.showIndicator);
    $('#it_whitelist').val(s.whitelist);

    updateProfilesList();
    updateConditionalVisibility();
    renderDebugLog();
}

// ---------- init ----------

jQuery(async () => {
    getSettings();

    const $target = $('#extensions_settings2').length
        ? $('#extensions_settings2')
        : $('#extensions_settings');
    $target.append(getSettingsHtml());

    loadSettingsUI();
    bindEvents();

    eventSource.on(event_types.MESSAGE_RECEIVED, (mesId) => {
        processMessage(mesId).catch((e) => console.error(`[${extensionName}]`, e));
    });
    eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => {
        processMessage(mesId).catch((e) => console.error(`[${extensionName}]`, e));
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        inProgress.clear();
        debugLog = [];
        updateProfilesList();
        renderDebugLog();
    });
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, () => {
        updateProfilesList();
    });

    console.log(`${extensionName}: loaded v1.5.0`);
});