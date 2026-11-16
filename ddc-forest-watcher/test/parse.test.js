'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normDate, dig, parseJson, parseRows, filterWatched, rankByPriority } = require('../src/parse');
const { findCandidateArrays } = require('../inspect');

test('날짜 정규화', () => {
  assert.equal(normDate('20261224'), '2026-12-24');
  assert.equal(normDate('2026-12-24'), '2026-12-24');
  assert.equal(normDate('2026.12.25'), '2026-12-25');
  assert.equal(normDate('2026.1.5'), '2026-01-05');
  assert.equal(normDate('예약가능'), '');
  assert.equal(normDate(null), '');
  assert.equal(normDate('20261399'), '', '잘못된 월/일은 거른다');
});

test('점 경로 탐색', () => {
  assert.deepEqual(dig({ a: { b: [1, 2] } }, 'a.b'), [1, 2]);
  assert.equal(dig({ a: { b: [1, 2] } }, 'a.b.1'), 2);
  assert.equal(dig({ a: 1 }, 'x.y'), undefined);
});

const payload = { data: { list: [
  { useDate: '20261224', roomNm: '숲속의집 A', remainCnt: 1 },
  { useDate: '20261224', roomNm: '숲속의집 B', remainCnt: 0 },
  { useDate: '20261225', roomNm: '캠핑데크 1', remainCnt: 2 },
] } };
const jsonRules = { listPath: 'data.list', dateField: 'useDate', nameField: 'roomNm', remainField: 'remainCnt' };

test('JSON 파싱: 잔여수량으로 가능/마감 판정', () => {
  const s = parseJson(payload, jsonRules);
  assert.equal(s.length, 3);
  assert.equal(s.filter((x) => x.available).length, 2);
  assert.equal(s[0].date, '2026-12-24');
});

test('JSON 파싱: 잘못된 listPath 는 예외 없이 빈 배열', () => {
  assert.deepEqual(parseJson(payload, { listPath: 'no.such' }), []);
});

test('JSON 파싱: statusField 방식', () => {
  const p = [{ useDate: '20261224', roomNm: 'A', rsrvtSttus: '예약가능' },
             { useDate: '20261224', roomNm: 'B', rsrvtSttus: '예약마감' }];
  const s = parseJson(p, { dateField: 'useDate', nameField: 'roomNm', statusField: 'rsrvtSttus' });
  assert.deepEqual(s.map((x) => x.available), [true, false]);
});

const rows = [
  { text: '숲속의집 A 2026-12-24 예약가능', room: '숲속의집 A', date: '2026-12-24', status: '예약가능' },
  { text: '숲속의집 B 2026-12-24 예약마감', room: '숲속의집 B', date: '2026-12-24', status: '예약마감' },
  { text: '캠핑데크 1 2026.12.25 예약가능', room: '캠핑데크 1', date: '2026.12.25', status: '예약가능' },
  { text: '조회 결과가 없습니다', room: '', date: '', status: '조회 결과가 없습니다' },
];

test('행 파싱: 마감 우선 판정, 애매한 행은 무시', () => {
  const s = parseRows(rows, {});
  assert.equal(s.length, 3, '"조회 결과가 없습니다" 행은 버린다');
  assert.equal(s.filter((x) => x.available).length, 2);
  assert.equal(s[2].date, '2026-12-25');
});

test('행 파싱: 가능/마감 키워드가 같이 있으면 마감으로 본다', () => {
  const s = parseRows([{ text: 'x', room: 'A', date: '2026-12-24', status: '예약가능 마감' }], {});
  assert.equal(s[0].available, false);
});

test('감시조건 필터: 날짜 + 포함 키워드', () => {
  const s = parseRows(rows, {});
  const f = filterWatched(s, { dates: ['2026-12-24'], roomNameContains: ['A'] });
  assert.deepEqual(f.map((x) => x.room), ['숲속의집 A']);
});

test('감시조건 필터: 제외 키워드', () => {
  const s = parseRows(rows, {});
  const f = filterWatched(s, { roomNameExcludes: ['캠핑'] });
  assert.equal(f.length, 2);
});

test('우선순위 정렬: 앞에 적은 키워드가 먼저', () => {
  const s = [{ room: '캠핑데크 1', date: '2026-12-25' }, { room: '숲속의집 A', date: '2026-12-24' }];
  const r = rankByPriority(s, ['숲속의집', '캠핑데크']);
  assert.deepEqual(r.map((x) => x.room), ['숲속의집 A', '캠핑데크 1']);
});

test('우선순위 미매칭 항목은 뒤로', () => {
  const s = [{ room: '기타동', date: '2026-12-24' }, { room: '숲속의집 A', date: '2026-12-24' }];
  assert.equal(rankByPriority(s, ['숲속의집'])[0].room, '숲속의집 A');
});

test('inspect: JSON 응답에서 빈자리 배열 경로를 자동으로 찾는다', () => {
  const c = findCandidateArrays(payload).sort((a, b) => b.score - a.score);
  assert.ok(c.length > 0);
  assert.equal(c[0].listPath, 'data.list');
  assert.equal(c[0].dateField, 'useDate');
  assert.equal(c[0].nameField, 'roomNm');
  assert.equal(c[0].remainField, 'remainCnt');
});

test('inspect: 관련 없는 JSON 은 후보를 만들지 않는다', () => {
  assert.deepEqual(findCandidateArrays({ ok: true, items: [1, 2, 3] }), []);
});
