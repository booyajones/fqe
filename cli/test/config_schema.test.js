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
