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

/**
 * DEFECT 1b (the regression the fix for 1 introduced, shipped in v0.18.19):
 * a runner that TIMES OUT genuinely ran.
 *
 * spawnSync sets `.error` when the child "failed OR timed out", so keying
 * neverStarted off `.error` reported a suite that ran for its full timeout as
 * never having started. Every runner has a timeout, so this was reachable on
 * any slow suite: the receipt would tell an engineer their `command` is wrong
 * when the real answer is that their tests are slow.
 *
 * A timeout must still BLOCK, and must say so for the true reason.
 */
test('a runner that TIMES OUT reports ran:true and blocks for the timeout, not a phantom spawn failure', () => {
  const dir = tmpRepo();
  const outDir = path.join(dir, 'out');
  const node = JSON.stringify(process.execPath);
  fs.writeFileSync(
    path.join(dir, '.fqe.yml'),
    'runners:\n  slow:\n' +
      `    command: ${node}\n` +
      '    args: ["-e", "setTimeout(function(){}, 60000)"]\n' +
      '    timeout_ms: 1500\n' +
      '    always_run: true\n' +
      '    required: true\n'
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const r = spawnSync(process.execPath, [BIN, 'run', '--commit', sha, '--output', outDir, '--repo-dir', dir], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 90000,
  });

  const yml = fs.readFileSync(path.join(outDir, 'QA-RESULT.yml'), 'utf8');

  // It ran. This is the whole point.
  assert.doesNotMatch(
    yml,
    /ran:\s*false/,
    'a runner that executed for its full timeout MUST NOT be recorded as never started:\n' + yml.slice(0, 900)
  );
  assert.doesNotMatch(
    yml,
    /FAILED TO START/,
    'a timeout is not a spawn failure:\n' + yml.slice(0, 900)
  );

  // It still blocks, and for the honest reason.
  assert.match(yml, /verdict:\s*FAIL/, 'a timed-out required runner must still block:\n' + yml.slice(0, 900));
  assert.match(yml, /TIMED OUT/, 'the receipt must name the timeout as the cause:\n' + yml.slice(0, 900));
  assert.strictEqual(r.status, 2, 'exit code must be 2 (FAIL/block)');
});

/**
 * The discriminator itself, at the unit level: presence of `.error` must never
 * be what decides whether a process ran.
 */
test('spawnSync sets .error on timeout, so .error alone can never mean "never started"', () => {
  const timedOut = spawnSync(process.execPath, ['-e', 'setTimeout(function(){}, 30000)'], { timeout: 400 });
  const missing = spawnSync('definitely-not-a-real-binary-xyz', []);

  // Both populate `.error` - which is exactly why keying on it was wrong.
  assert.ok(timedOut.error, 'precondition: node sets error on timeout');
  assert.ok(missing.error, 'precondition: node sets error on ENOENT');

  // The real discriminator: evidence of execution.
  assert.strictEqual(timedOut.error.code, 'ETIMEDOUT');
  assert.ok(timedOut.signal, 'a timed-out child was killed by a signal, proving it ran');
  assert.strictEqual(missing.signal, null, 'a child that never started has no signal');
});

/**
 * REVIEW ROUND 2. Three fixes shipped with no test at all, and the two that did
 * have tests had blind spots that let a real bug through green. These close that.
 */

/**
 * A quarantined runner that TIMES OUT must still say it timed out.
 *
 * Once a timeout reports ran:true it reaches Pass 2, where the quarantine
 * branches match first - so the timeout branch was dead for any quarantined
 * runner and the receipt said only "produced no numeric exit_code" for a suite
 * that hung. The quarantine still shields (that is its job); the record must
 * still be honest about what happened.
 */
test('a QUARANTINED runner that times out still names the timeout in the reason', () => {
  const out = computeVerdict({
    runners: [{
      name: 'flaky-e2e', required: true, ran: true, exit_code: undefined,
      timed_out: true, timeout_ms: 300000,
      quarantined: true, quarantine_expired: false,
    }],
  });
  assert.match(out.reasons.join('\n'), /TIMED OUT after 300000ms/,
    'a quarantine may neutralize the verdict, but it must never hide the cause:\n' + out.reasons.join('\n'));
  // Assert the VERDICT too, not just the message. Without this the test passes
  // identically if the timeout branch is moved ahead of the quarantine branches
  // - which would silently start blocking merges on quarantined runners while
  // the reason text still matched the regex above.
  assert.strictEqual(out.verdict, 'FLAG',
    'an ACTIVE quarantine must still shield; describing the timeout must not change the outcome');
});

