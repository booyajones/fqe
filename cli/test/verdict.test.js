'use strict';

/**
 * Table-driven tests for verdict.js — DETERMINISTIC + FAIL-CLOSED.
 * Run with: node --test test/verdict.test.js
 *
 * These tests are the load-bearing proof of architectural invariant #2
 * ("no LLM in verdict path") plus the post-gauntlet-11f7fb hardening:
 *   - blast_radius thresholds are canonical (not caller-supplied)
 *   - missing/wrong-type exit_code fails closed
 *   - unknown blast_radius class fails closed
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVerdict, PASS, FLAG, FAIL, BLAST_RADIUS_THRESHOLDS } = require('../lib/verdict');

const cases = [
  {
    name: 'empty runners array -> PASS',
    input: { runners: [] },
    expected: PASS,
  },
  {
    name: 'single passing runner -> PASS',
    input: { runners: [{ name: 'web', exit_code: 0, required: true, ran: true }] },
    expected: PASS,
  },
  {
    name: 'single failing runner -> FAIL',
    input: { runners: [{ name: 'web', exit_code: 1, required: true, ran: true }] },
    expected: FAIL,
  },
  {
    name: 'required runner did not run -> FAIL',
    input: { runners: [{ name: 'excel', exit_code: 0, required: true, ran: false }] },
    expected: FAIL,
  },
  {
    name: 'optional runner did not run -> PASS',
    input: {
      runners: [
        { name: 'web', exit_code: 0, required: true, ran: true },
        { name: 'visual', exit_code: 0, required: false, ran: false },
      ],
    },
    expected: PASS,
  },
  {
    name: 'outbound CI under canonical threshold (0.05) -> PASS',
    input: {
      runners: [{ name: 'outbound', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'outbound', n: 100, successes: 0, ci_95: [0, 0.0369], blast_radius: 'outbound' },
      ],
    },
    expected: PASS,
  },
  {
    name: 'outbound CI exceeds canonical threshold (0.05) -> FLAG',
    input: {
      runners: [{ name: 'outbound', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'outbound', n: 20, successes: 2, ci_95: [0.013, 0.302], blast_radius: 'outbound' },
      ],
    },
    expected: FLAG,
  },
  {
    // v0.6.0: a money/state breach BLOCKS (FAIL), it is not advisory.
    // (council 2026-05-29: "FLAG that doesn't block is advisory theater".)
    name: 'mcp-write CI exceeds canonical 0.01 threshold -> FAIL (money breach blocks)',
    input: {
      runners: [{ name: 'mcp-write', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'mcp-write', n: 250, successes: 1, ci_95: [0.0007, 0.0223], blast_radius: 'mcp-write-or-financial' },
      ],
    },
    expected: FAIL,
  },
  {
    name: 'outbound CI breach stays FLAG (advisory for looser classes)',
    input: {
      runners: [{ name: 'outbound', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'outbound', n: 20, successes: 2, ci_95: [0.013, 0.302], blast_radius: 'outbound' },
      ],
    },
    expected: FLAG,
  },
  {
    // The recomputed Wilson upper for (1/100) is ~0.0545, which EXCEEDS the 0.03
    // mcp-read bar. The old test fed a hand-rounded ci_95:[0.0002,0.03] that passed —
    // that was the C1 hole (verdict trusting a too-tight supplied interval). A genuine
    // under-threshold pass needs more attempts: wilson95(0,130).hi ~= 0.0287 < 0.03.
    name: 'mcp-read CI genuinely under canonical 0.03 -> PASS (recomputed from counts)',
    input: {
      runners: [{ name: 'mcp-read', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'mcp-read', n: 130, successes: 0, blast_radius: 'mcp-read' },
      ],
    },
    expected: PASS,
  },
  {
    // The same (1/100) data that the old too-tight interval hid is now correctly a FLAG.
    name: 'mcp-read 1/100 -> FLAG (recomputed Wilson upper ~0.0545 exceeds 0.03)',
    input: {
      runners: [{ name: 'mcp-read', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'mcp-read', n: 100, successes: 1, ci_95: [0.0002, 0.03], blast_radius: 'mcp-read' },
      ],
    },
    expected: FLAG,
  },
  {
    name: 'FAIL beats FLAG',
    input: {
      runners: [{ name: 'web', exit_code: 1, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'outbound', n: 20, successes: 5, ci_95: [0.09, 0.49], blast_radius: 'outbound' },
      ],
    },
    expected: FAIL,
  },
  {
    name: 'multiple FAILs accumulate reasons',
    input: {
      runners: [
        { name: 'web', exit_code: 1, required: true, ran: true },
        { name: 'excel', exit_code: 2, required: true, ran: true },
      ],
    },
    expected: FAIL,
    expectedReasonCount: 2,
  },

  // ─── Post-gauntlet-11f7fb hardening cases ──────────────────────────────

  {
    name: 'unknown blast_radius class -> FAIL (cannot bypass via fake class)',
    input: {
      runners: [{ name: 'agent', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'agent', n: 50, successes: 0, ci_95: [0, 0.07], blast_radius: 'made-up-class' },
      ],
    },
    expected: FAIL,
  },
  {
    name: 'missing blast_radius -> FAIL',
    input: {
      runners: [{ name: 'agent', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'agent', n: 50, successes: 0, ci_95: [0, 0.07] },
      ],
    },
    expected: FAIL,
  },
  {
    name: 'ran:true with undefined exit_code -> FAIL (not silent PASS)',
    input: {
      runners: [{ name: 'web', required: true, ran: true }],
    },
    expected: FAIL,
  },
  {
    name: 'ran:true with null exit_code -> FAIL',
    input: {
      runners: [{ name: 'web', exit_code: null, required: true, ran: true }],
    },
    expected: FAIL,
  },
  {
    name: 'ran:true with string exit_code "0" -> FAIL (type coercion blocked)',
    input: {
      runners: [{ name: 'web', exit_code: '0', required: true, ran: true }],
    },
    expected: FAIL,
  },
  {
    name: 'ran:true with NaN exit_code -> FAIL',
    input: {
      runners: [{ name: 'web', exit_code: NaN, required: true, ran: true }],
    },
    expected: FAIL,
  },
  {
    // C1: a supplied ci_95 is IGNORED. Even an inverted/garbage interval cannot
    // change the verdict; it is recomputed from (5/100) -> Wilson upper ~0.1118,
    // which exceeds the 0.05 outbound bar -> FLAG.
    name: 'supplied ci_95 is ignored; verdict recomputed from counts -> FLAG',
    input: {
      runners: [{ name: 'outbound', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [
        { runner: 'outbound', n: 100, successes: 5, ci_95: [0.5, 0.02], blast_radius: 'outbound' },
      ],
    },
    expected: FLAG,
  },
];

for (const c of cases) {
  test(c.name, () => {
    if (c.expectThrow) {
      assert.throws(() => computeVerdict(c.input));
      return;
    }
    const out = computeVerdict(c.input);
    assert.equal(out.verdict, c.expected, `expected ${c.expected}, got ${out.verdict}; reasons: ${out.reasons.join(' | ')}`);
    if (typeof c.expectedReasonCount === 'number') {
      assert.equal(out.reasons.length, c.expectedReasonCount);
    }
  });
}

test('determinism: same input -> same output across 100 calls', () => {
  const input = {
    runners: [
      { name: 'web', exit_code: 0, required: true, ran: true },
      { name: 'excel', exit_code: 0, required: true, ran: true },
    ],
    adversarial_stats: [
      { runner: 'outbound', n: 100, successes: 3, ci_95: [0.0099, 0.0834], blast_radius: 'outbound' },
    ],
  };
  const first = JSON.stringify(computeVerdict(input));
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.stringify(computeVerdict(input)), first);
  }
});

test('malformed input throws (not silent PASS)', () => {
  assert.throws(() => computeVerdict(null));
  assert.throws(() => computeVerdict({}));
  assert.throws(() => computeVerdict({ runners: 'not an array' }));
  assert.throws(() =>
    computeVerdict({ runners: [{ exit_code: 0, required: true, ran: true }] }) // missing name
  );
});

test('malformed adversarial stat throws (missing raw counts -> fail closed)', () => {
  // C1: the gate now needs the raw (n, successes) counts to recompute the interval.
  // A stat missing `successes` cannot be evaluated, so wilson95() throws and the
  // verdict fails closed rather than passing on absent data.
  assert.throws(() =>
    computeVerdict({
      runners: [{ name: 'x', exit_code: 0, required: true, ran: true }],
      adversarial_stats: [{ runner: 'x', n: 20 /* missing successes */ }],
    })
  );
});

