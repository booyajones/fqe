'use strict';

/**
 * fqe golden-master / regression engine.
 *
 * A golden master snapshots the output of a deterministic command (the
 * "golden"), then on later runs re-runs the command and FAILS if the output
 * drifts from the stored snapshot. This catches silent regressions in
 * deterministic outputs: rendered invoices, reconciliation reports, serialized
 * API payloads — anything where "same input -> same output" is the contract.
 *
 * Deterministic, fail-closed, no LLM in the path (same as the rest of fqe).
 *
 * Design notes:
 *   - The PURE comparison core (normalizeOutput, sha256, compareToGolden,
 *     goldenPath, parseGoldenManifest) is kept separate from the IMPURE
 *     subprocess layer (runCommand, captureGoldens, verifyGoldens) so the core
 *     is fully unit-testable WITHOUT spawning anything.
 *   - Subprocesses use spawnSync with an explicit argv array (NO shell), a
 *     bounded timeout, and per-command exit-code capture — same posture as
 *     orchestrator.js.
 *   - We FAIL CLOSED everywhere: a command that exits non-zero is never
 *     snapshotted (you must not freeze a failing command as the baseline), and
 *     verifying with no stored golden is a FAIL (you cannot verify against
 *     nothing — capture a baseline first).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const GOLDEN_EXT = '.golden';

// ─── PURE comparison core ───────────────────────────────────────────────

/**
 * Normalize command output for stable cross-platform comparison.
 *
 * Two transforms, in order:
 *   1. Line endings: every CRLF ("\r\n") and every lone CR ("\r") becomes LF
 *      ("\n"). This prevents false drift when a golden is captured on one OS
 *      (or by one editor's autocrlf) and verified on another.
 *   2. A single trailing newline is stripped. Many tools print a terminating
 *      "\n"; whether the stored file keeps it is an editor/OS detail, not a
 *      meaningful output difference. Only ONE trailing newline is removed, so a
 *      deliberate blank final line ("foo\n\n") still differs from "foo\n".
 *
 * @param {string} s raw output
 * @returns {string} normalized output
 */
function normalizeOutput(s) {
  let out = String(s == null ? '' : s);
  // CRLF first, then any remaining lone CR -> LF.
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip exactly one trailing LF if present.
  if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

/**
 * SHA-256 of a string, tagged with the algorithm prefix (matches the
 * "sha256:<hex>" convention used elsewhere in fqe receipts).
 * @param {string} s
 * @returns {string} "sha256:" + 64 lowercase hex chars
 */
function sha256(s) {
  const h = crypto.createHash('sha256');
  h.update(String(s == null ? '' : s), 'utf8');
  return `sha256:${h.digest('hex')}`;
}

/**
 * Compare actual command output against a stored golden.
 *
 * Both sides are normalized (see normalizeOutput) before hashing, so OS/editor
 * line-ending noise never counts as drift. This function assumes BOTH sides are
 * present strings; the "no golden stored" case is the caller's responsibility
 * (verifyGoldens reports it as 'missing-golden').
 *
 * @param {object} o
 * @param {string} o.actualContent  freshly captured output
 * @param {string} o.goldenContent  stored snapshot
 * @returns {{ status: 'pass'|'drift', expected_sha: string, actual_sha: string }}
 *   status 'pass' if the normalized shas are equal, 'drift' if they differ.
 */
function compareToGolden(o) {
  const { actualContent, goldenContent } = o || {};
  const expected_sha = sha256(normalizeOutput(goldenContent));
  const actual_sha = sha256(normalizeOutput(actualContent));
  return {
    status: expected_sha === actual_sha ? 'pass' : 'drift',
    expected_sha,
    actual_sha,
  };
}

/**
 * Resolve the on-disk path for a golden named `name` inside `dir`.
 *
 * Fail closed against path traversal: a golden name is a flat identifier, never
 * a path. Names containing a path separator ("/" or "\\") or a ".." segment are
 * rejected with a throw so a manifest cannot be used to write/read outside the
 * golden directory. A leading "." is also rejected: ".hidden" is a dotfile, not
 * a flat identifier, and could dodge a `*.golden` file enumeration in
 * oracle-guard.
 *
 * @param {string} dir  golden directory
 * @param {string} name golden identifier (flat, no separators, no leading dot)
 * @returns {string} path.join(dir, name + '.golden')
 */
function goldenPath(dir, name) {
  if (typeof name !== 'string' || name === '') {
    throw new Error('goldenPath: name must be a non-empty string');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`goldenPath: name must not contain a path separator: ${name}`);
  }
  if (name.includes('..')) {
    throw new Error(`goldenPath: name must not contain '..': ${name}`);
  }
  if (name.startsWith('.')) {
    throw new Error(`goldenPath: name must not start with '.' (no dotfiles): ${name}`);
  }
  return path.join(dir, name + GOLDEN_EXT);
}

