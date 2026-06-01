'use strict';

/**
 * v0.11 payments safety: require_money_idempotency. A money-movement repo must prove a
 * repeated request pays once. fqe refuses a green if no runner ran AND passed proving the
 * 'idempotency' invariant. This is the single highest-severity payments control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVerdict } = require('../lib/verdict');
const { validateConfig } = require('../lib/config_schema');

// A qualifying idempotency runner must ALSO carry coverage evidence of real execution.
const realCov = { declared: true, evidence_ok: true, executed: 8, reported: 8, collected: 8, min_tests: 1, reconcile: true, strict_coverage: true };

test('PASS: an idempotency runner that passed AND has real coverage evidence satisfies it', () => {
  const v = computeVerdict({
    require_money_idempotency: true,
    runners: [{ name: 'money', required: true, ran: true, exit_code: 0, class: 'money', invariant: ['idempotency', 'double-spend'], coverage: realCov }],
  });
  assert.equal(v.verdict, 'PASS');
});

test('FAIL (fail-open closed): a no-op runner CLAIMING the idempotency label cannot satisfy it', () => {
  // command: 'true' with invariant: [idempotency] but NO coverage evidence => decorative label.
  const v = computeVerdict({
    require_money_idempotency: true,
    runners: [{ name: 'fake', required: true, ran: true, exit_code: 0, class: 'money', invariant: ['idempotency'] }],
  });
  assert.equal(v.verdict, 'FAIL', 'a label without execution evidence must not satisfy the money gate');
  assert.match(v.reasons.join(' '), /coverage evidence/);
});

test('FAIL: idempotency runner declared coverage but evidence_ok is false', () => {
  const v = computeVerdict({
    require_money_idempotency: true,
    runners: [{ name: 'money', required: true, ran: true, exit_code: 0, class: 'money', invariant: ['idempotency'],
      coverage: { declared: true, evidence_ok: false, executed: null, min_tests: 1 } }],
  });
  assert.equal(v.verdict, 'FAIL');
});

test('FAIL: money idempotency required but no runner proves it', () => {
  const v = computeVerdict({
    require_money_idempotency: true,
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
  });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons.join(' '), /idempotency/);
});

test('FAIL: the idempotency runner ran but FAILED (must be passed)', () => {
  const v = computeVerdict({
    require_money_idempotency: true,
    runners: [{ name: 'money', required: true, ran: true, exit_code: 1, class: 'money', invariant: ['idempotency'] }],
  });
  assert.equal(v.verdict, 'FAIL');
});

test('require_money_idempotency false leaves the verdict unaffected (backward compatible)', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
  });
  assert.equal(v.verdict, 'PASS');
});

// ---------- config_schema ----------

function base(runner, top = {}) {
  return { version: 1, runners: { r: { command: 'x', always_run: true, ...runner } }, ...top };
}

test('config: invariant with an unknown id is rejected', () => {
  const res = validateConfig(base({ invariant: ['teleportation'] }));
  assert.equal(res.valid, false);
  assert.match(res.errors.join(' '), /unknown id 'teleportation'/);
});

test('config: invariant must be a non-empty list of strings', () => {
  assert.equal(validateConfig(base({ invariant: [] })).valid, false);
  assert.equal(validateConfig(base({ invariant: 'idempotency' })).valid, false);
});

test('config: a valid invariant + require_money_idempotency validates', () => {
  const res = validateConfig(base(
    { class: 'money', required: true, invariant: ['idempotency', 'double-spend'] },
    { require_money_idempotency: true }
  ));
  assert.equal(res.valid, true, res.errors.join('; '));
});

test('config: require_money_idempotency must be boolean', () => {
  const res = validateConfig(base({ invariant: ['idempotency'] }, { require_money_idempotency: 'yes' }));
  assert.equal(res.valid, false);
});
