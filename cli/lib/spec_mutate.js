'use strict';

/**
 * fqe SPEC-MUTATION engine — DETERMINISTIC + FAIL-CLOSED.
 *
 * Ordinary mutation testing (see mutation_gate.js) mutates the CODE and asks
 * "would the tests catch a broken implementation?". That kills sloppy
 * assertions, but it cannot catch a TAUTOLOGY: a test written to assert
 * exactly what the (possibly wrong) code does. Such a test passes against the
 * code AND against any code-mutant the test was co-derived from, because the
 * test never encoded the REQUIREMENT — it encoded the behavior.
 *
 * Spec mutation attacks that. It mutates the REQUIREMENT (the spec) instead of
 * the code. If a test is genuinely anchored to the spec, then corrupting the
 * spec must make the test FAIL (the test now contradicts the corrupted rule).
 * A mutant that the test suite still PASSES against has "survived": the test is
 * not actually pinned to that requirement — it is a tautology.
 *
 *   KILLED   = test suite FAILS against the spec-mutant (good: anchored)
 *   SURVIVED = test suite PASSES against the spec-mutant (bad: tautology)
 *
 * Same input -> same output. No I/O, no clock, no randomness, no LLM. Throws on
 * malformed input rather than silently passing.
 */

/**
 * @typedef {Object} SpecRule
 * @property {string} id          rule identifier (left of the colon)
 * @property {string} expression  the rule body (right of the colon)
 *
 * @typedef {Object} MutationOperator
 * @property {string} name
 * @property {(expr: string) => (string|null)} apply  returns the mutated
 *        expression, or null if this operator does not apply to `expr`
 *
 * @typedef {Object} Mutant
 * @property {string} id          rule id this mutant came from
 * @property {string} operator    operator name that produced it
 * @property {string} original    the original expression
 * @property {string} mutated     the mutated expression
 */

// ── parseSpecRules ───────────────────────────────────────────────────────────

/**
 * Parse a machine-readable spec.
 *
 * Line format: each non-comment, non-blank line is `RULE_ID: expression`.
 *   - blank lines (whitespace only) are skipped
 *   - lines whose first non-whitespace char is `#` are comments, skipped
 *   - everything else MUST contain a colon; the part before the first colon is
 *     the id, the rest is the expression
 *
 * An id must be a non-empty token (letters, digits, underscore). An expression
 * must be non-empty after trimming. A malformed line THROWS (fail closed) — we
 * never silently drop a rule we could not understand.
 *
 * @param {string} text
 * @returns {SpecRule[]}
 */
function parseSpecRules(text) {
  if (typeof text !== 'string') {
    throw new Error('parseSpecRules: text must be a string');
  }
  const rules = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '') continue;            // blank line
    if (trimmed.startsWith('#')) continue;   // comment

    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `parseSpecRules: malformed line ${i + 1} (no ':' separator): ${JSON.stringify(raw)}`
      );
    }
    const id = trimmed.slice(0, colon).trim();
    const expression = trimmed.slice(colon + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(id)) {
      throw new Error(
        `parseSpecRules: malformed rule id on line ${i + 1} (expected [A-Za-z0-9_]+): ${JSON.stringify(id)}`
      );
    }
    if (expression === '') {
      throw new Error(
        `parseSpecRules: empty expression on line ${i + 1} for rule ${JSON.stringify(id)}`
      );
    }
    rules.push({ id, expression });
  }
  return rules;
}

// ── MUTATION_OPERATORS ───────────────────────────────────────────────────────

// Comparison flips. Order matters: longer operators (<=, >=, ==, !=) must be
// tested before their single-char prefixes (<, >) so we never mis-split "<=".
// Each entry is [from, to]. The flip pairs both directions:
//   <  -> <=   and   <= -> <
//   >  -> >=   and   >= -> >
//   == -> !=   and   != -> ==
const COMPARISON_FLIPS = Object.freeze([
  ['<=', '<'],
  ['>=', '>'],
  ['==', '!='],
  ['!=', '=='],
  ['<', '<='],
  ['>', '>='],
]);

