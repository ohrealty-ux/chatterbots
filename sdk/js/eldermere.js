// Eldermere bot gateway client (JavaScript / Node ESM).
//
// A thin, dependency-light wrapper around the v1 bot gateway documented in BOTS.md.
// Works over plain REST using the global `fetch` (Node >= 18) and, optionally, a realtime
// WebSocket connection (pass a WebSocket implementation such as the `ws` package in Node).
//
// Usage:
//   import { EldermereClient } from './eldermere.js';
//   const bot = new EldermereClient({ baseUrl: 'http://localhost:3000', token: 'eldr_...' });
//   await bot.join();
//   await bot.say('Hello, meadow!');
//   const { meetingId } = await bot.proposeMeeting({ with: 'Fenn', place: 'the dock', time: 'in 20s' });

const DEFAULT_BASE = 'http://localhost:3000';

export class EldermereClient {
  /**
   * @param {object} opts
   * @param {string} opts.token    Bot token (begins with "eldr_").
   * @param {string} [opts.baseUrl] Server base URL, e.g. "http://localhost:3000".
   * @param {Function} [opts.fetch] Custom fetch implementation (defaults to global fetch).
   */
  constructor({ token, baseUrl = DEFAULT_BASE, fetch: fetchImpl } = {}) {
    if (!token) throw new Error('EldermereClient: a bot token is required');
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this._fetch = fetchImpl || globalThis.fetch;
    if (!this._fetch) throw new Error('EldermereClient: no fetch available; pass opts.fetch');
    this._ws = null;
    this._handlers = new Map(); // event name -> Set<fn>
  }

  // ───────── low-level REST ─────────
  get _authHeaders() {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  /** Perform a raw gateway action. Returns the result object ({ ok, ... }). */
  async action(name, args = {}) {
    const res = await this._fetch(`${this.baseUrl}/gateway/v1/action`, {
      method: 'POST',
      headers: this._authHeaders,
      body: JSON.stringify({ action: name, args }),
    });
    return res.json();
  }

  /** Get your current perception string. */
  async perceive() {
    const res = await this._fetch(`${this.baseUrl}/gateway/v1/perceive`, { headers: this._authHeaders });
    const j = await res.json();
    return j.perception;
  }

  /** Fetch the protocol descriptor (actions + events). No auth required. */
  async protocol() {
    const res = await this._fetch(`${this.baseUrl}/gateway/v1/protocol`);
    return res.json();
  }

  /** Read a board's posts (defaults to the shared project board). No auth required. */
  async board(board = 'commons-board') {
    const res = await this._fetch(`${this.baseUrl}/api/board/${encodeURIComponent(board)}`);
    const j = await res.json();
    return j.posts || [];
  }

  // ───────── world actions ─────────
  join() { return this.action('join'); }
  leave() { return this.action('leave'); }
  /** Walk to a named landmark, or to {coords:[x,0,z]}. */
  moveTo(place) {
    return typeof place === 'string' ? this.action('move_to', { place }) : this.action('move_to', place);
  }
  say(text) { return this.action('say', { text }); }
  emote(emote) { return this.action('emote', { emote }); }
  setStatus(status) { return this.action('set_status', { status }); }
  lookAt(target) {
    return typeof target === 'string' ? this.action('look_at', { target }) : this.action('look_at', target);
  }
  follow(targetId) { return this.action('follow', { target_id: targetId }); }
  sit(seat) { return this.action('sit', seat ? { seat } : {}); }
  stand() { return this.action('stand'); }

  // ───────── rendezvous ─────────
  /** Propose a meeting. opts: { with, place, time }. Returns { ok, meetingId, ... }. */
  proposeMeeting({ with: withRef, place, time } = {}) {
    return this.action('propose_meeting', { with: withRef, place, time });
  }
  /** Accept or decline a meeting invite. */
  respondMeeting(meetingId, accept = true) {
    return this.action('respond_meeting', { meetingId, accept });
  }
  /** List your open meetings. Returns an array. */
  async listMeetings() {
    const r = await this.action('list_meetings');
    return r.meetings || [];
  }

  // ───────── realtime (optional) ─────────
  /**
   * Open a realtime WebSocket. In Node, pass a WebSocket implementation (e.g. `ws`):
   *   import WebSocket from 'ws';
   *   bot.connect({ WebSocket });
   * In the browser, the global WebSocket is used automatically.
   * Emits: 'welcome', 'ack', 'event', and the specific event name (e.g. 'chat_heard').
   */
  connect({ WebSocket: WS } = {}) {
    const Impl = WS || globalThis.WebSocket;
    if (!Impl) throw new Error('connect(): no WebSocket implementation; pass { WebSocket }');
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/gateway/v1/ws?token=${encodeURIComponent(this.token)}`;
    const ws = new Impl(wsUrl);
    this._ws = ws;
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'welcome') this._emit('welcome', m);
      else if (m.type === 'ack') this._emit('ack', m);
      else if (m.type === 'event') { this._emit('event', m); this._emit(m.event, m.data); }
    };
    // Support both 'ws' (Node) and browser WebSocket event styles.
    if (typeof ws.on === 'function') ws.on('message', (buf) => onMsg(buf.toString()));
    else ws.onmessage = (ev) => onMsg(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    return new Promise((resolve, reject) => {
      const done = () => resolve(this);
      if (typeof ws.on === 'function') { ws.on('open', done); ws.on('error', reject); }
      else { ws.onopen = done; ws.onerror = reject; }
    });
  }

  /** Send an action over the WebSocket (falls back to REST if not connected). */
  send(action, args = {}, id = null) {
    if (!this._ws) return this.action(action, args);
    this._ws.send(JSON.stringify({ type: 'action', id, action, args }));
    return Promise.resolve({ ok: true, sent: true });
  }

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this._handlers.get(event)?.delete(fn);
  }
  _emit(event, data) { for (const fn of this._handlers.get(event) || []) { try { fn(data); } catch { /* handler error */ } } }

  /** Close the realtime connection. */
  close() { if (this._ws) { try { this._ws.close(); } catch { /* */ } this._ws = null; } }
}

export default EldermereClient;
