'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildReceipt, serializeReceipt } = require('../lib/receipt');
const { actorsFromYaml, currentApprovers, githubBypassRate, verifyCiReceipt } = require('../lib/ci_guard');
const sha = 'a'.repeat(40);
const review = (id, login, state = 'APPROVED', commit_id = sha) => ({ id, user: { login }, state, commit_id });

test('allowlist subset accepts inline comments without accepting invalid identities or other YAML forms', () => {
  assert.deepEqual(actorsFromYaml('# team\nallowed_actors: # reviewers\n  - alice # oncall\n  - bob\t# backup\n'), ['alice', 'bob']);
  assert.deepEqual(actorsFromYaml('allowed_actors: [] # empty\n'), []);
  assert.deepEqual(actorsFromYaml('allowed_actors:\n  - alice\n'), ['alice']);
  for (const text of [
    'allowed_actors:\n  - ali_ce # invalid\n',
    'allowed_actors:\n  - alice#comment\n',
    'allowed_actors:\n  - "alice" # quoted\n',
    'allowed_actors: [alice] # flow list\n',
    'allowed_actors:\n  - alice\nother: true # unknown key\n',
    'allowed_actors:\n  - ' + 'a'.repeat(40) + ' # too long\n',
  ]) assert.throws(() => actorsFromYaml(text), /allowlist/);
});

test('second approval excludes the author, requester, removed users and old-head approvals', () => {
  assert.deepEqual(currentApprovers({ headSha: sha, author: 'author', requester: 'requester',
    allowlist: ['author', 'requester', 'reviewer'], reviews: [review(1, 'author'), review(2, 'requester'),
      review(3, 'removed'), review(4, 'reviewer', 'APPROVED', 'b'.repeat(40)), review(5, 'reviewer')] }), ['reviewer']);
});
test('a later change request or dismissal revokes a prior approval, regardless of API ordering', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) assert.deepEqual(currentApprovers({
    headSha: sha, author: 'author', allowlist: ['reviewer'], reviews: [review(8, 'reviewer', state), review(1, 'reviewer')],
  }), []);
  assert.deepEqual(currentApprovers({ headSha: sha, author: 'author', allowlist: ['reviewer'], reviews: [review(1, 'reviewer'), review(9, 'reviewer', 'COMMENTED')] }), ['reviewer']);
});
test('malformed review evidence fails closed', () => {
  assert.throws(() => currentApprovers({ headSha: sha, allowlist: ['reviewer'], reviews: [{}] }), /evidence/);
});