/**
 * Find the first comparison operator in `expr` and return its position and
 * which flip applies. We scan left to right, and at each index prefer the
 * longest matching operator so "<=" is never read as "<".
 * @param {string} expr
 * @returns {{ index: number, from: string, to: string }|null}
 */
function firstComparison(expr) {
  for (let i = 0; i < expr.length; i++) {
    for (const [from, to] of COMPARISON_FLIPS) {
      if (expr.startsWith(from, i)) {
        return { index: i, from, to };
      }
    }
  }
  return null;
}

// Match the first standalone numeric literal (integer or decimal). We avoid
// matching digits that are part of an identifier (e.g. the "2" in "x2") by
// requiring the char before the match not be a letter/digit/underscore.
const NUMERIC_RE = /(?<![A-Za-z0-9_.])(\d+(?:\.\d+)?)/;

/**
 * Replace the first standalone numeric literal in `expr` using `transform`.
 * @param {string} expr
 * @param {(n: number) => number} transform
 * @returns {string|null}  null if there is no numeric literal
 */
function perturbFirstNumber(expr, transform) {
  const m = NUMERIC_RE.exec(expr);
  if (!m) return null;
  const original = m[1];
  const value = Number(original);
  if (!Number.isFinite(value)) return null;
  const next = transform(value);
  const start = m.index;
  return expr.slice(0, start) + String(next) + expr.slice(start + original.length);
}

// Rounding keyword swaps. HALF_EVEN -> HALF_UP (a different but plausible
// rounding mode that a tautological test would still accept); every other
// known rounding mode -> DOWN (truncation, the bluntest change).
const ROUNDING_KEYWORDS = Object.freeze(['HALF_EVEN', 'HALF_UP', 'HALF_DOWN', 'UP', 'DOWN', 'CEILING', 'FLOOR']);
const ROUNDING_RE = new RegExp(`\\b(${ROUNDING_KEYWORDS.join('|')})\\b`);

function swapRounding(expr) {
  const m = ROUNDING_RE.exec(expr);
  if (!m) return null;
  const kw = m[1];
  const replacement = kw === 'HALF_EVEN' ? 'HALF_UP' : 'DOWN';
  if (replacement === kw) return null; // would be a no-op (e.g. already DOWN)
  return expr.slice(0, m.index) + replacement + expr.slice(m.index + kw.length);
}

// Boolean swap: the first standalone `true`/`false` token is flipped.
const BOOLEAN_RE = /\b(true|false)\b/;

function swapBoolean(expr) {
  const m = BOOLEAN_RE.exec(expr);
  if (!m) return null;
  const replacement = m[1] === 'true' ? 'false' : 'true';
  return expr.slice(0, m.index) + replacement + expr.slice(m.index + m[1].length);
}

// fqe-fix: range rules (e.g. "amount >= 1 AND amount <= 1000000") have TWO bounds.
// The first-occurrence operators only probed the lower bound, so a tautological
// test that ignored the upper ceiling survived. These collect EVERY comparison
// and EVERY numeric literal so both bounds (and the ceiling) get mutated.

/** All non-overlapping comparison occurrences, longest-match first. */
function allComparisons(expr) {
  const out = [];
  for (let i = 0; i < expr.length; ) {
    let matched = null;
    for (const [from, to] of COMPARISON_FLIPS) {
      if (expr.startsWith(from, i)) { matched = { index: i, from, to }; break; }
    }
    if (matched) { out.push(matched); i += matched.from.length; } else { i++; }
  }
  return out;
}

