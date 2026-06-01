'use strict';

/**
 * fqe orchestrator — composes the verified pieces.
 *
 * Closes gauntlet 125523 fatal flaw: "The `fqe run` orchestrator is not built."
 *
 * Reads .fqe.yml, classifies the diff, spawns matching runners as subprocesses,
 * aggregates their results, calls computeVerdict(), and writes QA-RESULT.{yml,md}.
 *
 * Design notes:
 *   - subprocess orchestration is "glue" but it's where exit-code propagation,
 *     argument quoting, partial failures, and timeouts go wrong.
 *     We use spawnSync with explicit argv arrays (no shell), bounded timeouts,
 *     and per-runner exit-code capture.
 *   - Each runner is expected to print a JSON line of the shape
 *       {"runner":"<name>","exit_code":<n>,"adversarial_stats":[...optional...]}
 *     to stdout. Lines that don't parse are treated as runner failures.
 *   - No LLM in this path. Pure subprocess + JSON + verdict.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { computeVerdict, BLAST_RADIUS_THRESHOLDS } = require('./verdict');
const { wilson95 } = require('./wilson');
const { buildReceipt, serializeReceipt, writeReceiptFiles, hashString } = require('./receipt');
const { validateConfig } = require('./config_schema');
const { parseJUnit } = require('./junit');
const { parseInventory } = require('./inventory');
const { discover } = require('./discover');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function parseConfigYaml(text) {
  const lines = text.split(/\r?\n/);
  const result = {};
  let current = null;
  let currentRunner = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) throw new Error(`config parse: malformed top-level line ${i + 1}: ${line}`);
      current = m[1];
      if (m[2] === '') {
        result[current] = {};
        if (current === 'policy') {
          // The line-by-line loop below only understands the `runners` shape.
          // Collect the whole nested policy block (all following indent>0 lines)
          // and hand it to a dedicated parser.
          const block = [];
          let j = i + 1;
          for (; j < lines.length; j++) {
            const l = lines[j];
            if (l.trim() === '' || l.trim().startsWith('#')) continue;
            if (l.length - l.trimStart().length === 0) break;
            block.push(l);
          }
          result.policy = parsePolicyBlock(block);
          i = j - 1; // resume at the next top-level line (the loop does i++)
          current = null;
        }
      } else {
        result[current] = parseInlineScalar(m[2]);
        current = null;
      }
    } else if (current === 'runners') {
      if (indent === 2) {
        const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!m) throw new Error(`config parse: malformed runner key line ${i + 1}: ${line}`);
        currentRunner = m[1];
        result.runners[currentRunner] = {};
        if (m[2] !== '') {
          throw new Error(`config parse: runners.${currentRunner} must be a block`);
        }
      } else if (indent === 4 && currentRunner) {
        const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (!m) throw new Error(`config parse: malformed runner field line ${i + 1}`);
        const key = m[1];
        const val = m[2];
        if (val.startsWith('[')) {
          result.runners[currentRunner][key] = JSON.parse(val);
        } else if (val === '' && key === 'args') {
          result.runners[currentRunner][key] = [];
        } else {
          result.runners[currentRunner][key] = parseInlineScalar(val);
        }
      }
    }
  }
  return result;
}

function parseInlineScalar(v) {
  const t = v.trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t.startsWith('"') && t.endsWith('"')) return JSON.parse(t);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

/**
 * Parse an inline flow value: either a list `[a, b]` (JSON or YAML-flow) or a
 * scalar. Tolerant of both `["a","b"]` (JSON) and `[a, b]` (unquoted YAML flow).
 */
function parseMaybeList(val) {
  const t = val.trim();
  if (t.startsWith('[')) return parseFlowList(t);
  return parseInlineScalar(t);
}

function parseFlowList(t) {
  if (!t.startsWith('[') || !t.endsWith(']')) {
    throw new Error(`policy parse: malformed inline list: ${t}`);
  }
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.map(String);
  } catch (_) { /* fall through to the tolerant comma-split below */ }
  const inner = t.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/**
 * Parse the nested `policy` block. Supported shape:
 *   require_classes: ["unit", "lint"]
 *   require_for:
 *     - when: ["src/payments/**"]
 *       classes: ["money", "regression"]
 * Anything malformed throws (fail closed). Unknown keys are passed through so
 * config_schema.validateConfig rejects them with a clear message.
 */
