'use strict';

/**
 * fqe coverage ratchet.
 *
 * Two rules, both enforced deterministically (no LLM, like the rest of fqe):
 *
 *   1. PATCH RULE: the changed/new lines in this PR must hit a minimum
 *      coverage (default 80%). New code arrives tested.
 *   2. RATCHET RULE: total project coverage may never fall below the
 *      committed baseline (minus a small float tolerance). Coverage can
 *      only ever go up or hold; it can never silently slide.
 *
 * The baseline lives in a committed file (default coverage-baseline.json):
 *   { "total": 73.41 }
 * On a PR that raises total coverage, the ratchet reports shouldBumpBaseline
 * so a post-merge step can write the new, higher number back.
 *
 * This file is pure logic + format parsers. No I/O of its own beyond the
 * parser helpers that take raw report text. Table-driven unit tested.
 */

const TOLERANCE = 0.01; // absolute percentage points; absorbs float noise

/**
 * Evaluate the ratchet.
 * @param {object} o
 * @param {number} o.currentTotal   total coverage % now (0-100)
 * @param {number|null} o.baselineTotal  committed baseline %; null = first run
 * @param {number|null} o.patchCoverage  coverage % of changed lines; null = unknown/skip
 * @param {number} [o.patchThreshold=80]  minimum patch coverage %
 * @param {number} [o.tolerance=0.01]     float tolerance for the drop check
 * @returns {{ pass: boolean, reasons: string[], shouldBumpBaseline: boolean,
 *             newBaseline: number|null }}
 */
function evaluateRatchet(o) {
  const {
    currentTotal,
    baselineTotal,
    patchCoverage = null,
    patchThreshold = 80,
    tolerance = TOLERANCE,
  } = o || {};

  const reasons = [];

  if (typeof currentTotal !== 'number' || Number.isNaN(currentTotal)) {
    return {
      pass: false,
      reasons: ['COVERAGE_REPORT_UNREADABLE: no numeric total coverage was parsed'],
      shouldBumpBaseline: false,
      newBaseline: null,
    };
  }

  // RATCHET RULE: total may not drop below baseline (minus tolerance).
  if (typeof baselineTotal === 'number' && !Number.isNaN(baselineTotal)) {
    if (currentTotal < baselineTotal - tolerance) {
      reasons.push(
        `COVERAGE_RATCHET_DROP: total coverage fell to ${currentTotal.toFixed(2)}% ` +
        `from baseline ${baselineTotal.toFixed(2)}% (drop of ` +
        `${(baselineTotal - currentTotal).toFixed(2)} points). Add tests for the ` +
        `lines this change left uncovered, or justify in the PR.`
      );
    }
  }

  // PATCH RULE: changed lines must clear the threshold.
  if (typeof patchCoverage === 'number' && !Number.isNaN(patchCoverage)) {
    if (patchCoverage < patchThreshold - tolerance) {
      reasons.push(
        `COVERAGE_PATCH_LOW: changed lines are only ${patchCoverage.toFixed(2)}% ` +
        `covered, below the ${patchThreshold}% required for new code. ` +
        `Cover the new/changed lines before merging.`
      );
    }
  }

  const pass = reasons.length === 0;
  // Only bump when we PASS and genuinely improved past the baseline.
  const improved =
    typeof baselineTotal === 'number'
      ? currentTotal > baselineTotal + tolerance
      : true; // first run establishes the baseline
  const shouldBumpBaseline = pass && improved;
  const newBaseline = shouldBumpBaseline ? round2(currentTotal) : null;

  return { pass, reasons, shouldBumpBaseline, newBaseline };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Coverage report parsers ────────────────────────────────────────────────
// Each returns a total line-coverage percentage (0-100) or null if unparseable.

/**
 * Vitest / Istanbul json-summary: { total: { lines: { pct: 87.5 } } }
 * Also handles coverage-final style by falling back to .total.
 */
function parseJsonSummary(text) {
  try {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    const pct = j?.total?.lines?.pct;
    return typeof pct === 'number' ? pct : null;
  } catch {
    return null;
  }
}

/**
 * coverage.py json: { totals: { percent_covered: 73.4 } }
 */
function parseCoveragePyJson(text) {
  try {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    const pct = j?.totals?.percent_covered;
    return typeof pct === 'number' ? pct : null;
  } catch {
    return null;
  }
}

/**
 * Cobertura XML: <coverage line-rate="0.7341" ...> -> 73.41
 */
function parseCobertura(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/line-rate="([0-9]*\.?[0-9]+)"/);
  if (!m) return null;
  const rate = parseFloat(m[1]);
  return Number.isNaN(rate) ? null : round2(rate * 100);
}

/**
 * lcov.info: count LF (lines found) and LH (lines hit) records, sum, ratio.
 */
function parseLcov(text) {
  if (typeof text !== 'string') return null;
  let found = 0;
  let hit = 0;
  for (const line of text.split(/\r?\n/)) {
    // M2 (v0.17): a malformed LF/LH payload (e.g. `LH:xyz`) must mark the report UNREADABLE
    // (return null -> the CLI fails closed as COVERAGE_REPORT_UNREADABLE), not silently coerce
    // to 0 via `|| 0`, which would fabricate a confident wrong number from a garbled report.
    if (line.startsWith('LF:')) {
      const n = parseInt(line.slice(3), 10);
      if (!Number.isInteger(n) || n < 0) return null;
      found += n;
    } else if (line.startsWith('LH:')) {
      const n = parseInt(line.slice(3), 10);
      if (!Number.isInteger(n) || n < 0) return null;
      hit += n;
    }
  }
  if (found === 0) return null;
  return round2((hit / found) * 100);
}

/**
 * Best-effort auto-detect by content sniffing. Returns total % or null.
 */
function parseCoverage(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (s.startsWith('<')) return parseCobertura(s);
  if (s.startsWith('{')) {
    return parseJsonSummary(s) ?? parseCoveragePyJson(s);
  }
  if (s.includes('LF:') || s.includes('LH:')) return parseLcov(s);
  return null;
}

module.exports = {
  evaluateRatchet,
  parseCoverage,
  parseJsonSummary,
  parseCoveragePyJson,
  parseCobertura,
  parseLcov,
  TOLERANCE,
};
