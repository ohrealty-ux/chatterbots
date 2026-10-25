// Bot wake-webhook notifier. Sends a short fixed-schema JSON notice to a bot's registered
// webhook when something happens (mentioned / meeting_invite / meeting_report_due).
// Security posture:
//  • url + key are stored encrypted (AES-256-GCM, bound to bot id) and decrypted only here.
//  • every send goes through safeFetchPost (SSRF guard, re-validated at send time).
//  • 1 notice / bot / 30s and 60 / bot / day; circuit-break after 5 consecutive failures.
//  • bounded queue, concurrency 4; HMAC-SHA256(key, body+timestamp) signature headers.
//  • notice body is a fixed schema (<=280 chars), no secrets, no chat text.
import crypto from 'node:crypto';
import { Bots } from '../db/db.js';
import { decryptForBot } from '../security/crypto.js';
import { safeFetchPost, validateWebhookUrl } from '../security/ssrf.js';
import { logger } from '../security/logger.js';

const NOTICE_EVENTS = new Set(['mentioned', 'meeting_invite', 'meeting_report_due']);
const MIN_INTERVAL_MS = 30000;
const DAILY_CAP = 60;
const BREAKER_THRESHOLD = 5;
const MAX_QUEUE = 500;
const CONCURRENCY = 4;

export class WakeNotifier {
  constructor({ log } = {}) {
    this.log = log || logger.info;
    this.state = new Map();  // botId -> { last, day, count, fails, broken }
    this.queue = [];
    this.active = 0;
  }

  _st(botId) {
    let s = this.state.get(botId);
    const today = new Date().toISOString().slice(0, 10);
    if (!s) { s = { last: 0, day: today, count: 0, fails: 0, broken: false }; this.state.set(botId, s); }
    if (s.day !== today) { s.day = today; s.count = 0; }
    return s;
  }

  // Queue a notice. `text` is caller-supplied but re-clamped to a safe fixed schema here.
  notify(botId, event, text = '') {
    if (!NOTICE_EVENTS.has(event)) return { ok: false, error: 'bad_event' };
    const bot = Bots.get(botId);
    if (!bot || bot.revoked || bot.status !== 'approved') return { ok: false, error: 'not_eligible' };
    if (!bot.webhook_enc || !bot.webhook_enabled) return { ok: false, error: 'no_webhook' };
    const s = this._st(botId);
    const now = Date.now();
    if (s.broken) return { ok: false, error: 'circuit_open' };
    if (now - s.last < MIN_INTERVAL_MS) return { ok: false, error: 'throttled' };
    if (s.count >= DAILY_CAP) return { ok: false, error: 'daily_cap' };
    if (this.queue.length >= MAX_QUEUE) return { ok: false, error: 'queue_full' };
    s.last = now; s.count += 1;
    // Fixed schema, no secrets, no chat text — just a short safe notice string.
    const notice = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 280);
    this.queue.push({ botId, event, notice, ts: Date.now() });
    this._pump();
    return { ok: true };
  }

  _pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      this._send(job).finally(() => { this.active -= 1; this._pump(); });
    }
  }

  async _send(job) {
    const bot = Bots.get(job.botId);
    const s = this._st(job.botId);
    if (!bot || !bot.webhook_enc || !bot.webhook_key_enc || !bot.webhook_enabled) return;
    let url, key;
    try {
      url = decryptForBot(bot.id, bot.webhook_enc);
      key = decryptForBot(bot.id, bot.webhook_key_enc);
    } catch { return; }
    // Re-validate at send time (not only at registration).
    const v = await validateWebhookUrl(url);
    if (!v.ok) { this._fail(s, bot.id, 'validate:' + v.reason); return; }

    const timestamp = String(Date.now());
    const body = JSON.stringify({
      source: 'chatterbots',
      event: job.event,
      bot: bot.id,
      message: job.notice,
      ts: timestamp,
    });
    const sig = crypto.createHmac('sha256', key).update(body + timestamp).digest('hex');
    const res = await safeFetchPost(url, {
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Chatter-Signature': sig,
        'X-Chatter-Timestamp': timestamp,
      },
      timeoutMs: 5000,
    });
    if (res.ok) { s.fails = 0; }
    else { this._fail(s, bot.id, res.reason || ('status_' + res.status)); }
  }

  _fail(s, botId, reason) {
    s.fails = (s.fails || 0) + 1;
    this.log('[wake] delivery failed', { bot: botId, reason, fails: s.fails });
    if (s.fails >= BREAKER_THRESHOLD) { s.broken = true; this.log('[wake] circuit opened for bot', { bot: botId }); }
  }

  // Admin: reset the breaker after a webhook is fixed/re-enabled.
  reset(botId) { const s = this.state.get(botId); if (s) { s.broken = false; s.fails = 0; } }
}
