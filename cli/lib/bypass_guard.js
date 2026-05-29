'use strict';

/**
 * fqe bypass guard — SHA-bound, TTL-bound bypass evaluation.
 *
 * Closes SECURITY.md limitation #2. The legacy `fqe-bypass` LABEL had no TTL
 * (it persisted forever) and was not bound to the head SHA (once applied it
 * survived new pushes, so an allowlisted user could bypass a clean commit and
 * then push different code under the same bypass). For a payments company that
 * is the line an auditor and an attacker both look at first.
 *
 * Design comes from a 3-LLM council (claude + gpt + gemini chairman). The
 * winning approach abandons labels for a SHA-bound PR comment:
 *
 *     /fqe-bypass <40-char-head-sha> <24h|48h|72h>
 *
 * The binding is SHA EQUALITY, not time math. The comment names the exact head
 * SHA it authorizes. Any new push changes `pull.head.sha`, the named SHA no
 * longer matches, and the bypass evaporates with zero forgeable inputs. This is
 * stateless and deterministic.
 *
 * Everything trusted comes from the server-recorded comment object (the caller
 * fetches it from the GitHub comments API, NEVER from a PR-branch file):
 *   - identity:  comment.user.login   (checked against an out-of-branch allowlist)
 *   - TTL anchor: comment.created_at  (server time, not a forgeable commit date)
 *   - edit guard: comment.updated_at == comment.created_at (reject edited comments;
 *                 an edit is how a compromised account would repoint an old bypass)
 *
 * Fails CLOSED on everything: no match, not allowlisted, edited, wrong SHA,
 * expired, bad time, or bad head. Pure, deterministic, no LLM, no network.
 */

// Anchored, full 40-hex SHA only (no abbreviations -> no collision games),
// exact TTL token. Matched against the first non-empty line of the comment so
// a maintainer may add a reason on later lines.
const BYPASS_COMMAND_RE = /^\/fqe-bypass ([0-9a-f]{40}) (24h|48h|72h)$/;
const TTL_HOURS = Object.freeze({ '24h': 24, '48h': 48, '72h': 72 });
const LEGACY_LABEL = 'fqe-bypass';

function hoursBetween(aIso, bIso) {
  return (Date.parse(bIso) - Date.parse(aIso)) / 3600000;
}

function firstLine(body) {
  return String(body == null ? '' : body)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
}

/**
 * @param {object} o
 * @param {Array<{user_login:string, created_at:string, updated_at:string, body:string}>} o.comments
 *        PR comments from GET /repos/{o}/{r}/issues/{pr}/comments (server-recorded).
 * @param {string} o.headSha     live PR head SHA (40-hex), from GET .../pulls/{n} head.sha
 * @param {string[]} o.allowlist allowed bypass actors (read out-of-branch, at base ref)
 * @param {string} [o.now]       ISO current time (defaults to now)
 * @returns {{ bypass:boolean, actor?:string, ttl?:string, head_sha?:string,
 *             expires_at?:string, reason:string }}
 */
function evaluateBypass(o) {
  o = o || {};
  const comments = Array.isArray(o.comments) ? o.comments : [];
  const now = o.now || new Date().toISOString();

  if (!/^[a-f0-9]{40}$/.test(o.headSha || '')) {
    return { bypass: false, reason: 'BYPASS_BAD_HEAD: live head SHA missing or not 40-hex; failing closed.' };
  }

  // Candidate bypass comments, newest first (created_at desc). The most recent
  // VALID one wins (deterministic ordering, no ambiguity).
  const candidates = comments
    .map((c) => ({ c, m: firstLine(c && c.body).match(BYPASS_COMMAND_RE) }))
    .filter((x) => x.m)
    .sort((a, b) => Date.parse(b.c.created_at) - Date.parse(a.c.created_at));

  if (candidates.length === 0) {
    return { bypass: false, reason: 'BYPASS_NONE: no `/fqe-bypass <40-hex-sha> <24h|48h|72h>` comment found.' };
  }

  let topReason = null; // reason from the newest candidate, for the diagnostic
  for (const { c, m } of candidates) {
    const sha = m[1];
    const ttlToken = m[2];
    const ttlHours = TTL_HOURS[ttlToken];
    const reason = refuse(c, sha, ttlHours, ttlToken, o.allowlist, o.headSha, now);
    if (reason === null) {
      const expiresAt = new Date(Date.parse(c.created_at) + ttlHours * 3600000).toISOString();
      const remaining = (ttlHours - hoursBetween(c.created_at, now)).toFixed(1);
      return {
        bypass: true,
        actor: c.user_login,
        ttl: ttlToken,
        head_sha: o.headSha,
        expires_at: expiresAt,
        reason: `BYPASS_OK: by ${c.user_login}, ${ttlToken}, bound to ${o.headSha.slice(0, 12)}, ${remaining}h remaining.`,
      };
    }
    if (topReason === null) topReason = reason; // newest candidate's reason
  }
  return { bypass: false, reason: topReason };
}

/**
 * Returns null if the comment is a valid bypass for this head, else a reason.
 */
function refuse(c, sha, ttlHours, ttlToken, allowlist, headSha, now) {
  // Edited comments are rejected: an edit is how a compromised allowlisted
  // account would repoint an old bypass at a new SHA. Fail CLOSED if the edit
  // state cannot be verified (a missing created_at/updated_at): an
  // unverifiable comment must not be treated as unedited.
  if (!c.created_at || !c.updated_at || c.updated_at !== c.created_at) {
    return `BYPASS_EDITED: the /fqe-bypass comment by '${c.user_login}' was edited or its timestamps are missing/unverifiable; rejected.`;
  }
  if (!Array.isArray(allowlist) || !allowlist.includes(c.user_login)) {
    return `BYPASS_NOT_ALLOWLISTED: '${c.user_login}' is not on the bypass allowlist.`;
  }
  // Head-SHA binding: SHA equality is the binding. A new push changes head.
  if (sha !== headSha) {
    return (
      `BYPASS_STALE_SHA: comment authorizes ${sha.slice(0, 12)}, current head is ${headSha.slice(0, 12)}. ` +
      `New code was pushed after the bypass. Post a fresh /fqe-bypass for the new head SHA.`
    );
  }
  const age = hoursBetween(c.created_at, now);
  if (!Number.isFinite(age)) return 'BYPASS_BAD_TIME: comment created_at or current time is unparseable.';
  if (age < 0) return 'BYPASS_CLOCK_SKEW: comment created_at is in the future; failing closed.';
  if (age > ttlHours) {
    return `BYPASS_EXPIRED: comment is ${age.toFixed(1)}h old, past its ${ttlToken} TTL. Post a fresh /fqe-bypass.`;
  }
  return null;
}

module.exports = { evaluateBypass, BYPASS_COMMAND_RE, TTL_HOURS, LEGACY_LABEL };
