# Changelog

All notable changes to fqe. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Semver: MAJOR for invariant changes, MINOR for new features under stable invariants, PATCH for bug fixes.

## [0.18.5] - 2026-08-12

Tag: `fqe-v0.18.5`. Acting on the review of v0.18.4. Every finding was a defect in the guards themselves, which is the honest state of a release line about self-inspection: the guards are now the thing most likely to be wrong.

### Fixed

- **A docblock was attached to the wrong test.** The new `dependencies` assertion was inserted between the `bin` test and the docblock describing it, so one test carried two stacked comments (the first describing a different assertion) and the other carried none. In this file, whose entire thesis is that a comment describing something other than reality is the defect, that is the rot class it exists to catch.
- **Only `dependencies` was compared between the two manifests.** `optionalDependencies`, `peerDependencies` (npm 7+ installs these automatically) and `bundleDependencies` all satisfy the same "declared in `cli/`, never installed for the adopter" shape and all slipped through. Guarding one spelling of a defect is not guarding the defect. All four are compared now.
- **The prose-label guard used one shared `checked > 0` floor across two patterns.** There is exactly one match of each in the repo, so one pattern rotting to zero matches was masked by the other. Rewording README's opener to drop its trailing period would have made that pattern match nothing while the assertion stayed green and the label rotted forever, which is the v0.18.3 bug verbatim. Each pattern now has its own floor.
- **The pin guard matched PIN_CONTEXT against the whole line.** A "line" in SKILL.md's status block is a 4000-character paragraph, so one incidental "npx" in prose marked every version token in it as an executable pin, including correct historical mentions. Now scoped by proximity to the tag. This is the third appearance of one shape: the size guard attributed by array order over a window, the test-count guard excluded by whole line, this one matched by whole line. **Scope the context to the claim, never to whatever container it sits in.**
- **`SKILL.md`'s number was correct while the paragraph under it was two releases stale**, describing v0.18.2 in the present tense with no mention of v0.18.3 or v0.18.4, so a reader landed on a page labelled v0.18.4 and found the never-worked-install fix missing from the release story. Guarding the number cannot see that the prose it labels is out of date.
- **The `persist-credentials` blocks were written by a regex that doubled every newline**, leaving a blank line between each line of the `with:` block, and the same rationale copy-pasted into jobs where it did not apply. Collapsed, and each job now states its own reason.

- **The proximity fix silently shrank pin coverage by five characters.** At `PIN_PROXIMITY = 80` the guard stopped inspecting SECURITY.md's supply-chain pin, whose `git clone` sits 85 characters past the tag: 25 pins became 24 and nothing went red, because the dropped one happened to be correct. Widened to 160, and the rule is now a pure `pinContextNear()` with boundary tests, for the same reason `attributeSizeClaim` was extracted: a window that is only ever exercised against today's files is untested by construction.
- **`bundledDependencies` (with the d) is a real npm alias** that `normalize-package-data` folds into `bundleDependencies` at install time. This guard reads raw JSON and never sees that, so declaring the alias in `cli/package.json` alone would pass green while npm honored a bundle the adopter never got. Five spellings compared now, not four.
- **The dependency message was directional while the assertion is symmetric**, so a key present only in the root manifest produced a failure telling you to edit the file that was already correct.
- **SKILL.md restarted the drift it had just fixed.** v0.18.4 corrected a two-release gap between the status label and the narrative under it; v0.18.5 reopened it at one release in the same commit. Guarding the number cannot see the prose, so the narrative lead is now checked too.

### Notes

- 782 tests. All nine positive-control scenarios still catch, verified after the proximity change loosened the pin guard, since loosening is exactly when a guard quietly stops catching.

## [0.18.4] - 2026-08-12

Tag: `fqe-v0.18.4`. Acting on the CodeRabbit and Claude reviews of v0.18.3. Two of the three findings are the same defect class this release line exists to close: the path that gets tested differing from the path that ships.

### Security

- **`actions/checkout@v5` persisted credentials into every job.** It defaults `persist-credentials: true`, leaving a `GITHUB_TOKEN` in `.git/config` while the new install job executes repository code through `npx`. No step needs authenticated git, so all three checkouts now set `persist-credentials: false`.

### Fixed

