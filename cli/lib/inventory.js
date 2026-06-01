'use strict';

/**
 * Zero-dependency, FAIL-CLOSED inventory parser for fqe coverage-liveness.
 *
 * An `inventory_cmd` is a deterministic, no-network command that reports how many
 * tests the framework KNOWS about (collected), independent of how many a runner
 * chose to execute. fqe compares that collected count against the executed count
 * from the JUnit report. A runner scoped to a subset reports fewer testcases than
 * were collected, so a mis-scoped or partial run cannot read green.
 *
 * Supported formats (declared per runner as `inventory_format`):
 *   - 'count'         : stdout is a single non-negative integer (the count). The
 *                       repo author composes this from their own tooling, e.g.
 *                       `pytest --collect-only -q | grep -c '::'` or
 *                       `cargo nextest list --message-format json | jq '...'`.
 *                       This keeps fqe framework-agnostic: the author owns the
 *                       framework-specific extraction, fqe owns the gate.
 *   - 'pytest-collect': stdout of `pytest --collect-only -q`. Counts test-id lines
 *                       (a line beginning non-whitespace and containing '::'). If a
 *                       "N test(s) collected" summary is also present and disagrees
 *                       with the line count, that is ambiguous => throw (fail closed).
 *
 * INVARIANTS:
 *   - Returns a non-negative integer count, or throws. No verdict here.
 *   - Anything it cannot interpret unambiguously throws => orchestrator ERROR.
 */

const KNOWN_FORMATS = Object.freeze(['count', 'pytest-collect']);

function parseCount(stdout) {
  // Accept stdout that is exactly an integer, or whose LAST non-empty line is an
  // integer (lets an author end a pipeline with a bare count). Reject anything else.
  const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error("inventory: format 'count' produced no output (fail closed)");
  }
  const last = lines[lines.length - 1];
  if (!/^\d+$/.test(last)) {
    throw new Error(`inventory: format 'count' expected an integer, got "${last}" (fail closed)`);
  }
  return parseInt(last, 10);
}

function parsePytestCollect(stdout) {
  const lines = String(stdout).split(/\r?\n/);
  let idLines = 0;
  let summary = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // A pytest collect-only -q test id: non-indented, contains '::'.
    if (/^\S/.test(line) && line.includes('::')) {
      idLines++;
      continue;
    }
    // Summary line like "6 tests collected in 0.01s" or "1 test collected".
    const sm = line.match(/^(\d+)\s+tests?\s+collected\b/);
    if (sm) summary = parseInt(sm[1], 10);
  }
  if (summary !== null && summary !== idLines) {
    throw new Error(
      `inventory: pytest-collect ambiguous (${idLines} id lines vs summary ${summary}); failing closed`
    );
  }
  // If neither id lines nor a summary were found, we cannot trust a zero. Fail closed.
  if (idLines === 0 && summary === null) {
    throw new Error('inventory: pytest-collect found no test ids and no summary (fail closed)');
  }
  return summary !== null ? summary : idLines;
}

/**
 * @param {string} stdout  raw stdout of the inventory_cmd
 * @param {string} format  one of KNOWN_FORMATS
 * @returns {number} collected test count (>= 0)
 */
function parseInventory(stdout, format) {
  if (typeof stdout !== 'string') {
    throw new Error('inventory: stdout must be a string (fail closed)');
  }
  if (!KNOWN_FORMATS.includes(format)) {
    throw new Error(
      `inventory: unknown inventory_format "${format}"; known: ${KNOWN_FORMATS.join(', ')} (fail closed)`
    );
  }
  if (format === 'count') return parseCount(stdout);
  return parsePytestCollect(stdout);
}

module.exports = { parseInventory, KNOWN_FORMATS };
