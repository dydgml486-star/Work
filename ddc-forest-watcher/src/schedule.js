'use strict';
// 예약 오픈 스케줄 판정. 모든 시각은 Asia/Seoul 기준.

const TZ = 'Asia/Seoul';
const WEEKDAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MIN_INTERVAL_MS = 10_000; // 차단 방지 하한

/** Date -> KST 기준 {dow, day, minutes} */
function kstParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    dow: WEEKDAYS[p.weekday.toUpperCase().slice(0, 3)],
    day: Number(p.day),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function entryOpenMinutes(entry) {
  const [h, m = '0'] = String(entry.time ?? '09:00').split(':');
  return Number(h) * 60 + Number(m);
}

function entryMatchesDate(entry, parts) {
  if (entry.weekday != null) return parts.dow === WEEKDAYS[String(entry.weekday).toUpperCase().slice(0, 3)];
  if (entry.dayOfMonth != null) return parts.day === Number(entry.dayOfMonth);
  return false; // 요일/일자 둘 다 없으면 무효 항목
}

/** 지금이 오픈 구간이면 해당 스케줄 항목, 아니면 null */
function activeBurst(cfg, now = new Date()) {
  const b = cfg.burst || {};
  if (!b.enabled) return null;
  const parts = kstParts(now);
  const beforeDefault = Number(b.windowBeforeMin ?? 3);
  const afterDefault = Number(b.windowAfterMin ?? 20);
  for (const entry of b.schedule || []) {
    if (!entryMatchesDate(entry, parts)) continue;
    const open = entryOpenMinutes(entry);
    const before = Number(entry.windowBeforeMin ?? beforeDefault);
    const after = Number(entry.windowAfterMin ?? afterDefault);
    if (parts.minutes >= open - before && parts.minutes <= open + after) return entry;
  }
  return null;
}

/** 오픈 reminderMin 분 전 구간이면 {entry, leftMin}, 아니면 null */
function pendingReminder(cfg, now = new Date()) {
  const b = cfg.burst || {};
  const lead = Number(b.reminderMin ?? 0);
  if (!b.enabled || lead <= 0) return null;
  const parts = kstParts(now);
  for (const entry of b.schedule || []) {
    if (!entryMatchesDate(entry, parts)) continue;
    const left = entryOpenMinutes(entry) - parts.minutes;
    if (left > 0 && left <= lead) return { entry, leftMin: left };
  }
  return null;
}

/** 다음 조회까지 대기 시간(ms). 랜덤 지터 포함, 하한 10초. */
function nextIntervalMs(cfg, now = new Date()) {
  const entry = activeBurst(cfg, now);
  const sec = entry
    ? Number(entry.intervalSec ?? cfg.burst?.intervalSec ?? 15)
    : Number(cfg.pollIntervalSec ?? 90);
  const base = Math.max(MIN_INTERVAL_MS, sec * 1000);
  return base + Math.floor(Math.random() * Math.max(1000, base * 0.2));
}

module.exports = { TZ, WEEKDAYS, MIN_INTERVAL_MS, kstParts, activeBurst, pendingReminder, nextIntervalMs };
