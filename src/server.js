// Chatter Bots — open-metaverse server. World WS + Bot Gateway + admin.
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { World } from './world/world.js';
import { Gateway } from './gateway/gateway.js';
import { RendezvousManager } from './gateway/rendezvous.js';
import { meetingGuide } from './world/botGuide.js';
import { DemoRunner } from './world/demo.js';
import { grokAvailable } from './brains/grok.js';
import { seedLots, seedDemoBots, tierSummary } from './db/seed.js';
import {
  Bots, Lots, Waitlist, Leads, ChatLog, AuditLog, ModLog, Board, MeetingPreps, Prune, closeDb,
} from './db/db.js';
import {
  sanitizeText, sanitizeName, cspHeader,
  RateLimiter, WindowCounter, generateToken, hashToken, constantTimeEqual, randomId,
} from './security/security.js';
import { logger, hashEmail } from './security/logger.js';
import { schemas, validate, MEET_ID_RE, BOT_ID_RE } from './security/validate.js';
import { processFace } from './security/faceImage.js';
import { encryptForBot, wakeKeyConfigured } from './security/crypto.js';
import { WakeNotifier } from './gateway/webhooks.js';
import {
  passwordHashConfigured, checkPassword, isLocked, recordFailure, clearFailures,
  createSession, getValidSession, destroySession, setSessionCookie, clearSessionCookie,
  pruneSessions, ipAllowed,
} from './security/adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const log = logger.info;

// ───────── crash-safety: keep the process alive, log REDACTED ─────────
process.on('uncaughtException', (err) => logger.redactedError('[uncaughtException]', err));
process.on('unhandledRejection', (reason) => logger.redactedError('[unhandledRejection]', reason));

// Base engine config (brand-neutral, open-source) with optional private overlay merge.
function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    const o = over[k], b = base[k];
    if (Array.isArray(o) && Array.isArray(b) && o.every(e => e && e.id) && b.every(e => e && e.id)) {
      for (const oe of o) { const be = b.find(e => e.id === oe.id); if (be) deepMerge(be, oe); else b.push(oe); }
    } else if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object' && !Array.isArray(b)) {
      deepMerge(b, o);
    } else { base[k] = o; }
  }
  return base;
}
const NEUTRAL = process.env.BRAND_NEUTRAL === '1';
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'world.config.json'), 'utf8'));
const OVERLAY = path.join(ROOT, 'config', 'overlay.json');
if (NEUTRAL) {
  log('[config] BRAND_NEUTRAL=1 — open-metaverse mode: private overlay/storefront/brand disabled.');
} else if (fs.existsSync(OVERLAY)) {
  try { deepMerge(config, JSON.parse(fs.readFileSync(OVERLAY, 'utf8'))); log('[config] private overlay applied'); }
  catch (e) { log('[config] private overlay failed to parse, ignoring:', e.message); }
}
const HAS_STOREFRONT = !NEUTRAL && fs.existsSync(path.join(PUBLIC, 'storefront', 'index.html'));
const SERVE_BRAND = !NEUTRAL && fs.existsSync(path.join(PUBLIC, 'brand'));
const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').trim();
const FRAME_ANCESTORS_SET = (process.env.FRAME_ANCESTORS || '').trim().length > 0;

// ───────── admin password hash required in production ─────────
if (PROD && !passwordHashConfigured()) {
  logger.error('[admin] ADMIN_PASSWORD_HASH is not set. Refusing to start in production. Run `npm run admin:hash` and set it.');
  process.exit(1);
}
if (!passwordHashConfigured()) log('[admin] ADMIN_PASSWORD_HASH not set — admin console is disabled until it is configured.');

// ───────── seed ─────────
seedLots(config);
const createdBots = seedDemoBots(config);
if (createdBots.length) {
  // Never print demo tokens. Write them ONLY when SEED_DEMO=1, to a 0600 file.
  if (process.env.SEED_DEMO === '1') {
    const f = path.join(ROOT, 'data', 'demo-bot-tokens.txt');
    fs.writeFileSync(f, createdBots.map(b => `${b.id}\t${b.name}\t${b.token}`).join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch { /* */ }
    log(`[seed] ${createdBots.length} demo bot token(s) written to data/demo-bot-tokens.txt (0600).`);
  } else {
    log(`[seed] ${createdBots.length} demo bot(s) created. Set SEED_DEMO=1 to write their tokens to a 0600 file.`);
  }
}

// ───────── world + gateway ─────────
const world = new World(config);
const gateway = new Gateway(world);
const rendezvous = new RendezvousManager(world, gateway, log);
gateway.rendezvous = rendezvous;
rendezvous.on('log', ({ meetingId, line }) => log(`[meeting#${meetingId}]`, line));
const demo = new DemoRunner(world, gateway, log);
const wake = new WakeNotifier({ log });
gateway.wake = wake;   // lets the gateway fire a wake notice on `mentioned`

// ───────── express app ─────────
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Client IP: CF-Connecting-IP only when we trust the proxy (socket peer); else the socket peer.
// Raw X-Forwarded-For is never read directly.
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).split(',')[0].trim();
    if (req.ip) return req.ip;
  }
  return (req.socket && req.socket.remoteAddress) || 'ip';
}
function rawIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'ip';
}
function hostFromOrigin(o) { try { return new URL(o).host; } catch { return null; } }

