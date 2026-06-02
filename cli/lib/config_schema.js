'use strict';

/**
 * fqe config validator — fail-closed validation for .fqe.yml.
 *
 * The orchestrator's YAML parser is permissive on purpose (it is a tiny
 * hand-rolled subset parser with no dependency). The cost of that permissive
 * parsing: a typo'd runner key like `whne:` instead of `when:` parses without
 * error, the runner's match patterns come back empty, the runner never fires,
 * and the gate goes green. For a quality gate, a config typo that silently
 * disables a check is a correctness bug, not a cosmetic one.
 *
 * This validator rejects unknown keys, wrong types, a missing command, and
 * runners that can never fire. The orchestrator runs it before classifying,
 * so a broken config ERRORs (exit 1, non-green) instead of passing. It mirrors
 * schemas/fqe-config.schema.json (which drives editor autocomplete).
 *
 * Pure, dependency-free, no LLM. Same input -> same errors.
 */

const { KNOWN_CLASSES, BLAST_RADIUS_THRESHOLDS } = require('./verdict');
const { KNOWN_FORMATS } = require('./inventory');

const TOP_LEVEL_KEYS = ['runners', 'version', 'policy', 'require_coverage_evidence', 'require_all_suites_wired', 'require_money_idempotency', 'require_money_policy_when_detected', 'require_nonempty_gate', 'mutation'];
const MUTATION_KEYS = ['mode', 'threshold', 'min_mutants', 'allowlist', 'max_suppression_ratio'];
// Invariant ids a runner may declare it proves (payments safety, v0.11).
const KNOWN_INVARIANTS = Object.freeze(['idempotency', 'double-spend', 'conservation', 'no-negative-balance']);
const RUNNER_KEYS = [
  'command', 'args', 'when', 'required', 'always_run', 'timeout_ms', 'class',
  // coverage-liveness (v0.9.0): proof that real tests actually executed.
  'report', 'inventory_cmd', 'inventory_format', 'min_tests', 'reconcile', 'strict_coverage',
  // trust hygiene (v0.10): flaky-retry + quarantine so one random red never blocks.
  // v0.15 (F1): a quarantine must carry a start date and may set a TTL; it expires.
  'retries', 'quarantined', 'quarantined_since', 'quarantine_ttl_days',
  // payments safety (v0.11): the named money invariants this runner proves.
  'invariant',
  // adversarial gate (v0.14): the blast radius this runner attacks. Declaring it
  // (a) forces the runner to emit adversarial_stats (require_stats_for, no dropped
  // payload) and (b) binds the canonical threshold so the runner cannot downgrade
  // its own class. Value must be a known BLAST_RADIUS_THRESHOLDS key.
  'blast_radius',
];
const KNOWN_BLAST_RADII = Object.freeze(Object.keys(BLAST_RADIUS_THRESHOLDS));

