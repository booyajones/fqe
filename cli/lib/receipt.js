'use strict';

/**
 * fqe receipt — DETERMINISTIC generation + parsing.
 *
 * The receipt is the load-bearing artifact of the entire QA gate.
 * Two physical files per run, sharing identity:
 *   - QA-RESULT.yml      machine-readable (workflow reads .verdict via yq)
 *   - QA-RESULT.md       human-readable copy (same YAML frontmatter + markdown body)
 *
 * Why two files: GitHub Actions `yq` on a markdown file with YAML frontmatter
 * requires sed gymnastics; storing pure YAML in QA-RESULT.yml eliminates that
 * ambiguity (gauntlet 11f9c0 flaw #3).
 *
 * Architectural invariant bindings enforced here:
 *   - commit_sha is bound at write time, validated at parse time
 *   - content_hash covers ALL files at that commit
 *   - inputs_hash covers runner configs at that commit
 *   - bypass.requester_source MUST equal "github_events_api_v3" or parse rejects
 *     (closes v5 attacker-controlled-identity flaw)
 *   - verdict is computed by verdict.js, never authored as text
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const REQUESTER_SOURCE_OK = 'github_events_api_v3';
// Allowed server-recorded identity sources for a bypass. Both are GitHub REST
// objects the PR author cannot forge: the labeled-event actor (legacy label
// path) and the comment author (the v0.4.0 SHA-bound /fqe-bypass comment path).
const REQUESTER_SOURCES_OK = new Set([REQUESTER_SOURCE_OK, 'github_comments_api_v3']);

/**
 * Compute SHA256 over a list of files. Deterministic: files are sorted by
 * path before hashing so order doesn't affect the digest.
 *
 * @param {string[]} filePaths - absolute paths
 * @returns {string} "sha256:<64 hex>"
 */
