// Chatter Bots — open-metaverse server. World WS + Bot Gateway + admin (+ optional private overlay).
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
import { BotBeacons } from './adapters/botBeacons.js';
import { grokAvailable } from './brains/grok.js';
import { seedLots, seedDemoBots, tierSummary } from './db/seed.js';
import {
  Bots, Lots, Waitlist, Leads, ChatLog, AuditLog, ModLog, Board, MeetingPreps,
} from './db/db.js';
import {
  sanitizeText, sanitizeName, filterProfanity, cspHeader,
  RateLimiter, WindowCounter, generateToken, hashToken, wrapUntrusted,
} from './security/security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Base engine config (brand-neutral, open-source). An optional gitignored overlay at
// config/overlay.json lets a private deployment layer its own lore/zoning on top
// WITHOUT shipping that content in the open-source tree.
function deepMerge(base, over) {
  for (const k of Object.keys(over)) {
    const o = over[k], b = base[k];
    if (Array.isArray(o) && Array.isArray(b) && o.every(e => e && e.id) && b.every(e => e && e.id)) {
      // Merge arrays of objects BY id: overlay entries patch matching base entries,
      // unknown ids are appended, base entries without an overlay match are kept.
      for (const oe of o) {
        const be = b.find(e => e.id === oe.id);
        if (be) deepMerge(be, oe); else b.push(oe);
      }
    } else if (o && typeof o === 'object' && !Array.isArray(o) &&
               b && typeof b === 'object' && !Array.isArray(b)) {
      deepMerge(b, o);
    } else { base[k] = o; }
  }
  return base;
}
// BRAND_NEUTRAL=1 forces a pure open-metaverse deployment: the private overlay, storefront
// and brand assets are ignored even if present on disk, so the public site is 100% neutral.
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

// Admin password
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url'); log('[admin] No ADMIN_PASSWORD set — generated one for this session:', ADMIN_PASSWORD); }

// ───────── seed ─────────
seedLots(config);
const createdBots = seedDemoBots(config);
if (createdBots.length) {
  log('[seed] created demo bots (tokens shown ONCE — store securely, they are not recoverable):');
  for (const b of createdBots) log(`   ${b.name} [${b.id}] token=${b.token}`);
  const f = path.join(ROOT, 'data', 'demo-bot-tokens.txt');
  fs.writeFileSync(f, createdBots.map(b => `${b.id}\t${b.name}\t${b.token}`).join('\n') + '\n');
  log('[seed] demo bot tokens also written to data/demo-bot-tokens.txt (gitignored).');
}

// ───────── world + gateway ─────────
const world = new World(config);
const gateway = new Gateway(world);
const rendezvous = new RendezvousManager(world, gateway, log);
gateway.rendezvous = rendezvous;   // enables propose/respond/list_meetings + NL "meet me at..." trigger
rendezvous.on('log', ({ meetingId, line }) => log(`[meeting#${meetingId}]`, line));
const demo = new DemoRunner(world, gateway, log);

// Bot Beacons adapter (inert unless configured)
const beacons = new BotBeacons({
  log,
  onBeacon: (data) => {
    // Map a beacon to world behavior: e.g. task done -> walk to board, glow, say a line.
    try {
      const botId = data.bot || 'elowen';
      const bot = Bots.get(botId);
      if (!bot) return;
      gateway.handleAction(bot, 'join', {});
      if (data.type === 'task_done') {
        gateway.handleAction(bot, 'move_to', { place: 'project board' });
        gateway.handleAction(bot, 'set_status', { status: 'done' });
        gateway.handleAction(bot, 'emote', { emote: 'cheer' });
        gateway.handleAction(bot, 'say', { text: sanitizeText(data.text || 'Task done — badge lit on the project board.') });
      } else if (data.type === 'needs_attention') {
        gateway.handleAction(bot, 'set_status', { status: 'needs_attention' });
        gateway.handleAction(bot, 'say', { text: sanitizeText(data.text || 'Flagging this for attention.') });
      }
      AuditLog.add('bot-beacons', 'beacon', data);
    } catch (e) { log('[bot-beacons] handler error', e.message); }
  },
});
beacons.start();

// ───────── express app ─────────
const app = express();
app.disable('x-powered-by');

const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return true;              // same-origin / curl
  if (!ALLOWED.length) return true;
  return ALLOWED.includes(origin);
}

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', cspHeader());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // CORS limited to allowlist
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const jsonParser = express.json({ limit: '32kb' });

