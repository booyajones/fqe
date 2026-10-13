'use strict';

/**
 * fqe init — one-command repo bootstrap.
 *
 * Writes the files needed to deploy the gate on a Finexio repo:
 *   .fqe.yml                                — runner config (sample)
 *   .github/workflows/fqe-quality.yml        — main CI gate
 *   .github/workflows/fqe-publish.yml        — trusted checks + audit publisher
 *   .github/fqe-bypass-allowlist.yml         — who can bypass (default: current gh user)
 *   .github/fqe-second-reviewers.yml         — who can second-approve (empty by default)
 *
 * Idempotent: refuses to overwrite existing files unless --force.
 * Returns { written: [...], skipped: [...] }.
 *
 * Canonical workflow templates ship with the root npm package.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Additional templates wired by `--with-mutation` and `--with-qodo`. See the
 * docs/recipes/ai-test-generation.md for the full recipe.
 */
const MUTATION_RUNNER_BLOCK = `
  # Wired by 'fqe init --with-mutation'. The configured mutation judge
  # reads the full report; its deterministic kill rate is not a sampled attack rate.
  stryker-mutation:
    command: "node"
    args: ["scripts/fqe_stryker_runner.js"]
    always_run: true
    required: true
    class: mutation
    timeout_ms: 900000
`;

const QODO_RUNNER_BLOCK = `
  # Wired by 'fqe init --with-qodo'. Generates AI test candidates via Qodo
  # Cover (Meta TestGen-LLM filter pipeline). Requires ANTHROPIC_API_KEY
  # (preferred, uses Finexio's existing Claude key) or OPENAI_API_KEY in the
  # workflow secrets. The generated tests are then mutation-tested by the
  # stryker-mutation runner above; that's what actually gates the PR.
  qodo-cover:
    command: "bash"
    args: ["scripts/fqe_qodo_runner.sh"]
    when: ["**/*.js", "**/*.ts", "**/*.py"]
    required: false
    timeout_ms: 600000
`;

