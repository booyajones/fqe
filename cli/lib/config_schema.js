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

const { KNOWN_CLASSES } = require('./verdict');
const { KNOWN_FORMATS } = require('./inventory');

const TOP_LEVEL_KEYS = ['runners', 'version', 'policy', 'require_coverage_evidence', 'require_all_suites_wired'];
const RUNNER_KEYS = [
  'command', 'args', 'when', 'required', 'always_run', 'timeout_ms', 'class',
  // coverage-liveness (v0.9.0): proof that real tests actually executed.
  'report', 'inventory_cmd', 'inventory_format', 'min_tests', 'reconcile', 'strict_coverage',
  // trust hygiene (v0.10): flaky-retry + quarantine so one random red never blocks.
  'retries', 'quarantined',
];
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

module.exports = { validateConfig, TOP_LEVEL_KEYS, RUNNER_KEYS };
