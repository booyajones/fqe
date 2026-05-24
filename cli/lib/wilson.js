'use strict';

/**
 * Wilson score confidence interval for a binomial proportion.
 *
 * Closes the v1 flaw flagged by the Anthropic eval lead in council voice 3:
 *   "50 attempts cannot distinguish 3% from 10% attack success rate with any
 *    confidence. ... You cannot claim '≤10% ASR baseline' from 50 attempts."
 *
 * The Wilson interval is the standard for small-n binomial proportions and
 * stays well-defined when p_hat is 0 or 1 (unlike the normal approximation).
 *
 * Reference: Wilson, E. B. (1927). "Probable inference, the law of succession,
 * and statistical inference." JASA 22(158): 209-212.
 *
 * Unit tests pin output against scipy.stats.proportion_confint(method='wilson')
 * reference values.
 */

const Z_95 = 1.959963984540054; // standard normal 0.975 quantile, IEEE-754 stable

/**
 * Compute Wilson score interval at 95% confidence.
 *
 * @param {number} successes - non-negative integer count of "attack successes"
 * @param {number} n         - positive integer total attempts
 * @returns {{ lo: number, hi: number, p_hat: number, n: number, successes: number }}
 * @throws if inputs invalid
 */
function wilson95(successes, n) {
  if (!Number.isInteger(successes) || successes < 0) {
    throw new Error(`wilson95: successes must be non-negative integer, got ${successes}`);
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`wilson95: n must be positive integer, got ${n}`);
  }
  if (successes > n) {
    throw new Error(`wilson95: successes (${successes}) > n (${n})`);
  }

  const pHat = successes / n;
  const z = Z_95;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const halfWidth =
    (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;

  return {
    successes,
    n,
    p_hat: pHat,
    lo: Math.max(0, center - halfWidth),
    hi: Math.min(1, center + halfWidth),
  };
}

/**
 * Minimum N required to claim "true rate is <= target" at 95% confidence,
 * assuming 0 observed successes.
 *
 * Used to answer "how many attempts do I need to defensibly claim ≤1% ASR?"
 *   minNForUpperBound(0.01) -> ~298
 *   minNForUpperBound(0.05) -> ~58
 *   minNForUpperBound(0.10) -> ~28
 *
 * @param {number} target - upper bound to defend, e.g. 0.01 for "≤1%"
 * @returns {number} minimum N (integer, ceiling)
 */
function minNForUpperBound(target) {
  if (typeof target !== 'number' || target <= 0 || target >= 1) {
    throw new Error(`minNForUpperBound: target must be in (0,1), got ${target}`);
  }
  // With 0 successes, Wilson upper bound is z^2 / (n + z^2). Solve for n.
  const z2 = Z_95 * Z_95;
  const n = z2 * (1 - target) / target;
  return Math.ceil(n);
}

module.exports = { wilson95, minNForUpperBound, Z_95 };
