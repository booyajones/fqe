'use strict';

/**
 * fqe oracle-guard — catch a PR that edits its own oracle.
 *
 * The mutation gate proves a test is strong. It does NOT catch the move where
 * the change weakens the thing it is graded against: regenerating a golden
 * master so a regression looks correct, re-recording a partner cassette to
 * match broken output, lowering the coverage baseline, or editing .fqe.yml to
 * drop a runner. An agent (or a person in a hurry) can make a red PR green by
 * changing the answer key instead of the code.
 *
 * This guard reads the PR diff and raises a signal when the diff touches the
 * recorded ground truth or the grading rules. The fqe-second-approve workflow
 * consumes that signal to require a second human. A deterministic gate cannot
 * force a GitHub reviewer by itself, so the division of labor is: oracle-guard
 * DETECTS, the workflow ENFORCES.
 *
 * Two triggers, both tuned for high signal and low false-positive:
 *   1. GROUND TRUTH / RULES touched: golden masters, snapshots, recorded
 *      cassettes, fixtures, seeds, .fqe.yml, coverage-baseline.json, the
 *      mutation config, the bypass/reviewer allowlists. These are rarely
 *      changed and high-stakes, so any change to them needs a second look.
 *   2. TEST CO-CHANGE (only with includeTests): a test file changed in the
 *      same PR as a non-test source file. A pure test-only PR is frictionless
 *      (you want people adding tests); the dangerous combo is editing the
 *      test that grades the code you are changing in the same breath.
 *
 * Pure, dependency-free in the evaluate path, no LLM. Same diff -> same signal.
 */

const { fileMatches } = require('./orchestrator');

// Recorded ground truth and grading rules. A change here always needs a second
// reviewer. The `**/` prefix matches both top-level and nested paths.
const DEFAULT_ORACLE_PATTERNS = Object.freeze([
  // grading rules: the config a PR is judged by
  '**/.fqe.yml',
  '**/stryker.conf.json',
  '**/coverage-baseline.json',
  '**/fqe-bypass-allowlist.yml',
  '**/fqe-second-reviewers.yml',
  // recorded ground truth: the "correct answers"
  '**/__approved__/**',
  '**/*.approved.*',
  '**/*.received.*',   // ApprovalTests "received" output
  '**/*.expected',     // common golden naming
  '**/*.expected.*',
  '**/*.frozen',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/cassettes/**',
  '**/*.cassette.*',
  '**/vcr/**',
  '**/fixtures/**',
  '**/testdata/**',
  '**/seeds/**',
  '**/*.golden',
  '**/*.golden.*',
]);

// Test files. Only used when includeTests is set, and only triggers when a
// source file changed too (so pure test PRs are not penalized).
const DEFAULT_TEST_PATTERNS = Object.freeze([
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/test_*.py',
  '**/*_test.py',
]);

// Files that are neither oracle nor test nor docs count as "source" for the
// co-change rule. Docs are excluded so a README tweak does not look like a
// code change hiding behind a test edit.
const NON_SOURCE_PATTERNS = ['**/*.md', '**/*.markdown', '**/*.txt', '**/LICENSE'];

function matchAny(file, patterns) {
  // M1 (v0.17): match case-INSENSITIVELY. Oracle/golden/config names (.fqe.yml, *.golden,
  // coverage-baseline.json) are fixed, and on a case-insensitive filesystem (macOS, Windows)
  // a case-variant rename (.FQE.YML, *.GOLDEN) is the SAME file but evaded the tamper guard,
  // letting a grading-oracle edit self-approve. Lowercasing both closes that.
  const lf = String(file).toLowerCase();
  return patterns.some((p) => fileMatches(lf, String(p).toLowerCase()));
}

/**
 * @param {object} o
 * @param {string[]} o.files            changed file paths (forward slashes)
 * @param {boolean} [o.includeTests=false]
 * @param {string[]} [o.oraclePatterns]
 * @param {string[]} [o.testPatterns]
 * @returns {{ requires_second_review: boolean, tampered: boolean,
 *             oracle_files: string[], test_files: string[],
 *             source_files: string[], reasons: string[] }}
 */
