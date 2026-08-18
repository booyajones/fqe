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

const { parseConfigYaml } = orchestrator;

// --- v0.18.21: fail closed on a mis-indented line under `runners:`/`policy:` ---
// The parser keyed on EXACT indent (2 = runner name, 4 = field) and let every
// other indent fall through both branches, silently discarding the line. A
// one-space typo on `required: true` produced a runner the author believed was
// required, and validateConfig still called the config valid. A mis-indented
// runner NAME emptied `runners` entirely, so the gate went green protecting
// nothing. Same shape in parsePolicyBlock, where `indent !== 2` hit `continue`
// and a mis-indented `require_for:` dropped a diff-conditional money rule.

test('parseConfigYaml throws on a runner field indented 3 (the reported repro)', () => {
  assert.throws(() => parseConfigYaml([
    'version: 0.15',
    'runners:',
    '  unit:',
    '    command: "node"',
    '    always_run: true',
    '   required: true', // 3 spaces: one short
  ].join('\n')), /malformed indent under runners\.unit, line 6/);
});

test('parseConfigYaml throws on a runner field at every non-4 indent', () => {
  for (const n of [1, 3, 5, 6, 7, 8]) {
    assert.throws(() => parseConfigYaml([
      'runners:',
      '  unit:',
      '    command: "node"',
      `${' '.repeat(n)}required: true`,
    ].join('\n')), /malformed indent under runners\.unit/, `indent ${n} must throw`);
  }
});

test('parseConfigYaml throws on a TAB-indented runner field', () => {
  assert.throws(() => parseConfigYaml([
    'runners:',
    '  unit:',
    '    command: "node"',
    '\trequired: true',
  ].join('\n')), /malformed indent under runners\.unit/);
});

test('parseConfigYaml throws on a runner NAME at a non-2 indent', () => {
  // Worse than a dropped field: the whole runner vanished and `runners: {}`
  // validates clean, so the gate had nothing to run and still passed.
  for (const n of [1, 3, 5, 6]) {
    assert.throws(() => parseConfigYaml([
      'runners:',
      `${' '.repeat(n)}unit:`,
      '    command: "node"',
    ].join('\n')), /malformed indent under runners/, `runner name at indent ${n} must throw`);
  }
});

test('parseConfigYaml throws on a runner field before any runner name', () => {
  assert.throws(() => parseConfigYaml([
    'runners:',
    '    command: "node"',
  ].join('\n')), /has no runner to attach to/);
});

test('parseConfigYaml throws on a mis-indented policy key', () => {
  for (const n of [1, 3, 4]) {
    assert.throws(() => parseConfigYaml([
      'policy:',
      `${' '.repeat(n)}require_classes: ["unit"]`,
    ].join('\n')), /malformed indent under policy/, `policy key at indent ${n} must throw`);
  }
});

test('parseConfigYaml throws on a mis-indented require_for (money rule would vanish)', () => {
  assert.throws(() => parseConfigYaml([
    'policy:',
    '  require_classes: ["unit"]',
    '   require_for:', // 3 spaces: the money rule silently disappeared
    '     - when: ["src/payments/**"]',
    '       classes: ["money"]',
  ].join('\n')), /malformed indent under policy, line 3/);
});

test('parseConfigYaml still accepts canonical indentation (no false positives)', () => {
  const cfg = parseConfigYaml([
    'version: 0.15',
    'runners:',
    '  unit:',
    '    command: "node"',
    '    args: ["-e", "0"]',
    '    when: ["src/**"]',
    '    class: unit',
    '    required: true',
    '  money:',
    '    command: "npm"',
    '    args: []',
    '    always_run: true',
    'policy:',
    '  require_classes: ["unit"]',
    '  require_for:',
    '    - when: ["src/payments/**"]',
    '      classes: ["money", "regression"]',
    'mutation:',
    '  policy: blocking',
  ].join('\n'));
  assert.equal(cfg.runners.unit.required, true);
  assert.deepEqual(cfg.runners.unit.args, ['-e', '0']);
  assert.equal(cfg.runners.money.always_run, true);
  assert.deepEqual(cfg.runners.money.args, []);
  assert.deepEqual(cfg.policy.require_classes, ['unit']);
  assert.deepEqual(cfg.policy.require_for[0].classes, ['money', 'regression']);
  assert.equal(cfg.mutation.policy, 'blocking');
});

