'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { evaluateBypass } = require('./bypass_guard');
const { evaluateOracleGuard } = require('./oracle_guard');
const { parseReceiptYaml, buildReceipt, hashString } = require('./receipt');

function githubJson(endpoint) {
  const r = spawnSync('gh', ['api', '--paginate', '--slurp', endpoint], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`GitHub evidence unavailable: ${r.error ? r.error.message : r.stderr}`);
  const pages = JSON.parse(r.stdout);
  if (!Array.isArray(pages)) throw new Error('GitHub evidence is not a paginated response');
  return pages;
}

// Only a review of this head from a currently authorized, different person counts.
function currentApprovers({ reviews, headSha, author, requester, allowlist }) {
  if (!Array.isArray(reviews) || !/^[a-f0-9]{40}$/.test(headSha || '') || !Array.isArray(allowlist)) {
    throw new Error('review evidence, current head and allowlist are required');
  }
  const latest = new Map();
  for (const review of reviews) {
    const login = review && review.user && review.user.login;
    if (!login || !Number.isSafeInteger(review.id)) throw new Error('review evidence missing server identity or ID');
    if (['PENDING', 'COMMENTED'].includes(review.state)) continue;
    if (!latest.has(login) || review.id > latest.get(login).id) latest.set(login, review);
  }
  return [...latest.values()].filter(r => r.state === 'APPROVED' && r.commit_id === headSha &&
    r.user.login !== author && r.user.login !== requester && allowlist.includes(r.user.login))
    .map(r => r.user.login).sort();
}

// Immutable Actions artifacts are the audit ledger; a PR-branch file is never history.
function githubBypassRate({ repo, now = new Date(), windowDays = 14, currentRun, currentBypass, fetch = githubJson }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error('a repository and positive history window are required');
  }
  const cutoff = new Date(now).getTime() - windowDays * 86400000;
  if (!Number.isFinite(cutoff)) throw new Error('invalid audit clock');
  if (currentRun !== undefined && (!/^\d+-\d+$/.test(currentRun) || typeof currentBypass !== 'boolean')) throw new Error('current workflow attempt is invalid');
  const history = fetch(`repos/${repo}/actions/workflows/fqe-publish.yml/runs?per_page=100&status=completed&created=${encodeURIComponent('>=' + new Date(cutoff).toISOString())}`);
  const completed = history.flatMap(p => {
    if (!p || !Array.isArray(p.workflow_runs) || !Number.isSafeInteger(p.total_count)) throw new Error('publisher history is malformed');
    return p.workflow_runs;
  });
  if (history.some(p => p.total_count > completed.length)) throw new Error('publisher history is incomplete');
  const runs = new Map();
  for (const run of completed) {
    if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || !/^\.github\/workflows\/fqe-publish\.yml(?:@.+)?$/.test(run.path || '')) throw new Error('publisher history has no trusted attempt identity');
    runs.set(run.id, run);
  }
  const ids = new Set(runs.keys());
  if (currentRun !== undefined) ids.add(Number(currentRun.split('-')[0]));
  const artifacts = [];
  for (const id of ids) {
    const pages = fetch(`repos/${repo}/actions/runs/${id}/artifacts?per_page=100`);
    const found = pages.flatMap(p => {
      if (!p || !Array.isArray(p.artifacts) || !Number.isSafeInteger(p.total_count)) throw new Error('artifact history is malformed');
      return p.artifacts;
    });
    if (pages.some(p => p.total_count > found.length)) throw new Error('artifact history is incomplete');
    artifacts.push(...found);
  }
  const records = new Map();
  for (const a of artifacts) {
    const match = /^fqe-audit-v1-(normal|bypass)-(\d+)-(\d+)$/.exec(a.name || '');
    if (!match) continue;
    const at = Date.parse(a.created_at);
    if (!Number.isFinite(at)) throw new Error('audit artifact has no server timestamp');
    if (at < cutoff || at > new Date(now).getTime()) continue;
    if (a.expired) throw new Error('audit evidence expired inside the history window');
    const id = Number(match[2]);
    const attempt = Number(match[3]);
    if (!a.workflow_run || a.workflow_run.id !== id || attempt < 1) throw new Error('audit artifact run binding is invalid');
    if (!runs.has(id)) {
      const pages = fetch(`repos/${repo}/actions/runs/${id}`);
      if (pages.length !== 1 || !pages[0]) throw new Error('workflow identity unavailable');
      runs.set(id, pages[0]);
    }
    const run = runs.get(id);
    if (!/^\.github\/workflows\/fqe-publish\.yml(?:@.+)?$/.test(run.path || '') || run.id !== id || run.run_attempt < attempt) {
      throw new Error('audit artifact was not produced by the trusted FQE publisher');
    }
    const key = `${id}-${attempt}`;
    if (key === currentRun) continue;
    if (records.has(key)) throw new Error('duplicate audit record for one workflow attempt');
    records.set(key, match[1] === 'bypass');
  }
  for (const run of completed) {
    if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)) throw new Error('publisher history has no attempt identity');
    const key = `${run.id}-${run.run_attempt}`;
    if (key !== currentRun && !records.has(key)) throw new Error('completed publisher is missing its audit record');
  }
  if (currentRun !== undefined) {
    if (!/^\d+-\d+$/.test(currentRun) || typeof currentBypass !== 'boolean') throw new Error('current workflow attempt is invalid');
    records.set(currentRun, currentBypass);
  }
  const denominator = records.size;
  const numerator = [...records.values()].filter(Boolean).length;
  return { numerator, denominator, rate: denominator ? numerator / denominator : null,
    window_days: windowDays, source: 'github_actions_artifacts',
    note: 'Observed audited attempts, with a record required for each latest completed publisher run in the window; no evidence is never reported as a zero bypass rate.' };
}

