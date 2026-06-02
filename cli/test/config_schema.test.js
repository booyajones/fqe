'use strict';

/**
 * Tests for the .fqe.yml fail-closed validator (cli/lib/config_schema.js).
 *
 * The load-bearing case is the typo: `whne:` instead of `when:` must be a
 * hard error, because the permissive parser would otherwise accept it, the
 * runner would never fire, and the gate would pass green on a disabled check.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../lib/config_schema');
const { parseConfigYaml } = require('../lib/orchestrator');

function valid(config) {
  const r = validateConfig(config);
  assert.equal(r.valid, true, `expected valid; errors: ${r.errors.join(' | ')}`);
}
function invalid(config, match) {
  const r = validateConfig(config);
  assert.equal(r.valid, false, 'expected invalid');
  if (match) {
    assert.ok(
      r.errors.some((e) => match.test(e)),
      `expected an error matching ${match}; got: ${JSON.stringify(r.errors)}`
    );
  }
}

// ── valid configs ───────────────────────────────────────────────────────────

test('empty object is valid (no runners = always PASS)', () => {
  valid({});
});

test('runners: {} (the parser emits the string "{}") is valid', () => {
  valid({ runners: '{}' });
  valid({ runners: {} });
  valid({ runners: '{ }' }); // hand-written whitespace variant
});

test('a runner missing command does not also report "never fires" (no noise)', () => {
  const r = validateConfig({ runners: { web: { when: [] } } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /'command' is required/.test(e)));
  assert.ok(!r.errors.some((e) => /will never fire/.test(e)), `unexpected noise: ${r.errors.join(' | ')}`);
});

test('a full, well-formed runner is valid', () => {
  valid({
    runners: {
      web: {
        command: 'npx',
        args: ['playwright', 'test'],
        when: ['**/*.tsx'],
        required: true,
        timeout_ms: 600000,
      },
    },
  });
});

test('always_run runner with empty when is valid (it fires every run)', () => {
  valid({ runners: { voice: { command: 'vale', always_run: true, when: [] } } });
});

test('optional version (string or number) is valid', () => {
  valid({ version: '1', runners: {} });
  valid({ version: 1, runners: {} });
});

test('the --with-mutation stryker runner shape validates', () => {
  valid({
    runners: {
      'stryker-mutation': {
        command: 'node',
        args: ['scripts/fqe_stryker_runner.js'],
        when: ['**/*.js', '**/*.ts', 'test/**', 'stryker.conf.json'],
        required: true,
        timeout_ms: 900000,
      },
    },
  });
});

// ── the typo that used to pass green ─────────────────────────────────────────

test('a typo in a runner key (whne instead of when) is rejected', () => {
  invalid(
    { runners: { web: { command: 'npx', whne: ['**/*.tsx'] } } },
    /unknown key 'whne'/
  );
});

test('parsed-from-YAML typo is rejected end to end', () => {
  const yaml = `runners:
  web:
    command: "npx"
    whne: ["**/*.tsx"]
    required: true`;
  const cfg = parseConfigYaml(yaml);
  const r = validateConfig(cfg);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /unknown key 'whne'/.test(e)));
});

// ── structural / type errors ─────────────────────────────────────────────────

test('unknown top-level key is rejected', () => {
  invalid({ runnerz: {} }, /unknown top-level key 'runnerz'/);
});

test('runners as a list is rejected', () => {
  invalid({ runners: ['web'] }, /'runners' must be a mapping/);
});

test('runner missing command is rejected', () => {
  invalid({ runners: { web: { when: ['**/*.ts'] } } }, /'command' is required/);
});

test('runner with empty command is rejected', () => {
  invalid({ runners: { web: { command: '   ', when: ['**/*.ts'] } } }, /'command' is required/);
});

test('args must be a list of strings', () => {
  invalid({ runners: { web: { command: 'x', args: 'test', when: ['*'] } } }, /'args' must be a list/);
  invalid({ runners: { web: { command: 'x', args: [1, 2], when: ['*'] } } }, /'args' must be a list/);
});

test('when must be a list of strings', () => {
  invalid({ runners: { web: { command: 'x', when: '*.ts' } } }, /'when' must be a list/);
});

test('required must be boolean', () => {
  invalid({ runners: { web: { command: 'x', when: ['*'], required: 'yes' } } }, /'required' must be true or false/);
});

test('timeout_ms must be a positive integer', () => {
  invalid({ runners: { web: { command: 'x', when: ['*'], timeout_ms: -1 } } }, /'timeout_ms' must be a positive integer/);
  invalid({ runners: { web: { command: 'x', when: ['*'], timeout_ms: 1.5 } } }, /'timeout_ms' must be a positive integer/);
  invalid({ runners: { web: { command: 'x', when: ['*'], timeout_ms: '600000' } } }, /'timeout_ms' must be a positive integer/);
});

// ── the silent no-op: a runner that can never fire ───────────────────────────

test('a runner with no when and no always_run is rejected (never fires)', () => {
  invalid({ runners: { web: { command: 'x' } } }, /will never fire/);
});

