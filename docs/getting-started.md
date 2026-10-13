# Getting started

Install and verify in a sandbox before requiring the gate on an application. v0.19.0 is published as `fqe-v0.19.0`. For an immutable install, use the release commit `edde4120e86abedde65e4930f253544d9dfdb64e` in the install command and `--ref`.

## Step 1: Add fqe to your repo (one command)

In any git repo with a `main` or `master` branch:

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.19.0 fqe init
```

This creates:

- `.fqe.yml`: your runner config. A static template with commented examples; fqe does not inspect your repo to guess runners.
- `.github/workflows/fqe-quality.yml`: the gate workflow.
- `.github/workflows/fqe-publish.yml`: the trusted publisher.
- `.github/fqe-bypass-allowlist.yml`: who can bypass (seeded with your GitHub login).
- `.github/fqe-second-reviewers.yml`: who can independently approve oracle changes or a high-rate bypass.
- Immutable Actions audit artifacts retain the observed bypass history.

Configure actual required runners and an independent reviewer, then submit the installation through normal review. The publisher must reach the default branch before GitHub starts its `workflow_run` handler. After that bootstrap, open a dedicated probe PR and verify both checks before requiring them.

## Step 2: Configure your runners

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.19.0 fqe explain
```

Then open `.fqe.yml`. It ships with commented examples you adapt by hand:

```yaml
#   unit:
#     command: "npm"
#     args: ["test"]
#     when: ["**/*.ts", "test/**"]
#     class: unit
#     required: true
```

Copy an example under the live `runners:` key at the bottom of the file and delete the leading `# `. **Do not uncomment a second `runners:` line.** FQE rejects duplicate top-level keys, including `runners:`, instead of choosing one. Run `fqe validate` after editing; a duplicate or malformed config blocks the gate.

**On Windows**, `command: "npm"` will not start, because npm is a `.cmd` shim and fqe spawns without a shell. Use `command: "cmd"` with `args: ["/c", "npm", "test"]`. A runner that fails to spawn is reported as a failure carrying no exit code.

`require_nonempty_gate: true` blocks this empty scaffold until required runners are configured.

## Step 3: Open a PR and watch the workflow

Once `.fqe.yml`, `.github/workflows/`, and the allowlists are committed to your default branch, every future PR fires the gate automatically. The read-only **FQE Quality** run uploads its receipt. Completion starts the default-branch **FQE Publish** workflow, which publishes two Check Runs on the exact head:

| Check | What it does |
|---|---|
| `fqe/pass` | The trusted publisher verifies the source-run receipt and current authority. PASS and informational FLAG publish success; FAIL or an unsatisfied authority guard publishes failure. |
| `fqe/second-reviewer-required` | Requires independent current-head approval for oracle/grading-rule changes, or a requested bypass above the 10% rolling rate. Missing or unverifiable authority fails closed. |

Look at the Check Run detail. If the gate fails, the output panel contains a plain-English explanation of what failed, why, and how to reproduce it locally.

## Step 4: Run it locally before pushing

First, install the CLI so you have an `fqe` binary on your PATH. Two options:

```bash
# Option A: clone and link (recommended for iteration)
git clone https://github.com/booyajones/fqe.git ~/.local/share/fqe
cd ~/.local/share/fqe && git checkout fqe-v0.19.0
npm link --prefix ~/.local/share/fqe/cli   # adds `fqe` to PATH

# Option B: one-off via npx (no install, slower)
alias fqe='npx --yes -p github:booyajones/fqe#fqe-v0.19.0 fqe'
```

On **Windows**, both options above are Unix-only (`npm link` mutates your global prefix, and `alias` is a bash builtin that PowerShell rejects). Use a PowerShell function instead, or just type the full `npx` invocation:

```powershell
function fqe { npx --yes -p github:booyajones/fqe#fqe-v0.19.0 fqe @args }
```

Then, from any repo with a `.fqe.yml`:

```bash
fqe run --commit $(git rev-parse HEAD) --base origin/main --output ./out/
```

This produces local QA-RESULT.yml and QA-RESULT.md using the same verdict rules and explainer. Match CI's checkout, base and runner environment when comparing results. Local PASS does not replace the publisher's current-head authority checks or a fresh native check result.

If a runner fails locally, the explainer tells you exactly what to fix:

```
### FAIL: this PR cannot merge until fixed

**1. RUNNER_EXIT_NONZERO**

The "node-tests" runner exited with code 1, which fqe treats as a failure.
The runner's own logs (uploaded as a workflow artifact) explain why.

**Fix:** Download the qa-receipt artifact from this PR's workflow run to see
the runner's stderr. Then reproduce locally with the repro command below.

**Reproduce locally:**
```bash
fqe run --commit $(git rev-parse HEAD) --base origin/main --output ./out/
```
```

## Step 5: Make it block merges (one-time GitHub UI change)

`fqe` is non-blocking by default until you mark `fqe/pass` as a required check. To make `fqe/pass` actually gate merges:

1. Repo Settings, Branches, click the default branch (main or master).
2. Edit the protection rule.
3. **Require status checks to pass before merging**, then add `fqe/pass` and `fqe/second-reviewer-required`.
4. **Require branches to be up to date before merging**, check this.
5. **Do not allow bypassing**, check this if you want admins to also be gated (recommended).
6. Save.

The rule now requires both checks from the intended GitHub App. Inspect their conclusions on the current head; a local exit code does not establish a published check. To bypass in an emergency, an allowlisted maintainer posts a SHA-bound PR comment: `/fqe-bypass <head-sha> <24h|48h|72h>`. The named SHA must equal the live head (any new push invalidates it), it expires on the TTL, and every bypass is logged. A comment alone does not trigger evaluation: rerun the **FQE Publish** run associated with this head, then verify its receipt and both refreshed checks. Oracle changes still require independent approval. (The old unbounded `fqe-bypass` label was removed in v0.4.0.)

## What the gate doesn't do until you configure it

The empty standard scaffold has **no runners** and blocks with `require_nonempty_gate: true`. Legacy configs without that flag can still produce a hollow PASS; inspect and migrate them. FQE does not infer business requirements or implement missing tests.

## Optional: wire AI test-gen + mutation testing in the same install

For JS/TS repos that want the modern AI quality stack (Stryker mutation testing wired as a fqe runner, with deterministic mutation counts as the evidence), add the `--with-mutation` flag:

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.19.0 fqe init --with-mutation
npm install --save-dev @stryker-mutator/core
```

This drops in `stryker.conf.json`, `scripts/fqe_stryker_runner.js`, and a `stryker-mutation:` runner block in `.fqe.yml`. See [docs/recipes/ai-test-generation.md](recipes/ai-test-generation.md) for the mutation contract and the separate, optional AI test-proposal workflow.

## Production install (SHA-pinned)

The default install command in Step 1 pins a git tag. Tags can be force-pushed, so if upstream's tag is moved (accidentally or maliciously) every repo running the tag-pinned install picks up the new code on the next CI run.

For production, pin to a commit SHA instead. Find the SHA for the release you want at https://github.com/booyajones/fqe/releases, then:

```bash
# Replace SHA with the 40-char commit hash for the release you want
# Assign the reviewed release commit here; verify it is a full 40-hex SHA.
SHA="REPLACE_WITH_REVIEWED_COMMIT"
npx --yes -p "github:booyajones/fqe#${SHA}" fqe init --ref "$SHA"
```

The generated workflow YAML pins both workflows' `git fetch` steps to that SHA. To re-pin to a new release later, re-run `init` with the new SHA, or update both `.github/workflows/fqe-quality.yml` and `.github/workflows/fqe-publish.yml`.

No published FQE container is required by these workflows.

## Common next steps

- **[docs/writing-a-runner.md](writing-a-runner.md)**: how to add a runner.
- **[docs/recipes/](recipes/)**: per-stack starter configs (node-web, python-api, financial-model, mcp-server, outbound-comms).
- **Full-suite QA (v0.7.0)**: tag runners with a `class` and set a `policy` so the right test types are required before merge ([recipes/test-taxonomy.md](recipes/test-taxonomy.md)), gate acceptance criteria with `fqe uat` ([recipes/uat.md](recipes/uat.md)), catch regressions with `fqe golden` ([recipes/regression-golden.md](recipes/regression-golden.md)), and read it all in one `fqe qa-report` scorecard.
- **[docs/troubleshooting.md](troubleshooting.md)**: exact-error to exact-fix lookup when something goes wrong.
- **[docs/architecture.md](architecture.md)**: for the staff engineer who wants to understand the design before trusting it.
- **[SECURITY.md](../SECURITY.md)**: threat model and reporting.

## If something goes wrong

Run `fqe explain` to see the config fqe resolved, then check [docs/troubleshooting.md](troubleshooting.md).

Install the publisher on the default branch before enabling required checks. The empty standard config now blocks until a required runner is configured; validation alone is not proof that tests run. See the v0.19 migration section in README.
