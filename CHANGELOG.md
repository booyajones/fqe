# Changelog

All notable changes to fqe. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Semver: MAJOR for invariant changes, MINOR for new features under stable invariants, PATCH for bug fixes.

## [0.14.0] - 2026-06-02

Tag: `fqe-v0.14.0`. Integrity hardening. A completeness-adversary pass (find what is MISSING, not what is wrong) plus an Opus code review found fail-opens that five prior "done" releases shipped past, including a CRITICAL one in the exact part built to defend the money / MCP-write blast radius.

### Fixed (fail-closed)
- **Adversarial Wilson CI is recomputed from raw counts (CRITICAL).** verdict Pass 3 used to trust a runner-supplied `ci_95`, so a runner reporting a real 50/100 attack run with a fabricated tight interval passed the 0.01 money bar. The interval is now recomputed via `wilson95(successes, n)` inside the deterministic core; any supplied `ci_95` is ignored. A runner controls only the raw counts, not the inference.
- **`require_stats_for` is now wired in the real `fqe run` path.** A runner that declares a `blast_radius` must emit its adversarial stats; a dropped payload fails closed. The orchestrator derives the requirement from config (previously the check was dead code never populated outside the raw `fqe verdict` JSON path).
- **`blast_radius` is bound from config, not trusted from runner output.** A money-class runner cannot self-label a weaker class to dodge the bar. A `blast_radius` runner must be `required: true` so a diff that misses its `when` globs cannot skip the stat requirement.
- **A malformed mutation report fails closed.** A declared mutation gate with an unparseable or junk report now FAILs (blocking) or FLAGs (advisory) instead of silently going NEUTRAL. `parseStryker` throws on invalid JSON instead of returning a zeroed tally, so the `fqe mutation-gate` CLI path cannot pass a corrupt report.
- **The `mutation:` block now parses from `.fqe.yml`.** It previously fell through to `{}`, so the mutation gate was unreachable through `fqe run` (configurable only via the raw `fqe verdict` JSON path).
- **`reconcile` with no numeric collected count fails closed** instead of silently skipping reconciliation.
- **`fqe verdict` CLI fails closed to exit 2 (FAIL)** on a rejected input, matching the orchestrator, rather than surfacing as an infra error (exit 1).

### Added
- `blast_radius` runner config key (validated against the canonical blast classes).
- `cli/test/integrity_v014.test.js` plus CLI and schema regressions. 628 tests (627 pass, 1 Windows-symlink skip).

### Honesty
- `package.json` version was stale at 0.7.0 (now 0.14.0); SKILL.md was frozen at v0.7.0/410 tests; `fqe init` scaffolded a stale `fqe-v0.7.0` tag; a doc cited a test that does not exist; README/getting-started carried stale 0.1/0.7 anchors and a wrong Docker org. All corrected.

### Notes
- Reviewed by a 3-agent completeness adversary, an Opus code review (full files), and a technical gauntlet (no confirmed fatal flaw). Still NOT proven on a live production money path; that needs a sandbox. The receipt is content-hashed, not cryptographically signed (planned).

## [0.13.0] - 2026-06-01

Tag: `fqe-v0.13.0`. Stage B linchpin: the mutation-on-diff judge with advisory-first governance. Coverage-liveness proves a test RAN, mutation proves it would CATCH the code breaking. This is what lets fqe trust AI-authored tests without a human reading each one.

### Added
- **Top-level `mutation` block** (mode advisory|blocking, threshold, min_mutants, allowlist) + verdict Pass 9. A `class: mutation` runner emits a Stryker report or a direct `{killed,surviving,survivors}` tally; fqe scopes it to the PR diff, applies the equivalent-mutant allowlist, and maps survivors below threshold to a FLAG (advisory, the default) or FAIL (blocking, once ratcheted). Too few mutants is NEUTRAL (cannot judge, never a silent pass, never a block). The mutation judge can only ADD a FLAG/FAIL, never clear one, so it sits below contracts and money-invariants in the trust hierarchy.
- `evaluateMutationAdvisory` + survivor keys (file:line:Mutator) so an allowlist survives across runs. Built on the existing `parseStryker`/`evaluateMutationGate`.
- docs/recipes/mutation-advisory.md (advisory-first, diff-scope cost control, the AI-authoring-through-the-gate pipeline, and why advisory-first beats a hard gate for adoption).