- **The two manifests could diverge on `dependencies`, and only the root one is installed.** A runtime dependency added to `cli/package.json` (the natural place) would never be installed for an adopter, and the install job would stay green because `version` / `init` / `validate` do not exercise a dependency used by, say, `reconcile.js`. Green CI, `MODULE_NOT_FOUND` in the adopter's gate. Now asserted equal. Both are empty today, so this fails on the commit that introduces the divergence rather than on the bug report months later.
- **The prose release label was stale while the badge was correct.** v0.18.3 guarded the shields.io badge and not the sentence underneath it, so README's Status paragraph and SKILL.md's `**Status:**` line both still read v0.18.2 on a green build. The badge is decoration; the paragraph is the claim. Both are now guarded.

### Notes

- 778 tests. Both new guards negative-controlled: a runtime dep in only the root manifest, and a stale prose label, each planted alone and each caught.

## [0.18.3] - 2026-08-12

Tag: `fqe-v0.18.3`. **The documented install had never worked.** v0.18.2 shipped guards that proved every install pin named the current version. Running one revealed that none of those commands ran at all.

### Fixed

- **`npx --yes github:booyajones/fqe#<tag> cli/bin/fqe.js …` failed on every version ever tagged.** Verified identical `ENOENT` on v0.13.0, v0.17.0 and v0.18.2. Two independent causes, both now closed:
  1. **No `package.json` at the repo root.** npm clones the repo and immediately reads the root manifest to install it; fqe's manifest lives in `cli/`, so npm died before running anything. A root manifest now exists, declaring `bin: { fqe: "cli/bin/fqe.js" }`.
  2. **The command form passed a path where npx expects a binary name.** `npx <pkg> cli/bin/fqe.js init` makes `cli/bin/fqe.js` the subcommand, so the CLI exits with `unknown subcommand: cli/bin/fqe.js`. All 14 documented commands across nine files are now `npx --yes -p github:booyajones/fqe#<tag> fqe <subcommand>`.

  The `git clone --branch` install used by the CircleCI recipe and the scaffolded workflow was never affected, which is why CI stayed green: the gate installs itself the way that works and documents the way that does not.

### Added

- **A CI job that runs the documented install** on ubuntu and windows: `npx`-installs the commit under review from `file:`, asserts the reported version equals the root manifest's, then runs `fqe init` and `fqe validate` in a scratch repo. This is the check that would have caught the defect. Installing from the checkout rather than a tag means it validates the commit being reviewed, not the last release.
- **Three guards** in `doc_accuracy.test.js`: the root and `cli/` manifest versions must agree (adding the root one created a fresh drift risk in the same stroke, since npm advertises one version while `fqe version` prints the other); `bin.fqe` must point at a file that exists; and no doc may use the npx form that passes a path as a subcommand.

### Notes

- 776 tests, green on ubuntu + windows across Node 20 and 22.
- The lesson worth keeping: v0.18.2's pin guard confirmed all 25 pins named the current version while not one of those commands could run. **Checking that a claim is current is not checking that it is true.** The only guard that closes that gap executes the thing.

## [0.18.2] - 2026-08-12

Tag: `fqe-v0.18.2`. Doc-accuracy release. A cold re-read of the repo found that the claims fqe makes about ITSELF had rotted, in the exact places a skeptical engineer checks first. Nothing in the verdict core was wrong; everything describing it was. The fix is guards, not another hand-pass, because v0.17.0 already did a hand-pass and it did not hold for one release.

### Fixed

