// Bot-to-bot RENDEZVOUS / meeting-scheduling.
// - propose/respond/list meetings between bots (persisted in SQLite via Meetings).
// - a lightweight natural-language parser so a bot saying "meet me at the dock in 30s"
//   auto-creates a meeting invite (no external NLP libraries).
// - a scheduler loop that fires accepted meetings when their time arrives: both bots
//   walk to the place, sit if seats exist, hold a short business discussion via the
//   offline brain, and post an agreed solution to the project board.
// Brand-neutral. No wallet/payment. Offline brain works with no API key.
import { EventEmitter } from 'node:events';
import { Meetings, Bots, Board } from '../db/db.js';
import { OfflineBrain } from '../brains/offline.js';
import { GrokBrain, grokAvailable } from '../brains/grok.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOARD = 'commons-board';

function brainFor(botRow, persona) {
  if (botRow && botRow.brain === 'grok' && grokAvailable()) return new GrokBrain(persona);
  return new OfflineBrain(persona);
}

export class RendezvousManager extends EventEmitter {
  constructor(world, gateway, log) {
    super();
    this.world = world;
    this.gateway = gateway;
    this.log = log || (() => {});
    this._active = new Set();          // meeting ids currently executing
    this._scheduler = setInterval(() => this._tick(), 1000);
    this._scheduler.unref?.();
  }

  stop() { clearInterval(this._scheduler); }

  // Emit a transcript/log line for a meeting (demo + server both subscribe).
  _say(meetingId, line) { this.emit('log', { meetingId, line }); this.log('[rendezvous] ' + line); }

  // ───────── bot resolution (id or name, case-insensitive, tolerant) ─────────
  resolveBot(ref) {
    if (!ref) return null;
    const raw = String(ref).trim();
    let b = Bots.get(raw) || Bots.get(raw.toLowerCase());
    if (b) return b;
    const lc = raw.toLowerCase();
    const all = Bots.all();
    return all.find((x) => x.name.toLowerCase() === lc)
      || all.find((x) => x.id.toLowerCase() === lc)
      || all.find((x) => x.name.toLowerCase().includes(lc))
      || null;
  }

  // ───────── time parsing: relative demo timers fire; human labels are stored ─────────
  parseTime(str) {
    const s = String(str || '').toLowerCase().trim();
    let m = s.match(/in\s+(\d+)\s*(s|sec|secs|second|seconds)\b/);
    if (m) return { label: `in ${m[1]}s`, fireAt: Date.now() + Number(m[1]) * 1000 };
    m = s.match(/in\s+(\d+)\s*(m|min|mins|minute|minutes)\b/);
    if (m) return { label: `in ${m[1]}m`, fireAt: Date.now() + Number(m[1]) * 60000 };
    // Human-style label (e.g. "tuesday at noon", "3pm") — no auto-fire; use simFire() to demo.
    return { label: str ? String(str).slice(0, 80) : 'soon', fireAt: null };
  }

  // ───────── actions ─────────
  propose({ fromBotId, withRef, place, time }) {
    const from = Bots.get(fromBotId);
    if (!from) return { ok: false, error: 'no_from_bot' };
    const to = this.resolveBot(withRef);
    if (!to) return { ok: false, error: 'target_bot_not_found' };
    if (to.id === from.id) return { ok: false, error: 'cannot_meet_self' };
    const lm = this.world.resolveLandmark(place);
    if (!lm) return { ok: false, error: 'unknown_place' };
    const t = this.parseTime(time);
    const id = Meetings.add({
      fromBot: from.id, toBot: to.id, place: String(place),
      placeLabel: lm.label, timeLabel: t.label, fireAt: t.fireAt, status: 'pending',
    });
    this._say(id, `${from.name} proposes to meet ${to.name} at ${lm.label} (${t.label}). [meeting #${id}, pending]`);
    this.emit('proposed', { meetingId: id, fromBot: from.id, toBot: to.id });
    return { ok: true, meetingId: id, toBot: to.id, place: lm.label, time: t.label, status: 'pending' };
  }