test('an EXPIRED quarantine on a timed-out runner blocks AND names the timeout', () => {
  const out = computeVerdict({
    runners: [{
      name: 'flaky-e2e', required: true, ran: true, exit_code: undefined,
      timed_out: true, timeout_ms: 1000,
      quarantined: true, quarantine_expired: true,
    }],
  });
  assert.strictEqual(out.verdict, 'FAIL');
  assert.match(out.reasons.join('\n'), /TIMED OUT after 1000ms/);
});

/**
 * FINDING 5, both directions. Shipped with a switch that nothing populated and
 * that config validation rejected, so the guard could FLAG but never block -
 * strictly worse than the wrong-switch version it replaced. A guard is only real
 * if it is reachable from a .fqe.yml an adopter can actually write.
 */
test('require_resolvable_diff is a VALID .fqe.yml key (a guard you cannot turn on is not a guard)', () => {
  const { validateConfig } = require('../lib/config_schema');
  const ok = validateConfig({ runners: {}, require_resolvable_diff: true });
  assert.deepStrictEqual(ok.errors || [], [], 'adopters must be able to set this key');

  const bad = validateConfig({ runners: {}, require_resolvable_diff: 'yes' });
  assert.ok((bad.errors || []).length > 0, 'a non-boolean must be rejected');
});

test('require_resolvable_diff escalates an indeterminate diff to FAIL when true, FLAG when absent', () => {
  const strict = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0 }],
    diff_indeterminate: true,
    require_resolvable_diff: true,
  });
  assert.strictEqual(strict.verdict, 'FAIL', 'switch ON must block:\n' + strict.reasons.join('\n'));

  const loose = computeVerdict({
    runners: [{ name: 'unit', required: true, ran: true, exit_code: 0 }],
    diff_indeterminate: true,
  });
  assert.strictEqual(loose.verdict, 'FLAG', 'switch OFF must flag, not block:\n' + loose.reasons.join('\n'));
});

test('require_resolvable_diff blocks END TO END through `fqe run`, not just through computeVerdict', () => {
  // The source-grep version of this test passed while I had not actually proved
  // the path: my first manual check used a single-commit repo, where the guard is
  // deliberately suppressed, and reported PASS. Logic tests and a grep for the
  // forwarding line both pass whether or not an adopter can reach the behaviour.
  // Only driving the real binary against a real .fqe.yml proves the wiring.
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  execFileSync('git', ['add', 'f.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'two'], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' },
  });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const runner = [
    '  unit:',
    '    command: "node"',
    '    args: ["-e", "console.log(1)"]',
    '    always_run: true',
    '    required: true',
    '',
  ].join('\n');

  const run = (yml, out) => {
    fs.writeFileSync(path.join(dir, '.fqe.yml'), yml);
    return spawnSync(
      process.execPath,
      [BIN, 'run', '--commit', sha, '--base', 'origin/does-not-exist', '--output', path.join(dir, out), '--repo-dir', dir],
      { encoding: 'utf8', cwd: dir, timeout: 90000 }
    );
  };

  const strict = run(`require_resolvable_diff: true
runners:
${runner}`, 'out-strict');
  assert.strictEqual(strict.status, 2,
    `switch ON must BLOCK an unresolvable diff (exit 2):
${strict.stdout}${strict.stderr}`);

  const loose = run(`runners:
${runner}`, 'out-loose');
  assert.strictEqual(loose.status, 3,
    `switch ABSENT must FLAG, not block (exit 3):
${loose.stdout}${loose.stderr}`);
});

