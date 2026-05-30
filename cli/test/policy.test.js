'use strict';

/**
 * Tests for the v0.7.0 full-suite policy: the `class` taxonomy on runners and
 * the `policy` block (require_classes + diff-conditional require_for).
 * Run with: node --test test/policy.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orchestrator = require('../lib/orchestrator');
const { parseConfigYaml, computeRequiredClasses } = orchestrator;
const { validateConfig } = require('../lib/config_schema');

test('parseConfigYaml parses a policy block with require_classes', () => {
  const cfg = parseConfigYaml([
    'runners:',
    '  unit:',
    '    command: npm',
    '    args: ["test"]',
    '    when: ["src/**"]',
    '    class: unit',
    'policy:',
    '  require_classes: ["unit", "lint"]',
  ].join('\n'));
  assert.deepEqual(cfg.policy.require_classes, ['unit', 'lint']);
  assert.equal(cfg.runners.unit.class, 'unit');
});

test('parseConfigYaml parses require_for list-of-objects', () => {
  const cfg = parseConfigYaml([
    'policy:',
    '  require_classes: ["unit"]',
    '  require_for:',
    '    - when: ["src/payments/**", "src/ledger/**"]',
    '      classes: ["money", "regression"]',
    '    - when: ["api/**"]',
    '      classes: ["contract"]',
    'runners:',
    '  unit:',
    '    command: npm',
    '    when: ["src/**"]',
  ].join('\n'));
  assert.equal(cfg.policy.require_for.length, 2);
  assert.deepEqual(cfg.policy.require_for[0].when, ['src/payments/**', 'src/ledger/**']);
  assert.deepEqual(cfg.policy.require_for[0].classes, ['money', 'regression']);
  assert.deepEqual(cfg.policy.require_for[1].classes, ['contract']);
  // a top-level key after the policy block is still parsed
  assert.ok(cfg.runners.unit);
});

test('parseConfigYaml tolerates unquoted YAML-flow lists', () => {
  const cfg = parseConfigYaml([
    'policy:',
    '  require_classes: [unit, money]',
  ].join('\n'));
  assert.deepEqual(cfg.policy.require_classes, ['unit', 'money']);
});

test('computeRequiredClasses: static require_classes always apply', () => {
  const policy = { require_classes: ['unit', 'lint'] };
  const got = computeRequiredClasses(policy, ['README.md']);
  assert.deepEqual(got.sort(), ['lint', 'unit']);
});

test('computeRequiredClasses: require_for activates only on a glob match', () => {
  const policy = {
    require_classes: ['unit'],
    require_for: [
      { when: ['src/payments/**'], classes: ['money', 'regression'] },
      { when: ['api/**'], classes: ['contract'] },
    ],
  };
  // a payments change pulls in money + regression
  const pay = computeRequiredClasses(policy, ['src/payments/charge.ts']);
  assert.deepEqual(pay.sort(), ['money', 'regression', 'unit']);
  // a docs change pulls in nothing extra
  const docs = computeRequiredClasses(policy, ['docs/x.md']);
  assert.deepEqual(docs, ['unit']);
  // an api change pulls in contract
  const api = computeRequiredClasses(policy, ['api/routes.ts']);
  assert.deepEqual(api.sort(), ['contract', 'unit']);
});

test('computeRequiredClasses: no policy -> empty (backward compatible)', () => {
  assert.deepEqual(computeRequiredClasses(undefined, ['a.ts']), []);
  assert.deepEqual(computeRequiredClasses({}, ['a.ts']), []);
});

test('validateConfig rejects an unknown class on a runner', () => {
  const { valid, errors } = validateConfig({
    runners: { unit: { command: 'npm', when: ['src/**'], class: 'banana' } },
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /not a known test class/.test(e)));
});

test('validateConfig accepts a known class', () => {
  const { valid } = validateConfig({
    runners: { unit: { command: 'npm', when: ['src/**'], class: 'unit' } },
  });
  assert.equal(valid, true);
});

test('validateConfig rejects an unknown class in policy.require_classes', () => {
  const { valid, errors } = validateConfig({
    policy: { require_classes: ['unit', 'nope'] },
    runners: {},
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /policy\.require_classes.*not a known test class/.test(e)));
});

test('validateConfig rejects a malformed require_for entry', () => {
  const { valid, errors } = validateConfig({
    policy: { require_for: [{ when: [], classes: ['money'] }] },
    runners: {},
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /require_for\[0\]\.when/.test(e)));
});

test('validateConfig rejects an unknown policy key', () => {
  const { valid, errors } = validateConfig({
    policy: { require_clasess: ['unit'] },  // typo
    runners: {},
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /policy: unknown key/.test(e)));
});

test('validateConfig: policy with no runners is valid', () => {
  const { valid } = validateConfig({ policy: { require_classes: ['unit'] }, runners: {} });
  assert.equal(valid, true);
});

// --- v0.7.0 hardening (post-code-review) ---

test('computeRequiredClasses fails closed when the diff is indeterminate', () => {
  const policy = {
    require_classes: ['unit'],
    require_for: [
      { when: ['src/payments/**'], classes: ['money'] },
      { when: ['api/**'], classes: ['contract'] },
    ],
  };
  // diff unknown -> every require_for entry activates (strictest set), not dropped
  const got = computeRequiredClasses(policy, [], true);
  assert.deepEqual(got.sort(), ['contract', 'money', 'unit']);
});

test('parseConfigYaml throws on a require_classes key with no value', () => {
  assert.throws(() => parseConfigYaml([
    'policy:',
    '  require_classes:',
  ].join('\n')), /must have an inline list value/);
});

test('parseConfigYaml throws on a require_for entry with empty when', () => {
  assert.throws(() => parseConfigYaml([
    'policy:',
    '  require_for:',
    '    - when:',
    '      classes: ["money"]',
  ].join('\n')), /must have an inline list value/);
});

test('parseConfigYaml throws on an unknown policy key with empty value', () => {
  assert.throws(() => parseConfigYaml([
    'policy:',
    '  bogus_key:',
  ].join('\n')), /must have an inline list value/);
});

// --- end-to-end: run() fails closed on an indeterminate diff (gauntlet fqe070) ---
// Proves the changedFiles().ok === false -> computeRequiredClasses(diffIndeterminate)
// wiring AND the empty-FQE_CHANGED_FILES fail-closed fix, end to end through run().

test('run() fails closed when the diff is indeterminate (empty FQE_CHANGED_FILES)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-indet-'));
  const cfgPath = path.join(dir, '.fqe.yml');
  fs.writeFileSync(cfgPath, [
    'runners: {}',
    'policy:',
    '  require_for:',
    '    - when: ["src/payments/**"]',
    '      classes: ["money"]',
  ].join('\n'));
  const prev = process.env.FQE_CHANGED_FILES;
  process.env.FQE_CHANGED_FILES = ''; // empty => diff indeterminate => fail closed
  try {
    const result = orchestrator.run({
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      configPath: cfgPath,
      outputDir: path.join(dir, 'out'),
      repoDir: dir,
      fqeVersion: '0.7.0',
    });
    // No money runner exists, but an indeterminate diff activates require_for,
    // so the money class is required and missing -> FAIL.
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.reasons.some((r) => /required test class "money"/.test(r)));
  } finally {
    if (prev === undefined) delete process.env.FQE_CHANGED_FILES;
    else process.env.FQE_CHANGED_FILES = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run() with a non-empty FQE_CHANGED_FILES that misses the payments glob does NOT require money', () => {
  // Documents the trust boundary: a CI-provided non-empty diff is authoritative.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-det-'));
  const cfgPath = path.join(dir, '.fqe.yml');
  fs.writeFileSync(cfgPath, [
    'runners: {}',
    'policy:',
    '  require_for:',
    '    - when: ["src/payments/**"]',
    '      classes: ["money"]',
  ].join('\n'));
  const prev = process.env.FQE_CHANGED_FILES;
  process.env.FQE_CHANGED_FILES = 'docs/readme.md';
  try {
    const result = orchestrator.run({
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      configPath: cfgPath,
      outputDir: path.join(dir, 'out'),
      repoDir: dir,
      fqeVersion: '0.7.0',
    });
    assert.equal(result.verdict, 'PASS'); // docs change does not touch payments
  } finally {
    if (prev === undefined) delete process.env.FQE_CHANGED_FILES;
    else process.env.FQE_CHANGED_FILES = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
