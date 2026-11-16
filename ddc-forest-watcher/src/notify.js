'use strict';
// 알림 채널. 같은 슬롯 반복 알림 억제.

const nodemailerAvailable = false; // 의존성 추가 없이 텔레그램만 기본 지원

class Notifier {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.suppressMs = Number(cfg.repeatSuppressMin ?? 30) * 60_000;
    this.sent = new Map();
  }

  shouldSend(key) {
    const now = Date.now();
    const last = this.sent.get(key) ?? 0;
    if (now - last < this.suppressMs) return false;
    this.sent.set(key, now);
    return true;
  }

  /** 슬롯이 다시 마감되면 억제 해제 -> 재오픈 시 다시 알림 */
  clear(key) { this.sent.delete(key); }

  async send(key, subject, body) {
    if (!this.shouldSend(key)) return;
    if (this.cfg.console?.enabled !== false) {
      console.log(`\n*** ${subject}\n${body}\n`);
    }
    const tg = this.cfg.telegram;
    if (tg?.enabled) await this.telegram(tg, `${subject}\n${body}`);
  }

  async telegram(tg, text) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tg.chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.warn(`텔레그램 전송 실패: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`텔레그램 전송 실패: ${e.message}`); // 알림 실패가 감시를 죽이지 않게
    }
  }
}

module.exports = { Notifier, nodemailerAvailable };
