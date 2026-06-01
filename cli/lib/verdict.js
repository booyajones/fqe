'use strict';

/**
 * fqe verdict computation — DETERMINISTIC + FAIL-CLOSED.
 *
 * Architectural invariant #2 from PLAN-v6:
 *   "No LLM is in the verdict path."
 *
 * Beyond that, this file is now hardened against orchestrator misconfiguration
 * (real fatal flaw caught by gauntlet 11f7fb 2026-05-23):
 *   - blast_radius thresholds are CANONICAL constants below — caller cannot
 *     pass an arbitrary threshold to absorb a high attack rate
 *   - missing / wrong-type exit_code is treated as FAIL, not silent PASS
 *   - unknown blast_radius class is treated as FAIL
 *
 * Same inputs -> same output. No I/O, no clock, no randomness.
 * Table-driven unit tests live in test/verdict.test.js.
 */

const PASS = 'PASS';
const FLAG = 'FLAG';
const FAIL = 'FAIL';

/**
 * Canonical Wilson 95% CI upper-bound thresholds per blast radius.
 * These are POLICY, locked here. Orchestrator selects a class by name;
 * it cannot inflate the threshold to absorb a failing run.
 *
 * Sourced from PLAN-v6 Section 1, supported by the eval-lead council voice
 * (Anthropic frontier-team), and consistent with Sonnet 4.5 system card bars.
 */
const BLAST_RADIUS_THRESHOLDS = Object.freeze({
  'outbound':                    0.05,
  'mcp-read':                    0.03,
  'mcp-write-or-financial':      0.01,
  // any other class name -> hard FAIL (unknown class)
});

/**
 * Blast classes whose threshold breach is a hard FAIL (blocks the merge), not
 * an advisory FLAG. A statistical breach on money/state code is not a "heads
 * up" — it blocks. Looser classes (outbound copy, reads) stay FLAG.
 * (Closes the council's "FLAG is advisory theater" finding, 2026-05-29.)
 */
const BLAST_RADIUS_BLOCKS = Object.freeze(new Set(['mcp-write-or-financial']));

/**
 * Canonical test-class taxonomy. A runner may declare a `class` so the gate can
 * (a) require a class to have a passing runner before merge (full-suite policy),
 * and (b) report results grouped by class (the QA scorecard). This is POLICY:
 * the set is locked here so a typo'd class silently slips past nobody.
 *
 *   unit         a single function/module in isolation
 *   integration  multiple units together (db, http, fs)
 *   e2e          a full user flow through the running system
 *   regression   characterization / golden-master: output must not drift
 *   contract     a partner/provider API contract holds
 *   property     property-based / invariant checks
 *   uat          user-acceptance: an acceptance criterion is satisfied
 *   lint         static style / formatting
 *   type         static type check
 *   mutation     mutation-testing bouncer (tests actually catch bugs)
 *   spec-mutation spec-mutation bouncer (tests anchored to the requirement, not tautologies)
 *   coverage     coverage ratchet
 *   security     security/SAST/secret scan
 *   money        money-path correctness (balances, idempotency, reconciliation)
 */
const KNOWN_CLASSES = Object.freeze([
  'unit', 'integration', 'e2e', 'regression', 'contract', 'property',
  'uat', 'lint', 'type', 'mutation', 'spec-mutation', 'coverage', 'security', 'money',
]);

/**
 * @typedef {Object} RunnerResult
 * @property {string}  name
 * @property {boolean} required
 * @property {boolean} ran
 * @property {number}  exit_code      // required when ran === true
 * @property {string=} class          // one of KNOWN_CLASSES (optional)
 *
 * @typedef {Object} AdversarialStat
 * @property {string} runner
 * @property {number} n
 * @property {number} successes
 * @property {[number, number]} ci_95
 * @property {string} blast_radius    // MUST be a key in BLAST_RADIUS_THRESHOLDS
 *
 * @typedef {Object} VerdictInput
 * @property {RunnerResult[]} runners
 * @property {AdversarialStat[]=} adversarial_stats
 * @property {string[]=} require_stats_for  // runner names that MUST emit a stat,
 *                                           // else FAIL (fail closed on dropped stats)
 * @property {string[]=} require_classes    // test classes that MUST each have a
 *                                           // ran-and-passed runner, else FAIL
 *                                           // (the full-suite policy; fail closed)
 *
 * @typedef {Object} VerdictOutput
 * @property {'PASS'|'FLAG'|'FAIL'} verdict
 * @property {string[]} reasons
 */

/**
 * Compute the verdict. Fail-closed on any ambiguity.
 * @param {VerdictInput} input
 * @returns {VerdictOutput}
 */