// v0.15 money-strict profile + foot-gun caps.
// MONEY_CLASSES: the test classes that move or reconcile money. Runners in these
// classes are strict-by-default and may not carry the abusable carve-outs.
const MONEY_CLASSES = Object.freeze(new Set(['money', 'contract']));
// MONEY_ALLOWLIST_CAP (MS): a small, named, reviewed set of known-equivalent money
// mutants is fine; an open-ended list could suppress every real money survivor.
const MONEY_ALLOWLIST_CAP = 10;
// MAX_MIN_MUTANTS (F8): a real PR diff yields a handful of mutants; above this floor
// `total < min_mutants` pins NEUTRAL forever, silently disabling the mutation gate.
const MAX_MIN_MUTANTS = 5;
const POLICY_KEYS = ['require_classes', 'require_for'];
const REQUIRE_FOR_KEYS = ['when', 'classes'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isArrayOfStrings(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * The permissive parser turns `runners: {}` into the literal STRING "{}".
 * Treat that, an empty string, and null/undefined all as an empty runner set.
 * Anything else that is not a real object is malformed.
 * @returns {{ ok: boolean, value?: object }}
 */
function normalizeRunners(runners) {
  if (runners == null) return { ok: true, value: {} };
  if (typeof runners === 'string') {
    const t = runners.trim();
    // The parser emits `{}` for an empty map; tolerate a hand-written `{ }` too.
    if (t === '' || /^\{\s*\}$/.test(t)) return { ok: true, value: {} };
    return { ok: false };
  }
  if (isPlainObject(runners)) return { ok: true, value: runners };
  return { ok: false };
}

/**
 * Strict ISO-date parser (v0.15 F1). Accepts YYYY-MM-DD or a full ISO timestamp.
 * Rejects loose inputs ("last tuesday", "2026", "05/20/2026") so a quarantine date
 * cannot be fudged into something Date() would coerce. Returns a millisecond epoch
 * (UTC) or null. Pure, no clock.
 * @returns {number|null}
 */
function parseIsoDateUtc(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  // Require at least YYYY-MM-DD; optionally a T...time and zone.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(t)) {
    return null;
  }
  // Force UTC: a bare date-time with no timezone (e.g. "2026-05-20T12:00:00") would be
  // parsed as LOCAL time, making quarantine expiry differ across CI timezones. A date-only
  // value is already UTC per spec. Append Z to a tz-less date-time so the result is
  // deterministic everywhere.
  let norm = t.replace(' ', 'T');
  const hasTime = norm.includes('T');
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(norm);
  if (hasTime && !hasTz) norm += 'Z';
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Is this runner config a money-class runner (money or contract)? (v0.15)
 */
function isMoneyClass(cfg) {
  return isPlainObject(cfg) && typeof cfg.class === 'string' && MONEY_CLASSES.has(cfg.class);
}

/**
 * Does the config carry ANY money policy? (v0.15, single source of truth.)
 * True when a runner declares a money/contract class, OR require_money_idempotency
 * is on, OR a policy.require_for entry lists a money/contract class. The orchestrator
 * and money_scan both import THIS function so the definition never drifts.
 */
function hasMoneyPolicy(config) {
  if (!isPlainObject(config)) return false;
  if (config.require_money_idempotency === true) return true;
  const norm = normalizeRunners(config.runners);
  if (norm.ok) {
    for (const cfg of Object.values(norm.value)) {
      if (isMoneyClass(cfg)) return true;
    }
  }
  const policy = config.policy;
  if (isPlainObject(policy) && Array.isArray(policy.require_for)) {
    for (const entry of policy.require_for) {
      if (isPlainObject(entry) && Array.isArray(entry.classes) &&
          entry.classes.some((c) => MONEY_CLASSES.has(c))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validate a parsed .fqe.yml config object.
 * @param {object} config  output of orchestrator.parseConfigYaml
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateConfig(config) {
  const errors = [];

  if (!isPlainObject(config)) {
    return { valid: false, errors: ['config must be a mapping at the top level'] };
  }

  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      errors.push(
        `unknown top-level key '${key}' (known keys: ${TOP_LEVEL_KEYS.join(', ')})`
      );
    }
  }

  if ('version' in config) {
    const v = config.version;
    if (typeof v !== 'string' && typeof v !== 'number') {
      errors.push(`'version' must be a string or number, got ${typeOf(v)}`);
    }
  }

  if ('require_coverage_evidence' in config && typeof config.require_coverage_evidence !== 'boolean') {
    errors.push(`'require_coverage_evidence' must be true or false, got ${typeOf(config.require_coverage_evidence)}`);
  }

  if ('require_all_suites_wired' in config && typeof config.require_all_suites_wired !== 'boolean') {
    errors.push(`'require_all_suites_wired' must be true or false, got ${typeOf(config.require_all_suites_wired)}`);
  }

  if ('require_money_idempotency' in config && typeof config.require_money_idempotency !== 'boolean') {
    errors.push(`'require_money_idempotency' must be true or false, got ${typeOf(config.require_money_idempotency)}`);
  }

  // A4 (v0.15): opt-in strict flag. When money-looking code is detected with no money
  // policy configured, this turns the heuristic FLAG into a blocking FAIL.
  if ('require_money_policy_when_detected' in config && typeof config.require_money_policy_when_detected !== 'boolean') {
    errors.push(`'require_money_policy_when_detected' must be true or false, got ${typeOf(config.require_money_policy_when_detected)}`);
  }

  // F2 (v0.16): opt-in. A gate with no teeth (no required runner / class / money req) mints
  // a green that protects nothing; with this on, that FAILs instead.
  if ('require_nonempty_gate' in config && typeof config.require_nonempty_gate !== 'boolean') {
    errors.push(`'require_nonempty_gate' must be true or false, got ${typeOf(config.require_nonempty_gate)}`);
  }

  // MS (v0.15): does this repo carry any money policy? Computed once, used to tighten
  // the mutation block (below) and each money-class runner (in validateRunner).
  const moneyPolicy = hasMoneyPolicy(config);

  if ('mutation' in config) {
    validateMutation(config.mutation, errors);
    // MS money-aware mutation caps: under a money policy the mutation gate must BLOCK,
    // and the equivalent-mutant allowlist + suppression ratio cannot be loosened to
    // neutralize a real money survivor. Closes the "advisory mutation on money" and
    // "suppress every survivor" carve-outs.
    if (moneyPolicy && isPlainObject(config.mutation)) {
      const mut = config.mutation;
      if (mut.mode !== 'blocking') {
        errors.push(`mutation.mode must be 'blocking' under a money policy (advisory mutation lets a money survivor ship green); set mode: blocking`);
      }
      if (Array.isArray(mut.allowlist) && mut.allowlist.length > MONEY_ALLOWLIST_CAP) {
        errors.push(`mutation.allowlist has ${mut.allowlist.length} entries; a money policy caps it at ${MONEY_ALLOWLIST_CAP} (an open-ended allowlist suppresses every real money survivor)`);
      }
      if ('max_suppression_ratio' in mut && typeof mut.max_suppression_ratio === 'number' && mut.max_suppression_ratio > 0.5) {
        errors.push(`mutation.max_suppression_ratio must be at most 0.5 under a money policy (a higher cap re-enables wholesale survivor suppression); got ${mut.max_suppression_ratio}`);
      }
    }
  }

  if ('policy' in config) {
    validatePolicy(config.policy, errors);
  }

  const norm = normalizeRunners(config.runners);
  if (!norm.ok) {
    errors.push(
      `'runners' must be a mapping of runner-name to config, got ${typeOf(config.runners)}`
    );
    return { valid: errors.length === 0, errors };
  }

  for (const [name, cfg] of Object.entries(norm.value)) {
    validateRunner(name, cfg, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateClassName(value, where, errors) {
  if (typeof value !== 'string' || !KNOWN_CLASSES.includes(value)) {
    errors.push(
      `${where}: '${value}' is not a known test class (known: ${KNOWN_CLASSES.join(', ')})`
    );
    return false;
  }
  return true;
}

/**
 * Validate the optional top-level `policy` block:
 *   policy:
 *     require_classes: ["unit", "lint"]        # always-required classes
 *     require_for:                             # diff-conditional requirements
 *       - when: ["src/payments/**"]
 *         classes: ["money", "regression"]
 * A required class with no passing runner is a FAIL at verdict time, so a typo'd
 * class here must be rejected up front rather than silently never-satisfiable.
 */
function validatePolicy(policy, errors) {
  if (!isPlainObject(policy)) {
    errors.push(`'policy' must be a mapping, got ${typeOf(policy)}`);
    return;
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.includes(key)) {
      errors.push(`policy: unknown key '${key}' (known keys: ${POLICY_KEYS.join(', ')})`);
    }
  }
  if ('require_classes' in policy) {
    const rc = policy.require_classes;
    if (!Array.isArray(rc)) {
      errors.push(`policy.require_classes: must be a list of class names, got ${typeOf(rc)}`);
    } else {
      rc.forEach((c) => validateClassName(c, 'policy.require_classes', errors));
    }
  }
  if ('require_for' in policy) {
    const rf = policy.require_for;
    if (!Array.isArray(rf)) {
      errors.push(`policy.require_for: must be a list of {when, classes} entries, got ${typeOf(rf)}`);
    } else {
      rf.forEach((entry, idx) => {
        const where = `policy.require_for[${idx}]`;
        if (!isPlainObject(entry)) {
          errors.push(`${where}: must be a mapping with 'when' and 'classes'`);
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!REQUIRE_FOR_KEYS.includes(key)) {
            errors.push(`${where}: unknown key '${key}' (known keys: ${REQUIRE_FOR_KEYS.join(', ')})`);
          }
        }
        if (!isArrayOfStrings(entry.when) || entry.when.length === 0) {
          errors.push(`${where}.when: must be a non-empty list of glob strings`);
        }
        if (!Array.isArray(entry.classes) || entry.classes.length === 0) {
          errors.push(`${where}.classes: must be a non-empty list of class names`);
        } else {
          entry.classes.forEach((c) => validateClassName(c, `${where}.classes`, errors));
        }
      });
    }
  }
}

/**
 * Validate the optional top-level `mutation` block (v0.13):
 *   mutation:
 *     mode: advisory        # advisory (FLAG survivors) | blocking (FAIL survivors)
 *     threshold: 70         # minimum kill rate %
 *     min_mutants: 1        # below this, neutral (cannot judge)
 *     allowlist: ["file:line:Mutator"]   # equivalent mutants to suppress
 * Mutation proves a test catches a planted fault. It sits BELOW contracts and money
 * invariants in the trust hierarchy, and starts ADVISORY so it never sprays false reds.
 */
function validateMutation(mut, errors) {
  if (!isPlainObject(mut)) {
    errors.push(`'mutation' must be a mapping, got ${typeOf(mut)}`);
    return;
  }
  for (const key of Object.keys(mut)) {
    if (!MUTATION_KEYS.includes(key)) {
      errors.push(`mutation: unknown key '${key}' (known: ${MUTATION_KEYS.join(', ')})`);
    }
  }
  if ('mode' in mut && mut.mode !== 'advisory' && mut.mode !== 'blocking') {
    errors.push(`mutation.mode must be 'advisory' or 'blocking', got '${mut.mode}'`);
  }
  if ('threshold' in mut) {
    const t = mut.threshold;
    if (typeof t !== 'number' || t < 0 || t > 100) {
      errors.push('mutation.threshold must be a number 0..100 (kill-rate percent)');
    }
  }
  if ('min_mutants' in mut) {
    const n = mut.min_mutants;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      errors.push('mutation.min_mutants must be a positive integer');
    } else if (n > MAX_MIN_MUTANTS) {
      // F8 (v0.15): a high floor pins `total < min_mutants` to NEUTRAL forever, which
      // silently disables the gate while looking like "cannot judge".
      errors.push(`mutation.min_mutants must be at most ${MAX_MIN_MUTANTS}; a higher floor pins the gate to NEUTRAL forever (cannot judge) and silently disables it. Omit the mutation block to skip mutation, do not set an unreachable floor.`);
    }
  }
  if ('max_suppression_ratio' in mut) {
    // F6 (v0.15): the fraction of in-scope survivors that may be allowlisted before
    // the advisory gate flags the suppression as suspicious.
    const r = mut.max_suppression_ratio;
    if (typeof r !== 'number' || r < 0 || r > 1) {
      errors.push('mutation.max_suppression_ratio must be a number between 0 and 1');
    }
  }
  if ('allowlist' in mut && !isArrayOfStrings(mut.allowlist)) {
    errors.push('mutation.allowlist must be a list of survivor keys (file:line:Mutator)');
  }
}

function validateRunner(name, cfg, errors) {
  const where = `runner '${name}'`;

  if (!isPlainObject(cfg)) {
    errors.push(`${where}: must be a mapping with at least a 'command'`);
    return;
  }

  for (const key of Object.keys(cfg)) {
    if (!RUNNER_KEYS.includes(key)) {
      errors.push(
        `${where}: unknown key '${key}' (known keys: ${RUNNER_KEYS.join(', ')}). ` +
        `A typo here silently disables the runner, so it is rejected.`
      );
    }
  }

  const commandOk = 'command' in cfg && typeof cfg.command === 'string' && cfg.command.trim() !== '';
  if (!commandOk) {
    errors.push(`${where}: 'command' is required and must be a non-empty string`);
  }

  if ('args' in cfg && !isArrayOfStrings(cfg.args)) {
    errors.push(`${where}: 'args' must be a list of strings`);
  }

  if ('when' in cfg && !isArrayOfStrings(cfg.when)) {
    errors.push(`${where}: 'when' must be a list of glob strings`);
  }

  if ('required' in cfg && typeof cfg.required !== 'boolean') {
    errors.push(`${where}: 'required' must be true or false`);
  }

  if ('always_run' in cfg && typeof cfg.always_run !== 'boolean') {
    errors.push(`${where}: 'always_run' must be true or false`);
  }

  if ('timeout_ms' in cfg) {
    const t = cfg.timeout_ms;
    if (typeof t !== 'number' || !Number.isInteger(t) || t <= 0) {
      errors.push(`${where}: 'timeout_ms' must be a positive integer (milliseconds)`);
    }
  }

  if ('class' in cfg) {
    validateClassName(cfg.class, `${where}: 'class'`, errors);
  }

  // adversarial gate (v0.14): blast_radius must name a canonical class so the
  // orchestrator can bind its threshold and require its stats. An unknown value
  // would otherwise be assembled and only caught at verdict time; reject it here.
  if ('blast_radius' in cfg) {
    if (typeof cfg.blast_radius !== 'string' || !KNOWN_BLAST_RADII.includes(cfg.blast_radius)) {
      errors.push(`${where}: 'blast_radius' must be one of ${KNOWN_BLAST_RADII.join(', ')}, got '${cfg.blast_radius}'`);
    } else if (cfg.required !== true) {
      // HIGH-2 (v0.14.0): a blast-class runner that is not required could simply not
      // fire (a diff that misses its `when` globs) and silently skip the adversarial
      // stat requirement. Force it required so a non-firing money runner FAILs Pass 1.
      errors.push(`${where}: a runner that declares 'blast_radius' must be 'required: true' (otherwise a diff that avoids its 'when' globs would skip the adversarial-stat requirement)`);
    }
  }

  // --- coverage-liveness fields (v0.9.0) ---
  if ('report' in cfg) {
    if (typeof cfg.report !== 'string' || !/^junit:.+/.test(cfg.report.trim())) {
      errors.push(`${where}: 'report' must be a string of the form 'junit:<path>'`);
    }
  }
  if ('inventory_cmd' in cfg && (typeof cfg.inventory_cmd !== 'string' || cfg.inventory_cmd.trim() === '')) {
    errors.push(`${where}: 'inventory_cmd' must be a non-empty shell string`);
  }
  if ('inventory_format' in cfg && !KNOWN_FORMATS.includes(cfg.inventory_format)) {
    errors.push(
      `${where}: 'inventory_format' must be one of ${KNOWN_FORMATS.join(', ')}, got '${cfg.inventory_format}'`
    );
  }
  if ('min_tests' in cfg) {
    const n = cfg.min_tests;
    // Minimum 1: min_tests: 0 would disable the executed-count floor entirely, which
    // is exactly the "a green minted by a suite that ran nothing" hole we close.
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      errors.push(`${where}: 'min_tests' must be a positive integer (>= 1); 0 would disable the empty-suite gate`);
    }
  }
  if ('reconcile' in cfg && typeof cfg.reconcile !== 'boolean') {
    errors.push(`${where}: 'reconcile' must be true or false`);
  }
  if ('strict_coverage' in cfg && typeof cfg.strict_coverage !== 'boolean') {
    errors.push(`${where}: 'strict_coverage' must be true or false`);
  }

  if ('retries' in cfg) {
    const r = cfg.retries;
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > 5) {
      errors.push(`${where}: 'retries' must be an integer 0..5 (re-runs a failed runner to detect a flake)`);
    }
  }
  if ('quarantined' in cfg && typeof cfg.quarantined !== 'boolean') {
    errors.push(`${where}: 'quarantined' must be true or false`);
  }
  // F1 (v0.15): a quarantine must be dated, may set a TTL, and can never hide a money
  // failure. quarantined_since lets it expire; the orchestrator re-blocks an expired one.
  if ('quarantine_ttl_days' in cfg) {
    const d = cfg.quarantine_ttl_days;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 90) {
      errors.push(`${where}: 'quarantine_ttl_days' must be an integer 1..90`);
    }
  }
  if (cfg.quarantined === true) {
    if (isMoneyClass(cfg)) {
      errors.push(`${where}: 'quarantined: true' is forbidden on class '${cfg.class}' (a money/contract test failure can never be muted)`);
    }
    if (!('quarantined_since' in cfg)) {
      errors.push(`${where}: 'quarantined: true' requires 'quarantined_since' (an ISO date) so the quarantine can expire`);
    } else if (parseIsoDateUtc(cfg.quarantined_since) === null) {
      errors.push(`${where}: 'quarantined_since' is not a parseable ISO date (use YYYY-MM-DD or a full ISO timestamp), got '${cfg.quarantined_since}'`);
    }
  } else if ('quarantined_since' in cfg || 'quarantine_ttl_days' in cfg) {
    errors.push(`${where}: 'quarantined_since'/'quarantine_ttl_days' require 'quarantined: true'`);
  }
  if ('invariant' in cfg) {
    const inv = cfg.invariant;
    if (!isArrayOfStrings(inv) || inv.length === 0) {
      errors.push(`${where}: 'invariant' must be a non-empty list of invariant ids (${KNOWN_INVARIANTS.join(', ')})`);
    } else {
      for (const id of inv) {
        if (!KNOWN_INVARIANTS.includes(id)) {
          errors.push(`${where}: 'invariant' has unknown id '${id}' (known: ${KNOWN_INVARIANTS.join(', ')})`);
        }
      }
    }
  }

  // Coherence (fail closed): coverage fields are meaningless without a report,
  // and reconciliation is meaningless without an inventory to compare against.
  const hasReport = 'report' in cfg;
  const coverageOnlyFields = ['min_tests', 'reconcile', 'strict_coverage', 'inventory_cmd', 'inventory_format'];
  const usedCoverageField = coverageOnlyFields.find((k) => k in cfg);
  if (usedCoverageField && !hasReport) {
    errors.push(
      `${where}: '${usedCoverageField}' requires a 'report: junit:<path>' so fqe can read what executed`
    );
  }
  if (cfg.reconcile === true && !('inventory_cmd' in cfg)) {
    errors.push(`${where}: 'reconcile: true' requires an 'inventory_cmd' to count collected tests`);
  }
  if ('inventory_cmd' in cfg && !('inventory_format' in cfg)) {
    errors.push(`${where}: 'inventory_cmd' requires 'inventory_format' so fqe knows how to read its output`);
  }

  // MS (v0.15): a money/contract runner is strict by default. It must be required,
  // must prove its tests ran (report), must reconcile, must use strict_coverage, and
  // may not be quarantined. Loosening any of these FAILS validation loudly; the gate
  // refuses to run rather than silently weaken on a money path.
  if (isMoneyClass(cfg)) {
    if (cfg.required !== true) {
      errors.push(`${where}: a money/contract runner must be 'required: true' (a money test that can be skipped is not a gate)`);
    }
    if (!('report' in cfg)) {
      errors.push(`${where}: a money/contract runner must declare 'report: junit:<path>' so fqe can prove its tests actually ran`);
    }
    if (cfg.strict_coverage !== true) {
      errors.push(`${where}: a money/contract runner must set 'strict_coverage: true' (a partial money suite must block, not flag)`);
    }
    if (cfg.reconcile !== true) {
      errors.push(`${where}: a money/contract runner must set 'reconcile: true' (so a mis-scoped money suite is caught)`);
    }
    if (cfg.quarantined === true) {
      errors.push(`${where}: a money/contract runner can never be 'quarantined' (a muted money failure is a silent loss)`);
    }
  }

  // Firing rule: a runner with neither a non-empty 'when' nor 'always_run: true'
  // can never fire. That is the silent no-op the permissive parser used to hide.
  // Only report it once the runner is otherwise well-formed: a runner with a
  // broken command already has its error, and a "never fires" note on top would
  // just be confusing noise.
  const hasWhen = Array.isArray(cfg.when) && cfg.when.length > 0;
  const alwaysRun = cfg.always_run === true;
  if (commandOk && !hasWhen && !alwaysRun) {
    errors.push(
      `${where}: will never fire. Give it 'when' glob patterns or set 'always_run: true'.`
    );
  }
}

module.exports = {
  validateConfig, TOP_LEVEL_KEYS, RUNNER_KEYS, MUTATION_KEYS,
  MONEY_CLASSES, MONEY_ALLOWLIST_CAP, MAX_MIN_MUTANTS,
  hasMoneyPolicy, isMoneyClass, parseIsoDateUtc,
};