test('parse error names the offending line and text, not just a line number', () => {
  try {
    parseConfigYaml(['runners:', '  unit:', '    command: "node"', '   required: true'].join('\n'));
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /line 4/);
    assert.match(e.message, /required: true/);
    assert.match(e.message, /found 3/);
  }
});

test('parseConfigYaml throws on a mis-indented class line (money protections would vanish)', () => {
  // The worst instance of this defect. v0.15 forces a money/contract runner to be
  // required + reconciled + strict-coverage + junit-reporting, and all of it keys
  // on `class`. Dropping that one line silently removed every money rule at once,
  // and `fqe run` returned verdict PASS exit 0 with the runner reported as fired.
  assert.throws(() => parseConfigYaml([
    'version: 0.15',
    'runners:',
    '  money-check:',
    '    command: "node"',
    '    args: ["-e", "0"]',
    '    always_run: true',
    '   class: money', // 3 spaces
  ].join('\n')), /malformed indent under runners\.money-check, line 7/);
});

// --- round 2: the sibling silent drops the first fix left open ---
// An independent review found the same defect class one branch over. The first
// fix added an `else` INSIDE the `current === 'runners'` branch, but the outer
// if/else-if chain still had no final `else`, and every overwrite path was still
// silent. All three were reproduced end-to-end before being closed.

test('parseConfigYaml throws on a runner block after a top-level scalar key', () => {
  // A `version:` line between two runners reset `current` to null, so every
  // runner after it fell off the end of the chain. Measured: the money runner
  // vanished and validateConfig reported valid.
  assert.throws(() => parseConfigYaml([
    'runners:',
    '  lint:',
    '    command: "node"',
    '    always_run: true',
    'version: 0.15',
    '  money-check:',
    '    command: "node"',
    '    class: money',
    '    required: true',
  ].join('\n')), /unexpected indented line 6/);
});

test('parseConfigYaml throws on a duplicate top-level key', () => {
  assert.throws(() => parseConfigYaml([
    'runners:',
    '  money:',
    '    command: "node"',
    'runners:',
    '  lint:',
    '    command: "node"',
  ].join('\n')), /duplicate top-level key 'runners' at line 4/);
});

test('parseConfigYaml throws on a duplicate runner name', () => {
  assert.throws(() => parseConfigYaml([
    'runners:',
    '  dup:',
    '    command: "node"',
    '    class: money',
    '  dup:',
    '    command: "echo"',
  ].join('\n')), /duplicate runner 'dup' at line 5/);
});

test('parseConfigYaml throws on a duplicate runner field', () => {
  assert.throws(() => parseConfigYaml([
    'runners:',
    '  a:',
    '    command: "node"',
    '    command: "echo"',
  ].join('\n')), /duplicate field 'command' on runner 'a' at line 4/);
});

test('parseConfigYaml throws on a duplicate policy key', () => {
  assert.throws(() => parseConfigYaml([
    'policy:',
    '  require_classes: ["money"]',
    '  require_classes: ["lint"]',
  ].join('\n')), /duplicate key 'require_classes' at line 3/);
});

test('parseConfigYaml throws on a duplicate mutation key', () => {
  assert.throws(() => parseConfigYaml([
    'mutation:',
    '  policy: blocking',
    '  policy: advisory',
  ].join('\n')), /duplicate key 'policy'/);
});

test('parseConfigYaml throws on a require_for entry written without its dash', () => {
  // The keys overwrote the previous entry, merging two rules into one and
  // deleting the payments requirement with the config still valid.
  assert.throws(() => parseConfigYaml([
    'policy:',
    '  require_for:',
    '    - when: ["src/payments/**"]',
    '      classes: ["money"]',
    '      when: ["src/api/**"]',
    '      classes: ["contract"]',
  ].join('\n')), /duplicate key 'when' in one require_for entry/);
});

