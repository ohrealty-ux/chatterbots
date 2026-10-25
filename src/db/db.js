// SQLite persistence layer. Stores bots, lots/registry, waitlist, leads,
// chat log, audit log, moderation log. Chosen over Postgres for zero-dependency reliability.
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// DB file is overridable via WORLD_DB (relative paths resolve under data/). This lets the
// headless demo run against its own file instead of sharing the live server's world.db.
const DB_FILE = process.env.WORLD_DB
  ? (path.isAbsolute(process.env.WORLD_DB) ? process.env.WORLD_DB : path.join(DATA_DIR, process.env.WORLD_DB))
  : path.join(DATA_DIR, 'world.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// Cleanly finalize all prepared statements and close the handle. Call before a short-lived
// process exits (e.g. the headless demo) to avoid better-sqlite3's teardown assertion on Node 24.
export function closeDb() { try { db.close(); } catch { /* already closed */ } }

db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  home_lot TEXT,
  status TEXT DEFAULT 'idle',
  token_hash TEXT,
  token_prefix TEXT,
  scopes TEXT DEFAULT 'join,move,say,emote,status,sit,look,follow,enter_lot,place_object',
  owner TEXT,
  revoked INTEGER DEFAULT 0,
  brain TEXT DEFAULT 'offline',
  tokens_used_today INTEGER DEFAULT 0,
  tokens_day TEXT,
  created_at INTEGER,
  recent_chat TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL,
  boundaries TEXT,
  acreage REAL,
  list_price_token REAL,
  list_price_fiat REAL,
  owner TEXT,
  assigned_bot TEXT,
  permissions TEXT DEFAULT '{}',
  decor_layout TEXT DEFAULT '[]',
  reserved INTEGER DEFAULT 0,
  label TEXT
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  lot_id TEXT,
  tier TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, email TEXT, phone TEXT, message TEXT, kind TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, actor_kind TEXT, channel TEXT, text TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, action TEXT, detail TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT, action TEXT, target TEXT, detail TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS board_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT, author TEXT, text TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_bot TEXT NOT NULL,
  to_bot TEXT NOT NULL,
  place TEXT,
  place_label TEXT,
  time_label TEXT,
  fire_at INTEGER,
  status TEXT DEFAULT 'pending',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS meeting_preps (
  id TEXT PRIMARY KEY,
  location TEXT,
  time_label TEXT,
  party_a TEXT,
  party_b TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
`);

// Decorative per-bot "beacon badge" opt-in (purely cosmetic nameplate glow). This is NOT a
// real Bot Beacon and holds NO beacon key/topic/pairing data — just a 0/1 display flag.
// Added as a backward-compatible migration so existing databases keep working.
try { db.prepare('ALTER TABLE bots ADD COLUMN beacon INTEGER DEFAULT 0').run(); }
catch { /* column already exists */ }

const now = () => Date.now();

export const Bots = {
  upsert(b) {
    db.prepare(`INSERT INTO bots (id,name,avatar,home_lot,status,token_hash,token_prefix,scopes,owner,brain,created_at,recent_chat)
      VALUES (@id,@name,@avatar,@home_lot,@status,@token_hash,@token_prefix,@scopes,@owner,@brain,@created_at,'[]')
      ON CONFLICT(id) DO UPDATE SET name=@name,avatar=@avatar,home_lot=@home_lot,status=@status,scopes=@scopes,owner=@owner,brain=@brain`).run(b);
  },
  get(id) { return db.prepare('SELECT * FROM bots WHERE id=?').get(id); },
  byTokenPrefix(prefix) { return db.prepare('SELECT * FROM bots WHERE token_prefix=? AND revoked=0').get(prefix); },
  all() { return db.prepare('SELECT * FROM bots ORDER BY created_at DESC').all(); },
  setStatus(id, status) { db.prepare('UPDATE bots SET status=? WHERE id=?').run(status, id); },
  setToken(id, hash, prefix) { db.prepare('UPDATE bots SET token_hash=?,token_prefix=?,revoked=0 WHERE id=?').run(hash, prefix, id); },
  revoke(id) { db.prepare('UPDATE bots SET revoked=1 WHERE id=?').run(id); },
  setBeacon(id, on) { db.prepare('UPDATE bots SET beacon=? WHERE id=?').run(on ? 1 : 0, id); },
  remove(id) { db.prepare('DELETE FROM bots WHERE id=?').run(id); },
  addTokens(id, n) {
    const day = new Date().toISOString().slice(0, 10);
    const row = db.prepare('SELECT tokens_used_today,tokens_day FROM bots WHERE id=?').get(id) || {};
    let used = row.tokens_day === day ? (row.tokens_used_today || 0) : 0;
    used += n;
    db.prepare('UPDATE bots SET tokens_used_today=?,tokens_day=? WHERE id=?').run(used, day, id);
    return used;
  },
  tokensToday(id) {
    const day = new Date().toISOString().slice(0, 10);
    const row = db.prepare('SELECT tokens_used_today,tokens_day FROM bots WHERE id=?').get(id);
    if (!row || row.tokens_day !== day) return 0;
    return row.tokens_used_today || 0;
  },
  setRecentChat(id, arr) { db.prepare('UPDATE bots SET recent_chat=? WHERE id=?').run(JSON.stringify(arr.slice(-20)), id); }
};

export const Lots = {
  upsert(l) {
    db.prepare(`INSERT INTO lots (id,tier,boundaries,acreage,list_price_token,list_price_fiat,owner,assigned_bot,permissions,decor_layout,reserved,label)
      VALUES (@id,@tier,@boundaries,@acreage,@list_price_token,@list_price_fiat,@owner,@assigned_bot,@permissions,@decor_layout,@reserved,@label)
      ON CONFLICT(id) DO UPDATE SET tier=@tier,boundaries=@boundaries,acreage=@acreage,list_price_token=@list_price_token,list_price_fiat=@list_price_fiat,reserved=@reserved,label=@label`).run(l);
  },
  get(id) { return db.prepare('SELECT * FROM lots WHERE id=?').get(id); },
  all() { return db.prepare('SELECT * FROM lots').all(); },
  byTier(tier) { return db.prepare('SELECT * FROM lots WHERE tier=?').all(tier); },
  count() { return db.prepare('SELECT COUNT(*) c FROM lots').get().c; },
  assignBot(id, botId) { db.prepare('UPDATE lots SET assigned_bot=? WHERE id=?').run(botId, id); },
  setOwner(id, owner) { db.prepare('UPDATE lots SET owner=? WHERE id=?').run(owner, id); },
  setDecor(id, layout) { db.prepare('UPDATE lots SET decor_layout=? WHERE id=?').run(JSON.stringify(layout), id); }
};

export const Waitlist = {
  add(email, lot_id, tier) { return db.prepare('INSERT INTO waitlist (email,lot_id,tier,created_at) VALUES (?,?,?,?)').run(email, lot_id, tier, now()).lastInsertRowid; },
  all() { return db.prepare('SELECT * FROM waitlist ORDER BY created_at DESC').all(); }
};
export const Leads = {
  add(l) { return db.prepare('INSERT INTO leads (name,email,phone,message,kind,created_at) VALUES (?,?,?,?,?,?)').run(l.name, l.email, l.phone, l.message, l.kind, now()).lastInsertRowid; },
  all() { return db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all(); }
};
export const ChatLog = {
  add(actor, actor_kind, channel, text) { db.prepare('INSERT INTO chat_log (actor,actor_kind,channel,text,created_at) VALUES (?,?,?,?,?)').run(actor, actor_kind, channel, text, now()); },
  recent(n = 100) { return db.prepare('SELECT * FROM chat_log ORDER BY id DESC LIMIT ?').all(n).reverse(); }
};
export const AuditLog = {
  add(actor, action, detail) { db.prepare('INSERT INTO audit_log (actor,action,detail,created_at) VALUES (?,?,?,?)').run(actor, action, typeof detail === 'string' ? detail : JSON.stringify(detail || {}), now()); },
  recent(n = 200) { return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(n); }
};
export const ModLog = {
  add(actor, action, target, detail) { db.prepare('INSERT INTO moderation_log (actor,action,target,detail,created_at) VALUES (?,?,?,?,?)').run(actor, action, target, detail || '', now()); },
  recent(n = 200) { return db.prepare('SELECT * FROM moderation_log ORDER BY id DESC LIMIT ?').all(n); }
};
export const Board = {
  add(board, author, text) { return db.prepare('INSERT INTO board_posts (board,author,text,created_at) VALUES (?,?,?,?)').run(board, author, text, now()).lastInsertRowid; },
  byBoard(board, n = 50) { return db.prepare('SELECT * FROM board_posts WHERE board=? ORDER BY id DESC LIMIT ?').all(board, n).reverse(); }
};

// Bot-to-bot meetings / rendezvous. status: pending -> accepted|declined -> active -> done.
export const Meetings = {
  add(m) {
    return db.prepare(`INSERT INTO meetings (from_bot,to_bot,place,place_label,time_label,fire_at,status,created_at)
      VALUES (@from_bot,@to_bot,@place,@place_label,@time_label,@fire_at,@status,@created_at)`).run({
        from_bot: m.fromBot, to_bot: m.toBot, place: m.place || null, place_label: m.placeLabel || null,
        time_label: m.timeLabel || null, fire_at: m.fireAt ?? null, status: m.status || 'pending', created_at: now(),
      }).lastInsertRowid;
  },
  get(id) { return db.prepare('SELECT * FROM meetings WHERE id=?').get(id); },
  setStatus(id, status) { db.prepare('UPDATE meetings SET status=? WHERE id=?').run(status, id); },
  setFireAt(id, fireAt) { db.prepare('UPDATE meetings SET fire_at=? WHERE id=?').run(fireAt, id); },
  // Open meetings where a bot is organiser or invitee.
  forBot(botId) {
    return db.prepare(`SELECT * FROM meetings WHERE (from_bot=? OR to_bot=?)
      AND status IN ('pending','accepted','active') ORDER BY id DESC`).all(botId, botId);
  },
  // Accepted meetings whose scheduled time has arrived (relative/demo timers).
  dueAccepted(ts) {
    return db.prepare("SELECT * FROM meetings WHERE status='accepted' AND fire_at IS NOT NULL AND fire_at<=?").all(ts);
  },
  // Pending/accepted duplicate guard for the natural-language auto-proposer.
  openBetween(fromBot, toBot, place) {
    return db.prepare(`SELECT * FROM meetings WHERE from_bot=? AND to_bot=? AND place=?
      AND status IN ('pending','accepted','active')`).get(fromBot, toBot, place);
  },
  all(n = 100) { return db.prepare('SELECT * FROM meetings ORDER BY id DESC LIMIT ?').all(n); },
};

// Web meeting-prep: a shareable meeting that two parties fill out prep forms for.
// Distinct from bot-to-bot `meetings` above. party_a / party_b hold JSON prep blobs.
// A bot/gateway can fetch the full agenda for a meeting via GET /api/meet/:id (see server.js).
function _genMeetId() {
  // short, URL-safe, unguessable-enough id (no 0/O/1/l confusion)
  const alpha = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = ''; const b = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) s += alpha[b[i] % alpha.length];
  return s;
}
export const MeetingPreps = {
  create({ location, timeLabel } = {}) {
    let id; // retry on the astronomically unlikely collision
    for (let i = 0; i < 5; i++) { id = _genMeetId(); if (!db.prepare('SELECT 1 FROM meeting_preps WHERE id=?').get(id)) break; }
    const ts = now();
    db.prepare(`INSERT INTO meeting_preps (id,location,time_label,party_a,party_b,created_at,updated_at)
      VALUES (?,?,?,NULL,NULL,?,?)`).run(id, location || 'Lakeside bench', timeLabel || null, ts, ts);
    return id;
  },
  get(id) {
    const row = db.prepare('SELECT * FROM meeting_preps WHERE id=?').get(id);
    if (!row) return null;
    const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
    return {
      id: row.id, location: row.location, timeLabel: row.time_label,
      parties: { A: parse(row.party_a), B: parse(row.party_b) },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  },
  // Save one party's prep ('A' or 'B'). Returns the updated meeting, or null if not found.
  setParty(id, party, prep) {
    if (!db.prepare('SELECT 1 FROM meeting_preps WHERE id=?').get(id)) return null;
    const col = party === 'B' ? 'party_b' : 'party_a';
    db.prepare(`UPDATE meeting_preps SET ${col}=?, updated_at=? WHERE id=?`).run(JSON.stringify(prep), now(), id);
    return this.get(id);
  },
  setMeta(id, { location, timeLabel }) {
    if (location !== undefined) db.prepare('UPDATE meeting_preps SET location=?, updated_at=? WHERE id=?').run(location, now(), id);
    if (timeLabel !== undefined) db.prepare('UPDATE meeting_preps SET time_label=?, updated_at=? WHERE id=?').run(timeLabel, now(), id);
    return this.get(id);
  },
};

export default db;