// MS (v0.15): the PAYMENTS profile (fqe init --payments). Money repos are strict by
// default: every money/contract runner is locked to the safe configuration fqe enforces
// (required, coverage evidence, reconcile, strict_coverage, blocking mutation, no
// quarantine). Loosening any of it FAILS validation loudly.
//
// Since 2026-08-17: the money/contract runners ship COMMENTED OUT, behind the ARM markers.
// They used to ship live, and that made the profile unusable: fqe's `required: true`
// means "this runner must fire on THIS pull request" (docs/troubleshooting.md), the
// validator FORCES every money/contract runner to be required, and those runners were
// scoped with `when: ["src/payments/**", ...]`. So every pull request whose diff missed
// those globs FAILED with "required runner money did not run" - a docs-only PR, in a
// fresh repo AND in a real payments repo that already has src/payments. Add the dead
// require_for globs (BLOCKED under require_money_policy_when_detected) and the
// require_money_idempotency flag with no runner to prove it, and `fqe init --payments`
// produced a config that could not pass any pull request at all.
//
// What is live now is the part that works in ANY repo, and it still has teeth:
// require_money_policy_when_detected FAILS the first PR that adds money-looking code
// with no money policy configured, which is the cue to arm the template.
//
// The armed runners use `always_run: true`, not `when:` globs, matching
// docs/recipes/money-invariants.md. Under fqe's `required` semantics that is the only
// self-consistent shape for a money runner, and it is right on its own merits: a change
// OUTSIDE src/payments that breaks a payment is exactly the one the money suite must catch.
//
// ARM_BEGIN_RE / ARM_END_RE below are the sentinels a human (and money_strict.test.js)
// uses to uncomment the template. Keep them in sync with the text.
const PAYMENTS_FQE_YML = `# Finexio Quality Engine - PAYMENTS profile (fqe init --payments)
#
# This profile ships ARMED BUT INERT. It is a TEMPLATE, not a finished gate.
#
# LIVE right now, in any repo:
#   require_money_policy_when_detected  the first pull request that adds money-LOOKING
#                                       code FAILS with "money-looking code is present but
#                                       no money policy is configured". That is your cue to
#                                       arm the template below. It triggers on a payments /
#                                       ledger / billing / settlement / invoice / payout
#                                       PATH, or on any of these stems in a source file:
#                                       idempoten, debit, credit, settle, reconcil,
#                                       chargeback, payout, invoice, ledger, double-spend,
#                                       no-negative-balance, remittance, disbursement.
#                                       It is a heuristic, not a proof: money-moving code
#                                       under a name it does not know (src/txn/, src/xfer/)
#                                       is NOT detected. Arm the template; do not rely on
#                                       the detector to notice for you.
#   mutation                            configured only with --with-mutation, and then
#                                       blocking with an actual report-producing runner.
#
# COMMENTED OUT ON PURPOSE: the money and contract runners call 'npm run test:money' and
# 'npm run test:contract'. fqe cannot know your scripts. Shipping them live blocks EVERY
# pull request in a repo that does not already have them - including the one that adds them.
#
# TO ARM THE MONEY GATE: uncomment BOTH marked blocks and point the runners at your real
# scripts. On Windows also restructure the command itself, not just its arguments (see the
# note at the bottom). Nothing else needs editing: the armed runners are always_run, so
# they do not name a single path, and there is no glob to get wrong.
#
# The two blocks are not symmetric:
#   ARM 2 alone (the runners) is a WORKING gate. A money-class runner arms the idempotency
#     requirement by itself, so you get that for free. ARM 1 states it explicitly, which
#     keeps the requirement on if the runners are ever renamed or removed.
#   ARM 1 alone (the flag, no runner that can PROVE the invariant) BLOCKS EVERY PULL
#     REQUEST, by design. Do not arm it on its own.
#
# There is deliberately NO policy.require_for in the armed default. See the OPTIONAL block
# further down for why, and read its warning before you turn it on.
#
# Note 'always_run: true' on the runners, NOT 'when:' globs. In fqe, 'required: true' means
# "this runner must fire on THIS pull request", and the validator forces every money or
# contract runner to be required - so a 'when'-scoped money runner FAILS every pull request
# whose diff misses its globs. always_run is also correct on its own merits: a change
# OUTSIDE src/payments that breaks a payment is exactly what the money suite must catch.
# Same shape as docs/recipes/money-invariants.md.
#
# Money strictness is not negotiable once armed. A money/contract runner must be required,
# must declare a junit report, must reconcile, must set strict_coverage, and can never be
# quarantined. Loosening any of it FAILS validation loudly; the gate refuses to run rather
# than silently weaken on a money path. Add your own unit/lint runners too.
#
# On Windows the runners below need RESTRUCTURING, not just retargeting: "command: npm"
# never starts (npm is npm.cmd and fqe spawns without a shell), and it fails as a spawn
# error, not a test failure. Move npm into args:
#   command: "cmd"
#   args: ["/c", "npm", "run", "test:money"]

version: 0.15
require_money_policy_when_detected: true
# If fqe cannot resolve the diff it cannot tell which runners were required, so a
# green result would mean "nothing was checked", not "nothing was wrong". On a
# money repo that must block, not flag.
require_resolvable_diff: true

# Mutation is optional until configured. Run init --payments --with-mutation to
# install its real runner; a declared gate without a report is a blocking failure.

# >>> ARM 1 of 2: uncomment every line between this marker and END ARM 1. >>>
# require_money_idempotency: true
# <<< END ARM 1 of 2 <<<

# OPTIONAL, and NOT part of arming. policy.require_for binds a PATH to the test classes
# that must have run and passed when that path changes. The armed runners are always_run,
# so the money and contract classes are already demanded on every pull request;
# require_for adds nothing for them. It is worth turning on only to demand a class the
# armed runners do NOT provide - regression is the usual one.
#
# It comes in TWO PIECES that live in two different places: the policy here, and a
# regression runner further down under runners:. Each piece is positioned so that
# uncommenting it WHERE IT SITS is correct - do not move them. Turn on both or neither.
#
# READ BOTH WARNINGS FIRST. Each blocks EVERY pull request, not just money ones:
#
#   1. Every glob must match a real file in YOUR repo. A glob that matches nothing is
#      BLOCKED (dead policy glob) under require_money_policy_when_detected, which is on
#      above. That is deliberate - a typo'd money path would otherwise silently grant the
#      loose bar - but it also fires for the ordinary case of "we do not happen to have a
#      directory by that name". Replace the path below with YOUR money paths, and list
#      every one of them: a glob for a directory this repo does not have blocks every PR.
#
#   2. Every class you name must have a runner that RAN AND PASSED, or the gate FAILs on
#      exactly the pull requests those globs cover - the money PRs. Naming "regression"
#      here without also uncommenting the regression runner below is the trap.
#
# >>> OPTIONAL 1 of 2 (the policy): uncomment every line to END OPTIONAL 1, then edit. >>>
# policy:
#   require_for:
#     - when: ["src/payments/**"]
#       classes: ["money", "regression"]
# <<< END OPTIONAL 1 of 2 <<<
# OPTIONAL 2 of 2 (the regression runner) is under runners:, further down.
# See docs/recipes/regression-golden.md.

# Your runners go under this key. The empty scaffold is not a configured quality gate.
runners:
# >>> ARM 2 of 2: uncomment every line between this marker and END ARM 2. >>>
#   money:
#     command: "npm"
#     args: ["run", "test:money"]
#     always_run: true
#     class: money
#     required: true
#     report: "junit:reports/money-junit.xml"
#     inventory_cmd: "npm run test:money -- --listTests --silent | grep -c ."
#     inventory_format: count
#     reconcile: true
#     strict_coverage: true
#     min_tests: 1
#     invariant: ["idempotency", "no-negative-balance"]
#
#   contract:
#     command: "npm"
#     args: ["run", "test:contract"]
#     always_run: true
#     class: contract
#     required: true
#     report: "junit:reports/contract-junit.xml"
#     inventory_cmd: "npm run test:contract -- --listTests --silent | grep -c ."
#     inventory_format: count
#     reconcile: true
#     strict_coverage: true
#     min_tests: 1
# <<< END ARM 2 of 2 <<<

# OPTIONAL 2 of 2 - the regression runner for the policy above, and NOT part of arming.
# It already sits under runners:, at the right indent.
#
# Turn on BOTH pieces or NEITHER, for two different reasons:
#   OPTIONAL 1 without this = every money PR FAILs, because the policy demands a
#     regression class no runner provides.
#   This without OPTIONAL 1 = still a live gate, not a no-op. It is always_run and
#     required ON ITS OWN, so it fires and can block on EVERY pull request; what you lose
#     is only the path-to-class binding. And until you have captured a manifest it exits
#     non-zero, so arming it alone blocks every PR immediately.
#
# 'fqe golden verify' needs a manifest you have already captured; without one it exits
# non-zero with a clear message, which on a required runner blocks the merge. Run
# 'fqe golden capture' first. See docs/recipes/regression-golden.md.
#
# >>> OPTIONAL 2 of 2 (the runner): uncomment every line to END OPTIONAL 2. >>>
#   regression:
#     command: "node"
#     args: ["node_modules/.bin/fqe", "golden", "verify", "--manifest", "golden.yml", "--dir", "goldens"]
#     always_run: true
#     class: regression
#     required: true
# <<< END OPTIONAL 2 of 2 <<<
`;

