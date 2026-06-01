#!/usr/bin/env node
'use strict';

/**
 * Spec-mutation runner for fqe's own self-host gate.
 *
 * The fqe `spec-mutate` subcommand is a pure evaluator: it takes a count of
 * mutants generated and killed. This script is the orchestration that PRODUCES
 * that count: it parses the invariant spec, generates every mutant, and for each
 * one writes a mutated copy of the spec and re-runs the spec-anchored test
 * (test/selfhost_spec.test.js) with FQE_SPEC_PATH pointed at the mutant. If the
 * test FAILS the mutant is KILLED (the test is anchored to the spec); if it
 * PASSES the mutant SURVIVED (the test is a tautology).
 *
 * Output (stdout): {"mutantsTotal":N,"mutantsKilled":M} — feed to:
 *   fqe spec-mutate --report <thisOutput>
 *
 * Deterministic: no clock, no randomness. Same spec + same tests -> same counts.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseSpecRules, generateMutants } = require('../lib/spec_mutate');

const CLI_DIR = path.join(__dirname, '..');
const SPEC_PATH = process.argv[2] || path.join(CLI_DIR, 'spec', 'fqe-invariants.spec');
// Absolute path so it resolves the same regardless of the caller's cwd.
const TEST_FILE = process.argv[3] || path.join(CLI_DIR, 'test', 'selfhost_spec.test.js');
const TEST_TIMEOUT_MS = 60000;

const specText = fs.readFileSync(SPEC_PATH, 'utf8');
const lines = specText.split(/\r?\n/);
const rules = parseSpecRules(specText);

// Build mutants for every rule.
const mutants = [];
for (const r of rules) {
  for (const m of generateMutants(r)) mutants.push(m);
}
if (mutants.length === 0) {
  process.stderr.write('fqe_specmutate_run: no mutants generated; cannot judge (fail closed)\n');
  process.exit(1);
}

// Find the spec line index for a rule id (to replace its expression).
function lineIndexFor(id) {
  const re = new RegExp(`^\\s*${id}\\s*:`);
  return lines.findIndex((l) => re.test(l));
}

function runTest(specPath) {
  const r = spawnSync('node', ['--test', TEST_FILE], {
    cwd: CLI_DIR,
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
    env: { ...process.env, FQE_SPEC_PATH: specPath },
  });
  // A spawn failure (node missing) or a signal/timeout kill (status === null)
  // is a RUNNER error, NEVER a kill. Counting either as killed would inflate the
  // kill ratio into a false PASS, so fail closed loudly instead.
  if (r.error) {
    throw new Error(`fqe_specmutate_run: could not run the test (${r.error.message}); cannot judge (fail closed)`);
  }
  if (r.status === null) {
    throw new Error(`fqe_specmutate_run: test terminated by signal ${r.signal} (likely timeout); cannot judge (fail closed)`);
  }
  return r.status; // 0 = passed (survived), non-zero = failed (killed)
}

// Baseline: the test MUST pass on the unmutated spec. If it does not, every
// mutant would "die" for the wrong reason and we cannot trust the kill count.
if (runTest(SPEC_PATH) !== 0) {
  process.stderr.write('fqe_specmutate_run: the anchored test FAILS on the unmutated spec; fix the baseline before judging (fail closed)\n');
  process.exit(1);
}

let killed = 0;
const survivors = [];
for (const m of mutants) {
  const idx = lineIndexFor(m.id);
  if (idx < 0) throw new Error(`fqe_specmutate_run: cannot locate spec line for rule ${m.id}`);
  const mutatedLines = lines.slice();
  mutatedLines[idx] = `${m.id}: ${m.mutated}`;
  // process.pid keeps concurrent runs on the same machine from colliding on a
  // shared /tmp path (idx keeps it unique within this run).
  const tmp = path.join(os.tmpdir(), `fqe-specmut-${process.pid}-${m.id}-${m.operator}-${idx}.spec`);
  fs.writeFileSync(tmp, mutatedLines.join('\n'));
  try {
    // exit !== 0 means the test FAILED against the mutated spec => mutant KILLED.
    if (runTest(tmp) !== 0) killed++;
    else survivors.push(`${m.id}/${m.operator} -> ${m.mutated}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

if (survivors.length > 0) {
  process.stderr.write('SURVIVING spec-mutants (tests not anchored to these):\n');
  for (const s of survivors) process.stderr.write(`  - ${s}\n`);
}
process.stdout.write(JSON.stringify({ mutantsTotal: mutants.length, mutantsKilled: killed }) + '\n');
