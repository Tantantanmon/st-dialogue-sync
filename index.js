import {
    DEFAULTS,
    syncDialogue,
    extractTagCandidates,
    guessTagRoles,
    normalizeFormat,
} from './core.js';

const NAME = 'dialogue-sync';
const SYNC_BTN = 'dialogue_sync_button';
const UNDO_BTN = 'dialogue_sync_undo';

/**
 * 설치된 폴더 이름을 스크립트 경로에서 알아낸다.
 * 저장소 이름을 바꿔도 settings.html 을 찾을 수 있게 하기 위함.
 */
function extensionFolder() {
    try {
        const url = import.meta.url;
        const m = url.match(/third-party\/([^/]+)\//);
        if (m) return m[1];
    } catch {
        /* import.meta 를 못 쓰는 환경이면 아래 기본값 사용 */
    }
    return NAME;
}

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

function notify(msg, kind) {
    if (typeof toastr !== 'undefined' && toastr[kind]) toastr[kind](msg, 'Dialogue Sync');
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

/**
 * 메시지 하나를 교정한다. 버튼과 /dsync 명령이 같이 쓴다.
 * @returns {Promise<number>} 바꾼 대사 개수 (0이면 변경 없음)
 */
async function syncMessage(c, mesId) {
    const message = c.chat[mesId];
    if (!message || typeof message.mes !== 'string' || message.is_user || message.is_system) {
        notify('교정할 수 있는 AI 메시지가 아닙니다.', 'warning');
        return 0;
    }

    const fixed = normalizeFormat(message.mes);
    const result = syncDialogue(fixed.text, settings());
    const finalText = result ? result.text : fixed.text;
    const changed = fixed.changed + (result ? result.changed : 0);

    if (finalText === message.mes) {
        notify('고칠 대사가 없습니다.', 'info');
        return 0;
    }

    backups.set(backupKey(c, mesId), { before: message.mes, after: finalText });
    await applyMessage(c, mesId, message, finalText);
    notify(`대사 ${changed}개를 고쳤습니다.`, 'success');
    refreshButtons();
    return changed;
}

async function onSyncClick(event) {
    event.stopPropagation();
    const c = ctx();
    if (!c) return;

    const mesId = messageIdFrom($(event.currentTarget));
    if (mesId === null) return;

    await syncMessage(c, mesId);
}

async function onUndoClick(event) {
    event.stopPropagation();
    const c = ctx();
    if (!c) return;

    const mesId = messageIdFrom($(event.currentTarget));
    if (mesId === null) return;

    const key = backupKey(c, mesId);
    const saved = backups.get(key);
    if (saved === undefined) return;

    const message = c.chat[mesId];
    if (!message) return;

    // 그 사이 스와이프·편집·삭제로 메시지가 바뀌었다면 덮어쓰지 않는다
    if (message.mes !== saved.after) {
        backups.delete(key);
        refreshButtons();
        notify('메시지가 바뀌어서 되돌릴 수 없습니다. 원문을 덮어쓰지 않았어요.', 'warning');
        return;
    }

    backups.delete(key);
    await applyMessage(c, mesId, message, saved.before);
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
    const saved =
        c && !Number.isNaN(mesId) ? backups.get(backupKey(c, mesId)) : undefined;
    const hasBackup = !!saved && c.chat?.[mesId]?.mes === saved.after;
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

/* ---------------- /dsync 명령 ---------------- */

async function runDsync(arg) {
    const c = ctx();
    if (!c || !Array.isArray(c.chat) || c.chat.length === 0) return '0';

    let mesId;
    const raw = String(arg ?? '').trim();
    if (raw !== '') {
        mesId = Number(raw);
    } else {
        // 인자가 없으면 가장 최근 AI 메시지
        for (let i = c.chat.length - 1; i >= 0; i--) {
            const m = c.chat[i];
            if (m && !m.is_user && !m.is_system) { mesId = i; break; }
        }
    }
    if (mesId === undefined || Number.isNaN(mesId)) {
        notify('교정할 AI 메시지를 찾지 못했습니다.', 'warning');
        return '0';
    }
    return String(await syncMessage(c, mesId));
}

function registerCommand() {
    const c = ctx();
    if (!c) return;
    const help = '마지막 AI 메시지(또는 지정한 번호)의 대사를 "영어 (한국어)" 형식으로 고칩니다. 예: /dsync 또는 /dsync 12';
    try {
        if (c.SlashCommandParser && c.SlashCommand) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'dsync',
                callback: async (_args, value) => runDsync(value),
                helpString: help,
                returns: '바꾼 대사 개수',
            }));
        } else if (typeof c.registerSlashCommand === 'function') {
            c.registerSlashCommand('dsync', async (_args, value) => runDsync(value), [], help, true, true);
        }
    } catch (err) {
        console.error('[Dialogue Sync] /dsync 등록 실패', err);
    }
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

    const path = `scripts/extensions/third-party/${extensionFolder()}/settings.html`;
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
        ev.MESSAGE_DELETED,
        ev.MORE_MESSAGES_LOADED,
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

    registerCommand();
    loadPanel();
    refreshButtons();
}

jQuery(() => init());
