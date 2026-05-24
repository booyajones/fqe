'use strict';

/**
 * Orchestrator tests — composes verified pieces, but composition itself can
 * fail in subtle ways. These tests cover:
 *   - parseConfigYaml correctness on real config shapes
 *   - classify() matches files against glob patterns
 *   - run() with no config -> PASS receipt
 *   - run() with a failing runner -> FAIL receipt
 *   - run() with adversarial stats that exceed canonical threshold -> FLAG
 *   - run() writes both QA-RESULT.yml and QA-RESULT.md
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orchestrator = require('../lib/orchestrator');
const { parseReceiptYaml } = require('../lib/receipt');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-orch-'));
  return dir;
}

function fortyHex(seed = 'a') {
  return seed.repeat(40).slice(0, 40);
}

// ─── parseConfigYaml ────────────────────────────────────────────────────

test('parseConfigYaml: empty input -> empty result', () => {
  const r = orchestrator.parseConfigYaml('');
  assert.deepEqual(r, {});
});

test('parseConfigYaml: comments are ignored', () => {
  const r = orchestrator.parseConfigYaml('# just a comment\n\n');
  assert.deepEqual(r, {});
});

test('parseConfigYaml: runners block with one runner', () => {
  const yaml = `runners:
  web:
    command: "playwright"
    args: ["test"]
    when: ["**/*.tsx", "**/*.jsx"]
    required: true`;
  const r = orchestrator.parseConfigYaml(yaml);
  assert.deepEqual(r.runners.web.command, 'playwright');
  assert.deepEqual(r.runners.web.args, ['test']);
  assert.deepEqual(r.runners.web.when, ['**/*.tsx', '**/*.jsx']);
  assert.equal(r.runners.web.required, true);
});

test('parseConfigYaml: multiple runners', () => {
  const yaml = `runners:
  web:
    command: "playwright"
    args: ["test"]
    when: ["**/*.tsx"]
  excel:
    command: "python3"
    args: ["scripts/excel_diff.py"]
    when: ["**/*.xlsx"]`;
  const r = orchestrator.parseConfigYaml(yaml);
  assert.equal(Object.keys(r.runners).length, 2);
  assert.equal(r.runners.web.command, 'playwright');
  assert.equal(r.runners.excel.command, 'python3');
});

// ─── classify / fileMatches ─────────────────────────────────────────────

test('fileMatches: ** prefix matches nested paths', () => {
  assert.equal(orchestrator.fileMatches('src/app/Foo.tsx', '**/*.tsx'), true);
  assert.equal(orchestrator.fileMatches('Foo.tsx', '**/*.tsx'), true);
  assert.equal(orchestrator.fileMatches('Foo.js', '**/*.tsx'), false);
});

test('fileMatches: exact extension match', () => {
  assert.equal(orchestrator.fileMatches('model.xlsx', '**/*.xlsx'), true);
  assert.equal(orchestrator.fileMatches('model.xls', '**/*.xlsx'), false);
});

test('classify: web runner fires only when web files changed', () => {
  const runnersCfg = {
    web: { command: 'pw', when: ['**/*.tsx'] },
    excel: { command: 'py', when: ['**/*.xlsx'] },
  };
  const r = orchestrator.classify(['src/App.tsx'], runnersCfg);
  assert.deepEqual(r.runners_fired, ['web']);
});

test('classify: multiple matches fire multiple runners', () => {
  const runnersCfg = {
    web: { command: 'pw', when: ['**/*.tsx'] },
    excel: { command: 'py', when: ['**/*.xlsx'] },
  };
  const r = orchestrator.classify(['src/App.tsx', 'data/model.xlsx'], runnersCfg);
  assert.ok(r.runners_fired.includes('web'));
  assert.ok(r.runners_fired.includes('excel'));
});

test('classify: always_run runner fires even with empty diff', () => {
  const runnersCfg = {
    voice: { command: 'vale', always_run: true, when: [] },
  };
  const r = orchestrator.classify([], runnersCfg);
  assert.deepEqual(r.runners_fired, ['voice']);
});

// ─── run() — full orchestration ─────────────────────────────────────────

test('run: no config + no diff -> PASS receipt with no runners', () => {
  const dir = tmpRepo();
  const result = orchestrator.run({
    commitSha: fortyHex('a'),
    outputDir: dir,
    repoDir: dir,
    fqeVersion: '0.1.0',
  });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.classifier.runners_fired, []);
  assert.ok(fs.existsSync(result.ymlPath));
  assert.ok(fs.existsSync(result.mdPath));
  const receipt = parseReceiptYaml(fs.readFileSync(result.ymlPath, 'utf8'));
  assert.equal(receipt.verdict, 'PASS');
  assert.equal(receipt.commit_sha, fortyHex('a'));
});

test('run: config with no-op runner that exits 0 -> PASS', () => {
  const dir = tmpRepo();
  // Use a runner that's guaranteed available on any OS via node
  const yaml = `runners:
  noop:
    command: "node"
    args: ["-e", "process.exit(0)"]
    always_run: true
    required: true
    when: []`;
  fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml);
  const result = orchestrator.run({
    commitSha: fortyHex('b'),
    outputDir: dir,
    repoDir: dir,
    fqeVersion: '0.1.0',
  });
  assert.equal(result.verdict, 'PASS', `reasons: ${result.reasons.join(' | ')}`);
  assert.deepEqual(result.classifier.runners_fired, ['noop']);
});

test('run: config with failing runner -> FAIL', () => {
  const dir = tmpRepo();
  const yaml = `runners:
  failer:
    command: "node"
    args: ["-e", "process.exit(2)"]
    always_run: true
    required: true
    when: []`;
  fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml);
  const result = orchestrator.run({
    commitSha: fortyHex('c'),
    outputDir: dir,
    repoDir: dir,
    fqeVersion: '0.1.0',
  });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.some(r => r.includes('failer')));
});

test('run: runner emits adversarial stats with CI exceeding threshold -> FLAG', () => {
  const dir = tmpRepo();
  const yaml = `runners:
  outbound:
    command: "node"
    args: ["-e", "console.log(JSON.stringify({runner:'outbound',exit_code:0,adversarial_stats:[{runner:'outbound',n:20,successes:2,ci_95:[0.013,0.302],blast_radius:'outbound'}]}))"]
    always_run: true
    required: true
    when: []`;
  fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml);
  const result = orchestrator.run({
    commitSha: fortyHex('d'),
    outputDir: dir,
    repoDir: dir,
    fqeVersion: '0.1.0',
  });
  assert.equal(result.verdict, 'FLAG', `reasons: ${result.reasons.join(' | ')}`);
});

test('run: required runner that did not fire -> FAIL', () => {
  const dir = tmpRepo();
  const yaml = `runners:
  excel:
    command: "node"
    args: ["-e", "process.exit(0)"]
    required: true
    when: ["**/*.xlsx"]`;
  fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml);
  // No xlsx in diff, so excel doesn't fire — but it's required
  const result = orchestrator.run({
    commitSha: fortyHex('e'),
    outputDir: dir,
    repoDir: dir,
    fqeVersion: '0.1.0',
  });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.reasons.some(r => r.includes('excel')));
});

test('run: receipt commit_sha matches input', () => {
  const dir = tmpRepo();
  const sha = fortyHex('f');
  orchestrator.run({
    commitSha: sha,
    outputDir: dir,
    repoDir: dir,
    fqeVersion: '0.1.0',
  });
  const receipt = parseReceiptYaml(fs.readFileSync(path.join(dir, 'QA-RESULT.yml'), 'utf8'));
  assert.equal(receipt.commit_sha, sha);
});

test('run: same inputs produce same verdict (deterministic)', () => {
  const dir = tmpRepo();
  const yaml = `runners:
  noop:
    command: "node"
    args: ["-e", "process.exit(0)"]
    always_run: true
    required: true
    when: []`;
  fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml);
  const sha = fortyHex('a');
  const r1 = orchestrator.run({ commitSha: sha, outputDir: dir, repoDir: dir, fqeVersion: '0.1.0' });
  const r2 = orchestrator.run({ commitSha: sha, outputDir: dir, repoDir: dir, fqeVersion: '0.1.0' });
  assert.equal(r1.verdict, r2.verdict);
  assert.deepEqual(r1.classifier.runners_fired, r2.classifier.runners_fired);
});

test('run: verdict.js rejection (bad adversarial input) -> FAIL not silent PASS', () => {
  const dir = tmpRepo();
  const yaml = `runners:
  bad:
    command: "node"
    args: ["-e", "console.log(JSON.stringify({runner:'bad',exit_code:0,adversarial_stats:[{runner:'bad',n:20,ci_95:[0,0.04]}]}))"]
    always_run: true
    required: true
    when: []`;
  // ↑ Missing blast_radius — verdict.js will throw, orchestrator should convert to FAIL
  fs.writeFileSync(path.join(dir, '.fqe.yml'), yaml);
  const result = orchestrator.run({
    commitSha: fortyHex('a'),
    outputDir: dir,
    repoDir: dir,
    fqeVersion: '0.1.0',
  });
  assert.equal(result.verdict, 'FAIL');
  // verdict.js v3 hardening: missing blast_radius -> FAIL with explicit reason
  // (could be either "rejected input" if thrown OR "missing blast_radius" if returned)
  assert.ok(
    result.reasons.some(r => /blast_radius|rejected/i.test(r)),
    `expected blast_radius or rejected in reasons; got: ${JSON.stringify(result.reasons)}`
  );
});

test('computeContentHash: empty file list returns deterministic sentinel', () => {
  const h1 = orchestrator.computeContentHash([], tmpRepo());
  const h2 = orchestrator.computeContentHash([], tmpRepo());
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[a-f0-9]{64}$/);
});

test('computeContentHash: changes when file content changes', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const h1 = orchestrator.computeContentHash(['a.txt'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'world');
  const h2 = orchestrator.computeContentHash(['a.txt'], dir);
  assert.notEqual(h1, h2);
});
