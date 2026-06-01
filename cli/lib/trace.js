'use strict';

/**
 * fqe trace gate — REQUIREMENT to TEST traceability, DETERMINISTIC + FAIL-CLOSED.
 *
 * Coverage and mutation testing prove that the tests you HAVE are honest. This
 * gate proves you have the tests you NEED. It builds a bidirectional matrix
 * between declared requirements and the tests that cover them, then fails the
 * build when a high-blast-radius requirement (money, security) ships with no
 * covering test, OR when a money/security test exists but traces to no
 * requirement (an orphan test that is testing something nobody asked for, or
 * silently lost its requirement link).
 *
 * Why money/security are "strict": an untested money requirement is an
 * un-reconciled balance waiting to happen; an untested security requirement is
 * an un-audited attack surface. Looser classes (unit, integration, ...) are
 * still reported as FLAG-level gaps but do not block the merge.
 *
 * Same inputs -> same output. No I/O, no clock, no randomness, no LLM. Throws
 * on malformed input (a dropped or mistyped requirement/test array cannot pass
 * by being silently treated as empty).
 *
 * Mirrors the shape of verdict.js / mutation_gate.js: a pure evaluate function
 * returning { verdict, reasons }, with a separate pure matrix-builder.
 */

/**
 * Test classes whose traceability gaps are a hard FAIL (block the merge) rather
 * than an advisory FLAG. POLICY, locked here so a caller cannot loosen it.
 */
const DEFAULT_STRICT_CLASSES = Object.freeze(['money', 'security']);

/**
 * Build the requirement<->test traceability matrix.
 *
 * @param {object} o
 * @param {Array<{id:string, class:string}>} o.requirements
 *        Each requirement declares an id and an fqe test-class (money,
 *        security, unit, ...).
 * @param {Array<{name:string, requirementIds:string[], class:string}>} o.tests
 *        Each test declares a name, the requirement ids it covers, and its class.
 * @returns {{
 *   covered: string[],            // requirement ids that have >= 1 covering test
 *   orphanRequirements: string[], // requirement ids with NO covering test
 *   orphanTests: string[],        // names of money/security tests with empty requirementIds
 * }}
 * @throws {Error} on malformed input (non-array, missing id/class, etc.)
 */
function buildTraceMatrix(o) {
  if (!o || typeof o !== 'object') {
    throw new Error('trace: input must be an object');
  }
  const { requirements, tests } = o;
  if (!Array.isArray(requirements)) {
    throw new Error('trace: requirements must be an array');
  }
  if (!Array.isArray(tests)) {
    throw new Error('trace: tests must be an array');
  }

  // Validate + index requirements. Fail closed on any malformed entry.
  const requirementById = new Map();
  for (const req of requirements) {
    if (!req || typeof req !== 'object') {
      throw new Error('trace: each requirement must be an object');
    }
    if (typeof req.id !== 'string' || req.id.length === 0) {
      throw new Error('trace: requirement missing id');
    }
    if (typeof req.class !== 'string' || req.class.length === 0) {
      throw new Error(`trace: requirement "${req.id}" missing class`);
    }
    if (requirementById.has(req.id)) {
      throw new Error(`trace: duplicate requirement id "${req.id}"`);
    }
    requirementById.set(req.id, req);
  }

  // Walk tests, accumulating which requirements are covered and which
  // strict-class tests are orphans (no requirement link at all).
  const coveredSet = new Set();
  const orphanTests = [];
  for (const t of tests) {
    if (!t || typeof t !== 'object') {
      throw new Error('trace: each test must be an object');
    }
    if (typeof t.name !== 'string' || t.name.length === 0) {
      throw new Error('trace: test missing name');
    }
    if (typeof t.class !== 'string' || t.class.length === 0) {
      throw new Error(`trace: test "${t.name}" missing class`);
    }
    if (!Array.isArray(t.requirementIds)) {
      throw new Error(`trace: test "${t.name}" requirementIds must be an array`);
    }

    // fqe-fix: only count coverage from requirementIds that point at a REAL
    // declared requirement. A test referencing a deleted/typo'd id must not
    // invent coverage (this also drives the ghost-pointing orphan check below).
    let resolvedCount = 0;
    for (const rid of t.requirementIds) {
      if (typeof rid !== 'string' || rid.length === 0) {
        throw new Error(`trace: test "${t.name}" has a non-string requirementId`);
      }
      if (requirementById.has(rid)) {
        coveredSet.add(rid);
        resolvedCount++;
      }
    }

    // An orphan test is a strict-class (money/security) test that traces to NO
    // existing requirement: either it has zero links, OR every link points at a
    // requirement that does not exist (a deleted or mistyped id = ghost coverage).
    // Without this, a money test pinned to "DELETED_REQ" silently passed the gate.
    if (DEFAULT_STRICT_CLASSES.includes(t.class) && resolvedCount === 0) {
      orphanTests.push(t.name);
    }
  }

  // covered = requirement ids that have at least one covering test. We only
  // count coverage of requirements that actually exist (a test pointing at a
  // requirement id that was never declared does not invent a covered req).
  const covered = [];
  const orphanRequirements = [];
  for (const req of requirements) {
    if (coveredSet.has(req.id)) {
      covered.push(req.id);
    } else {
      orphanRequirements.push(req.id);
    }
  }

  return { covered, orphanRequirements, orphanTests };
}

