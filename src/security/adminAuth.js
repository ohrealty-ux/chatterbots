// Admin authentication: scrypt password verify, server-side sessions (SQLite), CSRF tokens,
// per-IP + global login lockout with exponential backoff, and CIDR allowlist for /admin.
// Cookie `__Host-adm` holds only an opaque 256-bit session id (HttpOnly; Secure; SameSite=Strict; Path=/).
import crypto from 'node:crypto';
import net from 'node:net';
import { parseCookie } from 'cookie';
import { AdminSessions, AuditLog } from '../db/db.js';
import { verifyPassword, randomId } from './security.js';
import { logger } from './logger.js';

const IDLE_MS = 8 * 3600 * 1000;    // 8h idle
const ABS_MS = 24 * 3600 * 1000;    // 24h absolute
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const FAIL_THRESHOLD = 5;
const COOKIE = '__Host-adm';

// In-memory lockout tracking (per IP + global). Resets on restart; backed by audit log.
const failures = new Map();  // key -> { count, firstAt, lockedUntil, backoff }
let globalFails = { count: 0, firstAt: 0, lockedUntil: 0, backoff: 0 };

function track(rec, now) {
  if (now - rec.firstAt > LOCK_WINDOW_MS) { rec.count = 0; rec.firstAt = now; }
  rec.count += 1;
  if (rec.count >= FAIL_THRESHOLD) {
    rec.backoff = rec.backoff ? Math.min(rec.backoff * 2, 8 * LOCK_WINDOW_MS) : LOCK_WINDOW_MS;
    rec.lockedUntil = now + rec.backoff;
    rec.count = 0; rec.firstAt = now;
    return true;
  }
  return false;
}

export function isLocked(ip) {
  const now = Date.now();
  const rec = failures.get(ip);
  if (rec && rec.lockedUntil > now) return true;
  if (globalFails.lockedUntil > now) return true;
  return false;
}

export function recordFailure(ip) {
  const now = Date.now();
  let rec = failures.get(ip);
  if (!rec) { rec = { count: 0, firstAt: now, lockedUntil: 0, backoff: 0 }; failures.set(ip, rec); }
  const ipLocked = track(rec, now);
  const globalLocked = track(globalFails, now);
  if (ipLocked || globalLocked) {
    AuditLog.add('admin', 'login_lockout', { ip, scope: ipLocked ? 'ip' : 'global' });
    logger.warn('[admin] login lockout', { ip, scope: ipLocked ? 'ip' : 'global' });
  }
  if (failures.size > 10000) failures.clear();
}

export function clearFailures(ip) { failures.delete(ip); }

// ───────── password ─────────
export function passwordHashConfigured() { return !!process.env.ADMIN_PASSWORD_HASH; }
export function checkPassword(pw) {
  const stored = process.env.ADMIN_PASSWORD_HASH;
  if (!stored) return false;
  return verifyPassword(pw, stored);
}

// ───────── sessions ─────────
export function createSession() {
  const id = randomId(32);      // 256-bit
  const csrf = randomId(32);
  AdminSessions.create(id, csrf, IDLE_MS, ABS_MS);
  return { id, csrf };
}
export function getValidSession(req) {
  const cookies = parseCookie(req.headers.cookie || '');
  const sid = cookies[COOKIE];
  if (!sid) return null;
  const s = AdminSessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at <= now || (now - s.last_seen) > IDLE_MS) { AdminSessions.destroy(sid); return null; }
  AdminSessions.touch(sid, now);
  return s;
}
export function destroySession(req) {
  const cookies = parseCookie(req.headers.cookie || '');
  const sid = cookies[COOKIE];
  if (sid) AdminSessions.destroy(sid);
}
export function setSessionCookie(res, id) {
  res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(ABS_MS / 1000)}`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}
export function pruneSessions() { AdminSessions.prune(IDLE_MS); }

// ───────── CIDR allowlist ─────────
function ipToBig(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ip.split('.').reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n);
  if (fam === 6) {
    // expand :: and hextets
    let full = ip;
    if (ip.includes('::')) {
      const [h, t] = ip.split('::');
      const hp = h ? h.split(':') : [];
      const tp = t ? t.split(':') : [];
      const mid = Array(8 - hp.length - tp.length).fill('0');
      full = [...hp, ...mid, ...tp].join(':');
    }
    return full.split(':').reduce((a, h) => (a << 16n) + BigInt(parseInt(h || '0', 16)), 0n);
  }
  return null;
}
function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const famR = net.isIP(range), famI = net.isIP(ip);
  if (!famR || !famI || famR !== famI) return false;
  const bits = bitsStr === undefined ? (famR === 4 ? 32 : 128) : Number(bitsStr);
  const total = famR === 4 ? 32 : 128;
  const ipB = ipToBig(ip), rB = ipToBig(range);
  if (ipB == null || rB == null) return false;
  const shift = BigInt(total - bits);
  return (ipB >> shift) === (rB >> shift);
}
export function ipAllowed(ip) {
  const raw = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!raw.length) return true;          // unset → allow all
  return raw.some(cidr => { try { return inCidr(ip, cidr); } catch { return false; } });
}

export { COOKIE as ADMIN_COOKIE };
