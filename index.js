import {
    DEFAULTS,
    syncDialogue,
    extractTagCandidates,
    guessTagRoles,
} from './core.js';

const NAME = 'dialogue-sync';
const SYNC_BTN = 'dialogue_sync_button';
const UNDO_BTN = 'dialogue_sync_undo';

/* ---------------- 설정 ---------------- */

function ctx() {
    return typeof SillyTavern !== 'undefined' && SillyTavern.getContext
        ? SillyTavern.getContext()
        : null;
}

function settings() {
    const c = ctx();
    if (!c) return { ...DEFAULTS };
    const store = c.extensionSettings || c.extension_settings;
    if (!store) return { ...DEFAULTS };
    if (!store[NAME]) store[NAME] = { ...DEFAULTS };
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (store[NAME][k] === undefined) store[NAME][k] = v;
    }
    return store[NAME];
}

function save() {
    const c = ctx();
    if (c && typeof c.saveSettingsDebounced === 'function') {
        c.saveSettingsDebounced();
    }
}

function status(msg, kind) {
    const $s = $('#ds_status');
    $s.removeClass('ds-ok ds-warn');
    if (kind) $s.addClass(kind === 'ok' ? 'ds-ok' : 'ds-warn');
    $s.text(msg || '');
}

/* ---------------- 태그 찾기 ---------------- */

function detectFromPrompt() {
    const prompt = String($('#ds_prompt').val() || '').trim();
    if (!prompt) {
        status('프롬프트를 먼저 붙여 넣으세요.', 'warn');
        return;
    }

    const candidates = extractTagCandidates(prompt);
    if (candidates.length < 2) {
        status(
            candidates.length === 1
                ? `태그를 하나만 찾았습니다: ${candidates[0]}. "AI로 분석"을 눌러 보세요.`
                : '태그를 찾지 못했습니다. "AI로 분석"을 눌러 보세요.',
            'warn'
        );
        return;
    }

    const roles = guessTagRoles(candidates);
    $('#ds_source_tag').val(roles.sourceTag);
    $('#ds_target_tag').val(roles.targetTag);
    const s = settings();
    s.sourceTag = roles.sourceTag;
    s.targetTag = roles.targetTag;
    save();

    let msg = `원문 ${roles.sourceTag} / 번역 ${roles.targetTag} 으로 설정했습니다.`;
    if (candidates.length > 2) {
        msg += ` (후보 ${candidates.length}개 중 선택 — 틀렸다면 직접 고치세요.)`;
    }
    status(msg, 'ok');
}

/* ---------------- AI로 분석 ---------------- */

const ANALYZE_PROMPT = `You are analyzing a roleplay translation prompt to extract its output format.

The prompt below instructs an AI to produce output in two parts: an original-language part and a translated part, each wrapped in XML-style tags.

Identify:
- sourceTag: the tag name wrapping the ORIGINAL language part (the part that also contains inline translations in parentheses)
- targetTag: the tag name wrapping the FULL TRANSLATED part

Return ONLY a JSON object, no markdown fences, no explanation:
{"sourceTag":"...","targetTag":"..."}

Use the bare tag name without angle brackets. If you cannot determine a tag, use an empty string.

--- PROMPT TO ANALYZE ---
`;

function parseJsonLoose(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

async function detectWithAI() {
    const prompt = String($('#ds_prompt').val() || '').trim();
    if (!prompt) {
        status('프롬프트를 먼저 붙여 넣으세요.', 'warn');
        return;
    }

    const c = ctx();
    if (!c || typeof c.generateQuietPrompt !== 'function') {
        status('현재 환경에서는 AI 분석을 쓸 수 없습니다.', 'warn');
        return;
    }

    const $btn = $('#ds_detect_ai');
    $btn.addClass('disabled');
    status('분석 중…');

    try {
        const reply = await c.generateQuietPrompt(ANALYZE_PROMPT + prompt, false, false);
        const parsed = parseJsonLoose(reply);

        if (!parsed || (!parsed.sourceTag && !parsed.targetTag)) {
            status('분석에 실패했습니다. 태그를 직접 입력해 주세요.', 'warn');
            return;
        }

        const s = settings();
        const clean = (v) => String(v || '').replace(/[<>/\s]/g, '');
        const src = clean(parsed.sourceTag);
        const tgt = clean(parsed.targetTag);

        if (src) {
            $('#ds_source_tag').val(src);
            s.sourceTag = src;
        }
        if (tgt) {
            $('#ds_target_tag').val(tgt);
            s.targetTag = tgt;
        }
        save();

        status(
            src && tgt
                ? `원문 ${src} / 번역 ${tgt} 으로 설정했습니다. 맞는지 확인해 주세요.`
                : '일부만 찾았습니다. 빈 칸을 직접 채워 주세요.',
            src && tgt ? 'ok' : 'warn'
        );
    } catch (err) {
        console.error('[Dialogue Sync] AI 분석 실패', err);
        status('분석 중 오류가 발생했습니다. 태그를 직접 입력해 주세요.', 'warn');
    } finally {
        $btn.removeClass('disabled');
    }
}

/* ---------------- 되돌리기 저장소 ---------------- */

const backups = new Map();

function backupKey(c, mesId) {
    return `${c.chatId ?? c.getCurrentChatId?.() ?? ''}:${mesId}`;
}

/* ---------------- 버튼 동작 ---------------- */

function messageIdFrom($btn) {
    const $mes = $btn.closest('.mes');
    const id = Number($mes.attr('mesid'));
    return Number.isNaN(id) ? null : id;
}

async function applyMessage(c, mesId, message, text) {
    message.mes = text;
    if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
        message.swipes[message.swipe_id] = text;
    }
    c.updateMessageBlock(mesId, message);
    await c.saveChat();
}

