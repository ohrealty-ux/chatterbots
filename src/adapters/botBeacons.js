// Bot Beacons adapter. Subscribes to an ntfy topic, AES-256 decrypts each message,
// and maps beacon events to world behavior. Read-only consumer of the upstream project
// (github.com/SnazzyGaz/bot-beacons) which does one-way AES-256 encrypted ntfy notifications.
// INERT and logged as disabled if BOT_BEACONS_* env is not set. No file/command access.
import crypto from 'node:crypto';

function parseKey(k) {
  if (!k) return null;
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, 'hex');
  try { const b = Buffer.from(k, 'base64'); if (b.length === 32) return b; } catch { /* ignore */ }
  return null;
}

// Supports two common layouts: {iv,ct,tag} JSON (GCM) or iv(12)|tag(16)|ct raw base64 (GCM).
function aesDecrypt(payload, key) {
  try {
    let iv, ct, tag;
    const obj = typeof payload === 'string' && payload.trim().startsWith('{') ? JSON.parse(payload) : null;
    if (obj && obj.iv && obj.ct) {
      iv = Buffer.from(obj.iv, 'base64'); ct = Buffer.from(obj.ct, 'base64');
      tag = obj.tag ? Buffer.from(obj.tag, 'base64') : null;
    } else {
      const raw = Buffer.from(String(payload), 'base64');
      iv = raw.subarray(0, 12); tag = raw.subarray(12, 28); ct = raw.subarray(28);
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (tag) decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export class BotBeacons {
  constructor({ log, onBeacon }) {
    this.log = log || console.log;
    this.onBeacon = onBeacon || (() => {});
    this.topic = process.env.BOT_BEACONS_NTFY_TOPIC || '';
    this.server = process.env.BOT_BEACONS_NTFY_SERVER || 'https://ntfy.sh';
    this.key = parseKey(process.env.BOT_BEACONS_AES_KEY || '');
    this.enabled = !!(this.topic && this.key);
    this.abort = null;
  }

  start() {
    if (!this.enabled) {
      this.log('[bot-beacons] adapter DISABLED (set BOT_BEACONS_NTFY_TOPIC + BOT_BEACONS_AES_KEY to enable).');
      return;
    }
    this.log(`[bot-beacons] adapter ENABLED, subscribing to ${this.server}/${this.topic}`);
    this._subscribe();
  }

  async _subscribe() {
    const url = `${this.server}/${this.topic}/json`;
    this.abort = new AbortController();
    try {
      const r = await fetch(url, { signal: this.abort.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.trim()) this._handleLine(line);
        }
      }
    } catch (e) {
      if (this.abort?.signal.aborted) return;
      this.log('[bot-beacons] stream error, retrying in 15s:', e.message);
      setTimeout(() => this._subscribe(), 15000);
    }
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event !== 'message' || !msg.message) return;
    const plain = aesDecrypt(msg.message, this.key);
    if (!plain) { this.log('[bot-beacons] failed to decrypt a beacon (ignored)'); return; }
    let data;
    try { data = JSON.parse(plain); } catch { data = { type: 'raw', text: plain }; }
    // Map beacon -> world behavior. e.g. { bot, type:'task_done', text }
    this.onBeacon(data);
  }

  stop() { this.abort?.abort(); }
}
