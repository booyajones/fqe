'use strict';

/**
 * Self-host: fqe's own canonical invariants are ANCHORED to spec/fqe-invariants.spec.
 *
 * This test reads the spec file (NOT the code) for the expected blast-radius
 * thresholds and asserts cli/lib/verdict.js matches. Source independence: the
 * spec is the authority, the code must conform. `fqe spec-mutate` corrupts the
 * spec and re-runs this test; if a corrupted threshold does not break this test,
 * the test was a tautology and the spec-mutation gate FAILs.
 *
 * The spec path is overridable via FQE_SPEC_PATH so the spec-mutate runner can
 * point it at a mutated copy.
 *
 * Run with: node --test test/selfhost_spec.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSpecRules } = require('../lib/spec_mutate');
const { BLAST_RADIUS_THRESHOLDS } = require('../lib/verdict');

const SPEC_PATH = process.env.FQE_SPEC_PATH || path.join(__dirname, '..', 'spec', 'fqe-invariants.spec');

// Map spec rule ids to the verdict.js blast-radius class names they pin.
const RULE_TO_CLASS = Object.freeze({
  BLAST_OUTBOUND: 'outbound',
  BLAST_MCP_READ: 'mcp-read',
  BLAST_MCP_WRITE_OR_FINANCIAL: 'mcp-write-or-financial',
});

function specValues() {
  const rules = parseSpecRules(fs.readFileSync(SPEC_PATH, 'utf8'));
  const out = {};
  for (const r of rules) {
    const n = Number(r.expression.trim());
    if (!Number.isFinite(n)) {
      throw new Error(`selfhost: spec rule ${r.id} is not a numeric value: ${r.expression}`);
    }
    out[r.id] = n;
  }
  return out;
}

test('the spec declares exactly the blast-radius classes the code knows', () => {
  const v = specValues();
  const specClasses = Object.keys(RULE_TO_CLASS).filter((id) => id in v).map((id) => RULE_TO_CLASS[id]).sort();
  assert.deepEqual(specClasses, Object.keys(BLAST_RADIUS_THRESHOLDS).sort());
});

test('verdict.js blast-radius thresholds match the spec (anchored, not tautological)', () => {
  const v = specValues();
  for (const [ruleId, cls] of Object.entries(RULE_TO_CLASS)) {
    assert.equal(
      BLAST_RADIUS_THRESHOLDS[cls],
      v[ruleId],
      `threshold for ${cls} must equal spec ${ruleId} (${v[ruleId]}); code has ${BLAST_RADIUS_THRESHOLDS[cls]}`
    );
  }
});
