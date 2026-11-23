/* ============================================================
 * Dialogue Sync — core logic
 * 설정(config)에 따라 동작하는 순수 함수들. DOM/ST 의존 없음.
 * ============================================================ */

export const DEFAULTS = {
    sourceTag: 'english_output',
    targetTag: 'trans_korean',
    threshold: 0.55,
    enableUndo: true,
};

/* ---------------- 언어 감지 ---------------- */

const SCRIPTS = [
    { id: 'hangul', re: /[\uAC00-\uD7A3]/g },
    { id: 'kana', re: /[\u3040-\u30FF]/g },
    { id: 'han', re: /[\u4E00-\u9FFF]/g },
    { id: 'cyrillic', re: /[\u0400-\u04FF]/g },
    { id: 'arabic', re: /[\u0600-\u06FF]/g },
    { id: 'thai', re: /[\u0E00-\u0E7F]/g },
    { id: 'latin', re: /[A-Za-z]/g },
];

function countScript(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
}

/** 텍스트에서 가장 우세한 문자 체계를 반환 */
export function detectScript(text) {
    let best = null;
    let bestCount = 0;
    for (const s of SCRIPTS) {
        const c = countScript(text, s.re);
        if (c > bestCount) {
            bestCount = c;
            best = s.id;
        }
    }
    return best;
}

function scriptRe(id) {
    const s = SCRIPTS.find((x) => x.id === id);
    return s ? new RegExp(s.re.source) : null;
}

function scriptGlobalRe(id) {
    const s = SCRIPTS.find((x) => x.id === id);
    return s ? new RegExp(s.re.source, 'g') : null;
}

/** 해당 문자 체계의 글자가 하나라도 있는지 */
function hasScript(text, id) {
    const re = scriptRe(id);
    return re ? re.test(text) : false;
}

/* ---------------- 블록 추출 ---------------- */

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 태그로 감싸인 구간의 위치를 찾는다.
 * 유저 프롬프트가 <small><trans_korean> ... </small></trans_korean> 처럼
 * 태그 순서가 어긋난 경우도 허용하기 위해 여는/닫는 태그를 따로 찾는다.
 */
export function locateBlock(text, tag) {
    if (!tag) return null;
    const t = escapeRe(tag);
    const open = text.match(new RegExp('<' + t + '(?:\\s[^>]*)?>', 'i'));
    const close = text.match(new RegExp('</' + t + '\\s*>', 'i'));
    if (!open || !close) return null;

    let start = open.index + open[0].length;
    let end = close.index;
    if (end <= start) return null;

    // 닫는 태그 바로 앞에 붙은 다른 닫는 태그(</small> 등)는 본문에서 제외
    const tail = text.slice(start, end);
    const stray = tail.match(/(?:<\/[A-Za-z][\w-]*\s*>\s*)+$/);
    if (stray) end = start + stray.index;

    return { start, end, body: text.slice(start, end) };
}

/* ---------------- 대사 파싱 ---------------- */

const QUOTE_PAIRS = [
    ['"', '"'],
    ['\u201C', '\u201D'],
    ['\u300C', '\u300D'],
    ['\u300E', '\u300F'],
];

/** 따옴표로 감싸인 구간들을 위치와 함께 수집 */
export function findQuoted(text) {
    const out = [];
    for (const [o, c] of QUOTE_PAIRS) {
        const re =
            o === c
                ? new RegExp(escapeRe(o) + '([^' + escapeRe(o) + '\\n]+)' + escapeRe(c), 'g')
                : new RegExp(escapeRe(o) + '([^' + escapeRe(c) + ']+)' + escapeRe(c), 'g');
        let m;
        while ((m = re.exec(text)) !== null) {
            out.push({
                start: m.index,
                end: m.index + m[0].length,
                open: o,
                close: c,
                inner: m[1],
            });
        }
    }
    // 문자 메시지: 줄 맨 앞이 > 인 줄 전체를 하나의 대사로 본다
    const lineRe = /^([ \t]*>[ \t]*)(.+?)[ \t]*$/gm;
    let lm;
    while ((lm = lineRe.exec(text)) !== null) {
        out.push({
            start: lm.index,
            end: lm.index + lm[0].length,
            open: lm[1],
            close: '',
            inner: lm[2],
        });
    }
    // 겹치는 구간 제거 후 위치순 정렬
    out.sort((a, b) => a.start - b.start);
    const clean = [];
    let lastEnd = -1;
    for (const q of out) {
        if (q.start >= lastEnd) {
            clean.push(q);
            lastEnd = q.end;
        }
    }
    return clean;
}

