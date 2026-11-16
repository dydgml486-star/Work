#!/usr/bin/env node
'use strict';
/**
 * 숲나들e 동두천자연휴양림 감시/대응 엔진.
 *
 *   node watch.js --once        조회 1회 (설정 검증)
 *   node watch.js               상시 실행
 *   node watch.js --autofill    빈자리 발견 시 예약 화면까지 자동 진입 (최종 확정은 사용자)
 *
 * 최종 예약 확정/결제 버튼은 누르지 않는다.
 */

const fs = require('node:fs');
const path = require('node:path');
const { activeBurst, pendingReminder, nextIntervalMs } = require('./src/schedule');
const { parseJson, parseRows, filterWatched, rankByPriority, slotKey } = require('./src/parse');
const { Notifier } = require('./src/notify');

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const AUTOFILL = args.includes('--autofill');
const CONFIG = args.includes('-c') ? args[args.indexOf('-c') + 1] : 'config.json';

const ts = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
const log = (...a) => console.log(ts(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadConfig(p) {
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const t of cfg.targets || []) {
    if (String(t.url || '').includes('PUT-REAL')) {
      throw new Error('config.json 의 url 이 아직 예시값입니다. 먼저 `node inspect.js capture` 를 실행하세요.');
    }
  }
  return cfg;
}

/** 로그인 세션이 필요한 조회를 위해 브라우저 컨텍스트를 지연 생성 */
let browserState = null;
async function getBrowser(cfg) {
  if (browserState) return browserState;
  const { launch } = require('./src/browser');
  const { ctx } = await launch({ headless: cfg.browser?.headless ?? true });
  const page = await ctx.newPage();
  browserState = { ctx, page };
  return browserState;
}

/** 대상 1건 조회 -> Slot[] */
async function fetchTarget(cfg, target) {
  if (target.mode === 'rows') {
    // 로그인 세션이 필요한 HTML 화면: 브라우저로 직접 읽는다
    const { page } = await getBrowser(cfg);
    await page.goto(target.url || target.bookingPage, { waitUntil: 'domcontentloaded' });
    const sel = target.rows || {};
    const rows = await page.evaluate((s) => {
      return [...document.querySelectorAll(s.rowSelector)].map((tr) => {
        const pick = (q) => (q ? (tr.querySelector(q)?.innerText || '').trim() : '');
        return {
          text: tr.innerText.trim(),
          room: pick(s.nameSelector),
          date: pick(s.dateSelector),
          status: pick(s.statusSelector) || tr.innerText.trim(),
        };
      });
    }, sel);
    return parseRows(rows, sel);
  }

  // JSON/HTTP 조회
  const headers = {
    'User-Agent': cfg.http?.userAgent || 'ddc-forest-watcher/0.2',
    ...(target.headers || {}),
  };
  const init = { method: target.method || 'GET', headers, signal: AbortSignal.timeout((cfg.http?.timeoutSec ?? 15) * 1000) };
  if (init.method !== 'GET' && target.body != null) {
    init.body = typeof target.body === 'string' ? target.body : JSON.stringify(target.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(target.url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseJson(await res.json(), target.json || {});
}

/** 예약 화면 자동 진입 — 최종 확정 버튼은 누르지 않는다. */
async function autofill(cfg, target, slot) {
  const { page } = await getBrowser(cfg);
  const url = target.bookingPage || target.url;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const steps = target.autofill?.steps || [];
  const applied = [];
  for (const step of steps) {
    try {
      const sel = String(step.selector).replace('{date}', slot.date).replace('{room}', slot.room);
      if (step.action === 'click') await page.click(sel, { timeout: 8000 });
      else if (step.action === 'fill') await page.fill(sel, String(step.value).replace('{date}', slot.date));
      else if (step.action === 'select') await page.selectOption(sel, String(step.value));
      else if (step.action === 'wait') await page.waitForSelector(sel, { timeout: 10_000 });
      applied.push(step.label || `${step.action} ${sel}`);
    } catch (e) {
      applied.push(`실패: ${step.label || step.action} (${e.message.split('\n')[0]})`);
      break;
    }
  }
  const shot = path.join(__dirname, `autofill-${slot.date}-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  return { applied, screenshot: shot, url: page.url() };
}

async function tick(cfg, notifier) {
  const now = new Date();

  const rem = pendingReminder(cfg, now);
  if (rem) {
    const first = cfg.targets[0];
    await notifier.send(
      `reminder|${rem.entry.label}|${now.toISOString().slice(0, 10)}`,
      `[오픈 ${rem.leftMin}분 전] 동두천자연휴양림 ${rem.entry.label || ''}`.trim(),
      `오픈: ${rem.entry.time || '09:00'} KST\n예약 페이지: ${first.bookingPage || first.url}`,
    );
  }

  const burst = activeBurst(cfg, now);
  if (burst) log(`예약 오픈 구간: ${burst.label || JSON.stringify(burst)}`);

  let found = 0;
  for (const target of cfg.targets) {
    let slots;
    try {
      slots = filterWatched(await fetchTarget(cfg, target), target.watch || {});
    } catch (e) {
      log(`[${target.name}] 조회 실패: ${e.message}`);
      continue;
    }

    for (const s of slots) if (!s.available) notifier.clear(`${target.name}|${slotKey(s)}`);
    const avail = rankByPriority(slots.filter((s) => s.available), target.watch?.priority || []);
    log(`[${target.name}] 감시대상 ${slots.length}건 중 예약가능 ${avail.length}건`);
    found += avail.length;

    for (const s of avail) {
      let extra = '';
      if (AUTOFILL && s === avail[0]) {
        try {
          const r = await autofill(cfg, target, s);
          extra = `\n\n[자동 진입 결과]\n${r.applied.join('\n')}\n현재 URL: ${r.url}\n스크린샷: ${r.screenshot}\n`
                + '>> 브라우저에서 최종 확인 후 직접 예약 확정하세요.';
        } catch (e) {
          extra = `\n\n[자동 진입 실패] ${e.message}`;
        }
      }
      await notifier.send(
        `${target.name}|${slotKey(s)}`,
        '[빈자리] 동두천자연휴양림 예약 가능',
        `시설: ${target.name}\n날짜: ${s.date || '(미표기)'}\n객실: ${s.room}\n`
        + `확인: ${ts()}\n예약: ${target.bookingPage || target.url}\n\n근거: ${s.raw}${extra}`,
      );
    }
  }
  return found;
}

async function main() {
  const cfg = loadConfig(CONFIG);
  const notifier = new Notifier(cfg.notify || {});
  let errors = 0;
  const maxErrors = Number(cfg.http?.maxConsecutiveErrors ?? 10);

  log(`시작. autofill=${AUTOFILL ? 'ON (최종 확정은 사용자)' : 'OFF'}`);
  for (;;) {
    try {
      const found = await tick(cfg, notifier);
      errors = 0;
      if (ONCE) {
        if (browserState) await browserState.ctx.close();
        process.exitCode = found ? 0 : 1;
        return;
      }
    } catch (e) {
      errors += 1;
      log(`tick 오류 (${errors}/${maxErrors}): ${e.message}`);
      if (errors >= maxErrors) {
        log('연속 실패 한도 초과. 종료합니다.');
        process.exitCode = 2;
        return;
      }
    }
    await sleep(nextIntervalMs(cfg));
  }
}

if (require.main === module) {
  process.on('SIGINT', () => { log('중단'); process.exit(0); });
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
