// Bot Gateway: REST + WebSocket on a versioned JSON protocol (v1).
// Auth via per-bot token. Rate-limited. Emits EVENTS to the bot; accepts ACTIONS from the bot.
import express from 'express';
import { WebSocketServer } from 'ws';
import { Bots, AuditLog } from '../db/db.js';
import { verifyToken, RateLimiter, WindowCounter } from '../security/security.js';
import { ACTIONS, dispatch, toolDefs } from './actions.js';
import { joinGuide } from '../world/botGuide.js';

const EVENTS = ['perception', 'chat_heard', 'mentioned', 'arrived', 'seated', 'entered_lot', 'error'];

export class Gateway {
  constructor(world) {
    this.world = world;
    this.sessions = new Map();          // botId -> { ws|null, entityId, send }
    this.actionLimiter = new RateLimiter();
    this.msgWindow = new WindowCounter(60000);
    this.rendezvous = null;             // set by server after construction (RendezvousManager)
    this._wireWorldEvents();
  }

  authBot(req) {
    const h = req.headers['authorization'] || '';
    const raw = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    if (!raw) return null;
    const prefix = String(raw).slice(0, 12);
    const bot = Bots.byTokenPrefix(prefix);
    if (!bot || bot.revoked) return null;
    if (!verifyToken(raw, bot.token_hash)) return null;
    return bot;
  }

  router() {
    const r = express.Router();
    r.use(express.json({ limit: '16kb' }));

    // OpenAI-compatible tool definitions
    r.get('/v1/tools.json', (_req, res) => res.json({ version: 1, tools: toolDefs() }));
    r.get('/v1/protocol', (_req, res) => res.json({ version: 1, actions: ACTIONS, events: EVENTS, guide: joinGuide(this.world) }));

    const requireBot = (req, res, next) => {
      const bot = this.authBot(req);
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
    let s = this.sessions.get(botRow.id);
    if (s) return { ok: true, entityId: s.entityId, already: true };
    const entityId = 'bot:' + botRow.id;
    this.world.spawn({ id: entityId, name: botRow.name, kind: 'bot', avatar: botRow.avatar, owner: botRow.owner || 'The Bot Farm', homeLot: botRow.home_lot });
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
      if (mentioned) s.send({ type: 'event', event: 'mentioned', data: { from: from.name, text: from.text } });
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
    wss.on('connection', (ws, bot) => {
      const join = this.join(bot);
      const s = this.sessions.get(bot.id);
      s.ws = ws;
      s.send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* closed */ } };
      s.send({ type: 'welcome', version: 1, entityId: join.entityId, perception: this.world.perceive(join.entityId), guide: joinGuide(this.world) });
      // periodic perception push
      const perInt = setInterval(() => { if (s.ws === ws) s.send({ type: 'event', event: 'perception', data: this.world.perceive(join.entityId) }); }, 5000);
      perInt.unref?.();
      ws.on('message', (buf) => {
        if (buf.length > 16384) return;
        let m; try { m = JSON.parse(buf.toString()); } catch { return s.send({ type: 'event', event: 'error', data: 'bad_json' }); }
        if (m.type === 'action') {
          const out = this.handleAction(bot, m.action, m.args || {});
          s.send({ type: 'ack', id: m.id || null, result: out });
        }
      });
      ws.on('close', () => { clearInterval(perInt); });
    });
    return wss;
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== this._path) return false;
    const token = url.searchParams.get('token') || (req.headers['sec-websocket-protocol'] || '');
    const prefix = String(token).slice(0, 12);
    const bot = Bots.byTokenPrefix(prefix);
    if (!bot || bot.revoked || !verifyToken(token, bot.token_hash)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return true;
    }
    this._wss.handleUpgrade(req, socket, head, (ws) => this._wss.emit('connection', ws, bot));
    return true;
  }
}
