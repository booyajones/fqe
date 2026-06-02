'use strict';

/**
 * v0.13 Stage B: the mutation-on-diff judge with advisory-first governance.
 * Mutation proves a test would CATCH a planted fault (the only deterministic way to expose
 * an assert-nothing test). Governance: equivalent-mutant allowlist (no chronic false reds),
 * advisory mode (FLAG survivors, not block) until ratcheted to blocking, neutral when too
 * few mutants to judge. It can only ADD a FLAG/FAIL, never clear one (sits below contracts).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStryker, evaluateMutationAdvisory } = require('../lib/mutation_gate');
const { computeVerdict } = require('../lib/verdict');
const { validateConfig } = require('../lib/config_schema');

const REPORT = {
  files: {
    'src/pay.js': {
      mutants: [
        { status: 'Killed', mutatorName: 'Arithmetic', location: { start: { line: 5 } } },
        { status: 'Survived', mutatorName: 'ConditionalExpression', location: { start: { line: 9 } } },
      ],
    },
    'src/other.js': {
      mutants: [{ status: 'Killed', mutatorName: 'BlockStatement', location: { start: { line: 2 } } }],
    },
  },
};

test('parseStryker returns survivors with a stable file:line:mutator key', () => {
  const t = parseStryker(REPORT);
  assert.equal(t.killed, 2);
  assert.equal(t.surviving, 1);
  assert.equal(t.survivors[0].key, 'src/pay.js:9:ConditionalExpression');
});

test('advisory mode: a surviving mutant below threshold is a FLAG (not a block)', () => {
  const r = evaluateMutationAdvisory({ tally: parseStryker(REPORT), mode: 'advisory', threshold: 70 });
  assert.equal(r.verdict, 'FLAG');
  assert.match(r.reasons.join(' '), /advisory/);
});

test('blocking mode: the same survivor is a FAIL', () => {
  const r = evaluateMutationAdvisory({ tally: parseStryker(REPORT), mode: 'blocking', threshold: 70 });
  assert.equal(r.verdict, 'FAIL');
});

test('equivalent-mutant allowlist suppressing the ONLY survivor now FLAGs (F6 ratio cap, was PASS pre-v0.15)', () => {
  // 1 of 1 in-scope survivors suppressed = 100% > 50% cap -> FLAG (advisory, non-blocking).
  const r = evaluateMutationAdvisory({
    tally: parseStryker(REPORT), mode: 'blocking', threshold: 70,
    allowlist: ['src/pay.js:9:ConditionalExpression'],
  });
  assert.equal(r.verdict, 'FLAG');
  assert.equal(r.suppressed, 1);
  assert.equal(r.suppression_cap_tripped, true);
  assert.equal(r.suppression_ratio, 1);
});

test('a single equivalent suppression under an explicit cap of 1.0 still PASSes', () => {
  const r = evaluateMutationAdvisory({
    tally: parseStryker(REPORT), mode: 'blocking', threshold: 70,
    allowlist: ['src/pay.js:9:ConditionalExpression'], maxSuppressionRatio: 1,
  });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.suppression_cap_tripped, false);
});

test('kill rate at/above threshold -> PASS', () => {
  const r = evaluateMutationAdvisory({ tally: parseStryker(REPORT), mode: 'blocking', threshold: 50 });
  assert.equal(r.verdict, 'PASS');
});

test('too few mutants in scope -> NEUTRAL (cannot judge, never a silent pass)', () => {
  const r = evaluateMutationAdvisory({ tally: parseStryker(REPORT), mode: 'blocking', minMutants: 100 });
  assert.equal(r.verdict, 'NEUTRAL');
});

test('diff-scope: a survivor in an unchanged file is out of scope', () => {
  // Only src/other.js changed (no survivors there) -> the pay.js survivor is excluded.
  const r = evaluateMutationAdvisory({
    tally: parseStryker(REPORT), mode: 'blocking', threshold: 70, changedFiles: ['src/other.js'],
  });
  assert.equal(r.verdict, 'PASS', 'the only in-scope mutant was killed');
});

// ---------- verdict Pass 9 ----------

test('verdict: mutation FAIL blocks', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
    mutation: { verdict: 'FAIL', reasons: ['mutation kill rate low [blocking]'] },
  });
  assert.equal(v.verdict, 'FAIL');
});

test('verdict: mutation FLAG is advisory (FLAG, not block)', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
    mutation: { verdict: 'FLAG', reasons: ['mutation kill rate low [advisory]'] },
  });
  assert.equal(v.verdict, 'FLAG');
});

test('verdict: mutation NEUTRAL does not change the verdict', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
    mutation: { verdict: 'NEUTRAL', reasons: ['cannot judge'] },
  });
  assert.equal(v.verdict, 'PASS');
});

test('verdict: no mutation signal is unaffected (backward compatible)', () => {
  const v = computeVerdict({ runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }] });
  assert.equal(v.verdict, 'PASS');
});

// ---------- config_schema ----------

test('config: mutation block validates', () => {
  const res = validateConfig({ version: 1, runners: { u: { command: 'x', always_run: true } },
    mutation: { mode: 'advisory', threshold: 70, min_mutants: 1, allowlist: ['a:1:X'] } });
  assert.equal(res.valid, true, res.errors.join('; '));
});

test('config: mutation.mode must be advisory|blocking', () => {
  const res = validateConfig({ version: 1, runners: {}, mutation: { mode: 'yolo' } });
  assert.equal(res.valid, false);
  assert.match(res.errors.join(' '), /advisory.*blocking/);
});

// ── v0.15 F6: suppression-ratio cap ──────────────────────────────────────────
function tallyOf(killed, survivorFiles) {
  const survivors = survivorFiles.map((f, i) => ({ key: `${f}:${i + 1}:Cond`, file: f, mutator: 'Cond', status: 'Survived' }));
  const perFile = {};
  survivors.forEach((s) => { perFile[s.file] = perFile[s.file] || { killed: 0, surviving: 0 }; perFile[s.file].surviving++; });
  return { killed, surviving: survivors.length, perFile, survivors };
}

test('F6 T2: ratio exactly at cap (1 of 2 suppressed = 0.5) -> PASS (strict >)', () => {
  const r = evaluateMutationAdvisory({ tally: tallyOf(8, ['s/a.js', 's/b.js']), mode: 'blocking', threshold: 70, allowlist: ['s/a.js:1:Cond'] });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.suppression_ratio, 0.5);
  assert.equal(r.suppression_cap_tripped, false);
});

test('F6 T3: ratio just over cap (2 of 3 suppressed, base would pass) -> FLAG', () => {
  const r = evaluateMutationAdvisory({ tally: tallyOf(10, ['s/a.js', 's/b.js', 's/c.js']), mode: 'blocking', threshold: 70, allowlist: ['s/a.js:1:Cond', 's/b.js:2:Cond'] });
  assert.equal(r.verdict, 'FLAG');
  assert.equal(r.suppression_cap_tripped, true);
  assert.ok(r.suppression_ratio > 0.66 && r.suppression_ratio < 0.68);
});

test('F6 T5: zero survivors -> PASS, ratio 0', () => {
  const r = evaluateMutationAdvisory({ tally: tallyOf(10, []), mode: 'blocking', threshold: 70 });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.suppressed, 0);
  assert.equal(r.suppression_ratio, 0);
  assert.equal(r.suppression_cap_tripped, false);
});

test('F6 T6: below-threshold AND suppression tripped -> FLAG with both reasons', () => {
  const r = evaluateMutationAdvisory({ tally: tallyOf(1, ['s/a.js', 's/b.js', 's/c.js']), mode: 'advisory', threshold: 70, allowlist: ['s/a.js:1:Cond', 's/b.js:2:Cond'] });
  assert.equal(r.verdict, 'FLAG');
  const joined = r.reasons.join(' | ');
  assert.match(joined, /below/);
  assert.match(joined, /suppressed/);
});

test('F6 T7: too few mutants (minMutants 100) stays NEUTRAL, never flipped', () => {
  const r = evaluateMutationAdvisory({ tally: parseStryker(REPORT), mode: 'blocking', minMutants: 100 });
  assert.equal(r.verdict, 'NEUTRAL');
});

test('F6 T8: diff-scope denominator counts in-scope survivors only', () => {
  const r = evaluateMutationAdvisory({
    tally: tallyOf(5, ['src/a.js', 'src/b.js']), mode: 'blocking', threshold: 70, changedFiles: ['src/a.js'],
  });
  assert.equal(r.in_scope_survivors, 1, 'only src/a.js survivor is in scope');
});

test('F6 T9: a ratio-cap FLAG makes the overall verdict FLAG', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' }],
    mutation: { verdict: 'FLAG', reasons: ['mutation: 2 of 3 in-scope survivors suppressed [advisory]'] },
  });
  assert.equal(v.verdict, 'FLAG');
});

test('F6 T10: a ratio-cap FLAG can never clear a real FAIL', () => {
  const v = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 1, class: 'unit' }],
    mutation: { verdict: 'FLAG', reasons: ['mutation: suppression cap tripped [advisory]'] },
  });
  assert.equal(v.verdict, 'FAIL');
});