function hashFiles(filePaths) {
  const sorted = [...filePaths].sort();
  const h = crypto.createHash('sha256');
  for (const p of sorted) {
    h.update(p);
    h.update('\0');
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      const data = fs.readFileSync(p);
      h.update(data);
    } else {
      throw new Error(`hashFiles: not a regular file: ${p}`);
    }
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

/**
 * Hash a single string deterministically (used for inputs_hash over JSON configs).
 */
function hashString(s) {
  return `sha256:${crypto.createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

/**
 * Minimal-dependency YAML serializer for the fields we use.
 * Avoids pulling js-yaml into the trust boundary; what we emit must be
 * round-trip-stable through `yq` and standard YAML parsers.
 *
 * Supports: strings (quoted if needed), numbers, booleans, null, arrays of scalars,
 * arrays of objects, nested objects. No anchors, no multi-doc, no exotic tags.
 */
function yamlSerialize(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') {
    // Quote if contains special chars or could be misinterpreted
    if (/^[A-Za-z0-9_./-][A-Za-z0-9_.: /-]*$/.test(obj) && !['null', 'true', 'false', 'yes', 'no'].includes(obj.toLowerCase())) {
      return obj;
    }
    return JSON.stringify(obj); // valid YAML for double-quoted strings
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const inner = yamlSerialize(item, indent + 1);
        // first key on the same line as the dash
        const lines = inner.split('\n');
        const first = lines[0].replace(/^\s+/, '');
        const rest = lines.slice(1).join('\n');
        return `${pad}- ${first}` + (rest ? '\n' + rest : '');
      }
      // scalar or array - inline
      if (Array.isArray(item)) {
        return `${pad}- ${JSON.stringify(item)}`;
      }
      return `${pad}- ${yamlSerialize(item, indent + 1)}`;
    }).join('\n');
  }
  // object
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  return keys.map(k => {
    const v = obj[k];
    if (v === null || typeof v !== 'object' || (Array.isArray(v) && v.every(x => typeof x !== 'object' || x === null))) {
      // scalar or simple array - inline
      if (Array.isArray(v)) {
        return `${pad}${k}: ${JSON.stringify(v)}`;
      }
      return `${pad}${k}: ${yamlSerialize(v, indent + 1)}`;
    }
    // object or array-of-objects -> nested block
    return `${pad}${k}:\n${yamlSerialize(v, indent + 1)}`;
  }).join('\n');
}

/**
 * Build the receipt object. Caller supplies verdict (computed by verdict.js)
 * and all binding fields. This function does not compute verdict — that's
 * verdict.js's job, on purpose.
 *
 * @param {{
 *   fqe_version: string,
 *   run_id: string,
 *   started_at: string,
 *   finished_at: string,
 *   commit_sha: string,
 *   content_hash: string,
 *   inputs_hash: string,
 *   classifier_version: number,
 *   runner_versions: Object<string,string>,
 *   runners_fired: string[],
 *   runners: Array,
 *   adversarial_stats?: Array,
 *   quarantined_tests?: Array,
 *   verdict: 'PASS'|'FLAG'|'FAIL',
 *   verdict_reasons: string[],
 *   bypass?: {
 *     requester: string,
 *     requester_source: 'github_events_api_v3',
 *     events_url: string,
 *     requester_event_id?: number,
 *     allowlist_version: string,
 *     timestamp: string
 *   },
 *   evidence_paths: string[]
 * }} ctx
 * @returns {Object} receipt object
 */
function buildReceipt(ctx) {
  validateCtx(ctx);
  const receipt = {
    schema_version: SCHEMA_VERSION,
    fqe_version: ctx.fqe_version,
    run_id: ctx.run_id,
    started_at: ctx.started_at,
    finished_at: ctx.finished_at,
    commit_sha: ctx.commit_sha,
    content_hash: ctx.content_hash,
    inputs_hash: ctx.inputs_hash,
    classifier_version: ctx.classifier_version,
    runner_versions: ctx.runner_versions,
    runners_fired: ctx.runners_fired,
    runners: ctx.runners,
    adversarial_stats: ctx.adversarial_stats || [],
    required_classes: ctx.required_classes || [],
    quarantined_tests: ctx.quarantined_tests || [],
    verdict: ctx.verdict,
    verdict_reasons: ctx.verdict_reasons || [],
    bypass: ctx.bypass || null,
    evidence_paths: ctx.evidence_paths || [],
    // v0.10: instruments the near-autonomy DoD. Counts the items a human must look
    // at this run (flags, flaky/quarantined runners, unwired suites, AI drafts) and
    // an estimated minutes, so the "3-6 team-hours/week" target is observed, not asserted.
    human_review: ctx.human_review || null,
  };
  return receipt;
}

function validateCtx(ctx) {
  const required = [
    'fqe_version', 'run_id', 'started_at', 'finished_at',
    'commit_sha', 'content_hash', 'inputs_hash',
    'classifier_version', 'runner_versions', 'runners_fired',
    'runners', 'verdict',
  ];
  for (const f of required) {
    if (ctx[f] === undefined || ctx[f] === null) {
      throw new Error(`buildReceipt: missing required field '${f}'`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(ctx.commit_sha)) {
    throw new Error(`buildReceipt: commit_sha must be 40-char hex, got '${ctx.commit_sha}'`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(ctx.content_hash)) {
    throw new Error(`buildReceipt: content_hash must be 'sha256:<64hex>', got '${ctx.content_hash}'`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(ctx.inputs_hash)) {
    throw new Error(`buildReceipt: inputs_hash must be 'sha256:<64hex>', got '${ctx.inputs_hash}'`);
  }
  if (!['PASS', 'FLAG', 'FAIL'].includes(ctx.verdict)) {
    throw new Error(`buildReceipt: verdict must be PASS|FLAG|FAIL, got '${ctx.verdict}'`);
  }
  if (ctx.bypass) {
    // Hard invariant: bypass identity may ONLY come from a server-recorded
    // GitHub source (labeled-event actor OR comment author), never a PR file.
    if (!REQUESTER_SOURCES_OK.has(ctx.bypass.requester_source)) {
      throw new Error(
        `buildReceipt: bypass.requester_source MUST be one of ${[...REQUESTER_SOURCES_OK].join(', ')} ` +
        `(closes v5 attacker-controlled-identity flaw); got '${ctx.bypass.requester_source}'`
      );
    }
    for (const f of ['requester', 'events_url', 'allowlist_version', 'timestamp']) {
      if (!ctx.bypass[f]) {
        throw new Error(`buildReceipt: bypass.${f} is required when bypass is present`);
      }
    }
  }
}

/**
 * Serialize a receipt to YAML (for QA-RESULT.yml) and markdown (for QA-RESULT.md).
 * The .md version has the YAML as frontmatter so humans can read it inline.
 *
 * @param {Object} receipt
 * @returns {{ yaml: string, markdown: string }}
 */
function serializeReceipt(receipt) {
  const yaml = yamlSerialize(receipt);
  const body = renderMarkdownBody(receipt);
  const markdown = `---\n${yaml}\n---\n\n${body}\n`;
  return { yaml: yaml + '\n', markdown };
}

function renderMarkdownBody(r) {
  const lines = [];
  lines.push(`# QA Receipt — ${r.verdict}`);
  lines.push('');
  lines.push(`**Run ID:** \`${r.run_id}\``);
  lines.push(`**Commit:** \`${r.commit_sha}\``);
  lines.push(`**Started:** ${r.started_at}`);
  lines.push(`**Finished:** ${r.finished_at}`);
  if (r.bypass) {
    lines.push('');
    lines.push(`**BYPASS** by \`${r.bypass.requester}\` (source: ${r.bypass.requester_source})`);
    lines.push(`Events URL: ${r.bypass.events_url}`);
  }
  lines.push('');
  lines.push('## Runners');
  lines.push('');
  lines.push('| Runner | Class | Required | Ran | Exit | Tests (exec/collected) |');
  lines.push('|---|---|---|---|---|---|');
  for (const rn of r.runners) {
    // Surface coverage-liveness so absence is LOUD in the human-readable receipt, not
    // hidden in the YAML. "NO EVIDENCE" means a declared report was missing/unparseable.
    let covCell = '-';
    const cov = rn.coverage;
    if (cov && cov.declared === true) {
      if (cov.evidence_ok === true) {
        const coll = typeof cov.collected === 'number' ? cov.collected : '?';
        covCell = `${cov.executed}/${coll}`;
      } else {
        covCell = 'NO EVIDENCE';
      }
    }
    lines.push(`| ${rn.name} | ${rn.class || '-'} | ${rn.required ? 'yes' : 'no'} | ${rn.ran ? 'yes' : 'no'} | ${rn.ran ? rn.exit_code : '-'} | ${covCell} |`);
  }
  if (r.required_classes && r.required_classes.length > 0) {
    lines.push('');
    lines.push(`**Policy required classes:** ${r.required_classes.join(', ')}`);
  }
  if (r.human_review) {
    const h = r.human_review;
    lines.push('');
    lines.push(`**Human review queue:** ~${h.estimated_minutes} min ` +
      `(flags ${h.flags || 0}, flaky ${h.flaky || 0}, quarantined ${h.quarantined || 0}, ` +
      `unwired suites ${h.unwired_suites || 0}, AI drafts ${h.ai_drafts || 0})`);
  }
  if (r.adversarial_stats && r.adversarial_stats.length > 0) {
    lines.push('');
    lines.push('## Adversarial stats');
    lines.push('');
    lines.push('| Runner | Class | N | Successes | CI 95% | Threshold |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of r.adversarial_stats) {
      const ci = `[${s.ci_95[0].toFixed(4)}, ${s.ci_95[1].toFixed(4)}]`;
      lines.push(`| ${s.runner} | ${s.blast_radius} | ${s.n} | ${s.successes} | ${ci} | (canonical) |`);
    }
  }
  if (r.verdict_reasons && r.verdict_reasons.length > 0) {
    // Engineer-grade explanation (plain-English + repro command + fix suggestion)
    // — closes council 1613ed kill-feature #1 (explainability).
    // The lazy import keeps receipt.js usable standalone without explainer in
    // contexts that don't need rendering.
    let explainVerdict;
    try {
      ({ explainVerdict } = require('./explainer'));
    } catch (err) {
      // Only suppress "module genuinely not installed". Re-throw syntax errors
      // and runtime errors inside explainer.js so engineers see them loudly.
      if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    }
    if (explainVerdict) {
      lines.push('');
      lines.push('## What this means');
      lines.push('');
      lines.push(explainVerdict(
        { verdict: r.verdict, reasons: r.verdict_reasons },
        { commit_sha: r.commit_sha }
      ));
    } else {
      // Fallback if explainer is missing (shouldn't happen in normal use)
      lines.push('');
      lines.push('## Reasons');
      lines.push('');
      for (const reason of r.verdict_reasons) {
        lines.push(`- ${reason}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Parse a QA-RESULT.yml file and validate it.
 * Used by the workflow to read the verdict, and by tests.
 *
 * Lightweight YAML parser sufficient for the receipt shape we emit.
 * Does NOT support general YAML.
 *
 * @param {string} yamlText
 * @returns {Object}
 */
function parseReceiptYaml(yamlText) {
  // Use a minimal recursive descent suited to our serialization output.
  const lines = yamlText.split(/\r?\n/);
  const { value } = parseBlock(lines, 0, 0);
  if (!value || typeof value !== 'object') {
    throw new Error('parseReceiptYaml: top-level must be an object');
  }
  if (value.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `parseReceiptYaml: schema_version mismatch — got ${value.schema_version}, expected ${SCHEMA_VERSION}`
    );
  }
  // Re-validate the identity invariant on parse too
  if (value.bypass && !REQUESTER_SOURCES_OK.has(value.bypass.requester_source)) {
    throw new Error(
      `parseReceiptYaml: bypass.requester_source MUST be one of ${[...REQUESTER_SOURCES_OK].join(', ')}`
    );
  }
  return value;
}

function parseBlock(lines, startIdx, baseIndent) {
  const result = {};
  let i = startIdx;
  let firstIndent = -1;
  // Detect whether this block is a list
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
  if (i >= lines.length) return { value: result, nextIdx: i };
  const indent = countIndent(lines[i]);
  if (indent < baseIndent) return { value: result, nextIdx: i };
  if (lines[i].trim().startsWith('- ')) {
    const list = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
      const ind = countIndent(line);
      if (ind < baseIndent) break;
      if (ind === baseIndent && line.trim().startsWith('- ')) {
        const after = line.slice(ind + 2);
        // Could be: scalar, inline mapping, or block start
        if (after.includes(': ') || /^[A-Za-z_][\w-]*:$/.test(after.trim())) {
          // First key of an object item; treat indent + 2 as new base
          const synth = ' '.repeat(ind + 2) + after;
          // Re-inject for next pass
          const sub = [synth, ...lines.slice(i + 1)];
          const { value, nextIdx } = parseBlock(sub, 0, ind + 2);
          list.push(value);
          i = i + 1 + (nextIdx - 1);
        } else {
          list.push(parseScalar(after));
          i++;
        }
      } else {
        break;
      }
    }
    return { value: list, nextIdx: i };
  }
  // Mapping
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    const ind = countIndent(line);
    if (firstIndent === -1) firstIndent = ind;
    if (ind < baseIndent) break;
    if (ind > firstIndent) break;
    const m = line.slice(ind).match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const after = m[2];
    if (after === '' || after === undefined) {
      // nested block
      const { value, nextIdx } = parseBlock(lines, i + 1, ind + 2);
      result[key] = value;
      i = nextIdx;
    } else if (after.startsWith('[') || after.startsWith('{') || after === 'null' || after === 'true' || after === 'false' || /^-?\d/.test(after) || after.startsWith('"') || after.startsWith("'")) {
      result[key] = parseScalar(after);
      i++;
    } else {
      result[key] = parseScalar(after);
      i++;
    }
  }
  return { value: result, nextIdx: i };
}

function countIndent(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function parseScalar(text) {
  const t = text.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+(?:[eE]-?\d+)?$/.test(t)) return parseFloat(t);
  if (t.startsWith('"') && t.endsWith('"')) return JSON.parse(t);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t.startsWith('[') && t.endsWith(']')) {
    // JSON-compatible inline array
    try { return JSON.parse(t); } catch { return t; }
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    try { return JSON.parse(t); } catch { return t; }
  }
  return t;
}

/**
 * High-level write: serialize and write both QA-RESULT.yml and QA-RESULT.md
 * to the same directory atomically (write to temp + rename).
 */
function writeReceiptFiles(receipt, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { yaml, markdown } = serializeReceipt(receipt);
  const ymlPath = path.join(outDir, 'QA-RESULT.yml');
  const mdPath  = path.join(outDir, 'QA-RESULT.md');
  fs.writeFileSync(ymlPath + '.tmp', yaml);
  fs.writeFileSync(mdPath  + '.tmp', markdown);
  fs.renameSync(ymlPath + '.tmp', ymlPath);
  fs.renameSync(mdPath  + '.tmp', mdPath);
  return { ymlPath, mdPath };
}

module.exports = {
  SCHEMA_VERSION,
  REQUESTER_SOURCE_OK,
  REQUESTER_SOURCES_OK,
  hashFiles,
  hashString,
  buildReceipt,
  serializeReceipt,
  parseReceiptYaml,
  writeReceiptFiles,
};