function parsePolicyBlock(lines) {
  const policy = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    if (indent !== 2) continue; // deeper lines are consumed by their parent key
    const trimmed = line.trim();
    const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) throw new Error(`policy parse: malformed line: ${line}`);
    const key = m[1];
    const val = m[2];
    if (key === 'require_for' && val === '') {
      const { items, next } = parseRequireFor(lines, i + 1);
      policy.require_for = items;
      i = next - 1;
    } else if (val === '') {
      // Fail closed: a policy key with no inline value (e.g. `require_classes:`
      // alone, or a typo'd block key) must throw, not parse to an empty object
      // that the verdict would then ignore.
      throw new Error(`policy parse: key '${key}' must have an inline list value (e.g. ${key}: ["unit"])`);
    } else {
      policy[key] = parseMaybeList(val);
    }
  }
  return policy;
}

/**
 * Parse the list items under `require_for:` — each item is `- when: [...]`
 * (indent 4) optionally followed by `classes: [...]` (indent 6).
 * @returns {{ items: object[], next: number }} next = index after the block
 */
function parseRequireFor(lines, start) {
  const items = [];
  let i = start;
  let cur = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < 4) break; // dedent out of require_for
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      cur = {};
      items.push(cur);
      const after = trimmed.slice(2).trim();
      const m = after.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) throw new Error(`policy parse: malformed require_for item: ${line}`);
      if (m[2] === '') {
        // Fail closed: `when:` or `classes:` with no inline value must throw, not
        // become null and get silently dropped by computeRequiredClasses (which
        // would make a diff-conditional money requirement vanish).
        throw new Error(`policy parse: require_for key '${m[1]}' must have an inline list value`);
      }
      cur[m[1]] = parseMaybeList(m[2]);
    } else {
      if (!cur) throw new Error(`policy parse: require_for continuation without an item: ${line}`);
      const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) throw new Error(`policy parse: malformed require_for field: ${line}`);
      if (m[2] === '') {
        // Fail closed: `when:` or `classes:` with no inline value must throw, not
        // become null and get silently dropped by computeRequiredClasses (which
        // would make a diff-conditional money requirement vanish).
        throw new Error(`policy parse: require_for key '${m[1]}' must have an inline list value`);
      }
      cur[m[1]] = parseMaybeList(m[2]);
    }
  }
  return { items, next: i };
}

/**
 * Compute the effective set of required test classes for this run:
 *   policy.require_classes (always)  ∪  policy.require_for[*].classes whose
 *   `when` globs match at least one changed file (diff-conditional).
 * This is how "money paths get the strict bar" works: changing a payments file
 * pulls in its required classes automatically.
 *
 * `diffIndeterminate` (the diff could not be read) fails CLOSED: every
 * require_for entry is treated as activated, so a run that cannot see what
 * changed still demands the strictest set of classes rather than dropping them.
 * @returns {string[]}
 */
function computeRequiredClasses(policy, files, diffIndeterminate = false) {
  if (!policy || typeof policy !== 'object') return [];
  const set = new Set();
  if (Array.isArray(policy.require_classes)) {
    for (const c of policy.require_classes) set.add(c);
  }
  if (Array.isArray(policy.require_for)) {
    for (const entry of policy.require_for) {
      if (!entry || !Array.isArray(entry.when) || !Array.isArray(entry.classes)) continue;
      const matched = diffIndeterminate || files.some((f) => entry.when.some((p) => fileMatches(f, p)));
      if (matched) for (const c of entry.classes) set.add(c);
    }
  }
  return [...set];
}

/**
 * Resolve the changed-file list. Returns { files, ok } so the caller can tell
 * "no files changed" (ok:true, files:[]) apart from "could not read the diff"
 * (ok:false). The distinction matters for diff-conditional policy: if we cannot
 * see the diff we must NOT silently drop a require_for entry (that would let a
 * payments change pass with no money test). The caller fails closed on !ok.
 * @returns {{ files: string[], ok: boolean }}
 */
