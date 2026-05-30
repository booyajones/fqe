'use strict';

/**
 * qa_report.js tests — the QA scorecard over a PARSED receipt.
 * Run with: node --test test/qa_report.test.js
 *
 * The scorecard is a PURE roll-up. These tests build receipt objects by hand
 * (the same shape receipt.parseReceiptYaml produces) and assert:
 *   - per-class tallies + status are correct (pass / fail / not-run)
 *   - totals are correct
 *   - policy coverage marks covered vs GAP, and gaps[] explains each GAP
 *   - a class-less runner lands under 'unclassified'
 *   - adversarial_stats are summarized
 *   - buildQaReport fails closed on a non-object / missing runners
 *   - renderQaReport returns a non-empty string naming the verdict + each class
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQaReport, renderQaReport } = require('../lib/qa_report');

// ─── Helpers ────────────────────────────────────────────────────────────

function runner(name, cls, ran, exit_code, required = false) {
  return { name, class: cls, required, ran, exit_code };
}

function receipt(overrides = {}) {
  return {
    schema_version: 1,
    verdict: 'PASS',
    commit_sha: 'a3f2c891b5e7d8f9012345678901234567890abc',
    runners: [],
    required_classes: [],
    adversarial_stats: [],
    verdict_reasons: [],
    ...overrides,
  };
}

// ─── Clean multi-class receipt ────────────────────────────────────────────

test('clean multi-class receipt: per-class statuses + totals correct', () => {
  const r = receipt({
    runners: [
      runner('unit-fast', 'unit', true, 0, true),
      runner('unit-slow', 'unit', true, 0, false),
      runner('reg-golden', 'regression', true, 0, true),
      runner('money-recon', 'money', true, 0, true),
    ],
  });
  const report = buildQaReport(r);

  assert.equal(report.verdict, 'PASS');
  assert.equal(report.commit_sha, r.commit_sha);

  // unit: two runners, both ran and passed -> status pass
  assert.deepEqual(report.by_class.unit, {
    runners: ['unit-fast', 'unit-slow'],
    ran: 2, passed: 2, failed: 0, not_run: 0, status: 'pass',
  });
  assert.equal(report.by_class.regression.status, 'pass');
  assert.equal(report.by_class.money.status, 'pass');

  assert.deepEqual(report.totals, { runners: 4, passed: 4, failed: 0, not_run: 0 });
});

// ─── A failed runner ────────────────────────────────────────────────────

test('a failed runner makes its class status fail', () => {
  const r = receipt({
    verdict: 'FAIL',
    runners: [
      runner('unit-ok', 'unit', true, 0),
      runner('money-broke', 'money', true, 1),
    ],
  });
  const report = buildQaReport(r);

  assert.equal(report.by_class.money.status, 'fail');
  assert.equal(report.by_class.money.failed, 1);
  assert.equal(report.by_class.money.passed, 0);
  assert.equal(report.by_class.unit.status, 'pass');
  assert.deepEqual(report.totals, { runners: 2, passed: 1, failed: 1, not_run: 0 });
});

test('a ran runner with a non-numeric exit_code counts as failed (fail closed)', () => {
  const r = receipt({
    runners: [
      // ran but exit_code missing -> per verdict.js semantics this is NOT a pass
      { name: 'flaky', class: 'integration', required: true, ran: true },
    ],
  });
  const report = buildQaReport(r);
  assert.equal(report.by_class.integration.status, 'fail');
  assert.equal(report.by_class.integration.failed, 1);
  assert.equal(report.by_class.integration.passed, 0);
  assert.deepEqual(report.totals, { runners: 1, passed: 0, failed: 1, not_run: 0 });
});

// ─── A class with only not-run runners ────────────────────────────────────

test('a class with only not-run runners has status not-run', () => {
  const r = receipt({
    runners: [
      runner('e2e-suite', 'e2e', false, undefined, false),
      runner('e2e-extra', 'e2e', false, undefined, false),
    ],
  });
  const report = buildQaReport(r);
  assert.deepEqual(report.by_class.e2e, {
    runners: ['e2e-suite', 'e2e-extra'],
    ran: 0, passed: 0, failed: 0, not_run: 2, status: 'not-run',
  });
  assert.deepEqual(report.totals, { runners: 2, passed: 0, failed: 0, not_run: 2 });
});

// ─── required_classes: covered ────────────────────────────────────────────

test('required class with a passing runner is covered, no gap', () => {
  const r = receipt({
    required_classes: ['money'],
    runners: [
      runner('money-recon', 'money', true, 0, true),
    ],
  });
  const report = buildQaReport(r);
  assert.equal(report.required_class_status.money, 'covered');
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.required_classes, ['money']);
});

// ─── required_classes: GAP ────────────────────────────────────────────────

test('required class with no passing runner is a GAP with a gaps[] entry', () => {
  const r = receipt({
    verdict: 'FAIL',
    required_classes: ['money', 'regression'],
    runners: [
      // money ran but FAILED -> not a passing runner -> GAP
      runner('money-broke', 'money', true, 2, true),
      // regression has no runner at all -> GAP
      runner('unit-ok', 'unit', true, 0, true),
    ],
  });
  const report = buildQaReport(r);
  assert.equal(report.required_class_status.money, 'GAP');
  assert.equal(report.required_class_status.regression, 'GAP');
  assert.ok(report.gaps.includes('class "money" is required by policy but has no passing runner'));
  assert.ok(report.gaps.includes('class "regression" is required by policy but has no passing runner'));
  assert.equal(report.gaps.length, 2);
});

test('required class covered only counts a ran-AND-passed runner', () => {
  const r = receipt({
    required_classes: ['contract'],
    runners: [
      // present, but did not run -> does not cover
      runner('contract-a', 'contract', false, undefined),
      // ran and passed -> covers
      runner('contract-b', 'contract', true, 0),
    ],
  });
  const report = buildQaReport(r);
  assert.equal(report.required_class_status.contract, 'covered');
  assert.deepEqual(report.gaps, []);
});

test('an unknown class in required_classes is tagged UNKNOWN-CLASS, not a plain GAP', () => {
  const r = receipt({
    verdict: 'FAIL',
    required_classes: ['mony', 'money'], // "mony" is a typo for "money"
    runners: [
      // a real, passing money runner covers the correctly-spelled class
      runner('money-recon', 'money', true, 0, true),
    ],
  });
  const report = buildQaReport(r);
  // typo'd class is tagged distinctly, NOT a plain GAP
  assert.equal(report.required_class_status.mony, 'UNKNOWN-CLASS');
  assert.notEqual(report.required_class_status.mony, 'GAP');
  // the correctly-spelled, covered class is unaffected
  assert.equal(report.required_class_status.money, 'covered');
  // a distinct gap message names the typo, and there's no phantom plain GAP for it
  assert.ok(report.gaps.includes('class "mony" is required but is not a known test class (typo?)'));
  assert.ok(!report.gaps.includes('class "mony" is required by policy but has no passing runner'));
  assert.equal(report.gaps.length, 1);
});

// ─── Unclassified ─────────────────────────────────────────────────────────

test('a runner with no class appears under unclassified', () => {
  const r = receipt({
    runners: [
      { name: 'mystery', required: false, ran: true, exit_code: 0 }, // no class key
      { name: 'blank', class: '', required: false, ran: true, exit_code: 0 }, // empty class
      runner('unit-ok', 'unit', true, 0),
    ],
  });
  const report = buildQaReport(r);
  assert.ok(report.by_class.unclassified, 'unclassified bucket exists');
  assert.deepEqual(report.by_class.unclassified.runners, ['mystery', 'blank']);
  assert.equal(report.by_class.unclassified.status, 'pass');
  assert.ok(report.by_class.unit, 'classified runner still grouped by its class');
});

// ─── Adversarial summary ───────────────────────────────────────────────────

test('adversarial_stats are summarized into adversarial[]', () => {
  const r = receipt({
    runners: [runner('outbound', 'outbound-not-a-class', true, 0)],
    adversarial_stats: [
      { runner: 'outbound', n: 100, successes: 2, ci_95: [0, 0.0369], blast_radius: 'outbound' },
      { runner: 'mcp', n: 200, successes: 0, ci_95: [0, 0.0182], blast_radius: 'mcp-read' },
    ],
  });
  const report = buildQaReport(r);
  assert.deepEqual(report.adversarial, [
    { runner: 'outbound', blast_radius: 'outbound', ci_upper: 0.0369 },
    { runner: 'mcp', blast_radius: 'mcp-read', ci_upper: 0.0182 },
  ]);
});

test('an adversarial stat with no runner does not render the literal undefined', () => {
  const r = receipt({
    runners: [runner('unit-ok', 'unit', true, 0)],
    adversarial_stats: [
      { n: 100, successes: 0, ci_95: [0, 0.0369], blast_radius: 'outbound' }, // no runner key
      { runner: '', n: 50, successes: 0, ci_95: [0, 0.05], blast_radius: 'mcp-read' }, // empty runner
    ],
  });
  const report = buildQaReport(r);
  for (const a of report.adversarial) {
    assert.notEqual(a.runner, 'undefined');
    assert.equal(a.runner, '(unknown runner)');
  }
  // the rest of the summary is still carried through
  assert.equal(report.adversarial[0].blast_radius, 'outbound');
  assert.equal(report.adversarial[0].ci_upper, 0.0369);
});

test('missing adversarial_stats yields an empty adversarial[]', () => {
  const r = receipt({ runners: [runner('unit-ok', 'unit', true, 0)] });
  delete r.adversarial_stats;
  const report = buildQaReport(r);
  assert.deepEqual(report.adversarial, []);
});

test('missing required_classes defaults to an empty list with no gaps', () => {
  const r = receipt({ runners: [runner('unit-ok', 'unit', true, 0)] });
  delete r.required_classes;
  const report = buildQaReport(r);
  assert.deepEqual(report.required_classes, []);
  assert.deepEqual(report.required_class_status, {});
  assert.deepEqual(report.gaps, []);
});

// ─── Fail closed ───────────────────────────────────────────────────────────

test('buildQaReport throws on a non-object', () => {
  assert.throws(() => buildQaReport(null), /must be an object/);
  assert.throws(() => buildQaReport(undefined), /must be an object/);
  assert.throws(() => buildQaReport('a string'), /must be an object/);
  assert.throws(() => buildQaReport(42), /must be an object/);
  assert.throws(() => buildQaReport([]), /must be an object/);
});

test('buildQaReport throws when runners is missing or not an array', () => {
  assert.throws(() => buildQaReport({ verdict: 'PASS' }), /runners must be an array/);
  assert.throws(() => buildQaReport({ verdict: 'PASS', runners: 'nope' }), /runners must be an array/);
  assert.throws(() => buildQaReport({ verdict: 'PASS', runners: {} }), /runners must be an array/);
});

// ─── renderQaReport ─────────────────────────────────────────────────────────

test('renderQaReport returns a non-empty string with the verdict and each class', () => {
  const r = receipt({
    verdict: 'FAIL',
    required_classes: ['money'],
    runners: [
      runner('unit-ok', 'unit', true, 0),
      runner('money-broke', 'money', true, 1),
      runner('e2e-skip', 'e2e', false, undefined),
    ],
  });
  const report = buildQaReport(r);
  const text = renderQaReport(report);

  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  assert.ok(text.includes('FAIL'), 'names the verdict');
  assert.ok(text.includes('unit'), 'names the unit class');
  assert.ok(text.includes('money'), 'names the money class');
  assert.ok(text.includes('e2e'), 'names the e2e class');
  // policy section + gap surfaced
  assert.ok(text.includes('Policy-required classes:'));
  assert.ok(text.includes('GAP'));
  // no em-dashes (ASCII only)
  assert.ok(!text.includes('—'), 'no em-dashes');
});

test('renderQaReport handles a receipt with no runners and no policy', () => {
  const report = buildQaReport(receipt({ runners: [] }));
  const text = renderQaReport(report);
  assert.ok(text.includes('PASS'));
  assert.ok(text.includes('none required by policy'));
});
