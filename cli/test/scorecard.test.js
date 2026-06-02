'use strict';

/**
 * v0.18: shadow-trial scorecard (A6/A13) + M3 vitest config-only discovery.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { aggregateScorecard, renderScorecard } = require('../lib/scorecard');
const { discover } = require('../lib/discover');

function rcpt(verdict, over) {
  return Object.assign({
    verdict, commit_sha: 'a'.repeat(40),
    started_at: '2026-06-01T00:00:00Z', finished_at: '2026-06-01T00:00:30Z',
    bypass: null, human_review: { estimated_minutes: 0 },
  }, over || {});
}

test('scorecard: empty input -> zeros, no crash, false-red rate is null (not a false 0%)', () => {
  const s = aggregateScorecard([]);
  assert.equal(s.total_runs, 0);
  assert.equal(s.false_red.rate, null, 'a zero-FAIL sample cannot show a 0% false-red rate');
  assert.equal(s.true_catches, 0);
  assert.equal(s.gate_wall_ms.p50, null);
  assert.match(renderScorecard(s), /n\/a \(no FAILs in sample\)/);
});

test('scorecard: a sample with PASSes but no FAILs reports n/a false-red rate', () => {
  const s = aggregateScorecard([rcpt('PASS'), rcpt('PASS')]);
  assert.equal(s.false_red.rate, null);
  assert.equal(s.false_red.of_fails, 0);
});

test('scorecard: percentiles anchored for N=1 and N=2', () => {
  const one = aggregateScorecard([rcpt('PASS', { started_at: '2026-06-01T00:00:00Z', finished_at: '2026-06-01T00:00:05Z' })]);
  assert.equal(one.gate_wall_ms.p50, 5000);
  assert.equal(one.gate_wall_ms.p95, 5000);
  const two = aggregateScorecard([
    rcpt('PASS', { started_at: '2026-06-01T00:00:00Z', finished_at: '2026-06-01T00:00:10Z' }),
    rcpt('PASS', { started_at: '2026-06-01T00:00:00Z', finished_at: '2026-06-01T00:00:40Z' }),
  ]);
  assert.equal(two.gate_wall_ms.p95, 40000);
  assert.equal(two.gate_wall_ms.max, 40000);
});

test('scorecard: verdict distribution + rates', () => {
  const s = aggregateScorecard([rcpt('PASS'), rcpt('PASS'), rcpt('FLAG'), rcpt('FAIL')]);
  assert.equal(s.total_runs, 4);
  assert.deepEqual({ PASS: s.by_verdict.PASS, FLAG: s.by_verdict.FLAG, FAIL: s.by_verdict.FAIL }, { PASS: 2, FLAG: 1, FAIL: 1 });
  assert.equal(s.flag_rate, 0.25);
  assert.equal(s.fail_rate, 0.25);
});

test('scorecard: a bypassed FAIL is a false-red candidate; an un-bypassed FAIL is a true catch', () => {
  const bypassed = rcpt('FAIL', { bypass: { requester: 'm', requester_source: 'github_comments_api_v3', events_url: 'x', allowlist_version: 'y', timestamp: 'z' } });
  const stuck = rcpt('FAIL');
  const s = aggregateScorecard([bypassed, stuck, rcpt('PASS')]);
  assert.equal(s.false_red.candidates, 1);
  assert.equal(s.false_red.of_fails, 2);
  assert.equal(s.false_red.rate, 0.5);
  assert.equal(s.true_catches, 1);
  assert.equal(s.bypassed_runs, 1);
});

test('scorecard: gate wall-time percentiles + human minutes sum', () => {
  const a = rcpt('PASS', { started_at: '2026-06-01T00:00:00Z', finished_at: '2026-06-01T00:00:10Z', human_review: { estimated_minutes: 3 } });
  const b = rcpt('PASS', { started_at: '2026-06-01T00:00:00Z', finished_at: '2026-06-01T00:00:40Z', human_review: { estimated_minutes: 5 } });
  const s = aggregateScorecard([a, b]);
  assert.equal(s.gate_wall_ms.samples, 2);
  assert.equal(s.gate_wall_ms.max, 40000);
  assert.equal(s.human_review_minutes_total, 8);
});

test('scorecard: a malformed timestamp does not crash and is excluded from wall-time', () => {
  const s = aggregateScorecard([rcpt('PASS', { finished_at: 'not-a-date' })]);
  assert.equal(s.total_runs, 1);
  assert.equal(s.gate_wall_ms.samples, 0);
});

test('scorecard: renderScorecard produces the three named metrics', () => {
  const text = renderScorecard(aggregateScorecard([rcpt('FAIL'), rcpt('PASS')]));
  assert.match(text, /false-red rate/);
  assert.match(text, /gate wall-time/);
  assert.match(text, /true catches/);
});

// M3: a framework configured ONLY via its config file (no package.json devDep/script) is detected.
test('M3: vitest is detected from vitest.config.ts alone (no package.json signal)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-m3-'));
  fs.writeFileSync(path.join(dir, 'vitest.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(dir, 'src.test.ts'), 'test("x", () => {});');
  const d = discover(dir, {});
  assert.ok(JSON.stringify(d.detected).includes('vitest'), `vitest should be detected via its config file; detected: ${JSON.stringify(d.detected)}`);
});
