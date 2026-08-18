'use strict';

/**
 * fqe receipt signing (v0.16, A3).
 *
 * The content_hash makes a receipt TAMPER-EVIDENT (you can tell it changed). A bare hash
 * does NOT prove WHO produced it: anyone can recompute the hash over edited content. For a
 * receipt an auditor (SOC2 / PCI) is meant to trust, the receipt must be SIGNED.
 *
 * Two layers:
 *   - HMAC-SHA256 (this file): symmetric, deterministic, testable offline. Proves the
 *     signer held the shared secret (the CI runner's FQE_SIGNING_KEY). Closes "anyone can
 *     recompute the hash" — now you also need the key.
 *   - Sigstore keyless (CI workflow step, see docs/recipes/receipt-signing.md): asymmetric,
 *     OIDC-identity-bound, logged to a transparency log. The non-repudiation answer. It runs
 *     in GitHub Actions where the OIDC token exists; this module's verify path is the offline
 *     deterministic layer.
 *
 * Pure: no fs, no network, no clock. The caller passes signed_at (e.g. the receipt's
 * finished_at) so signing stays deterministic. The signature is computed over a stable
 * serialization of the receipt with the `signature` field EXCLUDED.
 */

const crypto = require('node:crypto');

const ALG = 'hmac-sha256';

// The signature binds these fields. content_hash already covers EVERY file at the commit,
// and inputs_hash covers the runner configs, so this tuple authenticates the full claim:
// "at this commit, over this content, with these inputs, the verdict was X." Signing a
// fixed scalar tuple (rather than the whole object) is robust against YAML round-trip drift
// on verify, where a re-parsed nested field could differ by formatting and break the MAC.
// `bypass` is included because it records HUMAN AUTHORITY to override a FAIL — if it were
// unsigned, a signed receipt's authorization could be forged post-signing. It is an all-string
// object (or null), so it round-trips faithfully. verdict_reasons and runners are NOT signed:
// they are human-readable evidence, reproducible by re-running fqe, and signing nested numeric
// arrays risks YAML round-trip drift. The recipe documents this scope explicitly.
// `diff_scope` IS signed. It is the field that distinguishes "clean because
// nothing was wrong" from "clean because nothing was evaluated", so leaving it
// outside the MAC would let anyone who can rewrite a receipt after signing forge
// exactly the claim it exists to make. Like `bypass`, it is a small object of
// scalars (strings, an integer, booleans, nulls) and round-trips faithfully.
const SIGNED_FIELDS = Object.freeze(['schema_version', 'fqe_version', 'commit_sha', 'content_hash', 'inputs_hash', 'verdict', 'bypass', 'diff_scope']);

// Every field name that has EVER been part of a signed tuple. Used to sanity-check
// a receipt's self-declared `covers` before honouring it.
const KNOWN_SIGNABLE = new Set(['schema_version', 'fqe_version', 'commit_sha', 'content_hash', 'inputs_hash', 'verdict', 'bypass', 'diff_scope']);

/**
 * Deterministic JSON: object keys sorted recursively, so the same logical receipt always
 * serializes identically regardless of key insertion order.
 */
function stableStringify(v) {
  if (v === undefined) return 'null'; // match the signedPayload null-sentinel; never emit invalid JSON
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** Non-secret fingerprint of a key, so a receipt records WHICH key signed it. */
function keyIdOf(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 12);
}

/**
 * The payload that gets signed.
 *
 * `fields` MUST be honoured when verifying an existing receipt, because the
 * signed tuple can grow between versions. Adding `diff_scope` to SIGNED_FIELDS
 * without this made every receipt signed by an earlier fqe verify as
 * "signature mismatch (receipt was tampered...)" - a legitimate, untampered,
 * in-retention artifact reported as forged, by the tool whose entire product is
 * tamper-evidence, under a scaffold that keeps receipts for 365 days.
 *
 * `signature.covers` was already being WRITTEN for exactly this purpose and was
 * never read back. It is now the authority on verify.
 */
function signedPayload(receipt, fields) {
  const use = Array.isArray(fields) && fields.length ? fields : SIGNED_FIELDS;
  const o = {};
  for (const k of use) o[k] = receipt[k] === undefined ? null : receipt[k];
  return stableStringify(o);
}

