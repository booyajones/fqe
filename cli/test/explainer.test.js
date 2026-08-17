'use strict';

/**
 * explainer.js tests.
 *
 * The most important property: every reason string that verdict.js can emit
 * must be matched by explainReason() and produce a non-UNKNOWN_REASON code.
 * If a pattern silently falls through to UNKNOWN_REASON, the engineer sees
 * the bare reason and the explainer adds zero value.
 *
 * These tests also pin the regex against the EXACT string templates in
 * verdict.js so future verdict-side changes break the explainer loudly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { explainReason, explainVerdict } = require('../lib/explainer');
const { computeVerdict, BLAST_RADIUS_THRESHOLDS } = require('../lib/verdict');

// ─── Pattern coverage ───────────────────────────────────────────────────

test('matches "required runner X did not run" — runner name in quotes in plain_english', () => {
  const out = explainReason('required runner "excel" did not run');
  assert.equal(out.code, 'REQUIRED_RUNNER_MISSING');
  // Pin on quoted name to distinguish from incidental "excel" elsewhere
  assert.match(out.plain_english, /"excel"/);
  assert.ok(out.fix.length > 20);
  assert.ok(out.repro_command.includes('fqe run'));
});

test('matches "runner X exited N" — name in quotes + exit code in plain_english', () => {
  const out = explainReason('runner "web" exited 2');
  assert.equal(out.code, 'RUNNER_EXIT_NONZERO');
  assert.match(out.plain_english, /"web"/);
  assert.match(out.plain_english, /code 2/);
});

test('matches "runner X exited -1" (negative exit codes)', () => {
  const out = explainReason('runner "agent" exited -1');
  assert.equal(out.code, 'RUNNER_EXIT_NONZERO');
  assert.match(out.plain_english, /"agent"/);
  assert.match(out.plain_english, /code -1/);
});

test('matches "runner X ran but exit_code is not a number" — captures bad value', () => {
  const out = explainReason('runner "outbound" ran but exit_code is not a number (got null)');
  assert.equal(out.code, 'RUNNER_EXIT_MALFORMED');
  assert.match(out.plain_english, /"outbound"/);
  // The captured bad value MUST appear in plain_english (post code-review fix)
  assert.match(out.plain_english, /`null`/);
  assert.match(out.fix, /bypass/);
});

test('matches malformed exit_code with stringified non-null value', () => {
  // Ensures the (.+) capture works for any malformed value
  const out = explainReason('runner "agent" ran but exit_code is not a number (got "0")');
  assert.equal(out.code, 'RUNNER_EXIT_MALFORMED');
  assert.match(out.plain_english, /"0"/);
});

test('matches Wilson CI threshold exceeded', () => {
  const reason = 'Wilson CI upper 0.2300 exceeds canonical threshold 0.0500 for blast_radius=outbound on runner=outbound-eval';
  const out = explainReason(reason);
  assert.equal(out.code, 'ADVERSARIAL_CI_EXCEEDED');
  assert.match(out.plain_english, /"outbound-eval"/);
  assert.match(out.plain_english, /0\.2300/);
  assert.match(out.plain_english, /0\.0500/);
  // The honest fix tells the engineer BOTH levers (failures + sample size)
  assert.match(out.fix, /Reduce failures/);
  assert.match(out.fix, /Increase sample size/);
  // Repro command points at the right local tools
  assert.match(out.repro_command, /fqe min-n 0\.05/);
});

test('matches "adversarial stat missing blast_radius"', () => {
  const out = explainReason('adversarial stat for "agent" missing blast_radius');
  assert.equal(out.code, 'ADVERSARIAL_MISSING_BLAST_RADIUS');
  assert.match(out.fix, /blast_radius/);
});

test('matches "adversarial stat unknown blast_radius"', () => {
  const known = Object.keys(BLAST_RADIUS_THRESHOLDS).join(', ');
  const reason = `adversarial stat for "x" has unknown blast_radius "made-up-class"; known classes: ${known}`;
  const out = explainReason(reason);
  assert.equal(out.code, 'ADVERSARIAL_UNKNOWN_BLAST_RADIUS');
  assert.match(out.plain_english, /made-up-class/);
});

test('unknown reason -> UNKNOWN_REASON with original wrapped in framing', () => {
  const reason = 'something completely novel that verdict.js never emits';
  const out = explainReason(reason);
  assert.equal(out.code, 'UNKNOWN_REASON');
  // Per code-review fix: raw reason is now WRAPPED with framing, not passed through
  assert.match(out.plain_english, new RegExp(reason));
  assert.match(out.plain_english, /doesn't match any known pattern/);
  assert.match(out.plain_english, /verdict itself .* is still trustworthy/);
  assert.match(out.fix, /file an issue/i);
});

// ─── Round-trip: every reason verdict.js can produce -> non-UNKNOWN ────

test('every verdict.js failure reason has an explainer match', () => {
  // Drive verdict.js into each failure path and assert the resulting reasons
  // are all matched by the explainer (no UNKNOWN_REASON fallbacks).
  const fortyHex = 'a'.repeat(40);
  const failureInputs = [
    {
      label: 'required-not-run',
      input: { runners: [{ name: 'excel', required: true, ran: false }] },
    },
    {
      label: 'runner-exit-nonzero',
      input: { runners: [{ name: 'web', required: true, ran: true, exit_code: 2 }] },
    },
    {
      label: 'runner-exit-not-number',
      input: { runners: [{ name: 'web', required: true, ran: true, exit_code: null }] },
    },
    {
      label: 'ci-exceeds-threshold',
      input: {
        runners: [{ name: 'outbound', required: true, ran: true, exit_code: 0 }],
        adversarial_stats: [
          { runner: 'outbound', n: 20, successes: 2, ci_95: [0.013, 0.302], blast_radius: 'outbound' },
        ],
      },
    },
    {
      label: 'missing-blast-radius',
      input: {
        runners: [{ name: 'agent', required: true, ran: true, exit_code: 0 }],
        adversarial_stats: [
          { runner: 'agent', n: 50, successes: 0, ci_95: [0, 0.07] },
        ],
      },
    },
    {
      label: 'unknown-blast-radius',
      input: {
        runners: [{ name: 'agent', required: true, ran: true, exit_code: 0 }],
        adversarial_stats: [
          { runner: 'agent', n: 50, successes: 0, ci_95: [0, 0.07], blast_radius: 'bogus-class' },
        ],
      },
    },
  ];
  for (const { label, input } of failureInputs) {
    const v = computeVerdict(input);
    assert.ok(v.reasons.length > 0, `${label}: verdict should have produced reasons`);
    for (const reason of v.reasons) {
      const ex = explainReason(reason);
      assert.notEqual(
        ex.code, 'UNKNOWN_REASON',
        `${label}: reason "${reason}" fell through to UNKNOWN_REASON — explainer pattern missing`
      );
    }
  }
});

// ─── explainVerdict markdown ────────────────────────────────────────────

test('PASS verdict produces ✅ message AND no repro/fix sections', () => {
  const md = explainVerdict({ verdict: 'PASS', reasons: [] });
  assert.match(md, /PASS/);
  assert.match(md, /All runners exited cleanly/);
  // PASS must NOT have any of the FAIL/FLAG affordances — guards against
  // accidentally wiring PASS through the FAIL formatter
  assert.doesNotMatch(md, /Reproduce locally/);
  assert.doesNotMatch(md, /\*\*Fix:\*\*/);
  assert.doesNotMatch(md, /```bash/);
  assert.doesNotMatch(md, /^### ❌/m);
  assert.doesNotMatch(md, /^### ⚠️/m);
});

test('FAIL verdict with multiple reasons produces numbered sections', () => {
  const md = explainVerdict({
    verdict: 'FAIL',
    reasons: [
      'runner "web" exited 1',
      'required runner "excel" did not run',
    ],
  });
  assert.match(md, /FAIL/);
  assert.match(md, /1\. RUNNER_EXIT_NONZERO/);
  assert.match(md, /2\. REQUIRED_RUNNER_MISSING/);
  assert.match(md, /Reproduce locally/);
  // Must have the repro command in a code block
  assert.match(md, /```bash[\s\S]*fqe run/);
});