/**
 * "원문 (번역)" 형태를 분해.
 * srcScript / tgtScript 는 감지된 문자 체계 id.
 */
export function splitPair(inner, srcScript, tgtScript) {
    // 마지막 괄호 묶음을 번역으로 본다. 원문 안에 괄호가 있어도 안전하게.
    const m = inner.match(/^([\s\S]*)\s*[(（[]([^()（）[\]]*)[)）\]]\s*$/);
    if (!m) return null;
    const a = m[1].trim();
    const b = m[2].trim();
    if (!a || !b) return null;
    if (!hasScript(a, srcScript)) return null;
    if (!hasScript(b, tgtScript)) return null;
    return { src: a, tgt: b };
}

/* ---------------- 유사도 ---------------- */

function normalize(s) {
    return s
        .replace(/\s+/g, '')
        .replace(/[.,!?…·~\-—"'\u201C\u201D\u2018\u2019\u300C\u300D()（）[\]]/g, '')
        .toLowerCase();
}

/** 바이그램 Dice 계수 (0~1) */
export function similarity(a, b) {
    const x = normalize(a);
    const y = normalize(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    // 아주 짧은 문장은 바이그램이 만들어지지 않으므로 포함 관계로 판정
    if (x.length < 2 || y.length < 2) {
        const [short, long] = x.length <= y.length ? [x, y] : [y, x];
        return long.includes(short) ? short.length / long.length : 0;
    }

    const grams = new Map();
    for (let i = 0; i < x.length - 1; i++) {
        const g = x.slice(i, i + 2);
        grams.set(g, (grams.get(g) || 0) + 1);
    }
    let hits = 0;
    for (let i = 0; i < y.length - 1; i++) {
        const g = y.slice(i, i + 2);
        const c = grams.get(g) || 0;
        if (c > 0) {
            grams.set(g, c - 1);
            hits++;
        }
    }
    return (2 * hits) / (x.length - 1 + y.length - 1);
}

/* ---------------- 메인 변환 ---------------- */

/**
 * @returns {{text:string, changed:number}|null}
 *   null 이면 변경할 것이 없거나 구조를 파악하지 못한 경우.
 */
export function syncDialogue(fullText, config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});

    const srcLoc = locateBlock(fullText, cfg.sourceTag);
    const tgtLoc = locateBlock(fullText, cfg.targetTag);
    if (!srcLoc || !tgtLoc) return null;

    // 문자 체계 자동 감지.
    // 원문 블록에는 "English (번역)" 처럼 번역이 섞여 있으므로
    // 괄호 안을 걷어낸 뒤 판정해야 원문 언어가 제대로 잡힌다.
    const stripParens = (s) => s.replace(/[(（[][^)）\]]*[)）\]]/g, ' ');
    const srcScript = detectScript(stripParens(srcLoc.body)) || detectScript(srcLoc.body);

    // 번역 블록은 이미 일부가 동기화되어 원문이 섞여 있을 수 있다.
    // 원문 문자를 걷어낸 뒤 판정해야 번역 언어가 제대로 잡힌다.
    const srcCharsRe = srcScript ? scriptGlobalRe(srcScript) : null;
    const tgtScript =
        (srcCharsRe && detectScript(tgtLoc.body.replace(srcCharsRe, ' '))) ||
        detectScript(tgtLoc.body);

    if (!srcScript || !tgtScript || srcScript === tgtScript) return null;

    // 원문 블록에서 "원문 (번역)" 쌍 수집
    const pairs = [];
    for (const q of findQuoted(srcLoc.body)) {
        const p = splitPair(q.inner, srcScript, tgtScript);
        if (p) pairs.push(p);
    }
    if (pairs.length === 0) return null;

    // 번역 블록의 대사 수집
    const targets = findQuoted(tgtLoc.body);
    if (targets.length === 0) return null;

    // 손봐야 할 것만 추림
    const pending = [];
    for (const t of targets) {
        if (splitPair(t.inner, srcScript, tgtScript)) continue; // 이미 정상
        if (!hasScript(t.inner, tgtScript)) continue; // 번역문이 아님
        if (hasScript(t.inner, srcScript) && /[(（[]/.test(t.inner)) continue; // 애매
        pending.push(t);
    }
    if (pending.length === 0) return null;

    const used = new Set();

    // 1차: 유사도 매칭
    for (const t of pending) {
        let bestIdx = -1;
        let bestScore = 0;
        for (let i = 0; i < pairs.length; i++) {
            if (used.has(i)) continue;
            const s = similarity(t.inner, pairs[i].tgt);
            if (s > bestScore) {
                bestScore = s;
                bestIdx = i;
            }
        }
        if (bestIdx >= 0 && bestScore >= cfg.threshold) {
            t.match = pairs[bestIdx];
            used.add(bestIdx);
        }
    }

    // 2차: 대사 개수가 정확히 같으면 순서를 근거로 채움.
    // 대사가 2개 이상이어야 "순서가 일치한다"는 근거가 성립하므로
    // 1개뿐일 때는 사용자가 정한 기준을 그대로 따른다.
    const FLOOR = Math.min(cfg.threshold, 0.25);
    if (
        pending.some((t) => !t.match) &&
        targets.length === pairs.length &&
        targets.length >= 2
    ) {
        for (const t of pending) {
            if (t.match) continue;
            const idx = targets.indexOf(t);
            if (idx < 0 || idx >= pairs.length || used.has(idx)) continue;
            if (similarity(t.inner, pairs[idx].tgt) < FLOOR) continue;
            t.match = pairs[idx];
            used.add(idx);
        }
    }

    const applied = pending.filter((t) => t.match);
    if (applied.length === 0) return null;

    // 뒤에서부터 치환하여 인덱스 보존
    let body = tgtLoc.body;
    for (let i = targets.length - 1; i >= 0; i--) {
        const t = targets[i];
        if (!t.match) continue;
        const repl = t.open + t.match.src + ' (' + t.inner.trim() + ')' + t.close;
        body = body.slice(0, t.start) + repl + body.slice(t.end);
    }

    return {
        text: fullText.slice(0, tgtLoc.start) + body + fullText.slice(tgtLoc.end),
        changed: applied.length,
    };
}

/* ---------------- 프롬프트에서 태그 추출 ---------------- */

// 프롬프트 설명문에 흔히 등장하지만 출력 태그는 아닌 것들
const TAG_BLACKLIST = new Set([
    'br', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'p', 'div',
    'span', 'hr', 'ul', 'ol', 'li', 'code', 'pre', 'sup', 'sub', 'a', 'img',
    'table', 'tr', 'td', 'th', 'thead', 'tbody', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'details', 'summary', 'font', 'center', 'blockquote',
    'user', 'char', 'system', 'example', 'instructions', 'rules',
]);

/**
 * 붙여넣은 프롬프트에서 여닫는 쌍이 존재하는 태그 후보를 순서대로 반환.
 */
export function extractTagCandidates(prompt) {
    if (!prompt) return [];
    const opens = new Map();
    const closes = new Set();

    const re = /<(\/?)([A-Za-z][\w-]*)(?:\s[^>]*)?>/g;
    let m;
    while ((m = re.exec(prompt)) !== null) {
        const isClose = m[1] === '/';
        const raw = m[2];
        const key = raw.toLowerCase();
        if (TAG_BLACKLIST.has(key)) continue;
        if (isClose) closes.add(key);
        else if (!opens.has(key)) opens.set(key, { index: m.index, raw });
    }

    return [...opens.entries()]
        .filter(([k]) => closes.has(k))
        .sort((a, b) => a[1].index - b[1].index)
        .map(([, v]) => v.raw);
}

/**
 * 태그 후보 중 원문/번역 태그를 추측.
 * 이름에 담긴 힌트를 점수로 매기고, 없으면 등장 순서(원문이 먼저)를 따른다.
 */
export function guessTagRoles(candidates) {
    if (!candidates || candidates.length < 2) return null;

    // 전체를 감싸기만 하는 껍데기 태그는 후보에서 제외
    const WRAPPER = /^(translation_protocol|protocol|format|output_format|instructions?|rules?|template|response|answer|reply)$/i;
    let pool = candidates.filter((c) => !WRAPPER.test(c));
    if (pool.length < 2) pool = candidates.slice();

    // 언어 이름이 가장 강한 단서. 그 다음이 역할 이름.
    const SRC_LANG = /(english|eng|en_|_en|latin)/i;
    const TGT_LANG = /(korean|kor|한국|japanese|jpn|jap|chinese|chn|zho|russian|rus|spanish|esp|french|fra|german|deu|thai|arabic)/i;
    const SRC_ROLE = /(source|src|original|orig|raw)/i;
    const TGT_ROLE = /(translat|trans|번역|version|localiz)/i;

    const score = (name) => {
        let s = 0;
        if (SRC_LANG.test(name)) s -= 3;
        if (SRC_ROLE.test(name)) s -= 2;
        if (TGT_LANG.test(name)) s += 3;
        if (TGT_ROLE.test(name)) s += 2;
        return s;
    };

    const scored = pool.map((name, i) => ({ name, i, s: score(name) }));

    const srcs = scored.filter((x) => x.s < 0).sort((a, b) => a.s - b.s || a.i - b.i);
    const tgts = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.i - a.i);

    let src = srcs[0]?.name;
    let tgt = tgts.find((x) => x.name !== src)?.name;

    // 한쪽만 확정된 경우, 나머지는 등장 순서로 채운다.
    if (src && !tgt) {
        tgt = pool.find((c) => c !== src && pool.indexOf(c) > pool.indexOf(src)) ||
              pool.find((c) => c !== src);
    }
    if (!src && tgt) {
        src = pool.find((c) => c !== tgt && pool.indexOf(c) < pool.indexOf(tgt)) ||
              pool.find((c) => c !== tgt);
    }
    if (!src || !tgt) {
        src = pool[0];
        tgt = pool[1];
    }

    return { sourceTag: src, targetTag: tgt };
}

