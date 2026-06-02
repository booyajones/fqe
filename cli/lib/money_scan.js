'use strict';

/**
 * fqe money-path heuristic (v0.15, A4 + F9).
 *
 * A4: discover.js finds test FRAMEWORKS, not money CODE. A payments repo onboarded
 * without a money policy gets the loose bar silently. This module detects money-LOOKING
 * code in the diff (by path and by keyword) so the gate can FLAG it loudly (or FAIL it
 * under require_money_policy_when_detected) when no money policy is configured.
 *
 * F9: a policy.require_for `when` glob that matches NO file in the repo silently grants
 * the loose bar (a typo'd payments path). findDeadRequireForGlobs surfaces those.
 *
 * Pure: no fs, no clock, no network. The orchestrator reads file contents and supplies
 * them; this module only inspects strings. It fails LOUD (toward "tell the human"), never
 * silently assumes a repo is safe. It does NOT define hasMoneyPolicy: that single source
 * of truth lives in config_schema.js and the orchestrator imports it from there.
 */

// Path segments that strongly imply money movement or reconciliation.
const MONEY_PATH_GLOBS = Object.freeze([
  '**/ledger/**', '**/payment*/**', '**/billing/**', '**/settlement*/**', '**/invoice*/**', '**/payout*/**',
]);
// Matcher for the globs above, applied to a normalized path. Conservative on purpose:
// a money segment must appear as a path component (bounded by / or . or _ or -), so
// "src/components/PaymentButton.tsx" hits but "src/deployment/x.ts" does not.
const MONEY_PATH_RE = /(^|\/)(ledger|ledgers|payment|payments|billing|settlement|settlements|invoice|invoices|payout|payouts)([\/._-]|$)/i;

// Keyword stems that imply money logic. Left-bounded by a non-letter (so "debited"
// matches "debit"); loose on the right (stems match longer words). Documented intent.
const MONEY_KEYWORDS = Object.freeze([
  'idempoten', 'debit', 'credit', 'settle', 'reconcil', 'chargeback', 'payout',
  'invoice', 'ledger', 'double-spend', 'no-negative-balance', 'remittance', 'disbursement',
]);
// A negative lookbehind is atomic on the left boundary, so there is no catastrophic
// backtracking on a large/adversarial file (the prior `(?:^|[^a-zA-Z])` alternation could
// backtrack O(n^2) on repeated near-prefixes). Left-bounded, loose on the right.
const KEYWORD_RE = new RegExp('(?<![a-zA-Z])(' + MONEY_KEYWORDS.join('|') + ')', 'i');

// Only source files are keyword-scanned. Docs/markdown/images are not money code.
const SCANNABLE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.cs', '.php', '.sql', '.kt', '.scala',
]);

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}
function extOf(p) {
  const s = normalize(p);
  const dot = s.lastIndexOf('.');
  const slash = s.lastIndexOf('/');
  return dot > slash && dot >= 0 ? s.slice(dot).toLowerCase() : '';
}

/**
 * Detect money-looking code in the changed file set.
 * @param {object} o
 * @param {string[]} o.changedFiles
 * @param {Record<string,string>} [o.fileContents]  path -> text (source files only)
 * @param {boolean} [o.diffIndeterminate]  the diff could not be read; fail closed
 * @returns {{ detected:boolean, indeterminate:boolean, pathHits:string[], keywordHits:Array<{file:string,keyword:string}> }}
 */
function detectMoneyPaths(o) {
  const opts = o || {};
  // Cannot scan a blind diff. Report indeterminate but do NOT CLAIM money is present:
  // the blind-diff money risk for a repo WITH a policy is already handled fail-closed by
  // the orchestrator's require_for activation. Claiming "detected" here would FLAG every
  // no-money repo on an unreadable diff (pure noise). Detection is by real signal only.
  if (opts.diffIndeterminate === true) {
    return { detected: false, indeterminate: true, pathHits: [], keywordHits: [] };
  }
  const files = Array.isArray(opts.changedFiles) ? opts.changedFiles : [];
  const contents = opts.fileContents && typeof opts.fileContents === 'object' ? opts.fileContents : {};
  const pathHits = [];
  const keywordHits = [];
  for (const f of files) {
    if (MONEY_PATH_RE.test(normalize(f))) pathHits.push(f);
    if (SCANNABLE_EXT.has(extOf(f))) {
      const text = contents[f];
      if (typeof text === 'string') {
        const m = text.match(KEYWORD_RE);
        if (m) keywordHits.push({ file: f, keyword: (m[1] || '').toLowerCase() });
      }
    }
  }
  return { detected: pathHits.length > 0 || keywordHits.length > 0, indeterminate: false, pathHits, keywordHits };
}

/**
 * Find policy.require_for `when` globs that match no file in the repo (F9).
 * Returns [] when there are no repo files to compare against (cannot judge, do not
 * false-flag). Uses the orchestrator's own fileMatches so "dead" means exactly "this
 * glob would never fire", matching the policy engine's semantics.
 * @returns {Array<{index:number, glob:string}>}
 */
function findDeadRequireForGlobs(o) {
  const opts = o || {};
  const policy = opts.policy;
  const repoFiles = Array.isArray(opts.repoFiles) ? opts.repoFiles : [];
  const fileMatches = typeof opts.fileMatches === 'function' ? opts.fileMatches : null;
  const dead = [];
  if (!fileMatches || repoFiles.length === 0) return dead;
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.require_for)) return dead;
  policy.require_for.forEach((entry, index) => {
    if (!entry || !Array.isArray(entry.when)) return;
    for (const glob of entry.when) {
      if (typeof glob !== 'string') continue;
      const hitsSomething = repoFiles.some((f) => fileMatches(f, glob));
      if (!hitsSomething) dead.push({ index, glob });
    }
  });
  return dead;
}

module.exports = {
  detectMoneyPaths, findDeadRequireForGlobs,
  MONEY_PATH_GLOBS, MONEY_KEYWORDS, SCANNABLE_EXT, MONEY_PATH_RE, KEYWORD_RE,
};
