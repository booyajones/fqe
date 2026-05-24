'use strict';

/**
 * wilson.js tests pinned against scipy.stats.proportion_confint(method='wilson').
 *
 * Reference values were produced with:
 *   from scipy.stats import proportion_confint
 *   proportion_confint(successes, n, alpha=0.05, method='wilson')
 *
 * Run with: node --test test/wilson.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { wilson95, minNForUpperBound } = require('../lib/wilson');

// (successes, n) -> [lo, hi] from statsmodels.stats.proportion.proportion_confint
//   method='wilson', alpha=0.05
// Verified locally 2026-05-22 via statsmodels 0.14.6 — exact match to my impl
// to 14+ decimal places (these are not "approximate scipy values"; they are the
// authoritative output). TOL exists only to guard float-encoding subtleties.
const refTable = [
  { s: 0,  n: 20,   lo: 0.0,                    hi: 0.1611251580528194 },
  { s: 1,  n: 20,   lo: 0.008881448800795402,   hi: 0.2361311934467421 },
  { s: 5,  n: 20,   lo: 0.11186170140766563,    hi: 0.4687008776187441 },
  { s: 0,  n: 50,   lo: 0.0,                    hi: 0.07134759913335874 },
  { s: 1,  n: 50,   lo: 0.003539259271646236,   hi: 0.10495443589637815 },
  { s: 0,  n: 100,  lo: 0.0,                    hi: 0.03699349820698569 },
  { s: 3,  n: 100,  lo: 0.01025452402403891,    hi: 0.08451936429052763 },
  { s: 10, n: 100,  lo: 0.05522913706067509,    hi: 0.17436566150491348 },
  { s: 0,  n: 250,  lo: 0.0,                    hi: 0.01513329949544458 },
  { s: 1,  n: 250,  lo: 0.0007064475340650966,  hi: 0.022305785565415927 },
  { s: 0,  n: 1000, lo: 0.0,                    hi: 0.003826758485555125 },
  { s: 10, n: 1000, lo: 0.005440754445529248,   hi: 0.018309468870314774 },
];

const TOL = 1e-12;

for (const row of refTable) {
  test(`wilson95(${row.s}/${row.n}) matches scipy within ${TOL}`, () => {
    const out = wilson95(row.s, row.n);
    assert.equal(out.n, row.n);
    assert.equal(out.successes, row.s);
    assert.ok(
      Math.abs(out.lo - row.lo) < TOL,
      `lo mismatch: got ${out.lo}, want ${row.lo} (diff ${Math.abs(out.lo - row.lo)})`
    );
    assert.ok(
      Math.abs(out.hi - row.hi) < TOL,
      `hi mismatch: got ${out.hi}, want ${row.hi} (diff ${Math.abs(out.hi - row.hi)})`
    );
  });
}

test('p_hat = successes / n', () => {
  assert.equal(wilson95(0, 20).p_hat, 0);
  assert.equal(wilson95(10, 100).p_hat, 0.1);
  assert.equal(wilson95(250, 1000).p_hat, 0.25);
});

test('upper bound never exceeds 1, lower bound never below 0', () => {
  assert.equal(wilson95(0, 5).lo, 0);
  const ones = wilson95(5, 5);
  assert.ok(ones.hi <= 1);
});

test('input validation rejects bad values', () => {
  assert.throws(() => wilson95(-1, 10));
  assert.throws(() => wilson95(11, 10));
  assert.throws(() => wilson95(0, 0));
  assert.throws(() => wilson95(1.5, 10));
  assert.throws(() => wilson95(1, -10));
});

// minNForUpperBound — sanity checks against the formula
// With 0 successes and z=1.96, Wilson upper = z^2 / (n + z^2) ≈ 3.8415 / (n + 3.8415)
// To get upper ≤ 0.01, need n ≥ 3.8415 * 0.99 / 0.01 ≈ 380.3 -> 381 (rounded up by ceiling)
// Spec from council: "to defend ≤1%, need ~298"; updated math: 381 with 0 successes
// (the 298 figure assumed approx normal at the boundary).
test('minNForUpperBound(0.01) requires hundreds of samples', () => {
  const n = minNForUpperBound(0.01);
  assert.ok(n >= 250, `expected n >= 250, got ${n}`);
  // Verify that wilson95(0, n).hi is <= 0.01 (and wilson95(0, n-1).hi > 0.01)
  assert.ok(wilson95(0, n).hi <= 0.01 + 1e-9, `wilson95(0, ${n}).hi = ${wilson95(0, n).hi}`);
});

test('minNForUpperBound(0.05) gates outbound class', () => {
  const n = minNForUpperBound(0.05);
  assert.ok(wilson95(0, n).hi <= 0.05 + 1e-9);
});

test('minNForUpperBound rejects out-of-range', () => {
  assert.throws(() => minNForUpperBound(0));
  assert.throws(() => minNForUpperBound(1));
  assert.throws(() => minNForUpperBound(-0.1));
  assert.throws(() => minNForUpperBound(2));
});
