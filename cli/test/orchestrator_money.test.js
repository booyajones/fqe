'use strict';

/**
 * v0.15 orchestrator integration: F1 quarantine expiry (the clock lives here), and the
 * A4 money-path heuristic + F9 dead-glob signals wired into the verdict end-to-end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orchestrator = require('../lib/orchestrator');

const { quarantineExpired } = orchestrator;

function tmpRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-om-')); }
function fortyHex(seed = 'a') { return seed.repeat(40).slice(0, 40); }
function isoDaysFrom(base, days) { return new Date(base + days * 24 * 60 * 60 * 1000).toISOString(); }

// Fixed base epoch (stamped here in the test, never inside the clock-free verdict core).
const BASE = Date.parse('2026-05-01T00:00:00Z');

// ── F1 quarantineExpired (pure helper, the orchestrator's clock) ──
test('O1: 13 days < 14-day TTL -> not expired', () => {
  assert.equal(quarantineExpired({ quarantined: true, quarantined_since: '2026-05-01T00:00:00Z' }, isoDaysFrom(BASE, 13)), false);
});
test('O2: 15 days > 14-day TTL -> expired', () => {
  assert.equal(quarantineExpired({ quarantined: true, quarantined_since: '2026-05-01T00:00:00Z' }, isoDaysFrom(BASE, 15)), true);
});
test('O3: exactly 14 days -> not expired (boundary)', () => {
  assert.equal(quarantineExpired({ quarantined: true, quarantined_since: '2026-05-01T00:00:00Z' }, isoDaysFrom(BASE, 14)), false);
});
test('O4: custom ttl 7 honored -> expired at 13 days', () => {
  assert.equal(quarantineExpired({ quarantined: true, quarantined_since: '2026-05-01T00:00:00Z', quarantine_ttl_days: 7 }, isoDaysFrom(BASE, 13)), true);
});
test('O5: garbage since-date fails closed (expired)', () => {
  assert.equal(quarantineExpired({ quarantined: true, quarantined_since: 'last tuesday' }, isoDaysFrom(BASE, 1)), true);
});
test('O6: unparseable finishedAt fails closed (expired)', () => {
  assert.equal(quarantineExpired({ quarantined: true, quarantined_since: '2026-05-01T00:00:00Z' }, 'not-a-date'), true);
});
test('O6b: a non-quarantined runner is never "expired"', () => {
  assert.equal(quarantineExpired({ quarantined: false }, isoDaysFrom(BASE, 99)), false);
});
test('O7: deterministic across 100 calls', () => {
  const cfg = { quarantined: true, quarantined_since: '2026-05-01T00:00:00Z' };
  const at = isoDaysFrom(BASE, 20);
  const first = quarantineExpired(cfg, at);
  for (let i = 0; i < 100; i++) assert.equal(quarantineExpired(cfg, at), first);
});

// ── e2e via run() with a controlled diff (FQE_CHANGED_FILES) ──
function withChangedFiles(list, fn) {
  const prev = process.env.FQE_CHANGED_FILES;
  process.env.FQE_CHANGED_FILES = list.join(',');
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.FQE_CHANGED_FILES; else process.env.FQE_CHANGED_FILES = prev;
  }
}

function writeFile(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const PASS_UNIT = `runners:
  unit:
    command: "node"
    args: ["-e", "process.exit(0)"]
    always_run: true
    required: true
    when: []`;

test('O11 (A4): a money file in the diff with no money policy -> FLAG', () => {
  const dir = tmpRepo();
  writeFile(dir, 'src/ledger/post.js', 'function post(a){ return a; }');
  writeFile(dir, '.fqe.yml', PASS_UNIT);
  const result = withChangedFiles(['src/ledger/post.js'], () =>
    orchestrator.run({ commitSha: fortyHex('a'), outputDir: dir, repoDir: dir, fqeVersion: '0.15.0' }));
  assert.equal(result.verdict, 'FLAG', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /no money policy/.test(r)), result.reasons.join(' | '));
});

test('O12 (A4): O11 + require_money_policy_when_detected -> FAIL', () => {
  const dir = tmpRepo();
  writeFile(dir, 'src/ledger/post.js', 'function post(a){ return a; }');
  writeFile(dir, '.fqe.yml', `require_money_policy_when_detected: true\n${PASS_UNIT}`);
  const result = withChangedFiles(['src/ledger/post.js'], () =>
    orchestrator.run({ commitSha: fortyHex('b'), outputDir: dir, repoDir: dir, fqeVersion: '0.15.0' }));
  assert.equal(result.verdict, 'FAIL', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /BLOCKED \(money detected/.test(r)), result.reasons.join(' | '));
});

test('O13 (A4): a non-money diff with no money policy -> PASS', () => {
  const dir = tmpRepo();
  writeFile(dir, 'src/ui/button.tsx', 'export const B = () => null;');
  writeFile(dir, '.fqe.yml', PASS_UNIT);
  const result = withChangedFiles(['src/ui/button.tsx'], () =>
    orchestrator.run({ commitSha: fortyHex('c'), outputDir: dir, repoDir: dir, fqeVersion: '0.15.0' }));
  assert.equal(result.verdict, 'PASS', result.reasons.join(' | '));
});

test('O14 (F9): a typo dead require_for glob -> FLAG', () => {
  const dir = tmpRepo();
  writeFile(dir, 'src/app.js', 'module.exports = 1;');
  writeFile(dir, '.fqe.yml', `policy:
  require_for:
    - when: ["src/paymnt/**"]
      classes: ["money"]
${PASS_UNIT}`);
  const result = withChangedFiles(['src/app.js'], () =>
    orchestrator.run({ commitSha: fortyHex('d'), outputDir: dir, repoDir: dir, fqeVersion: '0.15.0' }));
  assert.equal(result.verdict, 'FLAG', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /matches no file/.test(r)), result.reasons.join(' | '));
});

test('O-F1 e2e: an EXPIRED quarantine of a failing runner -> FAIL', () => {
  const dir = tmpRepo();
  writeFile(dir, '.fqe.yml', `runners:
  flaky:
    command: "node"
    args: ["-e", "process.exit(1)"]
    always_run: true
    required: true
    quarantined: true
    quarantined_since: "2020-01-01"
    when: []`);
  const result = orchestrator.run({ commitSha: fortyHex('e'), outputDir: dir, repoDir: dir, fqeVersion: '0.15.0' });
  assert.equal(result.verdict, 'FAIL', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /QUARANTINE HAS EXPIRED/.test(r)), result.reasons.join(' | '));
});

test('O-F1 e2e: a FRESH quarantine of a failing runner -> FLAG (today)', () => {
  const dir = tmpRepo();
  const today = new Date().toISOString().slice(0, 10);
  writeFile(dir, '.fqe.yml', `runners:
  flaky:
    command: "node"
    args: ["-e", "process.exit(1)"]
    always_run: true
    required: true
    quarantined: true
    quarantined_since: "${today}"
    when: []`);
  const result = orchestrator.run({ commitSha: fortyHex('f'), outputDir: dir, repoDir: dir, fqeVersion: '0.15.0' });
  assert.equal(result.verdict, 'FLAG', result.reasons.join(' | '));
});
