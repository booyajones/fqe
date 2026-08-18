'use strict';

/**
 * v0.15 MS: the money-aware strict profile (fqe init --payments) + the scaffold validating clean.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { validateConfig } = require('../lib/config_schema');
const { parseConfigYaml } = require('../lib/orchestrator');
const { init, PAYMENTS_FQE_YML, armPaymentsTemplate } = require('../lib/init');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-ms-'));
}

test('MS S10: the PAYMENTS scaffold parses and validates clean', () => {
  const cfg = parseConfigYaml(PAYMENTS_FQE_YML);
  const r = validateConfig(cfg);
  assert.equal(r.valid, true, r.errors.join(' | '));
});

test('MS I1: init --payments writes the payments scaffold as .fqe.yml', () => {
  const dir = tmpRepo();
  const res = init({ dir, force: true, payments: true });
  assert.ok(res.written.includes('.fqe.yml'), 'should write .fqe.yml');
  const body = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  assert.equal(body, PAYMENTS_FQE_YML);
});

test('MS I2: init --payments + --with-mutation keeps the payments body valid', () => {
  const dir = tmpRepo();
  init({ dir, force: true, payments: true, withMutation: true });
  const body = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  // Assert on a LIVE line, not on /class: money/. The money runner now ships commented
  // out, and "#     class: money" satisfies that regex just as well as a real runner
  // does - the assertion would have kept passing while measuring nothing.
  assert.match(body, /^require_money_policy_when_detected: true$/m, 'the payments profile identity must be live, not commented');
  assert.match(body, /^ {2}stryker-mutation:$/m, '--with-mutation must land a LIVE runner under runners:');
  const cfg = parseConfigYaml(body);
  assert.deepEqual(Object.keys(cfg.runners || {}), ['stryker-mutation'], 'the money runners ship commented out; only the mutation runner is live');
  const r = validateConfig(cfg);
  assert.equal(r.valid, true, r.errors.join(' | '));
});

/**
 * `fqe init --payments` used to generate a config that could not pass ANY pull
 * request: the money and contract runners shipped live, `required: true` (which the
 * validator forces on a money runner) means "must fire on THIS pull request", and their
 * `when` globs named src/payments, src/ledger and src/billing. A docs-only PR therefore
 * FAILED with "required runner money did not run", plus a dead-require_for BLOCK and an
 * unprovable require_money_idempotency.
 *
 * MS S10 above asserted the scaffold VALIDATES, and it did. Validates and usable are
 * different claims and only the first was tested. These drive the real binary.
 */

const BIN = path.join(__dirname, '..', 'bin', 'fqe.js');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c',
};

/** A git repo with one committed file, returning { dir, base }. */
function gitRepo(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-msu-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  for (const [rel, body] of Object.entries(seed || { 'README.md': 'hello\n' })) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir, env: GIT_ENV });
  return { dir, base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim() };
}

/**
 * The receipt's verdict_reasons, parsed. Read the array, do not regex the raw YAML: the
 * reasons are JSON-encoded in there, so /required runner "money" did not run/ never
 * matches the escaped \"money\" that is actually written - a negative assertion built
 * that way passes no matter what the gate did. Throws when the line is missing, so a
 * receipt that changed shape fails loudly instead of measuring nothing.
 */
function reasonsOf(yml) {
  const m = yml.match(/^verdict_reasons: (\[.*\])$/m);
  if (!m) throw new Error(`no verdict_reasons line in the receipt:\n${yml.slice(0, 800)}`);
  return JSON.parse(m[1]);
}

/** Commit `files` as the PR head and run the gate over base..head. */
function runGate(repo, files, outName) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(repo.dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  execFileSync('git', ['add', '-A'], { cwd: repo.dir });
  execFileSync('git', ['commit', '-q', '-m', 'pr'], { cwd: repo.dir, env: GIT_ENV });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
  const r = spawnSync(process.execPath, [
    BIN, 'run', '--commit', head, '--base', repo.base,
    '--output', path.join(repo.dir, outName || 'out'), '--repo-dir', repo.dir,
  ], { cwd: repo.dir, encoding: 'utf8' });
  const yml = fs.readFileSync(path.join(repo.dir, outName || 'out', 'QA-RESULT.yml'), 'utf8');
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', yml };
}

test('MS U1: init --payments then a non-payments PR reaches a non-FAIL verdict', () => {
  const repo = gitRepo();
  execFileSync(process.execPath, [BIN, 'init', '--dir', repo.dir, '--payments'], { encoding: 'utf8' });
  execFileSync('git', ['add', '-A'], { cwd: repo.dir });
  execFileSync('git', ['commit', '-q', '-m', 'fqe init --payments'], { cwd: repo.dir, env: GIT_ENV });
  repo.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();

  const res = runGate(repo, { 'README.md': 'hello\nworld\n' });

  assert.doesNotMatch(res.yml, /verdict:\s*FAIL/,
    `a docs-only PR must not be blocked by the payments scaffold:\n${res.stdout}${res.stderr}`);
  assert.notStrictEqual(res.status, 2,
    `exit 2 is FAIL/merge-blocked:\n${res.stdout}${res.stderr}`);
  // Name each reason the shipped scaffold used to emit, so a regression says which one.
  const reasons = reasonsOf(res.yml);
  for (const gone of [
    'required runner "money" did not run',
    'required runner "contract" did not run',
    'dead policy glob',
    'require_money_idempotency is on but no runner PROVED',
  ]) {
    assert.ok(!reasons.some((r) => r.includes(gone)),
      `the scaffold still emits "${gone}":\n${reasons.join('\n')}`);
  }
});

