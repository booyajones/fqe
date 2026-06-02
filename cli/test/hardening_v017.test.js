'use strict';

/**
 * v0.17 hardening regressions — the fail-opens a full-codebase adversary sweep found that
 * the per-version diff reviews could not (they only saw diffs). C1 (uat empty-criteria) is
 * covered in uat.test.js; this file covers the rest.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orchestrator = require('../lib/orchestrator');
const tally = require('../lib/bypass_tally');
const { discover } = require('../lib/discover');
const { evaluateOracleGuard } = require('../lib/oracle_guard');
const { parseLcov } = require('../lib/coverage_ratchet');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-h17-')); }

// HIGH-1: runner env must not leak fqe's signing key or other CI secrets.
test('HIGH-1: sanitizeRunnerEnv strips the signing key and secret-named vars, keeps the rest', () => {
  const save = { ...process.env };
  process.env.FQE_SIGNING_KEY = 'super-secret';
  process.env.GH_TOKEN = 'tok';
  process.env.MY_API_KEY = 'k';
  process.env.AWS_SECRET_ACCESS_KEY = 's';
  process.env.HARMLESS_VAR = 'ok';
  try {
    const env = orchestrator.sanitizeRunnerEnv({ FQE_RUNNER_NAME: 'r' });
    assert.equal(env.FQE_SIGNING_KEY, undefined, 'signing key must be stripped');
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.MY_API_KEY, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.HARMLESS_VAR, 'ok', 'non-secret vars pass through');
    assert.equal(env.FQE_RUNNER_NAME, 'r', 'explicit run-context extra passes through');
    assert.ok(env.PATH !== undefined || env.Path !== undefined, 'PATH passes through');
  } finally {
    for (const k of ['FQE_SIGNING_KEY', 'GH_TOKEN', 'MY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'HARMLESS_VAR']) {
      if (!(k in save)) delete process.env[k]; else process.env[k] = save[k];
    }
  }
});

// HIGH-1b (review): AWS_ACCESS_KEY_ID (ends _ID, not _KEY) is stripped; a secret-named
// extra cannot re-inject past the filter.
test('HIGH-1b: AWS_ACCESS_KEY_ID is stripped and a secret-named extra cannot re-inject', () => {
  const save = { ...process.env };
  process.env.AWS_ACCESS_KEY_ID = 'AKIA-leak';
  try {
    const env = orchestrator.sanitizeRunnerEnv({ FQE_SIGNING_KEY: 'sneaky', FQE_RUNNER_NAME: 'r' });
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined, 'AWS access key id must be stripped');
    assert.equal(env.FQE_SIGNING_KEY, undefined, 'a secret-named extra must NOT re-inject');
    assert.equal(env.FQE_RUNNER_NAME, 'r', 'non-secret extra still passes through');
  } finally {
    if (!('AWS_ACCESS_KEY_ID' in save)) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = save.AWS_ACCESS_KEY_ID;
  }
});

// H2 (review): bypasses present but no datable totals must NOT report rate 0 (alarm silenced).
test('H2: denominator 0 + a bypass present -> rate 1 and tally_alarm (fail closed)', () => {
  const dir = tmp();
  const now = new Date('2026-06-02T00:00:00Z');
  fs.writeFileSync(path.join(dir, tally.BYPASS_FILE), JSON.stringify({ actor: 'a' /* no ts */ }) + '\n');
  fs.writeFileSync(path.join(dir, tally.TOTAL_FILE), ''); // no totals at all
  const r = tally.rate(dir, { now });
  assert.equal(r.denominator, 0);
  assert.ok(r.numerator > 0);
  assert.equal(r.rate, 1, 'worst-case rate when the denominator is untrustworthy');
  assert.equal(r.tally_alarm, true);
});

// H1: an undatable bypass row must not silently vanish from the rolling rate numerator.
test('H1: a bypass row with a missing ts still counts in the numerator (fail closed)', () => {
  const dir = tmp();
  const now = new Date('2026-06-02T00:00:00Z');
  const inWindow = new Date('2026-05-30T00:00:00Z').toISOString();
  fs.writeFileSync(path.join(dir, tally.BYPASS_FILE),
    JSON.stringify({ actor: 'a', ts: inWindow }) + '\n' + JSON.stringify({ actor: 'b' /* no ts */ }) + '\n');
  // 10 datable totals in-window so the denominator is real
  const totals = Array.from({ length: 10 }, () => JSON.stringify({ ts: inWindow })).join('\n');
  fs.writeFileSync(path.join(dir, tally.TOTAL_FILE), totals + '\n');
  const r = tally.rate(dir, { now });
  assert.equal(r.numerator, 2, 'the undatable bypass is counted, not dropped');
  assert.equal(r.denominator, 10);
});

// H2: a bare .fqeignore pattern must match only a path segment, not any prefix.
test('H2: .fqeignore "src" does not over-match src_test.py (suite stays discoverable)', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.py'), 'x=1');
  fs.writeFileSync(path.join(dir, 'src_test.py'), 'def test_x(): pass');
  fs.writeFileSync(path.join(dir, '.fqeignore'), 'src\n');
  const d = discover(dir, {});
  const scanned = d.scanned_files || [];
  assert.ok(scanned.includes('src_test.py'), `src_test.py must NOT be ignored by bare "src"; scanned: ${scanned.join(', ')}`);
  assert.ok(!scanned.includes('src/app.py'), 'src/app.py IS under src/ and is correctly ignored');
});

// M1: oracle/golden/config matching is case-insensitive so a case-variant rename cannot evade.
test('M1: a case-variant .FQE.YML edit is still detected as an oracle change', () => {
  const r = evaluateOracleGuard({ files: ['.FQE.YML'] });
  assert.ok(Array.isArray(r.oracle_files) && r.oracle_files.includes('.FQE.YML'), `expected .FQE.YML flagged as oracle; got ${JSON.stringify(r.oracle_files)}`);
});

// M2: a malformed lcov payload is UNREADABLE (null), not silently coerced to 0.
test('M2: parseLcov returns null on a malformed LH payload (fails closed), parses a valid one', () => {
  assert.equal(parseLcov('LF:10\nLH:xyz\n'), null);
  assert.equal(parseLcov('LF:10\nLH:8\n'), 80);
});
