'use strict';

/**
 * Table-driven tests for spec_mutate.js — DETERMINISTIC + FAIL-CLOSED.
 * Run with: node --test test/spec_mutate.test.js
 *
 * These prove the SPEC-MUTATION engine:
 *   - parseSpecRules parses the line format and THROWS on malformed input
 *   - each operator produces the expected mutation
 *   - non-applicable operators return null
 *   - generateMutants is deterministic and skips no-op mutants
 *   - evaluateSpecMutation FAILs on any survivor, PASSes at full kill,
 *     and THROWS on 0 mutants (fail closed)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSpecRules,
  MUTATION_OPERATORS,
  generateMutants,
  evaluateSpecMutation,
} = require('../lib/spec_mutate');

function op(name) {
  const found = MUTATION_OPERATORS.find((o) => o.name === name);
  assert.ok(found, `operator ${name} must exist`);
  return found;
}

// ── parseSpecRules ───────────────────────────────────────────────────────────

test('parseSpecRules parses RULE_ID: expression lines', () => {
  const rules = parseSpecRules('R1: amount > 100\nR2: rounding == HALF_EVEN');
  assert.deepEqual(rules, [
    { id: 'R1', expression: 'amount > 100' },
    { id: 'R2', expression: 'rounding == HALF_EVEN' },
  ]);
});

test('parseSpecRules skips blank lines and # comments', () => {
  const text = [
    '# this is a comment',
    '',
    'R1: x <= 5',
    '   # indented comment',
    '   ',
    'R2: ok == true',
  ].join('\n');
  const rules = parseSpecRules(text);
  assert.deepEqual(rules, [
    { id: 'R1', expression: 'x <= 5' },
    { id: 'R2', expression: 'ok == true' },
  ]);
});

test('parseSpecRules keeps only the first colon as separator', () => {
  const rules = parseSpecRules('R1: label == "a:b"');
  assert.deepEqual(rules, [{ id: 'R1', expression: 'label == "a:b"' }]);
});

test('parseSpecRules THROWS on a line with no colon (malformed)', () => {
  assert.throws(() => parseSpecRules('R1 amount > 100'), /malformed line/);
});

test('parseSpecRules THROWS on a bad rule id', () => {
  assert.throws(() => parseSpecRules('bad id!: x > 1'), /malformed rule id/);
});

test('parseSpecRules THROWS on an empty expression', () => {
  assert.throws(() => parseSpecRules('R1:   '), /empty expression/);
});

test('parseSpecRules THROWS on non-string input (fail closed)', () => {
  assert.throws(() => parseSpecRules(null), /must be a string/);
  assert.throws(() => parseSpecRules(42), /must be a string/);
});

// ── MUTATION_OPERATORS: each operator produces the expected mutation ─────────

const operatorCases = [
  // flip_comparison
  { op: 'flip_comparison', expr: 'a < 5', expect: 'a <= 5' },
  { op: 'flip_comparison', expr: 'a <= 5', expect: 'a < 5' },
  { op: 'flip_comparison', expr: 'a > 5', expect: 'a >= 5' },
  { op: 'flip_comparison', expr: 'a >= 5', expect: 'a > 5' },
  { op: 'flip_comparison', expr: 'a == 5', expect: 'a != 5' },
  { op: 'flip_comparison', expr: 'a != 5', expect: 'a == 5' },
  // longest-match: "<=" must not be read as "<"
  { op: 'flip_comparison', expr: 'fee <= 250 && x > 0', expect: 'fee < 250 && x > 0' },
  { op: 'flip_comparison', expr: 'no comparison here', expect: null },

  // increment_literal (first standalone numeric literal + 1)
  { op: 'increment_literal', expr: 'amount > 100', expect: 'amount > 101' },
  { op: 'increment_literal', expr: 'rate == 2.5', expect: 'rate == 3.5' },
  { op: 'increment_literal', expr: 'x2 == val', expect: null }, // "2" is part of identifier
  { op: 'increment_literal', expr: 'flag == true', expect: null }, // no numeric literal

  // halve_literal (first standalone numeric literal / 2)
  { op: 'halve_literal', expr: 'amount > 100', expect: 'amount > 50' },
  { op: 'halve_literal', expr: 'rate == 5', expect: 'rate == 2.5' },
  { op: 'halve_literal', expr: 'no numbers', expect: null },

  // swap_boolean
  { op: 'swap_boolean', expr: 'ok == true', expect: 'ok == false' },
  { op: 'swap_boolean', expr: 'ok == false', expect: 'ok == true' },
  { op: 'swap_boolean', expr: 'amount > 100', expect: null },

  // swap_rounding (HALF_EVEN -> HALF_UP; others -> DOWN)
  { op: 'swap_rounding', expr: 'mode == HALF_EVEN', expect: 'mode == HALF_UP' },
  { op: 'swap_rounding', expr: 'mode == HALF_UP', expect: 'mode == DOWN' },
  { op: 'swap_rounding', expr: 'mode == CEILING', expect: 'mode == DOWN' },
  { op: 'swap_rounding', expr: 'mode == DOWN', expect: null }, // already DOWN -> no-op
  { op: 'swap_rounding', expr: 'amount > 100', expect: null },
];

for (const c of operatorCases) {
  test(`operator ${c.op} on "${c.expr}" -> ${JSON.stringify(c.expect)}`, () => {
    assert.equal(op(c.op).apply(c.expr), c.expect);
  });
}

test('MUTATION_OPERATORS is frozen and so is each operator', () => {
  assert.ok(Object.isFrozen(MUTATION_OPERATORS));
  for (const o of MUTATION_OPERATORS) {
    assert.ok(Object.isFrozen(o), `${o.name} must be frozen`);
  }
  assert.throws(() => { MUTATION_OPERATORS.push({}); }, TypeError);
});

// ── generateMutants ──────────────────────────────────────────────────────────

test('generateMutants applies every applicable operator, deterministic order', () => {
  const rule = { id: 'R1', expression: 'amount > 100' };
  const mutants = generateMutants(rule);
  // applicable: flip_comparison, increment_literal, halve_literal
  // NOT applicable: swap_boolean, swap_rounding
  assert.deepEqual(mutants.map((m) => m.operator), [
    'flip_comparison',
    'increment_literal',
    'halve_literal',
  ]);
  assert.deepEqual(mutants.map((m) => m.mutated), [
    'amount >= 100',
    'amount > 101',
    'amount > 50',
  ]);
  for (const m of mutants) {
    assert.equal(m.id, 'R1');
    assert.equal(m.original, 'amount > 100');
  }
});

test('generateMutants is deterministic across repeated calls', () => {
  const rule = { id: 'R2', expression: 'rounding == HALF_EVEN' };
  const first = JSON.stringify(generateMutants(rule));
  for (let i = 0; i < 50; i++) {
    assert.equal(JSON.stringify(generateMutants(rule)), first);
  }
});

test('generateMutants returns empty for a rule with no applicable operators', () => {
  // an identifier-only equality with no number, boolean, comparison-flip target,
  // or rounding keyword still has "==", so flip applies. Use a bare token.
  const mutants = generateMutants({ id: 'R3', expression: 'enabled' });
  assert.deepEqual(mutants, []);
});

test('generateMutants combines boolean + comparison operators', () => {
  const mutants = generateMutants({ id: 'R4', expression: 'ok == true' });
  // flip_comparison (== -> !=) and swap_boolean (true -> false) both apply
  assert.deepEqual(mutants.map((m) => m.operator), ['flip_comparison', 'swap_boolean']);
  assert.deepEqual(mutants.map((m) => m.mutated), ['ok != true', 'ok == false']);
});

test('generateMutants THROWS on a malformed rule (fail closed)', () => {
  assert.throws(() => generateMutants(null), /must be an object/);
  assert.throws(() => generateMutants({ id: '', expression: 'x > 1' }), /rule.id/);
  assert.throws(() => generateMutants({ id: 'R1', expression: '' }), /rule.expression/);
});

// ── evaluateSpecMutation ─────────────────────────────────────────────────────

test('evaluateSpecMutation PASSes at full kill (default threshold 1.0)', () => {
  const r = evaluateSpecMutation({ mutantsTotal: 5, mutantsKilled: 5 });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.killRatio, 1);
  assert.equal(r.survived, 0);
  assert.deepEqual(r.reasons, []);
});

test('evaluateSpecMutation FAILs when ANY mutant survives (default threshold)', () => {
  const r = evaluateSpecMutation({ mutantsTotal: 5, mutantsKilled: 4 });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.survived, 1);
  assert.match(r.reasons[0], /SPEC_MUTATION_SURVIVOR/);
});

test('evaluateSpecMutation respects a lower threshold', () => {
  // 3/4 = 0.75 >= 0.7 -> PASS
  const pass = evaluateSpecMutation({ mutantsTotal: 4, mutantsKilled: 3, threshold: 0.7 });
  assert.equal(pass.verdict, 'PASS');
  // 1/4 = 0.25 < 0.7 -> FAIL
  const fail = evaluateSpecMutation({ mutantsTotal: 4, mutantsKilled: 1, threshold: 0.7 });
  assert.equal(fail.verdict, 'FAIL');
});

test('evaluateSpecMutation handles floating kill ratio at the bar', () => {
  // 2/3 = 0.6667 >= 0.6667 threshold -> PASS (epsilon-tolerant)
  const r = evaluateSpecMutation({ mutantsTotal: 3, mutantsKilled: 2, threshold: 2 / 3 });
  assert.equal(r.verdict, 'PASS');
});

test('evaluateSpecMutation THROWS on 0 mutants (fail closed: cannot judge)', () => {
  assert.throws(() => evaluateSpecMutation({ mutantsTotal: 0, mutantsKilled: 0 }), /cannot judge/);
});

test('evaluateSpecMutation THROWS on malformed counts', () => {
  assert.throws(() => evaluateSpecMutation(null), /must be an object/);
  assert.throws(() => evaluateSpecMutation({ mutantsTotal: -1, mutantsKilled: 0 }), /non-negative integer/);
  assert.throws(() => evaluateSpecMutation({ mutantsTotal: 5, mutantsKilled: NaN }), /non-negative integer/);
  assert.throws(() => evaluateSpecMutation({ mutantsTotal: 3, mutantsKilled: 4 }), /cannot exceed/);
  assert.throws(() => evaluateSpecMutation({ mutantsTotal: 5, mutantsKilled: 5, threshold: 1.5 }), /threshold/);
  assert.throws(() => evaluateSpecMutation({ mutantsTotal: 2.5, mutantsKilled: 1 }), /non-negative integer/);
});

test('evaluateSpecMutation is deterministic', () => {
  const input = { mutantsTotal: 7, mutantsKilled: 6, threshold: 0.8 };
  const first = JSON.stringify(evaluateSpecMutation(input));
  for (let i = 0; i < 50; i++) {
    assert.equal(JSON.stringify(evaluateSpecMutation(input)), first);
  }
});

// ── end-to-end: parse -> generate -> evaluate ────────────────────────────────

test('end-to-end: parse a spec, generate mutants, evaluate a full kill', () => {
  const rules = parseSpecRules('R1: fee <= 250\nR2: rounding == HALF_EVEN');
  const allMutants = rules.flatMap(generateMutants);
  assert.ok(allMutants.length >= 4, 'should generate several mutants');
  // Simulate a fully-anchored suite: every spec-mutant killed.
  const r = evaluateSpecMutation({ mutantsTotal: allMutants.length, mutantsKilled: allMutants.length });
  assert.equal(r.verdict, 'PASS');
});

// ── fqe-fix regression tests (post-review) ──────────────────────────────────

test('threshold of 0 throws (a zero-kill gate is no gate)', () => {
  assert.throws(
    () => evaluateSpecMutation({ mutantsTotal: 5, mutantsKilled: 0, threshold: 0 }),
    /threshold must be in \(0, 1\]/
  );
});

test('a compound range rule mutates BOTH bounds and the ceiling literal', () => {
  const mutants = generateMutants({ id: 'AMT', expression: 'amount >= 1 AND amount <= 1000000' });
  const mutated = mutants.map((x) => x.mutated);
  // lower bound flipped: >= -> >
  assert.ok(mutated.includes('amount > 1 AND amount <= 1000000'), 'lower bound >= should flip to >');
  // upper bound flipped: <= -> < (was never touched before the fix)
  assert.ok(mutated.includes('amount >= 1 AND amount < 1000000'), 'upper bound <= should flip to <');
  // ceiling literal perturbed
  assert.ok(mutated.includes('amount >= 1 AND amount <= 1000001'), 'ceiling literal should be incremented');
});

test('a single survivor at scale FAILs even though the kill ratio ROUNDS to 1.0 (gauntlet fqe080)', () => {
  // 19999/20000 = 0.99995 -> round4 -> 1.0000. Gating on the rounded value would
  // PASS despite a surviving tautological mutant. The gate must use the exact ratio.
  const r = evaluateSpecMutation({ mutantsTotal: 20000, mutantsKilled: 19999 });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.survived, 1);
});
