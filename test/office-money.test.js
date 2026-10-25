// Section 4e — regression tests for the office location, attire, money validation, and the
// strict privacy of each party's walk-away number. Run with: node --test "test/**/*.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { World } from '../src/world/world.js';
import { validate, schemas } from '../src/security/validate.js';
import { meetingGuide } from '../src/world/botGuide.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'world.config.json'), 'utf8'));

function freshWorld() {
  const w = new World(config);
  w.stop();           // we drive it by hand in tests; no background tick needed
  return w;
}

test('office landmark + aliases all resolve to the business office', () => {
  const w = freshWorld();
  const names = ['the office', 'office', 'prestigious office', 'the prestigious business office', 'boardroom', 'business-office', 'business office'];
  for (const n of names) {
    const lm = w.resolveLandmark(n);
    assert.ok(lm, `"${n}" should resolve`);
    assert.equal(lm.seatAnchorId, 'business-office', `"${n}" should map to the business-office anchor`);
  }
});

test('both office seats can be taken, and a third sitter is refused', () => {
  const w = freshWorld();
  w.spawn({ id: 'a', name: 'A', kind: 'bot' });
  w.spawn({ id: 'b', name: 'B', kind: 'bot' });
  w.spawn({ id: 'c', name: 'C', kind: 'bot' });
  const r1 = w.sit('a', 'bo-1');
  const r2 = w.sit('b', 'bo-2');
  assert.equal(r1.ok, true, 'bo-1 should be takeable');
  assert.equal(r2.ok, true, 'bo-2 should be takeable');
  const r3 = w.sit('c', 'bo-1');
  assert.equal(r3.ok, false, 'an occupied office seat is refused');
  assert.equal(r3.error, 'seat_taken');
});

test('set_attire allowlist: formal/casual ok, anything else rejected', () => {
  const w = freshWorld();
  w.spawn({ id: 'a', name: 'A', kind: 'bot' });
  assert.equal(w.setAttire('a', 'formal').ok, true);
  assert.equal(w.setAttire('a', 'casual').ok, true);
  const bad = w.setAttire('a', 'tuxedo');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad_attire');
});

test('money validation rejects out-of-range, non-numeric, and too-many-decimals', () => {
  const ok = validate(schemas.meetSubmit, { party: 'A', money: { amountAnchor: '400000', reveal: 'opening' } });
  assert.equal(ok.ok, true, 'a valid money amount passes');

  assert.equal(validate(schemas.meetSubmit, { party: 'A', money: { amountAnchor: '2000000000' } }).ok, false, 'over 1e9 rejected');
  assert.equal(validate(schemas.meetSubmit, { party: 'A', money: { amountAnchor: 'abc' } }).ok, false, 'non-numeric rejected');
  assert.equal(validate(schemas.meetSubmit, { party: 'A', money: { amountAnchor: '10.123' } }).ok, false, '3 decimals rejected');
  assert.equal(validate(schemas.meetSubmit, { party: 'A', money: { amountAnchor: '-5' } }).ok, false, 'negative rejected');
  assert.equal(validate(schemas.meetSubmit, { party: 'A', money: { unit: 'weekly' } }).ok, false, 'bad unit enum rejected');
  assert.equal(validate(schemas.meetSubmit, { party: 'A', money: { bogus: 1 } }).ok, false, 'unknown money key rejected (strict)');
});

test('a party\'s walk-away never appears in the other party\'s guide or the shared guide', () => {
  const w = freshWorld();
  // Distinctive sentinels so we can assert they never leak.
  const A_WALK_TEXT = 'SENTINEL_WALK_A', B_WALK_TEXT = 'SENTINEL_WALK_B';
  const meeting = {
    id: 'm1', location: 'Prestigious business office',
    parties: {
      A: { name: 'Sheila', goals: 'buy', walkaway: A_WALK_TEXT, authority: 'negotiate',
           money: { dealType: 'buy_sell', amountAnchor: 400000, amountWalkaway: 410000, askAbove: 405000, reveal: 'opening' } },
      B: { name: 'Seller', goals: 'sell', walkaway: B_WALK_TEXT, authority: 'negotiate',
           money: { dealType: 'buy_sell', amountAnchor: 430000, amountWalkaway: 421000, askAbove: 425000, reveal: 'opening' } },
    },
  };

  // Guide scoped to A: must contain A's own walk-away, never B's.
  const gA = JSON.stringify(meetingGuide(meeting, w, 'A'));
  assert.ok(gA.includes(A_WALK_TEXT), 'A sees its own walk-away in its private block');
  assert.ok(!gA.includes(B_WALK_TEXT), 'A must NOT see B\'s walk-away text');
  assert.ok(!gA.includes('421000'), 'A must NOT see B\'s walk-away number');
  assert.ok(!gA.includes('425000'), 'A must NOT see B\'s ask-above number');

  // Shared/unscoped guide: carries NO party's walk-away number at all.
  const gShared = JSON.stringify(meetingGuide(meeting, w));
  assert.ok(!gShared.includes('410000'), 'shared guide has no A walk-away number');
  assert.ok(!gShared.includes('421000'), 'shared guide has no B walk-away number');
  assert.ok(!gShared.includes(A_WALK_TEXT) && !gShared.includes(B_WALK_TEXT), 'shared guide has no walk-away text');
  assert.equal(meetingGuide(meeting, w).negotiation, undefined, 'no private negotiation block without a party scope');
});
