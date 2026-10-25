// Headless offline discussion simulation (no server, no API key).
// Runs two bots through the full seven-phase discussion, records the transcript, and writes
// each side's full owner report to data/transcripts/. Proves C end to end.
//   Run:  node scripts/discussion-sim.js   (or: npm run demo:discussion)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineBrain } from '../src/brains/offline.js';
import { PHASE_IDS } from '../src/world/discussion.js';
import { REQUIRED_SECTIONS } from '../src/world/ownerReport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TRANSCRIPT_DIR = path.join(ROOT, 'data', 'transcripts');

// A realistic meeting prep for two parties. Private limits (walkaway / askAbove) are included
// precisely so we can prove they NEVER leak into any message or report.
const meeting = {
  location: 'Prestigious business office',
  parties: {
    A: {
      name: 'Ada — Ada\u2019s Agent', goals: 'secure a supplier partnership that cuts lead time',
      authority: 'negotiate', research: true,
      walkaway: 'no commitment over the SECRET_WALKAWAY_A line; keep our data private',
      money: { dealType: 'buy_sell', unit: 'total', amountAnchor: 1000, amountIdeal: 1200,
               amountWalkaway: 1500, askAbove: 1400, trades: ['scope', 'term'], reveal: 'opening' },
    },
    B: {
      name: 'Bo — Bo\u2019s Bot', goals: 'win a steady contract at a sustainable margin',
      authority: 'commit', research: true,
      walkaway: 'cannot go below SECRET_WALKAWAY_B per unit',
      money: { dealType: 'buy_sell', unit: 'total', amountAnchor: 1800, amountIdeal: 1600,
               amountWalkaway: 1550, askAbove: 1580, trades: ['speed', 'timing'], reveal: 'nothing' },
    },
  },
};

const live = [];
const { discussion, transcript, reports } = OfflineBrain.simulateDiscussion(meeting, {
  onRecord: (t) => { const line = `[${t.phase}] ${t.who}: ${t.text}`; live.push(line); console.log(line); },
});

fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// Persist the raw transcript + both reports.
fs.writeFileSync(path.join(TRANSCRIPT_DIR, `discussion-${stamp}.json`), JSON.stringify({ transcript }, null, 2));
fs.writeFileSync(path.join(TRANSCRIPT_DIR, `discussion-${stamp}-report-A.md`), reports.A);
fs.writeFileSync(path.join(TRANSCRIPT_DIR, `discussion-${stamp}-report-B.md`), reports.B);

// --- self-checks ---
const problems = [];
if (!transcript.length) problems.push('transcript is empty');
if (!discussion.phasesInOrder()) problems.push('phases out of order');
if (!discussion.noDoubleTurns()) problems.push('a bot spoke twice in a row');
if (!discussion.everyPhaseHasBothBots()) problems.push('a phase is missing one of the bots');
for (const id of PHASE_IDS) if (!transcript.some((t) => t.phase === id)) problems.push('missing phase ' + id);
for (const side of ['A', 'B']) {
  for (const sec of REQUIRED_SECTIONS) if (!reports[side].includes(sec)) problems.push(`report ${side} missing section "${sec}"`);
}
// No private secret may appear in the shared transcript or EITHER report.
const sharedText = transcript.map((t) => t.text).join('\n');
for (const secret of ['SECRET_WALKAWAY_A', 'SECRET_WALKAWAY_B', '1500', '1400', '1550', '1580']) {
  if (sharedText.includes(secret)) problems.push(`private value "${secret}" leaked into transcript`);
  if (reports.A.includes(secret) || reports.B.includes(secret)) problems.push(`private value "${secret}" leaked into a report`);
}

console.log(`\nTurns: ${transcript.length} across ${PHASE_IDS.length} phases.`);
console.log(`Report A length: ${reports.A.length} chars; Report B length: ${reports.B.length} chars.`);
console.log('Saved to:', TRANSCRIPT_DIR);
if (problems.length) { console.error('\nFAIL:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log('\nPASS — full discussion ran, transcript non-empty, both reports complete, no private leaks.');
