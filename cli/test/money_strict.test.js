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
const {
  init, PAYMENTS_FQE_YML, armPaymentsTemplate, enableOptionalPolicy,
  ARM_BEGIN_RE, ARM_END_RE, OPT_BEGIN_RE, OPT_END_RE,
} = require('../lib/init');

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
  // policy.require_for is deliberately NOT part of arming: its globs name paths fqe cannot
  // know, and a glob that matches nothing is a hard every-PR BLOCK. It ships as an OPTIONAL
  // block OUTSIDE the ARM markers, so arming must leave it commented.
  assert.equal(armed.policy, undefined,
    'arming must NOT enable policy.require_for; its example globs would block every PR in a repo with a different layout');
  assert.match(PAYMENTS_FQE_YML, /^# OPTIONAL, and NOT part of arming\./m,
    'the require_for example must still ship, as an optional block');
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
const SUITE = 'const fs=require("fs"),p=require("path");' +
  'const o=process.argv[2];fs.mkdirSync(p.dirname(o),{recursive:true});' +
  'fs.writeFileSync(o,\'<testsuites><testsuite name="s" tests="1">' +
  '<testcase classname="c" name="settle_is_idempotent"/></testsuite></testsuites>\');';

/**
 * The shipped template, armed through the ARM markers, with only the npm scripts pointed
 * at a real passing suite. Everything the money strictness rests on (required, report,
 * reconcile, strict_coverage, min_tests, invariant, always_run) is left exactly as the
 * template ships it, so these tests measure the TEMPLATE, not a rewrite of it.
 */
function armedTemplate() {
  return armPaymentsTemplate(PAYMENTS_FQE_YML)
    .replace(/^ {4}command: "npm"$/gm, '    command: "node"')
    .replace(/^ {4}args: \["run", "test:money"\]$/m, '    args: ["scripts/suite.js", "reports/money-junit.xml"]')
    .replace(/^ {4}args: \["run", "test:contract"\]$/m, '    args: ["scripts/suite.js", "reports/contract-junit.xml"]')
    .replace(/^ {4}inventory_cmd: .*$/gm, '    inventory_cmd: "echo 1"');
}

/**
 * An ORDINARY payments repo: money code under src/payments and nothing else. Deliberately
 * NOT one that happens to have every directory the template's old require_for example
 * named. The earlier version of this seed created src/ledger and src/billing too, which
 * is exactly what hid the dead-glob block: the armed template FAILed every PR in a repo
 * that merely used a different layout, and no test could see it because every test repo
 * had been built to match the template.
 */
const PAYMENTS_SEED = {
  'README.md': 'hello\n',
  'scripts/suite.js': SUITE,
  'src/payments/charge.js': 'function charge(cents) { return cents; }\n',
};