function actorsFromYaml(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines[0] === 'allowed_actors: []' && lines.length === 1) return [];
  if (lines.shift() !== 'allowed_actors:') throw new Error('allowlist must declare allowed_actors');
  return lines.map(line => {
    const m = /^- ([A-Za-z0-9][A-Za-z0-9-]{0,38})$/.exec(line);
    if (!m) throw new Error('allowlist contains an invalid GitHub login');
    return m[1];
  });
}

// This runs only in the publisher job, which never executes PR code.
function verifyCiReceipt({ repo, pr, headSha, runId, auditRunId = runId, receiptPath, fqeVersion, now = new Date().toISOString(), fetch = githubJson }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/.test(headSha || '') ||
      !Number.isSafeInteger(pr) || pr < 1 || !/^\d+-\d+$/.test(runId || '')) throw new Error('CI destination is invalid');
  const one = endpoint => {
    const pages = fetch(endpoint);
    if (!Array.isArray(pages) || pages.length !== 1) throw new Error('GitHub object unavailable');
    return pages[0];
  };
  const metadata = one(`repos/${repo}`);
  const pull = one(`repos/${repo}/pulls/${pr}`);
  if (!pull.head || pull.head.sha !== headSha || pull.state !== 'open') throw new Error('PR head changed or PR is closed; refusing stale publication');
  const source = one(`repos/${repo}/actions/runs/${runId.split('-')[0]}`);
  if (!/^\.github\/workflows\/fqe-quality\.yml(?:@.+)?$/.test(source.path || '') ||
      !['pull_request', 'pull_request_review'].includes(source.event) ||
      source.head_sha !== headSha || source.run_attempt !== Number(runId.split('-')[1]) || source.status !== 'completed') {
    throw new Error('receipt is not bound to a completed FQE run of this PR head');
  }
  const allowed = file => {
    const data = one(`repos/${repo}/contents/.github/${file}?ref=${encodeURIComponent(metadata.default_branch)}`);
    if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('current allowlist unavailable');
    return actorsFromYaml(Buffer.from(data.content, 'base64').toString('utf8'));
  };
  const comments = fetch(`repos/${repo}/issues/${pr}/comments?per_page=100`).flat();
  const bypassAllowlist = allowed('fqe-bypass-allowlist.yml');
  const bypass = evaluateBypass({ headSha, now, allowlist: bypassAllowlist,
    comments: comments.map(c => ({ user_login: c.user && c.user.login, created_at: c.created_at, updated_at: c.updated_at, body: c.body })) });
  let receipt;
  if (bypass.bypass) {
    receipt = buildReceipt({ fqe_version: fqeVersion, run_id: runId, started_at: now, finished_at: now,
      commit_sha: headSha, content_hash: hashString(`bypass-content:${headSha}`), inputs_hash: hashString(`bypass-inputs:${headSha}`),
      classifier_version: 1, runner_versions: { fqe: fqeVersion }, runners_fired: [], runners: [], verdict: 'PASS',
      verdict_reasons: [bypass.reason], bypass: { requester: bypass.actor, requester_source: 'github_comments_api_v3',
        events_url: `https://github.com/${repo}/pull/${pr}`, allowlist_version: hashString(JSON.stringify(bypassAllowlist)), timestamp: now } });
  } else {
    receipt = parseReceiptYaml(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.commit_sha !== headSha || receipt.run_id !== runId || receipt.bypass) throw new Error('receipt does not match this commit and workflow attempt');
    if (receipt.verdict !== 'FAIL' && source.conclusion !== 'success') throw new Error('source workflow did not complete successfully; refusing a clean receipt');
  }
  const changedFiles = fetch(`repos/${repo}/pulls/${pr}/files?per_page=100`).flat().map(f => f.filename);
  if (changedFiles.length !== pull.changed_files || changedFiles.some(f => typeof f !== 'string')) {
    throw new Error('PR file inventory is incomplete; refusing an unchecked oracle change');
  }
  const oracle = evaluateOracleGuard({ files: changedFiles, includeTests: true });
  const reviewers = currentApprovers({ headSha, author: pull.user.login, requester: bypass.actor,
    allowlist: allowed('fqe-second-reviewers.yml'), reviews: fetch(`repos/${repo}/pulls/${pr}/reviews?per_page=100`).flat() });
  const rate = githubBypassRate({ repo, now, currentRun: auditRunId, currentBypass: bypass.bypass, fetch });
  const oracleSatisfied = !oracle.requires_second_review || reviewers.length > 0;
  const secondSatisfied = !bypass.bypass || (rate.rate != null && (rate.rate <= 0.1 || reviewers.length > 0));
  if (!oracleSatisfied || !secondSatisfied) {
    receipt.verdict = 'FAIL';
    receipt.verdict_reasons.push(!oracleSatisfied
      ? 'CI authority guard: changed grading rules require an authorized non-author approval of this head'
      : 'CI authority guard: bypass rate exceeds 10%; a different authorized reviewer must approve this head');
  }
  if (receipt.bypass) receipt.bypass.applied = oracleSatisfied && secondSatisfied;
  return { receipt, bypass: bypass.bypass && oracleSatisfied && secondSatisfied, reviewers, rate, oracle,
    check_state: receipt.verdict !== 'FAIL' && oracleSatisfied && secondSatisfied ? 'success' : 'failure',
    second_state: secondSatisfied ? 'success' : 'failure' };
}

module.exports = { currentApprovers, githubBypassRate, githubJson, actorsFromYaml, verifyCiReceipt };