const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
// CORS: strict allowlist. Empty list → same-origin only (never reflect a cross-origin).
function corsAllowed(origin, req) {
  if (!origin) return false;
  if (ALLOWED.length) return ALLOWED.includes(origin);
  return hostFromOrigin(origin) === req.headers.host;
}
// WS Origin: allow no-Origin (non-browser bots); else must pass the same allowlist/same-origin test.
function wsOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED.length) return ALLOWED.includes(origin);
  return hostFromOrigin(origin) === req.headers.host;
}

// ───────── global security headers ─────────
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', cspHeader(PUBLIC_HOST));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // When FRAME_ANCESTORS is set, the single CSP header controls framing; X-Frame-Options: DENY
  // would override it and block the allowlisted ancestors, so omit XFO in that case.
  if (!FRAME_ANCESTORS_SET) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (PROD || req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  const origin = req.headers.origin;
  if (origin && corsAllowed(origin, req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Meet-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ───────── per-route body parsers + JSON content-type guard ─────────
const jsonSmall = express.json({ limit: '8kb' });
const jsonMid = express.json({ limit: '16kb' });
const jsonJoin = express.json({ limit: '700kb' });
// Reject non-JSON content types with 415 (only when a body is present).
function requireJson(req, res, next) {
  const ct = String(req.headers['content-type'] || '');
  const len = Number(req.headers['content-length'] || 0);
  if ((len > 0 || req.headers['transfer-encoding']) && !ct.includes('application/json')) {
    return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
  }
  next();
}

// ───────── rate limiters ─────────
const hourCounter = new WindowCounter(3600000);
const dayCounter = new WindowCounter(86400000);
function limitHour(key, max, res) { if (!hourCounter.allow(key, max)) { res.status(429).json({ ok: false, error: 'rate_limited' }); return false; } return true; }
function limitDay(key, max, res) { if (!dayCounter.allow(key, max)) { res.status(429).json({ ok: false, error: 'rate_limited' }); return false; } return true; }

// ───────── public config + world data (read-only, display) ─────────
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    version: config.version, seed: config.seed, size: config.size, palette: config.palette,
    timeOfDay: config.timeOfDay, wind: config.wind, densities: config.densities,
    lake: config.lake, commons: config.commons, zoning: { currency: config.zoning.currency },
    quality: config.quality, visitorLimits: config.visitorLimits,
    grok: grokAvailable(),
  });
});
app.get('/api/tiers', (_req, res) => { res.setHeader('Cache-Control', 'max-age=0, s-maxage=30'); if (!config.zoning) return res.json({ ok: true, tiers: [], currency: null }); res.json({ ok: true, tiers: tierSummary(config), currency: config.zoning.currency }); });
app.get('/api/lots', (_req, res) => {
  res.setHeader('Cache-Control', 'max-age=0, s-maxage=30');
  const lots = Lots.all().map(l => ({
    id: l.id, tier: l.tier, acreage: l.acreage, label: l.label,
    priceToken: l.list_price_token, priceFiat: l.list_price_fiat,
    available: !l.owner && !l.reserved, reserved: !!l.reserved,
    owner: l.owner ? 'owned' : null, assignedBot: l.assigned_bot,
    boundaries: JSON.parse(l.boundaries || '{}'), decor: JSON.parse(l.decor_layout || '[]'),
  }));
  res.json({ ok: true, lots });
});
app.get('/api/board/:board', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, posts: Board.byBoard(sanitizeText(req.params.board, 40), 50) });
});
app.get('/api/chatlog', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, messages: ChatLog.recent(80) }); });

// ───────── waitlist + leads (rate-limited) ─────────
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

