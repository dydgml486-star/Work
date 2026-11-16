'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { activeBurst, pendingReminder, nextIntervalMs, kstParts } = require('../src/schedule');

// 2026-12-01 09:00 KST = 2026-12-01T00:00:00Z (화요일)
const kst = (iso) => new Date(iso);
const TUE_0858 = kst('2026-11-30T23:58:00Z');
const TUE_0900 = kst('2026-12-01T00:00:00Z');
const TUE_0915 = kst('2026-12-01T00:15:00Z');
const TUE_0930 = kst('2026-12-01T00:30:00Z');
const TUE_0850 = kst('2026-11-30T23:50:00Z');
const TUE_0840 = kst('2026-11-30T23:40:00Z');
const MON_0925 = kst('2026-11-30T00:25:00Z'); // 월요일 09:25 KST
const WED_0900 = kst('2026-12-02T00:00:00Z');

const cfg = {
  pollIntervalSec: 90,
  burst: {
    enabled: true, windowBeforeMin: 3, windowAfterMin: 20, intervalSec: 15, reminderMin: 15,
    schedule: [
      { label: '일반', weekday: 'TUE', time: '09:00' },
      { label: '시민우선', weekday: 'MON', time: '09:00', windowAfterMin: 30 },
    ],
  },
};

test('KST 변환이 요일/시각을 맞게 뽑는다', () => {
  const p = kstParts(TUE_0900);
  assert.equal(p.dow, 2);          // 화요일
  assert.equal(p.minutes, 9 * 60);
  assert.equal(p.day, 1);
});

test('오픈 3분 전은 burst 구간', () => {
  assert.equal(activeBurst(cfg, TUE_0858)?.label, '일반');
});

test('오픈 15분 후는 burst 구간', () => {
  assert.equal(activeBurst(cfg, TUE_0915)?.label, '일반');
});

test('오픈 30분 후는 평시 (윈도우 20분)', () => {
  assert.equal(activeBurst(cfg, TUE_0930), null);
});

test('항목별 windowAfterMin override 가 적용된다', () => {
  assert.equal(activeBurst(cfg, MON_0925)?.label, '시민우선');
});

test('오픈 요일이 아니면 평시', () => {
  assert.equal(activeBurst(cfg, WED_0900), null);
});

test('weekday/dayOfMonth 없는 항목은 무효', () => {
  const bad = { burst: { enabled: true, schedule: [{ time: '09:00' }] } };
  assert.equal(activeBurst(bad, TUE_0900), null);
});

test('burst 비활성이면 항상 null', () => {
  assert.equal(activeBurst({ burst: { ...cfg.burst, enabled: false } }, TUE_0900), null);
});

test('리마인더는 오픈 10분 전에 남은 분을 준다', () => {
  const r = pendingReminder(cfg, TUE_0850);
  assert.equal(r.entry.label, '일반');
  assert.equal(r.leftMin, 10);
});

test('리마인더 범위(15분) 밖이면 null', () => {
  assert.equal(pendingReminder(cfg, TUE_0840), null);
});

test('이미 오픈했으면 리마인더 없음', () => {
  assert.equal(pendingReminder(cfg, TUE_0915), null);
});

test('reminderMin=0 이면 리마인더 비활성', () => {
  const c = { burst: { ...cfg.burst, reminderMin: 0 } };
  assert.equal(pendingReminder(c, TUE_0850), null);
});

test('burst 구간 간격은 15~18초', () => {
  const ms = nextIntervalMs(cfg, TUE_0900);
  assert.ok(ms >= 15_000 && ms <= 18_000, `got ${ms}`);
});

test('평시 간격은 90초 이상', () => {
  assert.ok(nextIntervalMs(cfg, WED_0900) >= 90_000);
});

test('간격 하한 10초가 강제된다', () => {
  assert.ok(nextIntervalMs({ pollIntervalSec: 1 }, WED_0900) >= 10_000);
});