test('the payments scaffold sets require_resolvable_diff so money repos keep blocking', () => {
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--dir', dir, '--payments'], { encoding: 'utf8' });
  const yml = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  assert.match(yml, /^require_resolvable_diff:\s*true$/m, 'payments profile must block on an unresolvable diff');

  // And it must validate clean - a scaffold that fails its own validator is worse
  // than no scaffold, because the gate then refuses to run at all.
  const r = spawnSync(process.execPath, [BIN, 'validate', '--dir', dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `the generated payments config must validate:\n${r.stdout}${r.stderr}`);
});

/**
 * FINDING 6, which shipped untested. Two runner names that differ only in a
 * character the sanitizer collapses must not share one log file, or
 * evidence_paths shows runner A's output under runner B's name.
 */
test('the log-name sanitizer is injective over every runner name the parser accepts', () => {
  // Finding 6 said `unit/fast` and `unit_fast` both map to runner-unit_fast.log,
  // on the premise that .fqe.yml keys are free-form. They are NOT: the config
  // parser constrains a runner key to /^[A-Za-z_][\w-]*$/, and every character
  // that survives is already in the sanitizer's keep-set, so the mapping is
  // injective and the collision is unreachable through the product today. The
  // disambiguation added for it is defense in depth, kept deliberately.
  //
  // THIS is the invariant that makes it safe, so this is what gets pinned: if
  // anyone ever loosens the parser to accept '/' or ':' or a space, the collision
  // becomes reachable and this test fails at that moment - which is the point at
  // which someone needs to know.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'orchestrator.js'), 'utf8');

  const keyRe = src.match(/const m = trimmed\.match\((\/\^\(\[A-Za-z_\]\[[^)]*\)[^;]*)\);[\s\S]{0,120}?malformed runner key/);
  assert.ok(keyRe, 'could not locate the runner-key regex; if it moved, re-derive this guard');

  const sanitizer = src.match(/replace\(\/\[\^([^\]]+)\]\/g, '_'\)/);
  assert.ok(sanitizer, 'could not locate the log-name sanitizer');
  assert.strictEqual(sanitizer[1], 'A-Za-z0-9._-', 'sanitizer keep-set changed; re-check injectivity');

  // Every character the parser can accept must be preserved by the sanitizer.
  const parserAccepts = 'abcXYZ019_-';
  for (const ch of parserAccepts) {
    assert.strictEqual(
      ch.replace(/[^A-Za-z0-9._-]/g, '_'),
      ch,
      `parser accepts '${ch}' but the sanitizer rewrites it, so two distinct runner names can collide`
    );
  }

  // And the parser must still reject the characters that would break it.
  const { parseConfigYaml } = require('../lib/orchestrator');
  for (const bad of ['unit/fast', 'unit fast', 'unit:fast']) {
    assert.throws(
      () => parseConfigYaml(`runners:
  ${bad}:
    command: "node"
    args: []
`),
      /malformed runner key|config parse/,
      `if '${bad}' became a legal runner key, the sanitizer would no longer be injective`
    );
  }
});

/**
 * A '#' line inside a YAML block scalar is TEXT, not a comment.
 *
 * The runner-log upload comment was written inside `path: |`, so three lines of
 * English prose were passed to actions/upload-artifact as glob patterns - in
 * both the template and every workflow `fqe init` generates. It degrades to
 * harmless no-op globs rather than failing loudly, which is exactly why it
 * needs a test: nothing would ever have surfaced it.
 */
/**
 * Extract the lines a YAML `path: |` block scalar actually contains. A block
 * scalar ends when indentation drops below its first line, so this must respect
 * indentation - a regex that just takes following indented lines swallows the
 * next key's comment and reports a false positive.
 */
function blockScalarEntries(yaml) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*path: \|\s*$/.test(l));
  if (start === -1) return [];
  const indentOf = (l) => l.length - l.trimStart().length;
  const base = indentOf(lines[start + 1] || '');
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (indentOf(l) < base) break;
    out.push(l.trim());
  }
  return out;
}

test('the generated workflow uploads globs, not comment text, in its artifact path block', () => {
  const dir = tmpRepo();
  execFileSync(process.execPath, [BIN, 'init', '--dir', dir], { encoding: 'utf8' });
  const wf = fs.readFileSync(path.join(dir, '.github', 'workflows', 'fqe-quality.yml'), 'utf8');

  const entries = blockScalarEntries(wf);
  assert.ok(entries.length > 0, 'could not find the artifact path block in the generated workflow');
  for (const e of entries) {
    assert.ok(!e.startsWith('#'),
      `'${e}' is prose being passed to upload-artifact as a glob; move the comment ABOVE 'path: |'`);
  }
  assert.ok(entries.includes('out/runner-*.log'), `runner logs must be uploaded, got: ${JSON.stringify(entries)}`);
});