function changedFiles({ baseSha, headSha, repoDir }) {
  if (process.env.FQE_CHANGED_FILES !== undefined) {
    // FQE_CHANGED_FILES is a TRUSTED CI override: the workflow computes the
    // server-side merge-base diff and passes it here (the runner's own git
    // context may lack the base). It must be set by CI, never from PR-controlled
    // content. An EMPTY value is treated as indeterminate (ok:false), not as
    // "nothing changed" — otherwise clearing the var would silently dodge every
    // diff-conditional policy (require_for). Fail closed on the empty case.
    const envFiles = process.env.FQE_CHANGED_FILES.split(/[\s,]+/).filter(Boolean);
    return { files: envFiles, ok: envFiles.length > 0 };
  }
  const args = baseSha && headSha
    ? ['diff', '--name-only', `${baseSha}..${headSha}`]
    : ['diff', '--name-only', 'HEAD~1', 'HEAD'];
  const r = spawnSync('git', args, { cwd: repoDir || process.cwd(), encoding: 'utf8' });
  if (r.status !== 0) {
    return { files: [], ok: false };
  }
  return { files: r.stdout.split('\n').filter(Boolean), ok: true };
}

function classify(files, runnersConfig) {
  const fired = [];
  const byClass = {};
  for (const [name, cfg] of Object.entries(runnersConfig || {})) {
    const patterns = cfg.when || [];
    const matches = files.filter(f =>
      patterns.some(p => fileMatches(f, p))
    );
    if (matches.length > 0 || cfg.always_run === true) {
      fired.push(name);
      byClass[name] = matches;
    }
  }
  return { runners_fired: fired, by_class: byClass };
}

/**
 * Glob -> regex with the right semantics:
 *   "**\/x.tsx"  matches "x.tsx" AND "a/x.tsx" AND "a/b/x.tsx"
 *   "*.tsx"      matches "x.tsx" only (no slashes)
 *   "**"         matches anything
 *
 * Two-pass using non-printable sentinels so `*` substitutions don't collide.
 */