- **`npm test` was broken and CI could not see it.** The package script was `node --test test/`, which fails with MODULE_NOT_FOUND on Node 22 (both with and without the trailing slash). CI stayed green the whole time because `tests.yml` ran its own `node --test test/*.test.js` instead. The script is now bare `node --test`, which relies on Node's own test discovery and therefore needs no shell glob expansion on any platform, and **CI now runs `npm test`** so the documented command is the one CI proves. A command CI never runs is a command nobody has tested.
- **`fqe explain` recited a false number at runtime.** It hardcoded verdict.js at "~160 lines" in one sentence and "140 lines" in the very next, to the engineer running the 5-minute audit. It now reads the real file and reports its actual size, so it cannot drift again. Same single-source-of-truth fix v0.17.0 applied to the version string.
- **26 stale executable install pins.** Every `npx` / `git clone` / `FQE_TAG` pin across 15 files still read `fqe-v0.17.0` at v0.18.1, so anyone copy-pasting the documented install got a release behind on the v0.18.1 security-relevant scaffold fix.
- **Source-size claims were off by 3x.** Ten places put verdict.js at 160 lines; it is 516, having grown from 3 verdict passes to 12 across v0.9 -> v0.18. SKILL.md put bin/fqe.js at ~400 LOC; it is 1069.
- **`docs/architecture.md` documented a vulnerability as current behavior.** Its verdict pseudocode showed `if ci_95[1] > threshold`, that is, trusting the runner's own confidence interval. That is precisely the CRITICAL fail-open closed in v0.14.0, where a fabricated tight interval on a real 50/100 attack run sailed past the 0.01 money bar. It also showed 3 of the 12 passes and reported every CI breach as an advisory FLAG, omitting that a money/state breach is a hard FAIL. Rewritten to match the code.
- **README self-contradiction:** receipt signing was listed under "Planned next" while limitation #3 on the same page said it shipped in v0.16.0. Stale status block (v0.17.0 / 749 tests), stale "as of 0.13.0" caption, and a changelog description stopping at 0.13.0 are all corrected.

### Fixed (second pass, from PR review)

- **The new guard's attribution picked by ARRAY ORDER, not proximity.** `TARGETS.find(t => t.keyword.test(window))` returns the first entry listed, so `verdict` beat `bin/fqe.js` whenever both appeared in the 6-line window. SKILL.md passed only by luck of line ordering: sort that file tree alphabetically and the guard reports "claims 1070 for verdict.js, actual 516 (107% off)" — red, for the wrong file, on a doc that was correct. A guard that cries wolf gets deleted, which is the failure it exists to prevent. Now nearest mention wins, two files on the same nearest line report ambiguity rather than guessing, and the rule is a pure `attributeSizeClaim()` tested directly with synthetic fixtures (the whole-repo scan cannot catch this class: it only sees today's files, where the right and wrong answers coincided).
- **`return` instead of `continue`** inside the per-line match loop exited the callback for the entire line, so a second size claim on a line was skipped whenever the first was unattributable.
- **Three test-count claims were stale in files this release had already edited** (749 in `SECURITY.md`, `CONTRIBUTING.md`, `SKILL.md`), including the count backing the "no LLM in the verdict path" invariant in the threat model. `CONTRIBUTING.md` also told contributors to run `node --test test/` — the exact broken command this release fixes.
- **Three version mentions asserted the CURRENT pin but dodged the pin guard** (`SECURITY.md` x2, `docs/getting-started.md`), so at the next release they would have contradicted the guarded command ten lines above them in the same file. Reworded to name no version at all: an unrottable claim beats a guarded one.
- **Two overclaims this release itself introduced** in `docs/architecture.md`: "fails the build if either accumulator is *ever* assigned anything but `true`" promised AST-level coverage that a regex-over-source guard does not have (it misses aliasing and destructuring), and "the order does not matter to the outcome" was wrong for the `reasons` list, since a throw in Pass 3 means Passes 4-12 never contribute theirs. Both narrowed to what is actually true.
- **`fqe explain` read `verdict.js` twice per load** via two call sites in the module-scope array. Hoisted to one `VERDICT_SIZE` constant, which also makes it structurally impossible for the two sentences to disagree again — the original bug.

### Added

- **`cli/scripts/check_test_count.js`**: verifies every documented test count against the real suite. It runs as a separate CI job rather than a test, because a suite cannot count itself without spawning itself forever. Counts next to a third-party repo name (the more-itertools and semver proof forks) are excluded by proximity to the number, not by whole line — the first version excluded any line naming a third-party repo and silently swallowed SKILL.md's own count, which sits in a long paragraph that mentions the proof repos much later.
- **CI matrix**: ubuntu + windows, Node 20 and 22. `engines` declares `>=20` and a floor nothing runs is a claim rather than a fact; the repo also asserts cross-platform behavior ("1 Windows-symlink skip") that only Windows can observe.
- **A guard that `cli/test/` holds only `*.test.js`.** Bare `node --test` uses Node's default discovery, which executes ANY `.js` under a `test/` directory. Verified on Node 22.16 by dropping a `.js` into `test/fixtures/` and watching it run as a test, so `fixtures/` is deliberately scanned rather than skipped: that is exactly where a contributor would put one. Also verified Node does NOT descend into dot-directories, so a crashed Stryker run leaving `.stryker-tmp/sandbox-*/test/*.test.js` is not picked up.
- **A real floor on the pin guard.** It asserted only `checked > 0`. Since this release exists because 26 stale pins went unnoticed, a future PR consolidating 25 pin mentions down to 1 would have passed while watching 96% less. Now `MIN_PIN_CLAIMS`.

