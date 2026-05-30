'use strict';

/**
 * fqe explain — the staff engineer's 5-minute audit.
 *
 * Per council 1613ed kill-feature #2: when a skeptical staff engineer pokes
 * the black box for the first time, what they see decides their architectural
 * verdict. Hand them:
 *   - the canonical thresholds map (not configurable — that's the point)
 *   - the three architectural invariants in plain English
 *   - the current .fqe.yml config (what THIS repo actually gates on)
 *   - a dry-run preview: what would pass/fail right now without committing
 *   - links to source code, tests, and the public repo
 *
 * No I/O outside reading .fqe.yml and the runtime environment. No LLM.
 */

const fs = require('node:fs');
const path = require('node:path');
const { BLAST_RADIUS_THRESHOLDS } = require('./verdict');

const FQE_VERSION = '0.7.0';

const INVARIANTS = [
  {
    n: 1,
    name: 'No identity from attacker-writable sources',
    plain_english:
      'When someone bypasses the gate, fqe identifies them via the GitHub Events API ' +
      '(server-recorded actor on the labeled:fqe/bypass-* event). It NEVER reads identity ' +
      'from a file the bypassing actor wrote (commit message, PR body, receipt content). ' +
      'This means a junior engineer cannot pretend to be the CTO by writing "bypassed by ctom" ' +
      'in a commit — the GitHub API is the only authority.',
    why_it_matters:
      'Self-attested identity is the v1 design that the gauntlet caught in iteration v5. ' +
      'Without this invariant, every "bypass" is a write-it-yourself permission slip.',
  },
  {
    n: 2,
    name: 'No LLM in the verdict path',
    plain_english:
      'The verdict (PASS / FLAG / FAIL) is computed by a deterministic Node function ' +
      '(cli/lib/verdict.js, ~160 lines, fully unit-tested). Same inputs always produce ' +
      'the same output. No language model is ever asked "is this PR good?" — that would ' +
      'introduce non-determinism and an evaluator with its own failure mode.',
    why_it_matters:
      'This means the gate is auditable, reproducible, and Claude-skill-version-independent. ' +
      'You can read 140 lines of pure JavaScript and know exactly when the gate blocks.',
  },
  {
    n: 3,
    name: 'No required state lives only in the PR branch',
    plain_english:
      'Receipts (QA-RESULT.yml + QA-RESULT.md) persist as GitHub Actions workflow artifacts ' +
      'AND are posted as Check Run outputs — both server-side, immutable per run. The ' +
      'receipt is also committed to audits/<sha>/ on the protected branch after merge. ' +
      'fqe never depends on PR-branch files for gate decisions.',
    why_it_matters:
      'This prevents an attacker from manipulating a file in their own PR to forge a ' +
      'PASS receipt against a stale commit SHA.',
  },
];

const CONFIG_MAX_BYTES = 256 * 1024;  // 256 KB ceiling — sane config can't exceed this

/**
 * Read .fqe.yml (if present). Returns parsed config object or null on absence.
 * Hardened against symlink loops, binary blobs, and oversized files (reviewer-flagged).
 */
function readConfig(dir) {
  const cfgPath = path.join(dir, '.fqe.yml');
  try {
    // lstat (not stat) catches symlink loops by not following them — we then
    // refuse to read symlinks entirely. Real configs are regular files.
    const lst = fs.lstatSync(cfgPath, { throwIfNoEntry: false });
    if (!lst) return null;  // file doesn't exist
    if (lst.isSymbolicLink()) {
      return { path: cfgPath, parsed: null, raw: '', parse_error: '.fqe.yml is a symlink; refusing to follow' };
    }
    if (!lst.isFile()) {
      return { path: cfgPath, parsed: null, raw: '', parse_error: '.fqe.yml is not a regular file' };
    }
    if (lst.size > CONFIG_MAX_BYTES) {
      return { path: cfgPath, parsed: null, raw: '', parse_error: `.fqe.yml exceeds ${CONFIG_MAX_BYTES}-byte ceiling (got ${lst.size}); real configs are tiny` };
    }
    const text = fs.readFileSync(cfgPath, 'utf8');
    const { parseConfigYaml } = require('./orchestrator');
    try {
      return { path: cfgPath, parsed: parseConfigYaml(text), raw: text };
    } catch (err) {
      return { path: cfgPath, parsed: null, raw: text, parse_error: err.message };
    }
  } catch (err) {
    return { path: cfgPath, parsed: null, raw: '', parse_error: `${err.code || 'error'}: ${err.message}` };
  }
}

/**
 * Returns the explanation as structured data. CLI prints it; tests assert on it.
 *
 * @param {{dir?:string, format?:string}} opts
 * @returns {Object}
 */
