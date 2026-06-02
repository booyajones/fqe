# Contributing to fqe

fqe is the QA gate Finexio uses on its production repos. It exists because we lost a workday to a Validation-tab-says-PASS Excel ship and decided machines should enforce what humans miss. Anyone improving fqe is improving the floor for the whole team.

## Ground rules

1. **fqe must never block a merge on its own bugs.** If your change could cause `exit 4` (INFRA) to flip to `exit 2` (FAIL) on a transient failure, you have to add a test that pins the boundary. See `cli/test/cli.test.js` for the pattern.
2. **No LLM in the verdict path.** `cli/lib/verdict.js` is pure, deterministic, table-driven. If you need to change it, the test suite at `cli/test/verdict.test.js` is your contract.
3. **Architectural invariants are not negotiable.** Read `docs/architecture.md` before proposing any change to bypass, receipt, or check-publishing logic. If your change requires loosening an invariant, open a discussion before a PR.

## Local dev loop

```bash
git clone https://github.com/booyajones/fqe.git
cd fqe/cli
npm install
node --test test/   # 749 tests
node bin/fqe.js explain   # see the staff-engineer audit
```

If you're on Windows: one test is auto-skipped (symlink creation requires admin). All other tests run cross-platform.

## What we want help with

In rough priority order:

| Want | Notes |
|---|---|
| **More runner recipes** in `docs/recipes/` | Per-stack starter configs. Currently shipping node-web, python-api, financial-model, mcp-server, outbound-comms. Add yours. |
| **Better failure explanations** in `cli/lib/explainer.js` | When a runner fails in a new way, add a regex pattern plus a plain-English fix. Tests in `cli/test/explainer.test.js`. |
| **A `create-fqe-runner` scaffold** | We want first-class plugin authoring. Right now it's a guide. The codegen tool is open. |
| **JSON Schema for `.fqe.yml`** | Engineers should get VSCode autocomplete. The schema doesn't exist yet. |
| **Reduce v0.1 install time** | We're at about 20 seconds per CI run. The Docker image (`ghcr.io/booyajones/fqe:0.1`, not yet published) cuts most of that. |
| **Publish the Docker image** with cosign signing | Dockerfile is at the repo root, build-time self-tests are inline. Needs a release workflow. |

## What we don't want

- **New runners as built-ins.** fqe is a generic orchestrator. Runners live in your repo's `.fqe.yml`, not in fqe itself. If you have a great Vale config, ship it as a recipe in `docs/recipes/`.
- **An LLM that scores PRs.** Not happening. See invariant #2.
- **Slack integrations.** Use the Check Run output. If your team wants Slack pings, write a GitHub Action that reads the `qa-receipt-*` artifact.

## PR checklist

Before opening a PR:

```bash
cd cli
node --test test/   # all pass, 0 fail
node bin/fqe.js explain --dir .   # output looks right
```

In the PR description:

1. **Problem in one sentence.** What were you stuck on?
2. **Solution in one sentence.** What does this PR do?
3. **Test evidence.** Paste the `# pass N / # fail 0` line.
4. **Invariant compatibility.** Cite which invariant(s) your change touches. If none, say "no invariant change."

We label PRs `good-first-issue` when the change is well-scoped and has obvious test coverage. We label `architectural` when the change requires invariant discussion.

## Release process

fqe ships as a git tag (`fqe-v<major>.<minor>.<patch>`) plus a moved-tag pointer to the public source. Patch releases (bug fixes) keep the same minor. Minor releases add features under stable invariants. Major releases change invariants and require a migration guide.

The release process is documented in `docs/releasing.md` (TODO for v0.2).

## Maintainers

- **Chris Wyatt** (`@booyajones`), primary, accepts PRs, holds the bypass allowlist key.
- Additional maintainers added as the team scales.

## Code of conduct

Be kind. Disagree with substance, not snark. The skeptical senior IC review is the most valuable, so route around no one.
