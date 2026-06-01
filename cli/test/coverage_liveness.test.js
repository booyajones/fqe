'use strict';

/**
 * Coverage-liveness ("make absence loud") tests. Two layers:
 *   1. computeVerdict Pass 6 (pure): the verdict decision from coverage counts.
 *   2. assembleCoverage (orchestrator IO): building coverage from a REAL pytest
 *      JUnit report on disk plus an inventory count.
 *
 * These are the negative controls the gauntlet required: a runner can exit 0 and
 * still have run nothing. Exit code passes; coverage-liveness must FAIL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeVerdict } = require('../lib/verdict');
const { assembleCoverage } = require('../lib/orchestrator');
const { validateConfig } = require('../lib/config_schema');

const FIX = path.join(__dirname, 'fixtures');
const realReport = fs.readFileSync(path.join(FIX, 'pytest_real_report.xml'), 'utf8'); // 6 reported, 4 executed
const allSkipped = fs.readFileSync(path.join(FIX, 'pytest_allskipped_report.xml'), 'utf8'); // 2 reported, 0 executed

function runner(coverage, over = {}) {
  return { name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit', coverage, ...over };
}

// ---------- Pass 6: verdict decision ----------

test('PASS: healthy coverage (executed >= min, reported == collected)', () => {
  const v = computeVerdict({ runners: [runner({
    declared: true, evidence_ok: true, executed: 4, reported: 6, collected: 6,
    min_tests: 1, reconcile: true, strict_coverage: true,
  })] });
  assert.equal(v.verdict, 'PASS');
});

test('FAIL: a runner that exits 0 but executed 0 non-skipped tests (all-skipped)', () => {
  const v = computeVerdict({ runners: [runner({
    declared: true, evidence_ok: true, executed: 0, reported: 2, collected: 2,
    min_tests: 1, reconcile: true, strict_coverage: true,
  })] });
  assert.equal(v.verdict, 'FAIL', 'exit code was 0 but nothing ran; coverage must block');
  assert.match(v.reasons.join(' '), /below the required minimum/);
});

test('FAIL: executed below an explicit min_tests floor', () => {
  const v = computeVerdict({ runners: [runner({
    declared: true, evidence_ok: true, executed: 3, reported: 3, collected: 3,
    min_tests: 10, reconcile: true, strict_coverage: true,
  })] });
  assert.equal(v.verdict, 'FAIL');
});

test('FAIL (fail-closed): declared report missing / stale / unparseable (evidence_ok false)', () => {
  const v = computeVerdict({ runners: [runner({
    declared: true, evidence_ok: false, evidence_error: 'declared report not found after run',
    executed: null, reported: null, collected: null, min_tests: 1, reconcile: false, strict_coverage: false,
  })] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons.join(' '), /no fresh, parseable test report/);
});

test('FAIL: mis-scoped subset (reported < collected) under strict_coverage', () => {
  const v = computeVerdict({ runners: [runner({
    declared: true, evidence_ok: true, executed: 3, reported: 3, collected: 6,
    min_tests: 1, reconcile: true, strict_coverage: true,
  })] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons.join(' '), /ran 3 of 6 collected/);
});

test('FLAG: mis-scoped subset when strict_coverage is off', () => {
  const v = computeVerdict({ runners: [runner({
    declared: true, evidence_ok: true, executed: 3, reported: 3, collected: 6,
    min_tests: 1, reconcile: true, strict_coverage: false,
  })] });
  assert.equal(v.verdict, 'FLAG');
});

test('FAIL: require_coverage_evidence on + a required runner with no coverage', () => {
  const v = computeVerdict({
    require_coverage_evidence: true,
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
  });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons.join(' '), /declares no test-evidence report/);
});

test('BACKWARD COMPAT: a runner with no coverage and no require_coverage_evidence is untouched', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
  });
  assert.equal(v.verdict, 'PASS');
});

// ---------- assembleCoverage: IO from a REAL report ----------

function writeTmp(content) {
  const p = path.join(os.tmpdir(), `fqe-cov-${process.pid}-${Math.random().toString(36).slice(2)}.xml`);
  fs.writeFileSync(p, content);
  return p;
}

test('assembleCoverage: real report + inventory count => evidence_ok, executed 4 of 6', () => {
  const p = writeTmp(realReport);
  try {
    const cov = assembleCoverage(
      { report: `junit:${p}`, min_tests: 1, reconcile: true, inventory_cmd: 'x', inventory_format: 'count' },
      p, Date.now() - 100, { ok: true, stdout: '6' }
    );
    assert.equal(cov.evidence_ok, true);
    assert.equal(cov.executed, 4);
    assert.equal(cov.reported, 6);
    assert.equal(cov.collected, 6);
  } finally { fs.rmSync(p, { force: true }); }
});

test('assembleCoverage: real all-skipped report => evidence_ok true but executed 0', () => {
  const p = writeTmp(allSkipped);
  try {
    const cov = assembleCoverage({ report: `junit:${p}`, min_tests: 1 }, p, Date.now() - 100, null);
    assert.equal(cov.evidence_ok, true);
    assert.equal(cov.executed, 0, 'parsed fine, but nothing executed; verdict turns this into FAIL');
  } finally { fs.rmSync(p, { force: true }); }
});

test('assembleCoverage: missing report file => evidence_ok false (fail closed)', () => {
  const cov = assembleCoverage({ report: 'junit:/no/such/report.xml' }, '/no/such/report.xml', Date.now(), null);
  assert.equal(cov.evidence_ok, false);
  assert.match(cov.evidence_error, /not found/);
});

test('assembleCoverage: unparseable report => evidence_ok false (fail closed)', () => {
  const p = writeTmp('this is not xml at all');
  try {
    const cov = assembleCoverage({ report: `junit:${p}` }, p, Date.now() - 100, null);
    assert.equal(cov.evidence_ok, false);
  } finally { fs.rmSync(p, { force: true }); }
});

test('assembleCoverage: reconcile on but inventory failed => evidence_ok false (fail closed)', () => {
  const p = writeTmp(realReport);
  try {
    const cov = assembleCoverage(
      { report: `junit:${p}`, reconcile: true, inventory_cmd: 'x', inventory_format: 'count' },
      p, Date.now() - 100, { ok: false, stdout: '', error: 'inventory_cmd exited 1' }
    );
    assert.equal(cov.evidence_ok, false);
    assert.match(cov.evidence_error, /inventory_cmd failed/);
  } finally { fs.rmSync(p, { force: true }); }
});

test('assembleCoverage: stale report (mtime predates run) => evidence_ok false', () => {
  const p = writeTmp(realReport);
  try {
    // Pretend the run started far in the future relative to the file mtime.
    const cov = assembleCoverage({ report: `junit:${p}` }, p, Date.now() + 60_000, null);
    assert.equal(cov.evidence_ok, false);
    assert.match(cov.evidence_error, /stale/);
  } finally { fs.rmSync(p, { force: true }); }
});

test('assembleCoverage: no report declared => undefined (backward compatible)', () => {
  assert.equal(assembleCoverage({}, null, Date.now(), null), undefined);
});

test('assembleCoverage: stale via pre-mtime (delete failed, runner did not rewrite) => fail closed', () => {
  // Simulate a prior report that survived a failed delete and was NOT rewritten:
  // preMtime equals the file's current mtime, so the runner produced nothing new.
  const p = writeTmp(realReport);
  try {
    const preMtime = fs.statSync(p).mtimeMs;
    const cov = assembleCoverage({ report: `junit:${p}` }, p, Date.now() - 100, null, preMtime);
    assert.equal(cov.evidence_ok, false, 'an unchanged report mtime means the runner wrote nothing this run');
    assert.match(cov.evidence_error, /not rewritten this run/);
  } finally { fs.rmSync(p, { force: true }); }
});

test('assembleCoverage: fresh rewrite (mtime advanced past pre-mtime) => evidence_ok', () => {
  const p = writeTmp(realReport);
  try {
    const cov = assembleCoverage({ report: `junit:${p}` }, p, Date.now() - 100, null, /*preMtime*/ 0);
    assert.equal(cov.evidence_ok, true, 'current mtime > preMtime(0) means it was rewritten');
  } finally { fs.rmSync(p, { force: true }); }
});

