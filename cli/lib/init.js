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
// quarantine). Loosening any of it FAILS validation loudly. This scaffold validates clean.
const PAYMENTS_FQE_YML = `# Finexio Quality Engine - PAYMENTS profile (fqe init --payments)
# Money repos are strict by default. The money/contract runners below are locked to the
# safe configuration fqe enforces. Loosening any of them FAILS validation loudly (the
# gate refuses to run); it does not silently weaken. Add your own unit/lint runners too.

version: 0.15
require_money_idempotency: true
require_money_policy_when_detected: true

mutation:
  mode: blocking
  threshold: 80
  min_mutants: 1
  max_suppression_ratio: 0.5

policy:
  require_for:
    - when: ["src/payments/**", "src/ledger/**", "src/billing/**"]
      classes: ["money", "regression"]

runners:
  money:
    command: "npm"
    args: ["run", "test:money"]
    when: ["src/payments/**", "src/ledger/**", "src/billing/**"]
    class: money
    required: true
    report: "junit:reports/money-junit.xml"
    inventory_cmd: "npm run test:money -- --listTests --silent | grep -c ."
    inventory_format: count
    reconcile: true
    strict_coverage: true
    min_tests: 1
    invariant: ["idempotency", "no-negative-balance"]

  contract:
    command: "npm"
    args: ["run", "test:contract"]
    when: ["src/payments/**", "contracts/**"]
    class: contract
    required: true
    report: "junit:reports/contract-junit.xml"
    inventory_cmd: "npm run test:contract -- --listTests --silent | grep -c ."
    inventory_format: count
    reconcile: true
    strict_coverage: true
    min_tests: 1
`;

const FILES = {
  '.fqe.yml': `# Finexio Quality Engine - repo config
# Each runner declares: command, args, when (glob patterns), required, always_run,
# and an optional class (the test type). Empty config = no runners = always PASS.
#
# Test classes (the full-suite taxonomy): unit, integration, e2e, regression,
# contract, property, uat, lint, type, mutation, coverage, security, money.
#
# Examples:
#
# runners:
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

runners: {}
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
          # When ghcr.io/booyajones/fqe:0.1 is published with cosign verify,
          # this entire step can be replaced with: container: ghcr.io/booyajones/fqe:0.1
          # FQE_REF accepts a tag OR a 40-char commit SHA. It is fetched rather
          # than cloned --branch, because --branch takes a ref name only: setting
          # it to a SHA (which SECURITY.md and getting-started.md both recommend
          # for production) failed with "Remote branch <sha> not found in upstream
          # origin", so the documented hardening path broke the gate outright.
          FQE_REF="fqe-v0.18.10"
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
          FQE_TMPDIR="$RUNNER_TEMP"
          [ -n "$FQE_TMPDIR" ] || FQE_TMPDIR=/tmp
          FQE_SRC="$(mktemp -d "$FQE_TMPDIR/fqe-src.XXXXXX")"
          git -C "$FQE_SRC" init -q .
          git -C "$FQE_SRC" fetch -q --depth=1 https://github.com/booyajones/fqe.git "$FQE_REF"
          git -C "$FQE_SRC" checkout -q --detach FETCH_HEAD
          cd "$FQE_SRC/cli"
          npm install --omit=dev
          chmod +x bin/fqe.js
          sudo ln -sf "$PWD/bin/fqe.js" /usr/local/bin/fqe
          fqe version

      - name: Install yq (Mike Farah v4) with SHA256 verification
        run: |
          set -euo pipefail
          # Supply-chain hardening: SHA256-verified download. If GitHub releases
          # ever served a tampered binary, sha256sum -c would fail closed.
          YQ_SHA256=654d2943ca1d3be2024089eb4f270f4070f491a0610481d128509b2834870049
          sudo wget -q "https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_amd64" -O /usr/local/bin/yq
          echo "$YQ_SHA256  /usr/local/bin/yq" | sha256sum -c -
          sudo chmod +x /usr/local/bin/yq
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
          fqe run --full \\
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
          path: |
            out/QA-RESULT.yml
            out/QA-RESULT.md
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
    container:
      image: ghcr.io/booyajones/fqe:0.1
    steps:
      - uses: actions/checkout@v5
        with:
          ref: \${{ github.event.pull_request.base.sha }}

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
  // Case 1: vanilla "runners: {}"
  if (/\nrunners:\s*\{\}\s*\n?$/m.test(yml)) {
    return yml.replace(/\nrunners:\s*\{\}\s*\n?$/m, `\nrunners:${block}`);
  }
  // Case 2: already populated "runners:\n  <something>" — append at the end
  if (/\nrunners:\s*\n/m.test(yml)) {
    return yml.replace(/\s*$/, `${block}`);
  }
  // Case 3: no anchor found — append a runners: section
  return yml.replace(/\s*$/, `\nrunners:${block}`);
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
};
