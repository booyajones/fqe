'use strict';

/**
 * v0.16 A3: HMAC receipt signing. The content_hash is tamper-EVIDENT; the signature makes
 * the receipt tamper-PROOF against anyone who lacks the key. Fail-closed on any tamper.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { signReceipt, verifyReceipt, keyIdOf, stableStringify } = require('../lib/signature');

const KEY = 'test-signing-key-do-not-use-in-prod';
const RECEIPT = {
  schema_version: 1,
  fqe_version: '0.16.0',
  commit_sha: 'a'.repeat(40),
  content_hash: 'sha256:' + 'b'.repeat(64),
  inputs_hash: 'sha256:' + 'c'.repeat(64),
  verdict: 'PASS',
  bypass: null,
  runners: [{ name: 'unit', exit_code: 0 }],
};

test('sign then verify round-trips', () => {
  const signed = signReceipt(RECEIPT, KEY, '2026-06-02T00:00:00Z');
  assert.equal(signed.signature.alg, 'hmac-sha256');
  assert.equal(signed.signature.key_id, keyIdOf(KEY));
  const r = verifyReceipt(signed, KEY);
  assert.equal(r.ok, true, r.reason);
});

test('signing is deterministic given (receipt, key)', () => {
  const a = signReceipt(RECEIPT, KEY, '2026-06-02T00:00:00Z');
  const b = signReceipt(RECEIPT, KEY, '2026-06-02T00:00:00Z');
  assert.equal(a.signature.value, b.signature.value);
});

test('signed_at is metadata only and does not affect the signature value', () => {
  const a = signReceipt(RECEIPT, KEY, '2026-06-02T00:00:00Z');
  const b = signReceipt(RECEIPT, KEY, '2030-01-01T00:00:00Z');
  assert.equal(a.signature.value, b.signature.value);
});

test('tampering with ANY signed field is detected -> verify fails', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  // Flip the verdict from PASS to FAIL-hiding... attacker edits the receipt.
  const tampered = { ...signed, verdict: 'FAIL' };
  const r = verifyReceipt(tampered, KEY);
  assert.equal(r.ok, false);
  assert.match(r.reason, /tamper|mismatch/i);
});

test('tampering with the content_hash is detected', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  const tampered = { ...signed, content_hash: 'sha256:' + 'd'.repeat(64) };
  assert.equal(verifyReceipt(tampered, KEY).ok, false);
});

test('tampering with the inputs_hash is detected', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  const tampered = { ...signed, inputs_hash: 'sha256:' + 'e'.repeat(64) };
  assert.equal(verifyReceipt(tampered, KEY).ok, false);
});

test('forging a bypass block into a signed receipt is detected (C2)', () => {
  // bypass records HUMAN AUTHORITY to override a FAIL; it MUST be covered by the signature.
  const signed = signReceipt(RECEIPT, KEY, null);
  const forged = { ...signed, bypass: { requester: 'attacker', requester_source: 'github_events_api_v3', events_url: 'x', allowlist_version: 'y', timestamp: 'z' } };
  assert.equal(verifyReceipt(forged, KEY).ok, false, 'an injected bypass must break the signature');
});

test('stripping key_id from a signed receipt fails closed (C1)', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  delete signed.signature.key_id;
  assert.equal(verifyReceipt(signed, KEY).ok, false);
});

test('a different key fails verification', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  const r = verifyReceipt(signed, 'a-different-key');
  assert.equal(r.ok, false);
});

test('a receipt with no signature fails closed', () => {
  assert.equal(verifyReceipt(RECEIPT, KEY).ok, false);
  assert.match(verifyReceipt(RECEIPT, KEY).reason, /no signature/);
});

test('an unsupported alg fails closed', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  signed.signature.alg = 'rot13';
  assert.equal(verifyReceipt(signed, KEY).ok, false);
});

test('an empty/garbage signature value fails closed', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  signed.signature.value = '';
  assert.equal(verifyReceipt(signed, KEY).ok, false);
  signed.signature.value = 'not-hex';
  assert.equal(verifyReceipt(signed, KEY).ok, false);
});

test('signing requires a non-empty key', () => {
  assert.throws(() => signReceipt(RECEIPT, ''));
  assert.throws(() => signReceipt(RECEIPT, null));
});

test('verify requires a key (a signed receipt + no key fails closed)', () => {
  const signed = signReceipt(RECEIPT, KEY, null);
  assert.equal(verifyReceipt(signed, '').ok, false);
});

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});
