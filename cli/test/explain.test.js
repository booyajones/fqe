'use strict';

/**
 * Tests for cli/lib/explain.js (the staff-engineer audit module).
 *
 * Per council 1613ed kill-feature #2: when a skeptical staff engineer pokes
 * `fqe explain`, what they see decides their architectural verdict. These
 * tests pin the contract: invariants are present and accurate, thresholds
 * are sourced live from verdict.js (not duplicated/stale), config parsing
 * is hardened against pathological inputs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { explain, renderExplainText, INVARIANTS, FQE_VERSION } = require('../lib/explain');
const { BLAST_RADIUS_THRESHOLDS } = require('../lib/verdict');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-explain-'));
}

test('explain() returns the three architectural invariants by number + name', () => {
  const data = explain({ dir: freshDir() });
  assert.equal(data.invariants.length, 3);
  assert.equal(data.invariants[0].n, 1);
  assert.match(data.invariants[0].name, /attacker-writable/i);
  assert.equal(data.invariants[1].n, 2);
  assert.match(data.invariants[1].name, /No LLM/i);
  assert.equal(data.invariants[2].n, 3);
  assert.match(data.invariants[2].name, /PR branch/i);
});

test('canonical_thresholds in explain() are LIVE from verdict.js (not duplicated)', () => {
  // If the thresholds in explain.js drift from verdict.js the gate would
  // lie to engineers. This test catches that.
  const data = explain({ dir: freshDir() });
  assert.deepEqual(data.canonical_thresholds, BLAST_RADIUS_THRESHOLDS);
  assert.equal(data.canonical_thresholds.outbound, 0.05);
  assert.equal(data.canonical_thresholds['mcp-read'], 0.03);
  assert.equal(data.canonical_thresholds['mcp-write-or-financial'], 0.01);
});

test('exit code taxonomy lists all 5 codes including INFRA=4', () => {
  const data = explain({ dir: freshDir() });
  assert.match(data.exit_code_taxonomy[0], /PASS/);
  assert.match(data.exit_code_taxonomy[2], /FAIL/);
  assert.match(data.exit_code_taxonomy[3], /FLAG/);
  assert.match(data.exit_code_taxonomy[4], /INFRA|neutral|never blocks/);
  assert.match(data.exit_code_taxonomy[1], /ERROR/);
});

test('explain() returns null config when no .fqe.yml present', () => {
  const data = explain({ dir: freshDir() });
  assert.equal(data.config.present, false);
  assert.equal(data.config.runner_count, 0);
  assert.deepEqual(data.config.runners, []);
});

test('explain() parses a valid .fqe.yml and surfaces runner metadata', () => {
  const dir = freshDir();
  const yaml = `runners:
  web:
    command: "npx"
    args: ["playwright", "test"]
    when: ["**/*.tsx"]
    required: true
  outbound:
    command: "vale"
    args: ["--config", ".vale.ini"]
    when: ["**/templates/**"]`;
  fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml);
  const data = explain({ dir });
  assert.equal(data.config.present, true);
  assert.equal(data.config.runner_count, 2);
  const web = data.config.runners.find(r => r.name === 'web');
  assert.ok(web);
  assert.equal(web.required, true);
  assert.equal(web.command, 'npx');
  assert.deepEqual(web.when, ['**/*.tsx']);
  assert.equal(web.args_count, 2);
});

// Symlink creation requires admin on Windows. Probe once and declare the test
// `skip:true` if we can't, so the test reporter explicitly shows it as skipped
// (not silently passed with zero assertions — reviewer flagged this).
const canSymlink = (() => {
  const probeDir = freshDir();
  const target = path.join(probeDir, 't');
  const link = path.join(probeDir, 's');
  fs.writeFileSync(target, '');
  try { fs.symlinkSync(target, link); return true; }
  catch (_) { return false; }
})();

test('explain() refuses to follow a symlink .fqe.yml', { skip: !canSymlink ? 'symlink creation not permitted on this platform' : false }, () => {
  const dir = freshDir();
  const target = path.join(dir, 'real-file.yml');
  fs.writeFileSync(target, 'runners:\n  web:\n    command: "echo"\n    when: []\n');
  fs.symlinkSync(target, path.join(dir, '.fqe.yml'));
  const data = explain({ dir });
  assert.equal(data.config.present, true);  // path is registered
  assert.equal(data.config.runner_count, 0);  // but no runners parsed
  assert.match(data.config.parse_error || '', /symlink/i);
});

test('explain() rejects oversized .fqe.yml (> 256KB ceiling)', () => {
  const dir = freshDir();
  // Make a 300 KB file (way above the ceiling)
  const big = 'runners:\n' + 'x'.repeat(300 * 1024);
  fs.writeFileSync(path.join(dir, '.fqe.yml'), big);
  const data = explain({ dir });
  assert.match(data.config.parse_error || '', /256|ceiling|exceeds/i);
});

test('explain() surfaces a parse_error when .fqe.yml is malformed', () => {
  const dir = freshDir();
  // A YAML that the orchestrator's permissive parser cannot make sense of
  fs.writeFileSync(path.join(dir, '.fqe.yml'), '!!! not valid at all !!!');
  const data = explain({ dir });
  // present:true is OK (the file exists) as long as parse_error is populated.
  // Reviewer flagged that we MUST verify parse_error is set, not just no-crash.
  assert.equal(data.config.present, true);
  assert.ok(
    data.config.parse_error,
    'expected parse_error to be populated for malformed YAML'
  );
});

test('renderExplainText() includes all 3 invariants by name', () => {
  const data = explain({ dir: freshDir() });
  const text = renderExplainText(data);
  for (const inv of INVARIANTS) {
    assert.ok(text.includes(inv.name), `expected text to include "${inv.name}"`);
  }
});

test('renderExplainText() includes canonical thresholds table', () => {
  const data = explain({ dir: freshDir() });
  const text = renderExplainText(data);
  for (const klass of Object.keys(BLAST_RADIUS_THRESHOLDS)) {
    assert.ok(text.includes(klass), `expected text to include class "${klass}"`);
  }
});

test('renderExplainText() includes the exit code taxonomy', () => {
  const data = explain({ dir: freshDir() });
  const text = renderExplainText(data);
  assert.match(text, /EXIT CODE TAXONOMY/);
  assert.match(text, /INFRA|neutral|never blocks/);
});

test('renderExplainText() includes links to source files', () => {
  const data = explain({ dir: freshDir() });
  const text = renderExplainText(data);
  assert.match(text, /github\.com\/booyajones\/fqe/);
  assert.match(text, /cli\/lib\/verdict\.js/);
});

test('renderExplainText() with no .fqe.yml suggests fqe init', () => {
  const data = explain({ dir: freshDir() });
  const text = renderExplainText(data);
  assert.match(text, /fqe init/);
});

test('renderExplainText() with empty runners explains the no-op state', () => {
  const dir = freshDir();
  // Use block-style empty: `runners:\n` (no value) — the orchestrator parser
  // treats this as `runners = {}` correctly. Inline `runners: {}` is mis-parsed
  // as a 2-char string by the permissive parser (a known limitation, not this
  // test's concern).
  fs.writeFileSync(path.join(dir, '.fqe.yml'), 'runners:\n');
  const data = explain({ dir });
  const text = renderExplainText(data);
  assert.equal(data.config.runner_count, 0);
  assert.match(text, /no runners configured/i);
  assert.match(text, /PASS every PR/);
});

test('FQE_VERSION export is a valid semver-like string', () => {
  assert.match(FQE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('explain() is deterministic when config + dir are unchanged', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, '.fqe.yml'), 'runners:\n');
  const a = explain({ dir });
  const b = explain({ dir });
  // Two calls with the same inputs produce identical structured output.
  // No timestamps, no random IDs in the explain payload by design.
  assert.deepEqual(a, b);
});
