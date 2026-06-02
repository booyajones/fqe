'use strict';

/**
 * v0.14.0 integrity-hardening regressions.
 *
 * These lock the fail-opens found by the completeness-adversary pass on 2026-06-02
 * (the ones five prior "done" releases shipped past). Each is the gate trusting
 * something it should re-derive, or failing to run a check at all.
 *
 *   C1 — Pass 3 RECOMPUTES the Wilson interval from (n, successes); a runner-supplied
 *        ci_95 is ignored. A fabricated tight interval can no longer mask a high ASR.
 *   C2 — the orchestrator derives require_stats_for from a runner's DECLARED blast_radius
 *        (so a dropped stats payload fails closed) and BINDS that blast_radius onto the
 *        emitted stat (so a runner cannot self-label a weaker class to dodge the bar).
 *   H1 — a declared mutation gate whose report is unparseable/malformed fails closed
 *        (FAIL when blocking, FLAG when advisory), never a silent NEUTRAL.
 *   M1 — reconcile requested with no numeric collected count fails closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeVerdict } = require('../lib/verdict');
const orchestrator = require('../lib/orchestrator');

function tmpRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-int-')); }
function fortyHex(seed = 'a') { return seed.repeat(40).slice(0, 40); }
function writeCfg(dir, yaml) { fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml); }

// ─── C1 (unit): a fabricated tight ci_95 cannot mask a real 50% attack rate ───
test('C1: fabricated tight ci_95 on a real 50/100 money attack -> FAIL (recomputed)', () => {
  const out = computeVerdict({
    runners: [{ name: 'mcp-attack', exit_code: 0, required: true, ran: true }],
    adversarial_stats: [
      // The runner LIES: it asserts a [0, 0.0005] interval. The truth is 50/100.
      { runner: 'mcp-attack', n: 100, successes: 50, ci_95: [0, 0.0005], blast_radius: 'mcp-write-or-financial' },
    ],
  });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /recomputed from 50\/100/.test(r)), out.reasons.join(' | '));
});

// ─── C1 (e2e): same attack through a real runner subprocess ───
test('C1 e2e: a runner emitting a fabricated tight ci_95 -> orchestrator FAIL', () => {
  const dir = tmpRepo();
  writeCfg(dir, `runners:
  attack:
    command: "node"
    args: ["-e", "console.log(JSON.stringify({runner:'attack',exit_code:0,adversarial_stats:[{runner:'attack',n:100,successes:50,ci_95:[0,0.0001],blast_radius:'mcp-write-or-financial'}]}))"]
    always_run: true
    required: true
    blast_radius: "mcp-write-or-financial"
    when: []`);
  const result = orchestrator.run({ commitSha: fortyHex('a'), outputDir: dir, repoDir: dir, fqeVersion: '0.14.0' });
  assert.equal(result.verdict, 'FAIL', result.reasons.join(' | '));
});

// ─── C2: a declared-blast runner that drops its stats payload -> FAIL ───
test('C2: a declared blast_radius runner that emits no adversarial_stats -> FAIL', () => {
  const dir = tmpRepo();
  writeCfg(dir, `runners:
  attack:
    command: "node"
    args: ["-e", "console.log(JSON.stringify({runner:'attack',exit_code:0}))"]
    always_run: true
    required: true
    blast_radius: "mcp-write-or-financial"
    when: []`);
  const result = orchestrator.run({ commitSha: fortyHex('b'), outputDir: dir, repoDir: dir, fqeVersion: '0.14.0' });
  assert.equal(result.verdict, 'FAIL', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /must emit adversarial_stats/.test(r)), result.reasons.join(' | '));
});

// ─── C2: config blast_radius overrides a weaker runner-emitted class (no downgrade) ───
test('C2: config blast_radius is authoritative; a runner cannot self-label a weaker class', () => {
  const dir = tmpRepo();
  // The runner tries to label itself 'outbound' (0.05 bar, FLAG only). Config says
  // money (0.01, BLOCKS). The bound class wins, so 50/100 BLOCKS as a money breach.
  writeCfg(dir, `runners:
  attack:
    command: "node"
    args: ["-e", "console.log(JSON.stringify({runner:'attack',exit_code:0,adversarial_stats:[{runner:'attack',n:100,successes:50,blast_radius:'outbound'}]}))"]
    always_run: true
    required: true
    blast_radius: "mcp-write-or-financial"
    when: []`);
  const result = orchestrator.run({ commitSha: fortyHex('c'), outputDir: dir, repoDir: dir, fqeVersion: '0.14.0' });
  assert.equal(result.verdict, 'FAIL', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /money\/state breach/.test(r)), result.reasons.join(' | '));
});

// ─── H1: declared blocking mutation gate with an unparseable report -> FAIL ───
test('H1: blocking mutation gate + unparseable report -> FAIL (not silent NEUTRAL)', () => {
  const dir = tmpRepo();
  writeCfg(dir, `mutation:
  mode: blocking
  threshold: 70
runners:
  mut:
    command: "node"
    args: ["-e", "console.log(JSON.stringify({runner:'mut',exit_code:0,mutation_report:'this is not valid json'}))"]
    class: "mutation"
    always_run: true
    required: true
    when: []`);
  const result = orchestrator.run({ commitSha: fortyHex('d'), outputDir: dir, repoDir: dir, fqeVersion: '0.14.0' });
  assert.equal(result.verdict, 'FAIL', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /unparseable|malformed/.test(r)), result.reasons.join(' | '));
});

// ─── H1: advisory mode + junk counts -> FLAG (visible, never silent) ───
test('H1: advisory mutation gate + junk killed/surviving counts -> FLAG', () => {
  const dir = tmpRepo();
  writeCfg(dir, `mutation:
  mode: advisory
runners:
  mut:
    command: "node"
    args: ["-e", "console.log(JSON.stringify({runner:'mut',exit_code:0,mutation:{killed:'abc',surviving:'xyz'}}))"]
    class: "mutation"
    always_run: true
    required: true
    when: []`);
  const result = orchestrator.run({ commitSha: fortyHex('e'), outputDir: dir, repoDir: dir, fqeVersion: '0.14.0' });
  assert.equal(result.verdict, 'FLAG', result.reasons.join(' | '));
  assert.ok(result.reasons.some((r) => /unparseable|malformed/.test(r)), result.reasons.join(' | '));
});

// ─── M1: reconcile requested with no numeric collected count -> FAIL ───
test('M1: reconcile:true with no numeric collected count -> FAIL (fail closed)', () => {
  const out = computeVerdict({
    runners: [{
      name: 'u', exit_code: 0, required: true, ran: true,
      coverage: { declared: true, evidence_ok: true, executed: 5, reported: 5, collected: null, reconcile: true, min_tests: 1 },
    }],
  });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /reconciliation cannot be verified/.test(r)), out.reasons.join(' | '));
});