- **`cli/test/doc_accuracy.test.js`**: three guards that make all of the above self-enforcing. (1) Every executable install pin must equal `package.json`'s version. (2) Every source-size claim in the docs must be within 15% of the real file, attributed to its subject by keyword within a 6-line window. (3) The README status badge must match `package.json`. Each guard also fails when it finds NOTHING to inspect, so a reword cannot turn it into a hollow green. Scope is documented in the file header: prose version mentions and CHANGELOG history are deliberately out of scope, since they are correct as history.

### Notes

- 765 tests (764 pass, 1 Windows-symlink skip). Each guard was verified by planting its regression one at a time and confirming the right guard went red with the right message, including the two hollow-pass paths. A guard that has only ever passed is not evidence.
- Unchanged and still the real adoption blockers: no live production money-path proof, bus factor 1, HMAC rather than Sigstore by default, mutation gate advisory by default.

## [0.18.1] - 2026-06-02

Tag: `fqe-v0.18.1`. Acting on an external multi-LLM review (council + gauntlet, GPT/DeepSeek/Gemini) of the finished v0.18.0 package. The verdict is recorded honestly: internal dev-team use SHIP-WITH-CONDITIONS (~63/100), required money-path gate NOT-YET (~25/100), overall RECONSIDER (66/100), capped by what only people and data can fix (no live-money-path proof, bus factor 1, HMAC-not-Sigstore-by-default). This patch closes the two findings that were solo-fixable and were the structural blind spots a Claude-only review had missed.

### Added
- **`docs/build-vs-buy.md`**: the honest answer to the single most likely staff-engineer objection the review named ("why not Codecov + Stryker + Sigstore + branch protection?"). fqe does not replace those tools, it composes them; its only unique job is one deterministic, fail-closed, money-aware verdict across heterogeneous runners. For everything else: buy, do not build. Includes the honest adoption sequencing (off-the-shelf first, fqe as a non-blocking layer, required gate only after shadow-trial data).
- **Strictly-additive invariant guard** (`cli/test/source_hygiene.test.js`): fqe's strongest claim was that a verdict pass can only ADD a FLAG/FAIL and never clear one, but that was a convention enforced by discipline alone (the fragility the review flagged: "a Pass 13 by a tired human could silently break it"). A source guard now proves the two verdict accumulators in `verdict.js` are initialized once to `false` and thereafter only ever assigned the literal `true`. Any direct clear (`= false`, `&&=`, `||=`, `??=`, or a non-literal RHS) fails the test. Scope kept honest: it covers direct assignment, not aliasing/destructuring (verdict.js uses plain locals, so it is complete for the code as written).

### Fixed
- **`fqe init` scaffold pinned a stale, security-behind release.** The payments workflow `fqe init` writes pinned `FQE_TAG="fqe-v0.16.0"`, so new adopters got a version missing the v0.17 security fixes (the signing-key environment leak and the empty-UAT silent PASS). Bumped to `fqe-v0.18.1`.
- **`fqe init` scaffold emitted soon-deprecated CI actions.** Bumped the scaffolded `actions/checkout` and `actions/setup-node` to `@v5` to match the repo's own CI (GitHub deprecates the node20 action runtime in 2026). `upload-artifact` stays at `@v4` (current major).

## [0.18.0] - 2026-06-02

Tag: `fqe-v0.18.0`. The buildable backlog: the shadow-trial scorecard (the adoption-winning artifact), the last discovery gap, the CI-actions bump, and the doc nits.

### Added
- **`fqe scorecard --dir <receipts-dir>`** (`cli/lib/scorecard.js`): aggregates a directory of QA-RESULT receipts into the shadow-trial scorecard the red-team named as the precondition for trusting a required gate. Reports the three metrics: false-red rate (fraction of FAILs that were bypassed), gate wall-time (p50/p95/max), and true catches (FAILs that stuck). Plus verdict distribution, bypass count, and modeled human-review minutes. A report, not a gate (always exits 0). `--format json` for machine use.

