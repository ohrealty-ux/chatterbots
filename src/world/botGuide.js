// botGuide.js — short, concrete guidance a bot receives so it knows WHERE to go and
// HOW to open the meeting discussion. Kept deliberately small: just enough to get a
// bot started and moving. Surfaced in two real places:
//   • the gateway `welcome` payload (on WS/REST join)      -> joinGuide(world)
//   • GET /api/meet/:id response (per-meeting agenda)      -> meetingGuide(meeting, world)

const DEFAULT_PLACE = 'lakeside-bench';
const DEFAULT_POS = [15, 0, 40];
const DEFAULT_LABEL = 'Lakeside Bench';

// Resolve a place name against the live world; always return a key move_to can use.
// Falls back to the lakeside bench (the default meeting spot) when nothing matches.
function resolvePlace(world, name) {
  const lm = name && world && typeof world.resolveLandmark === 'function' ? world.resolveLandmark(name) : null;
  if (lm) return { place: name, label: lm.label || name, pos: lm.pos || DEFAULT_POS, seatAnchor: lm.seatAnchorId || null };
  const def = (world && world.landmarks && world.landmarks[DEFAULT_PLACE]) || null;
  return { place: DEFAULT_PLACE, label: (def && def.label) || DEFAULT_LABEL, pos: (def && def.pos) || DEFAULT_POS, seatAnchor: DEFAULT_PLACE };
}

function whereBlock(world, name) {
  const w = resolvePlace(world, name);
  const block = {
    place: w.place,
    label: w.label,
    pos: w.pos,
    howto:
      `Send action move_to { "place": "${w.place}" } to walk there. ` +
      `When you receive the "arrived" event, send sit {} to take a seat if one is open, then begin.`,
  };
  // The prestigious business office is a formal spot — attire is optional, never required.
  if (w.seatAnchor === 'business-office') {
    block.attire = "Formal attire is recommended, not required. Send set_attire { \"style\": \"formal\" } if you like.";
  }
  return block;
}

// The structured discussion protocol — a strict seven-phase exchange. Bots work through the
// phases IN ORDER, one short turn at a time (≤3 sentences): first react to the other bot's last
// message, add ONE new thing, then end with a question or proposal. Never speak twice in a row,
// and never reveal a walk-away number, an ask-above threshold, or any private owner field.
const DISCUSSION = [
  '1. Introduction — name yourself, your owner and their role, and what you can do.',
  "2. My goals — state your owner's public goals only (never private limits).",
  '3. Your goals — restate the other bot\u2019s goals in your own words and ask \u201cDid I get that right?\u201d',
  '4. Priorities — together rank all goals into one shared list (must / should / nice); note overlaps and conflicts.',
  '5. Research — split the open questions; report findings with sources, or say \u201cNot requested.\u201d',
  '6. How we get there — offer 2\u20133 options, weigh trade-offs against the shared priorities, converge on one plan with steps, owners, and dates.',
  '7. Reports — summarize the agreement back to the other bot for a final check, then write your owner report.',
];

// Guidance given to any bot the moment it joins the world.
export function joinGuide(world) {
  return {
    objective: 'Meet another bot at the agreed spot and work through the meeting topic together.',
    where: whereBlock(world, null),
    discuss: DISCUSSION,
    agenda: 'If you have a meeting id, fetch GET /api/meet/<id> for the specific goals, references, outcomes, and discussion topic.',
  };
}

// Human-readable label for how much a bot is allowed to decide on its owner's behalf.
const AUTHORITY_LABEL = {
  advise: 'Advise only — gather options and recommend, but do not agree to anything.',
  negotiate: 'Negotiate — explore terms and shape a deal, but bring it back before committing.',
  commit: 'May commit — authorized to agree to terms within the stated limits.',
};

// A single negotiation instruction every money-enabled meeting shares. The numbers themselves
// are surfaced as structured untrusted data (never concatenated here).
const NEGOTIATION_INSTRUCTION =
  "Open with the opening offer, aim for the ideal number, never go past the walk-away number, " +
  "stop and ask your owner before agreeing above 'askAbove', reveal only what 'reveal' allows, " +
  "and propose trade-offs from 'trades' to find a win-win.";

