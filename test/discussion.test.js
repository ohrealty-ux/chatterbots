// Tests for the structured seven-phase discussion, recording, and owner report (item C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Discussion, PHASE_IDS, PHASES } from '../src/world/discussion.js';
import { buildOwnerReport, REQUIRED_SECTIONS } from '../src/world/ownerReport.js';
import { OfflineBrain } from '../src/brains/offline.js';

// A meeting with PRIVATE limits present, so we can prove they never leak.
function demoMeeting() {
  return {
    location: 'Prestigious business office',
    parties: {
      A: { name: 'Ada', goals: 'cut lead time via a supplier partnership', authority: 'negotiate', research: true,
           walkaway: 'no commitment over SECRET_WA_A',
           money: { dealType: 'buy_sell', unit: 'total', amountAnchor: 1000, amountIdeal: 1200,
                    amountWalkaway: 1500, askAbove: 1400, trades: ['scope'], reveal: 'opening' } },
      B: { name: 'Bo', goals: 'a steady contract at a sustainable margin', authority: 'commit', research: true,
           walkaway: 'cannot go below SECRET_WA_B',
           money: { dealType: 'buy_sell', unit: 'total', amountAnchor: 1800, amountIdeal: 1600,
                    amountWalkaway: 1550, askAbove: 1580, trades: ['speed'], reveal: 'nothing' } },
    },
  };
}

test('state machine: enforces strict alternation', () => {
  const d = new Discussion();
  d.record('A', 'hello');
  assert.throws(() => d.record('A', 'again'), /twice in a row/);
});

test('state machine: advances on agreement after both speak', () => {
  const d = new Discussion();
  assert.equal(d.currentPhase, 'INTRODUCTION');
  d.record('A', 'intro from A');
  assert.equal(d.currentPhase, 'INTRODUCTION'); // only one bot so far
  d.record('B', 'intro from B — agreed');
  assert.equal(d.currentPhase, 'MY_GOALS');     // advanced
});

test('state machine: advances after 4 turns without agreement', () => {
  const d = new Discussion();
  d.record('A', 'a1'); d.record('B', 'b1'); d.record('A', 'a2'); d.record('B', 'b2');
  assert.equal(d.currentPhase, 'MY_GOALS');
});

test('state machine: refuses to record a private secret', () => {
  const d = new Discussion({ secrets: ['1500', 'SECRET_WA_A'] });
  assert.throws(() => d.record('A', 'my walk-away is 1500'), /private owner secret/);
});

test('simulation: phases occur in order', () => {
  const { discussion } = OfflineBrain.simulateDiscussion(demoMeeting());
  assert.ok(discussion.phasesInOrder());
  // the distinct phase sequence equals the canonical order
  const seen = [];
  for (const t of discussion.turns) if (seen[seen.length - 1] !== t.phase) seen.push(t.phase);
  assert.deepEqual(seen, PHASE_IDS);
});

test('simulation: no bot speaks twice in a row', () => {
  const { discussion } = OfflineBrain.simulateDiscussion(demoMeeting());
  assert.ok(discussion.noDoubleTurns());
});

test('simulation: each phase has turns from both bots', () => {
  const { discussion } = OfflineBrain.simulateDiscussion(demoMeeting());
  assert.ok(discussion.everyPhaseHasBothBots());
  for (const ph of PHASES) {
    const tp = discussion.turnsIn(ph.id);
    assert.ok(tp.length >= 2, `phase ${ph.id} has >=2 turns`);
  }
});

test('simulation: transcript is non-empty and recorded', () => {
  const rec = [];
  const { transcript } = OfflineBrain.simulateDiscussion(demoMeeting(), { onRecord: (t) => rec.push(t) });
  assert.ok(transcript.length > 0);
  assert.equal(rec.length, transcript.length);
  for (const t of transcript) {
    assert.ok(t.phase && t.who && typeof t.text === 'string' && t.at);
  }
});

test('report: contains every required section', () => {
  const { reports } = OfflineBrain.simulateDiscussion(demoMeeting());
  for (const side of ['A', 'B']) {
    for (const sec of REQUIRED_SECTIONS) {
      assert.ok(reports[side].includes(sec), `report ${side} has section "${sec}"`);
    }
  }
});

test('report: refuses an empty transcript', () => {
  assert.throws(() => buildOwnerReport(demoMeeting(), { turns: [] }, 'A'), /empty transcript/);
});

test('privacy: walk-away and ask-above never appear in the shared transcript or the other report', () => {
  const { discussion, reports } = OfflineBrain.simulateDiscussion(demoMeeting());
  const shared = discussion.turns.map((t) => t.text).join('\n');
  for (const secret of ['SECRET_WA_A', 'SECRET_WA_B', '1500', '1400', '1550', '1580']) {
    assert.ok(!shared.includes(secret), `transcript must not contain ${secret}`);
    assert.ok(!reports.A.includes(secret), `report A must not contain ${secret}`);
    assert.ok(!reports.B.includes(secret), `report B must not contain ${secret}`);
  }
  // B revealed 'nothing' → B's opening/ideal must not show in A's report.
  assert.ok(!reports.A.includes('1800'), 'A report must not show B opening (reveal=nothing)');
  assert.ok(!reports.A.includes('1600'), 'A report must not show B ideal (reveal=nothing)');
  // A revealed 'opening' → A opening may show in B's report, but NOT A's ideal.
  assert.ok(!reports.B.includes('1200'), 'B report must not show A ideal (reveal=opening)');
});