test('parse error names the block-sequence and block-scalar shapes by name', () => {
  // Telling the author to re-indent a `- item` to 4 spaces sends them to a
  // second, less clear error: this parser reads inline flow lists only.
  assert.throws(() => parseConfigYaml([
    'runners:', '  a:', '    command: "node"', '    args:', '      - "-e"',
  ].join('\n')), /YAML block sequence; use inline-list syntax/);
  assert.throws(() => parseConfigYaml([
    'runners:', '  a:', '    command: "node"', '    script: |', '      body',
  ].join('\n')), /uses a YAML block scalar/);
});

test('policy parse errors report the REAL file line, not the block index', () => {
  // Pins the lineNos threading. Blank and comment lines are skipped during block
  // collection, so block index and file line diverge here; a hardcoded offset
  // passes the other fixtures but fails this one.
  try {
    parseConfigYaml([
      'version: 0.15',      // 1
      '',                   // 2
      '# a comment',        // 3
      'policy:',            // 4
      '',                   // 5
      '  # inner comment',  // 6
      '  require_classes: ["unit"]', // 7
      '',                   // 8
      '   require_for:',    // 9  <- mis-indented, the throw
    ].join('\n'));
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /line 9/);
  }
});

test('parseConfigYaml accepts comments and blank lines inside blocks (no false positives)', () => {
  // The guards must not turn an ordinary commented config into a parse error.
  const cfg = parseConfigYaml([
    'version: 0.15',
    'runners:',
    '  # which suite this is',
    '  unit:',
    '',
    '    command: "node"',
    '    # inline note at field depth',
    '    args: ["-e", "0"]',
    '    always_run: true',
    '',
    'policy:',
    '  # the static bar',
    '  require_classes: ["unit"]',
  ].join('\n'));
  assert.equal(cfg.runners.unit.command, 'node');
  assert.deepEqual(cfg.policy.require_classes, ['unit']);
});

test('parseConfigYaml behaves identically on CRLF input', () => {
  const lines = [
    'version: 0.15', 'runners:', '  unit:', '    command: "node"', '    always_run: true',
  ];
  assert.deepEqual(parseConfigYaml(lines.join('\r\n')), parseConfigYaml(lines.join('\n')));
  const bad = ['runners:', '  unit:', '    command: "node"', '   required: true'];
  assert.throws(() => parseConfigYaml(bad.join('\r\n')), /malformed indent under runners\.unit, line 4/);
});

// --- round 4: the last members of each family, from review ---

test('parseConfigYaml throws on a duplicate require_for block', () => {
  // The `require_for` branch assigns unconditionally, so it sat outside the
  // duplicate guard: a repeated `require_for:` silently replaced the earlier
  // one, on the single key where losing a rule matters most.
  assert.throws(() => parseConfigYaml([
    'policy:',
    '  require_for:',
    '    - when: ["src/payments/**"]',
    '      classes: ["money"]',
    '  require_for:',
    '    - when: ["src/**"]',
    '      classes: ["unit"]',
  ].join('\n')), /duplicate key 'require_for' at line 5/);
});

test('parseConfigYaml throws on a require_for block with no entries', () => {
  // Parsed to [], which validateConfig accepts and the verdict ignores, so the
  // diff-conditional money requirement vanished with the config reporting valid.
  // The sibling `require_classes:` branch already threw for exactly this reason.
  assert.throws(() => parseConfigYaml([
    'policy:', '  require_for:', 'runners:', '  unit:', '    command: "node"',
  ].join('\n')), /'require_for' at line 2 has no entries/);
  // Same outcome when every item is commented out: parseRequireFor skips them.
  assert.throws(() => parseConfigYaml([
    'policy:', '  require_for:', '    # - when: ["a"]', 'runners:', '  unit:', '    command: "node"',
  ].join('\n')), /has no entries/);
});

