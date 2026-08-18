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
const { validateConfig, hasMoneyPolicy, isMoneyClass, parseIsoDateUtc } = require('./config_schema');
const { parseJUnit } = require('./junit');
const { parseInventory } = require('./inventory');
const { discover } = require('./discover');
const { parseStryker, evaluateMutationAdvisory } = require('./mutation_gate');
const { detectMoneyPaths, findDeadRequireForGlobs } = require('./money_scan');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// F1 (v0.15): a quarantine expires after this many days. The CLOCK lives here in the
// orchestrator; verdict.js only consumes the resulting boolean and stays clock-free.
const DEFAULT_QUARANTINE_TTL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A4 (v0.15): bounds on the money-path content scan so a huge diff cannot OOM the gate.
const MONEY_SCAN_MAX_FILES = 500;
const MONEY_SCAN_MAX_BYTES = 512 * 1024;
const MONEY_SCAN_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.cs', '.php', '.sql', '.kt', '.scala',
]);

/**
 * F1 (v0.15): is a runner's quarantine expired as of the run timestamp? Fail CLOSED:
 * an unparseable quarantined_since or run timestamp counts as EXPIRED (a quarantine that
 * cannot prove its age cannot keep shielding a failure).
 * @returns {boolean}
 */
function quarantineExpired(cfg, finishedAtIso) {
  if (!cfg || cfg.quarantined !== true) return false;
  const sinceMs = parseIsoDateUtc(cfg.quarantined_since);
  const nowMs = parseIsoDateUtc(finishedAtIso);
  if (sinceMs === null || nowMs === null) return true; // cannot age it -> expired
  const ttlDays = (typeof cfg.quarantine_ttl_days === 'number' && Number.isInteger(cfg.quarantine_ttl_days))
    ? cfg.quarantine_ttl_days : DEFAULT_QUARANTINE_TTL_DAYS;
  return (nowMs - sinceMs) / MS_PER_DAY > ttlDays;
}

function scanExtOf(f) {
  const s = String(f);
  const d = s.lastIndexOf('.');
  const sl = s.lastIndexOf('/');
  return d > sl && d >= 0 ? s.slice(d).toLowerCase() : '';
}

/**
 * A4 (v0.15): read the changed source files (bounded) so the money-path heuristic can
 * keyword-scan them. Never throws: an unreadable or oversized file is skipped.
 * @returns {Record<string,string>} path -> text
 */