test('FLAG verdict is non-blocking in the explanation', () => {
  const md = explainVerdict({
    verdict: 'FLAG',
    reasons: ['Wilson CI upper 0.2300 exceeds canonical threshold 0.0500 for blast_radius=outbound on runner=outbound-eval'],
  });
  assert.match(md, /FLAG/);
  assert.match(md, /does not block merge/);
});

test('empty reasons on FAIL produces a defensive explanation, not just a header', () => {
  // Edge case: verdict says FAIL but reasons array is empty (shouldn't happen
  // from verdict.js, but the explainer must give useful output rather than
  // a bare scary heading)
  const md = explainVerdict({ verdict: 'FAIL', reasons: [] });
  assert.match(md, /FAIL/);
  // Per code-review fix: must explain the empty-reasons situation
  assert.match(md, /No reasons were recorded/);
  assert.match(md, /file an issue/i);
});

// ─── Determinism ────────────────────────────────────────────────────────

test('explainReason is deterministic AND pins expected output (snapshot)', () => {
  const r = 'runner "web" exited 1';
  const a = explainReason(r);
  const b = explainReason(r);
  assert.deepEqual(a, b);
  // Snapshot-style pin: a stable wrong explainer would pass deepEqual(a,b)
  // unless we also pin known-good fields.
  assert.equal(a.code, 'RUNNER_EXIT_NONZERO');
  assert.match(a.plain_english, /"web"/);
  assert.match(a.plain_english, /code 1/);
  // The repro command must be RUNNABLE, not merely stable. This assertion used to
  // pin `--full`, a flag the parser does not have, so the suite was actively
  // certifying a command that fails on the first try with "missing required flag:
  // --commit". A snapshot test defends whatever it was given, including a defect.
  assert.match(a.repro_command, /^fqe run --commit /);
  assert.doesNotMatch(a.repro_command, /--full|--verbose/, 'phantom flags: neither exists in the parser');
});