app.post('/api/waitlist', requireJson, jsonSmall, (req, res) => {
  if (!limitHour('wl:' + clientIp(req), 5, res)) return;
  const v = validate(schemas.waitlist, req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const email = sanitizeText(v.data.email, 120);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
  const lotId = sanitizeText(v.data.lotId || '', 40) || null;
  const tier = sanitizeText(v.data.tier || '', 40) || null;
  const id = Waitlist.add(email, lotId, tier);
  AuditLog.add('visitor', 'waitlist', { email: hashEmail(email), lotId, tier });
  res.json({ ok: true, id, message: 'Thanks — you are on the list.' });
});

app.post('/api/lead', requireJson, jsonSmall, (req, res) => {
  if (!limitHour('ld:' + clientIp(req), 5, res)) return;
  const v = validate(schemas.lead, req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const email = sanitizeText(v.data.email, 120);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
  const lead = {
    name: sanitizeName(v.data.name || 'Guest', 60),
    email, phone: sanitizeText(v.data.phone || '', 40),
    message: sanitizeText(v.data.message || '', 500),
    kind: ['irl', 'metaverse'].includes(v.data.kind) ? v.data.kind : 'irl',
  };
  const id = Leads.add(lead);
  AuditLog.add('visitor', 'lead', { email: hashEmail(lead.email), kind: lead.kind });
  res.json({ ok: true, id, message: 'Thanks — a licensed human from our team will reach out.' });
});

// ───────── meeting prep ─────────
function cleanPrep(body) {
  return {
    name: sanitizeName(body?.name || '', 60),
    goals: sanitizeText(body?.goals || '', 1500),
    files: sanitizeText(body?.files || '', 2000),
    accomplish: sanitizeText(body?.accomplish || '', 1500),
    ideas: sanitizeText(body?.ideas || '', 2000),
    notes: sanitizeText(body?.notes || '', 1500),
    objectives: sanitizeText(body?.objectives || '', 2000),
    walkaway: sanitizeText(body?.walkaway || '', 1500),
    authority: ['advise', 'negotiate', 'commit'].includes(body?.authority) ? body.authority : 'advise',
    reportFormat: sanitizeText(body?.reportFormat || '', 600),
    time: sanitizeText(body?.time || '', 120),
    location: sanitizeText(body?.location || '', 120) || 'Lakeside bench',
    research: body?.research === true || body?.research === 'true' || body?.research === 'on',
    beaconNotify: body?.beaconNotify === true || body?.beaconNotify === 'true' || body?.beaconNotify === 'on',
    money: cleanMoney(body?.money),
    submittedAt: Date.now(),
  };
}
// Money / negotiation intake. The values arrive already validated by the zod `money` schema
// (numbers in range, 2-decimal, enums). We only normalize + sanitize the free-text deadline.
// Returns undefined when nothing was entered so empty prep stays clean. Values are NEVER
// concatenated into instruction strings — they are surfaced as structured untrusted data.
function cleanMoney(m) {
  if (!m || typeof m !== 'object') return undefined;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out = {
    amountAnchor: num(m.amountAnchor),
    amountIdeal: num(m.amountIdeal),
    amountWalkaway: num(m.amountWalkaway),
    askAbove: num(m.askAbove),
    paymentStyle: m.paymentStyle || undefined,
    deadline: m.deadline ? sanitizeText(m.deadline, 40) : undefined,
    trades: Array.isArray(m.trades) ? m.trades.slice(0, 10) : undefined,
    reveal: m.reveal || 'nothing',
  };
  // drop if entirely empty (only the default reveal present)
  const hasAny = out.amountAnchor !== undefined || out.amountIdeal !== undefined ||
    out.amountWalkaway !== undefined || out.askAbove !== undefined ||
    out.paymentStyle || out.deadline || (out.trades && out.trades.length);
  return hasAny ? out : undefined;
}
// A meeting GET returns private fields (walk-away, authority) ONLY to the edit-key holder.
function meetKeyOk(id, req) {
  const stored = MeetingPreps.editKeyHash(id);
  if (!stored) return false;
  const provided = req.headers['x-meet-key'] || '';
  return !!provided && constantTimeEqual(hashToken(String(provided)), stored);
}
function publicMeetingView(m) {
  if (!m) return m;
  // The shared/public view NEVER carries a party's private negotiation data: walk-away text,
  // authority level, or the whole money block (which holds the walk-away number + ask-above
  // threshold). Each party's money is returned only to the edit-key holder for that party.
  const strip = (p) => p ? { ...p, walkaway: undefined, authority: undefined, money: undefined } : p;
  return { ...m, parties: { A: strip(m.parties?.A), B: strip(m.parties?.B) } };
}

app.post('/api/meet', requireJson, jsonSmall, (req, res) => {
  if (!limitHour('mk:' + clientIp(req), 5, res)) return;
  if (!limitDay('mk:global', 200, res)) return;
  const v = validate(schemas.meetCreate, req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const location = sanitizeText(v.data.location || '', 120) || 'Lakeside bench';
  const timeLabel = sanitizeText(v.data.time || '', 120) || null;
  const editKey = randomId(16);   // 128-bit; returned once
  const id = MeetingPreps.create({ location, timeLabel, editKeyHash: hashToken(editKey) });
  AuditLog.add('visitor', 'meet_create', { id });
  res.json({ ok: true, id, editKey });
});

app.get('/api/meet/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!MEET_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const m = MeetingPreps.get(id);
  if (!m) return res.status(404).json({ ok: false, error: 'not_found' });
  const holder = meetKeyOk(id, req);
  const view = holder ? m : publicMeetingView(m);
  res.json({ ok: true, meeting: view, guide: meetingGuide(view, world), keyHolder: holder });
});

app.post('/api/meet/:id', requireJson, jsonMid, (req, res) => {
  if (!limitHour('ms:' + clientIp(req), 20, res)) return;
  const id = String(req.params.id || '');
  if (!MEET_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  if (!MeetingPreps.get(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  // Editing a party requires the per-meeting edit key (X-Meet-Key).
  if (!meetKeyOk(id, req)) return res.status(403).json({ ok: false, error: 'edit_key_required' });
  const v = validate(schemas.meetSubmit, req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const party = v.data.party;
  const prep = cleanPrep(v.data);
  const m = MeetingPreps.setParty(id, party, prep);
  if (!m) return res.status(404).json({ ok: false, error: 'not_found' });
  const cleanLabel = prep.time ? prep.time.replace(/\s*·?\s*\[[^\]]*\]\s*$/, '').trim() : null;
  MeetingPreps.setMeta(id, { location: prep.location, timeLabel: cleanLabel || null });
  AuditLog.add('visitor', 'meet_submit', { id, party });
  const fresh = MeetingPreps.get(id);
  res.json({ ok: true, meeting: fresh, guide: meetingGuide(fresh, world) });
});

// ───────── public join flow (E-a): create a PENDING bot, optional re-encoded face ─────────
app.post('/api/join', requireJson, jsonJoin, async (req, res) => {
  if (!limitHour('join:' + clientIp(req), 3, res)) return;
  const v = validate(schemas.join, req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const name = sanitizeName(v.data.name, 40);
  const owner = sanitizeName(v.data.owner, 40);
  if (/\b(admin|system|concierge)\b/i.test(name)) return res.status(400).json({ ok: false, error: 'reserved_name' });
  // Reject a name that duplicates an existing bot.
  if (Bots.all().some(b => b.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ ok: false, error: 'name_taken' });

  let face = null;
  if (v.data.face) {
    try { face = await processFace(v.data.face); }
    catch { return res.status(400).json({ ok: false, error: 'bad_face' }); }
  }

  // Unique id + non-colliding token prefix.
  let id = 'bot-' + crypto.randomBytes(4).toString('hex');
  for (let i = 0; i < 5 && Bots.get(id); i++) id = 'bot-' + crypto.randomBytes(4).toString('hex');
  let tok = generateToken();
  for (let i = 0; i < 5 && Bots.prefixExists(tok.prefix); i++) tok = generateToken();
  if (Bots.prefixExists(tok.prefix)) return res.status(500).json({ ok: false, error: 'server_error' });

  Bots.createPending({
    id, name, avatar: null, home_lot: null, token_hash: tok.hash, token_prefix: tok.prefix,
    scopes: 'join,move,say,emote,status,sit,look,follow,enter_lot,place_object',
    owner, brain: 'offline', created_at: Date.now(), face,
  });
  AuditLog.add('visitor', 'join_request', { id, name });
  res.json({ ok: true, id, status: 'pending', worldPass: tok.raw, note: 'World pass shown once — store it now. Your bot can join once an admin approves it.' });
});

// Serve a re-encoded face from the DB (outside the static root), locked-down headers.
app.get('/faces/:id.png', (req, res) => {
  const id = String(req.params.id || '');
  if (!BOT_ID_RE.test(id)) return res.status(404).end();
  const buf = Bots.getFace(id);
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Cache-Control', 'max-age=0, s-maxage=60');
  res.end(buf);
});

// ───────── wake webhook registration (E-b) — authed with the bot world pass ─────────
app.post('/api/join/wake', requireJson, jsonSmall, async (req, res) => {
  if (!limitHour('wake:' + clientIp(req), 10, res)) return;
  const bot = gateway.authBot(req, rawIp(req));
  if (!bot) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!wakeKeyConfigured()) return res.status(503).json({ ok: false, error: 'wake_unavailable' });
  const v = validate(schemas.wake, req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  // Validate the URL is SSRF-safe before storing it.
  const { validateWebhookUrl } = await import('./security/ssrf.js');
  const chk = await validateWebhookUrl(v.data.webhook_url);
  if (!chk.ok) return res.status(400).json({ ok: false, error: 'bad_webhook_url' });
  try {
    Bots.setWebhook(bot.id, encryptForBot(bot.id, v.data.webhook_url), encryptForBot(bot.id, v.data.webhook_key));
    wake.reset(bot.id);
  } catch { return res.status(500).json({ ok: false, error: 'server_error' }); }
  AuditLog.add('bot:' + bot.id, 'wake_set', {});   // never log url/key
  res.json({ ok: true, message: 'Wake webhook stored (encrypted). The key is never returned.' });
});

// ───────── gateway (bot REST) ─────────
app.use('/gateway', gateway.router(() => rawIp));

// ───────── admin ─────────
// IP allowlist + no-store/noindex on every admin path (incl. /admin/api/*).
app.use('/admin', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!ipAllowed(clientIp(req))) return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
});

function requireAdmin(req, res, next) {
  if (!passwordHashConfigured()) return res.status(503).json({ ok: false, error: 'admin_disabled' });
  const s = getValidSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.adminSession = s;
  if (req.method !== 'GET') {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
    const origin = req.headers.origin;
    if (origin && hostFromOrigin(origin) !== req.headers.host) return res.status(403).json({ ok: false, error: 'bad_origin' });
    const csrf = String(req.headers['x-csrf-token'] || '');
    if (!csrf || !constantTimeEqual(csrf, s.csrf)) return res.status(403).json({ ok: false, error: 'bad_csrf' });
  }
  next();
}

app.post('/admin/api/login', requireJson, jsonSmall, (req, res) => {
  const ip = clientIp(req);
  if (!passwordHashConfigured()) return res.status(503).json({ ok: false, error: 'admin_disabled' });
  if (isLocked(ip)) { AuditLog.add('admin', 'login_locked', { ip }); return res.status(429).json({ ok: false, error: 'locked' }); }
  const v = validate(schemas.adminLogin, req.body);
  if (!v.ok) { recordFailure(ip); AuditLog.add('admin', 'login_fail', { ip }); return res.status(401).json({ ok: false, error: 'unauthorized' }); }
  if (!checkPassword(v.data.password)) {
    recordFailure(ip); AuditLog.add('admin', 'login_fail', { ip });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  destroySession(req);                 // rotate: drop any prior session for this cookie
  clearFailures(ip);
  const sess = createSession();        // fresh random session id on every login
  setSessionCookie(res, sess.id);
  AuditLog.add('admin', 'login', { ip });
  res.json({ ok: true, csrf: sess.csrf });
});

app.post('/admin/api/logout', requireAdmin, (req, res) => {
  destroySession(req); clearSessionCookie(res);
  AuditLog.add('admin', 'logout', {});
  res.json({ ok: true });
});

app.get('/admin/api/state', requireAdmin, (_req, res) => {
  res.json({
    ok: true, frozen: world.isFrozen(),
    bots: Bots.all().map(b => ({ id: b.id, name: b.name, status: b.status, revoked: !!b.revoked, brain: b.brain, owner: b.owner, home_lot: b.home_lot, token_prefix: b.token_prefix, tokensToday: Bots.tokensToday(b.id), webhook: !!b.webhook_enc, webhookEnabled: !!b.webhook_enabled })),
    pending: Bots.byStatus('pending').map(b => ({ id: b.id, name: b.name, owner: b.owner, created_at: b.created_at, hasFace: !!b.face })),
    waitlist: Waitlist.all(), leads: Leads.all(),
    audit: AuditLog.recent(80), moderation: ModLog.recent(60),
    grok: grokAvailable(), csrf: _req.adminSession.csrf,
  });
});
app.post('/admin/api/bot', requireAdmin, jsonSmall, (req, res) => {
  const v = validate(schemas.adminBot, req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  const name = sanitizeName(v.data.name || 'Bot', 40);
  let id = sanitizeText(v.data.id || ('bot-' + crypto.randomBytes(3).toString('hex')), 40).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) id = 'bot-' + crypto.randomBytes(3).toString('hex');
  const brain = v.data.brain === 'grok' ? 'grok' : 'offline';
  let tok = generateToken();
  for (let i = 0; i < 5 && Bots.prefixExists(tok.prefix); i++) tok = generateToken();
  if (Bots.prefixExists(tok.prefix)) return res.status(500).json({ ok: false, error: 'server_error' });
  Bots.upsert({ id, name, avatar: null, home_lot: null, status: 'approved', token_hash: tok.hash, token_prefix: tok.prefix,
    scopes: 'join,move,say,emote,status,sit,look,follow,enter_lot,place_object', owner: sanitizeName(v.data.owner || 'admin', 40), brain, created_at: Date.now() });
  AuditLog.add('admin', 'create_bot', { id, name });
  res.json({ ok: true, id, token: tok.raw, note: 'Token shown once. Store it now.' });
});
app.post('/admin/api/bot/:id/approve', requireAdmin, jsonSmall, (req, res) => {
  const bot = Bots.get(req.params.id); if (!bot) return res.status(404).json({ ok: false });
  Bots.setStatus(bot.id, 'approved');
  AuditLog.add('admin', 'approve_bot', { id: bot.id }); res.json({ ok: true });
});
app.post('/admin/api/bot/:id/reject', requireAdmin, jsonSmall, (req, res) => {
  const bot = Bots.get(req.params.id); if (!bot) return res.status(404).json({ ok: false });
  Bots.setStatus(bot.id, 'rejected'); gateway.leave(bot.id);
  AuditLog.add('admin', 'reject_bot', { id: bot.id }); res.json({ ok: true });
});
app.post('/admin/api/bot/:id/rotate', requireAdmin, jsonSmall, (req, res) => {
  const bot = Bots.get(req.params.id); if (!bot) return res.status(404).json({ ok: false });
  let tok = generateToken();
  for (let i = 0; i < 5 && Bots.prefixExists(tok.prefix); i++) tok = generateToken();
  Bots.setToken(bot.id, tok.hash, tok.prefix);
  AuditLog.add('admin', 'rotate_token', { id: bot.id });
  res.json({ ok: true, token: tok.raw });
});
app.post('/admin/api/bot/:id/revoke', requireAdmin, jsonSmall, (req, res) => {
  Bots.revoke(req.params.id); gateway.leave(req.params.id);
  AuditLog.add('admin', 'revoke_bot', { id: req.params.id }); res.json({ ok: true });
});
app.post('/admin/api/bot/:id/kill', requireAdmin, jsonSmall, (req, res) => {
  gateway.leave(req.params.id); AuditLog.add('admin', 'kill_bot', { id: req.params.id }); res.json({ ok: true });
});
app.post('/admin/api/bot/:id/delete', requireAdmin, jsonSmall, (req, res) => {
  gateway.leave(req.params.id); Bots.remove(req.params.id);
  AuditLog.add('admin', 'delete_bot', { id: req.params.id }); res.json({ ok: true });
});
app.post('/admin/api/bot/:id/webhook', requireAdmin, jsonSmall, (req, res) => {
  const bot = Bots.get(req.params.id); if (!bot) return res.status(404).json({ ok: false });
  const enable = req.body?.enable === true;
  if (!enable) { Bots.setWebhookEnabled(bot.id, false); }
  else { Bots.setWebhookEnabled(bot.id, true); wake.reset(bot.id); }
  AuditLog.add('admin', 'webhook_toggle', { id: bot.id, enabled: enable }); res.json({ ok: true });
});
app.post('/admin/api/freeze', requireAdmin, jsonSmall, (req, res) => {
  world.freezeAll(!!req.body?.frozen); AuditLog.add('admin', 'freeze_all', { frozen: !!req.body?.frozen }); res.json({ ok: true, frozen: world.isFrozen() });
});
app.post('/admin/api/demo', requireAdmin, jsonSmall, (_req, res) => {
  AuditLog.add('admin', 'trigger_demo', {});
  demo.run(['elowen', 'fenn']).then(r => log('[demo] finished', r)).catch(e => logger.redactedError('[demo]', e));
  res.json({ ok: true, message: 'Demo started. Watch the world or read data/transcripts/.' });
});
app.post('/admin/api/lot/:id/assign', requireAdmin, jsonSmall, (req, res) => {
  const lot = Lots.get(req.params.id); if (!lot) return res.status(404).json({ ok: false });
  Lots.assignBot(lot.id, sanitizeText(req.body?.botId || '', 40) || null);
  AuditLog.add('admin', 'assign_lot', { lot: lot.id, bot: sanitizeText(req.body?.botId || '', 40) }); res.json({ ok: true });
});
app.post('/admin/api/mute', requireAdmin, jsonSmall, (req, res) => {
  const id = sanitizeText(req.body?.id || '', 60);
  if (req.body?.mute) { world.mute(id); ModLog.add('admin', 'mute', id); } else { world.unmute(id); ModLog.add('admin', 'unmute', id); }
  res.json({ ok: true });
});

// ───────── public docs (no auth) ─────────
function serveDoc(file) {
  return (req, res) => {
    let md;
    try { md = fs.readFileSync(file, 'utf8'); }
    catch { return res.status(404).type('text/plain; charset=utf-8').send('Not found'); }
    const asMarkdown = req.path.endsWith('.md') || req.path === '/BOTS.md';
    res.setHeader('Content-Type', asMarkdown ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'max-age=0, s-maxage=300');
    res.send(md);
  };
}
app.get(['/beacon-from-picture.md', '/beacon-from-picture'], serveDoc(path.join(PUBLIC, 'beacon-from-picture.md')));
app.get(['/join-chatter-bots.md', '/join'], serveDoc(path.join(PUBLIC, 'join-chatter-bots.md')));
// H1: serve the repo's BOTS.md (was 404). Wording: eldr_ is a "world pass".
app.get('/BOTS.md', serveDoc(path.join(ROOT, 'BOTS.md')));

// ───────── static ─────────
app.use('/vendor', express.static(path.join(PUBLIC, 'vendor'), { maxAge: '1d' }));
app.use('/client', express.static(path.join(PUBLIC, 'client'), { maxAge: 0, setHeaders: r => r.setHeader('Cache-Control', 'max-age=0, s-maxage=60') }));
app.use('/admin', express.static(path.join(PUBLIC, 'admin'), { maxAge: 0, setHeaders: r => r.setHeader('Cache-Control', 'max-age=0, s-maxage=60') }));
if (SERVE_BRAND) app.use('/brand', express.static(path.join(PUBLIC, 'brand'), { maxAge: '1h' }));
if (HAS_STOREFRONT) app.use(express.static(path.join(PUBLIC, 'storefront'), { maxAge: 0, setHeaders: r => r.setHeader('Cache-Control', 'max-age=0, s-maxage=60') }));
app.get('/world', (_req, res) => res.sendFile(path.join(PUBLIC, 'client', 'index.html')));
app.get('/meet', (_req, res) => res.sendFile(path.join(PUBLIC, 'client', 'meet.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin', 'admin.html')));
if (!HAS_STOREFRONT) app.get('/', (_req, res) => res.redirect('/world'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ───────── body-parser + final error handler ─────────
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'bad_json' });
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ ok: false, error: 'payload_too_large' });
  if (err && err.status === 415) return res.status(415).json({ ok: false, error: 'unsupported_media_type' });
  const reqId = randomId(8);
  logger.redactedError(`[server_error id=${reqId}] ${req.method} ${req.path}`, err);
  res.status(500).json({ ok: false, error: 'server_error', id: reqId });
});

// ───────── http + ws ─────────
const server = http.createServer(app);

// Human world WS — small frames, no compression.
const worldWss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
const humanClients = new Set();
const worldConnsByIp = new Map();
const moveLimiter = new RateLimiter();
const humanMsgWindow = new WindowCounter(60000);
const MAX_TOTAL_CONNS = 500;
const MAX_WORLD_PER_IP = 3;

function totalConns() { return humanClients.size + gateway.connectionCount(); }

// Coalesced + throttled broadcast (max 10/s). Latest state wins.
let pendingState = null, lastBroadcast = 0, broadcastTimer = null;
function broadcast(payload) { for (const c of humanClients) { if (c.ws.readyState === 1) { try { c.ws.send(payload); } catch { /* */ } } } }
function scheduleStateBroadcast(snap) {
  pendingState = snap;
  const since = Date.now() - lastBroadcast;
  const flush = () => { broadcastTimer = null; lastBroadcast = Date.now(); if (pendingState) { broadcast(JSON.stringify({ type: 'state', snap: pendingState })); pendingState = null; } };
  if (since >= 100) flush();
  else if (!broadcastTimer) broadcastTimer = setTimeout(flush, 100 - since);
}
world.on('state', (snap) => scheduleStateBroadcast(snap));
world.on('chat', (msg) => broadcast(JSON.stringify({ type: 'chat', msg })));
world.on('freeze', (frozen) => broadcast(JSON.stringify({ type: 'freeze', frozen })));

worldWss.on('connection', (ws, req, name, ip) => {
  const id = 'human:' + crypto.randomBytes(5).toString('hex');
  const ent = world.spawn({ id, name, kind: 'human' });
  const client = { ws, id, ip };
  humanClients.add(client);
  worldConnsByIp.set(ip, (worldConnsByIp.get(ip) || 0) + 1);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (e) => logger.redactedError('[worldWs]', e));
  try {
    ws.send(JSON.stringify({ type: 'welcome', id, name, you: ent.id,
      config: { commons: config.commons, lake: config.lake, palette: config.palette }, snap: world.snapshot() }));
    ws.send(JSON.stringify({ type: 'history', messages: ChatLog.recent(40) }));
  } catch { /* */ }

  ws.on('message', (buf) => {
    try {
      if (buf.length > 4096) return;
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
      const lim = config.visitorLimits;
      if (m.type === 'move') {
        if (!moveLimiter.allow('mv:' + id, lim.actionsPerSec, lim.actionsPerSec * 2)) return;
        world.moveProposal(id, Number(m.dx) || 0, Number(m.dz) || 0, Number(m.yaw));
      } else if (m.type === 'say') {
        if (!humanMsgWindow.allow('h:' + id, lim.msgsPerMin)) return;
        world.say(id, String(m.text || ''), lim.maxChars);
      } else if (m.type === 'sit') {
        world.sit(id, sanitizeText(m.seat || '', 20) || null);
      } else if (m.type === 'stand') {
        world.stand(id);
      }
    } catch (e) { logger.redactedError('[worldWs msg]', e); }
  });
  ws.on('close', () => {
    humanClients.delete(client); world.despawn(id);
    const n = (worldConnsByIp.get(ip) || 1) - 1;
    if (n <= 0) worldConnsByIp.delete(ip); else worldConnsByIp.set(ip, n);
  });
});

