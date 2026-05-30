'use strict';

/**
 * fqe UAT gate — DETERMINISTIC + FAIL-CLOSED, zero runtime dependencies.
 *
 * This module gates a release against acceptance criteria. Each criterion is
 * either verified automatically (by a named test result) or manually (by a
 * named human sign-off). The verdict is:
 *
 *   FAIL  if any criterion FAILED, or (in strict mode) any is UNVERIFIED
 *   FLAG  if any criterion is UNVERIFIED (and none FAILED) in non-strict mode
 *   PASS  if every criterion is COVERED
 *
 * Fail-closed everywhere: a missing test result is NEVER a pass, a manual pass
 * with no signer is NEVER acceptance, and malformed input throws rather than
 * silently passing. Same input -> same output. No I/O, no clock, no randomness.
 *
 * The CORE evaluator (evaluateUat) is a PURE function so the CLI can read files
 * and feed it strings; this module does no file reading itself.
 *
 * Table-driven unit tests live in test/uat.test.js.
 */

const PASS = 'PASS';
const FLAG = 'FLAG';
const FAIL = 'FAIL';

const MANUAL = 'manual';
const TEST_REF = /^test:.+/;

/**
 * @typedef {Object} Criterion
 * @property {string}  id           // unique acceptance-criterion id (e.g. "AC-1")
 * @property {string}  statement    // human-readable acceptance statement
 * @property {string}  verified_by  // "test:<testId>" (automated) or "manual"
 * @property {string=} status       // for manual: 'pass' | 'fail' | 'pending'
 * @property {string=} signoff       // for manual pass: non-empty signer string
 *
 * @typedef {Object} UatResult
 * @property {number} total
 * @property {number} covered
 * @property {number} automated_covered
 * @property {number} manual_covered
 * @property {{id:string,statement:string,reason:string}[]} failed
 * @property {{id:string,statement:string,reason:string}[]} unverified
 * @property {number} coverage_pct
 * @property {'PASS'|'FLAG'|'FAIL'} verdict
 * @property {string[]} reasons
 */

/**
 * Evaluate UAT criteria against test results. PURE — the heart of the module.
 *
 * @param {Object} o
 * @param {Criterion[]} o.criteria          acceptance criteria
 * @param {Record<string,'pass'|'fail'>=} o.results  testId -> result (default {})
 * @param {boolean=} o.strict               when true, UNVERIFIED -> FAIL
 * @returns {UatResult}
 */
function evaluateUat(o) {
  if (!o || typeof o !== 'object') {
    throw new Error('uat: input must be an object');
  }
  const { criteria } = o;
  const strict = o.strict === true;
  const results =
    o.results && typeof o.results === 'object' && !Array.isArray(o.results)
      ? o.results
      : (o.results === undefined || o.results === null)
        ? {}
        : null;
  if (results === null) {
    throw new Error('uat: results must be an object mapping testId -> "pass"|"fail"');
  }

  validateCriteria(criteria);

  const failed = [];
  const unverified = [];
  let automatedCovered = 0;
  let manualCovered = 0;

  for (const c of criteria) {
    if (c.verified_by === MANUAL) {
      const evalRes = evaluateManual(c);
      if (evalRes.state === 'covered') manualCovered++;
      else if (evalRes.state === 'failed') failed.push({ id: c.id, statement: c.statement, reason: evalRes.reason });
      else unverified.push({ id: c.id, statement: c.statement, reason: evalRes.reason });
    } else {
      // verified_by is "test:<testId>" (validated above)
      const testId = c.verified_by.slice('test:'.length);
      const result = Object.prototype.hasOwnProperty.call(results, testId)
        ? results[testId]
        : undefined;
      if (result === 'pass') {
        automatedCovered++;
      } else if (result === 'fail') {
        failed.push({
          id: c.id,
          statement: c.statement,
          reason: `automated test "${testId}" FAILED`,
        });
      } else {
        // missing / undefined / any non-pass-non-fail value -> UNVERIFIED (fail closed)
        unverified.push({
          id: c.id,
          statement: c.statement,
          reason: result === undefined
            ? `no result for automated test "${testId}" (a missing result is never a pass)`
            : `automated test "${testId}" reported unrecognized result ${JSON.stringify(result)} (only "pass"|"fail" recognized; treated as unverified)`,
        });
      }
    }
  }

  const total = criteria.length;
  const covered = automatedCovered + manualCovered;
  const coverage_pct = total === 0 ? 100 : round1((covered / total) * 100);

  let verdict;
  if (failed.length > 0 || (strict && unverified.length > 0)) verdict = FAIL;
  else if (unverified.length > 0) verdict = FLAG;
  else verdict = PASS;

  const reasons = buildReasons({
    total, covered, automatedCovered, manualCovered,
    failed, unverified, coverage_pct, verdict, strict,
  });

  return {
    total,
    covered,
    automated_covered: automatedCovered,
    manual_covered: manualCovered,
    failed,
    unverified,
    coverage_pct,
    verdict,
    reasons,
  };
}

