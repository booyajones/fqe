'use strict';

/**
 * fqe double-entry money reconciliation backstop — DETERMINISTIC + FAIL-CLOSED.
 *
 * This is the runtime money HALT. Coverage, mutation testing, and the verdict
 * gate all judge the *tests*. This judges the *ledger itself*: it re-derives
 * the double-entry invariant (sum of debits == sum of credits, per-transaction
 * AND in aggregate) from the raw entries and refuses to let a books-don't-
 * balance state pass. There is no LLM anywhere in this path; the same ledger
 * always produces the same verdict.
 *
 * Money is handled in INTEGER MINOR UNITS (cents) only. Floats are rejected at
 * the door — a float cents value is a category error in a reconciliation
 * engine and silently absorbing it (via rounding) is exactly how a penny of
 * drift hides a real defalcation. We throw instead.
 *
 * Time ('now') is PASSED IN as an ISO string. The evaluator never reads the
 * system clock, so a given (ledger, now) pair is reproducible forever.
 *
 * Fail-closed contract (these THROW, they do not return an unbalanced result):
 *   - missing/!array `entries`
 *   - a cents value that is not a finite integer (incl. floats like 10.5)
 *   - a negative cents value
 *   - an entry with BOTH debit and credit > 0, or NEITHER > 0
 *
 * HALT contract (these FAIL the verdict, books do not balance):
 *   - aggregate debits/credits drift exceeds the threshold
 *   - any per-transaction debit/credit imbalance
 *   - any orphaned authorization (not voided, under-captured, expired)
 */

const PASS = 'PASS';
const FAIL = 'FAIL';

/**
 * Assert a value is a non-negative integer count of minor units (cents).
 * Throws on float, NaN, Infinity, negative, or non-number. This is the single
 * choke point that keeps floats out of the money math.
 * @param {*} v
 * @param {string} label  for the error message (e.g. 'entry[3].debitCents')
 * @returns {number} the validated integer
 */
function assertCents(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`reconcile: ${label} must be a finite number (got ${JSON.stringify(v)})`);
  }
  if (!Number.isInteger(v)) {
    throw new Error(`reconcile: ${label} must be an integer number of cents, not a float (got ${v})`);
  }
  // fqe-fix: reject values beyond the IEEE-754 safe-integer range. Past 2^53 a JS
  // number can no longer represent every integer, so cents math (and therefore
  // the reconciliation verdict) would be silently wrong. Fail closed.
  if (!Number.isSafeInteger(v)) {
    throw new Error(`reconcile: ${label} exceeds the safe-integer range (got ${v}); cents math would lose precision`);
  }
  if (v < 0) {
    throw new Error(`reconcile: ${label} must be non-negative (got ${v})`);
  }
  return v;
}

/**
 * Parse an ISO timestamp to epoch ms, REQUIRING an explicit timezone designator
 * (Z or +/-HH:MM). fqe-fix: a bare local-time ISO string makes Date.parse
 * machine/timezone-dependent, which would make the expiry/orphan verdict
 * non-deterministic across runners. Fail closed on a timezone-less string.
 */
function parseIsoStrict(s, label) {
  if (typeof s !== 'string') {
    throw new Error(`reconcile: ${label} must be an ISO date string (got ${JSON.stringify(s)})`);
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    throw new Error(`reconcile: ${label} must include a timezone (e.g. ...Z or +00:00) so the verdict is deterministic; got ${JSON.stringify(s)}`);
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new Error(`reconcile: ${label} is not a valid ISO date string (got ${JSON.stringify(s)})`);
  }
  return ms;
}

/**
 * Reconcile a double-entry ledger and surface money-halt violations.
 *
 * @param {object} o
 * @param {Array<{txnId:string, account:string, debitCents:number, creditCents:number}>} o.entries
 *        Each entry has EXACTLY ONE of debitCents / creditCents greater than 0.
 * @param {Array<{authId:string, amountCents:number, capturedCents:number,
 *                 voided:boolean, expiresAt:string, status:string}>} [o.authorizations=[]]
 * @param {number} [o.driftThresholdCents=0]  tolerance (in cents) for aggregate
 *        debit/credit drift. Default 0 = books must tie to the penny.
 * @param {string} o.now  current time as an ISO string (NOT read from clock).
 * @returns {{
 *   balanced: boolean,
 *   drift: number,
 *   totalDebits: number,
 *   totalCredits: number,
 *   perTxnImbalances: string[],
 *   orphanAuths: Array<object>,
 *   violations: string[]
 * }}
 */