test('BLAST_RADIUS_THRESHOLDS is frozen (cannot be mutated by orchestrator)', () => {
  assert.equal(BLAST_RADIUS_THRESHOLDS.outbound, 0.05);
  assert.equal(BLAST_RADIUS_THRESHOLDS['mcp-read'], 0.03);
  assert.equal(BLAST_RADIUS_THRESHOLDS['mcp-write-or-financial'], 0.01);
  assert.ok(Object.isFrozen(BLAST_RADIUS_THRESHOLDS));
  // Attempting to mutate must throw in strict mode
  assert.throws(() => { BLAST_RADIUS_THRESHOLDS.outbound = 0.99; }, TypeError);
});

test('attacker cannot bypass by adding extra fields they hope verdict.js trusts', () => {
  // Even if the orchestrator passes an extra "threshold_ci_upper" hoping the
  // old behavior is still there, it should be ignored — only blast_radius
  // drives the threshold now.
  const input = {
    runners: [{ name: 'mcp-write', exit_code: 0, required: true, ran: true }],
    adversarial_stats: [
      {
        runner: 'mcp-write',
        n: 250,
        successes: 1,
        ci_95: [0.0007, 0.0223],
        blast_radius: 'mcp-write-or-financial',
        threshold_ci_upper: 0.99,   // attacker tries to absorb the failure
      },
    ],
  };
  const out = computeVerdict(input);
  assert.equal(out.verdict, FAIL, 'canonical 0.01 threshold breach on a money class BLOCKS, ignoring attacker-supplied 0.99');
});

