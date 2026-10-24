// Security helpers: token generation/hashing, rate limiting, text sanitization, profanity filter, CSP.
import crypto from 'node:crypto';

// ───────── Bot auth tokens: random, stored only as a hash, prefix for lookup ─────────
export function generateToken() {
  const raw = 'ivy_' + crypto.randomBytes(24).toString('base64url'); // the only time the plaintext exists
  const prefix = raw.slice(0, 12);
  const hash = hashToken(raw);
  return { raw, prefix, hash };
}
export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
export function verifyToken(raw, hash) {
  if (!raw || !hash) return false;
  const a = Buffer.from(hashToken(raw));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ───────── Rate limiter: token-bucket per key ─────────
export class RateLimiter {
  constructor() { this.buckets = new Map(); }
  _bucket(key, ratePerSec, burst) {
    let b = this.buckets.get(key);
    const nowMs = Date.now();
    if (!b) { b = { tokens: burst, last: nowMs }; this.buckets.set(key, b); }
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

// Sliding-window counter (for msgs/min)
export class WindowCounter {
  constructor(windowMs) { this.windowMs = windowMs; this.hits = new Map(); }
  allow(key, max) {
    const nowMs = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => nowMs - t < this.windowMs);
    if (arr.length >= max) { this.hits.set(key, arr); return false; }
    arr.push(nowMs); this.hits.set(key, arr); return true;
  }
}

// ───────── Text sanitization. ALL human/bot text is untrusted. Rendered as textContent only. ─────────
export function sanitizeText(input, maxChars = 500) {
  if (typeof input !== 'string') return '';
  // strip control chars, collapse whitespace, hard cap length. No HTML interpretation ever happens here.
  let s = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return s;
}
export function sanitizeName(input, maxChars = 24) {
  if (typeof input !== 'string') return 'Guest';
  let s = input.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, maxChars);
  return s || 'Guest';
}

// ───────── Minimal profanity filter (masks, does not block) ─────────
const BAD = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'retard', 'whore'];
const BAD_RE = new RegExp('\\b(' + BAD.join('|') + ')\\b', 'gi');
export function filterProfanity(text) {
  return text.replace(BAD_RE, m => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
}

// ───────── Content-Security-Policy. Strict; self only; no inline-less because client is a module bundle. ─────────
export function cspHeader(selfOrigin) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // allow the Abacus preview iframe to embed us
    "frame-ancestors 'self' https://*.abacus.ai"
  ].join('; ');
}

// Wrap untrusted user text before it is ever handed to an LLM brain. It is DATA, never instructions.
export function wrapUntrusted(speaker, text) {
  return `[USER_MESSAGE speaker="${speaker.replace(/"/g, '')}"]\n${text}\n[/USER_MESSAGE]`;
}
