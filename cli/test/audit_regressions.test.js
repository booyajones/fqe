'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../lib/orchestrator');
const { buildReceipt, serializeReceipt, parseReceiptYaml } = require('../lib/receipt');
const { aggregateScorecard } = require('../lib/scorecard');

const cli = path.resolve(__dirname, '../bin/fqe.js');
const sha = 'a'.repeat(40);
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function receipt(overrides = {}) {
  return buildReceipt({
    fqe_version: 'test', run_id: 'current-run',
    started_at: '2026-10-12T14:00:00Z', finished_at: '2026-10-12T14:01:00Z',
    commit_sha: sha, content_hash: 'sha256:' + 'b'.repeat(64), inputs_hash: 'sha256:' + 'c'.repeat(64),
    classifier_version: 1, runner_versions: {}, runners_fired: [], runners: [],
    verdict: 'PASS', bypass: null, ...overrides,
  });
}
function mutationRun(t, payload) {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports = 1;');
  const runners = payload === undefined ? {} : { mutation: {
    command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(payload))})`],
    class: 'mutation', required: true, always_run: true,
  } };
  const config = ['mutation:', '  mode: blocking', '  threshold: 70', 'runners:'];
  for (const [name, cfg] of Object.entries(runners)) {
    config.push('  ' + name + ':');
    for (const [key, value] of Object.entries(cfg)) config.push('    ' + key + ': ' + JSON.stringify(value));
  }
  fs.writeFileSync(path.join(dir, '.fqe.yml'), config.join('\n'));
  const previous = process.env.FQE_CHANGED_FILES;
  process.env.FQE_CHANGED_FILES = 'app.js';
  try { return run({ repoDir: dir, commitSha: sha, outputDir: path.join(dir, 'out'), fqeVersion: 'test' }); }
  finally {
    if (previous === undefined) delete process.env.FQE_CHANGED_FILES;
    else process.env.FQE_CHANGED_FILES = previous;
  }
}

test('blocking mutation requires a runner and a report, even when no payload is emitted', t => {
  assert.equal(mutationRun(t, undefined).verdict, 'FAIL');
  assert.equal(mutationRun(t, {}).verdict, 'FAIL');
});

test('count-only mutation preserves surviving mutants without inventing file scope', t => {
  const r = mutationRun(t, { mutation: { killed: 5, surviving: 10 } });
  assert.equal(r.verdict, 'FAIL');
  assert.match(r.reasons.join(' '), /33\.33|10 live survivor/);
});

test('malformed or inconsistent mutation counts never produce a clean result', t => {
  for (const mutation of [
    { killed: -1, surviving: 2 }, { killed: 1.5, surviving: 1 },
    { killed: '5', surviving: '0' }, { killed: 5, surviving: 10, survivors: [] },
  ]) assert.equal(mutationRun(t, { mutation }).verdict, 'FAIL');
});

test('receipt parsing rejects missing and unknown verdicts', () => {
  for (const yaml of ['schema_version: 1\n', 'schema_version: 1\nverdict: ERROR\n']) {
    assert.throws(() => parseReceiptYaml(yaml), /required|verdict/);
  }
});

test('status checks reject receipts for a different commit or workflow attempt', t => {
  const dir = temp(t);
  const p = path.join(dir, 'QA-RESULT.yml');
  fs.writeFileSync(p, serializeReceipt(receipt()).yaml);
  for (const args of [
    ['--expected-commit', 'b'.repeat(40)], ['--expected-run-id', 'wrong-run'],
  ]) {
    const r = spawnSync(process.execPath, [cli, 'status', 'print', p, ...args], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not match/);
  }
  const valid = spawnSync(process.execPath, [cli, 'status', 'print', p,
    '--expected-commit', sha, '--expected-run-id', 'current-run'], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
});

test('a failed run cannot leave an older PASS receipt for the publisher', t => {
  const dir = temp(t);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'QA-RESULT.yml'), serializeReceipt(receipt()).yaml);
  fs.writeFileSync(path.join(out, 'QA-RESULT.md'), 'old PASS');
  fs.writeFileSync(path.join(dir, '.fqe.yml'), 'unknown_key: true\n');
  assert.throws(() => run({ repoDir: dir, commitSha: sha, outputDir: out, fqeVersion: 'test' }), /invalid/);
  assert.equal(fs.existsSync(path.join(out, 'QA-RESULT.yml')), false);
  assert.equal(fs.existsSync(path.join(out, 'QA-RESULT.md')), false);
});

test('scorecard correlates a failed attempt with a later bypass of that same commit', () => {
  const failed = receipt({ verdict: 'FAIL' });
  const bypass = receipt({ started_at: '2026-10-12T14:02:00Z', finished_at: '2026-10-12T14:02:00Z',
    bypass: { requester: 'maintainer', requester_source: 'github_comments_api_v3', events_url: 'https://example.invalid', allowlist_version: 'sha256:x', timestamp: '2026-10-12T14:02:00Z' } });
  const card = aggregateScorecard([failed, bypass]);
  assert.equal(card.false_red.candidates, 1);
  assert.equal(card.false_red.rate, 1);
  assert.equal(card.true_catches, 0);
  const unrelated = aggregateScorecard([failed, { ...bypass, commit_sha: 'b'.repeat(40) }]);
  assert.equal(unrelated.false_red.candidates, 0);
});

test('a failing JUnit report blocks even when its process exits zero', t => {
  const dir = temp(t);
  const report = '<testsuite failures="1"><testcase name="broken"><failure>assertion failed</failure></testcase></testsuite>';
  const code = `require('node:fs').writeFileSync('report.xml', ${JSON.stringify(report)})`;
  const config = `runners:\n  unit:\n    command: ${JSON.stringify(process.execPath)}\n    args: ${JSON.stringify(['-e', code])}\n    always_run: true\n    required: true\n    report: "junit:report.xml"\n`;
  fs.writeFileSync(path.join(dir, '.fqe.yml'), config);
  const result = run({ repoDir: dir, commitSha: sha, outputDir: path.join(dir, 'out'), fqeVersion: 'test' });
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.reasons.join(' '), /reported 1 failed/);
});

test('signatures authenticate workflow attempt, time and runner evidence through YAML round trips', () => {
  const { signReceipt, verifyReceipt } = require('../lib/signature');
  const signed = signReceipt(receipt({ runners: [{ name: 'unit', ran: true, exit_code: 0, detail: undefined }] }), 'synthetic-key');
  const parsed = parseReceiptYaml(serializeReceipt(signed).yaml);
  assert.equal(verifyReceipt(parsed, 'synthetic-key').ok, true);
  for (const changed of [
    { run_id: 'forged-attempt' }, { finished_at: '2030-01-01T00:00:00Z' },
    { runners: [{ name: 'unit', ran: true, exit_code: 2 }] },
    { classifier_version: 999 }, { runner_versions: { unit: 'forged' } }, { quarantined_tests: ['hidden'] },
  ]) assert.equal(verifyReceipt({ ...parsed, ...changed }, 'synthetic-key').ok, false);
});

test('receipt parsing refuses duplicate or prototype keys instead of changing the claim', () => {
  const yaml = serializeReceipt(receipt()).yaml;
  assert.throws(() => parseReceiptYaml(yaml + '\nverdict: FAIL\n'), /duplicate/);
  assert.throws(() => parseReceiptYaml(yaml + '\n__proto__:\n  verdict: PASS\n'), /unsafe/);
});

test('historical HMAC receipts remain authentic only for their original fixed field list', () => {
  const crypto = require('node:crypto');
  const { verifyReceipt, stableStringify, keyIdOf } = require('../lib/signature');
  const covers = ['schema_version', 'fqe_version', 'commit_sha', 'content_hash', 'inputs_hash', 'verdict', 'bypass'];
  const archived = receipt({ fqe_version: '0.18.19' });
  const payload = Object.fromEntries(covers.map(k => [k, archived[k] ?? null]));
  const key = 'synthetic-historical-key';
  archived.signature = { alg: 'hmac-sha256', key_id: keyIdOf(key), covers,
    value: crypto.createHmac('sha256', key).update(stableStringify(payload)).digest('hex') };
  const result = verifyReceipt(archived, key);
  assert.equal(result.ok, true);
  assert.ok(result.unsigned_fields.includes('run_id'));
  assert.ok(result.unsigned_fields.includes('runners'));
  assert.equal(verifyReceipt({ ...archived, verdict: 'FAIL' }, key).ok, false);
});

test('the standard installer refuses a hollow gate and wires an actual deterministic mutation judge', t => {
  const { init } = require('../lib/init');
  const { parseConfigYaml } = require('../lib/orchestrator');
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, '.git'));
  init({ dir, actor: 'reviewer' });
  assert.equal(run({ repoDir: dir, commitSha: sha, outputDir: path.join(dir, 'out'), fqeVersion: 'test' }).verdict, 'FAIL');
  init({ dir, actor: 'reviewer', force: true, withMutation: true });
  const config = parseConfigYaml(fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8'));
  assert.equal(config.mutation.mode, 'advisory');
  assert.equal(config.runners['stryker-mutation'].class, 'mutation');
  assert.equal(config.runners['stryker-mutation'].always_run, true);
  const wrapper = fs.readFileSync(path.join(dir, 'scripts/fqe_stryker_runner.js'), 'utf8');
  assert.doesNotMatch(wrapper, /adversarial_stats\s*:/);
  assert.match(wrapper, /mutation_report:/);
});

test('the mutation wrapper handles large embedded source without losing its verdict evidence', t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'app.js'), 'module.exports=1;');
  const preload = path.join(dir, 'fake-stryker.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');require('node:child_process').spawnSync=()=>{const p=path.join(process.cwd(),'reports/mutation/mutation.json');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify({files:{'app.js':{source:'x'.repeat(2*1024*1024),mutants:[{status:'Killed',mutatorName:'Boolean',location:{start:{line:1}}}]}}}));return {status:0};};`);
  const config = ['mutation:', '  mode: blocking', '  threshold: 70', 'runners:', '  mutation:',
    '    command: ' + JSON.stringify(process.execPath),
    '    args: ' + JSON.stringify(['--require', preload, path.resolve(__dirname, '../templates/fqe_stryker_runner.js')]),
    '    class: mutation', '    required: true', '    always_run: true'];
  fs.writeFileSync(path.join(dir, '.fqe.yml'), config.join('\n'));
  const prior = process.env.FQE_CHANGED_FILES; process.env.FQE_CHANGED_FILES = 'app.js';
  try {
    const result = run({ repoDir: dir, commitSha: sha, outputDir: path.join(dir, 'out'), fqeVersion: 'test' });
    assert.equal(result.verdict, 'PASS', result.reasons.join(' '));
    assert.ok(fs.statSync(path.join(dir, 'out/runner-mutation.log')).size < 2000);
  } finally { if (prior === undefined) delete process.env.FQE_CHANGED_FILES; else process.env.FQE_CHANGED_FILES = prior; }
});

test('JUnit suite-only errors are counted across independent suites', () => {
  const { parseJUnit } = require('../lib/junit');
  assert.equal(parseJUnit('<testsuites><testsuite errors="1"><testcase name="a"/></testsuite><testsuite failures="2"><testcase name="b"/></testsuite></testsuites>').failed, 3);
});
