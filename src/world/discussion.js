// discussion.js — the structured 7-phase discussion a pair of bots runs when they meet.
//
// This is a small, dependency-free state machine. It records every turn as
// { phase, who, text, at } and enforces the discussion rules the project requires:
//   • phases run strictly IN ORDER (INTRODUCTION → … → REPORTS);
//   • a phase needs at least 2 turns (one per bot) before it can advance;
//   • a phase advances when BOTH bots have spoken AND the last turn is an agreement
//     ("agreed" / "let's move on"), or once 4 turns have happened in that phase;
//   • no bot ever speaks twice in a row (enforced across the WHOLE transcript).
//
// It does NOT generate any dialogue itself (see brains/offline.js for the offline
// simulation) and it never touches private owner fields — callers are responsible for
// only ever passing public, shareable text in. A defensive guard still rejects any
// line that contains a registered private secret, so a bug upstream cannot leak one.

// The seven phases, in strict order. `id` is stable (used by reports + tests); `title`
// is the human label; `blurb` is short guidance surfaced to the bots.
export const PHASES = [
  { id: 'INTRODUCTION',    title: 'Introduction',
    blurb: 'Name yourself, say who your owner is and their role, and what you can do.' },
  { id: 'MY_GOALS',        title: 'My goals',
    blurb: "State your owner's public goals for this meeting — nothing private." },
  { id: 'YOUR_GOALS',      title: 'Your goals',
    blurb: "Restate the other bot's goals in your own words and ask \u201cDid I get that right?\u201d" },
  { id: 'PRIORITIES',      title: 'Priorities',
    blurb: 'Rank all goals into one shared list (must / should / nice); note overlaps and conflicts.' },
  { id: 'RESEARCH',        title: 'Research',
    blurb: 'Split the open questions and report findings with sources — or say \u201cNot requested.\u201d' },
  { id: 'HOW_WE_GET_THERE', title: 'How we get there',
    blurb: 'Offer 2\u20133 options, weigh trade-offs against the shared priorities, converge on one plan.' },
  { id: 'REPORTS',         title: 'Reports',
    blurb: 'Summarize the agreement back to the other bot for a final check, then write your owner report.' },
];

export const PHASE_IDS = PHASES.map((p) => p.id);

const MIN_TURNS_PER_PHASE = 2;   // one per bot before a phase may advance
const MAX_TURNS_PER_PHASE = 4;   // hard cap — advance no matter what after this many

// Does a line read as an agreement to move on?
const AGREE_RE = /\bagreed\b|\blet'?s move on\b|\bmove on\b|\bsounds good\b|\bthat works\b/i;
export function isAgreement(text) { return AGREE_RE.test(String(text || '')); }

export class Discussion {
  // opts.onRecord(turn)  — optional callback fired for every recorded turn (live view / persistence).
  // opts.secrets         — optional array of private strings that must never appear in a line.
  constructor(opts = {}) {
    this.turns = [];            // [{ phase, who, text, at }]
    this.phaseIndex = 0;
    this.lastWho = null;        // last speaker across the WHOLE transcript (strict alternation)
    this.onRecord = typeof opts.onRecord === 'function' ? opts.onRecord : null;
    this.secrets = Array.isArray(opts.secrets)
      ? opts.secrets.map((s) => String(s || '').trim()).filter((s) => s.length >= 2)
      : [];
  }

  get complete() { return this.phaseIndex >= PHASES.length; }
  get currentPhase() { return this.complete ? null : PHASES[this.phaseIndex].id; }

  turnsIn(phaseId) { return this.turns.filter((t) => t.phase === phaseId); }
  bothSpokeIn(phaseId) {
    const tp = this.turnsIn(phaseId);
    return tp.some((t) => t.who === 'A') && tp.some((t) => t.who === 'B');
  }

  // Record one turn. `who` is 'A' or 'B'; `text` is public, shareable text.
  // Throws on a rule violation so bugs surface loudly rather than corrupting the record.
  record(who, text) {
    if (this.complete) throw new Error('discussion already complete — no phases left');
    if (who !== 'A' && who !== 'B') throw new Error('turn.who must be "A" or "B"');
    if (who === this.lastWho) throw new Error('a bot may not speak twice in a row');
    const clean = String(text == null ? '' : text);
    for (const s of this.secrets) {
      if (s && clean.includes(s)) throw new Error('refusing to record a line containing a private owner secret');
    }
    const turn = { phase: this.currentPhase, who, text: clean, at: new Date().toISOString() };
    this.turns.push(turn);
    this.lastWho = who;
    if (this.onRecord) this.onRecord(turn);
    this._maybeAdvance();
    return turn;
  }

  _maybeAdvance() {
    const phaseId = PHASES[this.phaseIndex].id;
    const tp = this.turnsIn(phaseId);
    if (tp.length < MIN_TURNS_PER_PHASE) return false;
    if (!this.bothSpokeIn(phaseId)) return false;
    const lastAgreed = isAgreement(tp[tp.length - 1].text);
    if (lastAgreed || tp.length >= MAX_TURNS_PER_PHASE) {
      this.phaseIndex += 1;      // advance; lastWho is NOT reset, keeping global alternation
      return true;
    }
    return false;
  }

  // Validation helpers (also used by tests).
  phasesInOrder() {
    // The sequence of distinct phases as they appear must be a prefix of PHASE_IDS, in order.
    const seen = [];
    for (const t of this.turns) if (seen[seen.length - 1] !== t.phase) seen.push(t.phase);
    for (let i = 0; i < seen.length; i++) if (seen[i] !== PHASE_IDS[i]) return false;
    return true;
  }
  noDoubleTurns() {
    for (let i = 1; i < this.turns.length; i++) if (this.turns[i].who === this.turns[i - 1].who) return false;
    return true;
  }
  everyPhaseHasBothBots() {
    for (const id of PHASE_IDS) {
      const tp = this.turnsIn(id);
      if (!tp.length) return false;
      if (!(tp.some((t) => t.who === 'A') && tp.some((t) => t.who === 'B'))) return false;
    }
    return true;
  }
}

export default { Discussion, PHASES, PHASE_IDS, isAgreement };