test('a runner with empty when and no always_run is rejected', () => {
  invalid({ runners: { web: { command: 'x', when: [] } } }, /will never fire/);
});

test('always_run: false with empty when is rejected (still never fires)', () => {
  invalid({ runners: { web: { command: 'x', when: [], always_run: false } } }, /will never fire/);
});

// ── multiple errors are all reported ─────────────────────────────────────────

test('multiple problems are reported together', () => {
  const r = validateConfig({
    bogus: 1,
    runners: { web: { whne: ['*'], timeout_ms: 0 } },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 3, `expected several errors, got ${r.errors.length}`);
});

// ── v0.14.0: blast_radius runner key (adversarial gate) ──────────────────────
test('blast_radius must be a canonical class', () => {
  const r = validateConfig({
    runners: { atk: { command: 'x', always_run: true, required: true, blast_radius: 'made-up' } },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /blast_radius/.test(e)), r.errors.join('; '));
});

test('blast_radius runner MUST be required:true (HIGH-2: cannot silently skip the stat requirement)', () => {
  const r = validateConfig({
    runners: { atk: { command: 'x', always_run: true, required: false, blast_radius: 'mcp-write-or-financial' } },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /must be 'required: true'/.test(e)), r.errors.join('; '));
});

test('a well-formed required blast_radius runner is valid', () => {
  const r = validateConfig({
    runners: { atk: { command: 'x', always_run: true, required: true, blast_radius: 'mcp-write-or-financial' } },
  });
  assert.equal(r.valid, true, r.errors.join('; '));
});

// ── v0.15: money-aware strict profile + foot-gun caps ────────────────────────
const { MAX_MIN_MUTANTS } = require('../lib/config_schema');

function moneyRunner(over) {
  const base = {
    command: 'npm', args: ['run', 'test:money'], when: ['src/payments/**'],
    class: 'money', required: true, report: 'junit:reports/m.xml',
    inventory_cmd: 'x', inventory_format: 'count', reconcile: true,
    strict_coverage: true, min_tests: 1,
  };
  const r = Object.assign(base, over || {});
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return r;
}

// MS — money-strict runner refusals
test('MS: a fully-strict money runner is valid', () => { valid({ runners: { m: moneyRunner() } }); });
test('MS S1: money runner missing strict_coverage', () => { invalid({ runners: { m: moneyRunner({ strict_coverage: undefined }) } }, /strict_coverage: true/); });
test('MS S2: money runner missing report', () => { invalid({ runners: { m: moneyRunner({ report: undefined }) } }, /report: junit:/); });
test('MS S3: money runner required:false', () => { invalid({ runners: { m: moneyRunner({ required: false }) } }, /required: true/); });
test('MS S4: contract runner loose', () => { invalid({ runners: { c: moneyRunner({ class: 'contract', strict_coverage: undefined }) } }); });
test('MS S5: money runner quarantined:true', () => { invalid({ runners: { m: moneyRunner({ quarantined: true, quarantined_since: '2026-05-20' }) } }, /quarantined/); });
test('MS S6: advisory mutation under money policy', () => { invalid({ require_money_idempotency: true, runners: { u: { command: 'x', always_run: true } }, mutation: { mode: 'advisory' } }, /mode must be 'blocking'/); });
test('MS S7: mutation mode unset under money policy', () => { invalid({ require_money_idempotency: true, runners: { u: { command: 'x', always_run: true } }, mutation: { threshold: 80 } }, /mode must be 'blocking'/); });
test('MS S8: unbounded allowlist under money policy', () => { invalid({ require_money_idempotency: true, runners: { u: { command: 'x', always_run: true } }, mutation: { mode: 'blocking', allowlist: Array.from({ length: 11 }, (_, i) => `f:${i}:X`) } }, /caps it at 10/); });
test('MS S9: require_for money + advisory mutation', () => { invalid({ runners: { u: { command: 'x', always_run: true } }, policy: { require_for: [{ when: ['src/pay/**'], classes: ['money'] }] }, mutation: { mode: 'advisory' } }, /mode must be 'blocking'/); });
test('MS residual#4: max_suppression_ratio>0.5 under money policy', () => { invalid({ require_money_idempotency: true, runners: { u: { command: 'x', always_run: true } }, mutation: { mode: 'blocking', max_suppression_ratio: 0.9 } }, /at most 0.5 under a money policy/); });
test('MS S11: non-money runner allows quarantine', () => { valid({ runners: { u: { command: 'x', always_run: true, quarantined: true, quarantined_since: '2026-05-20' } } }); });
test('MS S12: non-money advisory mutation OK', () => { valid({ runners: { u: { command: 'x', always_run: true } }, mutation: { mode: 'advisory' } }); });

// F1 — quarantine TTL + dating + money ban
test('F1 S13: quarantined without since', () => { invalid({ runners: { u: { command: 'x', always_run: true, quarantined: true } } }, /requires 'quarantined_since'/); });
test('F1 S14: unparseable since', () => { invalid({ runners: { u: { command: 'x', always_run: true, quarantined: true, quarantined_since: 'last tuesday' } } }, /not a parseable ISO date/); });
test('F1 S15: bare-year since rejected', () => { invalid({ runners: { u: { command: 'x', always_run: true, quarantined: true, quarantined_since: '2026' } } }, /not a parseable ISO date/); });
test('F1 S16: valid YYYY-MM-DD', () => { valid({ runners: { u: { command: 'x', always_run: true, class: 'e2e', quarantined: true, quarantined_since: '2026-05-20' } } }); });
test('F1 S17: full-ISO since', () => { valid({ runners: { u: { command: 'x', always_run: true, quarantined: true, quarantined_since: '2026-05-20T12:00:00Z' } } }); });
test('F1 S18: quarantine on money forbidden', () => { invalid({ runners: { m: { command: 'x', always_run: true, class: 'money', quarantined: true, quarantined_since: '2026-05-20' } } }, /forbidden on class 'money'|quarantined/); });
test('F1 S19: quarantine on contract forbidden', () => { invalid({ runners: { c: { command: 'x', always_run: true, class: 'contract', quarantined: true, quarantined_since: '2026-05-20' } } }, /forbidden on class 'contract'|quarantined/); });
test('F1 S20: ttl out of range', () => { invalid({ runners: { u: { command: 'x', always_run: true, quarantined: true, quarantined_since: '2026-05-20', quarantine_ttl_days: 0 } } }, /integer 1\.\.90/); });
test('F1 S21: dangling since without quarantined', () => { invalid({ runners: { u: { command: 'x', always_run: true, quarantined_since: '2026-05-20' } } }, /require 'quarantined: true'/); });

// F8 — min_mutants ceiling
test('F8 S22: floor (1) valid', () => { valid({ runners: {}, mutation: { mode: 'advisory', min_mutants: 1 } }); });
test('F8 S23: ceiling (5) valid', () => { valid({ runners: {}, mutation: { mode: 'advisory', min_mutants: 5 } }); });
test('F8 S24: floor 0 rejected', () => { invalid({ runners: {}, mutation: { mode: 'advisory', min_mutants: 0 } }, /positive integer/); });
test('F8 S25: ceiling 9999 rejected', () => { invalid({ runners: {}, mutation: { mode: 'advisory', min_mutants: 9999 } }, /at most 5/); });
test('F8 S26: just-over (6) rejected', () => { invalid({ runners: {}, mutation: { mode: 'advisory', min_mutants: 6 } }, /at most 5/); });
test('F8 S27: ceiling message names omit path', () => { invalid({ runners: {}, mutation: { mode: 'advisory', min_mutants: 9999 } }, /[Oo]mit the mutation block/); });
test('F8 S28: single error not double', () => {
  const r = validateConfig({ runners: {}, mutation: { mode: 'advisory', min_mutants: 9999 } });
  assert.equal(r.errors.filter((e) => /min_mutants/.test(e)).length, 1, r.errors.join(' | '));
});
test('F8 S29: non-integer caught by floor not ceiling', () => { invalid({ runners: {}, mutation: { mode: 'advisory', min_mutants: 3.5 } }, /positive integer/); });
test('F8 S30: through the parser', () => { invalid(parseConfigYaml('mutation:\n  mode: advisory\n  min_mutants: 9999\n'), /at most 5/); });
test('F8 S31: MAX_MIN_MUTANTS pinned at 5', () => { assert.equal(MAX_MIN_MUTANTS, 5); });

// F6 — max_suppression_ratio key
test('F6 S32: valid ratio', () => { valid({ runners: {}, mutation: { mode: 'advisory', max_suppression_ratio: 0.5 } }); });
test('F6 S33: ratio > 1 rejected', () => { invalid({ runners: {}, mutation: { mode: 'advisory', max_suppression_ratio: 50 } }, /between 0 and 1/); });
test('F6 S34: ratio non-number rejected', () => { invalid({ runners: {}, mutation: { mode: 'advisory', max_suppression_ratio: 'half' } }, /between 0 and 1/); });
test('F6 S35: typo sibling key rejected', () => { invalid({ runners: {}, mutation: { mode: 'advisory', max_supression_ratio: 0.5 } }, /unknown key/); });

// A4 — top-level boolean
test('A4 S36: boolean valid', () => { valid({ require_money_policy_when_detected: true, runners: { u: { command: 'x', always_run: true } } }); });
test('A4 S37: non-boolean rejected', () => { invalid({ require_money_policy_when_detected: 'true', runners: {} }, /must be true or false/); });
test('A4 S38: known top-level key (false)', () => { valid({ require_money_policy_when_detected: false, runners: {} }); });

// HIGH-3 (review): a bare date-time is interpreted as UTC so quarantine expiry is
// timezone-deterministic (would otherwise be parsed as local time).
test('parseIsoDateUtc treats a tz-less date-time as UTC', () => {
  const { parseIsoDateUtc } = require('../lib/config_schema');
  assert.equal(parseIsoDateUtc('2026-05-20T12:00:00'), parseIsoDateUtc('2026-05-20T12:00:00Z'));
  assert.equal(parseIsoDateUtc('2026-05-20'), Date.parse('2026-05-20T00:00:00Z'));
  assert.equal(parseIsoDateUtc('garbage'), null);
});
