'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateRatchet,
  parseCoverage,
  parseJsonSummary,
  parseCoveragePyJson,
  parseCobertura,
  parseLcov,
} = require('../lib/coverage_ratchet');

// ── RATCHET RULE: total may never drop below baseline ──────────────────────

test('ratchet passes when total holds exactly at baseline', () => {
  const r = evaluateRatchet({ currentTotal: 80, baselineTotal: 80, patchCoverage: null });
  assert.equal(r.pass, true);
  assert.equal(r.reasons.length, 0);
});

test('ratchet passes when total rises and flags a baseline bump', () => {
  const r = evaluateRatchet({ currentTotal: 85.2, baselineTotal: 80, patchCoverage: null });
  assert.equal(r.pass, true);
  assert.equal(r.shouldBumpBaseline, true);
  assert.equal(r.newBaseline, 85.2);
});

test('ratchet FAILS when total drops below baseline', () => {
  const r = evaluateRatchet({ currentTotal: 78.5, baselineTotal: 80, patchCoverage: null });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /COVERAGE_RATCHET_DROP/);
  assert.equal(r.shouldBumpBaseline, false);
});

test('a drop within float tolerance is NOT a failure', () => {
  const r = evaluateRatchet({ currentTotal: 79.995, baselineTotal: 80, patchCoverage: null });
  assert.equal(r.pass, true);
});

test('a hold at baseline does not bump the baseline', () => {
  const r = evaluateRatchet({ currentTotal: 80, baselineTotal: 80, patchCoverage: null });
  assert.equal(r.shouldBumpBaseline, false);
  assert.equal(r.newBaseline, null);
});

test('first run with no baseline passes and establishes the baseline', () => {
  const r = evaluateRatchet({ currentTotal: 64.3, baselineTotal: null, patchCoverage: null });
  assert.equal(r.pass, true);
  assert.equal(r.shouldBumpBaseline, true);
  assert.equal(r.newBaseline, 64.3);
});

// ── PATCH RULE: changed lines must clear the threshold ─────────────────────

test('patch rule passes when changed-line coverage meets the threshold', () => {
  const r = evaluateRatchet({ currentTotal: 80, baselineTotal: 80, patchCoverage: 92, patchThreshold: 80 });
  assert.equal(r.pass, true);
});

test('patch rule FAILS when changed lines are under-covered', () => {
  const r = evaluateRatchet({ currentTotal: 80, baselineTotal: 80, patchCoverage: 40, patchThreshold: 80 });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /COVERAGE_PATCH_LOW/);
});

test('patch exactly at threshold passes', () => {
  const r = evaluateRatchet({ currentTotal: 80, baselineTotal: 80, patchCoverage: 80, patchThreshold: 80 });
  assert.equal(r.pass, true);
});

test('both rules can fail at once and both reasons are reported', () => {
  const r = evaluateRatchet({ currentTotal: 70, baselineTotal: 80, patchCoverage: 10, patchThreshold: 80 });
  assert.equal(r.pass, false);
  assert.equal(r.reasons.length, 2);
});

// ── fail-closed on unreadable input ────────────────────────────────────────

test('non-numeric current total fails closed (does not silently pass)', () => {
  const r = evaluateRatchet({ currentTotal: NaN, baselineTotal: 80 });
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /COVERAGE_REPORT_UNREADABLE/);
});

// ── Parsers ────────────────────────────────────────────────────────────────

test('parses vitest/istanbul json-summary', () => {
  const txt = JSON.stringify({ total: { lines: { total: 200, covered: 175, pct: 87.5 } } });
  assert.equal(parseJsonSummary(txt), 87.5);
  assert.equal(parseCoverage(txt), 87.5);
});

test('parses coverage.py json', () => {
  const txt = JSON.stringify({ totals: { percent_covered: 73.42, num_statements: 1000 } });
  assert.equal(parseCoveragePyJson(txt), 73.42);
});

test('parses cobertura line-rate into a percentage', () => {
  const xml = '<?xml version="1.0"?><coverage line-rate="0.7341" branch-rate="0.5">';
  assert.equal(parseCobertura(xml), 73.41);
  assert.equal(parseCoverage(xml), 73.41);
});

test('parses lcov by summing LF/LH records', () => {
  const lcov = ['SF:a.js', 'LF:10', 'LH:8', 'end_of_record', 'SF:b.js', 'LF:10', 'LH:7', 'end_of_record'].join('\n');
  // 15 hit / 20 found = 75%
  assert.equal(parseLcov(lcov), 75);
  assert.equal(parseCoverage(lcov), 75);
});

test('parseCoverage returns null on garbage rather than guessing', () => {
  assert.equal(parseCoverage('not a coverage report'), null);
  assert.equal(parseCoverage(''), null);
  assert.equal(parseCoverage(null), null);
});

test('lcov with zero lines found returns null (avoids divide-by-zero)', () => {
  assert.equal(parseLcov('SF:a.js\nend_of_record'), null);
});
