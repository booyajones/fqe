'use strict';

/**
 * receipt.js tests.
 *
 * Critical assertions:
 *   - hashFiles is deterministic and order-independent
 *   - buildReceipt rejects malformed commit_sha + content_hash + verdict
 *   - buildReceipt REJECTS bypass with requester_source != github_events_api_v3
 *     (the v5 attacker-identity flaw)
 *   - serialize/parse round-trip preserves verdict + commit_sha + bypass
 *   - parseReceiptYaml rejects schema_version mismatch
 *
 * Run with: node --test test/receipt.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  hashFiles, hashString, buildReceipt, serializeReceipt,
  parseReceiptYaml, writeReceiptFiles, SCHEMA_VERSION, REQUESTER_SOURCE_OK,
} = require('../lib/receipt');

// ─── Helpers ────────────────────────────────────────────────────────────

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function validCtx(overrides = {}) {
  return {
    fqe_version: '0.1.0',
    run_id: '11f9c0-test',
    started_at: '2026-05-22T23:34:17Z',
    finished_at: '2026-05-22T23:35:42Z',
    commit_sha: 'a3f2c891b5e7d8f9012345678901234567890abc',
    content_hash: 'sha256:' + 'a'.repeat(64),
    inputs_hash: 'sha256:' + 'b'.repeat(64),
    classifier_version: 1,
    runner_versions: { fqe: '0.1.0', openpyxl: '3.1.5' },
    runners_fired: ['web', 'outbound'],
    runners: [
      { name: 'web', required: true, ran: true, exit_code: 0 },
      { name: 'outbound', required: true, ran: true, exit_code: 0 },
    ],
    adversarial_stats: [],
    quarantined_tests: [],
    verdict: 'PASS',
    verdict_reasons: [],
    bypass: null,
    evidence_paths: [],
    ...overrides,
  };
}

// ─── hashFiles ──────────────────────────────────────────────────────────

test('hashFiles is deterministic across calls', () => {
  const a = tmpFile('a.txt', 'hello');
  const b = tmpFile('b.txt', 'world');
  const h1 = hashFiles([a, b]);
  const h2 = hashFiles([a, b]);
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[a-f0-9]{64}$/);
});

test('hashFiles is order-independent', () => {
  const a = tmpFile('a.txt', 'hello');
  const b = tmpFile('b.txt', 'world');
  assert.equal(hashFiles([a, b]), hashFiles([b, a]));
});

test('hashFiles output changes when content changes', () => {
  const a1 = tmpFile('a1.txt', 'one');
  const a2 = tmpFile('a2.txt', 'two');
  assert.notEqual(hashFiles([a1]), hashFiles([a2]));
});

test('hashString is deterministic', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});

// ─── buildReceipt validation ────────────────────────────────────────────

test('buildReceipt accepts valid ctx', () => {
  const r = buildReceipt(validCtx());
  assert.equal(r.schema_version, SCHEMA_VERSION);
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.commit_sha.length, 40);
});

test('buildReceipt rejects short commit_sha', () => {
  assert.throws(() => buildReceipt(validCtx({ commit_sha: 'abc123' })));
});

test('buildReceipt rejects non-hex commit_sha', () => {
  assert.throws(() => buildReceipt(validCtx({ commit_sha: 'g'.repeat(40) })));
});

test('buildReceipt rejects malformed content_hash', () => {
  assert.throws(() => buildReceipt(validCtx({ content_hash: 'not-a-hash' })));
});

test('buildReceipt rejects bad verdict', () => {
  assert.throws(() => buildReceipt(validCtx({ verdict: 'MAYBE' })));
});

test('buildReceipt rejects missing required field', () => {
  const ctx = validCtx();
  delete ctx.fqe_version;
  assert.throws(() => buildReceipt(ctx));
});

// ─── Bypass identity invariant (THE critical security check) ────────────

test('buildReceipt REJECTS bypass with wrong requester_source (closes v5 flaw)', () => {
  const bad = {
    requester: 'evil-user',
    requester_source: 'pr-branch-file',  // not server-recorded
    events_url: 'https://api.github.com/...',
    allowlist_version: 'sha256:' + 'c'.repeat(64),
    timestamp: '2026-05-22T23:34:00Z',
  };
  assert.throws(
    () => buildReceipt(validCtx({ bypass: bad })),
    /requester_source MUST/
  );
});

test('buildReceipt ACCEPTS bypass with correct requester_source', () => {
  const ok = {
    requester: 'chris-wyatt',
    requester_source: REQUESTER_SOURCE_OK,
    events_url: 'https://api.github.com/repos/x/y/issues/1/events',
    allowlist_version: 'sha256:' + 'c'.repeat(64),
    timestamp: '2026-05-22T23:34:00Z',
  };
  const r = buildReceipt(validCtx({ bypass: ok }));
  assert.equal(r.bypass.requester, 'chris-wyatt');
});

test('buildReceipt ACCEPTS the v0.4.0 comment-based identity source', () => {
  const ok = {
    requester: 'chris-wyatt',
    requester_source: 'github_comments_api_v3',
    events_url: 'https://github.com/x/y/pull/1',
    allowlist_version: 'sha256:' + 'c'.repeat(64),
    timestamp: '2026-05-22T23:34:00Z',
  };
  const r = buildReceipt(validCtx({ bypass: ok }));
  assert.equal(r.bypass.requester_source, 'github_comments_api_v3');
});

test('buildReceipt rejects bypass missing required sub-field', () => {
  const bad = {
    requester: 'chris-wyatt',
    requester_source: REQUESTER_SOURCE_OK,
    // missing events_url
    allowlist_version: 'sha256:' + 'c'.repeat(64),
    timestamp: '2026-05-22T23:34:00Z',
  };
  assert.throws(() => buildReceipt(validCtx({ bypass: bad })));
});

// ─── Serialize / parse round-trip ───────────────────────────────────────

test('serialize/parse round-trip preserves PASS receipt', () => {
  const r = buildReceipt(validCtx());
  const { yaml } = serializeReceipt(r);
  const parsed = parseReceiptYaml(yaml);
  assert.equal(parsed.verdict, 'PASS');
  assert.equal(parsed.commit_sha, r.commit_sha);
  assert.equal(parsed.content_hash, r.content_hash);
  assert.equal(parsed.schema_version, SCHEMA_VERSION);
});

test('serialize/parse round-trip preserves bypass block', () => {
  const r = buildReceipt(validCtx({
    bypass: {
      requester: 'chris-wyatt',
      requester_source: REQUESTER_SOURCE_OK,
      events_url: 'https://api.github.com/repos/x/y/issues/1/events',
      allowlist_version: 'sha256:' + 'c'.repeat(64),
      timestamp: '2026-05-22T23:34:00Z',
    },
  }));
  const { yaml } = serializeReceipt(r);
  const parsed = parseReceiptYaml(yaml);
  assert.equal(parsed.bypass.requester, 'chris-wyatt');
  assert.equal(parsed.bypass.requester_source, REQUESTER_SOURCE_OK);
});

test('parseReceiptYaml rejects schema_version mismatch', () => {
  const r = buildReceipt(validCtx());
  const { yaml } = serializeReceipt(r);
  const tampered = yaml.replace(/schema_version:\s*1/, 'schema_version: 999');
  assert.throws(() => parseReceiptYaml(tampered), /schema_version mismatch/);
});

test('parseReceiptYaml rejects bypass with bad requester_source even after tamper', () => {
  // Simulate someone trying to write a bypass into a receipt with a fake source
  const r = buildReceipt(validCtx({
    bypass: {
      requester: 'chris-wyatt',
      requester_source: REQUESTER_SOURCE_OK,
      events_url: 'https://api.github.com/repos/x/y/issues/1/events',
      allowlist_version: 'sha256:' + 'c'.repeat(64),
      timestamp: '2026-05-22T23:34:00Z',
    },
  }));
  const { yaml } = serializeReceipt(r);
  const tampered = yaml.replace(REQUESTER_SOURCE_OK, 'pr-branch-file');
  assert.throws(() => parseReceiptYaml(tampered), /requester_source MUST/);
});

// ─── writeReceiptFiles writes both files atomically ─────────────────────

test('writeReceiptFiles writes QA-RESULT.yml and QA-RESULT.md', () => {
  const r = buildReceipt(validCtx());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-out-'));
  const { ymlPath, mdPath } = writeReceiptFiles(r, dir);
  assert.ok(fs.existsSync(ymlPath));
  assert.ok(fs.existsSync(mdPath));
  const yaml = fs.readFileSync(ymlPath, 'utf8');
  assert.match(yaml, /verdict: PASS/);
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.match(md, /^---/);
  assert.match(md, /# QA Receipt — PASS/);
  // .yml round-trips
  const parsed = parseReceiptYaml(yaml);
  assert.equal(parsed.verdict, 'PASS');
});