### Fixed
- **M3:** a framework configured only via its config file (e.g. `vitest.config.ts` with no `package.json` devDep/script) is now detected — `discover()` populates the `configMarker` the framework's `manifestHit` reads. Previously such a suite was invisible.

### Changed
- CI actions bumped off the deprecated Node 20: `actions/checkout` and `actions/setup-node` to `@v5` across the workflow templates and the repo's own CI.
- Doc accuracy: `writing-a-runner` now states `ci_95` is recomputed/ignored since v0.14 and that a config `blast_radius` is authoritative; removed the broken `docs/releasing.md` and `claude-review.yml` references and the stale "628 tests" line.

### Notes
- 758 tests (757 pass, 1 Windows-symlink skip). The false-red signal is the deterministic proxy "a FAIL that a human bypassed"; the wall-time ratio target needs the team's own CI baseline, which is not in the receipt, so the scorecard reports the gate's own time and leaves the ratio to the operator.

## [0.17.0] - 2026-06-02

Tag: `fqe-v0.17.0`. Full-codebase adversary sweep + hardening. Prompted by "are you sure there is nothing else to do?", three adversaries audited the WHOLE codebase (not just diffs) — the per-version reviews had only ever seen diffs. They found a CRITICAL silent-pass, three HIGH fail-opens, and extensive doc drift, none diff-catchable.

### Fixed (fail-closed)
- **CRITICAL: an empty UAT spec is no longer a silent PASS.** `evaluateUat` now FAILs (coverage 0) when a spec declares zero criteria, at the source, so neither the YAML nor the JSON parser branch can mint a green from nothing (the YAML branch guarded this; the JSON branch did not).
- **The signing key is stripped from runner subprocesses.** Runner + inventory_cmd subprocesses ran with the full `process.env`, exposing `FQE_SIGNING_KEY` (and other CI secrets) to PR-controlled commands, which could exfiltrate the key and forge signed receipts. They now get a sanitized env with secret-named vars removed.
- **Bypass-rate undercount fixed.** A bypass row with a missing/unparseable timestamp was silently dropped from the rolling-rate numerator (a way to keep the abuse alarm quiet). It now counts (fail closed toward detection); undatable totals do not dilute the denominator.
- **`.fqeignore` no longer over-matches.** A bare pattern (`src`) matched any prefix (`src_test.py`), which could hide whole test suites from discovery. It now matches only the exact path or a path-segment boundary.
- **Oracle/golden/config matching is case-insensitive**, so a case-variant rename (`.FQE.YML`, `*.GOLDEN`) on a case-insensitive filesystem can no longer evade the tamper guard.
- **A malformed lcov payload (`LH:xyz`) is UNREADABLE, not 0** (no longer coerced via `|| 0` into a confident wrong coverage number).
- **Source hygiene:** removed two literal NUL bytes from `orchestrator.js` (`computeContentHash` used a raw `0x00` delimiter instead of the `\0` escape; same hash, but it made the file read as binary to grep/editors). Added a guard test that fails if any source file ever contains a NUL byte.
- **Receipt signing key_id check is unconditional** (an absent key_id no longer skips the check); `key_id` is domain-separated. The signed tuple now explicitly includes `bypass` (override authority).

### Changed
- **Version drift root cause removed.** `bin/fqe.js` and `lib/explain.js` no longer hardcode the version (explain.js was stuck at 0.7.0 and printed it at runtime); both derive it from `package.json`, the single source of truth.
- **Docs honesty pass:** 27 stale install/pin tags updated to `fqe-v0.17.0`; stale test counts (162/407/613/740) and version badges corrected; the removed `fqe-bypass` label is replaced with the `/fqe-bypass` comment everywhere; the architecture doc's stale Events-API identity path and a broken `validateCtx` reference are corrected; the Docker image org is consistent (`ghcr.io/booyajones/fqe`).

### Added
- opt-in `require_nonempty_gate` (shipped in 0.16; documented). `cli/test/hardening_v017.test.js` + `source_hygiene.test.js`. 749 tests (748 pass, 1 Windows-symlink skip).

