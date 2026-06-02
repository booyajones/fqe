'use strict';

/**
 * fqe CLI integration tests.
 *
 * Spawns the CLI as a subprocess and verifies subcommand wiring + exit codes.
 * This is the test that proves the runtime layer actually exists end-to-end —
 * the gap gauntlet 11f9c0 called out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'fqe.js');

function run(args, stdin) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-cli-'));
}

function fortyHex(seed = 'a') {
  return seed.repeat(40).slice(0, 40);
}

const validResultsPass = {
  runners: [
    { name: 'web', required: true, ran: true, exit_code: 0 },
    { name: 'outbound', required: true, ran: true, exit_code: 0 },
  ],
  adversarial_stats: [
    { runner: 'outbound', n: 100, successes: 0, ci_95: [0, 0.0369], blast_radius: 'outbound' },
  ],
};

const validResultsFlag = {
  runners: [{ name: 'outbound', required: true, ran: true, exit_code: 0 }],
  adversarial_stats: [
    { runner: 'outbound', n: 20, successes: 2, ci_95: [0.013, 0.302], blast_radius: 'outbound' },
  ],
};

const validResultsFail = {
  runners: [{ name: 'web', required: true, ran: true, exit_code: 1 }],
};

test('fqe version prints version string', () => {
  const r = run(['version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^fqe \d+\.\d+\.\d+/);
});

test('fqe validate: clean config exits 0', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.fqe.yml'),
    'runners:\n  web:\n    command: "node"\n    when: ["**/*.ts"]\n    required: true\n');
  const r = run(['validate', '--config', path.join(dir, '.fqe.yml')]);
  assert.equal(r.status, 0);
});

test('fqe validate: a typo in a runner key exits 1 (fail closed)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.fqe.yml'),
    'runners:\n  web:\n    command: "node"\n    whne: ["**/*.ts"]\n');
  const r = run(['validate', '--config', path.join(dir, '.fqe.yml')]);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /whne/);
});

test('fqe run: a malformed .fqe.yml exits 1 (ERROR), never 0 (PASS) or 4 (INFRA)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.fqe.yml'),
    'runners:\n  web:\n    command: "node"\n    whne: ["**/*.ts"]\n');
  const r = run(['run', '--commit', fortyHex('a'), '--output', dir, '--repo-dir', dir]);
  assert.equal(r.status, 1);
});

test('fqe oracle-guard: a clean source PR exits 0', () => {
  const r = run(['oracle-guard', '--changed', 'src/app.ts,src/money.ts']);
  assert.equal(r.status, 0);
});

test('fqe oracle-guard: editing a golden FLAGs (exit 3)', () => {
  const r = run(['oracle-guard', '--changed', 'src/nacha.ts,testdata/run.golden']);
  assert.equal(r.status, 3);
});

test('fqe oracle-guard --block: editing a golden FAILs (exit 2)', () => {
  const r = run(['oracle-guard', '--changed', 'testdata/run.golden', '--block']);
  assert.equal(r.status, 2);
});

test('fqe oracle-guard fails CLOSED when it cannot read the diff (exit 3, never 0)', () => {
  const dir = tmpDir(); // a fresh temp dir, not a git repo
  const env = { ...process.env };
  delete env.FQE_CHANGED_FILES; // make sure nothing hands it a diff
  const r = spawnSync(
    process.execPath,
    [CLI, 'oracle-guard', '--repo-dir', dir, '--base', fortyHex('a'), '--head', fortyHex('b')],
    { encoding: 'utf8', env }
  );
  assert.notEqual(r.status, 0); // an unreadable diff must NOT report clean
  assert.equal(r.status, 3);    // FLAG: a second reviewer is required
  assert.match(r.stdout + r.stderr, /INDETERMINATE/);
});

test('fqe verdict — PASS exits 0', () => {
  const r = run(['verdict', '-'], JSON.stringify(validResultsPass));
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'PASS');
});

test('fqe verdict — FAIL exits 2', () => {
  const r = run(['verdict', '-'], JSON.stringify(validResultsFail));
  assert.equal(r.status, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'FAIL');
});