// The block sentinels, exported so a test can uncomment the template exactly the way the
// scaffold tells a human to, and prove the commented-out blocks are still a valid config.
// A template nobody validates rots into one that fails the moment somebody turns it on.
//
// ARM = the money gate itself. OPTIONAL = the require_for policy and its regression
// runner, which are NOT part of arming. Two distinct marker vocabularies so arming can
// never pick up the optional pieces: a `fqe golden verify` runner armed without a captured
// manifest is a required runner that dies on every PR.
const ARM_BEGIN_RE = /^# >>> ARM \d of 2:.*>>>$/;
const ARM_END_RE = /^# <<< END ARM \d of 2 <<<$/;
const OPT_BEGIN_RE = /^# >>> OPTIONAL \d of 2 .*>>>$/;
const OPT_END_RE = /^# <<< END OPTIONAL \d of 2 <<<$/;

/**
 * Uncomment every line BETWEEN a begin and end sentinel, and drop the sentinel lines.
 *
 * Position-based on purpose. An earlier test uncommented by matching a hand-listed set of
 * YAML key names instead, and it passed while silently leaving behind any line whose key
 * was not on the list - validating a config no human would ever produce. Uncommenting is a
 * property of WHERE a line is, not of what it says, so the mechanism has to be positional.
 *
 * @param {string} yml
 * @param {RegExp} beginRe
 * @param {RegExp} endRe
 * @param {string} label  block name, for the unclosed-marker error
 * @returns {string}
 */