/** All standalone numeric literals with index + raw text + numeric value. */
function allNumbers(expr) {
  const re = /(?<![A-Za-z0-9_.])(\d+(?:\.\d+)?)/g;
  const out = [];
  let m;
  while ((m = re.exec(expr)) !== null) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) out.push({ index: m.index, raw: m[1], value });
  }
  return out;
}

/**
 * The frozen, named, deterministic operator list. Each operator returns a
 * mutated expression, or null when it does not apply to the given expression.
 * The order here IS the deterministic generation order.
 *
 * @type {readonly MutationOperator[]}
 */
const MUTATION_OPERATORS = Object.freeze([
  Object.freeze({
    name: 'flip_comparison',
    apply(expr) {
      const c = firstComparison(expr);
      if (!c) return null;
      return expr.slice(0, c.index) + c.to + expr.slice(c.index + c.from.length);
    },
  }),
  Object.freeze({
    name: 'increment_literal',
    apply(expr) {
      return perturbFirstNumber(expr, (n) => n + 1);
    },
  }),
  Object.freeze({
    name: 'halve_literal',
    apply(expr) {
      return perturbFirstNumber(expr, (n) => n / 2);
    },
  }),
  Object.freeze({
    name: 'swap_boolean',
    apply(expr) {
      return swapBoolean(expr);
    },
  }),
  Object.freeze({
    name: 'swap_rounding',
    apply(expr) {
      return swapRounding(expr);
    },
  }),
]);

// ── generateMutants ──────────────────────────────────────────────────────────

/**
 * Apply every applicable operator to a rule. Deterministic order: operators are
 * applied in MUTATION_OPERATORS order, and operators that return null (not
 * applicable) are skipped. An operator that produces a mutant identical to the
 * original is also skipped (it would be a no-op, not a real mutant).
 *
 * @param {SpecRule} rule
 * @returns {Mutant[]}
 */
function generateMutants(rule) {
  if (!rule || typeof rule !== 'object') {
    throw new Error('generateMutants: rule must be an object');
  }
  if (typeof rule.id !== 'string' || rule.id === '') {
    throw new Error('generateMutants: rule.id must be a non-empty string');
  }
  if (typeof rule.expression !== 'string' || rule.expression === '') {
    throw new Error('generateMutants: rule.expression must be a non-empty string');
  }
  const expr = rule.expression;
  const seen = new Set();
  const mutants = [];
  const push = (operator, mutated) => {
    if (mutated == null) return;
    if (mutated === expr) return;       // no-op mutant, skip
    if (seen.has(mutated)) return;      // dedupe identical mutated strings
    seen.add(mutated);
    mutants.push({ id: rule.id, operator, original: expr, mutated });
  };

  // First-occurrence operators (covers boolean + rounding, and the first
  // comparison/literal). Kept so the operator unit tests stay meaningful.
  for (const op of MUTATION_OPERATORS) push(op.name, op.apply(expr));

  // fqe-fix: EVERY comparison position, so both bounds of a range rule are probed.
  for (const c of allComparisons(expr)) {
    push('flip_comparison', expr.slice(0, c.index) + c.to + expr.slice(c.index + c.from.length));
  }
  // fqe-fix: EVERY numeric literal, so a payment ceiling is not left unmutated.
  for (const n of allNumbers(expr)) {
    const repl = (v) => expr.slice(0, n.index) + String(v) + expr.slice(n.index + n.raw.length);
    push('increment_literal', repl(n.value + 1));
    push('halve_literal', repl(n.value / 2));
  }

  return mutants;
}

// ── evaluateSpecMutation ─────────────────────────────────────────────────────

const PASS = 'PASS';
const FAIL = 'FAIL';