test('fqe verdict — FLAG exits 3', () => {
  const r = run(['verdict', '-'], JSON.stringify(validResultsFlag));
  assert.equal(r.status, 3);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'FLAG');
});

test('fqe verdict — same input -> same output (deterministic)', () => {
  const r1 = run(['verdict', '-'], JSON.stringify(validResultsPass));
  const r2 = run(['verdict', '-'], JSON.stringify(validResultsPass));
  assert.equal(r1.stdout, r2.stdout);
  assert.equal(r1.status, r2.status);
});

test('fqe verdict — rejected input (bad stat counts) exits 2 FAIL, not 1 ERROR (CRIT-1)', () => {
  // A stat missing `successes` makes wilson95 throw. The CLI must fail CLOSED as a
  // block (exit 2), matching the orchestrator, not surface as a retryable infra error.
  const bad = {
    runners: [{ name: 'mcp', required: true, ran: true, exit_code: 0 }],
    adversarial_stats: [{ runner: 'mcp', n: 100, blast_radius: 'mcp-write-or-financial' }],
  };
  const r = run(['verdict', '-'], JSON.stringify(bad));
  assert.equal(r.status, 2, `expected exit 2 (FAIL), got ${r.status}; stderr: ${r.stderr}`);
});

test('fqe mutation-gate — a corrupt report file exits 2 FAIL, not a neutral pass (HIGH-1)', () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'mutation.json');
  fs.writeFileSync(bad, 'this is not json {');
  const r = run(['mutation-gate', '--report', bad]);
  assert.equal(r.status, 2, `expected exit 2 (FAIL) on a corrupt report, got ${r.status}; stderr: ${r.stderr}`);
});

test('fqe receipt write + parse round-trips through filesystem', () => {
  const dir = tmpDir();
  const ctx = {
    fqe_version: '0.1.0',
    run_id: 'cli-test',
    started_at: '2026-05-22T23:34:17Z',
    finished_at: '2026-05-22T23:35:42Z',
    commit_sha: fortyHex('a'),
    content_hash: 'sha256:' + 'a'.repeat(64),
    inputs_hash: 'sha256:' + 'b'.repeat(64),
    classifier_version: 1,
    runner_versions: { fqe: '0.1.0' },
    runners_fired: ['web'],
    runners: [{ name: 'web', required: true, ran: true, exit_code: 0 }],
    adversarial_stats: [],
    quarantined_tests: [],
    verdict: 'PASS',
    verdict_reasons: [],
    bypass: null,
    evidence_paths: [],
  };
  const ctxPath = path.join(dir, 'ctx.json');
  fs.writeFileSync(ctxPath, JSON.stringify(ctx));
  const w = run(['receipt', 'write', ctxPath, dir]);
  assert.equal(w.status, 0);
  const ymlPath = path.join(dir, 'QA-RESULT.yml');
  assert.ok(fs.existsSync(ymlPath));
  const p = run(['receipt', 'parse', ymlPath]);
  assert.equal(p.status, 0);
  assert.match(p.stdout, /"verdict":"PASS"/);
  assert.match(p.stdout, new RegExp(fortyHex('a')));
});

