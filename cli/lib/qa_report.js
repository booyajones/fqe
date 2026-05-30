'use strict';

/**
 * fqe QA scorecard — the "single pane of glass" over a parsed receipt.
 *
 * The verdict (verdict.js) answers "does this merge?". The scorecard answers
 * "what did QA actually cover, and where are the gaps?". It is the human-facing
 * roll-up: results grouped by test class, policy coverage, and a plain-English
 * list of any required-class gaps.
 *
 * DETERMINISTIC + PURE + NO LLM, same as the rest of fqe. The CORE
 * (buildQaReport) is a pure function over a PARSED receipt object — no file I/O,
 * no clock, no randomness. The CLI reads QA-RESULT.yml; this module never does.
 *
 * Fail-closed on a malformed receipt: a report that cannot be trusted is no
 * report at all, so we throw rather than emit a misleading empty scorecard.
 */

const { KNOWN_CLASSES } = require('./verdict');

const UNCLASSIFIED = 'unclassified';

/**
 * A runner "passed" iff it actually ran AND reported a numeric exit_code of 0.
 * This mirrors verdict.js Pass 2 exactly: a missing / NaN / non-zero exit_code
 * is NOT a pass. Kept as a single predicate so the scorecard and the verdict
 * can never silently disagree about what "passed" means.
 *
 * @param {Object} r - a runner record
 * @returns {boolean}
 */
function runnerPassed(r) {
  return !!r &&
    r.ran === true &&
    typeof r.exit_code === 'number' &&
    !Number.isNaN(r.exit_code) &&
    r.exit_code === 0;
}

/**
 * Did this runner actually run (regardless of outcome)?
 * @param {Object} r
 * @returns {boolean}
 */
function runnerRan(r) {
  return !!r && r.ran === true;
}

/**
 * Build the QA scorecard from a PARSED receipt object. PURE.
 *
 * @param {Object} receipt - a receipt parsed by receipt.parseReceiptYaml
 * @returns {{
 *   verdict: string,
 *   commit_sha: string|null,
 *   by_class: Object<string,{runners:string[], ran:number, passed:number,
 *                            failed:number, not_run:number, status:string}>,
 *   required_classes: string[],
 *   required_class_status: Object<string,'covered'|'GAP'>,
 *   gaps: string[],
 *   totals: { runners:number, passed:number, failed:number, not_run:number },
 *   adversarial: Array<{runner:string, blast_radius:(string|null), ci_upper:(number|null)}>,
 * }}
 */
