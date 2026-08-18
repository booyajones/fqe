# Getting started

5 minutes from `git clone` to a gated PR. If it takes longer than that, open an issue.

## Step 1: Add fqe to your repo (one command)

In any git repo with a `main` or `master` branch:

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.18.20 fqe init
```

This creates:

- `.fqe.yml`: your runner config. A static template with commented examples; fqe does not inspect your repo to guess runners.
- `.github/workflows/fqe-quality.yml`: the gate workflow.
- `.github/workflows/fqe-second-approve.yml`: the bypass-unblock workflow.
- `.github/fqe-bypass-allowlist.yml`: who can bypass (seeded with your GitHub login).
- `.github/fqe-second-reviewers.yml`: who can unblock when bypass rate is high.
- `.github/fqe-state/.gitkeep`: state directory for the rolling bypass tally.

Commit and push these on a branch, open a PR, watch the workflow fire.

## Step 2: Configure your runners

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.18.20 fqe explain
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

Copy an example under the live `runners:` key at the bottom of the file and delete the leading `# `. **Do not uncomment a second `runners:` line.** YAML takes the last key, so a duplicate silently discards everything you configured and leaves you with a gate that passes everything.

**On Windows**, `command: "npm"` will not start, because npm is a `.cmd` shim and fqe spawns without a shell. Use `command: "cmd"` with `args: ["/c", "npm", "test"]`. A runner that fails to spawn is reported as a failure carrying no exit code.

Empty config means the gate runs but always passes.

## Step 3: Open a PR and watch the workflow

Once `.fqe.yml`, `.github/workflows/`, and the allowlists are committed to your default branch, every future PR fires the gate automatically. Two Check Runs appear on the PR:

| Check | What it does |
|---|---|
| `fqe/pass` | Runs your configured runners. PASS if all clean, FAIL if any blocked, FLAG if Wilson CI bounds exceeded. |
| `fqe/second-reviewer-required` | Normally green. Goes red when the 14-day rolling bypass rate is above 10%, requiring an allowlisted second approver. |

Look at the Check Run detail. If the gate fails, the output panel contains a plain-English explanation of what failed, why, and how to reproduce it locally.

## Step 4: Run it locally before pushing

First, install the CLI so you have an `fqe` binary on your PATH. Two options:

```bash
# Option A: clone and link (recommended for iteration)
git clone https://github.com/booyajones/fqe.git ~/.local/share/fqe
cd ~/.local/share/fqe && git checkout fqe-v0.18.20
npm link --prefix ~/.local/share/fqe/cli   # adds `fqe` to PATH

# Option B: one-off via npx (no install, slower)
alias fqe='npx --yes -p github:booyajones/fqe#fqe-v0.18.20 fqe'
```

On **Windows**, both options above are Unix-only (`npm link` mutates your global prefix, and `alias` is a bash builtin that PowerShell rejects). Use a PowerShell function instead, or just type the full `npx` invocation:

```powershell
function fqe { npx --yes -p github:booyajones/fqe#fqe-v0.18.20 fqe @args }
```

Then, from any repo with a `.fqe.yml`:

```bash
fqe run --commit $(git rev-parse HEAD) --base origin/main --output ./out/
```

This produces the same QA-RESULT.yml and QA-RESULT.md that CI would. Same verdict. Same explainer output. You can iterate on your runner config without waiting for CI.

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

Now `main` cannot accept a merge without a green `fqe/pass`. To bypass in an emergency, an allowlisted maintainer posts a SHA-bound PR comment: `/fqe-bypass <head-sha> <24h|48h|72h>`. The named SHA must equal the live head (any new push invalidates it), it expires on the TTL, and every bypass is logged. (The old unbounded `fqe-bypass` label was removed in v0.4.0.)

## What the gate doesn't do until you configure it

Empty `.fqe.yml` (or a `.fqe.yml` with all suggestions still commented out) means **no runners**. The gate exists but always passes. This is intentional. fqe is a no-op until you tell it what to enforce.

## Optional: wire AI test-gen + mutation testing in the same install

For JS/TS repos that want the modern AI quality stack (Stryker mutation testing wired as a fqe runner, with Wilson-CI-bounded survival rate as the verdict), add the `--with-mutation` flag:

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.18.20 fqe init --with-mutation
npm install --save-dev @stryker-mutator/core
```

This drops in `stryker.conf.json`, `scripts/fqe_stryker_runner.js`, and a `stryker-mutation:` runner block in `.fqe.yml`. See [docs/recipes/ai-test-generation.md](recipes/ai-test-generation.md) for the rationale and the Qodo Cover layer that generates tests on PR.

## Production install (SHA-pinned)

The default install command in Step 1 pins a git tag. Tags can be force-pushed, so if upstream's tag is moved (accidentally or maliciously) every repo running the tag-pinned install picks up the new code on the next CI run.

For production, pin to a commit SHA instead. Find the SHA for the release you want at https://github.com/booyajones/fqe/releases, then:

```bash
# Replace SHA with the 40-char commit hash for the release you want
SHA=074eeb434215d5588088690a2dfde33e97356536
npx --yes -p "github:booyajones/fqe#${SHA}" fqe init
```

The generated workflow YAML will also pin its `git clone` step to that SHA. To re-pin to a new release later, re-run `init` with the new SHA, or hand-edit `.github/workflows/fqe-quality.yml`.

A SHA-pinned Docker image (`ghcr.io/booyajones/fqe`) will be pinned by image digest, which is content-addressed and cannot be silently changed. Once it ships, that's the recommended default.

## Common next steps

- **[docs/writing-a-runner.md](writing-a-runner.md)**: how to add a runner.
- **[docs/recipes/](recipes/)**: per-stack starter configs (node-web, python-api, financial-model, mcp-server, outbound-comms).
- **Full-suite QA (v0.7.0)**: tag runners with a `class` and set a `policy` so the right test types are required before merge ([recipes/test-taxonomy.md](recipes/test-taxonomy.md)), gate acceptance criteria with `fqe uat` ([recipes/uat.md](recipes/uat.md)), catch regressions with `fqe golden` ([recipes/regression-golden.md](recipes/regression-golden.md)), and read it all in one `fqe qa-report` scorecard.
- **[docs/troubleshooting.md](troubleshooting.md)**: exact-error to exact-fix lookup when something goes wrong.
- **[docs/architecture.md](architecture.md)**: for the staff engineer who wants to understand the design before trusting it.
- **[SECURITY.md](../SECURITY.md)**: threat model and reporting.

## If something goes wrong

Run `fqe explain` to see the config fqe resolved, then check [docs/troubleshooting.md](troubleshooting.md).
