'use strict';

/**
 * Tests for trace.js — REQUIREMENT to TEST traceability gate.
 * Run with: node --test test/trace.test.js
 *
 * Proves the load-bearing behavior:
 *   - a money/security requirement with no test FAILs
 *   - a money/security test with no requirement FAILs
 *   - full bidirectional coverage PASSes
 *   - non-strict gaps (unit, ...) are advisory FLAG-level, NOT a FAIL
 *   - malformed input throws (fail closed)
 *   - orphan detection is exact
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTraceMatrix, evaluateTrace, DEFAULT_STRICT_CLASSES } = require('../lib/trace');

// ── buildTraceMatrix ─────────────────────────────────────────────────────────

test('buildTraceMatrix marks a requirement covered when a test links to it', () => {
  const m = buildTraceMatrix({
    requirements: [{ id: 'R1', class: 'money' }],
    tests: [{ name: 'pays correctly', class: 'money', requirementIds: ['R1'] }],
  });
  assert.deepEqual(m.covered, ['R1']);
  assert.deepEqual(m.orphanRequirements, []);
  assert.deepEqual(m.orphanTests, []);
});

test('buildTraceMatrix reports an uncovered requirement as an orphan requirement', () => {
  const m = buildTraceMatrix({
    requirements: [{ id: 'R1', class: 'money' }, { id: 'R2', class: 'unit' }],
    tests: [{ name: 'covers R1', class: 'money', requirementIds: ['R1'] }],
  });
  assert.deepEqual(m.covered, ['R1']);
  assert.deepEqual(m.orphanRequirements, ['R2']); // exact: only R2
  assert.deepEqual(m.orphanTests, []);
});

test('buildTraceMatrix reports a strict-class test with no requirement as an orphan test', () => {
  const m = buildTraceMatrix({
    requirements: [],
    tests: [{ name: 'tests something', class: 'security', requirementIds: [] }],
  });
  assert.deepEqual(m.orphanTests, ['tests something']); // exact
  assert.deepEqual(m.covered, []);
  assert.deepEqual(m.orphanRequirements, []);
});

test('buildTraceMatrix does NOT treat a non-strict test with no requirement as an orphan test', () => {
  const m = buildTraceMatrix({
    requirements: [],
    tests: [{ name: 'a unit test', class: 'unit', requirementIds: [] }],
  });
  assert.deepEqual(m.orphanTests, []); // unit class is not strict
});

test('buildTraceMatrix: one test covering multiple requirements covers all of them', () => {
  const m = buildTraceMatrix({
    requirements: [{ id: 'R1', class: 'money' }, { id: 'R2', class: 'money' }],
    tests: [{ name: 'covers both', class: 'money', requirementIds: ['R1', 'R2'] }],
  });
  assert.deepEqual(m.covered.sort(), ['R1', 'R2']);
  assert.deepEqual(m.orphanRequirements, []);
});

test('buildTraceMatrix: a test pointing at an undeclared requirement does not invent coverage', () => {
  const m = buildTraceMatrix({
    requirements: [{ id: 'R1', class: 'money' }],
    tests: [{ name: 'points nowhere real', class: 'money', requirementIds: ['GHOST'] }],
  });
  // R1 is still uncovered; GHOST is not a declared requirement so it is not "covered".
  assert.deepEqual(m.covered, []);
  assert.deepEqual(m.orphanRequirements, ['R1']);
});

// ── evaluateTrace: the strict-class FAIL behavior ────────────────────────────

test('a money requirement with no test FAILs', () => {
  const matrix = buildTraceMatrix({
    requirements: [{ id: 'R1', class: 'money' }],
    tests: [],
  });
  const out = evaluateTrace(matrix, { requirements: [{ id: 'R1', class: 'money' }] });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /TRACE_UNCOVERED_REQUIREMENT/.test(r)));
});

test('a security requirement with no test FAILs', () => {
  const requirements = [{ id: 'SEC1', class: 'security' }];
  const matrix = buildTraceMatrix({ requirements, tests: [] });
  const out = evaluateTrace(matrix, { requirements });
  assert.equal(out.verdict, 'FAIL');
});

test('a money test with no requirement FAILs', () => {
  const requirements = [];
  const matrix = buildTraceMatrix({
    requirements,
    tests: [{ name: 'orphan money test', class: 'money', requirementIds: [] }],
  });
  const out = evaluateTrace(matrix, { requirements });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /TRACE_ORPHAN_TEST/.test(r)));
});

test('a security test with no requirement FAILs', () => {
  const requirements = [];
  const matrix = buildTraceMatrix({
    requirements,
    tests: [{ name: 'orphan sec test', class: 'security', requirementIds: [] }],
  });
  const out = evaluateTrace(matrix, { requirements });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /TRACE_ORPHAN_TEST/.test(r)));
});

test('full bidirectional coverage PASSes', () => {
  const requirements = [
    { id: 'R1', class: 'money' },
    { id: 'SEC1', class: 'security' },
    { id: 'U1', class: 'unit' },
  ];
  const matrix = buildTraceMatrix({
    requirements,
    tests: [
      { name: 'covers R1', class: 'money', requirementIds: ['R1'] },
      { name: 'covers SEC1', class: 'security', requirementIds: ['SEC1'] },
      { name: 'covers U1', class: 'unit', requirementIds: ['U1'] },
    ],
  });
  const out = evaluateTrace(matrix, { requirements });
  assert.equal(out.verdict, 'PASS');
  assert.deepEqual(out.reasons, []);
});

test('a unit requirement with no test does NOT FAIL (non-strict -> advisory)', () => {
  const requirements = [{ id: 'U1', class: 'unit' }];
  const matrix = buildTraceMatrix({ requirements, tests: [] });
  const out = evaluateTrace(matrix, { requirements });
  assert.equal(out.verdict, 'PASS');
  // ...but the gap is still reported as advisory.
  assert.ok(out.reasons.some((r) => /TRACE_GAP \(advisory\)/.test(r)));
});

test('strict FAIL coexists with non-strict advisory: a money gap FAILs even with a unit gap', () => {
  const requirements = [{ id: 'R1', class: 'money' }, { id: 'U1', class: 'unit' }];
  const matrix = buildTraceMatrix({ requirements, tests: [] });
  const out = evaluateTrace(matrix, { requirements });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /TRACE_UNCOVERED_REQUIREMENT.*money.*"R1"/.test(r)));
  assert.ok(out.reasons.some((r) => /TRACE_GAP \(advisory\).*unit.*"U1"/.test(r)));
});

test('custom strictClasses can promote unit to a blocking class', () => {
  const requirements = [{ id: 'U1', class: 'unit' }];
  const matrix = buildTraceMatrix({ requirements, tests: [] });
  const out = evaluateTrace(matrix, { requirements, strictClasses: ['unit'] });
  assert.equal(out.verdict, 'FAIL');
});

test('evaluateTrace fails closed when an orphan requirement cannot be classified', () => {
  // matrix has an orphan requirement, but no requirements list is passed to classify it.
  const matrix = { covered: [], orphanRequirements: ['R1'], orphanTests: [] };
  const out = evaluateTrace(matrix, {});
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /TRACE_UNCLASSIFIED_ORPHAN/.test(r)));
});

// ── fail-closed: malformed input throws ──────────────────────────────────────

test('buildTraceMatrix throws on malformed input (fail closed)', () => {
  assert.throws(() => buildTraceMatrix(null));
  assert.throws(() => buildTraceMatrix({}));                                   // missing both arrays
  assert.throws(() => buildTraceMatrix({ requirements: 'x', tests: [] }));     // requirements not array
  assert.throws(() => buildTraceMatrix({ requirements: [], tests: 'x' }));     // tests not array
  assert.throws(() => buildTraceMatrix({ requirements: [{ class: 'money' }], tests: [] })); // req missing id
  assert.throws(() => buildTraceMatrix({ requirements: [{ id: 'R1' }], tests: [] }));       // req missing class
  assert.throws(() => buildTraceMatrix({
    requirements: [],
    tests: [{ class: 'money', requirementIds: [] }],                           // test missing name
  }));
  assert.throws(() => buildTraceMatrix({
    requirements: [],
    tests: [{ name: 't', requirementIds: [] }],                                // test missing class
  }));
  assert.throws(() => buildTraceMatrix({
    requirements: [],
    tests: [{ name: 't', class: 'money', requirementIds: 'R1' }],              // requirementIds not array
  }));
  assert.throws(() => buildTraceMatrix({
    requirements: [],
    tests: [{ name: 't', class: 'money', requirementIds: [123] }],             // non-string requirementId
  }));
});

test('evaluateTrace throws on a malformed matrix (fail closed)', () => {
  assert.throws(() => evaluateTrace(null));
  assert.throws(() => evaluateTrace({}));                                      // missing arrays
  assert.throws(() => evaluateTrace({ covered: [], orphanRequirements: 'x', orphanTests: [] }));
});

test('evaluateTrace throws when the requirements list it is handed is malformed', () => {
  const matrix = { covered: [], orphanRequirements: ['R1'], orphanTests: [] };
  assert.throws(() => evaluateTrace(matrix, { requirements: [{ id: 'R1' }] })); // class missing
});

// ── determinism ──────────────────────────────────────────────────────────────

test('determinism: same input -> same output across 100 calls', () => {
  const requirements = [
    { id: 'R1', class: 'money' },
    { id: 'SEC1', class: 'security' },
    { id: 'U1', class: 'unit' },
  ];
  const tests = [
    { name: 'covers R1', class: 'money', requirementIds: ['R1'] },
    { name: 'orphan unit', class: 'unit', requirementIds: [] },
  ];
  const first = JSON.stringify(evaluateTrace(buildTraceMatrix({ requirements, tests }), { requirements }));
  for (let i = 0; i < 100; i++) {
    const out = JSON.stringify(evaluateTrace(buildTraceMatrix({ requirements, tests }), { requirements }));
    assert.equal(out, first);
  }
});

test('DEFAULT_STRICT_CLASSES is frozen and is money + security', () => {
  assert.deepEqual([...DEFAULT_STRICT_CLASSES], ['money', 'security']);
  assert.ok(Object.isFrozen(DEFAULT_STRICT_CLASSES));
});

// ── fqe-fix regression tests (post-review) ──────────────────────────────────

test('a money test pointing only at a NON-EXISTENT requirement is an orphan -> FAIL', () => {
  // ghost coverage: requirementIds is non-empty but references nothing real.
  const m = buildTraceMatrix({
    requirements: [{ id: 'REQ-1', class: 'money' }],
    tests: [
      { name: 'pays.test', class: 'money', requirementIds: ['DELETED_REQ'] },
      { name: 'covers.test', class: 'money', requirementIds: ['REQ-1'] },
    ],
  });
  assert.ok(m.orphanTests.includes('pays.test'));
  assert.equal(evaluateTrace(m, { requirements: [{ id: 'REQ-1', class: 'money' }] }).verdict, 'FAIL');
});

test('strictClasses: [] cannot suppress a money orphan requirement (floor cannot be narrowed)', () => {
  const reqs = [{ id: 'REQ-1', class: 'money' }];
  const m = buildTraceMatrix({ requirements: reqs, tests: [] });
  assert.deepEqual(m.orphanRequirements, ['REQ-1']);
  const v = evaluateTrace(m, { requirements: reqs, strictClasses: [] });
  assert.equal(v.verdict, 'FAIL');
});

test('duplicate requirement id throws (fail closed)', () => {
  assert.throws(
    () => buildTraceMatrix({ requirements: [{ id: 'R', class: 'money' }, { id: 'R', class: 'unit' }], tests: [] }),
    /duplicate requirement id/
  );
});
