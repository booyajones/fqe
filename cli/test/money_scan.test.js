'use strict';

/**
 * v0.15 A4 + F9: money-path heuristic + dead require_for glob detection (pure module).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectMoneyPaths, findDeadRequireForGlobs } = require('../lib/money_scan');
const { fileMatches } = require('../lib/orchestrator');
const { hasMoneyPolicy } = require('../lib/config_schema');

// ── detectMoneyPaths ─────────────────────────────────────────────────────────
test('M1: path glob hit src/ledger/post.ts', () => {
  const r = detectMoneyPaths({ changedFiles: ['src/ledger/post.ts'] });
  assert.equal(r.detected, true);
  assert.equal(r.pathHits.length, 1);
});

test('M2: app/payments/charge.js detected by path', () => {
  const r = detectMoneyPaths({ changedFiles: ['app/payments/charge.js'] });
  assert.equal(r.detected, true);
});

test('M3: keyword in a generic path detected via content scan', () => {
  const r = detectMoneyPaths({
    changedFiles: ['src/helpers.ts'],
    fileContents: { 'src/helpers.ts': 'export function run(){ return settlement(); }' },
  });
  assert.equal(r.detected, true);
  assert.ok(r.keywordHits.length >= 1);
});

test('M4: no money (README.md, button.tsx) -> not detected', () => {
  const r = detectMoneyPaths({
    changedFiles: ['README.md', 'src/ui/button.tsx'],
    fileContents: { 'src/ui/button.tsx': 'export const Button = () => <button>Go</button>;' },
  });
  assert.equal(r.detected, false);
});

test('M5: non-scannable extension is not keyword-scanned', () => {
  const r = detectMoneyPaths({
    changedFiles: ['notes/credit.md'],
    fileContents: { 'notes/credit.md': 'we should add a credit feature' },
  });
  assert.equal(r.keywordHits.length, 0);
  assert.equal(r.detected, false);
});

test('M6: indeterminate diff reports indeterminate but does not falsely CLAIM money', () => {
  // Detection is by real signal only; the blind-diff money risk is handled fail-closed by
  // the orchestrator's require_for activation, not by a noisy universal money FLAG.
  const r = detectMoneyPaths({ changedFiles: [], diffIndeterminate: true });
  assert.equal(r.detected, false);
  assert.equal(r.indeterminate, true);
});

test('M7: keyword left-boundary is loose ("debited" matches "debit")', () => {
  const r = detectMoneyPaths({
    changedFiles: ['src/x.ts'],
    fileContents: { 'src/x.ts': 'account was debited by amount' },
  });
  assert.equal(r.detected, true);
});

// ── findDeadRequireForGlobs ──────────────────────────────────────────────────
test('M8: a dead require_for glob is reported', () => {
  const dead = findDeadRequireForGlobs({
    policy: { require_for: [{ when: ['src/paymnt/**'], classes: ['money'] }] },
    repoFiles: ['src/payments/charge.js', 'src/index.ts'],
    fileMatches,
  });
  assert.equal(dead.length, 1);
  assert.equal(dead[0].glob, 'src/paymnt/**');
  assert.equal(dead[0].index, 0);
});

test('M9: a live require_for glob is not dead', () => {
  const dead = findDeadRequireForGlobs({
    policy: { require_for: [{ when: ['src/payments/**'], classes: ['money'] }] },
    repoFiles: ['src/payments/charge.js'],
    fileMatches,
  });
  assert.deepEqual(dead, []);
});

test('M10: mixed live + dead reports only the dead one', () => {
  const dead = findDeadRequireForGlobs({
    policy: { require_for: [{ when: ['src/payments/**', 'src/paymnt/**'], classes: ['money'] }] },
    repoFiles: ['src/payments/charge.js'],
    fileMatches,
  });
  assert.equal(dead.length, 1);
  assert.equal(dead[0].glob, 'src/paymnt/**');
});

test('M10b: no repo files -> cannot judge, no false dead-flag', () => {
  const dead = findDeadRequireForGlobs({
    policy: { require_for: [{ when: ['src/paymnt/**'], classes: ['money'] }] },
    repoFiles: [],
    fileMatches,
  });
  assert.deepEqual(dead, []);
});

// ── hasMoneyPolicy (single source of truth in config_schema) ─────────────────
test('M11: hasMoneyPolicy detects money/contract/idempotency/require_for', () => {
  assert.equal(hasMoneyPolicy({ runners: { m: { class: 'money' } } }), true);
  assert.equal(hasMoneyPolicy({ runners: { c: { class: 'contract' } } }), true);
  assert.equal(hasMoneyPolicy({ require_money_idempotency: true, runners: {} }), true);
  assert.equal(hasMoneyPolicy({ runners: {}, policy: { require_for: [{ when: ['x'], classes: ['money'] }] } }), true);
  assert.equal(hasMoneyPolicy({ runners: { u: { class: 'unit' } } }), false);
});
