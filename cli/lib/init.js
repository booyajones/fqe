'use strict';

/**
 * fqe init — one-command repo bootstrap.
 *
 * Writes the files needed to deploy the gate on a Finexio repo:
 *   .fqe.yml                                — runner config (sample)
 *   .github/workflows/fqe-quality.yml        — main CI gate
 *   .github/workflows/fqe-second-approve.yml — bypass-rate unblock
 *   .github/fqe-bypass-allowlist.yml         — who can bypass (default: current gh user)
 *   .github/fqe-second-reviewers.yml         — who can second-approve (empty by default)
 *   .github/fqe-state/.gitkeep               — ensures the state dir exists
 *
 * Idempotent: refuses to overwrite existing files unless --force.
 * Returns { written: [...], skipped: [...] }.
 *
 * Templates are inlined so the npm package is self-contained.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Additional templates wired by `--with-mutation` and `--with-qodo`. See the
 * docs/recipes/ai-test-generation.md for the full recipe.
 */
const MUTATION_RUNNER_BLOCK = `
  # Wired by 'fqe init --with-mutation'. Reads Stryker's mutation report and
  # emits Wilson-CI-bounded adversarial_stats. blast_radius defaults to
  # mcp-write-or-financial (1% survival ceiling) which is correct for code
  # that touches money or state. Re-tune via FQE_STRYKER_BLAST_RADIUS env var.
  stryker-mutation:
    command: "node"
    args: ["scripts/fqe_stryker_runner.js"]
    when: ["**/*.js", "**/*.ts", "test/**", "stryker.conf.json"]
    required: true
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
#   mutation                            blocking, already inside the caps a money policy
#                                       requires, so arming does not fail validation.
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

mutation:
  mode: blocking
  threshold: 80
  min_mutants: 1
  max_suppression_ratio: 0.5

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

# Your runners go under this key. Left empty, the gate runs and always passes.
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

# Add your runners under this key. Left empty, the gate runs and always passes.
# Block style (a bare "runners:") is the form the config parser handles; the
# inline "runners: {}" it used to emit is read as a 2-character string.
runners:
`,

  '.github/workflows/fqe-quality.yml': `# Finexio Quality Engine - main CI gate
# Generated by 'fqe init'. Edit .fqe.yml to configure runners.
#
# Architectural invariants (verbatim from PLAN-v6):
#   1. No identity from attacker-writable sources (server-recorded GitHub REST API only)
#   2. No LLM in the verdict path (verdict.js)
#   3. No required state only in PR branch (artifacts + Check Run outputs)

name: FQE Quality
on:
  pull_request:
    branches: [__FQE_DEFAULT_BRANCH__]

permissions:
  contents: read
  pull-requests: read
  issues: read
  checks: write
  actions: read

jobs:
  fqe:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0

      - name: Set up Node 22
        uses: actions/setup-node@v5
        with:
          node-version: '22'

      - name: Install fqe CLI from booyajones/finexio-skills (TAG-pinned)
        run: |
          set -euo pipefail
          # Supply-chain hardening: clone is pinned to a specific tag, not HEAD.
          # To update fqe, push a new tag in finexio-skills and re-run fqe init.
          # A container image would replace this whole step, but ghcr.io/booyajones/fqe
          # is NOT published today (Packages API 404, owner has no container packages),
          # so do not switch to it until it exists and is pinned by digest.
          # FQE_REF accepts a tag OR a 40-char commit SHA. It is fetched rather
          # than cloned --branch, because --branch takes a ref name only: setting
          # it to a SHA (which SECURITY.md and getting-started.md both recommend
          # for production) failed with "Remote branch <sha> not found in upstream
          # origin", so the documented hardening path broke the gate outright.
          FQE_REF="fqe-v0.18.19"
          # A FRESH directory per job, never a fixed path under /tmp.
          #
          # This step fetches code and then executes it, so where it stages that
          # code matters. /tmp is world-writable and sticky (1777) and persists
          # across jobs on self-hosted runners, so a predictable /tmp/fqe-src was
          # both a re-run hazard (remote origin already exists) and a staging
          # area another UID on the box could have prepared first. Deleting it
          # first fixed neither: rm -rf returns non-zero when the directory
          # belongs to someone else, which under set -e is the same red gate it
          # was meant to remove. RUNNER_TEMP is per-job and runner-owned, and
          # mktemp -d gives a fresh unique name under it on every run.
          # \${VAR:-default}, not a two-line test. This step opens with
          # \`set -euo pipefail\`, so under set -u an UNSET RUNNER_TEMP aborts on
          # the expansion itself with "unbound variable" and a following fallback
          # never runs. It would only have caught set-but-empty, which is not the
          # case that motivates a fallback. Unset is the normal state outside
          # GitHub Actions (act, a bare-shell copy-paste), which is exactly who
          # the fallback is for. The backslashes escape this JS template literal:
          # the file generates shell, so \${...} and backticks are JS syntax here.
          FQE_SRC="$(mktemp -d "\${RUNNER_TEMP:-/tmp}/fqe-src.XXXXXX")"
          git -C "$FQE_SRC" init -q .
          git -C "$FQE_SRC" fetch -q --depth=1 https://github.com/booyajones/fqe.git "$FQE_REF"
          git -C "$FQE_SRC" checkout -q --detach FETCH_HEAD
          cd "$FQE_SRC/cli"
          # npm ci, not npm install: cli/package-lock.json is checked in and was
          # just fetched, so ci installs exactly it and fails closed when manifest
          # and lock disagree. Identical today (the CLI has zero runtime deps);
          # the moment one is added, install could resolve outside the lockfile,
          # which is the same drift channel v0.18.4 closed on the manifest side.
          npm ci --omit=dev
          chmod +x bin/fqe.js
          sudo ln -sf "$PWD/bin/fqe.js" /usr/local/bin/fqe
          fqe version

      - name: Install yq (Mike Farah v4) with SHA256 verification
        run: |
          set -euo pipefail
          # Supply-chain hardening: SHA256-verified download. If GitHub releases
          # ever served a tampered binary, sha256sum -c would fail closed.
          YQ_SHA256=654d2943ca1d3be2024089eb4f270f4070f491a0610481d128509b2834870049
          # Download to a temp path, VERIFY, then install onto PATH. Writing
          # straight to /usr/local/bin/yq puts an unverified binary on PATH
          # before the checksum runs. It fails closed as written (set -e aborts
          # before chmod), but a pin only means something if nothing lands on
          # PATH ahead of it. Same order this repo's own Dockerfile uses.
          # Same rule the fqe source staging obeys a few steps up: stage under
          # RUNNER_TEMP, not bare /tmp. GitHub-hosted runners do not set TMPDIR,
          # so a bare mktemp lands in the world-writable, sticky, job-persistent
          # directory this file argues against at length elsewhere.
          YQ_TMP="$(mktemp "\${RUNNER_TEMP:-/tmp}/yq.XXXXXX")"
          wget -q "https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_amd64" -O "$YQ_TMP"
          echo "$YQ_SHA256  $YQ_TMP" | sha256sum -c -
          sudo install -m 0755 "$YQ_TMP" /usr/local/bin/yq
          rm -f "$YQ_TMP"
          yq --version

      - name: Check bypass eligibility (SHA-bound comment, server-authoritative)
        id: bypass-eligibility
        env:
          GH_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          # Bypass = an allowlisted maintainer posts a PR comment:
          #   /fqe-bypass <40-char-head-sha> <24h|48h|72h>
          # The binding is SHA equality (the comment names the exact head it
          # authorizes), so any new push changes head.sha and the bypass evaporates.
          # Identity + time come ONLY from the server-recorded comment object,
          # never from a PR-branch file. See cli/lib/bypass_guard.js and the council
          # design. Fails CLOSED: any error -> bypass=false -> the gate runs.
          HEAD_SHA=$(gh api "/repos/$REPO/pulls/$PR_NUMBER" --jq '.head.sha')
          # Allowlist read at the DEFAULT-BRANCH HEAD (the current allowlist), so
          # removing someone takes effect immediately, even on in-flight PRs. NOT
          # the PR base: a PR branched from an old commit where the author was
          # still allowlisted must not get a stale allowlist (offboarding hole).
          DEFAULT_BRANCH=$(gh api "/repos/$REPO" --jq '.default_branch')
          ALLOW=$(gh api "/repos/$REPO/contents/.github/fqe-bypass-allowlist.yml?ref=$DEFAULT_BRANCH" \\
                    --jq '.content' | base64 -d | yq '.allowed_actors[]' - | paste -sd, - || true)
          # Only comments within the max TTL window, normalized to the guard shape.
          SINCE=$(date -u -d '72 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-72H +%Y-%m-%dT%H:%M:%SZ)
          gh api "/repos/$REPO/issues/$PR_NUMBER/comments?since=$SINCE&per_page=100" --paginate \\
            --jq '[.[] | {user_login: .user.login, created_at, updated_at, body}]' > bypass-comments.json
          set +e
          OUT=$(fqe bypass-check --comments bypass-comments.json --head "$HEAD_SHA" --allowed "$ALLOW")
          RC=$?
          set -e
          echo "$OUT"
          if [ "$RC" -eq 0 ]; then
            BYPASS_ACTOR=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).actor||"")}catch{}})')
            echo "bypass=true" >> "$GITHUB_OUTPUT"
            echo "bypass_actor=$BYPASS_ACTOR" >> "$GITHUB_OUTPUT"
            echo "bypass_head=$HEAD_SHA" >> "$GITHUB_OUTPUT"
          else
            echo "bypass=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Generate bypass receipt
        if: steps.bypass-eligibility.outputs.bypass == 'true'
        run: |
          set -euo pipefail
          mkdir -p out
          fqe receipt generate-bypass \\
            --commit '\${{ steps.bypass-eligibility.outputs.bypass_head }}' \\
            --pr '\${{ github.event.pull_request.number }}' \\
            --actor '\${{ steps.bypass-eligibility.outputs.bypass_actor }}' \\
            --requester-source github_comments_api_v3 \\
            --events-url 'https://github.com/\${{ github.repository }}/pull/\${{ github.event.pull_request.number }}' \\
            --output out/

      - name: Run fqe (normal path)
        if: steps.bypass-eligibility.outputs.bypass != 'true'
        run: |
          set -euo pipefail
          mkdir -p out
          fqe run \\
            --commit '\${{ github.event.pull_request.head.sha }}' \\
            --base '\${{ github.event.pull_request.base.sha }}' \\
            --pr '\${{ github.event.pull_request.number }}' \\
            --output out/ || true
          if [ ! -f out/QA-RESULT.yml ]; then
            echo "::error::fqe run did not produce a receipt"
            exit 1
          fi

      - name: Upload receipt as workflow artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-receipt-\${{ github.event.pull_request.head.sha }}
          # runner-*.log carries what the receipt's evidence_paths names and what
          # the explainer tells you to download. Without it the receipt points at
          # files no reader can reach.
          # (Keep this comment ABOVE \`path:\` — inside a \`|\` block scalar a '#'
          # line is literal text, not a comment, and would be uploaded as a glob.)
          path: |
            out/QA-RESULT.yml
            out/QA-RESULT.md
            out/runner-*.log
          # 365 days for SOC2/PCI evidence retention (1-year minimum). The repo's
          # max artifact-retention setting must allow this; the Check Run output
          # also persists with the commit. For 7-year SOX, mirror to object storage.
          retention-days: 365

      - name: Determine fqe/pass state from verdict
        if: always()
        id: pass-state
        run: |
          set -euo pipefail
          if [ ! -f out/QA-RESULT.yml ]; then
            echo "state=failure" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          STATE=$(fqe status print out/QA-RESULT.yml | jq -r .check_state)
          echo "state=$STATE" >> "$GITHUB_OUTPUT"

      - name: Publish fqe/pass Check Run
        if: always()
        env:
          GH_TOKEN: \${{ github.token }}
          GITHUB_REPOSITORY: \${{ github.repository }}
        run: |
          set -euo pipefail
          if [ -f out/QA-RESULT.md ]; then
            BODY=$(head -c 65000 out/QA-RESULT.md)
          else
            BODY="No receipt produced"
          fi
          fqe status publish \\
            --check fqe/pass \\
            --commit '\${{ github.event.pull_request.head.sha }}' \\
            --state '\${{ steps.pass-state.outputs.state }}' \\
            --output-text "$BODY"

      - name: Tally + compute rolling bypass rate
        if: always()
        id: bypass-rate
        env:
          STATE_DIR: .github/fqe-state
        run: |
          set -euo pipefail
          mkdir -p "$STATE_DIR"
          fqe bypass-tally append-run \\
            --state-dir "$STATE_DIR" \\
            --pr '\${{ github.event.pull_request.number }}' \\
            --commit '\${{ github.event.pull_request.head.sha }}'
          if [ "\${{ steps.bypass-eligibility.outputs.bypass }}" = "true" ]; then
            fqe bypass-tally append-bypass \\
              --state-dir "$STATE_DIR" \\
              --actor '\${{ steps.bypass-eligibility.outputs.bypass_actor }}' \\
              --pr '\${{ github.event.pull_request.number }}' \\
              --commit '\${{ github.event.pull_request.head.sha }}'
          fi
          RATE=$(fqe bypass-tally rate --state-dir "$STATE_DIR" --window-days 14 --format scalar)
          echo "rate=$RATE" >> "$GITHUB_OUTPUT"

      - name: Publish fqe/second-reviewer-required Check Run
        if: always()
        env:
          GH_TOKEN: \${{ github.token }}
          GITHUB_REPOSITORY: \${{ github.repository }}
        run: |
          set -euo pipefail
          RATE='\${{ steps.bypass-rate.outputs.rate }}'
          if awk -v r="$RATE" 'BEGIN{exit !(r > 0.10)}'; then
            fqe status publish \\
              --check fqe/second-reviewer-required \\
              --commit '\${{ github.event.pull_request.head.sha }}' \\
              --state failure \\
              --description "Rolling bypass rate $RATE exceeds 10%; second reviewer required"
          else
            fqe status publish \\
              --check fqe/second-reviewer-required \\
              --commit '\${{ github.event.pull_request.head.sha }}' \\
              --state success \\
              --description "Bypass rate $RATE within tolerance"
          fi
`,

  '.github/workflows/fqe-second-approve.yml': `# Finexio Quality Engine - second-approve workflow
# Triggers on PR label fqe-second-approved. Validates the approver via Events API.

name: FQE Second Approve
on:
  pull_request:
    types: [labeled]

permissions:
  contents: read
  pull-requests: read
  checks: write

jobs:
  approve:
    if: github.event.label.name == 'fqe-second-approved'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          persist-credentials: false

      - name: Set up Node 22
        uses: actions/setup-node@v5
        with:
          node-version: '22'

      # Installed the same proven way fqe-quality.yml does.
      #
      # This job used to run inside \`container: ghcr.io/booyajones/fqe:0.1\` and
      # call a bare \`fqe\`. That image has never been published (the GitHub
      # Packages API returns 404 and the owner has no container packages), so the
      # job could not start at all: every adopter who ran \`fqe init\` got a
      # second-approve workflow that failed on image pull before step one. The
      # bypass-rate unblock is exactly the path you need working on a bad day.
      - name: Install fqe CLI (ref-pinned)
        run: |
          set -euo pipefail
          FQE_REF="fqe-v0.18.19"
          FQE_SRC="$(mktemp -d "\${RUNNER_TEMP:-/tmp}/fqe-src.XXXXXX")"
          git -C "$FQE_SRC" init -q .
          git -C "$FQE_SRC" fetch -q --depth=1 https://github.com/booyajones/fqe.git "$FQE_REF"
          git -C "$FQE_SRC" checkout -q --detach FETCH_HEAD
          cd "$FQE_SRC/cli"
          npm ci --omit=dev
          chmod +x bin/fqe.js
          sudo ln -sf "$PWD/bin/fqe.js" /usr/local/bin/fqe
          fqe version

      # yq came from the container image too, and a later step in this job parses
      # the second-reviewer allowlist with it. Dropping \`container:\` without this
      # would trade a failure at image pull for "yq: command not found" three steps
      # later: still a workflow that cannot complete, just failing further in.
      # Same SHA256-verified install the gate workflow uses.
      - name: Install yq (Mike Farah v4) with SHA256 verification
        run: |
          set -euo pipefail
          YQ_SHA256=654d2943ca1d3be2024089eb4f270f4070f491a0610481d128509b2834870049
          # Download to a temp path, VERIFY, then install onto PATH. Writing
          # straight to /usr/local/bin/yq puts an unverified binary on PATH
          # before the checksum runs. It fails closed as written (set -e aborts
          # before chmod), but a pin only means something if nothing lands on
          # PATH ahead of it. Same order this repo's own Dockerfile uses.
          # Same rule the fqe source staging obeys a few steps up: stage under
          # RUNNER_TEMP, not bare /tmp. GitHub-hosted runners do not set TMPDIR,
          # so a bare mktemp lands in the world-writable, sticky, job-persistent
          # directory this file argues against at length elsewhere.
          YQ_TMP="$(mktemp "\${RUNNER_TEMP:-/tmp}/yq.XXXXXX")"
          wget -q "https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_amd64" -O "$YQ_TMP"
          echo "$YQ_SHA256  $YQ_TMP" | sha256sum -c -
          sudo install -m 0755 "$YQ_TMP" /usr/local/bin/yq
          rm -f "$YQ_TMP"
          yq --version

      - name: Identify both actors via Events API
        id: actors
        env:
          GH_TOKEN: \${{ github.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          BYPASS_ACTOR=$(gh api \\
            "/repos/$REPO/issues/$PR_NUMBER/events" --paginate \\
            --jq '[.[] | select(.event=="labeled" and .label.name=="fqe-bypass")] | last | .actor.login')
          if [ -z "$BYPASS_ACTOR" ] || [ "$BYPASS_ACTOR" = "null" ]; then
            echo "::error::Cannot find original fqe-bypass label event"
            exit 1
          fi
          APPROVER='\${{ github.event.sender.login }}'
          echo "bypass_actor=$BYPASS_ACTOR" >> "$GITHUB_OUTPUT"
          echo "approver=$APPROVER" >> "$GITHUB_OUTPUT"

      - name: Validate approver (allowlist + same-actor rule)
        env:
          BYPASS_ACTOR: \${{ steps.actors.outputs.bypass_actor }}
          APPROVER: \${{ steps.actors.outputs.approver }}
        run: |
          set -euo pipefail
          if ! yq '.allowed_actors[]' .github/fqe-second-reviewers.yml | grep -qx "$APPROVER"; then
            echo "::error::Approver '$APPROVER' not in second-reviewer allowlist (at base commit)"
            exit 1
          fi
          if [ "$APPROVER" = "$BYPASS_ACTOR" ]; then
            echo "::error::Second approver '$APPROVER' cannot be the bypass requester '$BYPASS_ACTOR'"
            exit 1
          fi

      - name: Re-emit fqe/second-reviewer-required = success
        env:
          GH_TOKEN: \${{ github.token }}
          GITHUB_REPOSITORY: \${{ github.repository }}
        run: |
          fqe status publish \\
            --check fqe/second-reviewer-required \\
            --commit '\${{ github.event.pull_request.head.sha }}' \\
            --state success \\
            --description "Approved by \${{ steps.actors.outputs.approver }} (bypass by \${{ steps.actors.outputs.bypass_actor }})"
`,

  '.github/fqe-bypass-allowlist.yml': `# Who can add the 'fqe-bypass' label to skip the gate.
# The fqe-quality workflow looks up the LABEL ADDER (from GitHub Events API,
# server-authoritative) against this list at the PR's BASE commit, so a PR
# cannot add itself to this allowlist.
#
# Modifying this file is itself a PR that goes through the gate.

allowed_actors:
  - __FQE_DEFAULT_ACTOR__
`,

  '.github/fqe-second-reviewers.yml': `# Who can add 'fqe-second-approved' to unblock when rolling bypass rate > 10%.
# Approver must NOT be the same person who added 'fqe-bypass' (Events API check).
# Approver must be in this list at the PR's BASE commit.
#
# Add real reviewers here. Single-entry is acceptable for a solo operator but
# means same-actor rejection becomes the only collusion defense.

allowed_actors: []
`,

  '.github/fqe-state/.gitkeep': '',
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
      .replace(/__FQE_DEFAULT_BRANCH__/g, defaultBranch);
    fs.writeFileSync(fullPath, content);
    written.push(relPath);
  }

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