function explain(opts = {}) {
  const dir = path.resolve(opts.dir || process.cwd());
  const config = readConfig(dir);
  const runnerCount = config && config.parsed && config.parsed.runners
    ? Object.keys(config.parsed.runners).length
    : 0;

  return {
    fqe_version: FQE_VERSION,
    cwd: dir,
    invariants: INVARIANTS,
    canonical_thresholds: BLAST_RADIUS_THRESHOLDS,
    config: {
      present: !!config,
      path: config ? config.path : path.join(dir, '.fqe.yml'),
      runner_count: runnerCount,
      runners: config && config.parsed && config.parsed.runners
        ? Object.keys(config.parsed.runners).map((name) => {
            const r = config.parsed.runners[name];
            return {
              name,
              required: r.required === true,
              always_run: r.always_run === true,
              when: r.when || [],
              command: r.command || '(none — runner will not execute; if required, the gate will FAIL)',
              args_count: (r.args || []).length,
            };
          })
        : [],
      parse_error: config ? config.parse_error : null,
    },
    sources: {
      public_repo: 'https://github.com/booyajones/fqe',
      tag: 'fqe-v0.7.0',
      verdict_source: 'cli/lib/verdict.js',
      audit_source: 'cli/lib/explain.js',                // this file (what you just ran)
      failure_explainer_source: 'cli/lib/explainer.js',  // renders fail/flag explanations
    },
    exit_code_taxonomy: {
      0: 'PASS — gate is green; merge can proceed',
      2: 'FAIL — policy violation; merge blocked',
      3: 'FLAG — informational; merge can proceed but a concern was raised',
      4: 'INFRA — fqe itself errored (e.g., GitHub API timeout); Check Run is neutral, never blocks',
      1: 'ERROR — unrecoverable script/CLI error before verdict; should be rare',
    },
  };
}

/**
 * Render the explain output as human-readable text (for terminal display).
 */
function renderExplainText(data) {
  const lines = [];
  lines.push(`fqe ${data.fqe_version} — Finexio Quality Engine`);
  lines.push(`https://github.com/booyajones/fqe`);
  lines.push('');
  lines.push(`Working directory: ${data.cwd}`);
  lines.push('');

  lines.push('─── ARCHITECTURAL INVARIANTS ───');
  lines.push('');
  for (const inv of data.invariants) {
    lines.push(`${inv.n}. ${inv.name}`);
    lines.push('');
    lines.push(`   ${inv.plain_english.replace(/\n/g, '\n   ')}`);
    lines.push('');
    lines.push(`   Why it matters: ${inv.why_it_matters.replace(/\n/g, '\n   ')}`);
    lines.push('');
  }

  lines.push('─── CANONICAL THRESHOLDS (Wilson 95% CI upper bound) ───');
  lines.push('');
  lines.push('These are LOCKED in cli/lib/verdict.js as Object.freeze\'d constants.');
  lines.push('Orchestrator can request a blast_radius class but cannot pass an arbitrary threshold.');
  lines.push('');
  for (const [klass, threshold] of Object.entries(data.canonical_thresholds)) {
    lines.push(`  ${klass.padEnd(28)} ≤ ${threshold}`);
  }
  lines.push('');

  lines.push('─── EXIT CODE TAXONOMY ───');
  lines.push('');
  for (const [code, meaning] of Object.entries(data.exit_code_taxonomy)) {
    lines.push(`  ${code}  ${meaning}`);
  }
  lines.push('');

  lines.push('─── THIS REPO\'S CONFIG (.fqe.yml) ───');
  lines.push('');
  if (!data.config.present) {
    lines.push(`  No .fqe.yml found at ${data.config.path}`);
    lines.push('  Run `fqe init` to bootstrap with a starter config.');
  } else if (data.config.parse_error) {
    lines.push(`  ${data.config.path}: PARSE ERROR`);
    lines.push(`  ${data.config.parse_error}`);
  } else if (data.config.runner_count === 0) {
    lines.push(`  ${data.config.path}: present but no runners configured.`);
    lines.push('  The gate will currently PASS every PR (no rules to enforce).');
    lines.push('  Add runners to .fqe.yml to start gating. See examples at:');
    lines.push('  https://github.com/booyajones/fqe/tree/main/examples');
  } else {
    lines.push(`  ${data.config.path}: ${data.config.runner_count} runner(s) configured`);
    lines.push('');
    for (const r of data.config.runners) {
      const flags = [
        r.required ? 'required' : 'optional',
        r.always_run ? 'always_run' : `when: [${r.when.join(', ')}]`,
      ].join(', ');
      lines.push(`    • ${r.name}  (${flags})`);
      lines.push(`        command: ${r.command}`);
    }
  }
  lines.push('');

  lines.push('─── WHERE TO LOOK ───');
  lines.push('');
  lines.push(`  Public source:      ${data.sources.public_repo}  (tag: ${data.sources.tag})`);
  lines.push(`  Verdict logic:      ${data.sources.verdict_source}`);
  lines.push(`  Audit source:       ${data.sources.audit_source}`);
  lines.push(`  Failure explainer:  ${data.sources.failure_explainer_source}`);
  lines.push('');
  lines.push('Run `fqe doctor` to validate your local environment.');
  lines.push('Run `fqe run --full --base origin/main --output ./out/` to dry-run the gate.');
  return lines.join('\n');
}

module.exports = { explain, renderExplainText, INVARIANTS, FQE_VERSION };
