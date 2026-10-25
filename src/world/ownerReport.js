// ownerReport.js — turns a completed Discussion (+ the meeting prep) into the full
// markdown report a bot sends back to its OWNER through `reportBack`.
//
// Privacy rules (hard):
//   • A party's walk-away number (amountWalkaway) and owner-approval threshold (askAbove)
//     are PRIVATE LIMITS — they NEVER appear in any report, not even the owner's own.
//   • The OTHER party's money amounts appear only to the extent that party chose to reveal
//     them (reveal = 'nothing' | 'opening' | 'both').
//   • The transcript must be non-empty — we refuse to emit a report without one.

import { PHASES, PHASE_IDS } from './discussion.js';

const PRIVATE_MONEY_KEYS = ['amountWalkaway', 'askAbove'];

function nameOf(parties, who) {
  const d = parties && parties[who];
  return (d && d.name && String(d.name).trim()) || (who === 'A' ? 'Bot A' : 'Bot B');
}

function fmtAmount(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;
}

// Build the money lines for ONE party.
//   isOwner=true  → the report's owner: show their own non-private terms (never the private limits).
//   isOwner=false → the other party: show amounts only as their `reveal` setting allows.
function moneyLines(label, money, isOwner) {
  if (!money || typeof money !== 'object') return [];
  const out = [];
  if (money.dealType) out.push(`- ${label} deal type: ${money.dealType}`);
  if (money.unit) out.push(`- ${label} unit: ${money.unit}`);
  if (money.paymentStyle) out.push(`- ${label} payment style: ${money.paymentStyle}`);
  if (Array.isArray(money.trades) && money.trades.length) out.push(`- ${label} trade levers offered: ${money.trades.join(', ')}`);

  const reveal = money.reveal || (isOwner ? 'both' : 'nothing');
  const opening = fmtAmount(money.amountAnchor);
  const ideal = fmtAmount(money.amountIdeal);
  const showOpening = isOwner || reveal === 'opening' || reveal === 'both';
  const showIdeal = isOwner || reveal === 'both';
  if (showOpening && opening != null) out.push(`- ${label} opening offer: ${opening}`);
  if (showIdeal && ideal != null) out.push(`- ${label} ideal: ${ideal}`);
  if (!isOwner && reveal === 'nothing') out.push(`- ${label} chose not to reveal specific numbers.`);
  // PRIVATE_MONEY_KEYS are intentionally never emitted here.
  return out;
}

function stripPrivate(money) {
  if (!money || typeof money !== 'object') return money;
  const copy = { ...money };
  for (const k of PRIVATE_MONEY_KEYS) delete copy[k];
  return copy;
}