/**
 * Evaluate a single manual criterion. Fail-closed: pass requires status==='pass'
 * AND a non-empty signoff; anything else is unverified (or failed on 'fail').
 * @param {Criterion} c
 * @returns {{state:'covered'|'failed'|'unverified', reason:string}}
 */
function evaluateManual(c) {
  const status = c.status;
  if (status === 'fail') {
    return { state: 'failed', reason: 'manual acceptance marked FAILED' };
  }
  if (status === 'pass') {
    const signoff = typeof c.signoff === 'string' ? c.signoff.trim() : '';
    if (signoff.length > 0) {
      return { state: 'covered', reason: '' };
    }
    return {
      state: 'unverified',
      reason: 'manual status "pass" but signoff missing/empty (a manual pass with no signer is not acceptance)',
    };
  }
  // 'pending', absent, or anything else -> unverified
  return {
    state: 'unverified',
    reason: status === undefined
      ? 'manual acceptance pending (no status)'
      : `manual acceptance not accepted (status=${JSON.stringify(status)})`,
  };
}

/**
 * Validate the criteria array. Throws on any structural problem (fail closed).
 * @param {unknown} criteria
 */
function validateCriteria(criteria) {
  if (!Array.isArray(criteria)) {
    throw new Error('uat: criteria must be an array');
  }
  const seen = new Set();
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`uat: criterion at index ${i} must be an object`);
    }
    if (typeof c.id !== 'string' || c.id.length === 0) {
      throw new Error(`uat: criterion at index ${i} missing string "id"`);
    }
    if (typeof c.statement !== 'string' || c.statement.length === 0) {
      throw new Error(`uat: criterion "${c.id}" missing string "statement"`);
    }
    if (typeof c.verified_by !== 'string' || c.verified_by.length === 0) {
      throw new Error(`uat: criterion "${c.id}" missing string "verified_by"`);
    }
    if (c.verified_by !== MANUAL && !TEST_REF.test(c.verified_by)) {
      throw new Error(
        `uat: criterion "${c.id}" has invalid verified_by ${JSON.stringify(c.verified_by)} ` +
        '(must be "manual" or "test:<testId>")'
      );
    }
    if (seen.has(c.id)) {
      throw new Error(`uat: duplicate criterion id "${c.id}"`);
    }
    seen.add(c.id);
  }
}

/**
 * Build plain-English summary lines for the verdict.
 * @returns {string[]}
 */
function buildReasons(s) {
  const reasons = [];
  reasons.push(
    `${s.covered}/${s.total} acceptance criteria covered (${s.coverage_pct.toFixed(1)}%): ` +
    `${s.automatedCovered} automated, ${s.manualCovered} manual.`
  );
  for (const f of s.failed) {
    reasons.push(`FAILED ${f.id}: ${f.reason}`);
  }
  for (const u of s.unverified) {
    const lead = s.strict ? 'UNVERIFIED (strict -> FAIL)' : 'UNVERIFIED (flag)';
    reasons.push(`${lead} ${u.id}: ${u.reason}`);
  }
  if (s.verdict === PASS) {
    reasons.push('All acceptance criteria are covered. UAT PASS.');
  } else if (s.verdict === FLAG) {
    reasons.push(
      `${s.unverified.length} criterion(s) unverified; non-strict mode flags rather than fails. UAT FLAG.`
    );
  } else {
    reasons.push('UAT FAIL: release is not accepted.');
  }
  return reasons;
}