/**
 * Parse a goldens manifest. Two formats are accepted:
 *
 *   JSON  (filename ends ".json", OR the trimmed text starts with "{"):
 *     { "goldens": [ { "name": "...", "command": "...", "args": [...] } ] }
 *
 *   A small, constrained YAML subset (the orchestrator.js style):
 *     goldens:
 *       - name: invoice-render
 *         command: node
 *         args: ["scripts/render.js", "fixtures/inv.json"]
 *       - name: recon-report
 *         command: python3
 *         args: ["recon.py", "fixtures/day.csv"]
 *   List items begin with `- key: val` at indent 2; continuation keys sit at
 *   indent 4. `args` is a JSON-style inline array.
 *
 * Fails closed: a malformed structure, a missing/invalid name or command, or a
 * duplicate name throws. (You cannot half-run a regression suite.)
 *
 * @param {string} text     manifest contents
 * @param {string} [filename] used only to detect JSON by extension
 * @returns {{ goldens: Array<{name:string, command:string, args:string[]}> }}
 */
function parseGoldenManifest(text, filename) {
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  const looksJson =
    (typeof filename === 'string' && filename.toLowerCase().endsWith('.json')) ||
    trimmed.startsWith('{');

  let goldens;
  if (looksJson) {
    let obj;
    try {
      obj = JSON.parse(trimmed === '' ? '{}' : trimmed);
    } catch (e) {
      throw new Error(`golden manifest: invalid JSON: ${e.message}`);
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.goldens)) {
      throw new Error('golden manifest: JSON must have a top-level "goldens" array');
    }
    goldens = obj.goldens.map((g, idx) => normalizeGoldenEntry(g, idx));
  } else {
    goldens = parseGoldenManifestYaml(raw);
  }

  // Validate names + reject duplicates (fail closed).
  const seen = new Set();
  for (const g of goldens) {
    if (typeof g.name !== 'string' || g.name === '') {
      throw new Error('golden manifest: every golden requires a non-empty "name"');
    }
    if (g.name.includes('/') || g.name.includes('\\') || g.name.includes('..')) {
      throw new Error(`golden manifest: invalid name (path-unsafe): ${g.name}`);
    }
    if (seen.has(g.name)) {
      throw new Error(`golden manifest: duplicate golden name: ${g.name}`);
    }
    seen.add(g.name);
    if (typeof g.command !== 'string' || g.command === '') {
      throw new Error(`golden manifest: golden "${g.name}" requires a non-empty "command"`);
    }
    if (!Array.isArray(g.args)) {
      throw new Error(`golden manifest: golden "${g.name}" args must be an array`);
    }
  }
  return { goldens };
}

/** Coerce a JSON golden entry into the canonical {name, command, args} shape. */
function normalizeGoldenEntry(g, idx) {
  if (!g || typeof g !== 'object') {
    throw new Error(`golden manifest: goldens[${idx}] must be an object`);
  }
  return {
    name: g.name,
    command: g.command,
    args: g.args === undefined ? [] : g.args,
  };
}

