# Changelog

All notable changes to fqe. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Semver: MAJOR for invariant changes, MINOR for new features under stable invariants, PATCH for bug fixes.

## [0.6.0] - 2026-05-29

Tag: `fqe-v0.6.0`. Source: github.com/booyajones/fqe. Acts on an independent gauntlet (52/REWORK) and a 3-LLM council review. The two findings that capped the score are operational decisions, not code: rotate the exposed Anthropic key, and enforce the gate on a real money-path repo. The code, workflow, and doc findings are fixed here.

### Changed (security)

- **A money/state Wilson-CI breach now FAILs (blocks); it is no longer an advisory FLAG.** `verdict.js` adds `BLAST_RADIUS_BLOCKS`: a `mcp-write-or-financial` threshold breach blocks the merge, while looser classes (`outbound`, `mcp-read`) still FLAG. Closes the council finding "a FLAG that does not block is advisory theater."
- **The bypass allowlist is read at the default-branch HEAD, not the PR base ref.** Closes an offboarding / stale-allowlist hole (a PR branched from an old commit could otherwise carry a stale allowlist). SECURITY.md limitation #3 FIXED.
- **Receipt artifact retention raised 90 -> 365 days** for the SOC2/PCI 1-year minimum. SECURITY.md limitation #4 mitigated.

### Added

- **`verdict` `require_stats_for`**: a runner named in this list that emits no `adversarial_stats` is a FAIL. A compromised or misconfigured orchestrator cannot pass by dropping the stats array (fail closed).

### Docs and honesty

- The auto-test-author must NOT write money-path tests (mutation survival is not financial correctness; a human authors money invariants). Warning added to the recipe and the workflow-template prompt.
- Softened "proven" claims to honest framing: the Claude-review demo was n=1 with planted bugs; the mutation result is a real 57% -> 100% demonstration.
- SECURITY.md threat-model prose updated to the comment-based bypass and the current test count.

### Still open (your call, and what capped the review)

- **Rotate the exposed Anthropic API key.** Both reviewers led with this as the #1 disqualifier. It is free, and it caps the grade until done.
- **Enforce on a real money-path repo** with one real golden-master or partner-contract test. An advisory gate on a sandbox is, per the council, "a linter with good PR."
- Tracked: a runner-class field so financial runners can be required by policy (a non-required money runner is currently a config foot-gun).

### Tested

- 262 tests, 261 pass, 1 skipped (Windows symlink).

## [0.5.0] - 2026-05-29

Tag: `fqe-v0.5.0`. Source: github.com/booyajones/fqe. The "set up for success" release: completes the AI layer on your own Anthropic key (no per-seat vendor) and makes the platform adoptable by a small team.

### Added

- **Claude PR review** (`.github/workflows/claude-review.yml`, live on this repo). Anthropic's `claude-code-action` reviews every PR on your own `ANTHROPIC_API_KEY` and comments on the logic bugs the deterministic gate cannot see (float money math, missing idempotency, swallowed errors). Advisory, never blocks. Demonstrated on one PR (n=1, with bugs we planted, so this shows recall on known bugs, not novel ones): it caught four planted payments bugs plus missing tests and noted, unprompted, that the fqe gate could not catch them.
- **Auto-test-author** (`workflows/fqe-write-tests.yml.template`). Label a PR `fqe-write-tests` and Claude writes tests for the changed files on your key, commits them, and the new commit re-runs the gate so the mutation bouncer judges them. The $0 path to "tests write themselves," gated so a weak AI test cannot merge. Upgrades cleanly to qodo-ci or hosted Qodo later (same bouncer, different author).
- **Adoption runbook** (`docs/adopt.md`). The small-team playbook: the three layers, the 10-minute turn-on per repo, how to read a result, when to bypass, and honest sizing guidance (start advisory, skip the paid tools until you grow).
- **Playwright on-ramp recipe** (`docs/recipes/playwright.md`). Wrap an existing Playwright suite (including visual-regression configs) as a required runner. No rewrite.

### Notes

- The AI review and the auto-author both run on Anthropic's official action, so there is no new per-seat vendor. fqe stays the deterministic, blocking, auditable gate; Claude advises and authors; the mutation gate keeps the authored tests honest.

