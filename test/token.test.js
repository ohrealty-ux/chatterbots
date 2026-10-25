// Token / world-pass regression tests (Part 1, section C).
// Run with: npm test   (node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateToken, hashToken, verifyToken, verifyTokenMigratable, constantTimeEqual } from '../src/security/security.js';

test('generateToken yields an eldr_ world pass, a 12-char prefix, and a verifying hash', () => {
  const { raw, prefix, hash } = generateToken();
  assert.ok(raw.startsWith('eldr_'), 'raw is an eldr_ world pass');
  assert.equal(prefix.length, 12);
  assert.equal(prefix, raw.slice(0, 12));
  assert.ok(verifyToken(raw, hash), 'the minted hash verifies the raw pass');
});

test('verifyToken rejects a wrong pass and tolerates nothing empty', () => {
  const { raw, hash } = generateToken();
  assert.equal(verifyToken(raw + 'x', hash), false);
  assert.equal(verifyToken('', hash), false);
  assert.equal(verifyToken(raw, ''), false);
});

test('verifyTokenMigratable → "current" for the active sha256/HMAC scheme', () => {
  const { raw, hash } = generateToken();
  assert.equal(verifyTokenMigratable(raw, hash), 'current');
});

test('verifyTokenMigratable → "legacy" for a plain-sha256 row (pre-pepper)', () => {
  const raw = 'eldr_' + crypto.randomBytes(16).toString('base64url');
  const legacySha = crypto.createHash('sha256').update(raw).digest('hex');
  const status = verifyTokenMigratable(raw, legacySha);
  // When no TOKEN_PEPPER is set the active scheme IS plain sha256, so this reads as 'current';
  // with a pepper configured it reads as 'legacy'. Either way it must be truthy (authenticates).
  assert.ok(status === 'legacy' || status === 'current', 'plain-sha256 row still authenticates');
});

test('verifyTokenMigratable → "legacy" for a raw-plaintext row (earliest scheme)', () => {
  const raw = 'eldr_plaintext_example_value';
  assert.equal(verifyTokenMigratable(raw, raw), 'legacy');
});

test('verifyTokenMigratable → null for a non-matching hash', () => {
  const { raw } = generateToken();
  assert.equal(verifyTokenMigratable(raw, 'deadbeef'.repeat(8)), null);
  assert.equal(verifyTokenMigratable('', 'x'), null);
  assert.equal(verifyTokenMigratable('x', ''), null);
});

test('migrate-on-auth: a legacy plaintext row re-hashes to a verifying current digest', () => {
  // Simulate the gateway migration path: legacy row stored raw; on success we re-store hashToken(raw).
  const raw = 'eldr_legacy_plain_pass_123';
  const legacyStored = raw;                       // earliest scheme: plaintext
  assert.equal(verifyTokenMigratable(raw, legacyStored), 'legacy');
  const migrated = hashToken(raw);                // what the gateway writes via Bots.setToken
  assert.notEqual(migrated, raw, 'migrated digest is not plaintext');
  assert.equal(verifyTokenMigratable(raw, migrated), 'current', 'migrated digest now reads as current');
  assert.ok(verifyToken(raw, migrated));
});

test('constantTimeEqual compares equal/unequal strings correctly', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
});
