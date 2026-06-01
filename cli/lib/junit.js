'use strict';

/**
 * Zero-dependency, FAIL-CLOSED JUnit XML parser for fqe coverage-liveness.
 *
 * Purpose: turn a test framework's JUnit report into the three numbers the
 * verdict needs:
 *   - reported: total <testcase> elements in the report
 *   - skipped:  testcases that did NOT execute (skip / xfail / disabled / notrun)
 *   - executed: reported - skipped (failures and errors DID execute, so they count)
 *
 * INVARIANTS (this module can never mint a false PASS):
 *   - It returns NUMBERS only. It makes no verdict.
 *   - ANY structural ambiguity throws. The orchestrator maps a throw to ERROR,
 *     so a parser bug or an unknown dialect BLOCKS the merge, never passes it.
 *   - A well-formed report with zero testcases is NOT an error here; it returns
 *     executed: 0 and the verdict turns that into FAIL via min_tests. (Empty is
 *     a real, judgeable state; garbled is not.)
 *
 * Why both skip and xfail count as skipped: real pytest output renders xfail as
 * <skipped type="pytest.xfail">, so a suite that only xfails has executed: 0.
 *
 * Ids are extracted best-effort for the receipt MESSAGE only. They never gate.
 */

function attr(attrs, name) {
  // Escape the attribute name (defensive; call sites use literals today) and accept
  // BOTH quote styles: XML 1.0 permits status='skipped' as well as status="skipped".
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = attrs.match(new RegExp(`\\b${safe}\\s*=\\s*["']([^"']*)["']`));
  return m ? m[1] : '';
}

// Statuses that mean the test did NOT execute. Covers pytest skip/xfail (rendered as
// a <skipped> child), Jest pending (test.skip / xit), and disabled/ignored/notrun
// from other frameworks. A non-executing case must never count toward the floor.
const SKIPPED_STATUSES = Object.freeze(new Set(['skipped', 'disabled', 'notrun', 'ignored', 'pending']));

/**
 * Parse JUnit XML text. Throws on anything it cannot interpret unambiguously.
 * @param {string} xml
 * @returns {{reported:number, skipped:number, executed:number, ids:string[]}}
 */
function parseJUnit(xml) {
  if (typeof xml !== 'string') {
    throw new Error('junit: report content must be a string (fail closed)');
  }
  const raw = xml.trim();
  if (!raw) {
    throw new Error('junit: report is empty (fail closed)');
  }
  // Must look like a JUnit document. No testsuite root => not a report we can trust.
  if (!/<testsuites?\b/.test(raw)) {
    throw new Error('junit: no <testsuite>/<testsuites> root; not a JUnit report (fail closed)');
  }
  // Strip XML comments so a commented-out <testcase> cannot inflate the executed
  // count (both regexes would otherwise match it identically and dodge the cross-check).
  const text = raw.replace(/<!--[\s\S]*?-->/g, '');

  const openTags = (text.match(/<testcase\b/g) || []).length;

  // Local regex (no shared module-level lastIndex state to corrupt across calls).
  const testcaseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  let reported = 0;
  let skipped = 0;
  const ids = [];
  while ((m = testcaseRe.exec(text)) !== null) {
    reported++;
    const attrs = m[1] || '';
    const inner = m[3] || ''; // undefined/'' when self-closed
    const statusAttr = attr(attrs, 'status').toLowerCase();
    const isSkipped = /<skipped\b/.test(inner) || SKIPPED_STATUSES.has(statusAttr);
    if (isSkipped) skipped++;
    const cn = attr(attrs, 'classname');
    const nm = attr(attrs, 'name');
    ids.push(cn ? `${cn}::${nm}` : nm);
  }

  // Fail-closed cross-check: every literal "<testcase" must have parsed into a
  // complete element. A mismatch means a malformed/truncated tag we cannot trust.
  if (reported !== openTags) {
    throw new Error(
      `junit: ambiguous parse (${openTags} <testcase tags but ${reported} complete elements); failing closed`
    );
  }

  return { reported, skipped, executed: reported - skipped, ids };
}

module.exports = { parseJUnit };