function readChangedFileContents(files, repoDir) {
  const out = {};
  if (!Array.isArray(files)) return out;
  let count = 0;
  for (const f of files) {
    if (count >= MONEY_SCAN_MAX_FILES) break;
    if (!MONEY_SCAN_EXT.has(scanExtOf(f))) continue;
    try {
      const p = path.resolve(repoDir || process.cwd(), f);
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MONEY_SCAN_MAX_BYTES) continue;
      out[f] = fs.readFileSync(p, 'utf8');
      count++;
    } catch (_) { /* unreadable: skip, never throw */ }
  }
  return out;
}

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
        } else if (current === 'mutation') {
          // v0.14 fix: the `mutation:` block was never parsed from .fqe.yml (it fell
          // through to `{}`), so the mutation gate was unreachable through `fqe run`
          // — configurable only via the raw `fqe verdict` JSON path. Parse it as a
          // flat map of scalars/inline-lists, same collection strategy as policy.
          const block = [];
          let j = i + 1;
          for (; j < lines.length; j++) {
            const l = lines[j];
            if (l.trim() === '' || l.trim().startsWith('#')) continue;
            if (l.length - l.trimStart().length === 0) break;
            block.push(l);
          }
          result.mutation = parseFlatMapBlock(block);
          i = j - 1;
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
 * Parse a flat nested map block (key: scalar-or-inline-list per line), used for
 * the `mutation:` block. Fail closed on a key with no inline value. Unknown keys
 * pass through so config_schema.validateConfig rejects them with a clear message.
 */
function parseFlatMapBlock(lines) {
  const out = {};
  for (const raw of lines) {
    const t = raw.trim();
    const m = t.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) {
      throw new Error(
        `config parse: malformed mapping line: ${raw.trim()}. ` +
        `This block takes flat 'key: value' lines only; use inline-list syntax ` +
        `for lists (e.g. allowlist: ["file:1:Mutator"]), not a nested '- item' block.`
      );
    }
    const key = m[1];
    const val = m[2];
    if (val === '') {
      throw new Error(`config parse: key '${key}' must have an inline value (e.g. ${key}: blocking)`);
    }
    out[key] = parseMaybeList(val);
  }
  return out;
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
/**
 * Does this repo have enough history that a diff SHOULD be computable?
 *
 * Distinguishes "the diff failed because there is nothing to diff" (a genuinely
 * fresh repo with a single commit: legitimate, silent) from "the diff failed
 * even though history exists" (a real signal).
 *
 * IMPORTANT: this answer is AMBIGUOUS on its own and must never be the only
 * qualifier. It cannot tell a fresh repo from a SHALLOW CLONE: `actions/checkout`
 * defaults to fetch-depth 1, and `git clone --depth 1` of a 500-commit repo
 * reports exactly 1 commit here. Pair it with repoIsShallow(), which resolves
 * exactly that ambiguity.
 *
 * Fails SAFE toward silence: if we cannot even count commits, do not raise.
 */
function repoHasHistory(repoDir) {
  const r = spawnSync('git', ['rev-list', '--count', '-n', '2', 'HEAD'], {
    cwd: repoDir || process.cwd(),
    encoding: 'utf8',
  });
  if (r.status !== 0) return false;
  return parseInt(String(r.stdout).trim(), 10) > 1;
}

/**
 * Is this a SHALLOW clone (history deliberately truncated)?
 *
 * This is the fact that makes repoHasHistory() usable. A shallow clone reports
 * 1 commit no matter how old the repo is, so "1 commit" alone can mean either
 * "genuinely brand new" (silence is correct) or "500 commits I am not allowed to
 * see" (silence is a receipt reporting clean over a diff that never resolved).
 * `fetch-depth: 1` is the DEFAULT for actions/checkout, so the second case is
 * the common one in CI, not the exotic one.
 *
 * Fails SAFE toward SUSPICION: if we cannot determine depth, assume shallow, so
 * an unknown state raises rather than silently passing. The cost of a false
 * alarm is an engineer reading one extra line; the cost of false silence is a
 * merged PR nothing checked.
 */
function repoIsShallow(repoDir) {
  const cwd = repoDir || process.cwd();
  const r = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' });
  if (r.status === 0) {
    const out = String(r.stdout).trim();
    if (out === 'true') return true;
    if (out === 'false') return false;
  }
  // git < 2.15 has no --is-shallow-repository. The marker file predates it and
  // is authoritative, so fall back to it before giving up.
  const g = spawnSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' });
  if (g.status === 0) {
    const gitDir = String(g.stdout).trim();
    try {
      return fs.existsSync(path.resolve(cwd, gitDir, 'shallow'));
    } catch (_) { /* fall through to the safe default */ }
  }
  return true; // undeterminable depth -> treat as history-blind, never as fresh
}

/**
 * Is this the ONE case where an unresolvable diff deserves silence?
 *
 * Exactly one: a genuinely brand-new repository, where the caller named no base,
 * so there is legitimately nothing to diff against. Every other shape of
 * "the diff did not resolve" is a real signal and must surface.
 *
 * All three conditions are required, and each closes a hole a previous version
 * shipped:
 *   - no base named     : naming a base that does not resolve is always an error
 *   - not shallow       : a truncated clone is history-blind, not history-free
 *   - <= 1 commit       : with the two above, this now genuinely means "new"
 *
 * @returns {boolean} true only when silence is provably correct
 */
function isGenuinelyFirstRun(opts) {
  if (opts && opts.baseSha) return false;
  const repoDir = opts && opts.repoDir;
  // Not a git repo at all is a DIFFERENT state from a truncated one. There is no
  // history here to be blind to and no diff was ever possible, which is the
  // documented "empty config / always_run only" case. Treating it as suspicious
  // would flag every non-git invocation. A CI checkout that failed is still
  // covered, because the generated workflow always names a --base.
  if (!isGitRepo(repoDir)) return true;
  if (repoIsShallow(repoDir)) return false;
  return !repoHasHistory(repoDir);
}

/**
 * Is this directory inside a git work tree at all?
 *
 * CRITICAL: "git said no" and "git could not answer" are DIFFERENT states and
 * must not collapse. The first version returned false for both, and false is the
 * branch that GRANTS SILENCE - so every git failure (a dubious-ownership refusal,
 * a broken GIT_DIR, git missing from PATH, a linked worktree whose main clone
 * moved) was read as "brand-new repo" and minted a clean green receipt. That is
 * the most blind state fqe can be in, and it was getting the most trusting
 * treatment. It also re-opened the shallow-clone hole through a second door.
 *
 * A `.git` entry at or above the directory means this is MEANT to be a repo, so
 * a failure to read it is suspicious rather than evidence of newness. Keying on
 * the filesystem marker instead of parsing git's stderr keeps this stable across
 * git versions and locales.
 */
function isGitRepo(repoDir) {
  const cwd = repoDir || process.cwd();
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' });
  if (r.status === 0 && String(r.stdout).trim() === 'true') return true;
  // git did not confirm. If a .git marker exists anyway, git FAILED rather than
  // reported absence, so take the suspicious branch.
  return hasGitMarker(cwd);
}

/** Walk up from `dir` looking for a `.git` file or directory. */
function hasGitMarker(dir) {
  try {
    let cur = path.resolve(dir);
    for (;;) {
      if (fs.existsSync(path.join(cur, '.git'))) return true;
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  } catch (_) {
    // Cannot even inspect the filesystem. Assume a repo so the caller takes the
    // suspicious branch rather than granting silence on an unreadable state.
    return true;
  }
}

function changedFiles({ baseSha, headSha, repoDir }) {
  if (process.env.FQE_CHANGED_FILES !== undefined) {
    // FQE_CHANGED_FILES is a TRUSTED CI override: the workflow computes the
    // server-side merge-base diff and passes it here (the runner's own git
    // context may lack the base). It must be set by CI, never from PR-controlled
    // content. An EMPTY value is treated as indeterminate (ok:false), not as
    // "nothing changed" — otherwise clearing the var would silently dodge every
    // diff-conditional policy (require_for). Fail closed on the empty case.
    const envFiles = process.env.FQE_CHANGED_FILES.split(/[\s,]+/).filter(Boolean);
    // `reason` matters downstream: an EXPLICIT but empty override is the caller
    // asserting a diff it could not compute, which can never be excused by a
    // git-history check. Only a git-side absence is ever exemptible.
    return { files: envFiles, ok: envFiles.length > 0, reason: envFiles.length ? null : 'env-empty' };
  }
  // NO SILENT FALLBACK TO HEAD~1.
  //
  // This used to diff HEAD~1..HEAD whenever no base was given, which is a GUESS
  // at the pull request's scope, and it is wrong for every multi-commit PR.
  // Measured: a 3-commit PR whose break is in commit 1 and whose commit 2 was
  // docs-only returned PASS, exit 0, runners_fired: [] - the guessed range
  // covered only the docs commit. git SUCCEEDED, so diff.ok was true and the
  // whole indeterminate-diff guard never even ran. Five rounds of hardening
  // "the diff did not resolve" could not see this: nothing failed.
  //
  // fqe cannot gate a range it was not given. Not knowing the scope is exactly
  // what ok:false means, so say so and let the caller's qualifier decide whether
  // it deserves silence (a genuinely first run) or a flag.
  if (!baseSha || !headSha) {
    return { files: [], ok: false, reason: 'no-base' };
  }
  const r = spawnSync('git', ['diff', '--name-only', `${baseSha}..${headSha}`], {
    cwd: repoDir || process.cwd(),
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    return { files: [], ok: false, reason: 'git-failed' };
  }
  return { files: r.stdout.split('\n').filter(Boolean), ok: true, reason: null };
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

// HIGH-1 (v0.17): runner + inventory subprocesses run PR-controlled commands from .fqe.yml.
// They must NOT inherit fqe's own signing key or other CI secrets, or a malicious runner
// could exfiltrate FQE_SIGNING_KEY and forge signed receipts (defeating v0.16 signing). Strip
// secret-named env vars by a denylist before spawn; GitHub masks values, but the key must
// never reach an untrusted child at all. Non-secret vars (PATH, HOME, CI, NODE_*, FQE_* run
// context) pass through.
// `_KEY` is a substring (not `_KEY$`) so AWS_ACCESS_KEY_ID and other *_KEY_* names are
// caught, not just names ending in _KEY. ACCESS_KEY/KEY_ID added for the AWS pair.
const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|_KEY|KEY_ID|ACCESS_KEY|APIKEY|SIGNING|SESSION)/i;
function sanitizeRunnerEnv(extra) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_RE.test(k)) continue;
    out[k] = v;
  }
  // Apply the SAME filter to the explicit extras, so a future caller cannot accidentally
  // re-inject a secret-named var (e.g. sanitizeRunnerEnv({ FQE_SIGNING_KEY })) past the strip.
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (SECRET_ENV_RE.test(k)) continue;
      out[k] = v;
    }
  }
  return out;
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
    env: sanitizeRunnerEnv(),
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
      env: sanitizeRunnerEnv({ FQE_RUNNER_NAME: name, FQE_ATTEMPT: String(attempt) }),
    });
    const code = typeof r.status === 'number' ? r.status : null;
    attempts.push(code);
    if (code === 0) break; // passed; no need to retry
  }
  const finalCode = typeof r.status === 'number' ? r.status : null;
  const flaky = attempts.length > 1 && attempts[0] !== 0 && finalCode === 0;

  // DID THE PROCESS ACTUALLY START?
  //
  // `ran: true` used to be hardcoded below, so a command that never launched was
  // recorded in a tamper-evident receipt as having run. The reproducible case is
  // `command: "npm"` on Windows: npm is a .cmd shim and spawnSync without a shell
  // cannot execute it, so spawnSync returns `error: ENOENT` with `status: null`.
  // fqe then reported ran:true, exit_code:null, and a 7ms duration for a suite
  // that takes 74s, blocked the merge, and told the engineer their runner's JSON
  // was malformed. The receipt asserting a process ran when it never started is
  // the single worst thing this tool can do, because the receipt IS the product.
  //
  // A spawn failure is NOT a test failure. It is the runner never having been
  // given a chance, so it reports ran:false, which Pass 1 of the verdict already
  // treats as a hard FAIL for a required runner. Same blocking outcome, honest
  // reason, and the reason string now names the real cause.
  // A TIMEOUT IS NOT A SPAWN FAILURE. Node sets `error` on spawnSync when the
  // child "failed OR timed out" (ETIMEDOUT, status:null, signal:'SIGTERM'), so
  // keying neverStarted off `error` alone reports a suite that genuinely ran for
  // five minutes as never having started — reintroducing the exact lie this block
  // exists to remove. Every runner carries a timeout (DEFAULT_TIMEOUT_MS), so
  // that misclassification is reachable on any slow suite, not a corner case.
  //
  // So: decide on positive EVIDENCE OF EXECUTION, never on the presence of an
  // error object. A killing signal, a real exit code, any output, or a timeout
  // all prove the process ran. Only the total absence of all four is "never
  // started", which is what ENOENT/EACCES/EPERM actually look like.
  const spawnError = r && r.error ? r.error : null;
  const timedOut = !!spawnError && spawnError.code === 'ETIMEDOUT';
  const ranEvidence = timedOut || !!r.signal || finalCode !== null || !!(r.stdout || r.stderr);
  const neverStarted = !ranEvidence;
  const spawnHint = spawnError && spawnError.code === 'ENOENT' && process.platform === 'win32'
    ? ' On Windows, npm/npx/yarn/pnpm are .cmd shims and cannot be spawned directly:'
      + ' use command: "cmd" with args: ["/c", "npm", "test"].'
    : '';

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
    ran: !neverStarted,
    // A timeout still BLOCKS (Pass 2 fails closed on a non-numeric exit_code),
    // but it must block for the true reason. Carry it so the receipt says
    // "timed out after Nms" instead of "produced no numeric exit_code".
    timed_out: timedOut || undefined,
    timeout_ms: timedOut ? (cfg.timeout_ms || DEFAULT_TIMEOUT_MS) : undefined,
    spawn_failed: neverStarted || undefined,
    spawn_error: neverStarted
      ? ((spawnError ? (spawnError.code || spawnError.message) : 'process produced no exit code, no signal and no output')
         + spawnHint)
      : undefined,
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
    h.update('\0');
    h.update(fs.readFileSync(abs));
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * Persist each runner's stdout/stderr next to the receipt and return the paths.
 *
 * The receipt's whole claim is that it records what happened. Without this it
 * recorded only that something failed, while the docs promised stderr and the
 * repro command told you to `cat ./out/runner-<name>.log`, a file nothing wrote.
 * Naming matches that documented path so the instruction is finally true.
 *
 * Best-effort by design: a receipt that cannot be written because a log write
 * failed would be a worse outcome than a receipt with fewer evidence paths.
 */