function reconcile(o) {
  if (!o || typeof o !== 'object') {
    throw new Error('reconcile: input must be an object');
  }
  const { entries, authorizations = [], driftThresholdCents = 0 } = o;

  if (!Array.isArray(entries)) {
    throw new Error('reconcile: entries must be an array');
  }
  if (authorizations != null && !Array.isArray(authorizations)) {
    throw new Error('reconcile: authorizations must be an array when provided');
  }
  assertCents(driftThresholdCents, 'driftThresholdCents');

  // 'now' must be a timezone-anchored ISO instant. Fail closed on a bad or
  // timezone-less clock value so the orphan-auth check is deterministic.
  const nowMs = parseIsoStrict(o.now, 'now');

  let totalDebits = 0;
  let totalCredits = 0;
  // Per-transaction running balance: +debit, -credit. Net 0 means balanced.
  const perTxnNet = new Map();
  // Preserve first-seen order of txnIds for a deterministic imbalance list.
  const txnOrder = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== 'object') {
      throw new Error(`reconcile: entries[${i}] must be an object`);
    }
    if (typeof e.txnId !== 'string' || e.txnId === '') {
      throw new Error(`reconcile: entries[${i}].txnId must be a non-empty string`);
    }
    const debit = assertCents(e.debitCents, `entries[${i}].debitCents`);
    const credit = assertCents(e.creditCents, `entries[${i}].creditCents`);

    // Exactly one side must be positive. Both-positive or both-zero is a
    // malformed double-entry line and is a fail-closed throw, not a "balanced".
    const debitPos = debit > 0;
    const creditPos = credit > 0;
    if (debitPos && creditPos) {
      throw new Error(`reconcile: entries[${i}] (txn ${e.txnId}) has both a debit and a credit; exactly one must be > 0`);
    }
    if (!debitPos && !creditPos) {
      throw new Error(`reconcile: entries[${i}] (txn ${e.txnId}) has neither a debit nor a credit; exactly one must be > 0`);
    }

    totalDebits += debit;
    totalCredits += credit;

    if (!perTxnNet.has(e.txnId)) {
      perTxnNet.set(e.txnId, 0);
      txnOrder.push(e.txnId);
    }
    perTxnNet.set(e.txnId, perTxnNet.get(e.txnId) + debit - credit);
  }

  // fqe-fix: even when every entry is a safe integer, their SUM can cross 2^53
  // and lose precision, which would make drift/balance wrong. Fail closed.
  if (!Number.isSafeInteger(totalDebits) || !Number.isSafeInteger(totalCredits)) {
    throw new Error(
      `reconcile: aggregate totals exceeded the safe-integer range ` +
      `(debits ${totalDebits}, credits ${totalCredits}); sums are no longer exact`
    );
  }

  const perTxnImbalances = [];
  for (const txnId of txnOrder) {
    if (perTxnNet.get(txnId) !== 0) {
      perTxnImbalances.push(txnId);
    }
  }

  const drift = Math.abs(totalDebits - totalCredits);

  // Orphan authorizations: a live (not voided) auth that was never fully
  // captured AND has already expired. That is money authorized, partially or
  // not taken, and now stranded — the classic uncaptured-auth leak.
  const orphanAuths = [];
  const overCapturedAuths = [];
  for (let i = 0; i < authorizations.length; i++) {
    const a = authorizations[i];
    if (!a || typeof a !== 'object') {
      throw new Error(`reconcile: authorizations[${i}] must be an object`);
    }
    if (typeof a.authId !== 'string' || a.authId === '') {
      throw new Error(`reconcile: authorizations[${i}].authId must be a non-empty string`);
    }
    const amount = assertCents(a.amountCents, `authorizations[${i}].amountCents`);
    const captured = assertCents(a.capturedCents, `authorizations[${i}].capturedCents`);
    if (typeof a.voided !== 'boolean') {
      throw new Error(`reconcile: authorizations[${i}] (auth ${a.authId}) voided must be a boolean`);
    }
    const expMs = parseIsoStrict(a.expiresAt, `authorizations[${i}] (auth ${a.authId}) expiresAt`);

    const underCaptured = captured < amount;
    const overCaptured = captured > amount;
    // fqe-fix: expiry AT the evaluation instant counts as expired (the epoch has
    // passed). Strict < let a token expiring exactly at `now` slip through.
    const expired = expMs <= nowMs;
    if (!a.voided && underCaptured && expired) {
      orphanAuths.push(a);
    }
    // fqe-fix: over-capture (captured more than authorized) is a funds error that
    // must HALT regardless of void/expiry. Charging a card beyond its authorization
    // is never acceptable.
    if (overCaptured) {
      overCapturedAuths.push(a);
    }
  }

  const driftWithinThreshold = drift <= driftThresholdCents;
  const balanced = driftWithinThreshold && perTxnImbalances.length === 0;

  const violations = [];
  if (!driftWithinThreshold) {
    violations.push(
      `LEDGER_DRIFT: debits ${totalDebits} vs credits ${totalCredits} differ by ${drift} cent(s), ` +
      `exceeding the ${driftThresholdCents}-cent tolerance. Books do not balance.`
    );
  }
  if (perTxnImbalances.length > 0) {
    violations.push(
      `PER_TXN_IMBALANCE: ${perTxnImbalances.length} transaction(s) have debits != credits ` +
      `[${perTxnImbalances.join(', ')}]. A globally balanced ledger can still hide a per-txn break.`
    );
  }
  if (orphanAuths.length > 0) {
    violations.push(
      `ORPHAN_AUTH: ${orphanAuths.length} authorization(s) are live, under-captured, and expired ` +
      `[${orphanAuths.map((a) => a.authId).join(', ')}]. Funds authorized but stranded.`
    );
  }
  if (overCapturedAuths.length > 0) {
    violations.push(
      `OVER_CAPTURE: ${overCapturedAuths.length} authorization(s) captured MORE than authorized ` +
      `[${overCapturedAuths.map((a) => a.authId).join(', ')}]. Charging beyond authorization is a funds error.`
    );
  }

  return {
    balanced,
    drift,
    totalDebits,
    totalCredits,
    perTxnImbalances,
    orphanAuths,
    overCapturedAuths,
    violations,
  };
}

