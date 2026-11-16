#!/usr/bin/env node
'use strict';
/**
 * 숲나들e 사이트 구조 자동 수집기.
 *
 *   node inspect.js login     -> 브라우저 열고 사용자가 1회 로그인 (세션 디스크 저장)
 *   node inspect.js capture   -> 예약 조회 화면을 돌아다니며 XHR/표 구조 수집 + config 후보 생성
 *
 * 수집물은 ./site-dump/ 에 저장된다. 네트워크 요청/응답을 기록할 뿐 예약을 진행하지 않는다.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { launch, isLoggedIn } = require('./src/browser');
const { normDate } = require('./src/parse');

const HMPG_ID = 'ID02030023'; // 동두천자연휴양림
const HOME = `https://www.foresttrip.go.kr/indvz/main.do?hmpgId=${HMPG_ID}`;
const DUMP_DIR = path.join(__dirname, 'site-dump');

const DATE_KEY_RE = /(date|dt|ymd|day|useYmd|rsrvt)/i;
const NAME_KEY_RE = /(nm|name|room|fclt|시설|객실)/i;
const REMAIN_KEY_RE = /(remain|cnt|count|possible|able|stock|잔여)/i;

function log(...a) { console.log('[inspect]', ...a); }

/** 응답 JSON에서 "빈자리 목록"처럼 보이는 배열 경로를 찾는다. */
function findCandidateArrays(payload, prefix = '', out = [], depth = 0) {
  if (depth > 5 || payload == null) return out;
  if (Array.isArray(payload)) {
    const sample = payload.find((x) => x && typeof x === 'object');
    if (sample) {
      const keys = Object.keys(sample);
      const dateKey = keys.find((k) => DATE_KEY_RE.test(k) && normDate(sample[k]));
      const nameKey = keys.find((k) => NAME_KEY_RE.test(k) && typeof sample[k] === 'string');
      const remainKey = keys.find((k) => REMAIN_KEY_RE.test(k) && Number.isFinite(Number(sample[k])));
      if (dateKey || nameKey) {
        out.push({
          listPath: prefix, length: payload.length, keys,
          dateField: dateKey || null, nameField: nameKey || null, remainField: remainKey || null,
          sample,
          score: (dateKey ? 2 : 0) + (nameKey ? 2 : 0) + (remainKey ? 3 : 0) + Math.min(payload.length, 5) / 5,
        });
      }
    }
    return out;
  }
  if (typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      findCandidateArrays(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
  return out;
}

/** 페이지 안의 표를 행 단위로 덤프 (selector 추정용) */
async function dumpTables(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    return tables.slice(0, 10).map((t, ti) => {
      const rows = [...t.querySelectorAll('tbody tr')].slice(0, 8).map((tr) => ({
        cells: [...tr.querySelectorAll('th,td')].map((td) => td.innerText.trim().replace(/\s+/g, ' ').slice(0, 60)),
      }));
      return {
        index: ti,
        caption: (t.caption?.innerText || '').trim().slice(0, 80),
        headers: [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim()),
        rows,
      };
    });
  });
}

async function cmdLogin() {
  const { ctx, profileDir } = await launch({ headless: false });
  const page = await ctx.newPage();
  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  log(`프로필 경로: ${profileDir}`);
  log('브라우저에서 숲나들e 로그인을 완료하세요. 완료되면 이 창에서 Enter.');
  await new Promise((r) => process.stdin.once('data', r));
  const ok = await isLoggedIn(page);
  log(ok ? '로그인 확인됨. 세션이 프로필에 저장됐습니다.' : '로그인 흔적을 못 찾았습니다. 그래도 세션은 저장됩니다.');
  await ctx.close();
}

async function cmdCapture() {
  await fsp.mkdir(DUMP_DIR, { recursive: true });
  const { ctx } = await launch({ headless: false });
  const page = await ctx.newPage();

  const xhrs = [];
  page.on('response', async (res) => {
    const req = res.request();
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    const rec = {
      url: req.url(), method: req.method(), status: res.status(),
      postData: req.postData()?.slice(0, 2000) || null,
      headers: Object.fromEntries(Object.entries(req.headers())
        .filter(([k]) => ['referer', 'content-type', 'x-requested-with', 'accept'].includes(k))),
      contentType: ct,
    };
    try {
      const text = await res.text();
      rec.bodySnippet = text.slice(0, 4000);
      if (ct.includes('json')) {
        const json = JSON.parse(text);
        rec.candidates = findCandidateArrays(json).sort((a, b) => b.score - a.score).slice(0, 3);
      }
    } catch { /* 본문 못 읽는 응답은 메타만 기록 */ }
    xhrs.push(rec);
  });

  await page.goto(HOME, { waitUntil: 'domcontentloaded' });
  log('로그인 상태: ' + ((await isLoggedIn(page)) ? '확인됨' : '미확인 (node inspect.js login 먼저 실행 권장)'));
  log('');
  log('이제 브라우저에서 "숙박예약" -> 숲속의집/야영장 -> 날짜 조회 화면까지 들어가세요.');
  log('조회 월을 2~3번 바꿔주시면 필요한 요청이 전부 기록됩니다.');
  log('끝나면 이 창에서 Enter.');
  await new Promise((r) => process.stdin.once('data', r));

  const tables = await dumpTables(page).catch(() => []);
  const finalUrl = page.url();

  await fsp.writeFile(path.join(DUMP_DIR, 'xhr.json'), JSON.stringify(xhrs, null, 2));
  await fsp.writeFile(path.join(DUMP_DIR, 'tables.json'), JSON.stringify(tables, null, 2));
  await fsp.writeFile(path.join(DUMP_DIR, 'page.html'), await page.content());

  // config 후보 생성
  const best = xhrs
    .flatMap((x) => (x.candidates || []).map((c) => ({ ...c, xhr: x })))
    .sort((a, b) => b.score - a.score)[0];

  const suggestion = best
    ? {
        mode: 'json',
        url: best.xhr.url,
        method: best.xhr.method,
        headers: best.xhr.headers,
        body: best.xhr.postData,
        bookingPage: finalUrl,
        json: {
          listPath: best.listPath,
          dateField: best.dateField,
          nameField: best.nameField,
          remainField: best.remainField,
        },
        _detectedKeys: best.keys,
        _sample: best.sample,
      }
    : {
        mode: 'rows',
        bookingPage: finalUrl,
        _note: 'JSON 후보를 못 찾았습니다. tables.json 을 보고 rows 모드 selector 를 정해야 합니다.',
        _tableCount: tables.length,
      };

  await fsp.writeFile(path.join(DUMP_DIR, 'suggested-target.json'), JSON.stringify(suggestion, null, 2));

  log('');
  log(`XHR ${xhrs.length}건, 표 ${tables.length}개 수집 완료 -> ${DUMP_DIR}`);
  log('생성 파일: xhr.json, tables.json, page.html, suggested-target.json');
  if (best) {
    log(`자동 추정 성공: ${best.xhr.method} ${best.xhr.url}`);
    log(`  listPath=${best.listPath} date=${best.dateField} name=${best.nameField} remain=${best.remainField}`);
    log('suggested-target.json 내용을 config.json 의 targets[0] 에 넣으면 됩니다.');
  } else {
    log('자동 추정 실패. site-dump/ 를 그대로 전달해 주시면 수동으로 맞춥니다.');
  }
  await ctx.close();
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'login') return cmdLogin();
  if (cmd === 'capture') return cmdCapture();
  console.error('사용법: node inspect.js login | node inspect.js capture');
  process.exitCode = 2;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { findCandidateArrays };