function writeRunnerLogs(results, outputDir) {
  const paths = [];
  const usedStems = new Set();
  if (!outputDir) return paths;
  for (const r of results || []) {
    const body = [
      `runner: ${r.name}`,
      `ran: ${r.ran}`,
      `exit_code: ${r.exit_code === undefined ? 'undefined' : JSON.stringify(r.exit_code)}`,
      r.spawn_error ? `spawn_error: ${r.spawn_error}` : null,
      '',
      '--- stdout ---',
      r.stdout || '(empty)',
      '',
      '--- stderr ---',
      r.stderr || '(empty)',
      '',
    ].filter((l) => l !== null).join('\n');
    // Skip only runners that produced nothing at all AND started fine; a spawn
    // failure has no output but is exactly the case worth writing down.
    if (!r.stdout && !r.stderr && r.ran !== false) continue;
    // The sanitizer is NOT injective: `unit/fast` and `unit_fast` both collapse
    // to `runner-unit_fast.log`, so the second write silently overwrote the
    // first and evidence_paths listed the same path twice, showing one runner's
    // output under another's name. .fqe.yml keys are free-form, so this is
    // reachable. In a file whose entire purpose is evidence, a collision is a
    // correctness bug, not a cosmetic one. Disambiguate on collision.
    let stem = `runner-${String(r.name).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    if (usedStems.has(stem)) {
      let n = 2;
      while (usedStems.has(`${stem}-${n}`)) n++;
      stem = `${stem}-${n}`;
    }
    usedStems.add(stem);
    const file = path.join(outputDir, `${stem}.log`);
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
      paths.push(file);
    } catch (_) { /* evidence is additive; never fail the run over it */ }
  }
  return paths;
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

  // ONE qualified answer to "was the diff usable?", computed once and shared.
  // The three consumers below used to disagree: this one applied the
  // isGenuinelyFirstRun qualifier while computeRequiredClasses and
  // detectMoneyPaths took the RAW !diff.ok, so the exact state the main guard
  // deliberately exonerated (a genuinely new repo) was still hard-blocked by an
  // adjacent guard, and vice versa. A single value cannot contradict itself.
  // The first-run exemption applies ONLY to a git-side absence. An explicitly
  // supplied but EMPTY FQE_CHANGED_FILES is the caller telling us its own diff
  // came back empty; a git-history predicate has no bearing on that, and using
  // one to silence it would suppress a CI signal with an unrelated fact about
  // the checkout.
  const exemptible = diff.reason !== 'env-empty';
  const diffIndeterminate = !diff.ok && !(exemptible && isGenuinelyFirstRun(opts));

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

  // Adversarial stats assembly (v0.14 hardening, closes C1+C2 2026-06-02):
  //  - require_stats_for: any runner that RAN and DECLARES a blast_radius in config
  //    MUST emit adversarial_stats. A dropped payload then fails closed in verdict
  //    Pass 4 (previously this list was never populated, so the check was dead).
  //  - blast_radius is BOUND from the runner's config, not trusted from runner
  //    output, so a money-class runner cannot emit a stat tagged with a weaker
  //    class to dodge the 0.01 bar.
  //  - verdict Pass 3 recomputes the Wilson interval from (n, successes); any
  //    runner-supplied ci_95 is ignored, so a fabricated tight interval cannot pass.
  const adversarialStats = [];
  const requireStatsFor = [];
  for (const r of runnerResults) {
    const declaredBlast = config.runners[r.name] && typeof config.runners[r.name].blast_radius === 'string'
      ? config.runners[r.name].blast_radius : null;
    if (declaredBlast && r.ran === true) {
      requireStatsFor.push(r.name);
    }
    if (r.parsed && Array.isArray(r.parsed.adversarial_stats)) {
      for (const stat of r.parsed.adversarial_stats) {
        // Bind the declared blast_radius (config is authoritative; prevents downgrade).
        const bound = declaredBlast ? { ...stat, blast_radius: declaredBlast } : { ...stat };
        // Attach the AUTHORITATIVE recomputed interval, overwriting any runner-claimed
        // ci_95, so the receipt displays the true number. verdict Pass 3 independently
        // recomputes from (n, successes) regardless, so this is display-only (defense in
        // depth). Bad counts are left for Pass 3 / wilson95 to fail closed on.
        try {
          const ci = wilson95(bound.successes, bound.n);
          bound.ci_95 = [ci.lo, ci.hi];
        } catch (_) { /* leave counts; verdict recomputes and fails closed */ }
        adversarialStats.push(bound);
      }
    }
  }

  // Mutation-on-diff judge (v0.13): a class:'mutation' runner emits either a Stryker JSON
  // report (parsed.mutation_report) or a direct tally with survivors (parsed.mutation).
  // Evaluate it with the configured governance (mode, threshold, allowlist) scoped to the
  // diff. Advisory by default. Never throws: a malformed report yields no mutation signal
  // rather than crashing the gate.
  let mutationResult = null;
  if (config.mutation && typeof config.mutation === 'object') {
    const blocking = config.mutation.mode === 'blocking';
    // H1 (2026-06-02): a DECLARED mutation gate must never go dark on a corrupt
    // report. Distinguish "unparseable/malformed" (fail closed: FAIL when blocking,
    // FLAG when advisory) from "valid but too few mutants" (legitimately NEUTRAL).
    // The previous code swallowed both to a zeroed tally -> NEUTRAL -> silent pass.
    const unparseableResult = () => ({
      verdict: blocking ? 'FAIL' : 'FLAG',
      killRate: null, total: 0, killed: 0, surviving: 0, suppressed: 0, survivors: [],
      in_scope_survivors: 0, suppression_ratio: 0,
      suppression_cap: typeof config.mutation.max_suppression_ratio === 'number' ? config.mutation.max_suppression_ratio : 0.5,
      suppression_cap_tripped: false,
      reasons: [
        `mutation report present but unparseable or malformed; failing ` +
        `${blocking ? 'closed [blocking]' : 'to a FLAG [advisory]'} ` +
        `(a declared mutation gate cannot go dark on a corrupt report)`,
      ],
    });
    const mutRunner = runnerResults.find((r) => r.class === 'mutation' && r.parsed &&
      (r.parsed.mutation_report || r.parsed.mutation));
    if (mutRunner) {
      let tally = null;
      let unparseable = false;
      try {
        if (mutRunner.parsed.mutation_report) {
          const rep = mutRunner.parsed.mutation_report;
          let obj = rep;
          if (typeof rep === 'string') {
            try { obj = JSON.parse(rep); } catch { unparseable = true; }
          } else if (rep === null || typeof rep !== 'object') {
            unparseable = true;
          }
          // A valid object missing the `files` map is a malformed Stryker report.
          if (!unparseable && (!obj || typeof obj.files !== 'object' || obj.files === null)) {
            unparseable = true;
          }
          if (!unparseable) tally = parseStryker(obj);
        } else if (mutRunner.parsed.mutation && typeof mutRunner.parsed.mutation === 'object') {
          const m = mutRunner.parsed.mutation;
          const killedN = Number(m.killed);
          const survN = m.surviving != null ? Number(m.surviving)
            : (Array.isArray(m.survivors) ? m.survivors.length : NaN);
          // Reject junk counts instead of coercing to 0 (which read as NEUTRAL).
          if (!Number.isFinite(killedN) || !Number.isFinite(survN)) {
            unparseable = true;
          } else {
            tally = {
              killed: killedN, surviving: survN, perFile: m.perFile || {},
              survivors: Array.isArray(m.survivors) ? m.survivors : [],
            };
          }
        }
      } catch (_) { unparseable = true; }

      if (unparseable) {
        mutationResult = unparseableResult();
      } else if (tally) {
        mutationResult = evaluateMutationAdvisory({
          tally,
          mode: config.mutation.mode || 'advisory',
          threshold: typeof config.mutation.threshold === 'number' ? config.mutation.threshold : 70,
          minMutants: typeof config.mutation.min_mutants === 'number' ? config.mutation.min_mutants : 1,
          allowlist: Array.isArray(config.mutation.allowlist) ? config.mutation.allowlist : [],
          maxSuppressionRatio: typeof config.mutation.max_suppression_ratio === 'number' ? config.mutation.max_suppression_ratio : undefined,
          changedFiles: diff.ok ? files : null,
        });
      }
    }
  }

  const requiredClasses = computeRequiredClasses(config.policy, files, diffIndeterminate);

  // Inter-suite discovery: detect frameworks present that no declared runner covers.
  // Fail-loud (FLAG, or FAIL under require_all_suites_wired). A discovery CRASH must
  // not silently suppress the strict FAIL: if the caller opted into blocking on
  // unwired suites, an error means we cannot prove suites are wired, so fail closed.
  let discovery = { detected: [], wired: [], unwired: [] };
  let discoveryError = null;
  try { discovery = discover(repoDir, config); } catch (e) { discoveryError = e && e.message ? e.message : String(e); }

  // v0.15 money signals (A4 money-path heuristic + F9 dead-glob + MS idempotency arming).
  // Computed once. detectMoneyPaths fails LOUD (indeterminate diff -> detected).
  const moneyPolicyConfigured = hasMoneyPolicy(config);
  const runnersObj = (config.runners && typeof config.runners === 'object') ? config.runners : {};
  // A money OR contract runner arms the idempotency invariant (Pass 8). Use isMoneyClass
  // so this stays consistent with the strict-class set and the schema; otherwise a
  // contract-only repo over money paths would escape Pass 8 AND A4 (policy_configured).
  const hasMoneyClassRunner = Object.values(runnersObj).some((c) => isMoneyClass(c));
  const changedContents = readChangedFileContents(files, repoDir);
  const moneyDetect = detectMoneyPaths({ changedFiles: files, fileContents: changedContents, diffIndeterminate });
  const moneySignal = {
    detected: moneyDetect.detected,
    indeterminate: moneyDetect.indeterminate,
    policy_configured: moneyPolicyConfigured,
    path_hits: (moneyDetect.pathHits || []).slice(0, 20),
    keyword_hits: (moneyDetect.keywordHits || []).slice(0, 20),
  };
  const deadRequireForGlobs = findDeadRequireForGlobs({
    policy: config.policy,
    repoFiles: Array.isArray(discovery.scanned_files) ? discovery.scanned_files : [],
    fileMatches,
  });

  const verdictInput = {
    runners: runnerResults.map((r) => {
      const cfg = runnersObj[r.name] || {};
      const money = isMoneyClass(cfg);
      let coverage = r.coverage;
      // MS Flip 2: a money runner's coverage is strict + reconciled (only ever tightens).
      if (money && coverage && typeof coverage === 'object') {
        coverage = { ...coverage, strict_coverage: true, reconcile: true };
      }
      return {
        name: r.name,
        required: money ? true : (r.required === true),          // MS Flip 1: money is always required
        ran: r.ran === true,
        exit_code: r.exit_code,
        class: r.class,
        coverage,
        flaky: r.flaky === true,
        quarantined: money ? false : (r.quarantined === true),   // MS: a money runner can never be quarantined
        quarantine_expired: quarantineExpired(cfg, finishedAt),  // F1
        invariant: Array.isArray(cfg.invariant) ? cfg.invariant : undefined,
        // Carry the spawn outcome through. Without these two the verdict sees a
        // plain ran:false and emits the generic "did not run", which sends the
        // engineer to their `when` globs when the actual problem is `command`.
        // This mapping is where the detail was being dropped.
        spawn_failed: r.spawn_failed === true || undefined,
        spawn_error: r.spawn_error,
        timed_out: r.timed_out === true || undefined,
        timeout_ms: r.timeout_ms,
      };
    }),
    adversarial_stats: adversarialStats,
    require_stats_for: requireStatsFor,
    require_classes: requiredClasses,
    require_coverage_evidence: config.require_coverage_evidence === true,
    unwired_suites: discovery.unwired,
    require_all_suites_wired: config.require_all_suites_wired === true,
    discovery_error: discoveryError,
    // MS: a repo with a money-movement runner must prove idempotency, even if the flag
    // was not set explicitly (contract-only does not arm it; that is not money movement).
    require_money_idempotency: config.require_money_idempotency === true || hasMoneyClassRunner,
    require_money_policy_when_detected: config.require_money_policy_when_detected === true,
    // Without this line the switch verdict.js reads is undefined on every real
    // run, so the indeterminate-diff guard could FLAG but never block - which is
    // how giving it "its own switch" quietly disarmed it everywhere.
    require_resolvable_diff: config.require_resolvable_diff === true,
    require_nonempty_gate: config.require_nonempty_gate === true,
    money_signal: moneySignal,
    dead_require_for_globs: deadRequireForGlobs,
    mutation: mutationResult,
    // The diff could not be resolved (bad/unreachable base ref). This already
    // fails closed for require_for, but with no such policy it was INVISIBLE:
    // point --base at origin/main in a repo whose default branch is master and
    // git errors, the diff comes back empty, no `when`-gated runner fires, and
    // the gate returns PASS over a typo. Surfacing it here means a run that
    // scoped itself to nothing can never look like a clean run.
    // Fires when the diff could not be resolved AND the repo actually has a
    // history to diff against.
    //
    // The first version qualified on `!!opts.baseSha`, to avoid crying wolf on a
    // fresh single-commit repo. That disarmed it exactly where adopters run it:
    // the workflow `fqe init` generates calls `fqe run --commit ... --output out/`
    // with NO `--base`, so opts.baseSha was undefined and the generated gate kept
    // swallowing an unresolvable diff, which is the whole defect. Key on the
    // repo instead of on the flag: a repo with more than one commit CAN produce a
    // diff, so failing to is a real signal; a first-commit repo genuinely cannot.
    // SILENCE MUST BE EARNED. An unresolved diff raises unless we can positively
    // prove the one case where silence is right: a genuinely new repo, with no
    // base named, that simply has nothing to diff against yet.
    //
    // Written this way round because the previous two attempts both framed it as
    // "raise IF ..." and both shipped a hole. The first keyed on `!!opts.baseSha`
    // and missed a repo with history and no base. The second keyed on
    // `repoHasHistory()` and was defeated by a shallow clone. The third was the
    // union of those two, which still collapsed to `repoHasHistory()` alone
    // whenever `--base` was omitted - and `--base` is optional in fqe's own help
    // text - so a shallow checkout with no base still reported PASS over zero
    // evaluated files. Each time the defect was a case the condition never
    // considered, so the condition now enumerates the ONLY safe case instead.
    //
    // repoIsShallow() is what makes this decidable: it separates "1 commit
    // because the repo is new" from "1 commit because the clone is truncated",
    // which repoHasHistory() alone can never do.
    diff_indeterminate: diffIndeterminate,
    diff_base: opts.baseSha || null,
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
    // EVIDENCE. This was hardcoded to [] while three separate docs promised the
    // runner's stderr would be in the receipt, and the explainer told blocked
    // engineers to "download the qa-receipt artifact to see the runner's
    // stderr". It was captured in memory and thrown away, so a FAIL receipt
    // carried an exit code and nothing else, and the one file the repro command
    // told you to `cat` was never written. Write it for every runner that
    // produced output, so the receipt can answer "why" and not just "no".
    evidence_paths: writeRunnerLogs(runnerResults, opts.outputDir),
    // The scope this verdict is actually about. `base: null` now means the run
    // was never told what to diff against, which is exactly the state that used
    // to be indistinguishable from a clean one.
    diff_scope: {
      base: opts.baseSha || null,
      changed_file_count: files.length,
      indeterminate: diffIndeterminate,
    },
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
  quarantineExpired,
  readChangedFileContents,
  sanitizeRunnerEnv,
  // Exported so the guard can be tested directly. The shallow-clone hole shipped
  // twice partly because nothing could reach this decision without spawning the
  // whole CLI, so every test asserted the verdict's branching instead of the
  // predicate that feeds it.
  repoIsShallow,
  repoHasHistory,
  isGenuinelyFirstRun,
  isGitRepo,
};
