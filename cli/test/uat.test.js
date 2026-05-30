'use strict';

/**
 * Table-driven tests for uat.js — DETERMINISTIC + FAIL-CLOSED.
 * Run with: node --test test/uat.test.js
 *
 * Proves the UAT gate's fail-closed properties:
 *   - a missing automated result is NEVER a pass (it is an unverified gap)
 *   - a manual pass with no signer is NEVER acceptance
 *   - strict mode turns any unverified gap into a hard FAIL
 *   - malformed specs throw rather than silently passing
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateUat,
  parseUatYaml,
  loadUatSpec,
  renderUatReport,
  PASS,
  FLAG,
  FAIL,
} = require('../lib/uat');

// ---------------------------------------------------------------------------
// evaluateUat — table-driven verdict cases
// ---------------------------------------------------------------------------

const cases = [
  {
    name: 'automated pass -> covered / PASS',
    input: {
      criteria: [{ id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' }],
      results: { t1: 'pass' },
    },
    expected: PASS,
    check: (r) => {
      assert.equal(r.covered, 1);
      assert.equal(r.automated_covered, 1);
      assert.equal(r.manual_covered, 0);
      assert.equal(r.failed.length, 0);
      assert.equal(r.unverified.length, 0);
    },
  },
  {
    name: 'automated fail -> FAILED / FAIL verdict',
    input: {
      criteria: [{ id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' }],
      results: { t1: 'fail' },
    },
    expected: FAIL,
    check: (r) => {
      assert.equal(r.failed.length, 1);
      assert.equal(r.failed[0].id, 'AC-1');
      assert.equal(r.covered, 0);
    },
  },
  {
    name: 'automated missing result -> UNVERIFIED; FLAG when non-strict',
    input: {
      criteria: [{ id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' }],
      results: {},
      strict: false,
    },
    expected: FLAG,
    check: (r) => {
      assert.equal(r.unverified.length, 1);
      assert.equal(r.unverified[0].id, 'AC-1');
      assert.equal(r.failed.length, 0);
      assert.equal(r.covered, 0);
    },
  },
  {
    name: 'automated missing result -> FAIL when strict',
    input: {
      criteria: [{ id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' }],
      results: {},
      strict: true,
    },
    expected: FAIL,
    check: (r) => {
      assert.equal(r.unverified.length, 1);
      assert.equal(r.failed.length, 0);
    },
  },
  {
    name: 'results omitted entirely defaults to {} -> missing -> FLAG (fail closed, not pass)',
    input: {
      criteria: [{ id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' }],
    },
    expected: FLAG,
    check: (r) => {
      assert.equal(r.unverified.length, 1);
    },
  },
  {
    name: 'manual pass + signoff -> covered / PASS',
    input: {
      criteria: [{
        id: 'AC-2', statement: 'refund posts', verified_by: 'manual',
        status: 'pass', signoff: 'Jane Doe <jane@finexio.com>',
      }],
    },
    expected: PASS,
    check: (r) => {
      assert.equal(r.manual_covered, 1);
      assert.equal(r.automated_covered, 0);
      assert.equal(r.covered, 1);
    },
  },
  {
    name: 'manual pass WITHOUT signoff -> unverified (fail closed) -> FLAG',
    input: {
      criteria: [{
        id: 'AC-2', statement: 'refund posts', verified_by: 'manual', status: 'pass',
      }],
    },
    expected: FLAG,
    check: (r) => {
      assert.equal(r.unverified.length, 1);
      assert.match(r.unverified[0].reason, /signoff/i);
      assert.equal(r.manual_covered, 0);
    },
  },
  {
    name: 'manual pass with whitespace-only signoff -> unverified (fail closed)',
    input: {
      criteria: [{
        id: 'AC-2', statement: 'refund posts', verified_by: 'manual',
        status: 'pass', signoff: '   ',
      }],
    },
    expected: FLAG,
    check: (r) => {
      assert.equal(r.unverified.length, 1);
      assert.equal(r.manual_covered, 0);
    },
  },
  {
    name: 'manual pending -> unverified -> FLAG',
    input: {
      criteria: [{
        id: 'AC-2', statement: 'refund posts', verified_by: 'manual', status: 'pending',
      }],
    },
    expected: FLAG,
    check: (r) => {
      assert.equal(r.unverified.length, 1);
      assert.match(r.unverified[0].reason, /pending|not accepted/i);
    },
  },
  {
    name: 'manual absent status -> unverified -> FLAG',
    input: {
      criteria: [{ id: 'AC-2', statement: 'refund posts', verified_by: 'manual' }],
    },
    expected: FLAG,
    check: (r) => assert.equal(r.unverified.length, 1),
  },
  {
    name: 'manual fail -> FAILED / FAIL verdict',
    input: {
      criteria: [{
        id: 'AC-2', statement: 'refund posts', verified_by: 'manual', status: 'fail',
        signoff: 'Jane Doe',
      }],
    },
    expected: FAIL,
    check: (r) => {
      assert.equal(r.failed.length, 1);
      assert.equal(r.failed[0].id, 'AC-2');
    },
  },
  {
    name: 'mixed: one automated pass + one manual pass+signoff -> PASS, both covered',
    input: {
      criteria: [
        { id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' },
        { id: 'AC-2', statement: 'refund posts', verified_by: 'manual', status: 'pass', signoff: 'Jane' },
      ],
      results: { t1: 'pass' },
    },
    expected: PASS,
    check: (r) => {
      assert.equal(r.automated_covered, 1);
      assert.equal(r.manual_covered, 1);
      assert.equal(r.covered, 2);
      assert.equal(r.coverage_pct, 100);
    },
  },
  {
    name: 'failure beats unverified: one fail + one missing -> FAIL',
    input: {
      criteria: [
        { id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' },
        { id: 'AC-2', statement: 'refund posts', verified_by: 'test:t2' },
      ],
      results: { t1: 'fail' },
    },
    expected: FAIL,
    check: (r) => {
      assert.equal(r.failed.length, 1);
      assert.equal(r.unverified.length, 1);
    },
  },
  {
    name: 'unrecognized automated result value -> unverified (fail closed), not pass',
    input: {
      criteria: [{ id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' }],
      results: { t1: 'skipped' },
    },
    expected: FLAG,
    check: (r) => {
      assert.equal(r.unverified.length, 1);
      assert.equal(r.covered, 0);
    },
  },
  {
    name: 'empty criteria -> PASS, coverage 100',
    input: { criteria: [] },
    expected: PASS,
    check: (r) => {
      assert.equal(r.total, 0);
      assert.equal(r.coverage_pct, 100);
    },
  },
];

for (const c of cases) {
  test(c.name, () => {
    const r = evaluateUat(c.input);
    assert.equal(r.verdict, c.expected, `expected ${c.expected}, got ${r.verdict}; reasons: ${r.reasons.join(' | ')}`);
    if (typeof c.check === 'function') c.check(r);
  });
}

// ---------------------------------------------------------------------------
// coverage_pct math
// ---------------------------------------------------------------------------

test('coverage_pct: 2 of 4 = 50.0', () => {
  const r = evaluateUat({
    criteria: [
      { id: 'A', statement: 's', verified_by: 'test:t1' },
      { id: 'B', statement: 's', verified_by: 'test:t2' },
      { id: 'C', statement: 's', verified_by: 'test:t3' },
      { id: 'D', statement: 's', verified_by: 'test:t4' },
    ],
    results: { t1: 'pass', t2: 'pass' },
  });
  assert.equal(r.coverage_pct, 50.0);
  assert.equal(r.covered, 2);
  assert.equal(r.unverified.length, 2);
});

test('coverage_pct: 1 of 3 rounds to 33.3', () => {
  const r = evaluateUat({
    criteria: [
      { id: 'A', statement: 's', verified_by: 'test:t1' },
      { id: 'B', statement: 's', verified_by: 'test:t2' },
      { id: 'C', statement: 's', verified_by: 'test:t3' },
    ],
    results: { t1: 'pass' },
  });
  assert.equal(r.coverage_pct, 33.3);
});

test('coverage_pct: 2 of 3 rounds to 66.7', () => {
  const r = evaluateUat({
    criteria: [
      { id: 'A', statement: 's', verified_by: 'test:t1' },
      { id: 'B', statement: 's', verified_by: 'test:t2' },
      { id: 'C', statement: 's', verified_by: 'test:t3' },
    ],
    results: { t1: 'pass', t2: 'pass' },
  });
  assert.equal(r.coverage_pct, 66.7);
});

test('coverage_pct: 0 of 0 = 100', () => {
  const r = evaluateUat({ criteria: [] });
  assert.equal(r.coverage_pct, 100);
});

// ---------------------------------------------------------------------------
// validation — fail closed (throws)
// ---------------------------------------------------------------------------

const throwCases = [
  {
    name: 'criteria not an array -> throws',
    input: { criteria: 'nope' },
  },
  {
    name: 'criteria omitted -> throws',
    input: {},
  },
  {
    name: 'non-object input -> throws',
    input: null,
  },
  {
    name: 'criterion missing id -> throws',
    input: { criteria: [{ statement: 's', verified_by: 'manual' }] },
  },
  {
    name: 'criterion missing statement -> throws',
    input: { criteria: [{ id: 'A', verified_by: 'manual' }] },
  },
  {
    name: 'criterion missing verified_by -> throws',
    input: { criteria: [{ id: 'A', statement: 's' }] },
  },
  {
    name: 'criterion id wrong type -> throws',
    input: { criteria: [{ id: 7, statement: 's', verified_by: 'manual' }] },
  },
  {
    name: 'verified_by neither manual nor test: -> throws',
    input: { criteria: [{ id: 'A', statement: 's', verified_by: 'auto' }] },
  },
  {
    name: 'verified_by "test:" with empty id -> throws',
    input: { criteria: [{ id: 'A', statement: 's', verified_by: 'test:' }] },
  },
  {
    name: 'duplicate ids -> throws',
    input: {
      criteria: [
        { id: 'A', statement: 's', verified_by: 'manual', status: 'pass', signoff: 'x' },
        { id: 'A', statement: 's2', verified_by: 'manual', status: 'pass', signoff: 'y' },
      ],
    },
  },
  {
    name: 'results wrong type (array) -> throws',
    input: {
      criteria: [{ id: 'A', statement: 's', verified_by: 'test:t1' }],
      results: ['pass'],
    },
  },
];

for (const c of throwCases) {
  test(c.name, () => {
    assert.throws(() => evaluateUat(c.input));
  });
}

// ---------------------------------------------------------------------------
// parseUatYaml — round-trips the documented shape
// ---------------------------------------------------------------------------

const SAMPLE_YAML = `# UAT spec for the auth + refund release
version: 1
criteria:
  - id: AC-1
    statement: "User can log in with valid credentials"
    verified_by: "test:auth.login.valid"
  - id: AC-2
    statement: "Refund posts within one billing cycle"
    verified_by: manual
    status: pass
    signoff: "Jane Doe <jane@finexio.com>"
`;

test('parseUatYaml: parses the documented shape (ids, manual+signoff, test: refs)', () => {
  const spec = parseUatYaml(SAMPLE_YAML);
  assert.equal(spec.criteria.length, 2);

  const [a, b] = spec.criteria;
  assert.equal(a.id, 'AC-1');
  assert.equal(a.statement, 'User can log in with valid credentials');
  assert.equal(a.verified_by, 'test:auth.login.valid');

  assert.equal(b.id, 'AC-2');
  assert.equal(b.statement, 'Refund posts within one billing cycle');
  assert.equal(b.verified_by, 'manual');
  assert.equal(b.status, 'pass');
  assert.equal(b.signoff, 'Jane Doe <jane@finexio.com>');
});

test('parseUatYaml: parsed shape feeds evaluateUat and verifies PASS', () => {
  const spec = parseUatYaml(SAMPLE_YAML);
  const r = evaluateUat({
    criteria: spec.criteria,
    results: { 'auth.login.valid': 'pass' },
  });
  assert.equal(r.verdict, PASS);
  assert.equal(r.automated_covered, 1);
  assert.equal(r.manual_covered, 1);
});

test('parseUatYaml: ignores unknown top-level keys before and after criteria', () => {
  const text = `title: Release 1.2
criteria:
  - id: AC-1
    statement: "x"
    verified_by: manual
notes: ignored
`;
  const spec = parseUatYaml(text);
  assert.equal(spec.criteria.length, 1);
  assert.equal(spec.criteria[0].id, 'AC-1');
});

test('parseUatYaml: bare (unquoted) values parse and quotes are stripped', () => {
  const text = `criteria:
  - id: AC-9
    statement: bare value no quotes
    verified_by: test:some.test
`;
  const spec = parseUatYaml(text);
  assert.equal(spec.criteria[0].statement, 'bare value no quotes');
  assert.equal(spec.criteria[0].verified_by, 'test:some.test');
});

test('parseUatYaml: empty input yields empty array (no false fail-closed throw)', () => {
  // A genuinely empty file is not a parse failure; it just has nothing to gate.
  assert.deepEqual(parseUatYaml('').criteria, []);
  assert.deepEqual(parseUatYaml('   \n  \n').criteria, []);
});

test('parseUatYaml: FAIL CLOSED — non-empty spec with an empty criteria block throws', () => {
  // Previously this silently returned { criteria: [] } -> 100% coverage -> PASS.
  assert.throws(() => parseUatYaml('criteria:\n'), /zero items/);
});

test('parseUatYaml: FAIL CLOSED — non-empty spec with a typo\'d top-level key (no criteria found) throws', () => {
  const text = `critera:
  - id: AC-1
    statement: "x"
    verified_by: manual
`;
  assert.throws(() => parseUatYaml(text), /no "criteria:" list/);
});

test('parseUatYaml: parses a BOM-prefixed valid spec', () => {
  const spec = parseUatYaml('﻿' + SAMPLE_YAML);
  assert.equal(spec.criteria.length, 2);
  assert.equal(spec.criteria[0].id, 'AC-1');
  assert.equal(spec.criteria[1].verified_by, 'manual');
});

test('parseUatYaml: throws on non-string input', () => {
  assert.throws(() => parseUatYaml({ criteria: [] }));
});

test('parseUatYaml: validates structure at load time (duplicate ids throw)', () => {
  const text = `criteria:
  - id: AC-1
    statement: "first"
    verified_by: manual
  - id: AC-1
    statement: "dupe"
    verified_by: manual
`;
  assert.throws(() => parseUatYaml(text), /duplicate criterion id/);
});

test('parseUatYaml: throws on a continuation line with no colon', () => {
  const text = `criteria:
  - id: AC-1
    this line has no colon
`;
  assert.throws(() => parseUatYaml(text));
});

test('parseUatYaml: throws on unexpected indentation', () => {
  const text = `criteria:
  - id: AC-1
        statement: deep indent is malformed
`;
  assert.throws(() => parseUatYaml(text));
});

// ---------------------------------------------------------------------------
// loadUatSpec — JSON and YAML
// ---------------------------------------------------------------------------

test('loadUatSpec: parses a JSON string (by leading-brace shape)', () => {
  const json = JSON.stringify({
    criteria: [
      { id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' },
      { id: 'AC-2', statement: 'refund', verified_by: 'manual', status: 'pass', signoff: 'Jane' },
    ],
  });
  const spec = loadUatSpec(json);
  assert.equal(spec.criteria.length, 2);
  assert.equal(spec.criteria[0].verified_by, 'test:t1');
});

test('loadUatSpec: parses JSON by .json filename even when given to JSON.parse', () => {
  const json = '{"criteria":[{"id":"AC-1","statement":"s","verified_by":"manual"}]}';
  const spec = loadUatSpec(json, 'acceptance/uat.json');
  assert.equal(spec.criteria.length, 1);
});

test('loadUatSpec: parses a YAML string', () => {
  const spec = loadUatSpec(SAMPLE_YAML, 'uat.yml');
  assert.equal(spec.criteria.length, 2);
  assert.equal(spec.criteria[1].verified_by, 'manual');
});

test('loadUatSpec: JSON and YAML produce equivalent criteria for the same spec', () => {
  const yamlSpec = loadUatSpec(SAMPLE_YAML, 'uat.yml');
  const jsonSpec = loadUatSpec(
    JSON.stringify({ criteria: yamlSpec.criteria }),
    'uat.json'
  );
  assert.deepEqual(jsonSpec.criteria, yamlSpec.criteria);
});

test('loadUatSpec: throws on invalid JSON', () => {
  assert.throws(() => loadUatSpec('{ not valid json', 'uat.json'));
});

test('loadUatSpec: throws on JSON missing criteria array', () => {
  assert.throws(() => loadUatSpec('{"foo":1}', 'uat.json'));
});

test('loadUatSpec: validates structure — JSON spec with a malformed criterion throws at load', () => {
  // bad verified_by ("auto" is neither manual nor test:<id>) must be rejected
  // at load time, not silently passed through to evaluate.
  const json = '{"criteria":[{"id":"AC-1","statement":"s","verified_by":"auto"}]}';
  assert.throws(() => loadUatSpec(json, 'uat.json'), /invalid verified_by/);
});

test('loadUatSpec: validates structure — JSON spec with a duplicate id throws at load', () => {
  const json = JSON.stringify({
    criteria: [
      { id: 'AC-1', statement: 'a', verified_by: 'manual' },
      { id: 'AC-1', statement: 'b', verified_by: 'manual' },
    ],
  });
  assert.throws(() => loadUatSpec(json, 'uat.json'), /duplicate criterion id/);
});

// ---------------------------------------------------------------------------
// renderUatReport
// ---------------------------------------------------------------------------

test('renderUatReport: returns a non-empty string containing each criterion id', () => {
  const r = evaluateUat({
    criteria: [
      { id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' },
      { id: 'AC-2', statement: 'refund posts', verified_by: 'test:t2' },
      { id: 'AC-3', statement: 'export works', verified_by: 'manual', status: 'pending' },
    ],
    results: { t1: 'pass', t2: 'fail' },
  });
  const report = renderUatReport(r);
  assert.equal(typeof report, 'string');
  assert.ok(report.length > 0);
  // every gap criterion id appears in the report
  assert.match(report, /AC-2/);
  assert.match(report, /AC-3/);
  // verdict + coverage summary appear
  assert.match(report, /UAT FAIL/);
  assert.match(report, /covered/);
});

test('renderUatReport: PASS report has no gaps section detail', () => {
  const r = evaluateUat({
    criteria: [{ id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' }],
    results: { t1: 'pass' },
  });
  const report = renderUatReport(r);
  assert.match(report, /UAT PASS/);
  assert.match(report, /No gaps/);
});

test('renderUatReport: throws on non-object', () => {
  assert.throws(() => renderUatReport(null));
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test('determinism: same input -> same output across 100 calls', () => {
  const input = {
    criteria: [
      { id: 'AC-1', statement: 'logs in', verified_by: 'test:t1' },
      { id: 'AC-2', statement: 'refund', verified_by: 'manual', status: 'pass', signoff: 'Jane' },
      { id: 'AC-3', statement: 'export', verified_by: 'test:t3' },
    ],
    results: { t1: 'pass' },
    strict: false,
  };
  const first = JSON.stringify(evaluateUat(input));
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.stringify(evaluateUat(input)), first);
  }
});

// ---------------------------------------------------------------------------
// exported constants
// ---------------------------------------------------------------------------

test('exports PASS/FLAG/FAIL constants', () => {
  assert.equal(PASS, 'PASS');
  assert.equal(FLAG, 'FLAG');
  assert.equal(FAIL, 'FAIL');
});
