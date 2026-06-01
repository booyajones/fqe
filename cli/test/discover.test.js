'use strict';

/**
 * Tests for `fqe discover` pure logic: detect frameworks from evidence, and match
 * detected frameworks against declared runners to find UNWIRED suites (the
 * inter-suite "make absence loud" gap).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFrameworks, matchWired, runnerCmdLine } = require('../lib/discover');
const { computeVerdict } = require('../lib/verdict');

test('detect pytest by manifest', () => {
  const d = detectFrameworks({ files: [], manifests: { pyproject: '[tool.pytest.ini_options]\naddopts = "-q"\npytest' } });
  assert.ok(d.find((x) => x.id === 'pytest'), 'pytest detected via pyproject');
});

test('detect pytest by test files alone (no manifest)', () => {
  const d = detectFrameworks({ files: ['tests/test_money.py', 'src/app.py'], manifests: {} });
  const p = d.find((x) => x.id === 'pytest');
  assert.ok(p);
  assert.match(p.evidence, /test files/);
});

test('detect jest by package.json devDependency', () => {
  const d = detectFrameworks({ files: [], manifests: { packageJson: '{"devDependencies":{"jest":"^29"}}' } });
  assert.ok(d.find((x) => x.id === 'jest'));
});

test('detect playwright by @playwright/test', () => {
  const d = detectFrameworks({ files: ['playwright.config.ts'], manifests: { packageJson: '{"devDependencies":{"@playwright/test":"^1.56"}}' } });
  assert.ok(d.find((x) => x.id === 'playwright'));
});

test('detect cargo-test by Cargo.toml + tests/ dir', () => {
  const d = detectFrameworks({ files: ['tests/test_version.rs', 'src/lib.rs'], manifests: { cargoToml: '[package]\nname = "x"' } });
  assert.ok(d.find((x) => x.id === 'cargo-test'));
});

test('detect go-test by *_test.go', () => {
  const d = detectFrameworks({ files: ['pkg/util_test.go'], manifests: { goMod: 'module x\ngo 1.22' } });
  assert.ok(d.find((x) => x.id === 'go-test'));
});

test('a repo with no test signals detects nothing', () => {
  const d = detectFrameworks({ files: ['README.md', 'src/app.py'], manifests: {} });
  assert.equal(d.length, 0);
});

test('matchWired: a pytest runner wires the detected pytest suite', () => {
  const detected = [{ id: 'pytest', lang: 'python', evidence: 'manifest' }];
  const runners = { unit: { command: 'python', args: ['-m', 'pytest', '-q', 'tests/'] } };
  const { wired, unwired } = matchWired(detected, runners);
  assert.equal(unwired.length, 0);
  assert.equal(wired[0].runner, 'unit');
});

test('matchWired: a detected suite with NO matching runner is UNWIRED (loud)', () => {
  const detected = [
    { id: 'pytest', lang: 'python', evidence: 'manifest' },
    { id: 'playwright', lang: 'js', evidence: 'manifest' },
  ];
  // only pytest is wired; playwright has no runner
  const runners = { unit: { command: 'python', args: ['-m', 'pytest', 'tests/'] } };
  const { wired, unwired } = matchWired(detected, runners);
  assert.equal(wired.length, 1);
  assert.equal(unwired.length, 1);
  assert.equal(unwired[0].id, 'playwright');
});

test('matchWired: cargo nextest in inventory_cmd counts as wiring cargo-test', () => {
  const detected = [{ id: 'cargo-test', lang: 'rust', evidence: 'manifest' }];
  const runners = { cargo: { command: 'cargo', args: ['nextest', 'run'], inventory_cmd: 'cargo nextest list' } };
  const { unwired } = matchWired(detected, runners);
  assert.equal(unwired.length, 0);
});

test('runnerCmdLine includes command, args, and inventory_cmd, lowercased', () => {
  const line = runnerCmdLine({ command: 'Python', args: ['-m', 'PyTest'], inventory_cmd: 'pytest --collect-only' });
  assert.match(line, /python/);
  assert.match(line, /pytest/);
});

// ---------- verdict Pass 7: unwired suites ----------

test('verdict: an unwired suite is a FLAG by default', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
    unwired_suites: [{ id: 'playwright', lang: 'js', evidence: 'manifest' }],
  });
  assert.equal(v.verdict, 'FLAG');
  assert.match(v.reasons.join(' '), /no declared runner: playwright/);
});

test('verdict: an unwired suite FAILs under require_all_suites_wired', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
    unwired_suites: [{ id: 'go-test', lang: 'go', evidence: 'test files' }],
    require_all_suites_wired: true,
  });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons.join(' '), /require_all_suites_wired/);
});

test('verdict: no unwired suites is unaffected (backward compatible)', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
    unwired_suites: [],
  });
  assert.equal(v.verdict, 'PASS');
});