/**
 * Small, constrained YAML parser for the UAT spec file. Supports exactly:
 *
 *   criteria:
 *     - id: AC-1
 *       statement: "User can log in with valid credentials"
 *       verified_by: "test:auth.login.valid"
 *     - id: AC-2
 *       statement: "Refund posts within one billing cycle"
 *       verified_by: manual
 *       status: pass
 *       signoff: "Jane Doe <jane@finexio.com>"
 *
 * Rules: top-level key `criteria:` then list items at indent 2 ("- key: val"),
 * continuation keys at indent 4. Values may be bare or double-quoted; surrounding
 * double quotes are stripped. Unknown top-level keys are ignored. Throws on
 * malformed structure. Nothing exotic (no nested lists, anchors, multiline, etc).
 *
 * @param {string} text
 * @returns {{ criteria: Criterion[] }}
 */
function parseUatYaml(text) {
  if (typeof text !== 'string') {
    throw new Error('uat: parseUatYaml requires a string');
  }
  // Strip a leading UTF-8 BOM so the first line still matches `criteria:` at
  // indent 0 (a BOM would otherwise look like a leading character and the key
  // would never be recognized -> silent zero criteria).
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rawLines = stripped.split(/\r\n|\r|\n/);

  let inCriteria = false;
  let sawCriteriaKey = false; // a `criteria:` key was found at any point
  let criteriaTopIndent = -1; // indent of the `criteria:` key
  const criteria = [];
  let current = null;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    // strip a trailing full-line comment / blank lines (keep it tight: only
    // skip lines that are blank or start with # after their indentation).
    const noTab = raw.replace(/\t/g, '  '); // tabs are ambiguous; normalize to 2 spaces
    if (noTab.trim() === '' || /^\s*#/.test(noTab)) {
      continue;
    }
    const indent = noTab.length - noTab.replace(/^ +/, '').length;
    const content = noTab.slice(indent);

    if (!inCriteria) {
      // looking for a top-level `criteria:` key (indent 0)
      if (indent === 0 && /^criteria:\s*$/.test(content)) {
        inCriteria = true;
        sawCriteriaKey = true;
        criteriaTopIndent = indent;
        continue;
      }
      // ignore other top-level keys (e.g. "version: 1"); but a stray list item
      // or bad indent before criteria is just ignored as an unknown top key.
      continue;
    }

    // We are inside the criteria block.
    // A new top-level key at the same indent as `criteria:` ends the block.
    if (indent <= criteriaTopIndent && !content.startsWith('-')) {
      // unknown top-level key after criteria; criteria block is done.
      inCriteria = false;
      criteriaTopIndent = -1;
      continue;
    }

    if (indent === 2 && content.startsWith('- ')) {
      // new list item: "- id: AC-1"
      current = {};
      criteria.push(current);
      const after = content.slice(2); // strip "- "
      const { key, value } = splitKeyValue(after, i);
      current[key] = value;
      continue;
    }

    if (indent === 4 && current) {
      // continuation key for the current item: "statement: ..."
      const { key, value } = splitKeyValue(content, i);
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        throw new Error(`uat: duplicate key "${key}" in criterion on line ${i + 1}`);
      }
      current[key] = value;
      continue;
    }

    throw new Error(
      `uat: malformed UAT spec on line ${i + 1}: unexpected indent ${indent} / content ${JSON.stringify(content)}`
    );
  }

  // Fail closed on a non-empty file that yielded nothing. A parse miss (typo'd
  // top-level key, wrong indentation that skipped the list, an empty `criteria:`
  // block) must NOT silently produce zero criteria — that would turn a parse
  // failure into a green gate (0 criteria -> 100% coverage -> PASS).
  if (stripped.trim().length > 0) {
    if (!sawCriteriaKey) {
      throw new Error(
        'uat: spec has no "criteria:" list (a non-empty UAT spec must declare a top-level "criteria:" key)'
      );
    }
    if (criteria.length === 0) {
      throw new Error('uat: "criteria:" block parsed to zero items');
    }
  }

  // Defense-in-depth: validate structure at load time, not only at evaluate
  // time, so a caller that bypasses evaluateUat still gets a checked spec.
  validateCriteria(criteria);

  return { criteria };
}