### Notes
- Backward compatible (no mutation block = no mutation signal). Advisory by default so it never sprays false reds. Ratchet to blocking once the false-red rate on real PRs is near zero.

## [0.12.0] - 2026-06-01

Tag: `fqe-v0.12.0`. `fqe baseline`: contract coverage from the spec a team already wrote (the highest-trust oracle), no LLM guessing.

### Added
- **`fqe baseline --spec openapi.json`** (lib/baseline.js): count operations in an OpenAPI/Swagger JSON spec and scaffold a `contract`-class Schemathesis runner with coverage-liveness wired, so a contract suite that exercised fewer operations than the spec declares FAILs. Fail-closed: an empty, non-JSON, or non-OpenAPI spec throws rather than yielding a misleading 0 (OpenAPI YAML must be passed as JSON, which every toolchain can emit).

### Notes
- Backward compatible. The $0.01 sandbox canary (needs a payment-sandbox credential) and Stage B (mutation-on-diff advisory-first + AI authoring through the gate) are still ahead.

## [0.11.0] - 2026-06-01

Tag: `fqe-v0.11.0`. Stage A part 2: the mandatory money-idempotency invariant, the single highest-severity payments control. fqe now refuses a green for a money-movement repo that never proved a repeated request pays once.

### Added
- **`require_money_idempotency`** (top-level) + a runner `invariant: [idempotency, double-spend, conservation, no-negative-balance]` field. verdict Pass 8: with the flag on, a runner must have ran AND passed AND declared the `idempotency` invariant, else FAIL. Closes the worst payments failure class (double-pay under retry/crash) at the gate.
- docs/recipes/money-invariants.md: real Hypothesis and fast-check idempotency + double-spend property tests, the coverage-liveness pairing, and an optional Toxiproxy crash-window dimension.

### Notes
- Fully backward compatible (flag defaults off).
- Remaining v0.11 (separate, deterministic): `fqe baseline` (OpenAPI/DB DDL into Schemathesis). The $0.01 sandbox canary needs a payment sandbox credential and a safe target. Stage B (mutation + AI authoring, advisory-first) follows Checkpoint 1.

## [0.10.0] - 2026-06-01

Tag: `fqe-v0.10.0`. Stage A of the near-autonomy roadmap (researched + council/gauntlet vetted): trust hygiene and inter-suite discovery, the deterministic foundation the mutation/AI layer (Stage B) sits on. Sequenced cheap-deterministic-wins-first on the council's correction.

### Added
- **`fqe discover`** (lib/discover.js): detect test frameworks (pytest, jest, vitest, mocha, playwright, cargo-test, go-test) from manifests and test files, and report any with no matching declared runner. Extends "make absence loud" from inside a suite (v0.9.0) to ACROSS suites. verdict Pass 7: an unwired suite is a FLAG, FAIL under `require_all_suites_wired`. Honors `.fqeignore`. Fail-loud: ambiguous evidence reports the framework rather than hiding it.
- **Flaky-retry + quarantine** (trust hygiene): a runner `retries: N` re-runs on failure; fail-then-pass is FLAKY, a loud FLAG, never a silent PASS and never a blocking FAIL. `quarantined: true` makes a known-flaky runner's failure a neutral FLAG (stays visible in the receipt) so one unstable suite cannot hold a 10-person team hostage. A non-quarantined failure still FAILs.
- **Human-review telemetry**: the receipt reports a review queue (flags, flaky, quarantined, unwired suites, AI drafts) with estimated minutes, so the near-autonomy target (3 to 6 team-hours per week) is observed, not asserted.
- docs/recipes/discovery-and-trust.md (discover, retries/quarantine, deterministic helpers, the review queue).