/**
 * Evaluate the trace matrix into a verdict.
 *
 * @param {{covered:string[], orphanRequirements:string[], orphanTests:string[]}} matrix
 *        Output of buildTraceMatrix.
 * @param {object} [o]
 * @param {string[]} [o.strictClasses]  classes whose gaps FAIL (default: money,
 *        security). Pass a custom set to widen, never to narrow below policy in
 *        practice (kept as a parameter for determinism + testability).
 * @param {Array<{id:string, class:string}>} [o.requirements]  the original
 *        requirements, needed to know each orphan requirement's class. Required
 *        whenever orphanRequirements is non-empty.
 * @returns {{ verdict: 'PASS'|'FAIL', reasons: string[] }}
 * @throws {Error} on malformed input.
 */
function evaluateTrace(matrix, o) {
  if (!matrix || typeof matrix !== 'object') {
    throw new Error('trace: matrix must be an object');
  }
  const { covered, orphanRequirements, orphanTests } = matrix;
  if (!Array.isArray(covered) || !Array.isArray(orphanRequirements) || !Array.isArray(orphanTests)) {
    throw new Error('trace: matrix must have covered, orphanRequirements, orphanTests arrays');
  }

  const opts = o || {};
  // fqe-fix: the money/security floor cannot be narrowed away. A caller may WIDEN
  // the strict set (add classes) but never eliminate it: passing strictClasses: []
  // used to suppress every money/security FAIL. Always union the defaults in.
  const extra = Array.isArray(opts.strictClasses) ? opts.strictClasses : [];
  const strictSet = new Set([...DEFAULT_STRICT_CLASSES, ...extra]);

  // To FAIL on a strict orphan REQUIREMENT we must know its class. The caller
  // passes the original requirements so we can map id -> class. If there are
  // orphan requirements but no requirements list to classify them, fail closed:
  // we cannot prove the gap is harmless.
  const requirements = Array.isArray(opts.requirements) ? opts.requirements : null;
  const classById = new Map();
  if (requirements) {
    for (const req of requirements) {
      if (!req || typeof req.id !== 'string' || typeof req.class !== 'string') {
        throw new Error('trace: requirements passed to evaluateTrace are malformed');
      }
      classById.set(req.id, req.class);
    }
  }

  const reasons = [];
  let hasFail = false;

  for (const rid of orphanRequirements) {
    if (!requirements) {
      // Cannot classify -> fail closed.
      hasFail = true;
      reasons.push(
        `TRACE_UNCLASSIFIED_ORPHAN: requirement "${rid}" has no covering test and ` +
        `no requirements list was provided to classify it; failing closed`
      );
      continue;
    }
    const cls = classById.get(rid);
    if (cls === undefined) {
      // Orphan id not present in the requirements list -> fail closed.
      hasFail = true;
      reasons.push(
        `TRACE_UNCLASSIFIED_ORPHAN: orphan requirement "${rid}" is not present in ` +
        `the requirements list; cannot classify, failing closed`
      );
      continue;
    }
    if (strictSet.has(cls)) {
      hasFail = true;
      reasons.push(
        `TRACE_UNCOVERED_REQUIREMENT: ${cls} requirement "${rid}" has no covering ` +
        `test. A ${cls}-class requirement must be tested before merge.`
      );
    } else {
      reasons.push(
        `TRACE_GAP (advisory): ${cls} requirement "${rid}" has no covering test ` +
        `(non-strict class; reported but does not block).`
      );
    }
  }

  // Orphan tests are, by construction in buildTraceMatrix, strict-class tests
  // with no requirement link. Those FAIL.
  for (const name of orphanTests) {
    hasFail = true;
    reasons.push(
      `TRACE_ORPHAN_TEST: test "${name}" is in a strict class but traces to no ` +
      `requirement. Link it to a requirement or remove it.`
    );
  }

  return { verdict: hasFail ? 'FAIL' : 'PASS', reasons };
}

module.exports = {
  buildTraceMatrix,
  evaluateTrace,
  DEFAULT_STRICT_CLASSES,
};