function fileMatches(file, pattern) {
  const STAR2_SLASH = '';  // "**/" - optional any-path-prefix
  const SLASH_STAR2 = '';  // "/**" - optional any-path-suffix
  const STAR2 = '';        // "**"  - any chars including /
  const STAR1 = '';        // "*"   - any non-slash
  let p = pattern;
  p = p.replace(/\*\*\//g, STAR2_SLASH);
  p = p.replace(/\/\*\*/g, SLASH_STAR2);
  p = p.replace(/\*\*/g, STAR2);
  p = p.replace(/\*/g, STAR1);
  p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  p = p.split(STAR2_SLASH).join('(?:[^/]+/)*');
  p = p.split(SLASH_STAR2).join('(?:/.*)?');
  p = p.split(STAR2).join('.*');
  p = p.split(STAR1).join('[^/]*');
  return new RegExp('^' + p + '$').test(file);
}

/**
 * Resolve a runner's declared report ("junit:<path>") to an absolute path under
 * repoDir, or null when no report is declared.
 */
function reportPathOf(cfg, repoDir) {
  if (!cfg || typeof cfg.report !== 'string') return null;
  const m = cfg.report.trim().match(/^junit:(.+)$/);
  if (!m) return null;
  return path.resolve(repoDir || process.cwd(), m[1].trim());
}

/**
 * Run the inventory_cmd (a shell string, e.g. `pytest --collect-only -q`) and
 * capture stdout. Returns null when no inventory_cmd is declared.
 */
function runInventoryCmd(cfg, ctx) {
  if (!cfg || typeof cfg.inventory_cmd !== 'string' || cfg.inventory_cmd.trim() === '') {
    return null;
  }
  const r = spawnSync(cfg.inventory_cmd, {
    shell: true,
    encoding: 'utf8',
    cwd: ctx.repoDir || process.cwd(),
    timeout: cfg.timeout_ms || DEFAULT_TIMEOUT_MS,
    env: { ...process.env },
  });
  if (r.status !== 0) {
    return { ok: false, stdout: r.stdout || '', error: `inventory_cmd exited ${r.status === null ? 'by signal/timeout' : r.status}` };
  }
  return { ok: true, stdout: r.stdout || '' };
}

/**
 * Assemble the coverage-liveness object from a fresh JUnit report plus an optional
 * collected-count inventory. FAIL-CLOSED: any missing, stale, or unparseable
 * evidence yields evidence_ok:false with a reason, which verdict Pass 6 turns into
 * a FAIL. Returns undefined when the runner declared no report (backward compat).
 */
function assembleCoverage(cfg, reportAbs, startMs, invResult, preMtime) {
  if (!reportAbs) return undefined;
  const min_tests = typeof cfg.min_tests === 'number' ? cfg.min_tests : 1;
  const reconcile = cfg.reconcile === true;
  const strict_coverage = cfg.strict_coverage === true;
  const cov = {
    declared: true, evidence_ok: false, evidence_error: null,
    executed: null, reported: null, collected: null,
    min_tests, reconcile, strict_coverage,
  };

  let stat;
  try { stat = fs.statSync(reportAbs); }
  catch (_) { cov.evidence_error = `declared report not found after run: ${reportAbs}`; return cov; }
  if (!stat.isFile()) { cov.evidence_error = `declared report path is not a file: ${reportAbs}`; return cov; }
  // PRIMARY freshness guard, clock-independent: the report must have been WRITTEN by
  // this run. We deleted any prior report before running; if that delete failed (e.g.
  // a Windows file lock) a stale report could survive, so when a prior file existed we
  // require its mtime to have advanced. An unchanged mtime means the runner produced no
  // new report (crashed, or a subset that wrote nothing) -> fail closed.
  if (typeof preMtime === 'number' && stat.mtimeMs <= preMtime) {
    cov.evidence_error = 'declared report was not rewritten this run (stale or cached report); failing closed';
    return cov;
  }
  // Secondary clock-based backstop (tolerant of CI clock skew); the checks above are primary.
  if (typeof startMs === 'number' && stat.mtimeMs + 5000 < startMs) {
    cov.evidence_error = 'declared report mtime predates this run (stale or cached report); refusing it';
    return cov;
  }

  let parsed;
  try { parsed = parseJUnit(fs.readFileSync(reportAbs, 'utf8')); }
  catch (e) { cov.evidence_error = e.message; return cov; }
  cov.reported = parsed.reported;
  cov.executed = parsed.executed;

  if (reconcile) {
    if (!invResult || invResult.ok !== true) {
      cov.evidence_error = `reconcile is on but inventory_cmd failed (${invResult ? invResult.error : 'no inventory_cmd'})`;
      return cov;
    }
    try { cov.collected = parseInventory(invResult.stdout, cfg.inventory_format); }
    catch (e) { cov.evidence_error = `inventory parse failed: ${e.message}`; return cov; }
  }

  cov.evidence_ok = true;
  return cov;
}

function runOne(name, cfg, ctx) {
  const cmd = cfg.command;
  const args = (cfg.args || []).map(a => substituteVars(a, ctx));
  if (!cmd) {
    return {
      name, required: cfg.required === true, ran: false,
      class: cfg.class, exit_code: undefined, stdout: '', stderr: 'no command configured',
    };
  }

  const reportAbs = reportPathOf(cfg, ctx.repoDir);
  // Inventory is read-only and stable across attempts, so run it once.
  const invResult = runInventoryCmd(cfg, ctx);

  // Flaky-retry (v0.10 trust hygiene): re-run a FAILED runner up to `retries` times.
  // If it fails then passes, it is FLAKY: a neutral signal, not a hard FAIL, so one
  // random red never blocks a merge. A genuinely failing runner (fails every attempt)
  // still FAILs. Coverage evidence is taken from the FINAL attempt.
  const maxAttempts = 1 + (typeof cfg.retries === 'number' && cfg.retries > 0 ? cfg.retries : 0);
  const attempts = [];
  let r;
  let preMtime = null;
  let startMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (reportAbs) {
      // Record any pre-existing report's mtime BEFORE deleting it (clock-independent
      // freshness), then delete so a stale report cannot be trusted.
      try { preMtime = fs.statSync(reportAbs).mtimeMs; } catch (_) { preMtime = null; }
      try { fs.rmSync(reportAbs, { force: true }); } catch (_) { /* best effort; preMtime guards staleness */ }
    }
    startMs = Date.now();
    r = spawnSync(cmd, args, {
      timeout: cfg.timeout_ms || DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      cwd: ctx.repoDir || process.cwd(),
      env: { ...process.env, FQE_RUNNER_NAME: name, FQE_ATTEMPT: String(attempt) },
    });
    const code = typeof r.status === 'number' ? r.status : null;
    attempts.push(code);
    if (code === 0) break; // passed; no need to retry
  }
  const finalCode = typeof r.status === 'number' ? r.status : null;
  const flaky = attempts.length > 1 && attempts[0] !== 0 && finalCode === 0;

  let parsed = null;
  if (r.stdout) {
    for (const line of r.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try { parsed = JSON.parse(trimmed); break; } catch (_) { /* skip */ }
      }
    }
  }

  const coverage = assembleCoverage(cfg, reportAbs, startMs, invResult, preMtime);

  return {
    name,
    required: cfg.required === true,
    class: cfg.class,
    ran: true,
    exit_code: finalCode,
    attempts,
    flaky,
    quarantined: cfg.quarantined === true,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    parsed,
    coverage,
  };
}