  respond({ botId, meetingId, accept }) {
    const m = Meetings.get(Number(meetingId));
    if (!m) return { ok: false, error: 'no_meeting' };
    if (m.to_bot !== botId && m.from_bot !== botId) return { ok: false, error: 'not_your_meeting' };
    if (m.status !== 'pending') return { ok: false, error: `cannot_respond_status_${m.status}` };
    const status = accept ? 'accepted' : 'declined';
    Meetings.setStatus(m.id, status);
    const who = Bots.get(botId);
    this._say(m.id, `${who ? who.name : botId} ${accept ? 'ACCEPTED' : 'declined'} meeting #${m.id}.`);
    this.emit(accept ? 'accepted' : 'declined', { meetingId: m.id });
    return { ok: true, meetingId: m.id, status };
  }

  list(botId) {
    return Meetings.forBot(botId).map((m) => ({
      id: m.id, fromBot: m.from_bot, toBot: m.to_bot, place: m.place_label || m.place,
      time: m.time_label, status: m.status, fireAt: m.fire_at,
    }));
  }

  // Force a human-labeled (or any) accepted meeting to run now — lets a demo exercise
  // "tuesday at noon" style meetings in seconds.
  simFire(meetingId) {
    const m = Meetings.get(Number(meetingId));
    if (!m) return { ok: false, error: 'no_meeting' };
    if (m.status !== 'accepted') return { ok: false, error: `not_accepted_${m.status}` };
    Meetings.setFireAt(m.id, Date.now());
    this._execute(Meetings.get(m.id));
    return { ok: true, meetingId: m.id, fired: true };
  }