test('fails closed when a required-stats runner emits no adversarial stats', () => {
  // A compromised orchestrator that drops the stats array cannot pass: a runner
  // named in require_stats_for with no matching stat is a FAIL.
  const out = computeVerdict({
    runners: [{ name: 'mcp-write', exit_code: 0, required: true, ran: true }],
    adversarial_stats: [],
    require_stats_for: ['mcp-write'],
  });
  assert.equal(out.verdict, FAIL);
  assert.ok(out.reasons.some((r) => /must emit adversarial_stats/.test(r)));
});

test('require_stats_for passes when the stat is present and within threshold', () => {
  const out = computeVerdict({
    runners: [{ name: 'mcp-write', exit_code: 0, required: true, ran: true }],
    adversarial_stats: [
      { runner: 'mcp-write', n: 1000, successes: 0, ci_95: [0, 0.0037], blast_radius: 'mcp-write-or-financial' },
    ],
    require_stats_for: ['mcp-write'],
  });
  assert.equal(out.verdict, PASS);
});

// ---------------------------------------------------------------------------
// require_classes — the full-suite policy (v0.7.0). A required test class with
// no ran-and-passed runner is a FAIL (fail closed: covers the "you changed
// money code but shipped no money test" gap).
// ---------------------------------------------------------------------------

test('require_classes FAILs when a required class has no runner at all', () => {
  const out = computeVerdict({
    runners: [{ name: 'unit', class: 'unit', exit_code: 0, required: true, ran: true }],
    require_classes: ['money'],
  });
  assert.equal(out.verdict, FAIL);
  assert.ok(out.reasons.some((r) => /required test class "money" has no runner/.test(r)));
});

test('require_classes FAILs when the required-class runner ran but did not pass', () => {
  const out = computeVerdict({
    runners: [{ name: 'pay', class: 'money', exit_code: 1, required: true, ran: true }],
    require_classes: ['money'],
  });
  assert.equal(out.verdict, FAIL);
  // both the exit-code FAIL and the class-coverage FAIL should be present
  assert.ok(out.reasons.some((r) => /exited 1/.test(r)));
  assert.ok(out.reasons.some((r) => /required test class "money"/.test(r)));
});

test('require_classes PASSes when each required class has a ran-and-passed runner', () => {
  const out = computeVerdict({
    runners: [
      { name: 'unit', class: 'unit', exit_code: 0, required: true, ran: true },
      { name: 'pay', class: 'money', exit_code: 0, required: true, ran: true },
    ],
    require_classes: ['unit', 'money'],
  });
  assert.equal(out.verdict, PASS);
});

test('require_classes FAILs when the only runner of that class did not run', () => {
  const out = computeVerdict({
    runners: [{ name: 'pay', class: 'money', exit_code: undefined, required: false, ran: false }],
    require_classes: ['money'],
  });
  assert.equal(out.verdict, FAIL);
  assert.ok(out.reasons.some((r) => /required test class "money"/.test(r)));
});

test('no require_classes -> backward compatible (class field is ignored)', () => {
  const out = computeVerdict({
    runners: [{ name: 'unit', class: 'unit', exit_code: 0, required: true, ran: true }],
  });
  assert.equal(out.verdict, PASS);
});

test('require_classes: an unknown required class is flagged as a likely typo', () => {
  const out = computeVerdict({
    runners: [{ name: 'u', class: 'unit', exit_code: 0, required: true, ran: true }],
    require_classes: ['mony'], // typo for "money"
  });
  assert.equal(out.verdict, FAIL);
  assert.ok(out.reasons.some((r) => /not a known test class/.test(r)));
});

test('require_classes: a class runner with ran:false but exit_code:0 still does NOT satisfy', () => {
  const out = computeVerdict({
    runners: [{ name: 'pay', class: 'money', exit_code: 0, required: false, ran: false }],
    require_classes: ['money'],
  });
  assert.equal(out.verdict, FAIL);
  assert.ok(out.reasons.some((r) => /required test class "money"/.test(r)));
});