/**
 * Split "key: value" into { key, value }, stripping surrounding double quotes
 * from the value. Throws if there is no colon.
 * @param {string} s
 * @param {number} lineIdx  zero-based line index, for error messages
 * @returns {{key:string, value:string}}
 */
function splitKeyValue(s, lineIdx) {
  const colon = s.indexOf(':');
  if (colon === -1) {
    throw new Error(`uat: malformed "key: value" on line ${lineIdx + 1}: ${JSON.stringify(s)}`);
  }
  const key = s.slice(0, colon).trim();
  if (key.length === 0) {
    throw new Error(`uat: empty key on line ${lineIdx + 1}`);
  }
  let value = s.slice(colon + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/**
 * Load a UAT spec from text. JSON if the filename ends in ".json" OR the trimmed
 * text starts with "{"; otherwise the constrained YAML parser. Validates the
 * criteria structure at load time (fail-closed) in BOTH branches; evaluateUat
 * re-validates idempotently.
 *
 * @param {string} text
 * @param {string=} filename
 * @returns {{ criteria: Criterion[] }}
 */
function loadUatSpec(text, filename) {
  if (typeof text !== 'string') {
    throw new Error('uat: loadUatSpec requires a string');
  }
  const isJsonByName = typeof filename === 'string' && /\.json$/i.test(filename);
  const isJsonByShape = text.trim().startsWith('{');
  if (isJsonByName || isJsonByShape) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error(`uat: invalid JSON UAT spec: ${e.message}`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('uat: JSON UAT spec must be an object with a "criteria" array');
    }
    const criteria = Array.isArray(obj.criteria) ? obj.criteria : null;
    if (criteria === null) {
      throw new Error('uat: JSON UAT spec must have a "criteria" array');
    }
    // Defense-in-depth: validate at load time, not only at evaluate time.
    validateCriteria(criteria);
    return { criteria };
  }
  // parseUatYaml validates internally.
  return parseUatYaml(text);
}

/**
 * Render a human-readable UAT report: a per-criterion status table plus the
 * coverage summary and any gaps. Deterministic.
 *
 * @param {UatResult} result
 * @returns {string}
 */
function renderUatReport(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('uat: renderUatReport requires a result object');
  }

  const lines = [];
  lines.push(`UAT ${result.verdict} — ${result.covered}/${result.total} criteria covered (${result.coverage_pct.toFixed(1)}%)`);
  lines.push(`  automated: ${result.automated_covered}   manual: ${result.manual_covered}   failed: ${result.failed.length}   unverified: ${result.unverified.length}`);
  lines.push('');

  // The result carries failed + unverified by id (the gaps reviewers act on);
  // covered criteria are summarized by count in the header. List every gap id
  // with its status and detail.
  const rows = [];
  for (const f of result.failed || []) {
    rows.push({ id: f.id, status: 'FAILED', detail: f.reason, statement: f.statement });
  }
  for (const u of result.unverified || []) {
    rows.push({ id: u.id, status: 'UNVERIFIED', detail: u.reason, statement: u.statement });
  }

  if (rows.length === 0) {
    lines.push('All criteria covered. No gaps.');
  } else {
    lines.push('Gaps (action required):');
    const idWidth = Math.max(2, ...rows.map((r) => r.id.length));
    const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));
    for (const r of rows) {
      lines.push(
        `  ${r.id.padEnd(idWidth)}  ${r.status.padEnd(statusWidth)}  ${r.statement}`
      );
      lines.push(`  ${' '.repeat(idWidth)}  ${' '.repeat(statusWidth)}  -> ${r.detail}`);
    }
  }

  lines.push('');
  lines.push('Summary:');
  for (const reason of result.reasons || []) {
    lines.push(`  - ${reason}`);
  }

  return lines.join('\n');
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = {
  evaluateUat,
  parseUatYaml,
  loadUatSpec,
  renderUatReport,
  PASS,
  FLAG,
  FAIL,
};
