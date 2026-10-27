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
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const generateRawUnsafe = /** @type {any} */ (generateRaw);

// ---------- defaults ----------

const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'llm',
    translatorService: 'google',
    deeplApiKey: '',
    targetLang: 'ru',
    minLatinLength: 4,
    translateCjk: true,
    translateLatin: true,
    whitelist: 'HP, MP, XP, Lv, EXP, NPC, PvP, PvE, DnD, OOC, IC, PM, DM, GM',
    skipCodeBlocks: true,
    skipQuotes: true,
    showIndicator: true,
    connectionProfileId: '',
};

const CJK_REGEX = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3000-\u303f]/;
const LATIN_WORD_REGEX = /[A-Za-z][A-Za-z'\-]+/g;

// ---------- state ----------

let currentAbortController = null;
const inProgress = new Set();

// ---------- settings ----------

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const s = extension_settings[extensionName];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

// ---------- connection profile helpers (adapted from EventChronicle) ----------

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
    const profile = extension_settings?.connectionManager?.profiles?.find((p) => p.id === id);
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

function needsTranslation(text) {
    if (!text || typeof text !== 'string') return false;
    const s = getSettings();

    if (s.translateCjk && CJK_REGEX.test(text)) return true;

    if (s.translateLatin) {
        const whitelist = s.whitelist
            .split(',')
            .map((w) => w.trim().toLowerCase())
            .filter(Boolean);
        const words = text.match(LATIN_WORD_REGEX) || [];
        return words.some(
            (w) => w.length >= s.minLatinLength && !whitelist.includes(w.toLowerCase()),
        );
    }
    return false;
}

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
            if (codeCount % 2 === 1) {
                inCode = true;
                continue;
            }
        }

        if (s.skipQuotes) {
            // Skip pure-quote lines like `Elara: "..."` with no other content outside
            // Actually: don't skip by default; user can turn off. Keep behaviour simple:
        }

        const lead = part.match(/^\s*/)[0];
        const trail = part.match(/\s*$/)[0];
        const core = part.slice(lead.length, part.length - trail.length);

        if (core && needsTranslation(core)) {
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

async function translateViaLLM(items) {
    const list = items.map((it, i) => `${i + 1}. ${it.core}`).join('\n');
    const prompt = `Ты — переводчик, встроенный в русскоязычный ролевой чат. Модель иногда вставляет в русский текст иноязычные слова (английский, китайский, японский). Переведи каждое предложение на русский язык, сохранив тон, стиль и смысл. Имена персонажей и неологизмы оставляй без изменений. Никаких пояснений не добавляй.

Верни СТРОГО валидный JSON без markdown-обёртки, без комментариев:
{"translations": ["перевод 1", "перевод 2", ...]}

Массив должен содержать ровно ${items.length} элементов, в том же порядке.

Предложения:
${list}`;

    const response = await safeGenerateRaw(prompt);
    const translations = parseLLMTranslations(response, items.length);
    if (!translations) throw new Error('Не удалось распарсить ответ LLM');
    return translations;
}

// ---------- translator APIs ----------

async function translateViaGoogle(text, targetLang) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google: ${res.status}`);
    const data = await res.json();
    return data[0].map((p) => p[0]).join('');
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
    const res = await fetch(
        `https://lingva.ml/api/v1/auto/${encodeURIComponent(targetLang)}/${encodeURIComponent(text)}`,
    );
    if (!res.ok) throw new Error(`Lingva: ${res.status}`);
    const data = await res.json();
    return data.translation ?? '';
}

async function translateSingle(text) {
    const s = getSettings();
    if (s.translatorService === 'google') return translateViaGoogle(text, s.targetLang);
    if (s.translatorService === 'deepl') return translateViaDeepL(text, s.targetLang, s.deeplApiKey);
    if (s.translatorService === 'lingva') return translateViaLingva(text, s.targetLang);
    throw new Error('Неизвестный сервис перевода');
}