// 30s heartbeat: terminate sockets that didn't pong.
const heartbeat = setInterval(() => {
  for (const c of humanClients) {
    if (c.ws.isAlive === false) { try { c.ws.terminate(); } catch { /* */ } continue; }
    c.ws.isAlive = false; try { c.ws.ping(); } catch { /* */ }
  }
}, 30000);
heartbeat.unref?.();

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!wsOriginAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    if (totalConns() >= MAX_TOTAL_CONNS) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    if (url.pathname === '/world/v1/ws') {
      const ip = rawIp(req);
      if ((worldConnsByIp.get(ip) || 0) >= MAX_WORLD_PER_IP) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
      const name = sanitizeName(url.searchParams.get('name') || 'Guest', 24);
      worldWss.handleUpgrade(req, socket, head, (ws) => worldWss.emit('connection', ws, req, name, ip));
      return;
    }
    if (gateway.handleUpgrade(req, socket, head, rawIp(req))) return;
    socket.destroy();
  } catch (e) { logger.redactedError('[upgrade]', e); try { socket.destroy(); } catch { /* */ } }
});
gateway.attachWss(server, '/gateway/v1/ws');

// ───────── periodic retention ─────────
const pruneTimer = setInterval(() => { try { Prune.run(); pruneSessions(); } catch (e) { logger.redactedError('[prune]', e); } }, 3600000);
pruneTimer.unref?.();
Prune.run();