test('MS U2: the inert payments scaffold still BLOCKS the first PR that adds money code', () => {
  const repo = gitRepo();
  execFileSync(process.execPath, [BIN, 'init', '--dir', repo.dir, '--payments'], { encoding: 'utf8' });
  execFileSync('git', ['add', '-A'], { cwd: repo.dir });
  execFileSync('git', ['commit', '-q', '-m', 'fqe init --payments'], { cwd: repo.dir, env: GIT_ENV });
  repo.base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();

  const res = runGate(repo, { 'src/payments/charge.js': 'function charge(cents) { return cents; }\n' });

  // Commenting the runners out must not have turned --payments into a rubber stamp.
  // require_money_policy_when_detected stays LIVE, so money code with no armed policy
  // blocks, and the reason tells the reader to arm the template.
  assert.strictEqual(res.status, 2, `money code with no armed policy must BLOCK:\n${res.stdout}${res.stderr}`);
  assert.match(res.yml, /verdict:\s*FAIL/);
  const reasons = reasonsOf(res.yml);
  assert.ok(reasons.some((r) => /money detected, no policy/i.test(r)),
    `the FAIL must name the cause:\n${reasons.join('\n')}`);
});

test('MS U3: the ARM markers uncomment into a valid, strict money config', () => {
  // A commented-out template nobody validates rots into one that fails the moment a
  // human arms it. Uncomment it exactly the way the scaffold header says to.
  const armed = parseConfigYaml(armPaymentsTemplate(PAYMENTS_FQE_YML));
  const r = validateConfig(armed);
  assert.equal(r.valid, true, `the ARMED template must validate:\n${r.errors.join('\n')}`);
  assert.deepEqual(Object.keys(armed.runners), ['money', 'contract']);
  assert.equal(armed.require_money_idempotency, true, 'ARM 1 must turn the idempotency requirement on');
  assert.ok(armed.policy && Array.isArray(armed.policy.require_for), 'ARM 1 must turn the require_for policy on');
  for (const name of ['money', 'contract']) {
    const cfg = armed.runners[name];
    assert.equal(cfg.always_run, true, `${name} must be always_run, not when-scoped`);
    assert.equal(cfg.when, undefined, `${name} must not carry when globs`);
    assert.equal(cfg.required, true, `${name} must stay required`);
    assert.equal(cfg.reconcile, true, `${name} must stay reconciled`);
    assert.equal(cfg.strict_coverage, true, `${name} must stay strict_coverage`);
  }
});

/**
 * MS U4 is the reason the armed template says always_run instead of when. It is not a
 * fresh-repo problem: this repo HAS src/payments committed, so the globs are live and
 * every dead-glob signal is silent. The when-scoped shape still blocks a docs-only PR.
 * Both arms differ in exactly one line.
 */
test('MS U4: in a real payments repo, always_run runs the money suite on a docs-only PR and when-globs do not', () => {
  const SUITE = 'const fs=require("fs"),p=require("path");' +
    'const o=process.argv[2];fs.mkdirSync(p.dirname(o),{recursive:true});' +
    'fs.writeFileSync(o,\'<testsuites><testsuite name="s" tests="1">' +
    '<testcase classname="c" name="settle_is_idempotent"/></testsuite></testsuites>\');';

  const armedYml = armPaymentsTemplate(PAYMENTS_FQE_YML)
    // Point the template's npm scripts at a real, passing suite. Everything the money
    // strictness rests on (report, reconcile, strict_coverage, min_tests, invariant,
    // required) is left exactly as the template ships it.
    .replace(/^ {4}command: "npm"$/gm, '    command: "node"')
    .replace(/^ {4}args: \["run", "test:money"\]$/m, '    args: ["scripts/suite.js", "reports/money-junit.xml"]')
    .replace(/^ {4}args: \["run", "test:contract"\]$/m, '    args: ["scripts/suite.js", "reports/contract-junit.xml"]')
    .replace(/^ {4}inventory_cmd: .*$/gm, '    inventory_cmd: "echo 1"');

  // A real payments repo: every path the template's require_for names exists, so no
  // dead-glob signal can be mistaken for the thing this test is measuring.
  const seed = {
    'README.md': 'hello\n',
    'scripts/suite.js': SUITE,
    'src/payments/charge.js': 'function charge(cents) { return cents; }\n',
    'src/ledger/post.js': 'function post(entry) { return entry; }\n',
    'src/billing/invoice.js': 'function invoice(id) { return id; }\n',
  };

  const always = gitRepo({ ...seed, '.fqe.yml': armedYml });
  const alwaysRes = runGate(always, { 'README.md': 'hello\nworld\n' });
  assert.match(alwaysRes.yml, /verdict:\s*PASS/,
    `always_run must let the money suite fire on a docs-only PR:\n${alwaysRes.stdout}${alwaysRes.stderr}`);
  assert.match(alwaysRes.yml, /name:\s*money/, 'the money runner must actually have run');

  const whenYml = armedYml.replace(/^ {4}always_run: true$/gm,
    '    when: ["src/payments/**", "src/ledger/**", "src/billing/**"]');
  assert.notEqual(whenYml, armedYml, 'the when-scoped arm must actually differ');
  const scoped = gitRepo({ ...seed, '.fqe.yml': whenYml });
  const scopedRes = runGate(scoped, { 'README.md': 'hello\nworld\n' });
  assert.strictEqual(scopedRes.status, 2,
    `the when-scoped shape is what blocked every non-money PR; if this stops failing, the ` +
    `engine's 'required' semantics changed and the template can go back to when globs:\n${scopedRes.stdout}`);
  assert.ok(reasonsOf(scopedRes.yml).some((r) => r === 'required runner "money" did not run'),
    `and it must block for THAT reason:\n${reasonsOf(scopedRes.yml).join('\n')}`);
});