/* ---------------- 형식 교정 ---------------- */
// "영어" (한국어) / "영어" ("한국어") / "영어 ("한국어")" / "영어" "한국어"
// → "영어 (한국어)"
const Q_OPEN = '["“]', Q_CLOSE = '["”]';
const EN = '([^"“”\\n()（）가-힣]*[A-Za-z][^"“”\\n()（）가-힣]*?)';
const KO = '([^"“”\\n()（）]*[가-힣][^"“”\\n()（）]*?)';
const FIX_PATTERNS = [
    new RegExp(Q_OPEN + EN + Q_CLOSE + '[ \\t]*[(（][ \\t]*' + Q_OPEN + '?' + KO + Q_CLOSE + '?[ \\t]*[)）]', 'g'),
    new RegExp(Q_OPEN + EN + '[ \\t]*[(（][ \\t]*' + Q_OPEN + KO + Q_CLOSE + '[ \\t]*[)）]' + Q_CLOSE + '?', 'g'),
    new RegExp(Q_OPEN + EN + Q_CLOSE + '[ \\t]*' + Q_OPEN + KO + Q_CLOSE, 'g'),
];

export function normalizeFormat(text) {
    let changed = 0;
    for (const re of FIX_PATTERNS) {
        text = text.replace(re, (_, en, ko) => {
            changed++;
            return `"${en.trim()} (${ko.trim()})"`;
        });
    }
    return { text, changed };
}
