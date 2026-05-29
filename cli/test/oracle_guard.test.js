'use strict';

/**
 * Tests for oracle-guard (cli/lib/oracle_guard.js).
 *
 * The guard's job: raise "needs a second reviewer" exactly when a PR edits the
 * recorded ground truth / grading rules it is judged by, or (with includeTests)
 * weakens a test alongside the source it grades. The hard requirement is LOW
 * false-positive: a normal code PR, or a pure test-writing PR, must stay clean.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOracleGuard, getChangedFiles } = require('../lib/oracle_guard');

function ev(files, includeTests = false) {
  return evaluateOracleGuard({ files, includeTests });
}

// ── clean: no second review needed ───────────────────────────────────────────

test('a normal source-only PR is clean', () => {
  const r = ev(['src/app.ts', 'src/lib/money.ts']);
  assert.equal(r.requires_second_review, false);
  assert.deepEqual(r.oracle_files, []);
});

test('a docs-only PR is clean', () => {
  const r = ev(['README.md', 'docs/guide.md']);
  assert.equal(r.requires_second_review, false);
});

test('with includeTests off, source + test together is still clean', () => {
  const r = ev(['src/app.ts', 'src/app.test.ts'], false);
  assert.equal(r.requires_second_review, false);
});

test('a pure test-writing PR is clean even with includeTests on', () => {
  const r = ev(['src/app.test.ts', 'tests/extra.spec.ts'], true);
  assert.equal(r.requires_second_review, false);
  assert.equal(r.source_files.length, 0);
});

// ── ground truth / rules touched: always needs a second reviewer ─────────────

test('editing a golden master needs a second reviewer', () => {
  const r = ev(['src/nacha.ts', 'testdata/nacha/run.golden']);
  assert.equal(r.requires_second_review, true);
  assert.ok(r.oracle_files.includes('testdata/nacha/run.golden'));
  assert.match(r.reasons[0], /ORACLE_GROUND_TRUTH_CHANGED/);
});

test('editing .fqe.yml (the grading rules) needs a second reviewer', () => {
  const r = ev(['.fqe.yml']);
  assert.equal(r.requires_second_review, true);
  assert.ok(r.oracle_files.includes('.fqe.yml'));
});

test('lowering coverage-baseline.json needs a second reviewer', () => {
  const r = ev(['coverage-baseline.json']);
  assert.equal(r.requires_second_review, true);
});

test('editing the mutation config (stryker.conf.json) needs a second reviewer', () => {
  const r = ev(['stryker.conf.json']);
  assert.equal(r.requires_second_review, true);
});

test('re-recording a partner cassette needs a second reviewer', () => {
  const r = ev(['src/increase_client.py', 'tests/cassettes/increase_balance.yaml']);
  assert.equal(r.requires_second_review, true);
  assert.ok(r.oracle_files.some((f) => f.includes('cassettes/')));
});

test('editing a snapshot needs a second reviewer', () => {
  const r = ev(['src/App.tsx', 'src/__snapshots__/App.test.tsx.snap']);
  assert.equal(r.requires_second_review, true);
});

test('editing a fixture needs a second reviewer', () => {
  const r = ev(['src/parse.ts', 'test/fixtures/sample.json']);
  assert.equal(r.requires_second_review, true);
});

test('common golden extensions (.expected, .received) are covered', () => {
  assert.equal(ev(['src/x.ts', 'test/out.expected']).requires_second_review, true);
  assert.equal(ev(['src/x.ts', 'test/x.expected.txt']).requires_second_review, true);
  assert.equal(ev(['src/x.ts', 'test/x.received.txt']).requires_second_review, true);
  assert.equal(ev(['src/x.ts', 'test/x.frozen']).requires_second_review, true);
});

test('editing the reviewer allowlist needs a second reviewer', () => {
  const r = ev(['.github/fqe-second-reviewers.yml']);
  assert.equal(r.requires_second_review, true);
});

// ── test co-change (includeTests) ────────────────────────────────────────────

test('with includeTests, changing a test alongside source needs a second reviewer', () => {
  const r = ev(['src/money.ts', 'src/money.test.ts'], true);
  assert.equal(r.requires_second_review, true);
  assert.match(r.reasons.join(' '), /ORACLE_TEST_CO_CHANGE/);
  assert.deepEqual(r.test_files, ['src/money.test.ts']);
  assert.deepEqual(r.source_files, ['src/money.ts']);
});

test('with includeTests, a python test + source together needs a second reviewer', () => {
  const r = ev(['app/service.py', 'tests/test_service.py'], true);
  assert.equal(r.requires_second_review, true);
});

test('with includeTests, source + only a docs change (no test) is clean', () => {
  const r = ev(['src/app.ts', 'README.md'], true);
  assert.equal(r.requires_second_review, false);
});

// ── classification details ───────────────────────────────────────────────────

test('a golden file is oracle, not double-counted as source', () => {
  const r = ev(['data/x.golden', 'src/x.ts'], true);
  assert.ok(r.oracle_files.includes('data/x.golden'));
  assert.ok(!r.source_files.includes('data/x.golden'));
  assert.ok(r.source_files.includes('src/x.ts'));
});

test('backslash paths are normalized', () => {
  const r = ev(['src\\nacha.ts', 'testdata\\run.golden']);
  assert.equal(r.requires_second_review, true);
  assert.ok(r.oracle_files.includes('testdata/run.golden'));
});

test('both triggers can fire together and produce two reasons', () => {
  const r = ev(['src/money.ts', 'src/money.test.ts', '.fqe.yml'], true);
  assert.equal(r.requires_second_review, true);
  assert.equal(r.reasons.length, 2);
});

// ── getChangedFiles parsing ──────────────────────────────────────────────────

test('getChangedFiles parses a comma/space separated --changed list', () => {
  assert.deepEqual(getChangedFiles({ changed: 'a.ts, b.ts c.ts' }), ['a.ts', 'b.ts', 'c.ts']);
});

test('getChangedFiles normalizes ./ and backslashes in the list', () => {
  assert.deepEqual(getChangedFiles({ changed: './src\\a.ts' }), ['src/a.ts']);
});