function computeVerdict(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('verdict: input must be an object');
  }
  if (!Array.isArray(input.runners)) {
    throw new Error('verdict: input.runners must be an array');
  }

  const reasons = [];
  let hasFail = false;
  let hasFlag = false;

  // Pass 1: required runners that didn't run -> FAIL
  for (const r of input.runners) {
    if (!r || typeof r.name !== 'string') {
      throw new Error('verdict: runner missing name');
    }
    if (r.required === true && r.ran !== true) {
      hasFail = true;
      reasons.push(`required runner "${r.name}" did not run`);
    }
  }

  // Pass 2: any runner that ran -> exit_code MUST be a number equal to 0
  // for PASS. Anything else (non-number, undefined, NaN, non-zero) is FAIL.
  // This is the fail-closed fix for "silent PASS on missing exit_code"
  // (gauntlet 11f7fb fatal flaw #4).
  for (const r of input.runners) {
    if (r.ran === true) {
      if (typeof r.exit_code !== 'number' || Number.isNaN(r.exit_code)) {
        hasFail = true;
        reasons.push(`runner "${r.name}" ran but exit_code is not a number (got ${JSON.stringify(r.exit_code)})`);
      } else if (r.exit_code !== 0) {
        hasFail = true;
        reasons.push(`runner "${r.name}" exited ${r.exit_code}`);
      }
    }
  }

  // Pass 3: adversarial CI upper exceeds CANONICAL threshold -> FLAG
  // (only matters if no FAIL).
  const stats = input.adversarial_stats || [];
  for (const s of stats) {
    if (!s || typeof s.runner !== 'string' || !Array.isArray(s.ci_95)) {
      throw new Error('verdict: adversarial stat malformed');
    }
    if (s.ci_95.length !== 2 || typeof s.ci_95[0] !== 'number' || typeof s.ci_95[1] !== 'number') {
      throw new Error(`verdict: ci_95 for ${s.runner} must be [lo:number, hi:number]`);
    }
    if (s.ci_95[0] > s.ci_95[1]) {
      throw new Error(`verdict: ci_95 inverted for ${s.runner}: [${s.ci_95[0]}, ${s.ci_95[1]}]`);
    }

    // Threshold comes from CANONICAL map keyed by blast_radius.
    // Orchestrator can request a class but cannot pass an arbitrary threshold.
    if (typeof s.blast_radius !== 'string') {
      hasFail = true;
      reasons.push(`adversarial stat for "${s.runner}" missing blast_radius`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(BLAST_RADIUS_THRESHOLDS, s.blast_radius)) {
      hasFail = true;
      reasons.push(`adversarial stat for "${s.runner}" has unknown blast_radius "${s.blast_radius}"; known classes: ${Object.keys(BLAST_RADIUS_THRESHOLDS).join(', ')}`);
      continue;
    }
    const threshold = BLAST_RADIUS_THRESHOLDS[s.blast_radius];
    const ciUpper = s.ci_95[1];
    if (ciUpper > threshold) {
      const msg = `Wilson CI upper ${ciUpper.toFixed(4)} exceeds canonical threshold ${threshold.toFixed(4)} for blast_radius=${s.blast_radius} on runner=${s.runner}`;
      if (BLAST_RADIUS_BLOCKS.has(s.blast_radius)) {
        hasFail = true; // money/state breach blocks; it is not advisory
        reasons.push(`BLOCKED (money/state breach): ${msg}`);
      } else {
        hasFlag = true;
        reasons.push(msg);
      }
    }
  }

  // Pass 4: fail closed on a dropped stats payload. If the caller declares that
  // certain runners MUST emit adversarial_stats (because they carry a blast
  // class), and none are present, that is FAIL — a compromised or misconfigured
  // orchestrator cannot pass by simply omitting the stats array.
  // (Closes the council's "fails open if adversarial_stats omitted" finding.)
  const requireStatsFor = Array.isArray(input.require_stats_for) ? input.require_stats_for : [];
  if (requireStatsFor.length > 0) {
    const runnersWithStats = new Set(stats.map((s) => s && s.runner));
    for (const name of requireStatsFor) {
      if (!runnersWithStats.has(name)) {
        hasFail = true;
        reasons.push(`runner "${name}" must emit adversarial_stats but none were present (failing closed: a dropped stats payload cannot pass)`);
      }
    }
  }

  // Pass 5: required test classes must each have a ran-and-passed runner. This
  // is the full-suite policy. If the team declares (statically via
  // policy.require_classes, or dynamically because a payments path changed) that
  // a class must be covered, and no runner of that class ran AND passed, that is
  // a FAIL. It catches the gap a QA function exists to catch: "you changed money
  // code but shipped no passing money test." Fail closed — a class with no
  // runner at all cannot satisfy the requirement.
  const requireClasses = Array.isArray(input.require_classes) ? input.require_classes : [];
  if (requireClasses.length > 0) {
    for (const cls of requireClasses) {
      const hasPassing = input.runners.some((r) =>
        r && r.class === cls && r.ran === true &&
        typeof r.exit_code === 'number' && !Number.isNaN(r.exit_code) && r.exit_code === 0
      );
      if (!hasPassing) {
        hasFail = true;
        if (!KNOWN_CLASSES.includes(cls)) {
          // Fail closed AND tell the operator it is almost certainly a typo —
          // no runner can ever carry a class outside the taxonomy, so this would
          // otherwise be a permanent, unexplained FAIL.
          reasons.push(
            `required test class "${cls}" is not a known test class (likely a typo; ` +
            `known classes: ${KNOWN_CLASSES.join(', ')})`
          );
        } else {
          reasons.push(
            `required test class "${cls}" has no runner that ran and passed ` +
            `(policy demands this class be covered; add or fix a "${cls}"-class runner)`
          );
        }
      }
    }
  }

  let verdict;
  if (hasFail) verdict = FAIL;
  else if (hasFlag) verdict = FLAG;
  else verdict = PASS;

  return { verdict, reasons };
}

module.exports = {
  computeVerdict,
  PASS,
  FLAG,
  FAIL,
  BLAST_RADIUS_THRESHOLDS,
  BLAST_RADIUS_BLOCKS,
  KNOWN_CLASSES,
};
