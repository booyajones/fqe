# Getting started

5 minutes from `git clone` to a gated PR. If it takes longer than that, open an issue.

## Step 1: Add fqe to your repo (one command)

In any git repo with a `main` or `master` branch:

```bash
npx --yes github:booyajones/fqe#fqe-v0.1.0 cli/bin/fqe.js init
```

This creates:

- `.fqe.yml`: your runner config, pre-populated with suggestions based on what's in your repo.
- `.github/workflows/fqe-quality.yml`: the gate workflow.
- `.github/workflows/fqe-second-approve.yml`: the bypass-unblock workflow.
- `.github/fqe-bypass-allowlist.yml`: who can bypass (seeded with your GitHub login).
- `.github/fqe-second-reviewers.yml`: who can unblock when bypass rate is high.
- `.github/fqe-state/.gitkeep`: state directory for the rolling bypass tally.

Commit and push these on a branch, open a PR, watch the workflow fire.

## Step 2: See what fqe detected

```bash
node ./node_modules/.bin/fqe explain
```

Or, if you ran `init` via `npx`, look at `.fqe.yml`. The smart-detect pass added commented suggestions tagged with the marker that triggered them:

```yaml
# Detected: Node.js project (package.json present).
# Suggested: unit tests via npm + browser checks via Playwright.
# node-tests:
#   command: "npm"
#   args: ["test"]
#   when: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
#   required: true
```

To activate a suggestion, delete the leading `# ` on each line. Empty config means the gate runs but always passes.

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
cd ~/.local/share/fqe && git checkout fqe-v0.1.0
npm link --prefix ~/.local/share/fqe/cli   # adds `fqe` to PATH

# Option B: one-off via npx (no install, slower)
alias fqe='npx --yes github:booyajones/fqe#fqe-v0.1.0 cli/bin/fqe.js'
```

Then, from any repo with a `.fqe.yml`:

```bash
fqe run --full --base origin/main --output ./out/
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
fqe run --full --base origin/main --output ./out/ && cat ./out/runner-node-tests.log
```
```

## Step 5: Make it block merges (one-time GitHub UI change)

`fqe` is non-blocking by default in v0.1. To make `fqe/pass` actually gate merges:

1. Repo Settings, Branches, click the default branch (main or master).
2. Edit the protection rule.
3. **Require status checks to pass before merging**, then add `fqe/pass` and `fqe/second-reviewer-required`.
4. **Require branches to be up to date before merging**, check this.
5. **Do not allow bypassing**, check this if you want admins to also be gated (recommended).
6. Save.

Now `main` cannot accept a merge without a green `fqe/pass`. To bypass in an emergency, add the `fqe-bypass` label to your PR (you must be on the allowlist).

## What the gate doesn't do until you configure it

Empty `.fqe.yml` (or a `.fqe.yml` with all suggestions still commented out) means **no runners**. The gate exists but always passes. This is intentional. fqe is a no-op until you tell it what to enforce.

## Production install (SHA-pinned)

The default install command in Step 1 uses `fqe-v0.1.0`, a git tag. Tags can be force-pushed, so if upstream's tag is moved (accidentally or maliciously) every repo running the tag-pinned install picks up the new code on the next CI run.

For production, pin to a commit SHA instead. Find the SHA for the release you want at https://github.com/booyajones/fqe/releases, then:

```bash
# Replace SHA with the 40-char commit hash for the release you want
SHA=a36389a79d386e72a48183b8a5f29703b166c5f6
npx --yes "github:booyajones/fqe#${SHA}" cli/bin/fqe.js init
```

The generated workflow YAML will also pin its `git clone` step to that SHA. To re-pin to a new release later, re-run `init` with the new SHA, or hand-edit `.github/workflows/fqe-quality.yml`.

The 0.2 Docker image (`ghcr.io/finexio/fqe:0.1`) will be pinned by image digest, which is content-addressed and cannot be silently changed. Once 0.2 ships, that's the recommended default.

## Common next steps

- **[docs/writing-a-runner.md](writing-a-runner.md)**: how to add a runner.
- **[docs/recipes/](recipes/)**: per-stack starter configs (node-web, python-api, financial-model, mcp-server, outbound-comms).
- **[docs/troubleshooting.md](troubleshooting.md)**: exact-error to exact-fix lookup when something goes wrong.
- **[docs/architecture.md](architecture.md)**: for the staff engineer who wants to understand the design before trusting it.
- **[SECURITY.md](../SECURITY.md)**: threat model and reporting.

## If something goes wrong

`fqe doctor` (planned for v0.2) will validate your environment. For now: run `fqe explain` to see what fqe sees, then check the troubleshooting doc.
