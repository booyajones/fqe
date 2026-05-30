'use strict';

/**
 * Golden-master / regression engine tests.
 *
 * The PURE core (normalizeOutput, sha256, compareToGolden, goldenPath,
 * parseGoldenManifest) is tested directly without any subprocess. The IMPURE
 * path (captureGoldens / verifyGoldens) is exercised with integration tests
 * that use `node -e` as the command — node is guaranteed present and works
 * identically on every OS, so these tests are Windows-compatible. Temp dirs are
 * created with os.tmpdir() + fs.mkdtempSync and cleaned up after each test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const golden = require('../lib/golden');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-golden-'));
}
function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// ─── normalizeOutput (PURE) ─────────────────────────────────────────────

test('normalizeOutput: CRLF becomes LF', () => {
  assert.equal(golden.normalizeOutput('a\r\nb\r\nc'), 'a\nb\nc');
});

test('normalizeOutput: lone CR becomes LF', () => {
  assert.equal(golden.normalizeOutput('a\rb\rc'), 'a\nb\nc');
});

test('normalizeOutput: strips a single trailing newline', () => {
  assert.equal(golden.normalizeOutput('hello\n'), 'hello');
  assert.equal(golden.normalizeOutput('hello\r\n'), 'hello');
});

test('normalizeOutput: keeps a deliberate blank final line (only one stripped)', () => {
  assert.equal(golden.normalizeOutput('hello\n\n'), 'hello\n');
});

test('normalizeOutput: CRLF + trailing newline makes a Windows capture match a Unix one', () => {
  assert.equal(golden.normalizeOutput('line1\r\nline2\r\n'), golden.normalizeOutput('line1\nline2\n'));
});

test('normalizeOutput: empty / nullish -> empty string', () => {
  assert.equal(golden.normalizeOutput(''), '');
  assert.equal(golden.normalizeOutput(null), '');
  assert.equal(golden.normalizeOutput(undefined), '');
});

// ─── sha256 (PURE) ──────────────────────────────────────────────────────

test('sha256: tagged 64-hex format', () => {
  assert.match(golden.sha256('anything'), /^sha256:[a-f0-9]{64}$/);
});

test('sha256: deterministic for identical input', () => {
  assert.equal(golden.sha256('finexio'), golden.sha256('finexio'));
});

test('sha256: differs for different input', () => {
  assert.notEqual(golden.sha256('a'), golden.sha256('b'));
});

test('sha256: known vector for empty string', () => {
  assert.equal(
    golden.sha256(''),
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});

// ─── compareToGolden (PURE) ─────────────────────────────────────────────

test('compareToGolden: identical content -> pass', () => {
  const r = golden.compareToGolden({ actualContent: 'invoice 100', goldenContent: 'invoice 100' });
  assert.equal(r.status, 'pass');
  assert.equal(r.expected_sha, r.actual_sha);
});

test('compareToGolden: different content -> drift', () => {
  const r = golden.compareToGolden({ actualContent: 'invoice 101', goldenContent: 'invoice 100' });
  assert.equal(r.status, 'drift');
  assert.notEqual(r.expected_sha, r.actual_sha);
});

test('compareToGolden: line-ending-only difference -> pass (normalized)', () => {
  const r = golden.compareToGolden({ actualContent: 'a\r\nb\r\n', goldenContent: 'a\nb' });
  assert.equal(r.status, 'pass');
});

test('compareToGolden: returns sha-tagged hashes', () => {
  const r = golden.compareToGolden({ actualContent: 'x', goldenContent: 'y' });
  assert.match(r.expected_sha, /^sha256:[a-f0-9]{64}$/);
  assert.match(r.actual_sha, /^sha256:[a-f0-9]{64}$/);
});

// ─── goldenPath (PURE) — traversal guard ────────────────────────────────

test('goldenPath: builds dir/name.golden', () => {
  assert.equal(golden.goldenPath('/g', 'invoice-render'), path.join('/g', 'invoice-render.golden'));
});

test('goldenPath: rejects forward-slash separator', () => {
  assert.throws(() => golden.goldenPath('/g', 'sub/name'), /path separator/);
});

test('goldenPath: rejects backslash separator', () => {
  assert.throws(() => golden.goldenPath('/g', 'sub\\name'), /path separator/);
});

test('goldenPath: rejects .. traversal', () => {
  assert.throws(() => golden.goldenPath('/g', '..'), /'\.\.'/);
  assert.throws(() => golden.goldenPath('/g', 'a..b'), /'\.\.'/);
});

test('goldenPath: rejects a leading-dot (dotfile) name', () => {
  assert.throws(() => golden.goldenPath('/g', '.hidden'), /must not start with '\.'/);
  assert.throws(() => golden.goldenPath('/g', '.gitignore'), /must not start with '\.'/);
  // A dot elsewhere is fine — only a *leading* dot is rejected.
  assert.equal(golden.goldenPath('/g', 'inv.v2'), path.join('/g', 'inv.v2.golden'));
});

test('goldenPath: rejects empty / non-string name', () => {
  assert.throws(() => golden.goldenPath('/g', ''), /non-empty string/);
  assert.throws(() => golden.goldenPath('/g', null), /non-empty string/);
});

// ─── parseGoldenManifest (PURE) — JSON ──────────────────────────────────

test('parseGoldenManifest: JSON by extension', () => {
  const text = JSON.stringify({
    goldens: [{ name: 'inv', command: 'node', args: ['render.js'] }],
  });
  const r = golden.parseGoldenManifest(text, 'goldens.json');
  assert.equal(r.goldens.length, 1);
  assert.deepEqual(r.goldens[0], { name: 'inv', command: 'node', args: ['render.js'] });
});

test('parseGoldenManifest: JSON by leading-brace sniff (no filename)', () => {
  const text = '{"goldens":[{"name":"a","command":"node","args":[]}]}';
  const r = golden.parseGoldenManifest(text);
  assert.equal(r.goldens[0].name, 'a');
  assert.deepEqual(r.goldens[0].args, []);
});

test('parseGoldenManifest: JSON missing args defaults to empty array', () => {
  const text = '{"goldens":[{"name":"a","command":"node"}]}';
  const r = golden.parseGoldenManifest(text);
  assert.deepEqual(r.goldens[0].args, []);
});

test('parseGoldenManifest: invalid JSON throws', () => {
  assert.throws(() => golden.parseGoldenManifest('{not json', 'x.json'), /invalid JSON/);
});

test('parseGoldenManifest: JSON without goldens array throws', () => {
  assert.throws(() => golden.parseGoldenManifest('{"foo":1}', 'x.json'), /goldens.*array/);
});

// ─── parseGoldenManifest (PURE) — YAML ──────────────────────────────────

test('parseGoldenManifest: YAML two goldens', () => {
  const yaml = `goldens:
  - name: invoice-render
    command: node
    args: ["scripts/render.js", "fixtures/inv.json"]
  - name: recon-report
    command: python3
    args: ["recon.py", "fixtures/day.csv"]`;
  const r = golden.parseGoldenManifest(yaml, 'goldens.yml');
  assert.equal(r.goldens.length, 2);
  assert.deepEqual(r.goldens[0], {
    name: 'invoice-render',
    command: 'node',
    args: ['scripts/render.js', 'fixtures/inv.json'],
  });
  assert.deepEqual(r.goldens[1], {
    name: 'recon-report',
    command: 'python3',
    args: ['recon.py', 'fixtures/day.csv'],
  });
});

test('parseGoldenManifest: YAML name on the dash line, other keys at indent 4', () => {
  const yaml = `goldens:
  - name: one
    command: node
    args: []`;
  const r = golden.parseGoldenManifest(yaml, 'g.yaml');
  assert.deepEqual(r.goldens[0], { name: 'one', command: 'node', args: [] });
});

test('parseGoldenManifest: YAML quoted scalars are unquoted', () => {
  const yaml = `goldens:
  - name: "quoted-name"
    command: 'python3'
    args: ["a"]`;
  const r = golden.parseGoldenManifest(yaml, 'g.yml');
  assert.equal(r.goldens[0].name, 'quoted-name');
  assert.equal(r.goldens[0].command, 'python3');
});

test('parseGoldenManifest: YAML comments and blank lines are ignored', () => {
  const yaml = `# top comment
goldens:
  # an item follows
  - name: a
    command: node

    args: ["x"]`;
  const r = golden.parseGoldenManifest(yaml, 'g.yml');
  assert.equal(r.goldens.length, 1);
  assert.deepEqual(r.goldens[0].args, ['x']);
});

test('parseGoldenManifest: duplicate name throws', () => {
  const yaml = `goldens:
  - name: dup
    command: node
  - name: dup
    command: node`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /duplicate golden name: dup/);
});

test('parseGoldenManifest: missing name throws', () => {
  const yaml = `goldens:
  - command: node
    args: []`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /non-empty "name"/);
});

test('parseGoldenManifest: missing command throws', () => {
  const yaml = `goldens:
  - name: a
    args: []`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /non-empty "command"/);
});

test('parseGoldenManifest: path-unsafe name throws', () => {
  const yaml = `goldens:
  - name: ../escape
    command: node`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /path-unsafe/);
});

test('parseGoldenManifest: malformed args (not a JSON array) throws', () => {
  const yaml = `goldens:
  - name: a
    command: node
    args: not-an-array`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /JSON-style array/);
});

test('parseGoldenManifest: unknown top-level key throws', () => {
  const yaml = `runners:
  - name: a
    command: node`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /unknown top-level key/);
});

test('parseGoldenManifest: unknown golden field throws', () => {
  const yaml = `goldens:
  - name: a
    command: node
    bogus: true`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /unknown golden field/);
});

test('parseGoldenManifest: content not starting with a list item throws', () => {
  const yaml = `goldens:
  name: a
  command: node`;
  assert.throws(() => golden.parseGoldenManifest(yaml, 'g.yml'), /expected a list item/);
});

// ─── runCommand (IMPURE) ────────────────────────────────────────────────

test('runCommand: captures stdout and exit 0', () => {
  const r = golden.runCommand({ command: process.execPath, args: ['-e', "process.stdout.write('hi')"] });
  assert.equal(r.exit_code, 0);
  assert.equal(r.stdout, 'hi');
});

test('runCommand: non-zero exit is captured as exit_code', () => {
  const r = golden.runCommand({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
  assert.equal(r.exit_code, 3);
});

// ─── captureGoldens + verifyGoldens (IMPURE integration) ────────────────

test('integration: capture then verify -> PASS', () => {
  const dir = tmpDir();
  try {
    const goldens = [
      { name: 'hello', command: process.execPath, args: ['-e', "process.stdout.write('hello\\n')"] },
    ];
    const cap = golden.captureGoldens({ goldens, dir });
    assert.deepEqual(cap.written, ['hello']);
    assert.deepEqual(cap.failed, []);
    assert.ok(fs.existsSync(golden.goldenPath(dir, 'hello')));

    const v = golden.verifyGoldens({ goldens, dir });
    assert.equal(v.verdict, 'PASS', `reasons: ${v.reasons.join(' | ')}`);
    assert.equal(v.total, 1);
    assert.equal(v.passed, 1);
    assert.deepEqual(v.drifted, []);
  } finally {
    rm(dir);
  }
});

test('integration: captureGoldens is all-or-nothing — one bad name writes NOTHING and throws', () => {
  const dir = tmpDir();
  try {
    // A valid golden BEFORE an illegal one. Without upfront validation the
    // first would land on disk before the second throws (partial capture).
    const goldens = [
      { name: 'good', command: process.execPath, args: ['-e', "process.stdout.write('ok')"] },
      { name: 'bad..name', command: process.execPath, args: ['-e', "process.stdout.write('x')"] },
    ];
    assert.throws(() => golden.captureGoldens({ goldens, dir }), /'\.\.'/);

    // Nothing must have been written — not even the valid 'good' golden.
    assert.ok(!fs.existsSync(path.join(dir, 'good.golden')));
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    assert.deepEqual(entries.filter((e) => e.endsWith('.golden')), []);
  } finally {
    rm(dir);
  }
});

test('integration: captureGoldens rejects a leading-dot name before any write', () => {
  const dir = tmpDir();
  try {
    const goldens = [
      { name: 'first', command: process.execPath, args: ['-e', "process.stdout.write('a')"] },
      { name: '.sneaky', command: process.execPath, args: ['-e', "process.stdout.write('b')"] },
    ];
    assert.throws(() => golden.captureGoldens({ goldens, dir }), /must not start with '\.'/);
    assert.ok(!fs.existsSync(path.join(dir, 'first.golden')));
  } finally {
    rm(dir);
  }
});

test('integration: capture, then verify with different output -> drift -> FAIL', () => {
  const dir = tmpDir();
  try {
    const captureGoldens = [
      { name: 'render', command: process.execPath, args: ['-e', "process.stdout.write('v1')"] },
    ];
    golden.captureGoldens({ goldens: captureGoldens, dir });

    // Same golden name, command now prints different output.
    const verifyGoldens = [
      { name: 'render', command: process.execPath, args: ['-e', "process.stdout.write('v2')"] },
    ];
    const v = golden.verifyGoldens({ goldens: verifyGoldens, dir });
    assert.equal(v.verdict, 'FAIL');
    assert.equal(v.drifted.length, 1);
    assert.equal(v.drifted[0].name, 'render');
    assert.notEqual(v.drifted[0].expected_sha, v.drifted[0].actual_sha);
    assert.ok(v.reasons.some(r => /GOLDEN_DRIFT/.test(r)));
  } finally {
    rm(dir);
  }
});

test('integration: verify with no golden present -> missing-golden -> FAIL', () => {
  const dir = tmpDir();
  try {
    const goldens = [
      { name: 'never-captured', command: process.execPath, args: ['-e', "process.stdout.write('x')"] },
    ];
    const v = golden.verifyGoldens({ goldens, dir });
    assert.equal(v.verdict, 'FAIL');
    assert.equal(v.missing.length, 1);
    assert.equal(v.missing[0].name, 'never-captured');
    assert.equal(v.passed, 0);
    assert.ok(v.reasons.some(r => /GOLDEN_MISSING/.test(r)));
  } finally {
    rm(dir);
  }
});

test('integration: command exits 1 -> run-failed on verify, and not written on capture', () => {
  const dir = tmpDir();
  try {
    // First capture a valid baseline so the verify reaches the run step
    // (not the missing-golden short circuit).
    golden.captureGoldens({
      goldens: [{ name: 'flaky', command: process.execPath, args: ['-e', "process.stdout.write('ok')"] }],
      dir,
    });

    // Capture a *failing* command: must NOT be written, must be reported failed.
    const failing = [
      { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(1)'] },
    ];
    const cap = golden.captureGoldens({ goldens: failing, dir });
    assert.deepEqual(cap.written, []);
    assert.equal(cap.failed.length, 1);
    assert.equal(cap.failed[0].name, 'broken');
    assert.ok(!fs.existsSync(golden.goldenPath(dir, 'broken')));

    // Verify a golden whose command now exits 1 -> run-failed.
    const verify = [
      { name: 'flaky', command: process.execPath, args: ['-e', 'process.exit(1)'] },
    ];
    const v = golden.verifyGoldens({ goldens: verify, dir });
    assert.equal(v.verdict, 'FAIL');
    assert.equal(v.run_failed.length, 1);
    assert.equal(v.run_failed[0].name, 'flaky');
    assert.equal(v.run_failed[0].exit_code, 1);
    assert.ok(v.reasons.some(r => /GOLDEN_RUN_FAILED/.test(r)));
  } finally {
    rm(dir);
  }
});

test('integration: capture normalizes line endings before writing', () => {
  const dir = tmpDir();
  try {
    // Command prints CRLF + trailing newline; stored golden should be normalized.
    const goldens = [
      { name: 'crlf', command: process.execPath, args: ['-e', "process.stdout.write('a\\r\\nb\\r\\n')"] },
    ];
    golden.captureGoldens({ goldens, dir });
    const stored = fs.readFileSync(golden.goldenPath(dir, 'crlf'), 'utf8');
    assert.equal(stored, 'a\nb');

    // Verifying the same command passes (normalization is symmetric).
    const v = golden.verifyGoldens({ goldens, dir });
    assert.equal(v.verdict, 'PASS', `reasons: ${v.reasons.join(' | ')}`);
  } finally {
    rm(dir);
  }
});

test('integration: mixed result -> one pass, one drift -> FAIL with correct tallies', () => {
  const dir = tmpDir();
  try {
    const baseline = [
      { name: 'stable', command: process.execPath, args: ['-e', "process.stdout.write('same')"] },
      { name: 'changing', command: process.execPath, args: ['-e', "process.stdout.write('before')"] },
    ];
    golden.captureGoldens({ goldens: baseline, dir });

    const verify = [
      { name: 'stable', command: process.execPath, args: ['-e', "process.stdout.write('same')"] },
      { name: 'changing', command: process.execPath, args: ['-e', "process.stdout.write('after')"] },
    ];
    const v = golden.verifyGoldens({ goldens: verify, dir });
    assert.equal(v.verdict, 'FAIL');
    assert.equal(v.total, 2);
    assert.equal(v.passed, 1);
    assert.equal(v.drifted.length, 1);
    assert.equal(v.drifted[0].name, 'changing');
  } finally {
    rm(dir);
  }
});

// ─── renderGoldenReport (human-readable) ────────────────────────────────

test('renderGoldenReport: PASS result reads cleanly', () => {
  const out = golden.renderGoldenReport({
    total: 1, passed: 1, drifted: [], missing: [], run_failed: [], verdict: 'PASS', reasons: [],
  });
  assert.match(out, /verdict: PASS/);
  assert.match(out, /1 total, 1 passed/);
});

test('renderGoldenReport: FAIL result lists drift, missing, run-failed and reasons', () => {
  const out = golden.renderGoldenReport({
    total: 3,
    passed: 0,
    drifted: [{ name: 'd', expected_sha: 'sha256:aa', actual_sha: 'sha256:bb' }],
    missing: [{ name: 'm' }],
    run_failed: [{ name: 'f', exit_code: 1 }],
    verdict: 'FAIL',
    reasons: ['GOLDEN_DRIFT: d changed'],
  });
  assert.match(out, /verdict: FAIL/);
  assert.match(out, /DRIFT/);
  assert.match(out, /MISSING/);
  assert.match(out, /RUN-FAILED/);
  assert.match(out, /GOLDEN_DRIFT: d changed/);
});

test('renderGoldenReport: missing/invalid verdict throws (fail closed, no UNKNOWN)', () => {
  assert.throws(() => golden.renderGoldenReport({ total: 0, passed: 0 }), /missing\/invalid verdict/);
  assert.throws(() => golden.renderGoldenReport({ verdict: null }), /missing\/invalid verdict/);
  assert.throws(() => golden.renderGoldenReport({ verdict: 'UNKNOWN' }), /missing\/invalid verdict/);
  assert.throws(() => golden.renderGoldenReport(undefined), /missing\/invalid verdict/);
});

// ─── require sanity ─────────────────────────────────────────────────────

test('module exports the documented surface', () => {
  for (const fn of [
    'normalizeOutput', 'sha256', 'compareToGolden', 'goldenPath',
    'parseGoldenManifest', 'runCommand', 'captureGoldens', 'verifyGoldens',
    'renderGoldenReport',
  ]) {
    assert.equal(typeof golden[fn], 'function', `missing export: ${fn}`);
  }
});