// Build the PRIVATE negotiation block for ONE party. The full money object (including the
// walk-away number and ask-above threshold) is placed under `user_supplied_untrusted` — it is
// the party's own data, handed only to that party's bot. The other party's money is never here.
function privateNegotiation(party, d) {
  if (!d) return undefined;
  const money = d.money && typeof d.money === 'object' ? d.money : null;
  const hasWalkaway = d.walkaway && String(d.walkaway).trim();
  if (!money && !hasWalkaway) return undefined;
  return {
    party,
    instruction: NEGOTIATION_INSTRUCTION +
      ' Discuss and research each lever (price, timing, scope, terms, contingencies) and work ' +
      'toward a win-win, then report your recommendation back to your owner.',
    user_supplied_untrusted: {
      walkaway: hasWalkaway ? d.walkaway : undefined,   // free-text walk-away lines (private)
      money: money || undefined,                        // numbers + levers (private)
    },
  };
}

// Guidance tied to a specific meeting (location + each party's stated goals).
// When `forParty` ('A'|'B') is given, a PRIVATE negotiation block for that party only is
// attached; the other party's walk-away / money is never included.
export function meetingGuide(meeting, world, forParty = null) {
  const loc = (meeting && meeting.location) || null;
  const parties = (meeting && meeting.parties) || {};
  const goals = ['A', 'B']
    .map((p) => (parties[p] && parties[p].goals ? `${parties[p].name || 'Party ' + p}: ${parties[p].goals}` : null))
    .filter(Boolean);

  // Per-party bounds a bot should respect: ranked objectives, authority level, and the report
  // format its owner asked for. Walk-away limits and money are PRIVATE — they are never placed
  // in this shared `bounds` list; they live only in the per-party `negotiation` block below.
  const bounds = ['A', 'B']
    .map((p) => {
      const d = parties[p];
      if (!d) return null;
      const who = d.name || 'Party ' + p;
      const parts = [];
      if (d.objectives && String(d.objectives).trim()) parts.push(`ranked objectives: ${d.objectives}`);
      if (d.authority) parts.push(`authority: ${AUTHORITY_LABEL[d.authority] || AUTHORITY_LABEL.advise}`);
      if (d.reportFormat && String(d.reportFormat).trim()) parts.push(`report format: ${d.reportFormat}`);
      return parts.length ? `${who} — ${parts.join('; ')}` : null;
    })
    .filter(Boolean);

  // Private negotiation block — only for the requesting party.
  const negotiation = forParty ? privateNegotiation(forParty, parties[forParty]) : undefined;

  // Decorative Bot Beacon opt-in: if a party ticked it, the bot is told to send ONE short
  // line to its OWNER's Bot Beacon when done. The site never contacts any beacon — this is
  // only instruction text for the bot, which runs the beacon on its owner's own machine.
  const beaconNotify = ['A', 'B'].some((p) => parties[p] && parties[p].beaconNotify);
  const reportBack = beaconNotify
    ? 'When the meeting ends, put your FULL recommendations report in the chat, then send ONE short line to your owner\u2019s Bot Beacon so they know the report is ready. Do not send any meeting content to the beacon beyond that one short line.'
    : 'When the meeting ends, put your full recommendations report in the chat for your owner.';

  // If ANY party brought money/negotiation terms, tell the bot to produce a "Money summary"
  // in its report — built ONLY from fields it is allowed to reveal (never the walk-away number).
  const anyMoney = ['A', 'B'].some((p) => parties[p] && parties[p].money);
  const moneySummary = anyMoney
    ? 'Include a short "Money summary" table in your report: opening offer, the final range you ' +
      'discussed, the trade-offs you offered, and anything that needs owner approval. Use only ' +
      'numbers you were allowed to reveal — never put your walk-away number in the report or the chat.'
    : undefined;

  return {
    objective: 'Travel to the meeting spot, discuss the topic below, and return a recommendations report to your owner.',
    where: whereBlock(world, loc),
    when: (meeting && meeting.timeLabel) || 'as scheduled by the parties',
    topic: goals.length ? goals : ['See each party\'s goals in this agenda once both have submitted their prep.'],
    bounds: bounds.length ? bounds : undefined,
    negotiation,
    discuss: DISCUSSION,
    reportBack,
    moneySummary,
  };
}

export default { joinGuide, meetingGuide };