/**
 * Constrained-YAML parser for the goldens manifest. Mirrors orchestrator.js's
 * focused, indent-based approach. Only the documented shape is supported; any
 * deviation throws.
 */
function parseGoldenManifestYaml(text) {
  const lines = text.split(/\r?\n/);
  let inGoldens = false;
  const goldens = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 0) {
      const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) throw new Error(`golden manifest: malformed top-level line ${i + 1}: ${line}`);
      if (m[1] !== 'goldens') {
        throw new Error(`golden manifest: unknown top-level key "${m[1]}" (expected "goldens")`);
      }
      if (m[2] !== '') {
        throw new Error('golden manifest: "goldens" must be a block list');
      }
      inGoldens = true;
      cur = null;
      continue;
    }

    if (!inGoldens) {
      throw new Error(`golden manifest: indented content before "goldens:" at line ${i + 1}`);
    }

    if (indent === 2) {
      if (!trimmed.startsWith('- ')) {
        throw new Error(`golden manifest: expected a list item ("- key: val") at line ${i + 1}: ${line}`);
      }
      cur = { args: [] };
      goldens.push(cur);
      const after = trimmed.slice(2).trim();
      const m = after.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) throw new Error(`golden manifest: malformed list item at line ${i + 1}: ${line}`);
      assignGoldenField(cur, m[1], m[2], i + 1);
    } else if (indent === 4) {
      if (!cur) {
        throw new Error(`golden manifest: continuation key without a list item at line ${i + 1}: ${line}`);
      }
      if (trimmed.startsWith('- ')) {
        throw new Error(`golden manifest: unexpected nested list item at line ${i + 1}: ${line}`);
      }
      const m = trimmed.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!m) throw new Error(`golden manifest: malformed field at line ${i + 1}: ${line}`);
      assignGoldenField(cur, m[1], m[2], i + 1);
    } else {
      throw new Error(`golden manifest: unexpected indent (${indent}) at line ${i + 1}: ${line}`);
    }
  }

  if (!inGoldens) {
    throw new Error('golden manifest: missing top-level "goldens:" key');
  }
  return goldens;
}