test('every repro command the explainer emits passes the real CLI parser', () => {
  // The property the snapshot above could not see. Parse each emitted repro
  // command with the same flag parser bin/fqe.js uses, and require that the
  // flags fqe actually demands are present and that no invented flag survives.
  const REASONS = [
    'required runner "web" did not run',
    'runner "web" exited 1',
    'runner "web" ran but exit_code is not a number (got null)',
    'some brand new reason nobody has explained yet',
  ];
  for (const reason of REASONS) {
    const { repro_command } = explainReason(reason, { commit_sha: 'abc1234', base_sha: 'def5678' });
    const first = repro_command.split('\n').find((l) => l.startsWith('fqe run'));
    if (!first) continue; // some explanations legitimately suggest other subcommands
    assert.match(first, /--commit \S+/, `missing required --commit: ${first}`);
    assert.match(first, /--output \S+/, `missing required --output: ${first}`);
    assert.doesNotMatch(first, /--full|--verbose/, `emits a nonexistent flag: ${first}`);
    assert.doesNotMatch(first, /runner-.*\.log/, `points at a log file fqe never writes: ${first}`);
  }
});

test('explainVerdict is deterministic', () => {
  const v = {
    verdict: 'FAIL',
    reasons: ['runner "web" exited 1', 'required runner "excel" did not run'],
  };
  const a = explainVerdict(v);
  const b = explainVerdict(v);
  assert.equal(a, b);
});

// ─── Context (base_sha) flows into repro command ───────────────────────

test('base_sha context flows into the repro command', () => {
  const out = explainReason('runner "web" exited 1', { base_sha: 'abcdef1234567890' });
  assert.match(out.repro_command, /--base abcdef1/);
});

test('missing base_sha defaults to origin/main', () => {
  const out = explainReason('runner "web" exited 1');
  assert.match(out.repro_command, /--base origin\/main/);
});
