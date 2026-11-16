'use strict';
// 로그인 세션을 디스크에 유지하는 Playwright 브라우저. 로그인은 사용자가 1회 수동.

const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

const DEFAULT_PROFILE = path.join(os.homedir(), '.ddc-forest-watcher', 'profile');
const EXECUTABLE = process.env.DDC_CHROMIUM_PATH || undefined; // 리눅스 컨테이너용 override

/**
 * 영구 프로필로 브라우저 실행. 한 번 로그인하면 이후 세션이 유지된다.
 * @param {{headless?: boolean, profileDir?: string, slowMo?: number}} opts
 */
async function launch(opts = {}) {
  const profileDir = opts.profileDir || process.env.DDC_PROFILE_DIR || DEFAULT_PROFILE;
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? false,
    executablePath: EXECUTABLE,
    slowMo: opts.slowMo ?? 0,
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  ctx.setDefaultTimeout(20_000);
  return { ctx, profileDir };
}

/** 로그인 여부 추정: 로그아웃 링크나 마이페이지 흔적이 있으면 로그인된 것으로 본다. */
async function isLoggedIn(page, markers = ['로그아웃', '마이페이지', 'MY예약']) {
  const body = await page.content().catch(() => '');
  return markers.some((m) => body.includes(m));
}

module.exports = { launch, isLoggedIn, DEFAULT_PROFILE };