function uncommentBlocks(yml, beginRe, endRe, label) {
  const out = [];
  let inside = false;
  // Tolerate CRLF: a caller that reads a generated .fqe.yml back off disk gets \r\n, and
  // a \n-only split would leave a trailing \r that the $-anchored marker regexes miss.
  for (const line of String(yml).split(/\r?\n/)) {
    if (!inside && beginRe.test(line)) { inside = true; continue; }
    if (inside && endRe.test(line)) { inside = false; continue; }
    out.push(inside ? line.replace(/^# ?/, '') : line);
  }
  // An unclosed marker silently uncomments the whole rest of the file, prose included.
  // That happens to fail later in the YAML parser today, which is fail-loud by accident;
  // make it fail-loud by construction, at the point the shape is actually wrong.
  if (inside) {
    throw new Error(`uncommentBlocks: an ${label} block was opened and never closed`);
  }
  return out.join('\n');
}

/**
 * Arm the money gate: uncomment the ARM-marked blocks. The mechanical form of the
 * instruction printed in the scaffold header. Leaves the OPTIONAL blocks alone.
 * @param {string} yml
 * @returns {string}
 */
function armPaymentsTemplate(yml) {
  return uncommentBlocks(yml, ARM_BEGIN_RE, ARM_END_RE, 'ARM');
}

/**
 * Turn on the OPTIONAL require_for policy and its regression runner. Both pieces, since
 * either alone blocks every money pull request. Leaves the ARM blocks alone.
 * @param {string} yml
 * @returns {string}
 */
function enableOptionalPolicy(yml) {
  return uncommentBlocks(yml, OPT_BEGIN_RE, OPT_END_RE, 'OPTIONAL');
}

const FILES = {
  '.fqe.yml': `# Finexio Quality Engine - repo config
# Each runner declares: command, args, when (glob patterns), required, always_run,
# and an optional class (the test type). Empty config = no runners = always PASS.
#
# Test classes (the full-suite taxonomy): unit, integration, e2e, regression,
# contract, property, uat, lint, type, mutation, coverage, security, money.
#
# Examples. These go UNDER the live "runners:" key at the bottom of this file.
# Do NOT uncomment a second "runners:" line: YAML takes the last key, so a
# duplicate silently discards everything you configured and leaves you with a
# gate that passes everything.
#
# On Windows, "command: npm" does not start (npm is npm.cmd and fqe spawns
# without a shell). Use command: "cmd", args: ["/c", "npm", "test"] there.
#
#   unit:
#     command: "npm"
#     args: ["test"]
#     when: ["**/*.ts", "test/**"]
#     class: unit
#     required: true
#
#   web:
#     command: "npx"
#     args: ["playwright", "test"]
#     when: ["**/*.tsx", "**/*.jsx", "**/*.html"]
#     class: e2e
#
#   regression:
#     command: "node"
#     args: ["../cli/bin/fqe.js", "golden", "verify", "--manifest", "golden.yml", "--dir", "goldens"]
#     when: ["src/**"]
#     class: regression
#
#   acceptance:
#     command: "node"
#     args: ["../cli/bin/fqe.js", "uat", "--spec", "uat.yml", "--results", "uat-results.json", "--strict"]
#     always_run: true
#     class: uat
#
# Full-suite policy (optional). require_classes are always demanded; require_for
# adds classes only when matching files change. A required class with no passing
# runner is a FAIL — this is how "money paths get the strict bar" works.
#
# policy:
#   require_classes: ["unit", "lint"]
#   require_for:
#     - when: ["src/payments/**", "src/ledger/**"]
#       classes: ["money", "regression", "contract"]

# Add required runners under this key. Until then, require_nonempty_gate blocks.
# Block style (a bare "runners:") is the form the config parser handles; the
# inline "runners: {}" it used to emit is read as a 2-character string.
require_nonempty_gate: true
runners:
`,

  '.github/workflows/fqe-quality.yml': fs.readFileSync(path.join(__dirname, '../../workflows/fqe-quality.yml.template'), 'utf8'),
  '.github/workflows/fqe-publish.yml': fs.readFileSync(path.join(__dirname, '../../workflows/fqe-publish.yml.template'), 'utf8'),

  '.github/fqe-bypass-allowlist.yml': `# Who can post a SHA-bound /fqe-bypass <head-sha> <ttl> comment.
# The trusted publisher reads this allowlist at the live default branch.
#
# Modifying this file is itself a PR that goes through the gate.

allowed_actors:
  - __FQE_DEFAULT_ACTOR__
`,

  '.github/fqe-second-reviewers.yml': `# Who can approve the current PR head when the bypass rate is high or oracles changed.
# Reviewers must differ from both the PR author and bypass requester.
# The trusted publisher reads this list at the live default branch.
#
# Add real reviewers here. Single-entry is acceptable for a solo operator but
# means same-actor rejection becomes the only collusion defense.

allowed_actors: []
`,

};

/**
 * Detect the current GitHub actor via `gh api user`. Used to seed the
 * bypass allowlist. Returns null if gh isn't installed or not authenticated.
 */
function currentGhActor() {
  try {
    const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (r.status === 0 && r.stdout) {
      return r.stdout.trim();
    }
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * Detect the default branch of the git repo at `dir`. Tries (in order):
 *   1. git symbolic-ref refs/remotes/origin/HEAD
 *   2. gh repo view --json defaultBranchRef
 *   3. Fall back to 'main'
 */
function detectDefaultBranch(dir) {
  // Try git symbolic-ref (works offline if origin/HEAD is set)
  try {
    const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0 && r.stdout) {
      const ref = r.stdout.trim();
      // "origin/main" -> "main"
      const m = ref.match(/^origin\/(.+)$/);
      if (m) return m[1];
    }
  } catch (_) { /* fall through */ }
  // Try gh repo view (works for cloned repos with remote origin)
  try {
    const r = spawnSync('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], {
      encoding: 'utf8',
      timeout: 10000,
      cwd: dir,
    });
    if (r.status === 0 && r.stdout) {
      return r.stdout.trim();
    }
  } catch (_) { /* fall through */ }
  return 'main';
}

/**
 * Read a packaged template file (under cli/templates/). Returns null if missing,
 * which is how we tell init() to skip mutation wiring on installs that didn't
 * ship the templates dir.
 */
function readPackagedTemplate(name) {
  const candidates = [
    path.join(__dirname, '..', 'templates', name),
    path.join(__dirname, '..', '..', 'cli', 'templates', name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
}

/**
 * Append a runner block to the existing .fqe.yml template's runners: section.
 * Handles three states: (1) `runners: {}` (vanilla), (2) `runners:` already
 * populated by a prior --with-X flag, (3) malformed. Returns the new yaml or
 * the original if no anchor was found.
 */
function appendRunnerBlock(yml, block) {
  // Case 1: vanilla "runners: {}". No separator needed and none added: this branch
  // REPLACES the "runners: {}" line, so the block lands directly under the key it belongs
  // to with nothing before it to be confused with. Cases 2 and 3 append after existing
  // content, which is where the separator matters. Nothing the CLI generates reaches this
  // branch today (both scaffolds emit a bare "runners:"), but it is exported API.
  if (/\nrunners:\s*\{\}\s*\n?$/m.test(yml)) {
    return yml.replace(/\nrunners:\s*\{\}\s*\n?$/m, `\nrunners:${block}`);
  }
  // Case 2: already populated "runners:\n  <something>" — append at the end.
  // The leading \n is a SEPARATOR, not cosmetics. `\s*$` eats the template's own trailing
  // newline, so without it the appended block's first line butts directly against whatever
  // the template ended with. The payments template ends with a COMMENTED-OUT runner
  // example, and a live runner starting on the very next line reads as part of it — a
  // reader skimming "what is actually enabled" can misjudge where the example stops.
  // A blank line makes the boundary visible in every combination, not just this one.
  if (/\nrunners:\s*\n/m.test(yml)) {
    return yml.replace(/\s*$/, `\n${block}`);
  }
  // Case 3: no anchor found — append a runners: section
  return yml.replace(/\s*$/, `\n\nrunners:${block}`);
}

/**
 * @param {{ dir: string, force?: boolean, actor?: string, withMutation?: boolean, withQodo?: boolean }} opts
 */
function init(opts) {
  const dir = path.resolve(opts.dir || process.cwd());
  if (!fs.existsSync(dir)) {
    throw new Error(`init: target dir does not exist: ${dir}`);
  }
  // Detect a repo: must contain .git OR be passed explicitly via --force
  const isRepo = fs.existsSync(path.join(dir, '.git'));
  if (!isRepo && !opts.force) {
    throw new Error(`init: ${dir} is not a git repo. Run 'git init' first or pass --force.`);
  }

  const actor = opts.actor || currentGhActor() || 'REPLACE_WITH_GITHUB_LOGIN';
  const defaultBranch = opts.defaultBranch || detectDefaultBranch(dir);
  if (opts.ref !== undefined && !/^(?:[a-f0-9]{40}|fqe-v\d+\.\d+\.\d+)$/.test(opts.ref)) {
    throw new Error('init: --ref must be a full commit SHA or an FQE release tag');
  }

  const written = [];
  const skipped = [];
  const notes = [];

  // Build per-invocation FILES so we can conditionally append runner blocks
  // to .fqe.yml WITHOUT mutating the module-level FILES constant.
  const dynamicFiles = { ...FILES };

  // MS (v0.15): the payments profile swaps the base .fqe.yml for the strict money
  // scaffold BEFORE the --with-* appends, so a stryker/qodo runner block lands on it.
  if (opts.payments) {
    dynamicFiles['.fqe.yml'] = PAYMENTS_FQE_YML;
  }

  if (opts.withMutation) {
    const strykerRunner = readPackagedTemplate('fqe_stryker_runner.js');
    const strykerConf = readPackagedTemplate('stryker.conf.json');
    if (!strykerRunner || !strykerConf) {
      notes.push('--with-mutation requested but templates/ not found on disk. Skipped mutation wiring.');
    } else {
      dynamicFiles['.fqe.yml'] = 'mutation:\n  mode: ' + (opts.payments ? 'blocking' : 'advisory') + '\n  threshold: 80\n  min_mutants: 1\n  max_suppression_ratio: 0.5\n\n' + dynamicFiles['.fqe.yml'];
      dynamicFiles['.fqe.yml'] = appendRunnerBlock(dynamicFiles['.fqe.yml'], MUTATION_RUNNER_BLOCK);
      dynamicFiles['scripts/fqe_stryker_runner.js'] = strykerRunner;
      dynamicFiles['stryker.conf.json'] = strykerConf;
    }
  }

  if (opts.withQodo) {
    const qodoRunner = readPackagedTemplate('fqe_qodo_runner.sh');
    if (!qodoRunner) {
      notes.push('--with-qodo requested but templates/fqe_qodo_runner.sh not found on disk. Skipped Qodo wiring.');
    } else {
      dynamicFiles['.fqe.yml'] = appendRunnerBlock(dynamicFiles['.fqe.yml'], QODO_RUNNER_BLOCK);
      dynamicFiles['scripts/fqe_qodo_runner.sh'] = qodoRunner;
    }
  }

  for (const [relPath, template] of Object.entries(dynamicFiles)) {
    const fullPath = path.join(dir, relPath);
    const exists = fs.existsSync(fullPath);
    if (exists && !opts.force) {
      skipped.push(relPath);
      continue;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const content = template
      .replace(/__FQE_DEFAULT_ACTOR__/g, actor)
      .replace(/__FQE_DEFAULT_BRANCH__/g, defaultBranch)
      .replace(/FQE_REF="fqe-v\d+\.\d+\.\d+"/g, match => opts.ref ? `FQE_REF="${opts.ref}"` : match);
    fs.writeFileSync(fullPath, content);
    written.push(relPath);
  }

  notes.push('Require fqe/pass in branch protection, add a real second reviewer on the default branch, and remove the retired fqe-second-approve.yml workflow. The publisher must be installed on the default branch before it can handle workflow_run events.');

  // Leave breadcrumbs about what's next
  if (opts.withMutation && written.includes('scripts/fqe_stryker_runner.js')) {
    notes.push('Next: npm install --save-dev @stryker-mutator/core, then commit + open PR. See docs/recipes/ai-test-generation.md.');
  }
  if (opts.withQodo && written.includes('scripts/fqe_qodo_runner.sh')) {
    notes.push('Next: chmod +x scripts/fqe_qodo_runner.sh and add ANTHROPIC_API_KEY to repo Secrets (Settings, Secrets and variables, Actions). Qodo Cover uses Finexio\'s existing Claude key by default.');
  }

  return { written, skipped, actor, defaultBranch, dir, notes };
}

module.exports = {
  init,
  FILES,
  currentGhActor,
  readPackagedTemplate,
  appendRunnerBlock,
  MUTATION_RUNNER_BLOCK,
  QODO_RUNNER_BLOCK,
  PAYMENTS_FQE_YML,
  armPaymentsTemplate,
  enableOptionalPolicy,
  uncommentBlocks,
  ARM_BEGIN_RE,
  ARM_END_RE,
  OPT_BEGIN_RE,
  OPT_END_RE,
};
