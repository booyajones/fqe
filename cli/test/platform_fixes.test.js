'use strict';

/**
 * The four platform defects a 3-engineer cold start found on 2026-08-16.
 *
 * These are behaviour tests, not doc tests. Each one reproduces the exact thing
 * that made a skeptical engineer stop evaluating fqe, so a regression here is a
 * regression in whether the product is usable.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'fqe.js');
const { computeVerdict } = require('../lib/verdict');
const { explainReason } = require('../lib/explainer');

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-plat-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: d });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], {
    cwd: d,
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' },
  });
  return d;
}

/**
 * DEFECT 1: the receipt claimed a process ran when it never started.
 *
 * `command: "npm"` on Windows cannot be spawned (npm is a .cmd shim), so
 * spawnSync returns ENOENT with status null. fqe recorded ran:true,
 * exit_code:null and a ~7ms duration for a 74-second suite. A tamper-evident
 * receipt asserting a process ran is the worst thing this tool can get wrong,
 * because the receipt IS the product.
 */
test('a runner that cannot spawn reports ran:false in the RECEIPT, never a phantom run', () => {
  // End-to-end through the CLI, deliberately. The first version of this test
  // imported runOne and returned early if it was not exported. It is not
  // exported, so the test reported "ok" while asserting nothing: a green that
  // measured zero. Drive the real binary and read the real receipt instead.
  const dir = tmpRepo();
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(
    path.join(dir, '.fqe.yml'),
    'runners:\n  ghost:\n    command: "definitely-not-a-real-binary-xyz"\n    args: []\n    always_run: true\n    required: true\n'
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  spawnSync(process.execPath, [BIN, 'run', '--commit', sha, '--output', outDir, '--repo-dir', dir], {
    encoding: 'utf8',
    cwd: dir,
  });

  const yml = fs.readFileSync(path.join(outDir, 'QA-RESULT.yml'), 'utf8');
  assert.match(yml, /ran:\s*false/, 'a process that never started must not be recorded as having run:\n' + yml.slice(0, 700));
  assert.match(yml, /FAILED TO START|spawn/i, 'the receipt must say why');
  assert.match(yml, /verdict:\s*FAIL/, 'a required runner that could not start still blocks');
});

test('the verdict names a spawn failure instead of a generic "did not run"', () => {
  const out = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: false, spawn_failed: true, spawn_error: 'ENOENT' }],
  });
  assert.strictEqual(out.verdict, 'FAIL', 'a required runner that could not start still blocks');
  assert.ok(
    out.reasons.some((r) => /FAILED TO START/.test(r)),
    'the reason must say the process never started, not merely that it did not run:\n' + out.reasons.join('\n')
  );
});

test('the explainer sends a spawn failure to command config, not to runner JSON', () => {
  const e = explainReason('required runner "unit" FAILED TO START (ENOENT); the process never ran, so there is no exit code');
  assert.strictEqual(e.code, 'RUNNER_SPAWN_FAILED');
  assert.match(e.plain_english, /never started/i);
  assert.match(e.fix, /cmd/, 'must give the Windows workaround');
  assert.doesNotMatch(e.fix, /bypass-72h/, 'must not cite a label removed in v0.4.0');
});

/**
 * DEFECT 2: unknown flags were accepted silently.
 * A one-character typo in --config meant fqe loaded the DEFAULT config, turning
 * a fail-closed gate into a green PASS. It is also why `--full`, a flag that
 * never existed, survived into six docs and every generated receipt.
 */
test('an unknown flag is rejected, not silently ignored', () => {
  const r = spawnSync(process.execPath, [BIN, 'run', '--commit', 'a'.repeat(40), '--output', 'out', '--totally-bogus'], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
  });
  assert.notStrictEqual(r.status, 0, 'a bogus flag must not be accepted');
  assert.match((r.stderr || '') + (r.stdout || ''), /unknown flag/i);
});

test('the phantom --full flag is rejected', () => {
  const r = spawnSync(process.execPath, [BIN, 'run', '--full', '--commit', 'a'.repeat(40), '--output', 'out'], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
  });
  assert.notStrictEqual(r.status, 0);
  assert.match((r.stderr || '') + (r.stdout || ''), /--full/);
});

/**
 * DEFECT 3: an unresolvable base ref was swallowed.
 * `--base origin/main` in a repo whose default branch is master made git error,
 * the error was discarded, changed_file_count came back 0, every `when`-gated
 * runner sat out, and the gate returned PASS over a typo.
 */
test('an explicitly named base that does not resolve is surfaced, not swallowed', () => {
  const out = computeVerdict({
    runners: [],
    diff_indeterminate: true,
    diff_base: 'origin/main',
  });
  assert.notStrictEqual(out.verdict, 'PASS', 'a run that scoped itself to zero files must not look clean');
  assert.ok(out.reasons.some((r) => /could not be resolved/.test(r)), out.reasons.join('\n'));
});

test('a first-run with no base given does NOT cry wolf', () => {
  // The common newcomer path: fresh repo, single commit, no --base. The diff
  // genuinely cannot be computed, and that is not an error worth flagging.
  const out = computeVerdict({ runners: [], diff_indeterminate: false, diff_base: null });
  assert.strictEqual(out.verdict, 'PASS');
});

/**
 * DEFECT 4: the receipt promised stderr and delivered nothing.
 * evidence_paths was hardcoded to [] while three docs promised the runner's
 * stderr, and the repro command told you to cat a log file nothing ever wrote.
 */
test('runner output is written to disk and referenced by the receipt', () => {
  const dir = tmpRepo();
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(
    path.join(dir, '.fqe.yml'),
    'runners:\n  talky:\n    command: "node"\n    args: ["-e", "console.log(\'hello-from-runner\'); process.exit(1)"]\n    always_run: true\n    required: true\n'
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  spawnSync(process.execPath, [BIN, 'run', '--commit', sha, '--output', outDir, '--repo-dir', dir], {
    encoding: 'utf8',
    cwd: dir,
  });

  const log = path.join(outDir, 'runner-talky.log');
  assert.ok(fs.existsSync(log), 'the runner log the repro command tells you to cat must actually exist');
  const body = fs.readFileSync(log, 'utf8');
  assert.match(body, /hello-from-runner/, 'the runner output must be in the log');

  const yml = fs.readFileSync(path.join(outDir, 'QA-RESULT.yml'), 'utf8');
  assert.match(yml, /runner-talky\.log/, 'the receipt must reference the evidence it promises');
});
