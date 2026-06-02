'use strict';

/**
 * fqe shadow-trial scorecard (v0.18, A6/A13).
 *
 * The adoption question a skeptical team asks before making fqe a REQUIRED gate is: "if you
 * had run over our recent history, would you have lied to us?" The scorecard answers it from
 * the receipts fqe already emits (each run persists QA-RESULT.yml). Collect the last N runs'
 * receipts into a directory, run `fqe scorecard --dir <dir>`, and read the three metrics the
 * red-team named as the precondition for trusting a required gate:
 *
 *   1. false-red rate  (target ~0): the fraction of FAIL verdicts that were overridden by a
 *      human bypass. A bypassed FAIL is the operational signal of a red the team judged wrong.
 *   2. gate wall-time  (target small): p50/p95 of (finished_at - started_at). The "< X% of
 *      total CI" comparison needs the team's CI baseline, which is not in the receipt, so the
 *      scorecard reports the gate's own wall-time and leaves the ratio to the operator.
 *   3. true catches    (target >= 1): FAIL verdicts that were NOT bypassed (reds that stuck).
 *
 * Pure: no fs, no clock, no network. The caller reads + parses the receipts and passes them in.
 * This is a REPORT, not a gate: it never decides PASS/FAIL, so it has no fail-closed posture.
 */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function wallMs(r) {
  const a = Date.parse(r && r.started_at);
  const b = Date.parse(r && r.finished_at);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return b - a;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Aggregate a set of parsed receipts into a scorecard.
 * @param {object[]} receipts  parsed QA-RESULT objects (verdict, commit_sha, started_at,
 *                             finished_at, bypass, human_review, verdict_reasons)
 * @returns {object} the scorecard
 */
function aggregateScorecard(receipts) {
  const list = Array.isArray(receipts) ? receipts.filter((r) => r && typeof r === 'object') : [];
  const total = list.length;
  const byVerdict = { PASS: 0, FLAG: 0, FAIL: 0, OTHER: 0 };
  let bypassed = 0;
  let falseRedCandidates = 0; // FAIL verdicts that were bypassed (a human overrode the red)
  let trueCatches = 0;        // FAIL verdicts that stuck (no bypass)
  let humanMinutes = 0;
  const walls = [];
  let earliest = null;
  let latest = null;

  for (const r of list) {
    const v = ['PASS', 'FLAG', 'FAIL'].includes(r.verdict) ? r.verdict : 'OTHER';
    byVerdict[v]++;
    const hasBypass = r.bypass != null && typeof r.bypass === 'object';
    if (hasBypass) bypassed++;
    if (v === 'FAIL') {
      if (hasBypass) falseRedCandidates++; else trueCatches++;
    }
    if (r.human_review && num(r.human_review.estimated_minutes) != null) {
      humanMinutes += r.human_review.estimated_minutes;
    }
    const w = wallMs(r);
    if (w != null) walls.push(w);
    const startMs = Date.parse(r.started_at);
    if (!Number.isNaN(startMs) && (earliest === null || startMs < earliest)) earliest = startMs;
    const finMs = Date.parse(r.finished_at);
    if (!Number.isNaN(finMs) && (latest === null || finMs > latest)) latest = finMs;
  }

  walls.sort((a, b) => a - b);
  const failTotal = byVerdict.FAIL;
  const round = (n) => Math.round(n * 10000) / 10000;

  return {
    total_runs: total,
    by_verdict: byVerdict,
    flag_rate: total ? round(byVerdict.FLAG / total) : 0,
    fail_rate: total ? round(byVerdict.FAIL / total) : 0,
    bypassed_runs: bypassed,
    // The three adoption metrics:
    false_red: {
      candidates: falseRedCandidates,
      of_fails: failTotal,
      // null (not 0) when there were no FAILs: a zero-FAIL sample cannot show a 0% false-red
      // rate, or a team would read "all good" and promote the gate to required prematurely.
      rate: failTotal ? round(falseRedCandidates / failTotal) : null,
      note: failTotal
        ? 'a bypassed FAIL is the operational signal of a possibly-wrong red; target ~0'
        : 'no FAILs in this sample; false-red rate cannot be computed yet',
    },
    gate_wall_ms: {
      p50: percentile(walls, 50),
      p95: percentile(walls, 95),
      max: walls.length ? walls[walls.length - 1] : null,
      samples: walls.length,
      note: 'gate runtime only; compare to your total CI time for the < X% target',
    },
    true_catches: trueCatches, // reds that stuck (caught a real problem); target >= 1
    human_review_minutes_total: round(humanMinutes),
    window: {
      from: earliest != null ? new Date(earliest).toISOString() : null,
      to: latest != null ? new Date(latest).toISOString() : null,
    },
  };
}

/** Render the scorecard as a short human-readable report. */
function renderScorecard(s) {
  const ms = (x) => (x == null ? 'n/a' : `${(x / 1000).toFixed(1)}s`);
  const lines = [];
  lines.push('# fqe shadow-trial scorecard');
  lines.push('');
  lines.push(`Runs analyzed: ${s.total_runs}  (window ${s.window.from || 'n/a'} -> ${s.window.to || 'n/a'})`);
  lines.push(`Verdicts: PASS ${s.by_verdict.PASS}  FLAG ${s.by_verdict.FLAG}  FAIL ${s.by_verdict.FAIL}` +
    (s.by_verdict.OTHER ? `  OTHER ${s.by_verdict.OTHER}` : ''));
  lines.push('');
  lines.push('## The three adoption metrics');
  const frPct = s.false_red.rate == null ? 'n/a (no FAILs in sample)' : `${(s.false_red.rate * 100).toFixed(1)}%`;
  lines.push(`1. false-red rate: ${frPct}  (${s.false_red.candidates} bypassed of ${s.false_red.of_fails} FAILs) -- target ~0%`);
  lines.push(`2. gate wall-time: p50 ${ms(s.gate_wall_ms.p50)}, p95 ${ms(s.gate_wall_ms.p95)}, max ${ms(s.gate_wall_ms.max)} (n=${s.gate_wall_ms.samples})`);
  lines.push(`3. true catches: ${s.true_catches} real FAIL(s) that stuck -- target >= 1`);
  lines.push('');
  lines.push(`Bypassed runs: ${s.bypassed_runs}   Human-review minutes (modeled): ${s.human_review_minutes_total}`);
  return lines.join('\n');
}

module.exports = { aggregateScorecard, renderScorecard };