// Group transcript turns under the seven phase headings, "Name: text".
function transcriptSection(turns, parties) {
  const lines = [];
  for (const ph of PHASES) {
    lines.push(`### ${ph.title}`);
    const tp = turns.filter((t) => t.phase === ph.id);
    if (!tp.length) { lines.push('_No turns recorded in this phase._'); lines.push(''); continue; }
    for (const t of tp) lines.push(`- **${nameOf(parties, t.who)}:** ${t.text}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Pull the agreed-priorities narrative straight from the PRIORITIES phase, plus any structured
// list the caller supplies. Always returns at least a placeholder so the section is never empty.
function prioritiesSection(turns, parties, explicit) {
  const lines = [];
  if (Array.isArray(explicit) && explicit.length) {
    for (const p of explicit) {
      if (typeof p === 'string') lines.push(`- ${p}`);
      else if (p && p.item) lines.push(`- (${p.level || 'should'}) ${p.item}`);
    }
  }
  const tp = turns.filter((t) => t.phase === 'PRIORITIES');
  for (const t of tp) lines.push(`- **${nameOf(parties, t.who)}:** ${t.text}`);
  return lines.length ? lines.join('\n') : '_No priorities were agreed._';
}

function researchSection(turns, parties, research) {
  // research: { requested: bool, findings: [{ who, text, source }] }
  if (!research || research.requested === false) return 'Not requested.';
  const findings = Array.isArray(research.findings) ? research.findings : [];
  if (!findings.length) {
    // Fall back to the RESEARCH phase transcript.
    const tp = turns.filter((t) => t.phase === 'RESEARCH');
    if (!tp.length) return 'Not requested.';
    return tp.map((t) => `- **${nameOf(parties, t.who)}:** ${t.text}`).join('\n');
  }
  return findings.map((f) => {
    const who = f.who ? `**${nameOf(parties, f.who)}:** ` : '';
    const src = f.source ? ` _(source: ${f.source})_` : '';
    return `- ${who}${f.text}${src}`;
  }).join('\n');
}

function planSection(turns, parties, chosenPlan, options) {
  const lines = [];
  if (Array.isArray(options) && options.length) {
    lines.push('**Options considered:**');
    options.forEach((o, i) => lines.push(`- Option ${i + 1}: ${typeof o === 'string' ? o : (o.label || JSON.stringify(o))}`));
  }
  const tp = turns.filter((t) => t.phase === 'HOW_WE_GET_THERE');
  if (tp.length) {
    lines.push('');
    lines.push('**Discussion:**');
    for (const t of tp) lines.push(`- **${nameOf(parties, t.who)}:** ${t.text}`);
  }
  if (chosenPlan) { lines.push(''); lines.push(`**Chosen plan:** ${chosenPlan}`); }
  return lines.length ? lines.join('\n') : '_No plan was recorded._';
}

function nextStepsSection(nextSteps) {
  if (!Array.isArray(nextSteps) || !nextSteps.length) return '_No next steps were recorded._';
  return nextSteps.map((s) => {
    if (typeof s === 'string') return `- ${s}`;
    const who = s.who ? `**${s.who}** ` : '';
    const what = s.what || '';
    const when = s.when ? ` — _by ${s.when}_` : '';
    return `- ${who}${what}${when}`;
  }).join('\n');
}

function openQuestionsSection(open) {
  if (!Array.isArray(open) || !open.length) return '_None outstanding._';
  return open.map((q) => `- ${typeof q === 'string' ? q : (q.text || JSON.stringify(q))}`).join('\n');
}

// Build the full markdown owner report.
//   meeting   : { parties: {A,B}, location, title? }
//   discussion: a Discussion instance (or { turns: [...] })
//   forParty  : 'A' | 'B' — whose owner this report is for
//   opts      : { research, priorities, options, chosenPlan, nextSteps, openQuestions, executiveSummary }
export function buildOwnerReport(meeting, discussion, forParty, opts = {}) {
  const turns = (discussion && Array.isArray(discussion.turns)) ? discussion.turns : [];
  if (!turns.length) throw new Error('refusing to build an owner report with an empty transcript');
  if (forParty !== 'A' && forParty !== 'B') throw new Error('forParty must be "A" or "B"');

  const parties = (meeting && meeting.parties) || {};
  const other = forParty === 'A' ? 'B' : 'A';
  const myName = nameOf(parties, forParty);
  const otherName = nameOf(parties, other);
  const myData = parties[forParty] || {};
  const otherData = parties[other] || {};

  const title = (meeting && meeting.title)
    ? String(meeting.title)
    : `Meeting report for ${myName} — with ${otherName}`;

  const execSummary = opts.executiveSummary ||
    `${myName} met ${otherName}${meeting && meeting.location ? ' at the ' + meeting.location : ''} and ran the full ` +
    `seven-phase discussion (introductions, goals, priorities, research, plan, and a final report check). ` +
    `Below is the complete transcript, the goals on both sides, the agreed priorities and plan, next steps, ` +
    `and a money summary. Private limits are intentionally omitted.`;

  const goals = [
    `**My owner's goals (${myName}):** ${myData.goals ? String(myData.goals) : '_not stated_'}`,
    `**Their goals (${otherName}):** ${otherData.goals ? String(otherData.goals) : '_not stated_'}`,
  ].join('\n\n');

  // Money summary — never includes private limits; other party gated by their reveal setting.
  const moneyBlock = [];
  moneyBlock.push(...moneyLines(`${myName} (mine)`, stripPrivate(myData.money), true));
  moneyBlock.push(...moneyLines(`${otherName} (theirs)`, otherData.money, false));
  const moneySummary = moneyBlock.length
    ? moneyBlock.join('\n') + '\n\n_Private walk-away and owner-approval limits are omitted by policy._'
    : '_No money terms were brought to this meeting._';

  const sections = [
    `# ${title}`,
    ``,
    `_Advise only — not financial or legal advice._`,
    ``,
    `## Executive summary`,
    execSummary,
    ``,
    `## Full transcript`,
    transcriptSection(turns, parties),
    ``,
    `## Goals`,
    goals,
    ``,
    `## Agreed priorities`,
    prioritiesSection(turns, parties, opts.priorities),
    ``,
    `## Research findings`,
    researchSection(turns, parties, opts.research),
    ``,
    `## Chosen plan & options considered`,
    planSection(turns, parties, opts.chosenPlan, opts.options),
    ``,
    `## Next steps`,
    nextStepsSection(opts.nextSteps),
    ``,
    `## Money summary`,
    moneySummary,
    ``,
    `## Open questions`,
    openQuestionsSection(opts.openQuestions),
    ``,
  ];
  return sections.join('\n');
}

// The section headings every complete report must contain (used by tests).
export const REQUIRED_SECTIONS = [
  'Executive summary',
  'Full transcript',
  'Goals',
  'Agreed priorities',
  'Research findings',
  'Chosen plan & options considered',
  'Next steps',
  'Money summary',
  'Open questions',
];

export default { buildOwnerReport, REQUIRED_SECTIONS };