### Notes
- Confirmed clean by the sweep: bypass_guard, golden, reconcile, trace, junit, inventory, qa_report, and the core verdict / bypass-identity / prototype-pollution / command-injection defenses all held. One audit finding (runner stdout in the receipt) was verified a false positive: stdout is captured for line-parsing but never serialized into the receipt or Check Run.

## [0.16.0] - 2026-06-02

Tag: `fqe-v0.16.0`. Trust hardening: the receipt goes from tamper-EVIDENT (a hash) to tamper-PROOF (a signature), closing the red-team's "a bare hash is compliance theater" objection. Plus an opt-in empty-gate guard.

### Added
- **Receipt signing** (`cli/lib/signature.js`, `fqe receipt sign` / `fqe receipt verify`). HMAC-SHA256 over a canonical field tuple (`schema_version`, `fqe_version`, `commit_sha`, `content_hash`, `inputs_hash`, `verdict`); `content_hash` already covers every file, so the signature authenticates the full claim. Signing is deterministic (the caller passes `signed_at`; it is metadata, not part of the signed payload) and the tuple is robust to YAML round-trip. `verify` fails closed (exit 2) on any tamper, a wrong key, or a missing signature under `--require-signature`. A `key_id` records which key signed.
- **Sigstore keyless recipe** (`docs/recipes/receipt-signing.md`): the CI workflow step for OIDC identity-bound, non-repudiable, transparency-logged signing — the SOC2/PCI-grade layer above HMAC.
- **F2 (opt-in) empty/hollow-gate guard**: with top-level `require_nonempty_gate: true`, a gate with no teeth (no required runner, no required test class, no money-idempotency requirement) FAILs instead of minting a green that protects nothing. Default off, so the documented "no runners = PASS" behavior is unchanged.

### Notes
- HMAC proves key possession (the CI runner held `FQE_SIGNING_KEY`); Sigstore keyless is the non-repudiation answer and runs in CI. Honest scope documented in the recipe. 740 tests (739 pass, 1 Windows-symlink skip).

## [0.15.0] - 2026-06-02

Tag: `fqe-v0.15.0`. Money-aware strict profile + foot-gun caps. fqe's fail-closed guarantees were real but opt-in: strict protections defaulted off and the abusable carve-outs were unbounded. v0.15.0 makes money repos safe-by-default and caps the carve-outs. Designed via a parallel agent workflow (one designer per feature, synthesized into one conflict-aware build plan).

### Added
- **`fqe init --payments`**: scaffolds a strict money profile (`PAYMENTS_FQE_YML`) with required, reconciled, strict-coverage, blocking-mutation money/contract runners and `require_money_idempotency`.
- **Money-strict validation (MS)**: a `class: money`/`class: contract` runner must be `required: true`, declare a `report`, set `reconcile: true` and `strict_coverage: true`, and may not be `quarantined`. Loosening any of these FAILS validation loudly. Under a money policy, `mutation.mode` must be `blocking`, the allowlist is capped at 10, and `max_suppression_ratio` may not exceed 0.5.
- **F1 quarantine TTL**: a `quarantined: true` runner must carry a `quarantined_since` ISO date and expires after `quarantine_ttl_days` (default 14, max 90). An expired quarantine no longer shields a failure (it FAILs). Quarantine is banned on money/contract classes. The clock lives in the orchestrator; verdict.js stays clock-free.
- **F6 mutation allowlist suppression-ratio cap**: if more than half the in-scope survivors are allowlisted as equivalent, the advisory gate FLAGs the suppression (configurable via `mutation.max_suppression_ratio`, default 0.5).
- **F8 `min_mutants` ceiling**: capped at 5, so a high floor cannot pin the gate to NEUTRAL forever.
- **A4 money-path heuristic** (`cli/lib/money_scan.js`): detects money-looking code in the diff (by path and keyword) and FLAGs it when no money policy is configured (FAIL under `require_money_policy_when_detected`). Detection is by real signal; a blind diff is handled fail-closed by `require_for` activation, not a noisy universal flag.
- **F9 dead `require_for` glob detection**: a policy glob that matches no repo file is reported (FLAG, or FAIL under the strict flag), catching a typo that would silently guard nothing.

### Notes
- Backward compatible for non-money repos: the strict rules key on the money/contract class, and the new top-level flags default off. 720 tests (719 pass, 1 Windows-symlink skip). Still NOT proven on a live production money path.

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