/** Assign one parsed key/value onto a golden entry, with type rules. */
function assignGoldenField(entry, key, rawVal, lineNo) {
  const val = rawVal.trim();
  if (key === 'args') {
    if (val === '') {
      entry.args = [];
      return;
    }
    if (!val.startsWith('[')) {
      throw new Error(`golden manifest: args must be a JSON-style array at line ${lineNo}: ${rawVal}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(val);
    } catch (e) {
      throw new Error(`golden manifest: args is not valid JSON at line ${lineNo}: ${e.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`golden manifest: args must be an array at line ${lineNo}`);
    }
    entry.args = parsed.map(String);
    return;
  }
  if (key === 'name' || key === 'command') {
    entry[key] = parseScalar(val);
    return;
  }
  throw new Error(`golden manifest: unknown golden field "${key}" at line ${lineNo}`);
}

/** Strip matching surrounding quotes from a scalar; otherwise return as-is. */
function parseScalar(t) {
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try { return JSON.parse(t); } catch (_) { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

// ─── IMPURE subprocess layer ────────────────────────────────────────────

/**
 * Run a single command and capture its output.
 *
 * Uses spawnSync with an explicit argv array (NO shell, no quoting hazards),
 * utf8 encoding, and a bounded timeout. exit_code is the numeric status, or
 * null when the process did not exit normally (killed by timeout/signal) — same
 * convention as orchestrator.js.
 *
 * @param {object} o
 * @param {string}   o.command
 * @param {string[]} [o.args=[]]
 * @param {string}   [o.cwd=process.cwd()]
 * @param {number}   [o.timeoutMs=300000]
 * @returns {{ exit_code: number|null, stdout: string, stderr: string }}
 */
function runCommand(o) {
  const { command, args = [], cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = o || {};
  const r = spawnSync(command, Array.isArray(args) ? args : [], {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
  });
  return {
    exit_code: typeof r.status === 'number' ? r.status : null,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

/**
 * Capture (snapshot) goldens. For each golden, run the command and write the
 * normalized stdout to its golden file.
 *
 * FAIL CLOSED: if a command exits non-zero or its exit_code is null, the
 * failure is recorded and NO golden is written. You must never freeze a failing
 * command as the baseline — that would make every future verify a false pass.
 *
 * ALL-OR-NOTHING NAME VALIDATION: every golden name is validated (via
 * goldenPath) up front, before any file is written. parseGoldenManifest already
 * validates names, but a directly-constructed goldens array could carry an
 * illegal name; validating per-item inside the write loop would leave items
 * 1..N-1 already on disk when item N throws (a partial, misleading capture). We
 * resolve all target paths first so one bad name throws with nothing written.
 *
 * The golden directory is created (recursively) if missing.
 *
 * @param {object} o
 * @param {Array<{name,command,args}>} o.goldens
 * @param {string} o.dir   directory to write *.golden files into
 * @param {string} [o.cwd] working dir for the commands
 * @returns {{ written: string[], failed: Array<{name:string, reason:string}> }}
 */
function captureGoldens(o) {
  const { goldens, dir, cwd } = o || {};
  if (!Array.isArray(goldens)) throw new Error('captureGoldens: goldens must be an array');
  if (typeof dir !== 'string' || dir === '') throw new Error('captureGoldens: dir is required');

  // Validate ALL names before touching the filesystem. goldenPath throws on any
  // path-unsafe name, so a single bad entry aborts the whole capture with
  // nothing written (no partial dir). Resolved paths are reused below.
  const targets = goldens.map((g) => goldenPath(dir, g.name));

  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const failed = [];
  for (let i = 0; i < goldens.length; i++) {
    const g = goldens[i];
    const target = targets[i];
    const r = runCommand({ command: g.command, args: g.args, cwd });
    if (r.exit_code !== 0) {
      failed.push({
        name: g.name,
        reason:
          r.exit_code === null
            ? 'command did not exit normally (timeout/signal); not snapshotting a failing command'
            : `command exited ${r.exit_code}; not snapshotting a failing command`,
      });
      continue;
    }
    fs.writeFileSync(target, normalizeOutput(r.stdout));
    written.push(g.name);
  }
  return { written, failed };
}

/**
 * Verify goldens. For each golden:
 *   - if its golden file is missing            -> status 'missing-golden' (FAIL:
 *     a regression check with no baseline cannot verify against nothing — you
 *     must capture first).
 *   - if the command exits non-zero / null     -> status 'run-failed' (FAIL).
 *   - otherwise compare actual vs stored        -> status 'pass' | 'drift'.
 *
 * The overall verdict is PASS only when every golden passes; any drift, missing
 * baseline, or run failure is a blocker and yields FAIL (fail closed).
 *
 * @param {object} o
 * @param {Array<{name,command,args}>} o.goldens
 * @param {string} o.dir
 * @param {string} [o.cwd]
 * @returns {{
 *   total:number, passed:number,
 *   drifted: Array<{name:string, expected_sha:string, actual_sha:string}>,
 *   missing: Array<{name:string}>,
 *   run_failed: Array<{name:string, exit_code:number|null}>,
 *   verdict: 'PASS'|'FAIL',
 *   reasons: string[]
 * }}
 */
function verifyGoldens(o) {
  const { goldens, dir, cwd } = o || {};
  if (!Array.isArray(goldens)) throw new Error('verifyGoldens: goldens must be an array');
  if (typeof dir !== 'string' || dir === '') throw new Error('verifyGoldens: dir is required');

  let passed = 0;
  const drifted = [];
  const missing = [];
  const run_failed = [];
  const reasons = [];

  for (const g of goldens) {
    const target = goldenPath(dir, g.name); // throws on path-unsafe name

    if (!fs.existsSync(target)) {
      missing.push({ name: g.name });
      reasons.push(
        `GOLDEN_MISSING: "${g.name}" has no stored baseline at ${target}. ` +
        `Cannot verify against nothing — capture a golden first.`
      );
      continue;
    }

    const r = runCommand({ command: g.command, args: g.args, cwd });
    if (r.exit_code !== 0) {
      run_failed.push({ name: g.name, exit_code: r.exit_code });
      reasons.push(
        `GOLDEN_RUN_FAILED: "${g.name}" command exited ` +
        `${r.exit_code === null ? 'abnormally (timeout/signal)' : r.exit_code} ` +
        `— cannot compare a failing command to its golden.`
      );
      continue;
    }

    const goldenContent = fs.readFileSync(target, 'utf8');
    const cmp = compareToGolden({ actualContent: r.stdout, goldenContent });
    if (cmp.status === 'pass') {
      passed++;
    } else {
      drifted.push({
        name: g.name,
        expected_sha: cmp.expected_sha,
        actual_sha: cmp.actual_sha,
      });
      reasons.push(
        `GOLDEN_DRIFT: "${g.name}" output changed from its snapshot. ` +
        `expected ${cmp.expected_sha}, got ${cmp.actual_sha}. ` +
        `If this change is intended, re-capture the golden.`
      );
    }
  }

  const total = goldens.length;
  const verdict =
    drifted.length === 0 && missing.length === 0 && run_failed.length === 0
      ? 'PASS'
      : 'FAIL';

  return { total, passed, drifted, missing, run_failed, verdict, reasons };
}

/**
 * Render a human-readable report from a verifyGoldens() result.
 *
 * Fail closed: a missing or unrecognized verdict throws rather than rendering a
 * soft "UNKNOWN". A regression report with no verdict is meaningless, and
 * silently printing UNKNOWN could read as "not a FAIL" to a human or a grep.
 *
 * @param {ReturnType<typeof verifyGoldens>} result
 * @returns {string}
 */
function renderGoldenReport(result) {
  const r = result || {};
  if (r.verdict !== 'PASS' && r.verdict !== 'FAIL') {
    throw new Error(
      `renderGoldenReport: missing/invalid verdict (got ${JSON.stringify(r.verdict)}); ` +
      'expected "PASS" or "FAIL"'
    );
  }
  const lines = [];
  lines.push('fqe golden-master regression report');
  lines.push('====================================');
  lines.push(`verdict: ${r.verdict}`);
  lines.push(
    `goldens: ${r.total || 0} total, ${r.passed || 0} passed, ` +
    `${(r.drifted || []).length} drifted, ${(r.missing || []).length} missing, ` +
    `${(r.run_failed || []).length} run-failed`
  );

  if ((r.drifted || []).length > 0) {
    lines.push('');
    lines.push('DRIFT (output changed from snapshot):');
    for (const d of r.drifted) {
      lines.push(`  - ${d.name}`);
      lines.push(`      expected ${d.expected_sha}`);
      lines.push(`      actual   ${d.actual_sha}`);
    }
  }

  if ((r.missing || []).length > 0) {
    lines.push('');
    lines.push('MISSING (no baseline — capture first):');
    for (const m of r.missing) lines.push(`  - ${m.name}`);
  }

  if ((r.run_failed || []).length > 0) {
    lines.push('');
    lines.push('RUN-FAILED (command did not exit 0):');
    for (const f of r.run_failed) {
      lines.push(`  - ${f.name} (exit ${f.exit_code === null ? 'null' : f.exit_code})`);
    }
  }

  if ((r.reasons || []).length > 0) {
    lines.push('');
    lines.push('reasons:');
    for (const reason of r.reasons) lines.push(`  - ${reason}`);
  }

  return lines.join('\n');
}

module.exports = {
  normalizeOutput,
  sha256,
  compareToGolden,
  goldenPath,
  parseGoldenManifest,
  runCommand,
  captureGoldens,
  verifyGoldens,
  renderGoldenReport,
  DEFAULT_TIMEOUT_MS,
  GOLDEN_EXT,
};