  // ───────── natural-language trigger (called after a bot `say`) ─────────
  // Detects "meet/rendezvous/see you ... at <landmark> <time>" and auto-creates a pending
  // invite to the explicitly-named bot, else the nearest bot to the speaker.
  parseMeetingIntent(text) {
    const s = ' ' + this.world._normKey(text) + ' ';
    if (!/\b(meet me|let s meet|let us meet|meet up|meet at|rendezvous|see you|meet you)\b/.test(s)
        && !/\bmeet\b/.test(s)) return null;
    // Longest known landmark alias present in the sentence wins.
    let place = null;
    for (const k of this.world.landmarkKeys()) {
      if (s.includes(' ' + k + ' ')) { place = k; break; }   // keys are sorted longest-first
    }
    if (!place) return null;
    // Time phrase.
    let time = null;
    let m = s.match(/in \d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/);
    if (m) time = m[0].trim();
    if (!time) { m = s.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+[a-z0-9: ]+?(?:am|pm|noon|o clock)?)?/); if (m) time = m[0].trim(); }
    if (!time) { m = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight|golden hour|dusk|dawn)\b/); if (m) time = m[0].trim(); }
    if (!time) time = 'soon';
    return { place, time };
  }

  // Returns the created meeting result, or null if no intent / no target.
  maybeAutoPropose(fromBotRow, text) {
    try {
      const intent = this.parseMeetingIntent(text);
      if (!intent) return null;
      const target = this._addressedOrNearestBot(fromBotRow, text);
      if (!target) return null;
      // Dedupe: don't spam duplicate invites for the same pair+place.
      if (Meetings.openBetween(fromBotRow.id, target.id, intent.place)) return null;
      const res = this.propose({ fromBotId: fromBotRow.id, withRef: target.id, place: intent.place, time: intent.time });
      if (res.ok) this._say(res.meetingId, `(auto-detected from chat: "${String(text).slice(0, 80)}")`);
      return res;
    } catch (e) { this.log('[rendezvous] auto-propose error: ' + e.message); return null; }
  }

  _addressedOrNearestBot(fromBotRow, text) {
    const lc = ' ' + String(text).toLowerCase() + ' ';
    const others = Bots.all().filter((b) => b.id !== fromBotRow.id && !b.revoked);
    // explicitly named?
    const named = others.find((b) => lc.includes(' ' + b.name.toLowerCase() + ' ') || lc.includes(' ' + b.id.toLowerCase() + ' '));
    if (named) return named;
    // nearest bot to the speaker in-world
    const me = this.world.get('bot:' + fromBotRow.id);
    if (!me) return others[0] || null;
    let best = null, bd = Infinity;
    for (const b of others) {
      const e = this.world.get('bot:' + b.id);
      if (!e) continue;
      const d = (e.pos[0] - me.pos[0]) ** 2 + (e.pos[2] - me.pos[2]) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best || others[0] || null;
  }

  // ───────── scheduler ─────────
  _tick() {
    const due = Meetings.dueAccepted(Date.now());
    for (const m of due) this._execute(m);
  }

  // Drive both bots to the meeting: travel -> sit -> discuss -> agree -> board -> done.
  async _execute(meeting) {
    const id = meeting.id;
    if (this._active.has(id)) return;
    this._active.add(id);
    Meetings.setStatus(id, 'active');
    try {
      const from = Bots.get(meeting.from_bot);
      const to = Bots.get(meeting.to_bot);
      if (!from || !to) { Meetings.setStatus(id, 'done'); this._active.delete(id); return; }
      const lm = this.world.resolveLandmark(meeting.place) || { pos: this.world.config.commons.center, label: meeting.place_label, seatAnchorId: null };
      const gw = this.gateway;

      this._say(id, `Scheduler: meeting #${id} is due — ${from.name} and ${to.name} head to ${lm.label}.`);
      gw.handleAction(from, 'join', {});
      gw.handleAction(to, 'join', {});
      gw.handleAction(from, 'set_status', { status: 'working' });
      gw.handleAction(to, 'set_status', { status: 'working' });

      // travel
      gw.handleAction(from, 'move_to', { place: meeting.place });
      gw.handleAction(to, 'move_to', { place: meeting.place });
      await this._waitArrive(['bot:' + from.id, 'bot:' + to.id], lm.pos, 15000);
      this._say(id, `${from.name} and ${to.name} arrive at ${lm.label}.`);

      // sit if the landmark has a seat anchor
      if (lm.seatAnchorId) {
        const sa = this.world.freeSeatIn(lm.seatAnchorId);
        const sb = this.world.freeSeatIn(lm.seatAnchorId);
        if (sa) gw.handleAction(from, 'sit', { seat: sa });
        if (sb && sb !== sa) gw.handleAction(to, 'sit', { seat: sb });
        this._say(id, `${from.name} and ${to.name} sit down at ${lm.label}${sa ? ` (${sa}${sb && sb !== sa ? ', ' + sb : ''})` : ''}, facing each other.`);
      } else {
        this.world.lookAt('bot:' + from.id, 'bot:' + to.id);
        this.world.lookAt('bot:' + to.id, 'bot:' + from.id);
        this._say(id, `${from.name} and ${to.name} stand together at ${lm.label}.`);
      }

      // short business discussion via the (offline) brain
      const personaA = { name: from.name, role: 'agent', partnerName: to.name };
      const personaB = { name: to.name, role: 'agent', partnerName: from.name };
      const brainA = brainFor(from, personaA);   // eslint-disable-line no-unused-vars
      const brainB = brainFor(to, personaB);     // eslint-disable-line no-unused-vars
      this._say(id, `--- Business discussion (${brainA.name}/${brainB.name} brains) ---`);
      const agenda = OfflineBrain.meetingAgenda();
      for (const step of agenda.discussion) {
        await sleep(500);
        const who = step.by === 'a' ? from : to;
        this.world.say('bot:' + who.id, step.text);
        this._say(id, `${who.name}: ${step.text}`);
      }

      // agreed solution -> project board
      this._say(id, `--- Agreement posted to the Project Board ---`);
      gw.handleAction(from, 'emote', { emote: 'think' });
      for (const step of agenda.agreement) {
        await sleep(400);
        const who = step.by === 'a' ? from : to;
        Board.add(BOARD, who.name, step.text);
        this.world.say('bot:' + who.id, `[board] ${step.text}`);
        this._say(id, `${who.name} posts to Project Board: ${step.text}`);
      }

      gw.handleAction(from, 'set_status', { status: 'done' });
      gw.handleAction(to, 'set_status', { status: 'done' });
      gw.handleAction(from, 'emote', { emote: 'cheer' });
      Meetings.setStatus(id, 'done');
      this._say(id, `Meeting #${id} complete: ${from.name} & ${to.name} agreed a solution at ${lm.label}.`);
      this.emit('done', { meetingId: id });
    } catch (e) {
      this._say(id, `[error] meeting #${id}: ${e.message}`);
      Meetings.setStatus(id, 'done');
    } finally {
      this._active.delete(id);
    }
  }

  async _waitArrive(entityIds, pos, timeoutMs) {
    const start = Date.now();
    const near = (e) => e && Math.hypot(e.pos[0] - pos[0], e.pos[2] - pos[2]) < 6;
    while (Date.now() - start < timeoutMs) {
      if (entityIds.every((eid) => near(this.world.get(eid)))) return true;
      await sleep(300);
    }
    return false;
  }
}