// ───────── public config + world data (read-only, display) ─────────
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // never leak secrets — only the client-safe world config
  res.json({
    version: config.version, seed: config.seed, size: config.size, palette: config.palette,
    timeOfDay: config.timeOfDay, wind: config.wind, densities: config.densities,
    lake: config.lake, commons: config.commons, zoning: { currency: config.zoning.currency },
    quality: config.quality, visitorLimits: config.visitorLimits,
    grok: grokAvailable(), beacons: beacons.enabled,
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
  res.json({ ok: true, posts: Board.byBoard(req.params.board, 50) });
});
app.get('/api/chatlog', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, messages: ChatLog.recent(80) }); });

// ───────── waitlist + leads (rate-limited) ─────────
const formLimiter = new WindowCounter(60000);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function clientIp(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip').split(',')[0].trim(); }

app.post('/api/waitlist', jsonParser, (req, res) => {
  if (!formLimiter.allow('wl:' + clientIp(req), 10)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const email = sanitizeText(req.body?.email || '', 120);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
  const lotId = sanitizeText(req.body?.lotId || '', 40) || null;
  const tier = sanitizeText(req.body?.tier || '', 40) || null;
  const id = Waitlist.add(email, lotId, tier);
  AuditLog.add('visitor', 'waitlist', { email, lotId, tier });
  res.json({ ok: true, id, message: 'Thanks — you are on the list.' });
});

app.post('/api/lead', jsonParser, (req, res) => {
  if (!formLimiter.allow('ld:' + clientIp(req), 8)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const email = sanitizeText(req.body?.email || '', 120);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
  const lead = {
    name: sanitizeName(req.body?.name || 'Guest', 60),
    email, phone: sanitizeText(req.body?.phone || '', 40),
    message: sanitizeText(req.body?.message || '', 500),
    kind: ['irl', 'metaverse'].includes(req.body?.kind) ? req.body.kind : 'irl',
  };
  const id = Leads.add(lead);
  AuditLog.add('visitor', 'lead', { email: lead.email, kind: lead.kind });
  res.json({ ok: true, id, message: 'Thanks — a licensed human from our team will reach out.' });
});

// ───────── meeting prep (shareable "will your bot meet my bot?" agenda) ─────────
// A meeting has an id and two parties (A/B). Each party submits a prep form.
// Bots/gateways can fetch the full agenda (goals, references, outcomes, ideas, notes,
// schedule) as JSON via GET /api/meet/:id to prepare for the lakeside-bench meetup.
const MEET_ID_RE = /^[a-z2-9]{6,16}$/;
function cleanPrep(body) {
  return {
    name: sanitizeName(body?.name || '', 60),
    goals: sanitizeText(body?.goals || '', 1500),
    files: sanitizeText(body?.files || '', 2000),
    accomplish: sanitizeText(body?.accomplish || '', 1500),
    ideas: sanitizeText(body?.ideas || '', 2000),
    notes: sanitizeText(body?.notes || '', 1500),
    time: sanitizeText(body?.time || '', 120),
    location: sanitizeText(body?.location || '', 120) || 'Lakeside bench',
    research: body?.research === true || body?.research === 'true' || body?.research === 'on',
    submittedAt: Date.now(),
  };
}

app.post('/api/meet', jsonParser, (req, res) => {
  if (!formLimiter.allow('mk:' + clientIp(req), 20)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const location = sanitizeText(req.body?.location || '', 120) || 'Lakeside bench';
  const timeLabel = sanitizeText(req.body?.time || '', 120) || null;
  const id = MeetingPreps.create({ location, timeLabel });
  AuditLog.add('visitor', 'meet_create', { id });
  res.json({ ok: true, id });
});

app.get('/api/meet/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.params.id || '');
  if (!MEET_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const m = MeetingPreps.get(id);
  if (!m) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, meeting: m, guide: meetingGuide(m, world) });
});

app.post('/api/meet/:id', jsonParser, (req, res) => {
  if (!formLimiter.allow('ms:' + clientIp(req), 30)) return res.status(429).json({ ok: false, error: 'rate_limited' });
  const id = String(req.params.id || '');
  if (!MEET_ID_RE.test(id)) return res.status(400).json({ ok: false, error: 'bad_id' });
  const party = req.body?.party === 'A' ? 'A' : req.body?.party === 'B' ? 'B' : null;
  if (!party) return res.status(400).json({ ok: false, error: 'bad_party' });
  const prep = cleanPrep(req.body || {});
  const m = MeetingPreps.setParty(id, party, prep);
  if (!m) return res.status(404).json({ ok: false, error: 'not_found' });
  // keep the meeting-level schedule/location in step with the most recent submission
  const cleanLabel = prep.time ? prep.time.replace(/\s*·?\s*\[[^\]]*\]\s*$/, '').trim() : null;
  MeetingPreps.setMeta(id, { location: prep.location, timeLabel: cleanLabel || null });
  AuditLog.add('visitor', 'meet_submit', { id, party });
  res.json({ ok: true, meeting: MeetingPreps.get(id) });
});

// ───────── gateway (bot REST) ─────────
app.use('/gateway', gateway.router());

// ───────── admin ─────────
function adminOk(req) {
  const h = req.headers['authorization'] || '';
  const pw = h.startsWith('Bearer ') ? h.slice(7) : (req.query.pw || req.body?.pw || '');
  const a = Buffer.from(String(pw)); const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireAdmin(req, res, next) { if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' }); next(); }

app.get('/admin/api/state', requireAdmin, (_req, res) => {
  res.json({
    ok: true, frozen: world.isFrozen(),
    bots: Bots.all().map(b => ({ id: b.id, name: b.name, status: b.status, revoked: !!b.revoked, brain: b.brain, owner: b.owner, home_lot: b.home_lot, token_prefix: b.token_prefix, tokensToday: Bots.tokensToday(b.id) })),
    waitlist: Waitlist.all(), leads: Leads.all(),
    audit: AuditLog.recent(80), moderation: ModLog.recent(60),
    grok: grokAvailable(), beacons: beacons.enabled,
  });
});
app.post('/admin/api/bot', requireAdmin, jsonParser, (req, res) => {
  const name = sanitizeName(req.body?.name || 'Bot', 40);
  const id = sanitizeText(req.body?.id || ('bot-' + crypto.randomBytes(3).toString('hex')), 40).replace(/[^a-zA-Z0-9_-]/g, '');
  const brain = req.body?.brain === 'grok' ? 'grok' : 'offline';
  const tok = generateToken();
  Bots.upsert({ id, name, avatar: null, home_lot: null, status: 'idle', token_hash: tok.hash, token_prefix: tok.prefix,
    scopes: 'join,move,say,emote,status,sit,look,follow,enter_lot,place_object', owner: sanitizeName(req.body?.owner || 'admin', 40), brain, created_at: Date.now() });
  AuditLog.add('admin', 'create_bot', { id, name });
  res.json({ ok: true, id, token: tok.raw, note: 'Token shown once. Store it now.' });
});
app.post('/admin/api/bot/:id/rotate', requireAdmin, (req, res) => {
  const bot = Bots.get(req.params.id); if (!bot) return res.status(404).json({ ok: false });
  const tok = generateToken(); Bots.setToken(bot.id, tok.hash, tok.prefix);
  AuditLog.add('admin', 'rotate_token', { id: bot.id });
  res.json({ ok: true, token: tok.raw });
});
app.post('/admin/api/bot/:id/revoke', requireAdmin, (req, res) => {
  Bots.revoke(req.params.id); gateway.leave(req.params.id);
  AuditLog.add('admin', 'revoke_bot', { id: req.params.id }); res.json({ ok: true });
});
app.post('/admin/api/bot/:id/kill', requireAdmin, (req, res) => {
  gateway.leave(req.params.id); AuditLog.add('admin', 'kill_bot', { id: req.params.id }); res.json({ ok: true });
});
app.post('/admin/api/bot/:id/delete', requireAdmin, (req, res) => {
  gateway.leave(req.params.id); Bots.remove(req.params.id);
  AuditLog.add('admin', 'delete_bot', { id: req.params.id }); res.json({ ok: true });
});
app.post('/admin/api/freeze', requireAdmin, jsonParser, (req, res) => {
  world.freezeAll(!!req.body?.frozen); AuditLog.add('admin', 'freeze_all', { frozen: !!req.body?.frozen }); res.json({ ok: true, frozen: world.isFrozen() });
});
app.post('/admin/api/demo', requireAdmin, async (_req, res) => {
  AuditLog.add('admin', 'trigger_demo', {});
  demo.run(['elowen', 'fenn']).then(r => log('[demo] finished', r)).catch(e => log('[demo] error', e.message));
  res.json({ ok: true, message: 'Demo started. Watch the world or read data/transcripts/.' });
});
app.post('/admin/api/lot/:id/assign', requireAdmin, jsonParser, (req, res) => {
  const lot = Lots.get(req.params.id); if (!lot) return res.status(404).json({ ok: false });
  Lots.assignBot(lot.id, sanitizeText(req.body?.botId || '', 40) || null);
  AuditLog.add('admin', 'assign_lot', { lot: lot.id, bot: req.body?.botId }); res.json({ ok: true });
});
app.post('/admin/api/mute', requireAdmin, jsonParser, (req, res) => {
  const id = sanitizeText(req.body?.id || '', 60);
  if (req.body?.mute) { world.mute(id); ModLog.add('admin', 'mute', id); } else { world.unmute(id); ModLog.add('admin', 'unmute', id); }
  res.json({ ok: true });
});

// ───────── static ─────────
// World client at /world, admin at /admin, 3D assets at /vendor + /client (all open-source).
// The optional private storefront + brand assets are served only if present (deploy overlay).
app.use('/vendor', express.static(path.join(PUBLIC, 'vendor'), { maxAge: '1d' }));
app.use('/client', express.static(path.join(PUBLIC, 'client'), { maxAge: 0, setHeaders: r => r.setHeader('Cache-Control', 'max-age=0, s-maxage=60') }));
app.use('/admin', express.static(path.join(PUBLIC, 'admin'), { maxAge: 0, setHeaders: r => r.setHeader('Cache-Control', 'max-age=0, s-maxage=60') }));
if (SERVE_BRAND) app.use('/brand', express.static(path.join(PUBLIC, 'brand'), { maxAge: '1h' }));
if (HAS_STOREFRONT) app.use(express.static(path.join(PUBLIC, 'storefront'), { maxAge: 0, setHeaders: r => r.setHeader('Cache-Control', 'max-age=0, s-maxage=60') }));
app.get('/world', (_req, res) => res.sendFile(path.join(PUBLIC, 'client', 'index.html')));
// Meeting-prep landing page ("will your bot meet my bot?"). Reads ?m=<id> on the client.
app.get('/meet', (_req, res) => res.sendFile(path.join(PUBLIC, 'client', 'meet.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC, 'admin', 'admin.html')));
// Root: private storefront if present, otherwise the open commons.
if (!HAS_STOREFRONT) app.get('/', (_req, res) => res.redirect('/world'));
app.get('/healthz', (_req, res) => res.json({ ok: true, up: process.uptime() }));

// ───────── http + ws ─────────
const server = http.createServer(app);

// Human world WS
const worldWss = new WebSocketServer({ noServer: true });
const humanClients = new Set();
const moveLimiter = new RateLimiter();
const humanMsgWindow = new WindowCounter(60000);

world.on('state', (snap) => {
  const payload = JSON.stringify({ type: 'state', snap });
  for (const c of humanClients) { if (c.ws.readyState === 1) { try { c.ws.send(payload); } catch { /* */ } } }
});
world.on('chat', (msg) => {
  const payload = JSON.stringify({ type: 'chat', msg });
  for (const c of humanClients) { if (c.ws.readyState === 1) { try { c.ws.send(payload); } catch { /* */ } } }
});
world.on('freeze', (frozen) => {
  const payload = JSON.stringify({ type: 'freeze', frozen });
  for (const c of humanClients) { if (c.ws.readyState === 1) { try { c.ws.send(payload); } catch { /* */ } } }
});

worldWss.on('connection', (ws, req, name) => {
  const id = 'human:' + crypto.randomBytes(5).toString('hex');
  const ent = world.spawn({ id, name, kind: 'human' });
  const client = { ws, id };
  humanClients.add(client);
  ws.send(JSON.stringify({ type: 'welcome', id, name, you: ent.id,
    config: { commons: config.commons, lake: config.lake, palette: config.palette }, snap: world.snapshot() }));
  ws.send(JSON.stringify({ type: 'history', messages: ChatLog.recent(40) }));

  ws.on('message', (buf) => {
    if (buf.length > 4096) return;
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
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
  });
  ws.on('close', () => { humanClients.delete(client); world.despawn(id); });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  // WS origin check
  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  if (url.pathname === '/world/v1/ws') {
    const name = sanitizeName(url.searchParams.get('name') || 'Guest', 24);
    worldWss.handleUpgrade(req, socket, head, (ws) => worldWss.emit('connection', ws, req, name));
    return;
  }
  if (gateway.handleUpgrade(req, socket, head)) return;
  socket.destroy();
});
gateway.attachWss(server, '/gateway/v1/ws');

server.listen(PORT, '127.0.0.1', () => {
  log(`Chatter Bots listening on http://127.0.0.1:${PORT}`);
  log(`Grok brain: ${grokAvailable() ? 'ENABLED' : 'offline fallback'} | Bot Beacons: ${beacons.enabled ? 'ENABLED' : 'disabled'}`);
});

// Demo is OFF by default — the world stays calm and ready for real meetings (no scripted
// firepit/meadow/golden-hour chatter posted to chat or board). Opt in with AUTO_DEMO=1.
const AUTO_DEMO = process.env.AUTO_DEMO === '1';
if (AUTO_DEMO) setTimeout(() => { demo.run(['elowen', 'fenn']).then(r => log('[demo:auto]', r)).catch(e => log('[demo:auto] error', e.message)); }, 2500);

process.on('SIGTERM', () => { beacons.stop(); server.close(() => process.exit(0)); });
