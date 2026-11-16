'use strict';
// 예약 조회 응답(JSON/HTML) -> 공통 Slot 목록

const DATE_RE = /(20\d{2})[-./]?(\d{2})[-./]?(\d{2})/;

/** 'YYYYMMDD', 'YYYY-MM-DD', 'YYYY.M.D' 등 -> 'YYYY-MM-DD' ('' = 미확인) */
function normDate(text) {
  const s = String(text ?? '');
  let m = s.match(DATE_RE);
  if (!m) {
    m = s.match(/(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
    if (!m) return '';
  }
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  return `${y}-${String(Number(mo)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

/** 'data.list' / 'a.0.b' 점 경로 탐색 */
function dig(obj, path) {
  let cur = obj;
  for (const part of String(path || '').split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function slotKey(s) { return `${s.date}|${s.room}`; }

function parseJson(payload, rules = {}) {
  const items = rules.listPath ? dig(payload, rules.listPath) : payload;
  if (!Array.isArray(items)) return [];
  const { dateField = 'useDate', nameField = 'roomNm', remainField, statusField } = rules;
  const availKw = rules.availableKeywords || ['예약가능', '신청가능', 'Y'];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    let available;
    if (remainField != null) {
      const n = Number(it[remainField]);
      available = Number.isFinite(n) && n > 0;
    } else if (statusField != null) {
      const v = String(it[statusField] ?? '');
      available = availKw.some((k) => v === k || v.includes(k));
    } else continue;
    out.push({
      date: normDate(it[dateField]),
      room: String(it[nameField] ?? '(미표기)'),
      available,
      raw: JSON.stringify(it).slice(0, 400),
    });
  }
  return out;
}

/** cheerio 없이 돌아가도록, Playwright page.evaluate 결과(행 텍스트 배열)를 받는 형태 */
function parseRows(rows, rules = {}) {
  const availKw = rules.availableKeywords || ['예약가능', '신청가능', '가능'];
  const soldKw = rules.soldoutKeywords || ['마감', '예약완료', '불가', '대기', '휴무'];
  const out = [];
  for (const r of rows) {
    const status = String(r.status ?? r.text ?? '');
    const rowText = String(r.text ?? '').replace(/\s+/g, ' ').trim();
    if (!rowText) continue;
    let available;
    if (soldKw.some((k) => status.includes(k))) available = false;       // 마감 우선 판정
    else if (availKw.some((k) => status.includes(k))) available = true;
    else continue;                                                       // 애매한 행은 무시
    out.push({
      date: normDate(r.date ?? rowText),
      room: String(r.room ?? '').trim() || '(미표기)',
      available,
      raw: rowText.slice(0, 400),
    });
  }
  return out;
}

/** 감시 조건(날짜/객실 키워드/제외 키워드) 필터 */
function filterWatched(slots, watch = {}) {
  const dates = new Set(watch.dates || []);
  const inc = (watch.roomNameContains || []).filter(Boolean);
  const exc = (watch.roomNameExcludes || []).filter(Boolean);
  return slots.filter((s) => {
    if (dates.size && s.date && !dates.has(s.date)) return false;
    if (inc.length && !inc.some((c) => s.room.includes(c))) return false;
    if (exc.length && exc.some((c) => s.room.includes(c))) return false;
    return true;
  });
}

/** 우선순위 목록(앞이 높음) 기준 정렬. 미매칭은 뒤로. */
function rankByPriority(slots, priority = []) {
  const score = (room) => {
    const i = priority.findIndex((p) => room.includes(p));
    return i === -1 ? priority.length : i;
  };
  return [...slots].sort((a, b) => score(a.room) - score(b.room) || a.date.localeCompare(b.date));
}

module.exports = { normDate, dig, slotKey, parseJson, parseRows, filterWatched, rankByPriority };
