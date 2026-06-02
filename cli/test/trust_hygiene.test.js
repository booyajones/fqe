'use strict';

/**
 * v0.10 trust hygiene: flaky-retry (neutral, not blocking), quarantine (neutral),
 * and human-review telemetry in the receipt. One random red must never block a merge
 * and erode trust in the gate, but a flake must stay LOUD (a FLAG, never a silent PASS).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVerdict } = require('../lib/verdict');
const { buildReceipt, serializeReceipt } = require('../lib/receipt');

test('flaky runner (failed then passed on retry) is a FLAG, not a clean PASS', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit', flaky: true }],
  });
  assert.equal(v.verdict, 'FLAG');
  assert.match(v.reasons.join(' '), /FLAKY/);
});

test('quarantined runner that FAILED is a neutral FLAG, not a blocking FAIL', () => {
  const v = computeVerdict({
    runners: [{ name: 'e2e', required: true, ran: true, exit_code: 1, class: 'e2e', quarantined: true, quarantine_expired: false }],
  });
  assert.equal(v.verdict, 'FLAG', 'a known-flaky quarantined suite must not block the merge');
  assert.match(v.reasons.join(' '), /QUARANTINED/);
});

test('a NON-quarantined failing runner still FAILs (no weakening)', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 1, class: 'unit' }],
  });
  assert.equal(v.verdict, 'FAIL');
});

test('quarantined runner with a non-numeric exit is neutral, not FAIL', () => {
  const v = computeVerdict({
    runners: [{ name: 'e2e', required: true, ran: true, exit_code: null, class: 'e2e', quarantined: true, quarantine_expired: false }],
  });
  assert.equal(v.verdict, 'FLAG');
});

test('a normal passing runner is unaffected (backward compatible)', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
  });
  assert.equal(v.verdict, 'PASS');
});

// ---------- human-review telemetry in the receipt ----------

function ctx(human_review) {
  return {
    fqe_version: '0.10.0', run_id: 'r', started_at: 'a', finished_at: 'b',
    commit_sha: 'a'.repeat(40), content_hash: 'sha256:' + 'a'.repeat(64), inputs_hash: 'sha256:' + 'b'.repeat(64),
    classifier_version: 1, runner_versions: { fqe: '0.10.0' }, runners_fired: ['unit'],
    runners: [{ name: 'unit', class: 'unit', required: true, ran: true, exit_code: 0 }],
    verdict: 'PASS', verdict_reasons: [], human_review,
  };
}

test('receipt surfaces the human review queue with estimated minutes', () => {
  const { markdown } = serializeReceipt(buildReceipt(ctx(
    { flags: 2, flaky: 1, quarantined: 0, unwired_suites: 1, ai_drafts: 0, estimated_minutes: 6 }
  )));
  assert.match(markdown, /Human review queue:/);
  assert.match(markdown, /~6 min/);
  assert.match(markdown, /flaky 1/);
});

// ── v0.15 F1: quarantine expiry (orchestrator computes the boolean; verdict consumes it) ──
test('F1 V1: a FRESH quarantine of a failing runner is a FLAG', () => {
  const v = computeVerdict({ runners: [{ name: 'flaky', required: true, ran: true, exit_code: 1, quarantined: true, quarantine_expired: false }] });
  assert.equal(v.verdict, 'FLAG');
  assert.match(v.reasons.join(' '), /QUARANTINED/);
});
test('F1 V2: an EXPIRED quarantine of a failing runner is a FAIL', () => {
  const v = computeVerdict({ runners: [{ name: 'flaky', required: true, ran: true, exit_code: 1, quarantined: true, quarantine_expired: true }] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons.join(' '), /QUARANTINE HAS EXPIRED/);
});
test('F1 V3: an EXPIRED quarantine with a non-numeric exit is a FAIL', () => {
  const v = computeVerdict({ runners: [{ name: 'flaky', required: true, ran: true, exit_code: undefined, quarantined: true, quarantine_expired: true }] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons.join(' '), /QUARANTINE EXPIRED/);
});
test('F1 V4: an EXPIRED quarantine on a PASSING runner stays PASS', () => {
  const v = computeVerdict({ runners: [{ name: 'ok', required: true, ran: true, exit_code: 0, quarantined: true, quarantine_expired: true }] });
  assert.equal(v.verdict, 'PASS');
});
test('F1 V5: quarantine_expired ABSENT does not shield (fail-closed) -> FAIL', () => {
  // CRITICAL-2 fix: a quarantine with no computed expiry boolean (a raw verdict input that
  // never went through the orchestrator, which always sets it) must not shield a failure.
  const v = computeVerdict({ runners: [{ name: 'flaky', required: true, ran: true, exit_code: 1, quarantined: true }] });
  assert.equal(v.verdict, 'FAIL');
});