// ---------- config_schema: coverage fields fail closed ----------

test('config_schema: min_tests: 0 is REJECTED (would disable the empty-suite gate)', () => {
  const cfg = {
    version: 1,
    runners: { u: {
      command: 'x', always_run: true, required: true, report: 'junit:r.xml', min_tests: 0,
    } },
  };
  const res = validateConfig(cfg);
  assert.equal(res.valid, false);
  assert.match(res.errors.join(' '), /min_tests.*positive integer/);
});

test('config_schema: a coverage field without a report is REJECTED', () => {
  const cfg = {
    version: 1,
    runners: { u: { command: 'x', always_run: true, reconcile: true, inventory_cmd: 'y', inventory_format: 'count' } },
  };
  const res = validateConfig(cfg);
  assert.equal(res.valid, false, 'reconcile/min_tests without a report is meaningless => fail closed');
});

test('config_schema: a healthy coverage runner validates', () => {
  const cfg = {
    version: 1,
    require_coverage_evidence: true,
    runners: { u: {
      command: 'pytest', always_run: true, required: true, class: 'unit',
      report: 'junit:r.xml', inventory_cmd: 'pytest --collect-only -q', inventory_format: 'pytest-collect',
      min_tests: 1, reconcile: true, strict_coverage: true,
    } },
  };
  const res = validateConfig(cfg);
  assert.equal(res.valid, true, res.errors.join('; '));
});