## [0.4.1] - 2026-05-29

Tag: `fqe-v0.4.1`. Source: github.com/booyajones/fqe. Accuracy + dogfooding patch.

### Fixed

- **The AI-test-generation recipe and the `fqe init --with-qodo` glue told people to `pip install qodo-cover`, which does not work.** The open-source Qodo Cover package is archived and not on PyPI. The recipe is now **generator-agnostic**: the mutation gate is the durable bouncer that works today with zero external account, and the test author is pluggable (qodo-ai/qodo-ci, Qodo's hosted product, or any LLM). The glue script is now a fail-safe no-op until you wire `FQE_TEST_AUTHOR_CMD`, so `--with-qodo` no longer generates a broken runner.
- Python mutation guidance corrected from `mutmut` (does not run on Windows) to `cosmic-ray`.

### Added

- **fqe now runs its own test suite in CI** (`.github/workflows/tests.yml`) and `main` is branch-protected requiring the `test` check. A QA tool with no CI on itself is not credible.
- A live, reproducible result in the recipe: on real Finexio code (`brand.ts`), the gate caught a 57% kill rate (coverage without assertions), and strengthening the tests took it to 100%. Ran locally in 7 seconds, no key, no Qodo.

## [0.4.0] - 2026-05-29

Tag: `fqe-v0.4.0`. Source: github.com/booyajones/fqe. This release closes the one security liability the council flagged for a payments company: the bypass mechanism. The design came from a 3-LLM council (claude + gpt + gemini chairman).

### Changed (security, breaking)

- **Bypass is now a SHA-bound, TTL'd PR comment, not a label.** An allowlisted maintainer posts `/fqe-bypass <40-hex-head-sha> <24h|48h|72h>`. The binding is SHA equality: the comment names the exact head it authorizes, so any new push changes `pull.head.sha`, the named SHA no longer matches, and the bypass evaporates with no forgeable inputs (git commit timestamps are forgeable, so the design never trusts them). Identity and time come only from the server-recorded comment object (`user.login`, `created_at`). Edited comments are rejected (`updated_at != created_at`). Full 40-hex SHA only. Fails closed on any error.
- **The legacy unbounded `fqe-bypass` label is no longer honored.** This is a breaking change to the bypass UX. Remove the old label from branch automation and tell maintainers to use the comment.
- The generated `fqe-quality.yml` reads the bypass from the comments API, validates with `fqe bypass-check`, and records `requester_source: github_comments_api_v3` in the receipt.

### Added

- **`fqe bypass-check`** (`cli/lib/bypass_guard.js`, 17 tests). The deterministic core of the bypass decision: TTL + allowlist + edit-guard + SHA binding, all fail-closed. Exit 0 = a valid bypass applies, 3 = no valid bypass (run the gate), 1 = malformed inputs.
- `receipt` now accepts `github_comments_api_v3` as a server-recorded identity source (alongside the legacy events source).

### Tested

- 259 tests, 258 pass, 1 skipped (Windows symlink). No LLM in the verdict path.
- The bypass design was validated by a 3-LLM council; the implementation was reviewed by a gauntlet (no fatal flaws; the edit-guard was hardened to fail closed on unverifiable timestamps).

### Closes

- SECURITY.md limitation #2 (bypass not bound to head SHA, no TTL).

## [0.3.0] - 2026-05-29

Tag: `fqe-v0.3.0`. Source: github.com/booyajones/fqe. This release adds the two gates the gate itself was missing: a guard against a PR editing its own answer key, and fail-closed config validation so a typo cannot silently disable a check. It also fills the payments QA recipe set and adds a CircleCI path so the gate is not GitHub-Actions-only.

### Added

- **`fqe oracle-guard`** (`cli/lib/oracle_guard.js`, 20 tests). Flags a PR that edits the recorded ground truth or grading rules it is judged by (golden masters, snapshots, partner cassettes, fixtures, seeds, `.fqe.yml`, `coverage-baseline.json`, `stryker.conf.json`, the bypass/reviewer allowlists). With `--include-tests`, also flags a test changed alongside the source it grades, while a pure test-writing PR stays frictionless. Exit 0 clean / 3 FLAG (default) / 2 FAIL (`--block`). The companion `workflows/fqe-oracle-guard.yml.template` requires a second reviewer (not the author) before such a PR can merge. The mutation gate proves a test is strong; this keeps the answer key honest.
- **`fqe validate`** plus fail-closed validation inside `fqe run` (`cli/lib/config_schema.js`, 20 tests, `schemas/fqe-config.schema.json`). Rejects unknown keys (a typo'd `whne:` no longer silently disables a runner), wrong types, and runners that can never fire. A JSON Schema drives editor autocomplete.
- **Recipes**: `docs/recipes/property-based-testing.md` (closes the broken link from the rollout plan), `golden-master.md`, `partner-contract.md`, `oracle-tamper.md`, `flaky-quarantine.md`, and `circleci.md`.

### Changed

- **`fqe run` now ERRORs (exit 1) on a malformed `.fqe.yml`** instead of parsing past the problem, dropping the misconfigured runner, and passing green. This is a fail-closed behavior change: a config that used to "work" by silently skipping a check now blocks until fixed. Run `fqe validate` to see why.
- **`FQE_VERSION` bumped to 0.3.0.** It was still reporting `0.1.0` from `fqe version` and in receipts.

### Tested

- 240 tests, 239 pass, 1 skipped (Windows symlink). No LLM in the verdict path.
- The oracle-guard capability was scored by a multi-LLM gauntlet (technical mode, council): no fail-open or data-corruption flaws, fail-closed verified at the CLI and workflow layers.

## [0.2.0] - 2026-05-29

Tag: `fqe-v0.2.0`. Source: github.com/booyajones/fqe. The two quantity/quality gates below were the council's Phase-1 priority. They landed on `main` after the `fqe-v0.1.0` tag was cut, so this release tags them and re-points every pinned install reference at `fqe-v0.2.0`. Repos that pinned `fqe-v0.1.0` should bump their `FQE_TAG`.

### Added

- **`fqe coverage-ratchet --report FILE [--baseline coverage-baseline.json] [--patch-threshold 80] [--bump]`** (`cli/lib/coverage_ratchet.js`, 17 tests). The regression-quantity gate: enforces a patch rule (new lines at least 80% covered) plus total coverage never drops below a committed baseline. Auto-detects vitest/istanbul json-summary, coverage.py json, Cobertura, and lcov. Exit 0 / 2 (FAIL) / 4 (INFRA, unreadable report).
- **`fqe mutation-gate --report stryker.json [--threshold 70] [--changed "a,b"]`** or `--killed N --surviving N` (`cli/lib/mutation_gate.js`, 12 tests). The regression-quality gate and the bouncer for AI-generated tests: rejects tests that execute code without catching mutations. Surviving = Survived + Timeout + NoCoverage. Exit 0 / 2 (FAIL) / 4 (too-few-mutants, neutral).
- **`fqe init --with-mutation`** drops in the Stryker glue (`scripts/fqe_stryker_runner.js` + `stryker.conf.json`) and **`--with-qodo`** drops in a Qodo Cover wrapper that uses `ANTHROPIC_API_KEY` (Claude by default, no new vendor).
- **QA platform rollout plan** (`docs/qa-platform.md`) sequenced from a multi-LLM council review: Phase 1 trust gates (ratchet, flaky quarantine), Phase 2 the mutation-gated AI test factory, Phase 3 payments correctness (property-based, partner-contract, golden-master).
- **Recipes**: `docs/recipes/coverage-ratchet.md` and `docs/recipes/ai-test-generation.md`.

### Tested

- 179 tests pass (`node --test`). The new gates have no LLM in the verdict path, same as the rest of fqe.

### Changed

- Every pinned install/invocation reference moved from `fqe-v0.1.0` to `fqe-v0.2.0` (README, getting-started, faq, qa-platform, the recipes, SECURITY, and the `FQE_TAG` written by `fqe init`).

## [0.1.0] - 2026-05-24

Initial public release. Tag: `fqe-v0.1.0`. Source: github.com/booyajones/fqe.

### Added

- **`fqe run`** orchestrator that classifies the PR diff against `.fqe.yml` and dispatches matching runners as subprocesses.
- **`fqe verdict`** deterministic Node function computing PASS/FLAG/FAIL from runner exit codes + Wilson 95% CI bounds on adversarial stats.
- **`fqe explain`** staff-engineer 5-minute audit. Renders the three architectural invariants, canonical thresholds, current config, exit code taxonomy.
- **`fqe init`** with smart-detect repo bootstrap. Sniffs `package.json`, `pyproject.toml`, `.xlsx` files, `.vale.ini`, `templates/`, MCP markers. Generates context-aware `.fqe.yml` with commented suggestions per detected stack.
- **`fqe receipt`** subcommand suite (build, write, parse, generate-bypass) producing tamper-evident QA-RESULT.{yml,md} bound to `commit_sha + content_hash + inputs_hash`.
- **`fqe status publish`** that calls the GitHub Checks API via `gh api --input -` (nested JSON body, not form fields).
- **`fqe bypass-tally`** JSONL-based 14-day rolling rate tracker with separate run and bypass append commands.
- **`fqe wilson`**, **`fqe min-n`**, **`fqe thresholds`** utility commands for engineers debugging adversarial stat configs.
- **Engineer-grade failure explanations** in receipt markdown bodies. Every FAIL or FLAG includes plain-English reason, fix suggestion, copy-pasteable repro command.
- **Exit code taxonomy**: 0=PASS, 2=FAIL (block), 3=FLAG (informational), 4=INFRA (neutral Check Run, never blocks), 1=ERROR.
- **GitHub Actions workflow templates** (`fqe-quality.yml`, `fqe-second-approve.yml`) with tag-pinned clone of `booyajones/fqe@fqe-v0.1.0` and SHA256-verified yq install.
- **Auto-detect default branch** during `fqe init` (works on `main`, `master`, `develop`).
- **Three architectural invariants enforced in code**: (1) identity from GitHub Events API only, (2) no LLM in verdict path, (3) no required state only in PR branch.

### Tested

- 162 tests pass (unit + integration), 1 properly-skipped (symlink test on Windows).
- Wilson CI math pinned against `statsmodels.stats.proportion.proportion_confint` to 14 decimal places.
- Real GitHub Actions verification: https://github.com/booyajones/fqe-smoke-test/pull/1 (merged, both Check Runs SUCCESS).
- Excel runner validated against external 13,383-formula `vinci1it2000/formulas` test fixture (EUPL-1.1, public).

### Known limitations (planned for 0.2)

These five were flagged unanimously by a 3-judge LLM council before release. They are real architectural gaps, documented in SECURITY.md with today's mitigations.

- **Default install pins to a git tag**, which is force-pushable. Use the SHA-pinned install for production. 0.2 ships a digest-pinned Docker image.
- **`fqe-bypass` label is not bound to the head SHA.** Once applied, it persists across subsequent pushes. 0.2 ships TTL-bound bypass labels (`fqe-bypass-24h`, `-48h`, `-72h`) with head-SHA binding.
- **Allowlist is read at the PR's BASE commit**, not at default-branch HEAD. 0.2 fetches allowlist from `refs/heads/main` at workflow-run time.
- **Receipts default to 90-day GitHub artifact retention.** Check Run output persists indefinitely (with a 65KB cap). 0.2 ships an opt-in post-merge `audits/<sha>/` archiver.
- **Bypass-tally JSONL writes to the protected branch from a `workflow_run` event.** Fork PRs cannot bypass (intentional, read-only token). Concurrency stress-tested to ~5 simultaneous merges. 0.2 moves state to an external KV.

Also:

- **No JSON Schema for `.fqe.yml`** yet. VSCode autocomplete pending.
- **No published Docker image**. Workflows clone-and-install (about 20s overhead per CI run). Once published, swap `container: ghcr.io/booyajones/fqe:0.1`.
- **No `create-fqe-runner` scaffold**. Plugin authoring is doc-driven only.

### Migration notes

This is v0.1.0. No prior version to migrate from.