server.listen(PORT, '127.0.0.1', () => {
  log(`Chatter Bots listening on http://127.0.0.1:${PORT}`);
  log(`Grok brain: ${grokAvailable() ? 'ENABLED' : 'offline fallback'}`);
});

const AUTO_DEMO = process.env.AUTO_DEMO === '1';
if (AUTO_DEMO) setTimeout(() => { demo.run(['elowen', 'fenn']).then(r => log('[demo:auto]', r)).catch(e => logger.redactedError('[demo:auto]', e)); }, 2500);

// Graceful shutdown. Finalize all SQLite statements via closeDb() BEFORE exiting: on Node 24,
// better-sqlite3's Statement destructor asserts (SIGABRT, exit 134) if the process tears down
// the V8 isolate while prepared statements are still live. Closing the DB first makes a systemd
// restart exit cleanly instead of intermittently aborting.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(heartbeat);
  // Stop accepting new connections, then finalize SQLite and exit SYNCHRONOUSLY in this tick.
  // Doing closeDb() + process.exit(0) synchronously (rather than from an async server.close
  // callback) reliably avoids better-sqlite3's teardown assertion on Node 24.
  try { world.stop(); } catch { /* */ }          // stop the sim tick (no DB ops during teardown)
  try { rendezvous.stop(); } catch { /* */ }      // stop the meeting scheduler
  try { clearInterval(pruneTimer); } catch { /* */ }
  try { server.close(); } catch { /* */ }
  for (const c of humanClients) { try { c.ws.terminate(); } catch { /* */ } }
  try { closeDb(); } catch { /* */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