### Notes
- Fully backward compatible: runners without the new fields are unaffected.
- Stage A only. Mutation-on-diff and AI authoring (Stage B) are advisory-first and land in v0.12 after Checkpoint 1.

## [0.9.0] - 2026-06-01

Tag: `fqe-v0.9.0`. Coverage-liveness ("make absence loud"): a green can no longer be minted by a suite that ran nothing. Proven by plugging fqe COLD into real third-party Python (more-itertools) and Rust (semver) repos on real CI, turning the "works on any stack" claim from a design property into a reproducible fact (n=3 stacks: TypeScript, Python, Rust).

### Added
- **Coverage-liveness in the verdict path** (no LLM, fail-closed). New opt-in runner fields: `report: junit:<path>`, `inventory_cmd`, `inventory_format` (`count` or `pytest-collect`), `min_tests` (>= 1), `reconcile`, `strict_coverage`; plus a top-level `require_coverage_evidence`.
  - A required runner with no fresh, parseable report FAILs (mandatory evidence).
  - Non-skipped executed count below `min_tests` FAILs (catches empty and all-skipped suites; pytest renders skip AND xfail as `<skipped>`).
  - Collected-vs-executed reconciliation: fewer testcases reported than the framework collected FAILs under `strict_coverage` (else FLAG). Count-based, so it needs no brittle id-string normalization and works on pytest and cargo-nextest alike. A deflated inventory (reported > collected) FAILs closed.
- `cli/lib/junit.js` (zero-dep JUnit parser: counts only non-skipped cases, fails closed on ambiguity, strips XML comments, accepts both quote styles, handles Jest `pending`) and `cli/lib/inventory.js` (collected-count parser).
- Report freshness is clock-INDEPENDENT: fqe records any prior report's mtime, deletes it before the run, and requires the runner to have rewritten it, so a stale or cached report cannot pass even if the delete fails.
- Proof repos: booyajones/fqe-proof-python (more-itertools fork) and booyajones/fqe-proof-rust (semver fork), each green through fqe with a planted mis-scoped run proven RED on real CI.

### Notes
- Fully backward compatible: runners that declare no coverage fields are unaffected.
- Hardened across three plan-gauntlet rounds and two code reviews; every identified fail-open seam was closed before release.

## [0.8.1] - 2026-06-01

Tag: `fqe-v0.8.1`. fqe now self-hosts its own v0.8.0 backstop: the QA engine is gated by the same anti-tautology and money checks it ships.

