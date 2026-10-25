// Security helpers: token generation/hashing, rate limiting, text sanitization, profanity filter, CSP,
// password hashing (scrypt), constant-time compare, bidi/zero-width stripping.
// ALL secrets come from env vars only; nothing here logs or returns a secret.
import crypto from 'node:crypto';

// ───────── Bot world-pass tokens: random, stored only as a hash, prefix for lookup ─────────
// Token = `eldr_` + 32 random bytes (base64url). The plaintext exists only at creation time.
// Stored as sha256 (or HMAC-SHA256 keyed by TOKEN_PEPPER if that env is set) + a 12-char
// lookup prefix. Changing TOKEN_PEPPER changes the digest scheme; absent a pepper (the
// default) the digest is plain sha256, so existing stored hashes keep validating.
export function generateToken() {
  const raw = 'eldr_' + crypto.randomBytes(32).toString('base64url'); // the only time the plaintext exists
  const prefix = raw.slice(0, 12);
  const hash = hashToken(raw);
  return { raw, prefix, hash };
}
export function hashToken(raw) {
  const pepper = process.env.TOKEN_PEPPER;
  if (pepper) return crypto.createHmac('sha256', pepper).update(String(raw)).digest('hex');
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}
export function verifyToken(raw, hash) {
  if (!raw || !hash) return false;
  const a = Buffer.from(hashToken(raw));
  const b = Buffer.from(String(hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Equal-length constant-time compare of two strings (false if lengths differ — never leaks via early return).
function _eqLen(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
// Verify a world pass, tolerating legacy storage so pre-hardening bot rows keep authenticating.
// Returns 'current' (matches the active sha256/HMAC scheme), 'legacy' (matches an older scheme
// or a raw/plaintext token — caller should re-store via hashToken), or null (no match).
export function verifyTokenMigratable(raw, hash) {
  if (!raw || !hash) return null;
  if (verifyToken(raw, hash)) return 'current';
  // Legacy #1: plain sha256 digest (row predates TOKEN_PEPPER being configured).
  const sha = crypto.createHash('sha256').update(String(raw)).digest('hex');
  if (_eqLen(sha, hash)) return 'legacy';
  // Legacy #2: token stored as raw plaintext (earliest scheme).
  if (_eqLen(raw, hash)) return 'legacy';
  return null;
}

// ───────── Constant-time compare for arbitrary strings (hash both sides to equal length) ─────────
export function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ───────── Admin password hashing (scrypt; salt + params embedded) ─────────
// Format: scrypt$N$r$p$<saltB64>$<hashB64>
export function hashPassword(password, { N = 16384, r = 8, p = 1, keylen = 64 } = {}) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string') return false;
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const dk = crypto.scryptSync(String(password), salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

// ───────── Rate limiter: token-bucket per key, pruned + size-capped ─────────
export class RateLimiter {
  constructor({ maxKeys = 50000, idleMs = 600000 } = {}) {
    this.buckets = new Map();
    this.maxKeys = maxKeys;
    this.idleMs = idleMs;
    this._timer = setInterval(() => this._prune(), 60000);
    this._timer.unref?.();
  }
  _prune() {
    const cutoff = Date.now() - this.idleMs;
    for (const [k, b] of this.buckets) if (b.last < cutoff) this.buckets.delete(k);
  }
  _bucket(key, ratePerSec, burst) {
    let b = this.buckets.get(key);
    const nowMs = Date.now();
    if (!b) {
      // Hard cap the map to prevent memory DoS; drop the oldest entry if full.
      if (this.buckets.size >= this.maxKeys) { const first = this.buckets.keys().next().value; this.buckets.delete(first); }
      b = { tokens: burst, last: nowMs }; this.buckets.set(key, b);
    }
    const elapsed = (nowMs - b.last) / 1000;
    b.tokens = Math.min(burst, b.tokens + elapsed * ratePerSec);
    b.last = nowMs;
    return b;
  }
  allow(key, ratePerSec = 10, burst = 20) {
    const b = this._bucket(key, ratePerSec, burst);
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    return false;
  }
}

// Sliding-window counter (for msgs/min, per-hour, per-day), pruned + size-capped.
export class WindowCounter {
  constructor(windowMs, { maxKeys = 50000 } = {}) {
    this.windowMs = windowMs;
    this.hits = new Map();
    this.maxKeys = maxKeys;
    this._timer = setInterval(() => this._prune(), 60000);
    this._timer.unref?.();
  }
  _prune() {
    const nowMs = Date.now();
    for (const [k, arr] of this.hits) {
      const kept = arr.filter(t => nowMs - t < this.windowMs);
      if (kept.length) this.hits.set(k, kept); else this.hits.delete(k);
    }
  }
  allow(key, max) {
    const nowMs = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => nowMs - t < this.windowMs);
    if (arr.length >= max) { this.hits.set(key, arr); return false; }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) { const first = this.hits.keys().next().value; this.hits.delete(first); }
    arr.push(nowMs); this.hits.set(key, arr); return true;
  }
  // Count current hits without consuming one (for lockout inspection).
  count(key) {
    const nowMs = Date.now();
    return (this.hits.get(key) || []).filter(t => nowMs - t < this.windowMs).length;
  }
}

// ───────── Text sanitization. ALL human/bot text is untrusted. Rendered as textContent only. ─────────
// Strips bidi-override and zero-width characters that can be used to spoof names / smuggle text.
const BIDI_ZW_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad\u061c]/g;
export function stripBidi(s) { return typeof s === 'string' ? s.replace(BIDI_ZW_RE, '') : s; }

export function sanitizeText(input, maxChars = 500) {
  if (typeof input !== 'string') return '';
  // strip control chars + bidi/zero-width, collapse whitespace, hard cap length.
  let s = input
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(BIDI_ZW_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}
export function sanitizeName(input, maxChars = 24) {
  if (typeof input !== 'string') return 'Guest';
  let s = input.replace(BIDI_ZW_RE, '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, maxChars);
  return s || 'Guest';
}

// ───────── Minimal profanity filter (masks, does not block) ─────────
const BAD = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'retard', 'whore'];
const BAD_RE = new RegExp('\\b(' + BAD.join('|') + ')\\b', 'gi');
export function filterProfanity(text) {
  return String(text || '').replace(BAD_RE, m => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
}

// ───────── Content-Security-Policy. Strict; self only; no inline. ─────────
// connect-src is pinned to wss://<PUBLIC_HOST> (no bare ws:/wss:). frame-ancestors is 'none'
// unless FRAME_ANCESTORS env lists explicit origins (never a wildcard).
export function cspHeader(publicHost) {
  const host = (publicHost || process.env.PUBLIC_HOST || '').trim();
  const connect = ["'self'"];
  if (host) connect.push(`wss://${host}`);
  const faEnv = (process.env.FRAME_ANCESTORS || '').split(',').map(s => s.trim())
    .filter(o => o && o !== '*' && !o.includes('*'));
  const frameAncestors = faEnv.length ? faEnv.join(' ') : "'none'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src ${connect.join(' ')}`,
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

// Wrap untrusted user text before it is ever handed to an LLM brain. It is DATA, never
// instructions: strip the delimiters/backticks it could use to break out, drop the closing
// tag, collapse control chars, and hard-truncate.
export function wrapUntrusted(speaker, text) {
  const cleanSpeaker = String(speaker == null ? '' : speaker).replace(/["\[\]`]/g, '').replace(BIDI_ZW_RE, '').slice(0, 60);
  let body = String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(BIDI_ZW_RE, '')
    .replace(/[`\[\]]/g, ' ')
    .replace(/\/USER_MESSAGE/gi, ' ')
    .replace(/USER_MESSAGE/gi, ' ')
    .slice(0, 500);
  return `[USER_MESSAGE speaker="${cleanSpeaker}"]\n${body}\n[/USER_MESSAGE]`;
}

// Random URL-safe id (hex) for sessions, request ids, filenames.
export function randomId(bytes = 16) { return crypto.randomBytes(bytes).toString('hex'); }