test('parseConfigYaml throws on a reserved JavaScript property name as a key', () => {
  // `result.runners['__proto__'] = {}` goes through Object.prototype's setter and
  // re-points the map's prototype instead of adding a key, so the runner vanished
  // whole: Object.keys came back empty and `runners: {}` validated clean.
  assert.throws(() => parseConfigYaml([
    'runners:', '  __proto__:', '    command: "node"', '    class: money',
  ].join('\n')), /reserved JavaScript property name/);
  assert.throws(() => parseConfigYaml([
    'runners:', '  a:', '    __proto__: "x"',
  ].join('\n')), /reserved JavaScript property name/);
  assert.throws(() => parseConfigYaml([
    'runners:', '  constructor:', '    command: "node"',
  ].join('\n')), /reserved JavaScript property name/);
  assert.throws(() => parseConfigYaml([
    'policy:', '  __proto__: ["x"]',
  ].join('\n')), /reserved JavaScript property name/);
});

test('every parse throw is tagged fqeConfigInvalid', () => {
  // The tag routes these to the pinned EXIT.ERROR branch in bin/fqe.js rather
  // than die()'s default. An untagged throw is a silent downgrade risk, and the
  // first attempt at tagging converted only the single-line throw sites.
  const bad = [
    ['runners:', '  u:', '    command: "node"', '   required: true'],
    ['runners:', '   u:', '    command: "node"'],
    ['runners:', '    command: "node"'],
    ['runners:', '  a:', '    command: "x"', 'version: 0.15', '  b:', '    command: "y"'],
    ['runners:', '  a:', '    command: "x"', 'runners:', '  b:', '    command: "y"'],
    ['runners:', '  a:', '    command: "x"', '  a:', '    command: "y"'],
    ['runners:', '  a:', '    command: "x"', '    command: "y"'],
    ['runners:', '  a:', '    s: |', '      body'],
    ['runners:', '  a:', '    when:', '      - "src/**"'],
    ['runners:', '  __proto__:', '    command: "node"'],
    ['policy:', '   require_classes: ["unit"]'],
    ['policy:', '  require_classes: ["a"]', '  require_classes: ["b"]'],
    ['policy:', '  require_for:'],
    ['policy:', '  require_for:', '    - when: ["a"]', '      classes: ["m"]', '      when: ["b"]'],
    ['mutation:', '  policy: blocking', '  policy: advisory'],
    // The JSON/flow-list path: previously a bare JSON.parse, whose SyntaxError
    // is untagged and names neither the key nor the line.
    ['runners:', '  a:', '    command: "node"', '    args: [not, valid, json'],
    ['policy:', '  require_classes: [oops'],
  ];
  for (const lines of bad) {
    try {
      parseConfigYaml(lines.join('\n'));
      assert.fail(`expected a throw for:\n${lines.join('\n')}`);
    } catch (e) {
      assert.equal(e.fqeConfigInvalid, true, `untagged throw for:\n${lines.join('\n')}\n${e.message}`);
    }
  }
});

// --- round 6: a regression this PR introduced, and the locate half of round 5 ---

test('an inline list splits only on commas OUTSIDE quotes', () => {
  // Round 5 moved runner fields off a bare JSON.parse and onto parseFlowList,
  // which made its tolerant fallback reachable from `args` for the first time.
  // That fallback split EVERY comma, so a quoted element containing one became
  // two arguments, silently, on a money runner. Latent in policy and mutation
  // lists before that, so it is fixed once for all four callers.
  const cfg = parseConfigYaml([
    'runners:',
    '  money-tests:',
    '    command: "npx"',
    "    args: [jest, '--testPathPattern=payments,ledger']",
    '    class: money',
  ].join('\n'));
  assert.deepEqual(cfg.runners['money-tests'].args, ['jest', '--testPathPattern=payments,ledger']);

  const pol = parseConfigYaml(['policy:', "  require_classes: [unit, 'a,b']"].join('\n'));
  assert.deepEqual(pol.policy.require_classes, ['unit', 'a,b']);

  // Strict JSON and the unquoted flow form both keep working.
  assert.deepEqual(
    parseConfigYaml(['runners:', '  m:', '    args: ["-m", "pytest", "-q"]'].join('\n')).runners.m.args,
    ['-m', 'pytest', '-q']
  );
  assert.deepEqual(
    parseConfigYaml(['runners:', '  m:', '    invariant: [idempotency, double-spend]'].join('\n')).runners.m.invariant,
    ['idempotency', 'double-spend']
  );
});