test('the shipped workflow TEMPLATE has the same clean path block', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'workflows', 'fqe-quality.yml.template'), 'utf8');
  const entries = blockScalarEntries(tpl);
  assert.ok(entries.length > 0, 'could not find the artifact path block in the template');
  for (const e of entries) {
    assert.ok(!e.startsWith('#'), `'${e}' is prose inside a YAML block scalar in the template`);
  }
  assert.ok(entries.includes('out/runner-*.log'));
});

/**
 * A SHALLOW CLONE must not disarm the indeterminate-diff guard.
 *
 * `repoHasHistory()` counts commits reachable from HEAD, and a shallow clone
 * reports exactly 1 no matter how much history the repo really has.
 * `actions/checkout` defaults to fetch-depth 1, so keying the guard on that
 * alone meant an explicitly-named base that failed to resolve was swallowed and
 * the run reported PASS over zero evaluated files - under
 * `require_resolvable_diff: true`, on the money path.
 *
 * Every existing test for this feature fed `diff_indeterminate` straight into
 * computeVerdict(), so all of them passed while the orchestrator wiring that
 * DECIDES it was broken. These drive the real binary against a real shallow
 * clone.
 */
function shallowClone() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-src-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
  execFileSync('git', ['init', '-q', '.'], { cwd: src });
  for (let i = 0; i < 4; i++) {
    fs.appendFileSync(path.join(src, 'f.txt'), `line${i}\n`);
    execFileSync('git', ['add', 'f.txt'], { cwd: src });
    execFileSync('git', ['commit', '-q', '-m', `c${i}`], { cwd: src, env });
  }
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-shallow-')) + '-c';
  const srcUrl = 'file://' + src.split(path.sep).join('/');
  execFileSync('git', ['clone', '-q', '--depth', '1', srcUrl, dst], { env });
  return dst;
}

const RUNNER_BLOCK = [
  '  unit:',
  '    command: "node"',
  '    args: ["-e", "console.log(1)"]',
  '    always_run: true',
  '    required: true',
  '',
].join('\n');

test('a SHALLOW clone does not disarm the diff guard (an unresolvable base still blocks)', () => {
  const dir = shallowClone();
  const depth = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.strictEqual(depth, '1', 'precondition: a shallow clone must look like a single-commit repo');

  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, '.fqe.yml'), `require_resolvable_diff: true\nrunners:\n${RUNNER_BLOCK}`);

  const r = spawnSync(
    process.execPath,
    [BIN, 'run', '--commit', sha, '--base', 'origin/does-not-exist', '--output', path.join(dir, 'out'), '--repo-dir', dir],
    { encoding: 'utf8', cwd: dir, timeout: 90000 }
  );
  assert.strictEqual(r.status, 2,
    `a named base that did not resolve must BLOCK even on a shallow clone; a green here is a receipt reporting clean over zero evaluated files:\n${r.stdout}${r.stderr}`);
});

test('a genuinely fresh single-commit repo with no base still stays silent (no cry wolf)', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, '.fqe.yml'), `runners:\n${RUNNER_BLOCK}`);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const r = spawnSync(
    process.execPath,
    [BIN, 'run', '--commit', sha, '--output', path.join(dir, 'out'), '--repo-dir', dir],
    { encoding: 'utf8', cwd: dir, timeout: 90000 }
  );
  assert.strictEqual(r.status, 0,
    `a newcomer's first commit with no --base must not be flagged:\n${r.stdout}${r.stderr}`);
});

/**
 * ROUND 5. The round-4 fix closed only the half of the hole it was looking at.
 *
 * `!diff.ok && (!!opts.baseSha || repoHasHistory(...))` collapses to
 * `repoHasHistory(...)` alone whenever --base is omitted - and --base is
 * OPTIONAL in fqe's own help text - so a shallow checkout with no base still
 * reported PASS over zero evaluated files, with LESS setup than the bug round 4
 * fixed. Three attempts, all framed as "raise IF ...", each with a case the
 * condition never considered.
 *
 * The predicate is inverted now: silence must be EARNED by proving a genuinely
 * first run. These pin every arm of that proof.
 */
