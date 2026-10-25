// Bot Gateway: REST + WebSocket on a versioned JSON protocol (v1).
// Auth via per-bot world pass (eldr_...). Rate-limited. Emits EVENTS to the bot; accepts ACTIONS from the bot.
import express from 'express';
import { WebSocketServer } from 'ws';
import { Bots, AuditLog } from '../db/db.js';
import { verifyTokenMigratable, hashToken, RateLimiter, WindowCounter } from '../security/security.js';
import { ACTIONS, dispatch, toolDefs } from './actions.js';
import { joinGuide } from '../world/botGuide.js';

const EVENTS = ['perception', 'chat_heard', 'mentioned', 'arrived', 'seated', 'entered_lot', 'error'];
const FAILED_AUTH_MAX = 10;        // per IP, per minute
const WS_AUTH_TIMEOUT_MS = 10000;  // deferred-auth sockets must send {type:'auth',token} within this

export class Gateway {
  constructor(world) {
    this.world = world;
    this.sessions = new Map();          // botId -> { ws|null, entityId, send }
    this.actionLimiter = new RateLimiter();
    this.msgWindow = new WindowCounter(60000);
    this.failedAuth = new WindowCounter(60000);   // per-IP failed world-pass attempts (10/min)
    this.rendezvous = null;             // set by server after construction (RendezvousManager)
    this.wake = null;                   // optional WakeNotifier, set by server
    this._wireWorldEvents();
  }

  // ───────── world-pass auth (section C) ─────────
  // Identical outcome (null) for EVERY failure reason, so a caller can only ever learn "unauthorized".
  _tooManyFails(ip) { return !!ip && this.failedAuth.count(String(ip)) >= FAILED_AUTH_MAX; }
  _recordFail(ip) { if (ip) this.failedAuth.allow(String(ip), Number.MAX_SAFE_INTEGER); }

  // Verify a raw world pass: 12-char prefix lookup, then constant-time digest compare via
  // verifyTokenMigratable (tolerates legacy plaintext/sha256 rows). Legacy rows are migrated
  // to the active sha256/HMAC(TOKEN_PEPPER)+prefix scheme on first successful auth. The raw
  // token is never logged. Returns the bot row or null.
  _authRaw(raw, ip) {
    if (this._tooManyFails(ip)) return null;
    if (!raw) return null;
    const prefix = String(raw).slice(0, 12);
    const bot = Bots.byTokenPrefix(prefix);
    if (!bot || bot.revoked) { this._recordFail(ip); return null; }
    const status = verifyTokenMigratable(raw, bot.token_hash);
    if (!status) { this._recordFail(ip); return null; }
    if (status === 'legacy') { try { Bots.setToken(bot.id, hashToken(raw), prefix); } catch { /* non-fatal */ } }
    return bot;
  }

