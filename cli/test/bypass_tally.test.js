'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tally = require('../lib/bypass_tally');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-tally-'));
}

test('rate is 0 when state dir does not exist', () => {
  const dir = path.join(os.tmpdir(), 'fqe-nonexistent-' + Date.now());
  const r = tally.rate(dir);
  assert.equal(r.numerator, 0);
  assert.equal(r.denominator, 0);
  assert.equal(r.rate, 0);
});

test('appendRun increases denominator', () => {
  const dir = freshDir();
  for (let i = 1; i <= 5; i++) {
    tally.appendRun(dir, { pr: i, commit: 'a'.repeat(40) });
  }
  const r = tally.rate(dir);
  assert.equal(r.denominator, 5);
  assert.equal(r.numerator, 0);
  assert.equal(r.rate, 0);
});

test('appendBypass + appendRun produces real rate', () => {
  const dir = freshDir();
  for (let i = 1; i <= 10; i++) {
    tally.appendRun(dir, { pr: i, commit: 'a'.repeat(40) });
  }
  // 2 bypasses out of 10 runs = 0.2
  tally.appendBypass(dir, { actor: 'chris', pr: 3, commit: 'a'.repeat(40) });
  tally.appendBypass(dir, { actor: 'chris', pr: 7, commit: 'a'.repeat(40) });
  const r = tally.rate(dir);
  assert.equal(r.numerator, 2);
  assert.equal(r.denominator, 10);
  assert.equal(r.rate, 0.2);
});

test('window cutoff excludes old events', () => {
  const dir = freshDir();
  const now = new Date('2026-06-01T00:00:00Z');
  const old = new Date('2026-04-01T00:00:00Z').toISOString();   // 61 days ago
  const recent = new Date('2026-05-28T00:00:00Z').toISOString(); // 4 days ago
  // 1 old run + 4 recent runs + 1 recent bypass
  tally.appendRun(dir, { pr: 1, commit: 'a'.repeat(40), ts: old });
  for (let i = 2; i <= 5; i++) {
    tally.appendRun(dir, { pr: i, commit: 'a'.repeat(40), ts: recent });
  }
  tally.appendBypass(dir, { actor: 'chris', pr: 3, commit: 'a'.repeat(40), ts: recent });
  const r = tally.rate(dir, { windowDays: 14, now });
  assert.equal(r.denominator, 4, 'old run should be excluded by 14d window');
  assert.equal(r.numerator, 1);
  assert.equal(r.rate, 0.25);
});

test('window cutoff includes events exactly at boundary', () => {
  const dir = freshDir();
  const now = new Date('2026-06-01T00:00:00Z');
  const exactly14d = new Date('2026-05-18T00:00:00Z').toISOString();
  tally.appendRun(dir, { pr: 1, commit: 'a'.repeat(40), ts: exactly14d });
  const r = tally.rate(dir, { windowDays: 14, now });
  assert.equal(r.denominator, 1, 'event at exactly cutoff should be included');
});

test('rate handles >10% threshold scenarios', () => {
  const dir = freshDir();
  // 12 bypasses in 100 runs = 12% — should be above the 10% trigger
  for (let i = 1; i <= 100; i++) {
    tally.appendRun(dir, { pr: i, commit: 'a'.repeat(40) });
  }
  for (let i = 1; i <= 12; i++) {
    tally.appendBypass(dir, { actor: 'chris', pr: i, commit: 'a'.repeat(40) });
  }
  const r = tally.rate(dir);
  assert.equal(r.numerator, 12);
  assert.equal(r.denominator, 100);
  assert.equal(r.rate, 0.12);
  assert.ok(r.rate > 0.10, '12% should exceed the 10% trigger threshold');
});

test('rejects invalid event', () => {
  const dir = freshDir();
  assert.throws(() => tally.appendBypass(dir, { pr: -1, commit: 'a'.repeat(40), actor: 'x' }));
  assert.throws(() => tally.appendBypass(dir, { pr: 1, commit: 'not-hex', actor: 'x' }));
  assert.throws(() => tally.appendBypass(dir, { pr: 1, commit: 'a'.repeat(40), ts: 'garbage', actor: 'x' }));
  assert.throws(() => tally.appendBypass(dir, { pr: 1, commit: 'a'.repeat(40), actor: '' }));
});

test('rejects bad windowDays', () => {
  const dir = freshDir();
  assert.throws(() => tally.rate(dir, { windowDays: 0 }));
  assert.throws(() => tally.rate(dir, { windowDays: -5 }));
});

test('readJsonl rejects malformed line', () => {
  const dir = freshDir();
  const f = path.join(dir, tally.BYPASS_FILE);
  fs.writeFileSync(f, '{"ok":1}\n{not-json}\n');
  assert.throws(() => tally._readJsonl(f), /line 2 not valid JSON/);
});

test('persistence survives separate process boundaries (simulated)', () => {
  const dir = freshDir();
  tally.appendRun(dir, { pr: 1, commit: 'a'.repeat(40) });
  tally.appendBypass(dir, { actor: 'chris', pr: 1, commit: 'a'.repeat(40) });
  // simulate restart: directly read the files via a fresh require (here we just
  // re-read them via the existing module, which uses fs each call)
  const r = tally.rate(dir);
  assert.equal(r.numerator, 1);
  assert.equal(r.denominator, 1);
  assert.equal(r.rate, 1.0);
});