test('shallow clone + NO --base still blocks (the hole round 4 left open)', () => {
  const dir = shallowClone();
  assert.strictEqual(
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: dir, encoding: 'utf8' }).trim(),
    'true',
    'precondition: this must actually be a shallow clone'
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, '.fqe.yml'), `require_resolvable_diff: true\nrunners:\n${RUNNER_BLOCK}`);

  // NOTE: no --base. That is the whole point.
  const r = spawnSync(
    process.execPath,
    [BIN, 'run', '--commit', sha, '--output', path.join(dir, 'out'), '--repo-dir', dir],
    { encoding: 'utf8', cwd: dir, timeout: 90000 }
  );
  assert.strictEqual(r.status, 2,
    `a shallow clone is history-BLIND, not history-FREE; silence here is a receipt reporting clean over zero evaluated files:\n${r.stdout}${r.stderr}`);
});

test('a shallow clone is never mistaken for a first run', () => {
  const { repoIsShallow } = require('../lib/orchestrator');
  const shallow = shallowClone();
  const fresh = tmpRepo();
  assert.strictEqual(repoIsShallow(shallow), true, 'a --depth 1 clone must read as shallow');
  assert.strictEqual(repoIsShallow(fresh), false, 'a normal fresh repo must NOT read as shallow');
});

test('repoIsShallow fails toward SUSPICION when depth cannot be determined', () => {
  const { repoIsShallow } = require('../lib/orchestrator');
  // An undeterminable depth must never be reported as "definitely not shallow",
  // because that is the answer that silences the guard.
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-notgit-'));
  assert.strictEqual(repoIsShallow(notARepo), true,
    'an unknown clone depth must raise, not silently pass');
});

test('"not a git repo" is a different state from "shallow" and stays silent', () => {
  const { isGitRepo, isGenuinelyFirstRun } = require('../lib/orchestrator');
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-notgit2-'));
  assert.strictEqual(isGitRepo(notARepo), false);
  assert.strictEqual(isGitRepo(tmpRepo()), true);

  // There is no history here to be blind to and no diff was ever possible - the
  // documented "empty config / always_run only" case. Collapsing this into
  // "shallow" would flag every non-git invocation, which is a false alarm, and
  // false alarms are how a real signal gets ignored later.
  assert.strictEqual(isGenuinelyFirstRun({ repoDir: notARepo }), true);
  // ...but naming a base that did not resolve is still an error even here.
  assert.strictEqual(isGenuinelyFirstRun({ repoDir: notARepo, baseSha: 'origin/main' }), false);
});

test('the ONLY silent case is a genuinely new repo with no base named', () => {
  const { isGenuinelyFirstRun } = require('../lib/orchestrator');
  const fresh = tmpRepo();
  const shallow = shallowClone();

  assert.strictEqual(isGenuinelyFirstRun({ repoDir: fresh }), true,
    'a real first commit with no base is the one legitimate silence');
  assert.strictEqual(isGenuinelyFirstRun({ repoDir: fresh, baseSha: 'origin/main' }), false,
    'naming a base that did not resolve is always an error, even on a new repo');
  assert.strictEqual(isGenuinelyFirstRun({ repoDir: shallow }), false,
    'a shallow clone is not a first run');
});

/**
 * ROUND 6. Five rounds hardened "the diff did not resolve". A six-lens
 * adversarial sweep found the larger failure: THE DIFF RESOLVED, TO THE WRONG
 * SCOPE, SILENTLY. No guard could catch it because nothing failed.
 *
 * `changedFiles()` fell back to `HEAD~1..HEAD` whenever no base was given - a
 * guess at the pull request's range, wrong for every multi-commit PR. git
 * succeeded, so diff.ok was true and the whole indeterminate-diff predicate was
 * never consulted.
 */
function prRepo() {
  const dir = tmpRepo();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
  fs.writeFileSync(path.join(dir, '.fqe.yml'),
    'runners:\n  unit:\n    command: "node"\n    args: ["-e", "process.exit(1)"]\n    when: ["src/**"]\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir, env });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  // PR commit 1 breaks src/. PR commit 2 touches only docs.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'REGRESSION\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'pr c1: breaks src'], { cwd: dir, env });
  fs.writeFileSync(path.join(dir, 'README.md'), 'docs\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'pr c2: docs only'], { cwd: dir, env });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, base, head };
}

test('a multi-commit PR is gated over its WHOLE range when --base is given', () => {
  const { dir, base, head } = prRepo();
  const r = spawnSync(process.execPath,
    [BIN, 'run', '--commit', head, '--base', base, '--output', path.join(dir, 'out'), '--repo-dir', dir],
    { encoding: 'utf8', cwd: dir, timeout: 90000 });
  assert.strictEqual(r.status, 2, `the break in PR commit 1 must be caught:\n${r.stdout}${r.stderr}`);
  const yml = fs.readFileSync(path.join(dir, 'out', 'QA-RESULT.yml'), 'utf8');
  assert.match(yml, /runners_fired: \["unit"\]/, 'the when-gated runner must have fired');
});