function artifact(name, run = 10) {
  return { name, created_at: '2026-10-12T13:00:00Z', expired: false, workflow_run: { id: run } };
}
function rate(artifacts, overrides = {}) {
  const completed = [...new Set(artifacts.map(a => Number(a.name.split('-').at(-2))))].map(id => ({
    id, run_attempt: Math.max(...artifacts.filter(a => a.name.split('-').at(-2) === String(id)).map(a => Number(a.name.split('-').at(-1)))),
    path: '.github/workflows/fqe-publish.yml',
  }));
  return githubBypassRate({ repo: 'org/repo', now: '2026-10-12T14:00:00Z', currentHead: sha,
    fetch: endpoint => {
      if (endpoint.includes('/workflows/')) return [{ total_count: completed.length, workflow_runs: completed }];
      if (endpoint.includes('/artifacts?')) {
        const id = Number(endpoint.match(/runs\/(\d+)\//)[1]);
        const found = artifacts.filter(a => a.name.split('-').at(-2) === String(id));
        return [{ total_count: found.length, artifacts: found }];
      }
      return [{ id: Number(endpoint.split('/').pop()), run_attempt: 2, path: '.github/workflows/fqe-publish.yml' }];
    }, ...overrides });
}
test('bypass rate is recovered from earlier immutable workflow artifacts in a clean job', () => {
  const r = rate([artifact('fqe-audit-v2-bypass-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-1')], { currentRun: '11-1', currentBypass: false });
  assert.equal(r.rate, 0.5);
  assert.equal(r.denominator, 2);
});
test('audit history counts distinct heads and refuses conflicting attempt records', () => {
  assert.equal(rate([artifact('fqe-audit-v2-normal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-1'), artifact('fqe-audit-v2-bypass-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-2')]).denominator, 1);
  assert.throws(() => rate([artifact('fqe-audit-v2-normal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-1'), artifact('fqe-audit-v2-bypass-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-1')]), /duplicate/);
  const repeated = rate([artifact('fqe-audit-v2-bypass-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-1'), artifact('fqe-audit-v2-normal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-11-1', 11)]);
  assert.equal(repeated.denominator, 1);
  assert.equal(repeated.rate, 1);
});
test('missing, expired, misbound or unreadable audit evidence cannot claim a zero rate', () => {
  assert.equal(rate([]).rate, null);
  for (const a of [
    { ...artifact('fqe-audit-v2-normal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-1'), expired: true },
    artifact('fqe-audit-v2-normal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-10-1', 999),
    artifact('fqe-audit-v1-normal-10-1'),
  ]) assert.throws(() => rate([a]), /audit/);
  assert.throws(() => rate([], { fetch: () => { throw new Error('GitHub down'); } }), /GitHub down/);
});

function verify(t, overrides = {}, receipts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-publisher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptPath = path.join(dir, 'QA-RESULT.yml');
  const r = buildReceipt({ fqe_version: 'test', run_id: '10-1',
    started_at: '2026-10-12T13:00:00Z', finished_at: '2026-10-12T13:01:00Z',
    commit_sha: sha, content_hash: 'sha256:' + 'b'.repeat(64), inputs_hash: 'sha256:' + 'c'.repeat(64),
    classifier_version: 1, runner_versions: {}, runners_fired: [], runners: [], verdict: 'PASS', ...receipts });
  fs.writeFileSync(receiptPath, serializeReceipt(r).yaml);
  const responses = {
    'repos/org/repo': [{ default_branch: 'main' }],
    'repos/org/repo/pulls/1': [{ head: { sha }, state: 'open', changed_files: 1, user: { login: 'author' } }],
    'repos/org/repo/actions/runs/10': [{ path: '.github/workflows/fqe-quality.yml', event: 'pull_request', head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success' }],
    'repos/org/repo/issues/1/comments?per_page=100': [[]],
    'repos/org/repo/pulls/1/files?per_page=100': [[{ filename: 'app.js' }]],
    'repos/org/repo/pulls/1/reviews?per_page=100': [[]],
    'repos/org/repo/actions/runs/11/artifacts?per_page=100': [{ total_count: 0, artifacts: [] }],
    'repos/org/repo/actions/workflows/fqe-publish.yml/runs?per_page=100&status=completed&created=%3E%3D2026-09-28T14%3A00%3A00.000Z': [{ total_count: 0, workflow_runs: [] }],
  };
  for (const f of ['fqe-bypass-allowlist.yml', 'fqe-second-reviewers.yml']) {
    responses[`repos/org/repo/contents/.github/${f}?ref=main`] = [{ encoding: 'base64',
      content: Buffer.from('allowed_actors:\n  - reviewer\n  - author\n').toString('base64') }];
  }
  Object.assign(responses, overrides);
  return verifyCiReceipt({ repo: 'org/repo', pr: 1, headSha: sha, runId: '10-1', auditRunId: '11-1',
    now: '2026-10-12T14:00:00Z', fqeVersion: 'test', receiptPath, fetch: endpoint => {
      if (!responses[endpoint]) throw new Error('Unexpected GitHub lookup: ' + endpoint);
      return responses[endpoint];
    } });
}

test('trusted publisher permits an ordinary verified run and blocks stale or unsuccessful runs', t => {
  assert.equal(verify(t).check_state, 'success');
  assert.throws(() => verify(t, { 'repos/org/repo/pulls/1': [{ head: { sha: 'b'.repeat(40) }, state: 'open' }] }), /stale/);
  assert.throws(() => verify(t, { 'repos/org/repo/actions/runs/10': [{ path: '.github/workflows/fqe-quality.yml', event: 'pull_request', head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'failure' }] }), /successfully/);
  assert.throws(() => verify(t, {}, { run_id: 'old-attempt' }), /does not match/);
  assert.throws(() => verify(t, { 'repos/org/repo/actions/runs/10': [{ path: '.github/workflows/fqe-quality.yml', event: 'pull_request', head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success', pull_requests: [{ number: 2 }] }] }), /different PR/);
});

test('oracle changes require an authorized non-author approval of the current head', t => {
  const files = { 'repos/org/repo/pulls/1/files?per_page=100': [[{ filename: '.fqe.yml' }]] };
  const blocked = verify(t, files);
  assert.equal(blocked.check_state, 'failure');
  assert.equal(blocked.second_state, 'failure');
  const explained = serializeReceipt(blocked.receipt).markdown;
  assert.match(explained, /CI_ORACLE_REVIEW_REQUIRED/);
  assert.match(explained, /default branch's .github\/fqe-second-reviewers.yml/);
  assert.match(explained, /approve this exact head/);
  assert.match(explained, /Verify in GitHub/);
  assert.doesNotMatch(explained, /UNKNOWN_REASON|File an issue|Reproduce locally/);
  assert.equal(verify(t, { ...files, 'repos/org/repo/pulls/1/reviews?per_page=100': [[review(1, 'author')]] }).check_state, 'failure');
  const approved = verify(t, { ...files, 'repos/org/repo/pulls/1/reviews?per_page=100': [[review(2, 'reviewer')]] });
  assert.equal(approved.check_state, 'success');
  assert.equal(approved.second_state, 'success');
  assert.throws(() => verify(t, { 'repos/org/repo/pulls/1/files?per_page=100': [[]] }), /incomplete/);
});

test('only a live server comment can create a bypass, and a high rate requires a different reviewer', t => {
  const comments = { 'repos/org/repo/issues/1/comments?per_page=100': [[{ user: { login: 'author' },
    created_at: '2026-10-12T13:00:00Z', updated_at: '2026-10-12T13:00:00Z', body: `/fqe-bypass ${sha} 24h` }]] };
  const blocked = verify(t, comments, { verdict: 'FAIL' });
  assert.equal(blocked.bypass, false);
  assert.equal(blocked.receipt.verdict, 'FAIL');
  assert.equal(blocked.receipt.bypass.applied, false);
  assert.equal(blocked.check_state, 'failure');
  const explained = serializeReceipt(blocked.receipt).markdown;
  assert.match(explained, /CI_BYPASS_REVIEW_REQUIRED/);
  assert.match(explained, /CI_BYPASS_REQUEST_VALID/);
  assert.match(explained, /bypass is not applied/);
  assert.match(explained, /other than the PR author or bypass requester/);
  assert.match(explained, /rerun the current-head FQE Publish/);
  assert.doesNotMatch(explained, /UNKNOWN_REASON|File an issue|Reproduce locally/);
  const approved = verify(t, { ...comments, 'repos/org/repo/pulls/1/reviews?per_page=100': [[review(1, 'reviewer')]] }, { verdict: 'FAIL' });
  assert.equal(approved.check_state, 'success');
  assert.equal(approved.bypass, true);
  assert.equal(approved.receipt.bypass.requester, 'author');
  assert.equal(approved.receipt.run_id, '10-1');
});

test('simultaneous oracle and high-bypass-rate failures retain both reasons and remain blocked', t => {
  const overrides = {
    'repos/org/repo/pulls/1/files?per_page=100': [[{ filename: '.fqe.yml' }]],
    'repos/org/repo/issues/1/comments?per_page=100': [[{ user: { login: 'author' },
      created_at: '2026-10-12T13:00:00Z', updated_at: '2026-10-12T13:00:00Z', body: `/fqe-bypass ${sha} 24h` }]],
  };
  const blocked = verify(t, overrides);
  assert.ok(blocked.rate.rate > 0.1);
  assert.ok(blocked.receipt.verdict_reasons.includes('CI authority guard: changed grading rules require an authorized non-author approval of this head'));
  assert.ok(blocked.receipt.verdict_reasons.includes('CI authority guard: bypass rate exceeds 10%; a different authorized reviewer must approve this head'));
  assert.equal(blocked.receipt.verdict, 'FAIL');
  assert.equal(blocked.check_state, 'failure');
  assert.equal(blocked.second_state, 'failure');
  assert.equal(blocked.bypass, false);
  assert.equal(blocked.receipt.bypass.applied, false);
  const approved = verify(t, { ...overrides, 'repos/org/repo/pulls/1/reviews?per_page=100': [[review(1, 'reviewer')]] });
  assert.equal(approved.receipt.verdict, 'PASS');
  assert.equal(approved.check_state, 'success');
  assert.equal(approved.second_state, 'success');
  assert.equal(approved.bypass, true);
  assert.equal(approved.receipt.bypass.applied, true);
});

test('generated evaluation and publisher can pin the same immutable ref and reject shell text', t => {
  const { init } = require('../lib/init');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-ref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.git'));
  init({ dir, actor: 'reviewer', ref: sha });
  for (const file of ['fqe-quality.yml', 'fqe-publish.yml']) {
    assert.ok(fs.readFileSync(path.join(dir, '.github/workflows', file), 'utf8').includes(`FQE_REF="${sha}"`));
  }
  assert.throws(() => init({ dir, ref: '$(touch injected)' }), /full commit SHA/);
});

 test('deleted audit records and a truncated publisher inventory fail closed', () => {
  for (const history of [
    { total_count: 1, workflow_runs: [{ id: 12, run_attempt: 1, path: '.github/workflows/fqe-publish.yml' }] },
    { total_count: 1001, workflow_runs: [] },
  ]) assert.throws(() => rate([], { fetch: endpoint => endpoint.includes('/artifacts?') ? [{ total_count: 0, artifacts: [] }] : [history] }), /missing its audit|incomplete/);
});

test('rerunning a failed publisher repairs its missing latest audit record without a 14-day lockout', () => {
  const fetch = endpoint => endpoint.includes('/artifacts?') ? [{ total_count: endpoint.includes('/12/') ? 1 : 0, artifacts: endpoint.includes('/12/') ? [artifact('fqe-audit-v2-normal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-12-2', 12)] : [] }]
    : endpoint.includes('/workflows/') ? [{ total_count: 1, workflow_runs: [{ id: 12, run_attempt: 2, path: '.github/workflows/fqe-publish.yml' }] }]
    : [{ id: 12, path: '.github/workflows/fqe-publish.yml', run_attempt: 2 }];
  assert.equal(rate([], { fetch, currentRun: '13-1', currentBypass: false }).rate, 0);
});

test('ordinary clean PRs keep their verified result even when bypass history is unavailable', t => {
  const data = {
    'repos/org/repo/actions/runs/12/artifacts?per_page=100': [{ total_count: 1, artifacts: [artifact('fqe-audit-v2-bypass-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-12-1', 12)] }],
    'repos/org/repo/actions/workflows/fqe-publish.yml/runs?per_page=100&status=completed&created=%3E%3D2026-09-28T14%3A00%3A00.000Z': [{ total_count: 1, workflow_runs: [{ id: 12, path: '.github/workflows/fqe-publish.yml', run_attempt: 1 }] }],
    'repos/org/repo/actions/runs/12': [{ id: 12, path: '.github/workflows/fqe-publish.yml', run_attempt: 1 }],
  };
  data['repos/org/repo/actions/workflows/fqe-publish.yml/runs?per_page=100&status=completed&created=%3E%3D2026-09-28T14%3A00%3A00.000Z'] = [{ total_count: 1001, workflow_runs: [] }];
  const r = verify(t, data);
  assert.equal(r.rate.rate, null);
  assert.equal(r.rate.source, 'not_queried');
  assert.equal(r.check_state, 'success');
  assert.equal(r.second_state, 'success');
});