function substituteVars(s, ctx) {
  return String(s)
    .replace(/\$\{?FQE_COMMIT_SHA\}?/g, ctx.commitSha || '')
    .replace(/\$\{?FQE_HEAD_SHA\}?/g, ctx.commitSha || '')
    .replace(/\$\{?FQE_PR_NUMBER\}?/g, ctx.prNumber || '');
}

function computeContentHash(files, repoDir) {
  if (!files || files.length === 0) {
    return hashString('fqe-empty-content');
  }
  const sorted = [...files].sort();
  const h = crypto.createHash('sha256');
  for (const f of sorted) {
    const abs = path.resolve(repoDir || process.cwd(), f);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) continue;
    h.update(f);
    h.update(' ');
    h.update(fs.readFileSync(abs));
    h.update(' ');
  }
  return `sha256:${h.digest('hex')}`;
}

function run(opts) {
  if (!opts || !opts.commitSha) throw new Error('orchestrator.run: commitSha required');
  if (!opts.outputDir) throw new Error('orchestrator.run: outputDir required');
  const repoDir = opts.repoDir || process.cwd();
  const configPath = opts.configPath || path.join(repoDir, '.fqe.yml');

  let config = { runners: {} };
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, 'utf8');
    config = parseConfigYaml(text);
    config.runners = config.runners || {};
  }

  // Fail closed on a malformed config. A typo'd key (whne: instead of when:)
  // would otherwise parse, disable a runner, and pass the gate green. This
  // throws before any runner fires, so bin/fqe.js maps it to exit 1 (ERROR),
  // never a silent PASS. See cli/lib/config_schema.js.
  const validation = validateConfig(config);
  if (!validation.valid) {
    const err = new Error(
      `invalid .fqe.yml config (gate cannot run):\n  - ${validation.errors.join('\n  - ')}`
    );
    err.fqeConfigInvalid = true;
    throw err;
  }

  const diff = changedFiles({
    baseSha: opts.baseSha,
    headSha: opts.commitSha,
    repoDir,
  });
  const files = diff.files;

  const cls = classify(files, config.runners);

  const startedAt = new Date().toISOString();
  const runnerResults = [];
  for (const name of cls.runners_fired) {
    runnerResults.push(runOne(name, config.runners[name], {
      commitSha: opts.commitSha,
      prNumber: opts.prNumber,
      repoDir,
    }));
  }
  for (const [name, cfg] of Object.entries(config.runners || {})) {
    if (!cls.runners_fired.includes(name) && cfg.required === true) {
      runnerResults.push({
        name, required: true, class: cfg.class, ran: false,
        exit_code: undefined,
        stdout: '', stderr: 'required runner did not run',
      });
    }
  }
  const finishedAt = new Date().toISOString();

  const adversarialStats = [];
  for (const r of runnerResults) {
    if (r.parsed && Array.isArray(r.parsed.adversarial_stats)) {
      for (const stat of r.parsed.adversarial_stats) {
        adversarialStats.push(stat);
      }
    }
  }

  const requiredClasses = computeRequiredClasses(config.policy, files, !diff.ok);

  // Inter-suite discovery: detect frameworks present that no declared runner covers.
  // Fail-loud (FLAG, or FAIL under require_all_suites_wired). A discovery CRASH must
  // not silently suppress the strict FAIL: if the caller opted into blocking on
  // unwired suites, an error means we cannot prove suites are wired, so fail closed.
  let discovery = { detected: [], wired: [], unwired: [] };
  let discoveryError = null;
  try { discovery = discover(repoDir, config); } catch (e) { discoveryError = e && e.message ? e.message : String(e); }

  const verdictInput = {
    runners: runnerResults.map(r => ({
      name: r.name,
      required: r.required === true,
      ran: r.ran === true,
      exit_code: r.exit_code,
      class: r.class,
      coverage: r.coverage,
      flaky: r.flaky === true,
      quarantined: r.quarantined === true,
    })),
    adversarial_stats: adversarialStats,
    require_classes: requiredClasses,
    require_coverage_evidence: config.require_coverage_evidence === true,
    unwired_suites: discovery.unwired,
    require_all_suites_wired: config.require_all_suites_wired === true,
    discovery_error: discoveryError,
  };
  let verdictOut;
  try {
    verdictOut = computeVerdict(verdictInput);
  } catch (e) {
    verdictOut = {
      verdict: 'FAIL',
      reasons: [`verdict computation rejected input: ${e.message}`],
    };
  }

  const contentHash = computeContentHash(files, repoDir);
  const inputsHash = hashString(JSON.stringify({ config, file_count: files.length }));

  // Human-review telemetry (v0.10): count the items a person must look at this run and
  // estimate minutes, so the near-autonomy DoD (3-6 team-hours/week) is OBSERVED. The
  // per-item minute costs are a documented model, not a measurement.
  const flakyCount = runnerResults.filter(r => r.flaky === true).length;
  const quarantinedFailing = runnerResults.filter(
    r => r.quarantined === true && typeof r.exit_code === 'number' && r.exit_code !== 0
  ).length;
  const unwiredCount = discovery.unwired.length;
  const aiDrafts = 0; // wired in Stage B (v0.12)
  const PER_ITEM_MIN = { flaky: 3, quarantined: 3, unwired: 3, ai: 5 };
  const estimatedMinutes =
    flakyCount * PER_ITEM_MIN.flaky + quarantinedFailing * PER_ITEM_MIN.quarantined +
    unwiredCount * PER_ITEM_MIN.unwired + aiDrafts * PER_ITEM_MIN.ai;
  const humanReview = {
    flags: flakyCount + quarantinedFailing + unwiredCount + aiDrafts,
    flaky: flakyCount,
    quarantined: quarantinedFailing,
    unwired_suites: unwiredCount,
    ai_drafts: aiDrafts,
    estimated_minutes: estimatedMinutes,
  };

  const receipt = buildReceipt({
    fqe_version: opts.fqeVersion,
    run_id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    started_at: startedAt,
    finished_at: finishedAt,
    commit_sha: opts.commitSha,
    content_hash: contentHash,
    inputs_hash: inputsHash,
    classifier_version: 1,
    runner_versions: { fqe: opts.fqeVersion },
    runners_fired: cls.runners_fired,
    runners: verdictInput.runners,
    adversarial_stats: adversarialStats,
    required_classes: requiredClasses,
    quarantined_tests: [],
    verdict: verdictOut.verdict,
    verdict_reasons: verdictOut.reasons,
    bypass: null,
    evidence_paths: [],
    human_review: humanReview,
  });

  const { ymlPath, mdPath } = writeReceiptFiles(receipt, opts.outputDir);

  return {
    verdict: verdictOut.verdict,
    reasons: verdictOut.reasons,
    ymlPath,
    mdPath,
    runners: runnerResults,
    changed_files: files,
    classifier: cls,
  };
}

module.exports = {
  run,
  parseConfigYaml,
  classify,
  fileMatches,
  computeContentHash,
  computeRequiredClasses,
  reportPathOf,
  assembleCoverage,
};