async function onSyncClick(event) {
    event.stopPropagation();
    const c = ctx();
    if (!c) return;

    const mesId = messageIdFrom($(event.currentTarget));
    if (mesId === null) return;

    const message = c.chat[mesId];
    if (!message || typeof message.mes !== 'string') return;

    const result = syncDialogue(message.mes, settings());
    if (!result || result.text === message.mes) return;

    backups.set(backupKey(c, mesId), message.mes);
    await applyMessage(c, mesId, message, result.text);
    refreshButtons();
}

async function onUndoClick(event) {
    event.stopPropagation();
    const c = ctx();
    if (!c) return;

    const mesId = messageIdFrom($(event.currentTarget));
    if (mesId === null) return;

    const key = backupKey(c, mesId);
    const original = backups.get(key);
    if (original === undefined) return;

    const message = c.chat[mesId];
    if (!message) return;

    backups.delete(key);
    await applyMessage(c, mesId, message, original);
    refreshButtons();
}

/* ---------------- 버튼 삽입 ---------------- */

function makeButton(cls, icon, title) {
    return $('<div></div>')
        .addClass(`mes_button ${cls} fa-solid ${icon} interactable`)
        .attr({ title, tabindex: '0' });
}

function decorate($mes) {
    // AI 응답에만 붙인다. 유저 입력과 시스템 메시지는 제외.
    if ($mes.attr('is_user') === 'true') return;
    if ($mes.attr('is_system') === 'true') return;

    const $container = $mes.find('.mes_buttons').first();
    if ($container.length === 0) return;

    if ($container.find(`.${SYNC_BTN}`).length === 0) {
        const $btn = makeButton(SYNC_BTN, 'fa-scissors', '대사에 원문 붙이기');
        $btn.on('click', onSyncClick);
        $container.prepend($btn);
    }

    const c = ctx();
    const mesId = Number($mes.attr('mesid'));
    const hasBackup =
        c && !Number.isNaN(mesId) && backups.has(backupKey(c, mesId));
    const showUndo = settings().enableUndo && hasBackup;
    const $existing = $container.find(`.${UNDO_BTN}`);

    if (showUndo && $existing.length === 0) {
        const $undo = makeButton(UNDO_BTN, 'fa-rotate-left', '되돌리기');
        $undo.on('click', onUndoClick);
        $container.find(`.${SYNC_BTN}`).after($undo);
    } else if (!showUndo && $existing.length > 0) {
        $existing.remove();
    }
}

function refreshButtons() {
    $('#chat .mes').each(function () {
        decorate($(this));
    });
}

/* ---------------- 설정 UI 연결 ---------------- */

function bindSettingsUI() {
    const s = settings();

    $('#ds_source_tag').val(s.sourceTag);
    $('#ds_target_tag').val(s.targetTag);
    $('#ds_threshold').val(s.threshold);
    $('#ds_threshold_value').text(Number(s.threshold).toFixed(2));
    $('#ds_enable_undo').prop('checked', !!s.enableUndo);

    $('#ds_source_tag').on('input', function () {
        settings().sourceTag = String($(this).val() || '').trim();
        save();
    });

    $('#ds_target_tag').on('input', function () {
        settings().targetTag = String($(this).val() || '').trim();
        save();
    });

    $('#ds_threshold').on('input', function () {
        const v = Number($(this).val());
        settings().threshold = v;
        $('#ds_threshold_value').text(v.toFixed(2));
        save();
    });

    $('#ds_enable_undo').on('change', function () {
        settings().enableUndo = $(this).prop('checked');
        save();
        refreshButtons();
    });

    $('#ds_detect').on('click', detectFromPrompt);
    $('#ds_detect_ai').on('click', detectWithAI);
}

/* ---------------- 초기화 ---------------- */

async function loadPanel(attempt = 0) {
    if ($('#ds_prompt').length > 0) return;

    const $host = $('#extensions_settings2').length
        ? $('#extensions_settings2')
        : $('#extensions_settings');

    if ($host.length === 0) {
        // 확장 설정 서랍이 아직 그려지지 않았을 수 있으므로 잠시 뒤 재시도
        if (attempt < 20) setTimeout(() => loadPanel(attempt + 1), 500);
        return;
    }

    const path = `scripts/extensions/third-party/${NAME}/settings.html`;
    try {
        const html = await $.get(path);
        $host.append(html);
        bindSettingsUI();
    } catch (err) {
        console.error('[Dialogue Sync] 설정 패널 로드 실패', err);
    }
}

function init() {
    const c = ctx();
    if (!c || !c.eventSource) {
        setTimeout(init, 500);
        return;
    }

    const { eventSource, event_types: ev } = c;
    const events = [
        ev.CHARACTER_MESSAGE_RENDERED,
        ev.MESSAGE_SWIPED,
        ev.MESSAGE_UPDATED,
        ev.MESSAGE_EDITED,
    ].filter(Boolean);

    for (const e of events) {
        eventSource.on(e, () => setTimeout(refreshButtons, 0));
    }

    if (ev.CHAT_CHANGED) {
        eventSource.on(ev.CHAT_CHANGED, () => {
            backups.clear();
            setTimeout(refreshButtons, 100);
        });
    }

    loadPanel();
    refreshButtons();
}

jQuery(() => init());