  // REST auth: world pass ONLY via `Authorization: Bearer`. Tokens in the query string are rejected.
  authBot(req, ip) {
    if (req.query && (req.query.token || req.query.authorization)) { this._recordFail(ip); return null; }
    const h = req.headers['authorization'] || '';
    const raw = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!raw) return null;
    return this._authRaw(raw, ip);
  }

  // Number of live bot WS connections (used by the server's global connection cap).
  connectionCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.ws) n++;
    return n;
  }

  // ipFn is a getter the server supplies as `() => rawIp` — calling it yields the rawIp(req)
  // function, so the per-request IP is `ipFn()(req)`. Tolerates ipFn being absent or a direct fn.
  router(ipFn) {
    const r = express.Router();
    r.use(express.json({ limit: '16kb' }));
    const ipOf = (req) => {
      if (typeof ipFn !== 'function') return undefined;
      try { const g = ipFn(); return typeof g === 'function' ? g(req) : g; } catch { return undefined; }
    };

    // OpenAI-compatible tool definitions
    r.get('/v1/tools.json', (_req, res) => res.json({ version: 1, tools: toolDefs() }));
    r.get('/v1/protocol', (_req, res) => res.json({ version: 1, actions: ACTIONS, events: EVENTS, guide: joinGuide(this.world) }));

    const requireBot = (req, res, next) => {
      const bot = this.authBot(req, ipOf(req));
      if (!bot) return res.status(401).json({ ok: false, error: 'unauthorized' });
      req.bot = bot; next();
    };

    // REST perception
    r.get('/v1/perceive', requireBot, (req, res) => {
      const s = this.sessions.get(req.bot.id);
      if (!s) return res.json({ ok: true, perception: 'You are not in the world. Call join first.' });
      res.json({ ok: true, perception: this.world.perceive(s.entityId) });
    });

    // REST action
    r.post('/v1/action', requireBot, (req, res) => {
      const { action, args } = req.body || {};
      const out = this.handleAction(req.bot, action, args || {});
      res.status(out.ok ? 200 : 400).json(out);
    });

    return r;
  }

  // Rate-limited, allowlisted action dispatch shared by REST + WS + in-process bots.
  handleAction(botRow, action, args) {
    if (!botRow) return { ok: false, error: 'unauthorized' };
    if (!ACTIONS.includes(action)) return { ok: false, error: 'unknown_action' };
    const rl = this.world.config.botDefaults.rateLimit;
    if (!this.actionLimiter.allow('bot:' + botRow.id, rl.actionsPerSec, rl.actionsPerSec * 2))
      return { ok: false, error: 'rate_limited' };
    if (action === 'say' && !this.msgWindow.allow('bot:' + botRow.id, rl.msgsPerMin))
      return { ok: false, error: 'msg_rate_limited' };

    if (action === 'join') return this.join(botRow);
    if (action === 'leave') return this.leave(botRow.id);

    // Meeting / rendezvous actions are intercepted here (no world-scope gate; available to
    // every bot). They do not require an active session except where noted.
    if (action === 'propose_meeting') {
      if (!this.rendezvous) return { ok: false, error: 'rendezvous_unavailable' };
      return this.rendezvous.propose({ fromBotId: botRow.id, withRef: args.with, place: args.place, time: args.time });
    }
    if (action === 'respond_meeting') {
      if (!this.rendezvous) return { ok: false, error: 'rendezvous_unavailable' };
      return this.rendezvous.respond({ botId: botRow.id, meetingId: args.meetingId, accept: !!args.accept });
    }
    if (action === 'list_meetings') {
      if (!this.rendezvous) return { ok: false, error: 'rendezvous_unavailable' };
      return { ok: true, meetings: this.rendezvous.list(botRow.id) };
    }

    const s = this.sessions.get(botRow.id);
    if (!s) return { ok: false, error: 'not_joined' };
    const out = dispatch(this.world, botRow, s.entityId, action, args);
    // Natural-language rendezvous trigger: a plain "say" that proposes a meeting auto-creates
    // a proposal to the addressed/nearest bot. Meeting conversation uses world.say directly,
    // so it never re-enters this path (no recursion).
    if (action === 'say' && out.ok && this.rendezvous) {
      try { this.rendezvous.maybeAutoPropose(botRow, out.text || String(args.text || '')); } catch { /* non-fatal */ }
    }
    return out;
  }

  join(botRow) {
    // Only approved/active bots may enter the world. Pending/rejected bots can authenticate
    // (e.g. to register a wake webhook) but cannot spawn.
    if (botRow.status === 'pending' || botRow.status === 'rejected') return { ok: false, error: 'not_approved' };
    let s = this.sessions.get(botRow.id);
    if (s) return { ok: true, entityId: s.entityId, already: true };
    const entityId = 'bot:' + botRow.id;
    this.world.spawn({ id: entityId, name: botRow.name, kind: 'bot', avatar: botRow.avatar, owner: botRow.owner || 'Chatter Bots', homeLot: botRow.home_lot, beacon: botRow.beacon === 1 });
    s = { ws: null, entityId, botId: botRow.id, send: () => {} };
    this.sessions.set(botRow.id, s);
    AuditLog.add('bot:' + botRow.id, 'join', { name: botRow.name });
    return { ok: true, entityId, guide: joinGuide(this.world) };
  }
  leave(botId) {
    const s = this.sessions.get(botId);
    if (!s) return { ok: true };
    this.world.despawn(s.entityId);
    this.sessions.delete(botId);
    AuditLog.add('bot:' + botId, 'leave', {});
    return { ok: true };
  }

  // Map world events to the owning bot's session.
  _wireWorldEvents() {
    const toBot = (entityId) => {
      for (const s of this.sessions.values()) if (s.entityId === entityId) return s;
      return null;
    };
    this.world.on('chat_heard', ({ listener, from, mentioned }) => {
      const s = toBot(listener); if (!s) return;
      s.send({ type: 'event', event: 'chat_heard', data: { from: from.name, kind: from.kind, text: from.text } });
      if (mentioned) {
        s.send({ type: 'event', event: 'mentioned', data: { from: from.name, text: from.text } });
        if (this.wake) { try { this.wake.notify(s.botId, { from: from.name, text: from.text }); } catch { /* non-fatal */ } }
      }
    });
    this.world.on('arrived', ({ id, pos }) => { const s = toBot(id); if (s) s.send({ type: 'event', event: 'arrived', data: { pos } }); });
    this.world.on('seated', ({ id, seat }) => { const s = toBot(id); if (s) s.send({ type: 'event', event: 'seated', data: { seat } }); });
    this.world.on('entered_lot', ({ id, lotId }) => { const s = toBot(id); if (s) s.send({ type: 'event', event: 'entered_lot', data: { lotId } }); });
  }

  // WS server for bots (separate path from the human world WS).
  attachWss(server, path = '/gateway/v1/ws') {
    const wss = new WebSocketServer({ noServer: true });
    this._wss = wss;
    this._path = path;
    // bot may be null when the upgrade carried no world pass — then the socket must authenticate
    // with a {type:'auth',token} first message before any action is accepted.
    wss.on('connection', (ws, bot, ip) => this._onConnection(ws, bot, ip));
    return wss;
  }

  _onConnection(ws, bot, ip) {
    let botRow = null;
    let authed = false;
    let perInt = null;
    let authTimer = null;

    const startSession = (row) => {
      botRow = row;
      authed = true;
      const join = this.join(row);
      if (!join.ok) { try { ws.send(JSON.stringify({ type: 'event', event: 'error', data: join.error })); } catch { /* */ } }
      const s = this.sessions.get(row.id);
      if (!s) return;
      s.ws = ws;
      s.send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* closed */ } };
      s.send({ type: 'welcome', version: 1, entityId: join.entityId, perception: this.world.perceive(join.entityId), guide: joinGuide(this.world) });
      perInt = setInterval(() => { if (s.ws === ws) s.send({ type: 'event', event: 'perception', data: this.world.perceive(join.entityId) }); }, 5000);
      perInt.unref?.();
    };

    if (bot) {
      startSession(bot);
    } else {
      authTimer = setTimeout(() => { if (!authed) { try { ws.close(4001, 'auth_timeout'); } catch { /* */ } } }, WS_AUTH_TIMEOUT_MS);
      authTimer.unref?.();
    }

    ws.on('message', (buf) => {
      if (buf.length > 16384) return;
      let m; try { m = JSON.parse(buf.toString()); } catch { try { ws.send(JSON.stringify({ type: 'event', event: 'error', data: 'bad_json' })); } catch { /* */ } return; }
      if (!m || typeof m.type !== 'string') return;

      if (!authed) {
        // Deferred auth: the only message accepted before auth is {type:'auth',token}.
        if (m.type !== 'auth' || typeof m.token !== 'string') {
          try { ws.send(JSON.stringify({ type: 'event', event: 'error', data: 'unauthorized' })); } catch { /* */ }
          return;
        }
        const row = this._authRaw(m.token, ip);
        if (!row) {
          try { ws.send(JSON.stringify({ type: 'event', event: 'error', data: 'unauthorized' })); } catch { /* */ }
          try { ws.close(4001, 'unauthorized'); } catch { /* */ }
          return;
        }
        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
        startSession(row);
        return;
      }

      if (m.type === 'action') {
        const out = this.handleAction(botRow, m.action, m.args || {});
        const s = this.sessions.get(botRow.id);
        if (s) s.send({ type: 'ack', id: m.id || null, result: out });
      }
    });

    ws.on('close', () => { if (perInt) clearInterval(perInt); if (authTimer) clearTimeout(authTimer); });
  }

  // HTTP → WS upgrade. World pass accepted via `Authorization: Bearer` or the
  // `Sec-WebSocket-Protocol` header; tokens in the query string are rejected. If no pass is
  // present, the upgrade is allowed and the socket must authenticate with a first message.
  handleUpgrade(req, socket, head, ip) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== this._path) return false;
    if (url.searchParams.get('token')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return true;
    }
    const h = req.headers['authorization'] || '';
    let raw = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!raw && req.headers['sec-websocket-protocol']) {
      raw = String(req.headers['sec-websocket-protocol']).split(',')[0].trim();
    }
    if (raw) {
      const bot = this._authRaw(raw, ip);
      if (!bot) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return true; }
      this._wss.handleUpgrade(req, socket, head, (ws) => this._wss.emit('connection', ws, bot, ip));
      return true;
    }
    // No pass on the handshake → allow upgrade, require {type:'auth',token} first message.
    this._wss.handleUpgrade(req, socket, head, (ws) => this._wss.emit('connection', ws, null, ip));
    return true;
  }
}