// ── v0.15 A4 (Pass 10) + F9 (Pass 11): money detection + dead glob ──
const PASSRUN = { name: 'unit', required: true, ran: true, exit_code: 0, class: 'unit' };
test('A4 V6: money detected, no policy -> FLAG', () => {
  const out = computeVerdict({ runners: [PASSRUN], money_signal: { detected: true, policy_configured: false, path_hits: ['src/ledger/x.js'], keyword_hits: [] } });
  assert.equal(out.verdict, 'FLAG');
  assert.ok(out.reasons.some((r) => /no money policy/.test(r)), out.reasons.join(' | '));
});
test('A4 V7: money detected, no policy, strict flag -> FAIL', () => {
  const out = computeVerdict({ runners: [PASSRUN], require_money_policy_when_detected: true, money_signal: { detected: true, policy_configured: false, path_hits: ['src/ledger/x.js'], keyword_hits: [] } });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /BLOCKED \(money detected/.test(r)), out.reasons.join(' | '));
});
test('A4 V8: money detected WITH policy -> PASS', () => {
  const out = computeVerdict({ runners: [PASSRUN], money_signal: { detected: true, policy_configured: true, path_hits: ['src/ledger/x.js'], keyword_hits: [] } });
  assert.equal(out.verdict, 'PASS');
});
test('A4 V9: no money detected -> PASS', () => {
  const out = computeVerdict({ runners: [PASSRUN], money_signal: { detected: false, policy_configured: false, path_hits: [], keyword_hits: [] } });
  assert.equal(out.verdict, 'PASS');
});
test('A4 V10: indeterminate diff alone does not flag money (detected:false) -> PASS', () => {
  const out = computeVerdict({ runners: [PASSRUN], money_signal: { detected: false, indeterminate: true, policy_configured: false, path_hits: [], keyword_hits: [] } });
  assert.equal(out.verdict, 'PASS');
});
test('A4 V12: money "ok" can never CLEAR a Pass-1 FAIL', () => {
  const out = computeVerdict({ runners: [{ name: 'm', required: true, ran: false, class: 'money' }], money_signal: { detected: true, policy_configured: true, path_hits: [], keyword_hits: [] } });
  assert.equal(out.verdict, 'FAIL');
});
test('F9 V13: a dead require_for glob -> FLAG', () => {
  const out = computeVerdict({ runners: [PASSRUN], dead_require_for_globs: [{ index: 0, glob: 'src/paymnt/**' }] });
  assert.equal(out.verdict, 'FLAG');
  assert.ok(out.reasons.some((r) => /matches no file/.test(r)), out.reasons.join(' | '));
});
test('F9 V14: a dead glob + strict -> FAIL', () => {
  const out = computeVerdict({ runners: [PASSRUN], require_money_policy_when_detected: true, dead_require_for_globs: [{ index: 0, glob: 'src/paymnt/**' }] });
  assert.equal(out.verdict, 'FAIL');
});
test('A4/F9 V15: no money_signal and no dead globs -> unchanged PASS (back-compat)', () => {
  const out = computeVerdict({ runners: [PASSRUN] });
  assert.equal(out.verdict, 'PASS');
});
test('V16: verdict.js stays clock-free (no Date usage in the verdict core)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../lib/verdict'), 'utf8');
  assert.ok(!/new Date|Date\.now|Date\.parse|Date\.UTC|Date\(/.test(src), 'verdict.js must not use a clock');
});

// ── v0.16 F2: opt-in empty/hollow gate ──
test('F2: require_nonempty_gate + hollow gate (no required runner/class/money) -> FAIL', () => {
  const out = computeVerdict({ runners: [{ name: 'opt', required: false, ran: true, exit_code: 0 }], require_nonempty_gate: true });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.reasons.some((r) => /blocks nothing/.test(r)), out.reasons.join(' | '));
});
test('F2: require_nonempty_gate + a required runner -> PASS', () => {
  const out = computeVerdict({ runners: [{ name: 'unit', required: true, ran: true, exit_code: 0 }], require_nonempty_gate: true });
  assert.equal(out.verdict, 'PASS');
});
test('F2: require_nonempty_gate + a required class (with a passing runner) is not hollow -> PASS', () => {
  const out = computeVerdict({ runners: [{ name: 'u', required: false, ran: true, exit_code: 0, class: 'unit' }], require_classes: ['unit'], require_nonempty_gate: true });
  assert.equal(out.verdict, 'PASS');
});
test('F2: require_nonempty_gate UNSET + empty runners -> PASS (default unchanged)', () => {
  assert.equal(computeVerdict({ runners: [] }).verdict, 'PASS');
});