test('with NO --base the gate does not silently guess HEAD~1 and pass', () => {
  const { dir, head } = prRepo();
  const r = spawnSync(process.execPath,
    [BIN, 'run', '--commit', head, '--output', path.join(dir, 'out'), '--repo-dir', dir],
    { encoding: 'utf8', cwd: dir, timeout: 90000 });
  // Previously: exit 0, PASS, runners_fired [] - because HEAD~1..HEAD covered
  // only the docs commit. fqe cannot gate a range it was not given; saying so is
  // the only honest outcome.
  assert.notStrictEqual(r.status, 0,
    `a run that was never told its range must not report clean:\n${r.stdout}${r.stderr}`);
  const yml = fs.readFileSync(path.join(dir, 'out', 'QA-RESULT.yml'), 'utf8');
  assert.match(yml, /indeterminate: true/, 'the receipt must say the scope was unknown');
});

test('--base given but EMPTY is rejected, not silently demoted to "no base"', () => {
  const { dir, head } = prRepo();
  for (const bad of ['', '   ']) {
    const r = spawnSync(process.execPath,
      [BIN, 'run', '--commit', head, '--base', bad, '--output', path.join(dir, 'out'), '--repo-dir', dir],
      { encoding: 'utf8', cwd: dir, timeout: 90000 });
    assert.strictEqual(r.status, 1, `--base '${bad}' must be a hard error, not a silent scope change`);
    assert.match(`${r.stdout}${r.stderr}`, /--base was given but is empty/);
  }
});

test('the receipt records the scope the verdict is about', () => {
  const { dir, base, head } = prRepo();
  spawnSync(process.execPath,
    [BIN, 'run', '--commit', head, '--base', base, '--output', path.join(dir, 'out'), '--repo-dir', dir],
    { encoding: 'utf8', cwd: dir, timeout: 90000 });
  const yml = fs.readFileSync(path.join(dir, 'out', 'QA-RESULT.yml'), 'utf8');
  // Without this a blind PASS and a genuinely clean PASS are byte-identical.
  assert.match(yml, /diff_scope:/);
  assert.match(yml, new RegExp(`base: ${base}`), 'the receipt must name the base it diffed against');
  assert.match(yml, /changed_file_count: [12]/, 'the receipt must record how much it looked at');
  assert.match(yml, /indeterminate: false/);
});

test('git REFUSING to answer is not mistaken for a brand-new repo', () => {
  const { isGitRepo, isGenuinelyFirstRun } = require('../lib/orchestrator');
  const { dir } = prRepo();
  // A real repo whose git probes fail must still read as a repo, because the
  // .git marker proves it is one. Simulated by pointing GIT_DIR at nothing,
  // which is what a dubious-ownership refusal or a moved worktree looks like.
  const prev = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(dir, 'no-such-git-dir');
  try {
    assert.strictEqual(isGitRepo(dir), true,
      'git failing to answer must never be read as "there is no repo here"');
    assert.strictEqual(isGenuinelyFirstRun({ repoDir: dir }), false,
      'the most blind state fqe can be in must not receive the most trusting treatment');
  } finally {
    if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev;
  }
});

test('an explicitly EMPTY FQE_CHANGED_FILES is never excused by repo history', () => {
  // The caller asserting "my diff came back empty" is a CI signal. A git-history
  // predicate about the checkout has no bearing on it and must not silence it.
  const { dir, head } = prRepo();
  const prev = process.env.FQE_CHANGED_FILES;
  process.env.FQE_CHANGED_FILES = '';
  try {
    const r = spawnSync(process.execPath,
      [BIN, 'run', '--commit', head, '--output', path.join(dir, 'out'), '--repo-dir', dir],
      { encoding: 'utf8', cwd: dir, timeout: 90000, env: { ...process.env, FQE_CHANGED_FILES: '' } });
    assert.notStrictEqual(r.status, 0, 'an empty CI-supplied diff must not report clean');
  } finally {
    if (prev === undefined) delete process.env.FQE_CHANGED_FILES;
    else process.env.FQE_CHANGED_FILES = prev;
  }
});