async function translateItems(items) {
    if (!items.length) return [];
    const s = getSettings();

    if (s.mode === 'llm') {
        return translateViaLLM(items);
    }

    const results = [];
    for (const it of items) {
        try {
            results.push(await translateSingle(it.core));
        } catch (e) {
            console.error(`[${extensionName}] Ошибка перевода:`, e);
            results.push(null);
        }
    }
    return results;
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

    const items = findTranslatableSentences(originalText);
    if (!items.length) return;

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

        const translations = await translateItems(items);

        let newText = originalText;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const tr = translations[i];
            if (!tr || !String(tr).trim()) continue;
            const replacement = it.lead + String(tr).trim() + it.trail;
            const idx = newText.indexOf(it.full);
            if (idx !== -1) {
                newText = newText.slice(0, idx) + replacement + newText.slice(idx + it.full.length);
            }
        }

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
            console.error(`[${extensionName}] Ошибка перевода:`, err);
            toastr.error(`Перевод не удался: ${err.message}`);
        }
    } finally {
        if (needsProfileSwitch && originalProfileName !== undefined) {
            try {
                await switchProfile(originalProfileName);
            } catch (e) {
                console.warn(`[${extensionName}] Не удалось вернуть профиль`, e);
            }
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
            const html = messageFormatting(
                msg.mes,
                msg.name,
                msg.is_system,
                msg.is_user,
                msg.extra?.media,
            );
            $text.html(html);
        } else {
            $text.text(msg.mes);
        }
    } catch (e) {
        console.error(`[${extensionName}] Ошибка перерисовки:`, e);
        $text.text(msg.mes);
    }
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
                    <label for="it_min_latin">Мин. длина латинского слова:</label>
                    <input type="number" id="it_min_latin" class="text_pole" min="2" max="12" style="max-width:90px;">
                </div>

                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_cjk"><span>Переводить CJK</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_latin"><span>Переводить латиницу</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_skip_code"><span>Пропускать код-блоки</span></label>
                </div>
                <div class="ec-setting-row">
                    <label class="checkbox_label"><input type="checkbox" id="it_indicator"><span>Индикатор перевода</span></label>
                </div>

                <div class="ec-setting-row" style="flex-direction:column; align-items:stretch;">
                    <label for="it_whitelist">Игнор-лист (через запятую):</label>
                    <textarea id="it_whitelist" class="text_pole" rows="2"></textarea>
                </div>

            </div>
        </div>
    </div>`;
}

function bindEvents() {
    const s = getSettings();

    $(document).on('change', '#it_enabled', function () {
        s.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $(document).on('change', '#it_mode', function () {
        s.mode = $(this).val();
        saveSettingsDebounced();
        updateConditionalVisibility();
    });

    $(document).on('change', '#it_service', function () {
        s.translatorService = $(this).val();
        saveSettingsDebounced();
        updateConditionalVisibility();
    });

    $(document).on('change', '#it-connection-profile', function () {
        s.connectionProfileId = $(this).val() || '';
        saveSettingsDebounced();
    });

    $(document).on('input', '#it_deepl_key', function () {
        s.deeplApiKey = $(this).val();
        saveSettingsDebounced();
    });

    $(document).on('input', '#it_lang', function () {
        s.targetLang = $(this).val().trim() || 'ru';
        saveSettingsDebounced();
    });

    $(document).on('input', '#it_min_latin', function () {
        s.minLatinLength = Math.max(2, parseInt($(this).val()) || 4);
        saveSettingsDebounced();
    });

    $(document).on('change', '#it_cjk', function () {
        s.translateCjk = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $(document).on('change', '#it_latin', function () {
        s.translateLatin = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $(document).on('change', '#it_skip_code', function () {
        s.skipCodeBlocks = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $(document).on('change', '#it_indicator', function () {
        s.showIndicator = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $(document).on('input', '#it_whitelist', function () {
        s.whitelist = $(this).val();
        saveSettingsDebounced();
    });
}

function loadSettingsUI() {
    const s = getSettings();
    $('#it_enabled').prop('checked', s.enabled);
    $('#it_mode').val(s.mode);
    $('#it_service').val(s.translatorService);
    $('#it_deepl_key').val(s.deeplApiKey);
    $('#it_lang').val(s.targetLang);
    $('#it_min_latin').val(s.minLatinLength);
    $('#it_cjk').prop('checked', s.translateCjk);
    $('#it_latin').prop('checked', s.translateLatin);
    $('#it_skip_code').prop('checked', s.skipCodeBlocks);
    $('#it_indicator').prop('checked', s.showIndicator);
    $('#it_whitelist').val(s.whitelist);

    updateProfilesList();
    updateConditionalVisibility();
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
        updateProfilesList();
    });

    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, () => {
        updateProfilesList();
    });

    console.log(`${extensionName}: loaded v1.1.0`);
});