test('an unterminated quote in an inline list throws rather than guessing', () => {
  assert.throws(() => parseConfigYaml([
    'runners:', '  m:', "    args: [a, 'unterminated]",
  ].join('\n')), /unterminated single quote in inline list/);
});

test('inline-list errors name the key and the line', () => {
  // parseFlowList has four callers and its throw named neither, while every
  // other throw in this parser carries a line number.
  try {
    parseConfigYaml(['runners:', '  m:', '    command: "node"', '    args: [not, valid, json'].join('\n'));
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /runners\.m\.args/);
    assert.match(e.message, /line 4/);
    assert.equal(e.fqeConfigInvalid, true);
  }
});

test('parseConfigYaml throws on the inline empty require_for spelling too', () => {
  // `require_for: []` reaches the same end state as the empty block form: valid
  // config, rule gone, hasMoneyPolicy down a signal. The block form throwing
  // while this one passed was an indefensible asymmetry.
  assert.throws(() => parseConfigYaml([
    'policy:', '  require_classes: ["unit"]', '  require_for: []',
  ].join('\n')), /'require_for' at line 3 has no entries/);
});

test('a reserved-key error never prints a line number that cannot exist', () => {
  // Three call sites passed a literal 0, producing "at line 0". parseRequireFor
  // had the real lines available through its caller and simply was not given
  // them; parseFlatMapBlock has none, so it omits the clause rather than faking
  // one. Same degraded-error path that parsePolicyBlock's default once produced.
  try {
    parseConfigYaml(['mutation:', '  __proto__: x'].join('\n'));
    assert.fail('expected a throw');
  } catch (e) {
    assert.doesNotMatch(e.message, /line 0/);
    assert.doesNotMatch(e.message, /line undefined/);
    assert.match(e.message, /reserved JavaScript property name/);
  }
  try {
    parseConfigYaml(['policy:', '  require_for:', '    - __proto__: ["a"]'].join('\n'));
    assert.fail('expected a throw');
  } catch (e) {
    assert.match(e.message, /at line 3/); // the real file line, not 0
  }
});

// --- round 8: found by an old-vs-ad5ab10 differential over the new quote-aware split ---

test('an interior empty element in an inline list throws (doubled comma)', () => {
  // The first quote-aware split filtered empties, so `[a, , b]` silently became
  // two elements. That is the same quiet weakening this change exists to remove,
  // newly reachable from runner fields and pre-existing for policy lists.
  assert.throws(() => parseConfigYaml([
    'runners:', '  a:', '    args: [a, , b]',
  ].join('\n')), /empty element at position 2 of inline list at runners\.a\.args/);
});

test('a single trailing comma in an inline list is benign', () => {
  assert.deepEqual(
    parseConfigYaml(['runners:', '  a:', '    args: [a, b,]'].join('\n')).runners.a.args,
    ['a', 'b']
  );
});

test('a quote is only special at the START of a list element', () => {
  // YAML's own rule. Treating it as special mid-element made an ordinary
  // apostrophe report as an unterminated quote.
  assert.deepEqual(
    parseConfigYaml(['runners:', '  a:', "    args: [dont, it's, fine]"].join('\n')).runners.a.args,
    ['dont', "it's", 'fine']
  );
  // A genuinely unterminated quote still throws.
  assert.throws(() => parseConfigYaml([
    'runners:', '  a:', "    args: [a, 'oops]",
  ].join('\n')), /unterminated single quote/);
  // And a quoted element still protects its commas.
  assert.deepEqual(
    parseConfigYaml(['runners:', '  a:', "    args: [jest, '--x=p,l']"].join('\n')).runners.a.args,
    ['jest', '--x=p,l']
  );
});
