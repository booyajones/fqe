'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStryker, evaluateMutationGate } = require('../lib/mutation_gate');

function strykerReport(files) {
  // files: { "a.ts": [["Killed",3],["Survived",1]], ... } -> Stryker shape
  const out = { files: {} };
  for (const [path, statuses] of Object.entries(files)) {
    const mutants = [];
    for (const [status, n] of statuses) {
      for (let i = 0; i < n; i++) mutants.push({ status });
    }
    out.files[path] = { mutants };
  }
  return JSON.stringify(out);
}

// ── parseStryker ───────────────────────────────────────────────────────────

test('parseStryker tallies killed and surviving across files', () => {
  const r = parseStryker(strykerReport({
    'a.ts': [['Killed', 8], ['Survived', 2]],
    'b.ts': [['Killed', 10], ['Survived', 0]],
  }));
  assert.equal(r.killed, 18);
  assert.equal(r.surviving, 2);
  assert.equal(r.total, 20);
  assert.equal(r.killRate, 90);
});

test('parseStryker counts Timeout and NoCoverage as surviving (not killed)', () => {
  const r = parseStryker(strykerReport({
    'a.ts': [['Killed', 5], ['Timeout', 2], ['NoCoverage', 3]],
  }));
  assert.equal(r.killed, 5);
  assert.equal(r.surviving, 5);
  assert.equal(r.killRate, 50);
});

test('parseStryker ignores CompileError/RuntimeError/Ignored', () => {
  const r = parseStryker(strykerReport({
    'a.ts': [['Killed', 4], ['Survived', 0], ['CompileError', 9], ['Ignored', 3]],
  }));
  assert.equal(r.total, 4);
  assert.equal(r.killRate, 100);
});

test('parseStryker THROWS on unparseable JSON (fails loud, never a zeroed NEUTRAL)', () => {
  // v0.14.0 HIGH-1: a corrupt report must block, not parse to a 0-mutant NEUTRAL.
  assert.throws(() => parseStryker('not json'), /not valid JSON/);
});

test('parseStryker on a valid-but-empty report -> 0 mutants, null killRate (legitimately neutral later)', () => {
  const r = parseStryker('{"files":{}}');
  assert.equal(r.killRate, null);
  assert.equal(r.total, 0);
});

// ── evaluateMutationGate ───────────────────────────────────────────────────

test('passes when kill rate meets the threshold (via tally)', () => {
  const tally = parseStryker(strykerReport({ 'a.ts': [['Killed', 9], ['Survived', 1]] }));
  const g = evaluateMutationGate({ tally, threshold: 70 });
  assert.equal(g.pass, true);
  assert.equal(g.killRate, 90);
});

test('FAILS when kill rate is below the threshold', () => {
  const tally = parseStryker(strykerReport({ 'a.ts': [['Killed', 5], ['Survived', 5]] }));
  const g = evaluateMutationGate({ tally, threshold: 70 });
  assert.equal(g.pass, false);
  assert.match(g.reasons[0], /MUTATION_KILL_RATE_LOW/);
});

test('exactly at threshold passes', () => {
  const tally = parseStryker(strykerReport({ 'a.ts': [['Killed', 7], ['Survived', 3]] }));
  const g = evaluateMutationGate({ tally, threshold: 70 });
  assert.equal(g.pass, true);
});

test('accepts direct killed/surviving counts (cosmic-ray / Python path)', () => {
  const g = evaluateMutationGate({ killed: 40, surviving: 19, threshold: 60 });
  // 40/59 = 67.8% >= 60
  assert.equal(g.pass, true);
  assert.equal(g.killRate, 67.8);
});

test('changedFiles scopes the gate to just the PR diff', () => {
  const tally = parseStryker(strykerReport({
    'changed.ts': [['Killed', 9], ['Survived', 1]],   // 90% on changed
    'legacy.ts': [['Killed', 1], ['Survived', 9]],    // 10% on legacy (ignored)
  }));
  const g = evaluateMutationGate({ tally, threshold: 70, changedFiles: ['changed.ts'] });
  assert.equal(g.pass, true);
  assert.equal(g.killRate, 90); // legacy.ts excluded
});

test('changedFiles path normalization handles backslashes and ./ prefix', () => {
  const tally = parseStryker(strykerReport({ 'src/changed.ts': [['Killed', 8], ['Survived', 2]] }));
  const g = evaluateMutationGate({ tally, threshold: 70, changedFiles: ['./src\\changed.ts'] });
  assert.equal(g.killRate, 80);
});

test('too few mutants is treated as INSUFFICIENT (neutral), not a silent pass', () => {
  const g = evaluateMutationGate({ killed: 0, surviving: 0, threshold: 70 });
  assert.equal(g.pass, false);
  assert.equal(g.insufficient, true);
  assert.match(g.reasons[0], /MUTATION_INSUFFICIENT/);
});

test('unreadable counts fail closed and flag insufficient', () => {
  const g = evaluateMutationGate({ killed: NaN, surviving: 3, threshold: 70 });
  assert.equal(g.pass, false);
  assert.equal(g.insufficient, true);
  assert.match(g.reasons[0], /MUTATION_REPORT_UNREADABLE/);
});
