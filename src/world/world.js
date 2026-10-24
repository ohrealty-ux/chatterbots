// Authoritative world. Server owns positions, seats, lots, chat. Clients are thin.
import { EventEmitter } from 'node:events';
import { ChatLog } from '../db/db.js';
import { sanitizeText, filterProfanity } from '../security/security.js';

const TICK_MS = 100;            // 10 Hz authoritative sim
const NEARBY_RADIUS = 14;       // proximity chat / perception radius
const SEAT_SNAP = 1.2;

function dist2(a, b) { const dx = a[0] - b[0], dz = a[2] - b[2]; return dx * dx + dz * dz; }
function clampSpeed(dx, dz, max) {
  const l = Math.hypot(dx, dz);
  if (l <= max) return [dx, dz];
  return [dx / l * max, dz / l * max];
}

export class World extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.entities = new Map();   // id -> entity
    this.seats = new Map();      // slotId -> { anchorId, slot, occupant }
    this.frozen = false;         // global freeze-all-bots switch
    this.muted = new Set();      // entity ids muted by moderation
    this.blocked = new Set();    // entity ids blocked (kicked)
    this.namedPlaces = this._buildPlaces(config);
    this._initSeats(config);
    this.loop = setInterval(() => this.tick(), TICK_MS);
    this.loop.unref?.();
  }

  // Build the named-place index. Produces two maps keyed by normalized name:
  //   this.namedPlaces  name -> [x,0,z]                       (back-compat: resolvePlace)
  //   this.landmarks    name -> { pos, label, seatAnchorId }  (rich: resolveLandmark)
  // Data-driven: reads config.landmarks (canonical + aliases) when present, and always
  // derives sensible defaults from commons/lake so the resolver works even without that block.
  _buildPlaces(cfg) {
    const places = {};
    const landmarks = {};
    const c = cfg.commons;
    const anchorCenter = (id) => { const a = (c.seatAnchors || []).find(s => s.id === id); return a ? a.center : null; };
    const put = (names, pos, label, seatAnchorId = null) => {
      if (!pos) return;
      for (const n of names) {
        const k = this._normKey(n);
        if (!k) continue;
        places[k] = pos;
        landmarks[k] = { pos, label: label || names[0], seatAnchorId: seatAnchorId || null };
      }
    };

    // Defaults derived from the world (always available).
    put([c.name, 'commons', 'eldermere commons'], c.center, 'Eldermere Commons');
    put(['picnic bench', 'picnic table'], anchorCenter('picnic-bench'), 'Picnic Table', 'picnic-bench');
    put(['firepit', 'fire pit'], c.firepit, 'Firepit', 'firepit-ring');
    put(['project board', 'whiteboard'], c.whiteboard && c.whiteboard.pos, 'Project Board');
    put(['lakeside bench', 'the bench'], anchorCenter('lakeside-bench'), 'Lakeside Bench', 'lakeside-bench');
    if (cfg.lake) put([cfg.lake.name, 'lake elon', 'the lake'], cfg.lake.center, cfg.lake.name || 'Lake Elon');

    // Config-driven canonical landmarks (override/extend defaults).
    const lm = cfg.landmarks || {};
    const canon = lm.canonical || {};
    for (const [key, def] of Object.entries(canon)) {
      if (def && Array.isArray(def.pos)) put([key, def.label || key], def.pos, def.label || key, def.seatAnchor || null);
    }
    // Config-driven aliases -> resolve to a canonical/known key.
    for (const [alias, target] of Object.entries(lm.aliases || {})) {
      const tk = this._normKey(target);
      const t = landmarks[tk];
      if (t) { const k = this._normKey(alias); places[k] = t.pos; landmarks[k] = t; }
    }

    this.landmarks = landmarks;
    return places;
  }

  // Normalize a spoken place name: lowercase, strip punctuation, collapse whitespace.
  _normKey(name) {
    return String(name || '').toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  _initSeats(cfg) {
    for (const anchor of cfg.commons.seatAnchors) {
      for (const slot of anchor.slots) {
        this.seats.set(slot.id, { anchorId: anchor.id, slot, occupant: null });
      }
    }
  }

  // Resolve a spoken place name to [x,0,z] (back-compatible). Case-insensitive, tolerant:
  // exact normalized match, then with a leading "the " dropped.
  resolvePlace(name) {
    const lm = this.resolveLandmark(name);
    return lm ? lm.pos : null;
  }

  // Resolve to a rich landmark { pos, label, seatAnchorId } or null.
  resolveLandmark(name) {
    if (!name) return null;
    const key = this._normKey(name);
    if (this.landmarks[key]) return this.landmarks[key];
    if (key.startsWith('the ') && this.landmarks[key.slice(4)]) return this.landmarks[key.slice(4)];
    return null;
  }

  // List of all known landmark keys (longest first) — used by the NL meeting parser.
  landmarkKeys() {
    return Object.keys(this.landmarks).sort((a, b) => b.length - a.length);
  }

  // First free seat slot id within a given seat anchor (e.g. 'lakeside-bench'), or null.
  freeSeatIn(anchorId) {
    for (const [sid, s] of this.seats) if (s.anchorId === anchorId && !s.occupant) return sid;
    return null;
  }

  // ───────── entity lifecycle ─────────
  spawn({ id, name, kind, avatar, owner, homeLot }) {
    const spawnPt = this.config.commons.center;
    const ent = {
      id, name, kind, avatar: avatar || null, owner: owner || null, homeLot: homeLot || null,
      pos: [spawnPt[0] + (Math.random() * 8 - 4), 0, spawnPt[2] + 8 + (Math.random() * 6)],
      yaw: Math.PI, status: 'idle', seat: null, lotInside: null,
      target: null, followId: null, emote: null, lookAt: null,
      maxSpeed: kind === 'bot' ? this.config.botDefaults.maxSpeed : this.config.visitorLimits.maxSpeed,
      lastSeen: Date.now()
    };
    this.entities.set(id, ent);
    this.emit('spawn', ent);
    this._broadcastState();
    return ent;
  }

  despawn(id) {
    const ent = this.entities.get(id);
    if (!ent) return;
    if (ent.seat) this._vacate(ent);
    this.entities.delete(id);
    this.emit('despawn', id);
    this._broadcastState();
  }

  get(id) { return this.entities.get(id); }

  // ───────── movement (server-authoritative; no teleport, clamped speed, private-lot gate) ─────────
  setTarget(id, pos) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false, error: 'no_entity' };
    if (ent.seat) this._vacate(ent);
    ent.target = [pos[0], 0, pos[2]];
    ent.followId = null;
    return { ok: true };
  }
  // Direct player movement proposal — validated (clamped) before applying.
  moveProposal(id, dx, dz, yaw) {
    const ent = this.entities.get(id);
    if (!ent || ent.seat) return;
    const max = ent.maxSpeed * (TICK_MS / 1000) * 2.5; // generous per-message cap
    [dx, dz] = clampSpeed(dx, dz, max);
    const nx = ent.pos[0] + dx, nz = ent.pos[2] + dz;
    if (this._blockedByPrivateLot(ent, [nx, 0, nz])) return;
    ent.pos[0] = nx; ent.pos[2] = nz; if (typeof yaw === 'number') ent.yaw = yaw;
    ent.target = null;
  }

  _blockedByPrivateLot(ent, pos) {
    // demo: lots are not physically collidable except private-permission gate via enter_lot.
    return false;
  }

  follow(id, targetId) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false, error: 'no_entity' };
    if (!this.entities.get(targetId)) return { ok: false, error: 'no_target' };
    if (ent.seat) this._vacate(ent);
    ent.followId = targetId; ent.target = null;
    return { ok: true };
  }

  lookAt(id, targetOrPos) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false };
    let p = null;
    if (typeof targetOrPos === 'string') { const t = this.entities.get(targetOrPos); if (t) p = t.pos; else p = this.resolvePlace(targetOrPos); }
    else if (Array.isArray(targetOrPos)) p = targetOrPos;
    if (!p) return { ok: false, error: 'no_target' };
    ent.yaw = Math.atan2(p[0] - ent.pos[0], p[2] - ent.pos[2]);
    ent.lookAt = p;
    return { ok: true };
  }

  // ───────── seats ─────────
  sit(id, seatSlotId) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false, error: 'no_entity' };
    // if no slot given, pick nearest free slot of picnic bench
    let seat = seatSlotId ? this.seats.get(seatSlotId) : this._nearestFreeSeat(ent.pos);
    if (!seat) return { ok: false, error: 'seat_not_found' };
    if (seat.occupant && seat.occupant !== id) return { ok: false, error: 'seat_taken' };
    if (ent.seat) this._vacate(ent);
    seat.occupant = id;
    ent.seat = seat.slot.id;
    ent.pos = [seat.slot.pos[0], 0, seat.slot.pos[2]];
    ent.yaw = Math.atan2(seat.slot.faceTo[0] - ent.pos[0], seat.slot.faceTo[2] - ent.pos[2]);
    ent.target = null; ent.followId = null; ent.status = ent.status === 'idle' ? 'working' : ent.status;
    this.emit('seated', { id, seat: seat.slot.id });
    this._broadcastState();
    return { ok: true, seat: seat.slot.id };
  }
  _nearestFreeSeat(pos) {
    let best = null, bd = Infinity;
    for (const s of this.seats.values()) {
      if (s.occupant) continue;
      const d = dist2(pos, s.slot.pos);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  _vacate(ent) {
    const s = this.seats.get(ent.seat);
    if (s) s.occupant = null;
    ent.seat = null;
  }
  stand(id) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false };
    if (ent.seat) this._vacate(ent);
    ent.pos[2] += 2;
    return { ok: true };
  }

  enterLot(id, lotId, allowed) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false, error: 'no_entity' };
    if (!allowed) return { ok: false, error: 'permission_denied' };
    ent.lotInside = lotId;
    this.emit('entered_lot', { id, lotId });
    return { ok: true };
  }

  setStatus(id, status) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false };
    const valid = ['idle', 'working', 'done', 'needs_attention'];
    if (!valid.includes(status)) return { ok: false, error: 'bad_status' };
    ent.status = status;
    this._broadcastState();
    return { ok: true };
  }
  emote(id, emote) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false };
    ent.emote = String(emote).slice(0, 24);
    setTimeout(() => { if (ent.emote === emote) ent.emote = null; }, 3000);
    this.emit('emote', { id, emote: ent.emote });
    return { ok: true };
  }

  // ───────── chat (proximity) ─────────
  say(id, text, maxChars = 500) {
    const ent = this.entities.get(id);
    if (!ent) return { ok: false, error: 'no_entity' };
    if (this.muted.has(id)) return { ok: false, error: 'muted' };
    let clean = filterProfanity(sanitizeText(text, maxChars));
    if (!clean) return { ok: false, error: 'empty' };
    ChatLog.add(ent.name, ent.kind, 'proximity', clean);
    const msg = { id, name: ent.name, kind: ent.kind, text: clean, at: Date.now() };
    // deliver to nearby entities as perception/chat_heard + mentioned
    for (const other of this.entities.values()) {
      if (other.id === id) continue;
      if (dist2(ent.pos, other.pos) <= NEARBY_RADIUS * NEARBY_RADIUS) {
        const mentioned = clean.toLowerCase().includes(other.name.toLowerCase());
        this.emit('chat_heard', { listener: other.id, from: msg, mentioned });
      }
    }
    this.emit('chat', msg);
    return { ok: true, text: clean };
  }

  // ───────── perception for bots: short plain-text summary of who/what is nearby ─────────
  perceive(id) {
    const ent = this.entities.get(id);
    if (!ent) return '';
    const near = [];
    for (const other of this.entities.values()) {
      if (other.id === id) continue;
      if (dist2(ent.pos, other.pos) <= NEARBY_RADIUS * NEARBY_RADIUS) {
        const d = Math.round(Math.hypot(ent.pos[0] - other.pos[0], ent.pos[2] - other.pos[2]));
        near.push(`${other.name} (${other.kind}${other.seat ? ', seated' : ''}, ${other.status}, ${d}m away)`);
      }
    }
    const place = this._placeLabel(ent.pos);
    let s = `You are ${ent.name}. You are ${ent.seat ? 'sitting' : 'standing'} at ${place}.`;
    s += near.length ? ` Nearby: ${near.join('; ')}.` : ' No one is nearby.';
    return s;
  }
  _placeLabel(pos) {
    const c = this.config.commons;
    if (dist2(pos, c.seatAnchors[0].center) < 36) return 'the picnic table in Eldermere Commons';
    if (dist2(pos, c.firepit) < 36) return 'the firepit in Eldermere Commons';
    if (dist2(pos, this.config.lake.center) < this.config.lake.radius * this.config.lake.radius) return 'the shore of Lake Elon';
    return 'Eldermere Commons';
  }

  // ───────── tick: advance bot movement toward targets / follow ─────────
  tick() {
    const dt = TICK_MS / 1000;
    for (const ent of this.entities.values()) {
      if (ent.seat) continue;
      let tgt = ent.target;
      if (ent.followId) {
        const t = this.entities.get(ent.followId);
        if (t) tgt = [t.pos[0] - 1.5, 0, t.pos[2] - 1.5];
      }
      if (tgt) {
        let dx = tgt[0] - ent.pos[0], dz = tgt[2] - ent.pos[2];
        const d = Math.hypot(dx, dz);
        const step = ent.maxSpeed * dt;
        if (d <= Math.max(step, SEAT_SNAP)) {
          if (!ent.followId) { ent.target = null; this.emit('arrived', { id: ent.id, pos: ent.pos.slice() }); }
        } else {
          ent.pos[0] += dx / d * step; ent.pos[2] += dz / d * step;
          ent.yaw = Math.atan2(dx, dz);
        }
      }
    }
    this._broadcastState();
  }

  snapshot() {
    const ents = [];
    for (const e of this.entities.values()) {
      ents.push({ id: e.id, name: e.name, kind: e.kind, avatar: e.avatar, owner: e.owner,
        pos: [Math.round(e.pos[0] * 100) / 100, 0, Math.round(e.pos[2] * 100) / 100],
        yaw: Math.round(e.yaw * 1000) / 1000, status: e.status, seat: e.seat, emote: e.emote });
    }
    return { t: Date.now(), entities: ents, frozen: this.frozen };
  }
  _broadcastState() { this.emit('state', this.snapshot()); }

  freezeAll(v) { this.frozen = !!v; this.emit('freeze', this.frozen); }
  isFrozen() { return this.frozen; }
  mute(id) { this.muted.add(id); }
  unmute(id) { this.muted.delete(id); }
}
