'use strict';

/**
 * Tests for the bypass guard (cli/lib/bypass_guard.js).
 *
 * This is the most security-sensitive function in fqe, so the matrix leans on
 * the FAIL paths: every way a bypass should be refused must be refused, and the
 * one valid path must be tight. The binding is SHA equality (the comment names
 * the exact head SHA it authorizes), so a stale SHA is the load-bearing reject.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBypass, TTL_HOURS } = require('../lib/bypass_guard');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ALLOW = ['maintainer1', 'maintainer2'];

function comment(over = {}) {
  return {
    user_login: 'maintainer1',
    created_at: '2026-05-29T10:00:00Z',
    updated_at: '2026-05-29T10:00:00Z',
    body: `/fqe-bypass ${HEAD} 24h`,
    ...over,
  };
}

function base(over = {}) {
  return {
    comments: [comment()],
    headSha: HEAD,
    allowlist: ALLOW,
    now: '2026-05-29T12:00:00Z', // 2h after the comment
    ...over,
  };
}

// ── the one valid path ───────────────────────────────────────────────────────

test('valid: fresh SHA-bound comment by an allowlisted maintainer -> bypass', () => {
  const r = evaluateBypass(base());
  assert.equal(r.bypass, true);
  assert.equal(r.actor, 'maintainer1');
  assert.equal(r.ttl, '24h');
  assert.equal(r.head_sha, HEAD);
  assert.equal(r.expires_at, '2026-05-30T10:00:00.000Z');
  assert.match(r.reason, /BYPASS_OK/);
});

test('valid exactly at the TTL boundary still passes', () => {
  const r = evaluateBypass(base({ now: '2026-05-30T10:00:00Z' })); // exactly 24h
  assert.equal(r.bypass, true);
});

test('48h and 72h tokens are honored', () => {
  assert.equal(evaluateBypass(base({ comments: [comment({ body: `/fqe-bypass ${HEAD} 48h` })] })).bypass, true);
  assert.equal(evaluateBypass(base({ comments: [comment({ body: `/fqe-bypass ${HEAD} 72h` })] })).bypass, true);
});

// ── no / malformed command ───────────────────────────────────────────────────

test('no bypass comment -> refused', () => {
  const r = evaluateBypass(base({ comments: [comment({ body: 'lgtm, merging' })] }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_NONE/);
});

test('abbreviated SHA is not matched (full 40-hex required)', () => {
  const r = evaluateBypass(base({ comments: [comment({ body: '/fqe-bypass aaaaaaa 24h' })] }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_NONE/);
});

test('command must be the first non-empty line (no quoting/injection trigger)', () => {
  const r = evaluateBypass(base({ comments: [comment({ body: `discussing whether to /fqe-bypass ${HEAD} 24h` })] }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_NONE/);
});

test('a reason on a later line is allowed (command on first line)', () => {
  const r = evaluateBypass(base({ comments: [comment({ body: `/fqe-bypass ${HEAD} 24h\nreason: prod hotfix` })] }));
  assert.equal(r.bypass, true);
});

// ── identity / allowlist / edits ─────────────────────────────────────────────

test('commenter not on the allowlist -> refused', () => {
  const r = evaluateBypass(base({ comments: [comment({ user_login: 'attacker' })] }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_NOT_ALLOWLISTED/);
});

test('edited comment (updated_at != created_at) -> refused', () => {
  const r = evaluateBypass(base({ comments: [comment({ updated_at: '2026-05-29T11:30:00Z' })] }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_EDITED/);
});

test('missing updated_at -> fail closed (edit state unverifiable)', () => {
  const r = evaluateBypass(base({ comments: [comment({ updated_at: undefined })] }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_EDITED/);
});

// ── head-SHA binding (the core of limitation #2) ─────────────────────────────

test('stale SHA: comment authorizes a different commit than current head -> refused', () => {
  const r = evaluateBypass(base({ comments: [comment({ body: `/fqe-bypass ${OTHER} 24h` })] }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_STALE_SHA/);
});

test('after a new push (head changed), the old comment no longer matches -> refused', () => {
  // comment named HEAD; head is now OTHER
  const r = evaluateBypass(base({ headSha: OTHER }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_STALE_SHA/);
});

test('bad head SHA shape -> fail closed', () => {
  const r = evaluateBypass(base({ headSha: 'deadbeef' }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_BAD_HEAD/);
});

// ── TTL ──────────────────────────────────────────────────────────────────────

test('expired past TTL -> refused', () => {
  const r = evaluateBypass(base({ now: '2026-05-30T11:00:00Z' })); // 25h, past 24h
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_EXPIRED/);
});

test('comment timestamp in the future (clock skew) -> fail closed', () => {
  const r = evaluateBypass(base({ now: '2026-05-29T09:00:00Z' }));
  assert.equal(r.bypass, false);
  assert.match(r.reason, /BYPASS_CLOCK_SKEW/);
});

// ── determinism with multiple comments ───────────────────────────────────────

test('most recent valid comment wins (newest by created_at)', () => {
  const older = comment({ created_at: '2026-05-29T10:00:00Z', updated_at: '2026-05-29T10:00:00Z', body: `/fqe-bypass ${HEAD} 24h` });
  const newer = comment({ created_at: '2026-05-29T11:00:00Z', updated_at: '2026-05-29T11:00:00Z', body: `/fqe-bypass ${HEAD} 48h`, user_login: 'maintainer2' });
  const r = evaluateBypass(base({ comments: [older, newer] }));
  assert.equal(r.bypass, true);
  assert.equal(r.actor, 'maintainer2'); // the newer one
  assert.equal(r.ttl, '48h');
});

test('a newer stale comment does not shadow an older valid one', () => {
  const olderValid = comment({ created_at: '2026-05-29T10:00:00Z', updated_at: '2026-05-29T10:00:00Z', body: `/fqe-bypass ${HEAD} 24h` });
  const newerStale = comment({ created_at: '2026-05-29T11:00:00Z', updated_at: '2026-05-29T11:00:00Z', body: `/fqe-bypass ${OTHER} 24h` });
  const r = evaluateBypass(base({ comments: [olderValid, newerStale] }));
  assert.equal(r.bypass, true); // the older valid one authorizes the current head
});

test('TTL_HOURS is the documented set', () => {
  assert.deepEqual(TTL_HOURS, { '24h': 24, '48h': 48, '72h': 72 });
});