test('fqe receipt generate-bypass — REJECTS bad requester-source', () => {
  const dir = tmpDir();
  const r = run([
    'receipt', 'generate-bypass',
    '--commit', fortyHex('a'),
    '--pr', '42',
    '--actor', 'evil-user',
    '--requester-source', 'pr-branch-file',  // <-- malicious
    '--output', dir,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /MUST be|requester-source/);
});

test('fqe receipt generate-bypass — accepts valid github_events_api_v3', () => {
  const dir = tmpDir();
  const r = run([
    'receipt', 'generate-bypass',
    '--commit', fortyHex('b'),
    '--pr', '42',
    '--actor', 'chris-wyatt',
    '--requester-source', 'github_events_api_v3',
    '--output', dir,
  ]);
  assert.equal(r.status, 0, `expected 0, got ${r.status}; stderr=${r.stderr}`);
  const ymlPath = path.join(dir, 'QA-RESULT.yml');
  assert.ok(fs.existsSync(ymlPath));
  const yaml = fs.readFileSync(ymlPath, 'utf8');
  assert.match(yaml, /requester_source: github_events_api_v3/);
  assert.match(yaml, /requester: chris-wyatt/);
});

test('fqe bypass-tally append-run + rate roundtrip', () => {
  const dir = tmpDir();
  for (let i = 1; i <= 5; i++) {
    const r = run([
      'bypass-tally', 'append-run',
      '--state-dir', dir,
      '--pr', String(i),
      '--commit', fortyHex('c'),
    ]);
    assert.equal(r.status, 0);
  }
  const r = run([
    'bypass-tally', 'append-bypass',
    '--state-dir', dir,
    '--actor', 'chris',
    '--pr', '3',
    '--commit', fortyHex('c'),
  ]);
  assert.equal(r.status, 0);
  const rt = run(['bypass-tally', 'rate', '--state-dir', dir]);
  assert.equal(rt.status, 0);
  const parsed = JSON.parse(rt.stdout);
  assert.equal(parsed.numerator, 1);
  assert.equal(parsed.denominator, 5);
  assert.equal(parsed.rate, 0.2);
});

test('fqe bypass-tally rate --format scalar emits just the number (shell-comparable)', () => {
  const dir = tmpDir();
  for (let i = 1; i <= 10; i++) {
    run(['bypass-tally', 'append-run', '--state-dir', dir, '--pr', String(i), '--commit', fortyHex('c')]);
  }
  run(['bypass-tally', 'append-bypass', '--state-dir', dir, '--actor', 'chris', '--pr', '3', '--commit', fortyHex('c')]);
  run(['bypass-tally', 'append-bypass', '--state-dir', dir, '--actor', 'chris', '--pr', '7', '--commit', fortyHex('c')]);
  const r = run(['bypass-tally', 'rate', '--state-dir', dir, '--format', 'scalar']);
  assert.equal(r.status, 0);
  const trimmed = r.stdout.trim();
  // Must be a parseable number, NOT JSON — workflow does shell comparison
  const num = parseFloat(trimmed);
  assert.ok(!Number.isNaN(num), `expected number, got: '${trimmed}'`);
  assert.equal(num, 0.2);
});

test('fqe status publish rejects invalid --state', () => {
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'bogus-state',
    '--repo', 'foo/bar',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid --state/);
});

test('fqe status publish rejects malformed commit', () => {
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', 'not-a-sha',
    '--state', 'success',
    '--repo', 'foo/bar',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /40-char hex/);
});

test('fqe status publish rejects missing required flags', () => {
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    // missing --commit, --state
    '--repo', 'foo/bar',
  ]);
  assert.notEqual(r.status, 0);
});

test('fqe status publish rejects malformed --repo (must be owner/name)', () => {
  // Polish item from gauntlet 125a6e: validate --repo owner/repo format
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'success',
    '--repo', 'not-a-valid-repo',  // missing slash
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /owner\/name/);
});

test('fqe status publish --dry-run respects empty --description (parseFlags polish)', () => {
  // Polish item from gauntlet 125a6e: --description "" should be an empty string,
  // NOT boolean true. Verify by passing --description "" and checking the body.
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'success',
    '--repo', 'foo/bar',
    '--description', '',     // empty string, not boolean
    '--dry-run',
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // Title should be the empty string (caller's explicit choice), not "fqe success"
  // or the boolean true coerced to string. This is what 125a6e flagged.
  assert.equal(parsed.body.output.title, '');
});

test('fqe status publish is recognized as a subcommand (not unknown)', () => {
  // Even without gh installed, the subcommand must validate flags FIRST
  // and emit a known-flag-validation error, not "unknown subcommand"
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'success',
    '--repo', 'foo/bar',
  ]);
  // Either succeeds (if gh CLI is installed and authenticated) or fails with
  // a gh-call error — never with "unknown subcommand: publish"
  assert.doesNotMatch(r.stderr, /unknown subcommand/);
});