/**
 * Turn a reconcile() result into a HALT verdict.
 * FAIL (HALT) if the ledger is not balanced OR any orphan auth exists.
 * @param {ReturnType<typeof reconcile>} result
 * @returns {{ verdict: 'PASS'|'FAIL', reasons: string[] }}
 */
function evaluateReconciliation(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('reconcile: evaluateReconciliation requires a reconcile() result object');
  }
  if (typeof result.balanced !== 'boolean' || !Array.isArray(result.orphanAuths) || !Array.isArray(result.violations)) {
    throw new Error('reconcile: evaluateReconciliation got a malformed result (missing balanced/orphanAuths/violations)');
  }
  // overCapturedAuths is newer; tolerate an older result shape but treat a
  // non-array as empty rather than crashing.
  const overCaptured = Array.isArray(result.overCapturedAuths) ? result.overCapturedAuths : [];

  const reasons = [];
  const halt = result.balanced !== true || result.orphanAuths.length > 0 || overCaptured.length > 0;

  if (halt) {
    // Surface the concrete violations the reconciler found. If for some reason
    // none were attached, still fail closed with a generic HALT reason.
    if (Array.isArray(result.violations) && result.violations.length > 0) {
      for (const v of result.violations) reasons.push(v);
    } else {
      reasons.push('MONEY_HALT: ledger failed reconciliation (unbalanced or orphaned authorization)');
    }
  }

  return { verdict: halt ? FAIL : PASS, reasons };
}

module.exports = { reconcile, evaluateReconciliation, assertCents, PASS, FAIL };