function buildQaReport(receipt) {
  // Fail closed: a non-object, or one without the runners array, is not a
  // receipt we can score. Throw rather than emit a misleading empty scorecard.
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('buildQaReport: receipt must be an object');
  }
  if (!Array.isArray(receipt.runners)) {
    throw new Error('buildQaReport: receipt.runners must be an array');
  }

  // ── Group runners by class ────────────────────────────────────────────
  // A runner with no class (absent / empty / non-string) goes under
  // 'unclassified'. We do NOT invent classes that aren't present; only
  // classes that actually appear among the runners get a by_class entry.
  const by_class = {};
  for (const r of receipt.runners) {
    if (!r || typeof r !== 'object') {
      throw new Error('buildQaReport: every runner must be an object');
    }
    const cls = (typeof r.class === 'string' && r.class !== '') ? r.class : UNCLASSIFIED;
    if (!by_class[cls]) {
      by_class[cls] = { runners: [], ran: 0, passed: 0, failed: 0, not_run: 0, status: 'not-run' };
    }
    const bucket = by_class[cls];
    bucket.runners.push(typeof r.name === 'string' ? r.name : String(r.name));
    if (runnerRan(r)) {
      bucket.ran += 1;
      if (runnerPassed(r)) bucket.passed += 1;
      else bucket.failed += 1;
    } else {
      bucket.not_run += 1;
    }
  }

  // Derive per-class status from the tallies.
  //   'fail'    if any runner of the class ran and failed
  //   'pass'    if >=1 ran and none failed (every run was a pass)
  //   'not-run' if no runner of the class ran at all
  for (const cls of Object.keys(by_class)) {
    const b = by_class[cls];
    if (b.failed > 0) b.status = 'fail';
    else if (b.ran > 0) b.status = 'pass';
    else b.status = 'not-run';
  }

  // ── Policy coverage ───────────────────────────────────────────────────
  // For each policy-required class, it is 'covered' iff >=1 runner of that
  // class ran AND passed. Anything less is a 'GAP'. This is the scorecard
  // view of verdict.js Pass 5 (required test classes). Fail closed: a class
  // with no runner at all is a GAP, not silently covered.
  const required_classes = Array.isArray(receipt.required_classes)
    ? receipt.required_classes.slice()
    : [];
  // A required class that is not in the canonical KNOWN_CLASSES taxonomy is
  // almost certainly a typo (e.g. "mony"). No runner can ever satisfy it, so a
  // plain GAP would be a phantom permanent failure that an operator can't tell
  // apart from a real coverage gap. Tag it distinctly so the typo is obvious.
  const knownSet = new Set(KNOWN_CLASSES);
  const required_class_status = {};
  const gaps = [];
  for (const cls of required_classes) {
    if (!knownSet.has(cls)) {
      required_class_status[cls] = 'UNKNOWN-CLASS';
      gaps.push(`class "${cls}" is required but is not a known test class (typo?)`);
      continue;
    }
    const covered = receipt.runners.some((r) => r && r.class === cls && runnerPassed(r));
    if (covered) {
      required_class_status[cls] = 'covered';
    } else {
      required_class_status[cls] = 'GAP';
      gaps.push(`class "${cls}" is required by policy but has no passing runner`);
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────
  const totals = { runners: 0, passed: 0, failed: 0, not_run: 0 };
  for (const r of receipt.runners) {
    totals.runners += 1;
    if (runnerRan(r)) {
      if (runnerPassed(r)) totals.passed += 1;
      else totals.failed += 1;
    } else {
      totals.not_run += 1;
    }
  }

  // ── Adversarial summary ───────────────────────────────────────────────
  // A compact pass-through: just enough to surface statistical risk on the
  // scorecard. Empty array when the receipt carries no adversarial_stats.
  // A stat with a missing/invalid runner name is labeled '(unknown runner)'
  // rather than rendering the literal string 'undefined', so an operator can
  // see the entry is malformed instead of mistaking it for a runner named
  // "undefined".
  const adversarial = Array.isArray(receipt.adversarial_stats)
    ? receipt.adversarial_stats.map((s) => ({
        runner: s && typeof s.runner === 'string' && s.runner !== '' ? s.runner : '(unknown runner)',
        blast_radius: s && typeof s.blast_radius === 'string' ? s.blast_radius : null,
        ci_upper: s && Array.isArray(s.ci_95) && typeof s.ci_95[1] === 'number' ? s.ci_95[1] : null,
      }))
    : [];

  return {
    verdict: receipt.verdict,
    commit_sha: typeof receipt.commit_sha === 'string' ? receipt.commit_sha : null,
    by_class,
    required_classes,
    required_class_status,
    gaps,
    totals,
    adversarial,
  };
}

/**
 * Render a report (from buildQaReport) as a clean ASCII scorecard.
 * Human-readable, no em-dashes, no color codes — pipes through any terminal
 * or a GitHub Actions log.
 *
 * @param {Object} report - the object returned by buildQaReport
 * @returns {string}
 */
function renderQaReport(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('renderQaReport: report must be an object');
  }
  const lines = [];

  // Header
  lines.push('QA SCORECARD');
  lines.push(`Overall verdict: ${report.verdict}`);
  if (report.commit_sha) {
    lines.push(`Commit: ${report.commit_sha}`);
  }
  const t = report.totals || { runners: 0, passed: 0, failed: 0, not_run: 0 };
  lines.push(`Runners: ${t.runners} total, ${t.passed} passed, ${t.failed} failed, ${t.not_run} not run`);
  lines.push('');

  // Per-class table. Deterministic order: KNOWN_CLASSES first (in canonical
  // order), then any remaining classes (e.g. 'unclassified') sorted, so the
  // same receipt always renders identically.
  const classNames = Object.keys(report.by_class || {});
  const known = KNOWN_CLASSES.filter((c) => classNames.includes(c));
  const extra = classNames.filter((c) => !KNOWN_CLASSES.includes(c)).sort();
  const ordered = [...known, ...extra];

  const header = ['Class', 'Ran', 'Passed', 'Failed', 'Status'];
  const rows = ordered.map((cls) => {
    const b = report.by_class[cls];
    return [cls, String(b.ran), String(b.passed), String(b.failed), b.status];
  });

  // Compute column widths for clean alignment.
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length), 0)
  );
  const fmtRow = (cells) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';

  lines.push(fmtRow(header));
  lines.push(sep);
  if (rows.length === 0) {
    lines.push('(no runners)');
  } else {
    for (const row of rows) lines.push(fmtRow(row));
  }
  lines.push('');

  // Policy-required classes section.
  lines.push('Policy-required classes:');
  if (!report.required_classes || report.required_classes.length === 0) {
    lines.push('  (none required by policy)');
  } else {
    for (const cls of report.required_classes) {
      const status = report.required_class_status[cls] || 'GAP';
      lines.push(`  ${cls}: ${status}`);
    }
  }

  // Gaps section (only if any).
  if (report.gaps && report.gaps.length > 0) {
    lines.push('');
    lines.push('GAPS:');
    for (const g of report.gaps) {
      lines.push(`  - ${g}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  buildQaReport,
  renderQaReport,
  runnerPassed,
  UNCLASSIFIED,
};