/**
 * Sign a receipt with an HMAC-SHA256 key. Returns a NEW receipt object with a `signature`
 * block. Deterministic given (receipt, key, signedAt).
 * @param {object} receipt
 * @param {string} key       a non-empty signing key
 * @param {string} [signedAt] ISO timestamp (metadata; not part of the signed payload)
 */
function signReceipt(receipt, key, signedAt) {
  if (!receipt || typeof receipt !== 'object') throw new Error('signReceipt: receipt must be an object');
  if (typeof key !== 'string' || key.length === 0) throw new Error('signReceipt: a non-empty signing key is required');
  const value = crypto.createHmac('sha256', key).update(signedPayload(receipt), 'utf8').digest('hex');
  const out = {};
  for (const k of Object.keys(receipt)) {
    if (k !== 'signature') out[k] = receipt[k];
  }
  out.signature = { alg: ALG, value, key_id: keyIdOf(key), signed_at: signedAt || null, covers: [...SIGNED_FIELDS] };
  return out;
}

/**
 * Verify a receipt's HMAC signature. Fail CLOSED: a missing signature, an unsupported alg,
 * a missing key, or any tamper to a signed field returns ok:false.
 * @returns {{ ok: boolean, reason?: string, key_id?: string }}
 */
function verifyReceipt(receipt, key) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'receipt is not an object' };
  const sig = receipt.signature;
  if (!sig || typeof sig !== 'object') return { ok: false, reason: 'no signature present' };
  if (sig.alg !== ALG) return { ok: false, reason: `unsupported signature alg '${sig.alg}'` };
  if (typeof key !== 'string' || key.length === 0) return { ok: false, reason: 'no verification key provided' };
  // Verify over the field list the receipt was ACTUALLY signed with. Forging a
  // shorter `covers` to dodge a field does not help an attacker: changing it
  // changes the payload, and producing a matching MAC still requires the key.
  // Every name must be one we know, so a malformed list cannot smuggle in
  // arbitrary keys.
  const covers = Array.isArray(sig.covers) && sig.covers.length
    && sig.covers.every((f) => KNOWN_SIGNABLE.has(f))
    ? sig.covers
    : SIGNED_FIELDS;
  const expected = crypto.createHmac('sha256', key).update(signedPayload(receipt, covers), 'utf8').digest('hex');
  const got = typeof sig.value === 'string' ? sig.value : '';
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  const match = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  if (!match) return { ok: false, reason: 'signature mismatch (receipt was tampered, or signed with a different key)' };

  // WHAT THE SIGNATURE DOES NOT COVER. Honouring `covers` fixes verification of
  // receipts signed before a field existed, but it also means those receipts
  // never had that field in their MAC - so it can be rewritten freely, with the
  // signature block untouched, and still verify. Proven: a legacy-covers receipt
  // with a fabricated diff_scope bolted on returns ok:true. No forgery of
  // `covers` is needed, which is why "shrinking covers breaks the MAC" was never
  // the relevant defence.
  //
  // The honest answer is not to fail the receipt (it IS authentic for what it
  // covers) but to stop reporting a bare OK. A caller that trusts diff_scope
  // must be able to see whether diff_scope was actually signed.
  const unsigned = SIGNED_FIELDS.filter((f) => receipt[f] !== undefined && !covers.includes(f));
  // key_id is ALWAYS written by signReceipt, so its absence (or a wrong value) after parse is
  // itself a tamper signal. Check unconditionally (fail closed), do not skip when absent.
  if (sig.key_id !== keyIdOf(key)) {
    return { ok: false, reason: 'key_id missing or does not match the verification key' };
  }
  return {
    ok: true,
    key_id: sig.key_id,
    covers: [...covers],
    // Non-empty means the receipt carries these fields but its signature never
    // authenticated them. Callers MUST NOT treat their values as trustworthy.
    unsigned_fields: unsigned,
  };
}

module.exports = { signReceipt, verifyReceipt, keyIdOf, stableStringify, ALG, SIGNED_FIELDS };