test('MS U4: in a real payments repo, always_run runs the money suite on a docs-only PR and when-globs do not', () => {
  const armedYml = armedTemplate();
  const seed = PAYMENTS_SEED;

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

/**
 * MS U5 is the axis MS U1-U4 all missed: they only ever diff README.md, so none of them
 * exercised a pull request that touches the MONEY paths - the one kind of PR the payments
 * profile exists for. Found by review, reproduced, and it was real: the armed template
 * declared `classes: ["money", "regression"]` while providing no class:regression runner,
 * so verdict Pass 5 FAILed every money PR on `required test class "regression" has no
 * runner that ran and passed`. Same defect class this whole change is about ("a gate no
 * PR can pass"), one layer deeper, reachable only on the money path.
 *
 * The rule this pins: every class named in policy.require_for must have a runner in the
 * template that can satisfy it.
 */
test('MS U5: the armed template PASSes a pull request that changes the money paths', () => {
  const repo = gitRepo({ ...PAYMENTS_SEED, '.fqe.yml': armedTemplate() });
  const res = runGate(repo, { 'src/payments/charge.js': 'function charge(cents) { return cents + 0; }\n' });

  assert.strictEqual(res.status, 0,
    `the armed template must let a money PR through when the money suite passes:\n${res.stdout}${res.stderr}`);
  assert.match(res.yml, /verdict:\s*PASS/);
  assert.deepEqual(reasonsOf(res.yml), []);
  assert.match(res.yml, /name:\s*money/, 'the money runner must have run on a money PR');
});

/**
 * The header tells the operator what happens if they arm only one block. Both halves of
 * that claim are measured here, because the first version of that prose was WRONG in one
 * direction: it said arming part of it "stops" the gate, and ARM 2 alone in fact yields a
 * working, narrower gate. Prose about behaviour has to be pinned by the behaviour.
 */
test('MS U6: ARM 2 alone is a working narrower gate; ARM 1 alone blocks every PR', () => {
  // Derive the per-block markers from the EXPORTED regexes rather than retyping them.
  // Hand-copied marker text would silently stop matching if init.js reworded the sentinel,
  // and this helper would then quietly return a fully-commented config - testing something
  // no human would ever produce.
  const forBlock = (re, n) => {
    const src = re.source.replace('\\d', String(n));
    assert.notEqual(src, re.source, `expected a \\d placeholder in ${re.source}`);
    return new RegExp(src);
  };
  const onlyBlock = (n) => {
    const begin = forBlock(ARM_BEGIN_RE, n);
    const end = forBlock(ARM_END_RE, n);
    const out = []; let inside = false; let sawBlock = false;
    for (const line of PAYMENTS_FQE_YML.split(/\r?\n/)) {
      if (!inside && begin.test(line)) { inside = true; sawBlock = true; continue; }
      if (inside && end.test(line)) { inside = false; continue; }
      out.push(inside ? line.replace(/^# ?/, '') : line);
    }
    assert.ok(sawBlock, `ARM ${n} markers not found; the sentinel wording changed`);
    assert.equal(inside, false, `ARM ${n} was opened and never closed`);
    return out.join('\n');
  };

  // ARM 2 only: runners, no explicit flags. The money-class runner arms the idempotency
  // requirement by itself (orchestrator), so this is a real gate, just without the
  // path-to-class binding.
  const arm2 = onlyBlock(2)
    .replace(/^ {4}command: "npm"$/gm, '    command: "node"')
    .replace(/^ {4}args: \["run", "test:money"\]$/m, '    args: ["scripts/suite.js", "reports/money-junit.xml"]')
    .replace(/^ {4}args: \["run", "test:contract"\]$/m, '    args: ["scripts/suite.js", "reports/contract-junit.xml"]')
    .replace(/^ {4}inventory_cmd: .*$/gm, '    inventory_cmd: "echo 1"');
  const cfg2 = parseConfigYaml(arm2);
  assert.equal(validateConfig(cfg2).valid, true, 'ARM 2 alone must validate');
  assert.deepEqual(Object.keys(cfg2.runners), ['money', 'contract']);
  assert.equal(cfg2.policy, undefined, 'ARM 2 alone carries no require_for binding');
  const r2 = runGate(gitRepo({ ...PAYMENTS_SEED, '.fqe.yml': arm2 }), { 'README.md': 'hello\nworld\n' });
  assert.strictEqual(r2.status, 0, `ARM 2 alone must be a WORKING gate:\n${r2.stdout}${r2.stderr}`);

  // ARM 1 only: flags and policy, no runner that can satisfy them. Blocks every PR.
  const r1 = runGate(gitRepo({ ...PAYMENTS_SEED, '.fqe.yml': onlyBlock(1) }), { 'README.md': 'hello\nworld\n' });
  assert.strictEqual(r1.status, 2, `ARM 1 alone must block every PR:\n${r1.stdout}${r1.stderr}`);
  assert.ok(reasonsOf(r1.yml).some((r) => /require_money_idempotency is on but no runner PROVED/.test(r)),
    `and for the reason the header names:\n${reasonsOf(r1.yml).join('\n')}`);
});

test('MS U7: an unclosed ARM marker throws instead of uncommenting the rest of the file', () => {
  const broken = PAYMENTS_FQE_YML.replace('# <<< END ARM 2 of 2 <<<\n', '');
  assert.notEqual(broken, PAYMENTS_FQE_YML, 'the end marker must actually have been removed');
  assert.throws(() => armPaymentsTemplate(broken), /opened and never closed/);
});

/**
 * MS U9. The OPTIONAL policy ships as two pieces in two different places, and the header
 * tells the reader to "uncomment in place". Review found the earlier single-block form
 * put a `regression:` runner inside the `policy:` stanza when uncommented the way a human
 * selects a visual block - it threw rather than silently dropping the runner, so it was
 * fail-loud, but the reader's only protection was a prose line sitting inside the very
 * block they were selecting. Prose is not a mechanism. This asserts the mechanism: strip
 * the comment markers off each piece WHERE IT SITS and the result must be a valid config
 * with the policy at the top level and the runner under runners:.
 */
test('MS U9: each OPTIONAL piece is valid when uncommented exactly where it sits', () => {
  // Uncomment by POSITION, via the shipped helper - the same mechanism as arming, and the
  // same mechanism the sentinels tell a human to use. The first version of this test
  // uncommented by matching a hand-listed set of key names, and review broke it by adding
  // one plausible field (report:) to the template: that line stayed commented, the config
  // still parsed, and the test still passed - a green over a config no human would produce.
  // Uncommenting is a property of WHERE a line is, never of what it says.
  const opted = enableOptionalPolicy(armPaymentsTemplate(PAYMENTS_FQE_YML));

  const cfg = parseConfigYaml(opted);
  const r = validateConfig(cfg);
  assert.equal(r.valid, true, `both OPTIONAL pieces must uncomment in place into a valid config:\n${r.errors.join('\n')}`);

  // PIECE 1 landed at the TOP level, not nested somewhere odd.
  assert.ok(cfg.policy && Array.isArray(cfg.policy.require_for), 'PIECE 1 must land as a top-level policy.require_for');
  assert.deepEqual(cfg.policy.require_for[0].classes, ['money', 'regression']);

  // PIECE 2 landed under runners:, NOT under policy: - the exact confusion this shape fixes.
  assert.deepEqual(Object.keys(cfg.runners), ['money', 'contract', 'regression'],
    'PIECE 2 must land under runners:, beside the armed money and contract runners');
  assert.equal(cfg.runners.regression.class, 'regression');
  assert.equal(cfg.runners.regression.always_run, true);

  // And the pairing the warning promises actually holds: the class named in PIECE 1 is
  // provided by PIECE 2, so turning both on does not reproduce the round-2 regression trap.
  const provided = new Set(Object.values(cfg.runners).map((c) => c.class));
  for (const cls of cfg.policy.require_for[0].classes) {
    assert.ok(provided.has(cls), `class "${cls}" is demanded by the policy but no runner provides it`);
  }

  // Position-based means EVERY line in the block comes through, including ones nobody
  // enumerated. Pin that: no line inside either OPTIONAL block may survive commented.
  // This is what the key-name version could not assert, and what let it pass with a
  // silently-skipped field.
  const inOptional = [];
  let inside = false;
  for (const line of PAYMENTS_FQE_YML.split(/\r?\n/)) {
    if (!inside && OPT_BEGIN_RE.test(line)) { inside = true; continue; }
    if (inside && OPT_END_RE.test(line)) { inside = false; continue; }
    if (inside) inOptional.push(line);
  }
  assert.ok(inOptional.length >= 8, `expected the OPTIONAL blocks to have content, got ${inOptional.length} lines`);
  for (const line of inOptional) {
    const uncommented = line.replace(/^# ?/, '');
    assert.ok(opted.split('\n').includes(uncommented),
      `line "${line.trim()}" was not uncommented; the mechanism skipped it`);
  }

  // ARM and OPTIONAL must stay disjoint: arming alone must never enable the regression
  // runner, or the armed template gains a `fqe golden verify` with no captured manifest -
  // a required runner that dies on every PR, which is case one all over again.
  const armedOnly = parseConfigYaml(armPaymentsTemplate(PAYMENTS_FQE_YML));
  assert.deepEqual(Object.keys(armedOnly.runners), ['money', 'contract']);
  assert.equal(armedOnly.policy, undefined);
});

test('MS U10: an appended runner block is separated from the template it lands on', () => {
  // The payments template ENDS with a commented-out runner example, and `\s*$` in
  // appendRunnerBlock eats the trailing newline, so without an explicit separator a live
  // runner starts on the line immediately after the inert example and reads as part of it.
  const dir = tmpRepo();
  init({ dir, force: true, payments: true, withMutation: true, withQodo: true });
  const body = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');

  for (const live of ['stryker-mutation', 'qodo-cover']) {
    const lines = body.split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim() === `${live}:`);
    assert.ok(i > 0, `${live} must be present and live`);
    // Walk back over its own leading comment block to the line before it.
    let j = i - 1;
    while (j >= 0 && lines[j].trim().startsWith('#')) j--;
    assert.equal(lines[j].trim(), '',
      `a live runner must be separated from what precedes it by a blank line, ` +
      `or it reads as part of the commented-out example above it:\n` +
      lines.slice(Math.max(0, j - 2), i + 1).join('\n'));
  }

  const cfg = parseConfigYaml(body);
  assert.deepEqual(Object.keys(cfg.runners), ['stryker-mutation', 'qodo-cover']);
  assert.equal(validateConfig(cfg).valid, true);
});

/**
 * MS U8: the third "arms into a gate that cannot pass" case, found by review after U5
 * closed the second. `policy.require_for` used to be part of ARM 1 with its `when` globs
 * hardcoded to src/payments + src/ledger + src/billing. A repo with only src/payments -
 * an ordinary layout - armed the template as instructed and then FAILed EVERY pull
 * request, money or not, on `BLOCKED (dead policy glob)`, because
 * require_money_policy_when_detected (live in this profile) makes that check strict.
 *
 * Every test above missed it because their repos were seeded to match the template's own
 * globs. require_for is no longer part of arming; this pins both halves of that decision.
 */
test('MS U8: arming in a repo that lacks the template\'s example paths does not block, and the optional policy still guards', () => {
  // Half 1: an ordinary layout (src/payments only) arms clean.
  const repo = gitRepo({ ...PAYMENTS_SEED, '.fqe.yml': armedTemplate() });
  const res = runGate(repo, { 'README.md': 'hello\nworld\n' });
  assert.strictEqual(res.status, 0,
    `arming must not depend on the repo having src/ledger and src/billing:\n${res.stdout}${res.stderr}`);
  assert.ok(!reasonsOf(res.yml).some((r) => /dead policy glob/.test(r)),
    `no dead-glob block may survive arming:\n${reasonsOf(res.yml).join('\n')}`);

  // Half 2: the dead-glob guard itself is NOT gone. Turn the optional policy on with a
  // glob this repo cannot satisfy and it must still BLOCK - that is what makes the
  // warning above the optional block true rather than decorative.
  const withPolicy = armedTemplate() +
    '\npolicy:\n  require_for:\n    - when: ["src/ledger/**"]\n      classes: ["money"]\n';
  const guarded = gitRepo({ ...PAYMENTS_SEED, '.fqe.yml': withPolicy });
  const gres = runGate(guarded, { 'README.md': 'hello\nworld\n' });
  assert.strictEqual(gres.status, 2,
    `a dead require_for glob must still block:\n${gres.stdout}${gres.stderr}`);
  assert.ok(reasonsOf(gres.yml).some((r) => /dead policy glob.*src\/ledger/.test(r)),
    `and name the glob:\n${reasonsOf(gres.yml).join('\n')}`);
});