function evaluateOracleGuard(o) {
  const files = (o && Array.isArray(o.files) ? o.files : []).map(normalize);
  const includeTests = !!(o && o.includeTests);
  const oraclePatterns = (o && o.oraclePatterns) || DEFAULT_ORACLE_PATTERNS;
  const testPatterns = (o && o.testPatterns) || DEFAULT_TEST_PATTERNS;

  const oracle_files = files.filter((f) => matchAny(f, oraclePatterns));
  const oracleSet = new Set(oracle_files);
  const test_files = includeTests
    ? files.filter((f) => !oracleSet.has(f) && matchAny(f, testPatterns))
    : [];
  const testSet = new Set(test_files);
  const source_files = files.filter(
    (f) => !oracleSet.has(f) && !testSet.has(f) && !matchAny(f, NON_SOURCE_PATTERNS)
  );

  const groundTruthTouched = oracle_files.length > 0;
  const testCoChange = includeTests && test_files.length > 0 && source_files.length > 0;
  const requires_second_review = groundTruthTouched || testCoChange;

  const reasons = [];
  if (groundTruthTouched) {
    const preview = oracle_files.slice(0, 5).join(', ') + (oracle_files.length > 5 ? ', ...' : '');
    reasons.push(
      `ORACLE_GROUND_TRUTH_CHANGED: this PR edits ${oracle_files.length} file(s) that are the ` +
      `recorded ground truth or the grading rules it is judged by (${preview}). ` +
      `A second reviewer must approve, because a self-approved change here can make a regression look correct.`
    );
  }
  if (testCoChange) {
    reasons.push(
      `ORACLE_TEST_CO_CHANGE: this PR changes ${test_files.length} test file(s) and ` +
      `${source_files.length} source file(s) together. A weakened assertion can make a broken ` +
      `change pass green, so a second reviewer must approve.`
    );
  }

  return {
    requires_second_review,
    tampered: requires_second_review,
    oracle_files,
    test_files,
    source_files,
    reasons,
  };
}

/**
 * Resolve the changed-file list from (in order): an explicit list, the
 * FQE_CHANGED_FILES env var, or `git diff`.
 *
 * Returns { ok, files, source, reason }. CRITICAL: `ok` distinguishes "git ran
 * and the diff is genuinely empty" (ok:true, files:[]) from "could not read the
 * diff at all" (ok:false). A security guard must fail CLOSED on the second case:
 * if it cannot see the diff, it must not report "clean". The caller turns
 * ok:false into requires_second_review, never into a pass.
 * @returns {{ ok: boolean, files: string[], source: string, reason?: string }}
 */
function resolveChangedFiles(o) {
  o = o || {};
  if (typeof o.changed === 'string' && o.changed.trim() !== '') {
    return { ok: true, files: o.changed.split(/[\s,]+/).filter(Boolean).map(normalize), source: 'changed' };
  }
  if (process.env.FQE_CHANGED_FILES) {
    return { ok: true, files: process.env.FQE_CHANGED_FILES.split(/[\s,]+/).filter(Boolean).map(normalize), source: 'env' };
  }
  const { spawnSync } = require('node:child_process');
  const args =
    o.baseSha && o.headSha
      ? ['diff', '--name-only', `${o.baseSha}..${o.headSha}`]
      : ['diff', '--name-only', 'HEAD~1', 'HEAD'];
  const r = spawnSync('git', args, { cwd: o.repoDir || process.cwd(), encoding: 'utf8' });
  if (r.error || typeof r.status !== 'number' || r.status !== 0) {
    const why = r.error ? r.error.code || r.error.message : `exit ${r.status}`;
    return { ok: false, files: [], source: 'git', reason: `git ${args.join(' ')} failed (${why})` };
  }
  return { ok: true, files: r.stdout.split('\n').filter(Boolean).map(normalize), source: 'git' };
}

/**
 * Thin wrapper returning just the file list (back-compat). Prefer
 * resolveChangedFiles in fail-closed call paths, because this drops the `ok`
 * flag and cannot tell "empty diff" from "could not read the diff".
 */
function getChangedFiles(o) {
  return resolveChangedFiles(o).files;
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

module.exports = {
  evaluateOracleGuard,
  resolveChangedFiles,
  getChangedFiles,
  DEFAULT_ORACLE_PATTERNS,
  DEFAULT_TEST_PATTERNS,
};