/**
 * Evaluate the spec-mutation gate.
 *
 * A mutant is KILLED if the test suite FAILS against it (the test is anchored
 * to the spec) and SURVIVED if the suite still PASSES (the test is a tautology,
 * not pinned to the requirement). The kill ratio must meet `threshold`
 * (default 1.0 — every spec-mutant must be killed, since a single survivor is a
 * proven tautology).
 *
 * Fail closed: `mutantsTotal` of 0 THROWS (with no mutants we cannot judge
 * whether the tests are anchored — that is not a pass).
 *
 * @param {object} o
 * @param {number} o.mutantsTotal     total spec-mutants generated/run (> 0)
 * @param {number} o.mutantsKilled    how many the suite failed against
 * @param {number} [o.threshold=1.0]  minimum kill ratio (0..1)
 * @returns {{ verdict: 'PASS'|'FAIL', killRatio: number, survived: number,
 *             reasons: string[] }}
 */
function evaluateSpecMutation(o) {
  if (!o || typeof o !== 'object') {
    throw new Error('evaluateSpecMutation: input must be an object');
  }
  const { mutantsTotal, mutantsKilled } = o;
  const threshold = o.threshold === undefined ? 1.0 : o.threshold;

  if (!Number.isFinite(mutantsTotal) || !Number.isInteger(mutantsTotal) || mutantsTotal < 0) {
    throw new Error(
      `evaluateSpecMutation: mutantsTotal must be a non-negative integer (got ${JSON.stringify(mutantsTotal)})`
    );
  }
  if (mutantsTotal === 0) {
    // Fail closed: no spec-mutants means we cannot prove the tests are anchored.
    throw new Error(
      'evaluateSpecMutation: mutantsTotal is 0 — cannot judge spec anchoring with zero mutants (fail closed)'
    );
  }
  if (!Number.isFinite(mutantsKilled) || !Number.isInteger(mutantsKilled) || mutantsKilled < 0) {
    throw new Error(
      `evaluateSpecMutation: mutantsKilled must be a non-negative integer (got ${JSON.stringify(mutantsKilled)})`
    );
  }
  if (mutantsKilled > mutantsTotal) {
    throw new Error(
      `evaluateSpecMutation: mutantsKilled (${mutantsKilled}) cannot exceed mutantsTotal (${mutantsTotal})`
    );
  }
  // fqe-fix: threshold MUST be in (0, 1]. A threshold of 0 was a fail-open: the
  // gate condition (killRatio < threshold) can never be true at 0, so a suite
  // that killed nothing still PASSed. A zero-kill-requirement gate is no gate.
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error(
      `evaluateSpecMutation: threshold must be in (0, 1] (got ${JSON.stringify(threshold)}); 0 would disable the gate`
    );
  }

  const survived = mutantsTotal - mutantsKilled;
  // fqe-fix: GATE on the EXACT ratio, round only for display. Gating on the
  // rounded ratio was a fail-open: at scale, 19999/20000 = 0.99995 rounds to
  // 1.0000 and slipped past the default 1.0 gate even though a tautological
  // spec-mutant survived. The module exists to catch exactly that survivor.
  const exactRatio = mutantsKilled / mutantsTotal;
  const killRatio = round4(exactRatio);
  const reasons = [];
  // Use a tiny epsilon so floating-point kill ratios at the bar (e.g. 2/3 vs a
  // 0.66 threshold) compare cleanly.
  if (exactRatio < threshold - 1e-9) {
    reasons.push(
      `SPEC_MUTATION_SURVIVOR: ${survived} of ${mutantsTotal} spec-mutant(s) survived ` +
      `(kill ratio ${killRatio.toFixed(4)} below threshold ${threshold}). ` +
      `A surviving spec-mutant is a tautological test: the suite still passes when the ` +
      `REQUIREMENT is corrupted, so the test is pinned to the code, not the spec. ` +
      `Re-anchor the assertion to the requirement.`
    );
  }
  return {
    verdict: reasons.length === 0 ? PASS : FAIL,
    killRatio,
    survived,
    reasons,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  parseSpecRules,
  MUTATION_OPERATORS,
  generateMutants,
  evaluateSpecMutation,
  PASS,
  FAIL,
};