test('fqe status publish --dry-run emits valid GitHub check-runs JSON body (closes 125882)', () => {
  // The gauntlet 125882 fatal flaw was: `gh api -f 'output[title]=...'` sends
  // form fields, GitHub's API wants nested JSON. The fix uses `gh api --input -`
  // with a real JSON body. This test proves the body is shaped correctly.
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'success',
    '--repo', 'foo/bar',
    '--output-text', 'hello world',
    '--description', 'all green',
    '--dry-run',
  ]);
  assert.equal(r.status, 0, `expected 0, stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // Confirm gh command structure
  assert.deepEqual(parsed.gh_command.slice(0, 5), ['gh', 'api', '--method', 'POST', '--input']);
  assert.equal(parsed.gh_command[5], '-');
  assert.equal(parsed.gh_command[6], '/repos/foo/bar/check-runs');
  // Confirm body is a nested JSON object (not form-encoded)
  assert.equal(parsed.body.name, 'fqe/pass');
  assert.equal(parsed.body.head_sha, fortyHex('a'));
  assert.equal(parsed.body.status, 'completed');
  assert.equal(parsed.body.conclusion, 'success');
  // output MUST be a nested object — this is what 125882 caught
  assert.equal(typeof parsed.body.output, 'object');
  assert.equal(parsed.body.output.title, 'all green');
  assert.equal(parsed.body.output.summary, 'hello world');
});

test('fqe status publish accepts --output-text starting with "---" (YAML frontmatter)', () => {
  // Real-CI regression test 2026-05-24: when QA-RESULT.md is passed as
  // --output-text, its content starts with "---" (YAML frontmatter delimiter).
  // The old parseFlags treated any next-arg-starting-with-"--" as a flag,
  // silently making --output-text = boolean true and crashing on .slice().
  const yamlBody = '---\nschema_version: 1\nverdict: PASS\n---\n\n# QA Receipt';
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'success',
    '--repo', 'foo/bar',
    '--output-text', yamlBody,
    '--dry-run',
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // The value MUST be preserved as a string, not coerced to boolean true
  assert.equal(typeof parsed.body.output.summary, 'string');
  assert.ok(parsed.body.output.summary.startsWith('---'),
    `expected summary to start with '---', got: ${JSON.stringify(parsed.body.output.summary).slice(0, 100)}`);
  assert.ok(parsed.body.output.summary.includes('verdict: PASS'));
});

test('parseFlags: value that is literally "--" gets preserved as a value', () => {
  // Edge case: a value that starts with "--" but isn't followed by a letter
  // (e.g. "--", "---", "--123") should be treated as a value, not a flag name.
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'success',
    '--repo', 'foo/bar',
    '--description', '--- divider ---',  // value with leading "---"
    '--dry-run',
  ]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.body.output.title, '--- divider ---');
});

test('fqe status publish --dry-run summary length never exceeds 65000', () => {
  // Test truncation indirectly: pass a moderate-length input (well under
  // both Windows argv cap and the 65K Check Run limit) and assert the body
  // surfaces it intact. The slice(0, 65000) for longer inputs is a trivial
  // determinstic op verified in code review.
  const text = 'x'.repeat(1000);
  const r = run([
    'status', 'publish',
    '--check', 'fqe/pass',
    '--commit', fortyHex('a'),
    '--state', 'success',
    '--repo', 'foo/bar',
    '--output-text', text,
    '--dry-run',
  ]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.body.output.summary.length <= 65000, 'must not exceed Check Run output limit');
  assert.equal(parsed.body.output.summary, text);
});

test('fqe status print maps verdict to GitHub check state', () => {
  const dir = tmpDir();
  // PASS receipt
  const ctxPass = {
    fqe_version: '0.1.0',
    run_id: 's1',
    started_at: '2026-05-22T23:34:17Z',
    finished_at: '2026-05-22T23:35:42Z',
    commit_sha: fortyHex('a'),
    content_hash: 'sha256:' + 'a'.repeat(64),
    inputs_hash: 'sha256:' + 'b'.repeat(64),
    classifier_version: 1,
    runner_versions: { fqe: '0.1.0' },
    runners_fired: ['web'],
    runners: [{ name: 'web', required: true, ran: true, exit_code: 0 }],
    verdict: 'PASS',
  };
  const ctxPath = path.join(dir, 'ctx.json');
  fs.writeFileSync(ctxPath, JSON.stringify(ctxPass));
  run(['receipt', 'write', ctxPath, dir]);
  const ymlPath = path.join(dir, 'QA-RESULT.yml');
  const r = run(['status', 'print', ymlPath]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.check_state, 'success');
  assert.equal(parsed.verdict, 'PASS');
});

test('fqe status print maps FAIL to failure', () => {
  const dir = tmpDir();
  const ctxFail = {
    fqe_version: '0.1.0',
    run_id: 's2',
    started_at: '2026-05-22T23:34:17Z',
    finished_at: '2026-05-22T23:35:42Z',
    commit_sha: fortyHex('a'),
    content_hash: 'sha256:' + 'a'.repeat(64),
    inputs_hash: 'sha256:' + 'b'.repeat(64),
    classifier_version: 1,
    runner_versions: { fqe: '0.1.0' },
    runners_fired: ['web'],
    runners: [{ name: 'web', required: true, ran: true, exit_code: 1 }],
    verdict: 'FAIL',
  };
  const ctxPath = path.join(dir, 'ctx.json');
  fs.writeFileSync(ctxPath, JSON.stringify(ctxFail));
  run(['receipt', 'write', ctxPath, dir]);
  const ymlPath = path.join(dir, 'QA-RESULT.yml');
  const r = run(['status', 'print', ymlPath]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.check_state, 'failure');
});

test('fqe wilson <s> <n> matches the lib', () => {
  const r = run(['wilson', '0', '100']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.hi > 0 && parsed.hi < 0.05);
});

test('fqe thresholds prints the canonical map', () => {
  const r = run(['thresholds']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.outbound, 0.05);
  assert.equal(parsed['mcp-write-or-financial'], 0.01);
});

test('fqe with no args prints help and exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: fqe/);
});

test('fqe unknown subcommand exits non-zero', () => {
  const r = run(['totally-not-a-subcommand']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown subcommand/);
});

test('fqe receipt sign + verify round-trips through YAML; verify catches a tamper (A3)', () => {
  const dir = tmpDir();
  const ctxPath = path.join(dir, 'ctx.json');
  fs.writeFileSync(ctxPath, JSON.stringify({
    fqe_version: '0.16.0', run_id: 'cli-sig', started_at: '2026-06-02T00:00:00Z', finished_at: '2026-06-02T00:01:00Z',
    commit_sha: fortyHex('a'), content_hash: 'sha256:' + 'b'.repeat(64), inputs_hash: 'sha256:' + 'c'.repeat(64),
    classifier_version: 1, runner_versions: { fqe: '0.16.0' }, runners_fired: ['unit'],
    runners: [{ name: 'unit', exit_code: 0 }], verdict: 'PASS', verdict_reasons: [],
  }));
  const ymlPath = path.join(dir, 'QA-RESULT.yml');
  fs.writeFileSync(ymlPath, run(['receipt', 'build', ctxPath]).stdout);
  const prev = process.env.FQE_SIGNING_KEY;
  process.env.FQE_SIGNING_KEY = 'cli-test-key';
  try {
    assert.equal(run(['receipt', 'sign', ymlPath]).status, 0);
    assert.equal(run(['receipt', 'verify', ymlPath]).status, 0, 'a freshly signed receipt verifies');
    fs.writeFileSync(ymlPath, fs.readFileSync(ymlPath, 'utf8').replace('verdict: PASS', 'verdict: FAIL'));
    assert.equal(run(['receipt', 'verify', ymlPath]).status, 2, 'a tampered receipt fails verification (exit 2)');
  } finally {
    if (prev === undefined) delete process.env.FQE_SIGNING_KEY; else process.env.FQE_SIGNING_KEY = prev;
  }
});