### Added
- **Self-host gate** (`.github/workflows/fqe-selfhost.yml`): on every push, fqe runs `spec-mutate`, `trace`, and `reconcile` against its own invariants.
- `cli/spec/fqe-invariants.spec` (the canonical blast-radius thresholds), `cli/test/selfhost_spec.test.js` (asserts `verdict.js` matches the spec, source-independent), and `cli/scripts/fqe_specmutate_run.js` (generates spec-mutants, runs the anchored test against each, tallies kills, fails closed on a spawn error, signal/timeout, or a broken baseline).
- `cli/spec/fqe-trace.json` (fqe's money/security requirements mapped to tests) and `cli/spec/fqe-ledger-fixture.json` (a balanced ledger for the reconcile self-check).
- `docs/recipes/self-host.md`: the turnkey pattern any repo copies to gate its own money paths.

### Proven
- All three gates PASS on fqe's real invariants and FAIL (exit 2) on planted defects: an untested money requirement, a surviving spec-mutant, and a one-cent ledger drift. 512 tests, 511 pass, 1 skipped (Windows symlink).

## [0.8.0] - 2026-06-01

Tag: `fqe-v0.8.0`. The autonomous-QA linchpin: three new pure, deterministic, fail-closed modules (no LLM in the verdict), built via an agent swarm and hardened through adversarial review plus two gauntlet rounds.

### Added
- **`spec-mutate`**: mutate the requirement and prove a test fails. A surviving spec-mutant is a tautological test pinned to the code, not the spec.
- **`trace`**: requirement-to-test traceability. A money or security requirement with no covering test, or a money/security test with no real requirement, FAILs.
- **`reconcile`**: deterministic integer-cents double-entry money HALT. Per-transaction and aggregate balance, orphan and over-captured authorizations, timezone-anchored expiry, safe-integer enforcement.
- `spec-mutation` added to the test-class taxonomy.

### Hardening (review + gauntlet findings, all fixed before release)
- spec-mutate: gate on the exact (not rounded) kill ratio, reject threshold 0, mutate every comparison and literal (both range bounds).
- trace: flag a test pointing only at a non-existent requirement, money/security floor cannot be narrowed, duplicate requirement ids throw.
- reconcile: over-capture halts, expiry-at-now is expired, ISO timestamps require a timezone, cents must be safe integers.

## [0.7.0] - 2026-05-30

Tag: `fqe-v0.7.0`. Source: github.com/booyajones/fqe. Turns fqe from a gate over whatever tests you have into a full-suite QA capability: it now understands and enforces every test class an engineering team needs (unit, regression, integration, contract, property, e2e, UAT, money), reports them as one scorecard, and blocks merges by policy. Built with a backbone-then-parallel-agents approach, code-reviewed, and all review findings fixed before ship.

### Added

- **Test-class taxonomy.** A runner can declare a `class` (unit, integration, e2e, regression, contract, property, uat, lint, type, mutation, coverage, security, money). The set is locked in `verdict.js` (`KNOWN_CLASSES`); a typo'd class is rejected by `fqe validate`.
- **Full-suite policy.** A new `policy` block in `.fqe.yml`: `require_classes` (classes that must always have a passing runner) and `require_for` (diff-conditional: when these globs change, these classes become required). A required class with no ran-and-passed runner is a FAIL in `verdict.js`. This is how "money paths get the strict bar" works, and it closes the v0.6.0 tracked deferral (financial runners required by policy). Fails closed: if the diff cannot be read, every `require_for` entry activates.
- **`fqe uat`** — user-acceptance testing as a gate. `uat --spec uat.yml [--results R.json] [--strict]`. A criterion verified by an automated test that passed is covered; a manual criterion needs a signoff; an unverified criterion is a gap (a missing automated result is never a pass). Strict mode makes a gap a FAIL.
- **`fqe golden`** — golden-master regression engine. `golden capture` snapshots deterministic command output; `golden verify` re-runs and FAILs on drift, missing baseline, or a failed command. Pairs with `oracle-guard` so a PR cannot edit its own golden.
- **`fqe qa-report`** — the single-pane QA scorecard. Rolls a QA-RESULT receipt up into per-class status, policy gaps, coverage, and the adversarial summary. Report-only by default; `--gate` maps the verdict to the exit code.
- The receipt now carries each runner's `class` and the run's `required_classes`. `fqe init` scaffolds the taxonomy and a commented policy block.

### Review findings fixed (pre-ship code review)

- Policy parser fails closed: a `require_for` entry with an empty `when:`/`classes:`, or any policy key with no value, throws instead of parsing to a droppable null.
- Diff-indeterminate runs require the strictest class set rather than silently dropping diff-conditional requirements.
- An unknown required class is reported as a likely typo (still fail closed).
- An empty golden manifest is an error, not a green pass. UAT results file must be a JSON object. Golden capture is all-or-nothing on a bad name. UAT spec parsing strips a BOM and refuses to silently yield zero criteria from a non-empty file.

### Tested

- 408 tests, 407 pass, 1 skipped (Windows symlink). No LLM in the verdict path.

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
