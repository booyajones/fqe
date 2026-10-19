'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('publisher keeps an audit file when evidence or authorization fails', { skip: process.platform === 'win32' }, t => {
  const template = fs.readFileSync(path.join(__dirname, '../../workflows/fqe-publish.yml.template'), 'utf8');
  const section = template.split('      - name: Verify current authority and publish checks\n')[1]
    .split('      - name: Persist verified receipt and audit record\n')[0];
  const script = section.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-publisher-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = `fqe() {
    if [ "$1" = ci-verify ]; then
      [ "$CASE" != rejected ] || return 1
      printf '%s\\n' 'Verified receipt' > "$VERIFIED/QA-RESULT.md"
      printf '%s\\n' '{"check_state":"success","second_state":"success","bypass":false}'
    else
      printf '%s\\n' "$*" >> "$PUBLISH_LOG"
    fi
  }\n`;
  for (const scenario of ['missing', 'invalid-pr', 'rejected', 'verified']) {
    const workspace = path.join(dir, scenario);
    fs.mkdirSync(workspace);
    if (scenario !== 'missing') fs.writeFileSync(path.join(workspace, 'context.json'),
      JSON.stringify({ pr: scenario === 'invalid-pr' ? null : 1 }));
    const result = spawnSync('bash', ['-c', mock + script], { encoding: 'utf8', env: {
      ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
      CASE: scenario, EVIDENCE: workspace, RUNNER_TEMP: workspace,
      GITHUB_ENV: path.join(workspace, 'env'), GITHUB_OUTPUT: path.join(workspace, 'output'),
      PUBLISH_LOG: path.join(workspace, 'publish'), REPO: 'org/repo', HEAD_SHA: 'a'.repeat(40),
      SOURCE_RUN: '10', SOURCE_ATTEMPT: '1', GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1',
    } });
    assert.ifError(result.error);
    assert.equal(result.status, scenario === 'verified' ? 0 : 1, scenario + ': ' + result.stderr);
    const verified = fs.readFileSync(path.join(workspace, 'env'), 'utf8').trim().slice('VERIFIED='.length);
    const markdown = fs.readFileSync(path.join(verified, 'QA-RESULT.md'), 'utf8');
    assert.match(markdown, scenario === 'verified' ? /^Verified receipt\n$/ : /could not be verified/, scenario);
    assert.equal(fs.readFileSync(path.join(workspace, 'output'), 'utf8'), 'bypass=normal\n');
    const checks = fs.readFileSync(path.join(workspace, 'publish'), 'utf8').trim().split('\n');
    assert.equal(checks.length, 2);
    for (const check of checks) assert.ok(check.includes('--state ' + (scenario === 'verified' ? 'success' : 'failure')), check);
    assert.ok(checks[0].includes('--check fqe/pass '));
    assert.ok(checks[1].includes('--check fqe/second-reviewer-required '));
    if (scenario === 'rejected') assert.equal(fs.statSync(path.join(verified, 'verification.json')).size, 0);
  }
});
