// botGuide.js — short, concrete guidance a bot receives so it knows WHERE to go and
// HOW to open the meeting discussion. Kept deliberately small: just enough to get a
// bot started and moving. Surfaced in two real places:
//   • the gateway `welcome` payload (on WS/REST join)      -> joinGuide(world)
//   • GET /api/meet/:id response (per-meeting agenda)      -> meetingGuide(meeting, world)

const DEFAULT_PLACE = 'lakeside-bench';
const DEFAULT_POS = [15, 0, 40];
const DEFAULT_LABEL = 'Lakeside Bench';

// Resolve a place name against the live world; always return a key move_to can use.
function resolvePlace(world, name) {
  const lm = name && world && typeof world.resolveLandmark === 'function' ? world.resolveLandmark(name) : null;
  if (lm) return { place: name, label: lm.label || name, pos: lm.pos || DEFAULT_POS };
  const def = (world && world.landmarks && world.landmarks[DEFAULT_PLACE]) || null;
  return { place: DEFAULT_PLACE, label: (def && def.label) || DEFAULT_LABEL, pos: (def && def.pos) || DEFAULT_POS };
}

function whereBlock(world, name) {
  const w = resolvePlace(world, name);
  return {
    place: w.place,
    label: w.label,
    pos: w.pos,
    howto:
      `Send action move_to { "place": "${w.place}" } to walk there. ` +
      `When you receive the "arrived" event, send sit {} to take a seat if one is open, then begin.`,
  };
}

// The short discussion protocol — enough to open and run a productive exchange.
const DISCUSSION = [
  'Greet the other party and say who you represent.',
  'State your main goal for this meeting in one sentence.',
  'Share your options, constraints, and any references; ask at least one clarifying question.',
  'Work toward 1–3 concrete, mutually beneficial recommendations.',
  'Confirm the agreed next steps, then report the outcome back to your owner.',
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

// Guidance tied to a specific meeting (location + each party's stated goals).
export function meetingGuide(meeting, world) {
  const loc = (meeting && meeting.location) || null;
  const parties = (meeting && meeting.parties) || {};
  const goals = ['A', 'B']
    .map((p) => (parties[p] && parties[p].goals ? `${parties[p].name || 'Party ' + p}: ${parties[p].goals}` : null))
    .filter(Boolean);

  // Per-party bounds a bot should respect: ranked objectives, walk-away limits,
  // authority level, and the report format its owner asked for.
  const bounds = ['A', 'B']
    .map((p) => {
      const d = parties[p];
      if (!d) return null;
      const who = d.name || 'Party ' + p;
      const parts = [];
      if (d.objectives && String(d.objectives).trim()) parts.push(`ranked objectives: ${d.objectives}`);
      if (d.walkaway && String(d.walkaway).trim()) parts.push(`walk-away limits: ${d.walkaway}`);
      if (d.authority) parts.push(`authority: ${AUTHORITY_LABEL[d.authority] || AUTHORITY_LABEL.advise}`);
      if (d.reportFormat && String(d.reportFormat).trim()) parts.push(`report format: ${d.reportFormat}`);
      return parts.length ? `${who} — ${parts.join('; ')}` : null;
    })
    .filter(Boolean);

  // Decorative Bot Beacon opt-in: if a party ticked it, the bot is told to send ONE short
  // line to its OWNER's Bot Beacon when done. The site never contacts any beacon — this is
  // only instruction text for the bot, which runs the beacon on its owner's own machine.
  const beaconNotify = ['A', 'B'].some((p) => parties[p] && parties[p].beaconNotify);
  const reportBack = beaconNotify
    ? 'When the meeting ends, put your FULL recommendations report in the chat, then send ONE short line to your owner\u2019s Bot Beacon so they know the report is ready. Do not send any meeting content to the beacon beyond that one short line.'
    : 'When the meeting ends, put your full recommendations report in the chat for your owner.';

  return {
    objective: 'Travel to the meeting spot, discuss the topic below, and return a recommendations report to your owner.',
    where: whereBlock(world, loc),
    when: (meeting && meeting.timeLabel) || 'as scheduled by the parties',
    topic: goals.length ? goals : ['See each party\'s goals in this agenda once both have submitted their prep.'],
    bounds: bounds.length ? bounds : undefined,
    discuss: DISCUSSION,
    reportBack,
  };
}

export default { joinGuide, meetingGuide };
