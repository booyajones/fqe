---
name: fqe
description: Finexio Quality Engine (fqe). A unified deterministic CI gate for Finexio builds. Runs verified-against-real-CI checks across web apps, financial models, MCP servers, outbound copy, and AI agents, producing a SHA-bound receipt that branch protection requires before any "done", "ship", "merge", "ready", or "deploy" claim. Auto-fires on build intent. Use this when Chris is about to ship something, when QA is needed, when reviewing whether a change is safe to merge, or when bootstrapping a Finexio repo with the gate.
---

# fqe: Finexio Quality Engine

**Status:** v0.18.19. Deterministic, fail-closed CI gate with a no-LLM verdict and a SHA-bound, tamper-evident receipt that can be cryptographically SIGNED. 839 tests, green on real GitHub Actions across ubuntu + windows and Node 20 + 22 (one symlink test self-skips on a Windows box without developer mode). v0.18.19 fixed the four PLATFORM defects that actually made engineers quit: a spawn failure was recorded in the receipt as `ran: true` with a 7ms duration (it now reports ran:false with the OS error and the Windows cmd /c workaround), unknown flags were accepted silently so a typo in --config turned a fail-closed gate green, an explicitly-named base ref that did not resolve was swallowed and diffed zero files, and evidence_paths was hardcoded empty while three docs promised the runner's stderr. v0.18.18 shipped only the doc tier, because the push went to fix/coldstart-text while the PR tracked fix/cold-start-text, one hyphen apart. v0.18.18 acted on a 3-engineer COLD START (42 findings, 40 reproduced, 2 of 3 hard-stopped): the generated config emitted a commented runners: example above a live runners: {}, so uncommenting it as the docs instruct created a duplicate YAML key that silently discarded every runner and left a green gate enforcing nothing (and inline runners: {} parsed as the 2-char STRING, not a map). The flagship local-run command was missing its required --commit and carried two flags that do not exist, wrong in 6 docs and in every receipt fqe generates. The failure explainer blamed a runner JSON typo for what is actually a Windows spawn failure, and pointed at a bypass label removed in v0.4.0. Docs promised a smart-detect that has no code, and SECURITY.md still argued against enabling the gate until 0.2. v0.18.17 moved the proof into the suite: the "catches five spellings" claim had rested on a scratch script that was deleted, so the rule is now a pure function with six committed counter-examples plus a false-positive and an out-of-scope case. v0.18.16 replaced that guard again after finding that merely SWAPPING the install and verify lines reproduced the identical vulnerability with the guard green: it keyed on wget/curl, and the `sudo install` line has neither. The rule is now an ORDERING one, scoped per step, tested against five different spellings of the same defect. v0.18.15 closed the gap that made the previous guard hollow: it matched the yq DOWNLOAD URL, which is identical in the safe and the vulnerable form, so reverting to the download-onto-PATH order left the suite green. The invariant is now positional (never fetch into a PATH directory), verified by reverting to the vulnerable form and watching it go red. v0.18.14 hardened the yq step and the guard behind it: the SHA256 download landed on PATH before it was verified (now temp-then-verify-then-install, the order the Dockerfile already used), and the binary guard accepted a CALL as proof of installation and was order-blind, so a pure reordering left it green. v0.18.13 finished that fix: the removed container had also supplied yq, so v0.18.12 moved the failure from image pull to "yq: command not found" a few steps later. It now installs yq with the same SHA256 verification the gate uses, and a test asserts every binary a generated workflow calls is installed in it. v0.18.12 fixed a workflow that could never start: fqe init generated a second-approve job running inside ghcr.io/booyajones/fqe:0.1, an image that has NEVER been published (Packages API 404, owner has zero container packages), so it failed on image pull before step one. Both it and the reference templates now install the CLI the same ref-pinned way as the gate, and a test asserts no generated workflow declares a container. v0.18.11 fixed a RUNNER_TEMP fallback that was dead code under set -u, corrected the SECURITY table (fqe init generates the container form too, and all three pins are mutable as shipped), and added a guard so the container org cannot rot a third time. v0.18.10 stopped staging fetched code at a predictable path in world-writable /tmp (it now uses mktemp -d under RUNNER_TEMP), corrected the shipped templates to ghcr.io/booyajones, and documented all THREE install mechanisms honestly (the container form is a mutable tag and the weakest pin). v0.18.9 made the scaffold re-runnable (git remote add is not idempotent, and /tmp persists on self-hosted runners) and tightened the proximity upper bound. v0.18.8 fixed the documented SHA-pinning, which broke the gate rather than hardening it (`git clone --branch` takes a ref name, not a commit SHA), and corrected two false claims in v0.18.7. v0.18.7 corrected v0.18.6, including a false claim in its own changelog: the control it replaced had actually pinned the proximity window at its lower edge, so the swap left the shipped constant unconstrained. v0.18.6 fixed a third round of guard defects, including the misattached docblock returning in the commit that fixed it. v0.18.5 fixed the guards themselves after review: a docblock had attached to the wrong test, only one of five dependency-field spellings was compared, two label patterns shared one hollow-pass floor, and the pin check matched context against a whole 4000-character paragraph. v0.18.4 hardened CI credentials (`actions/checkout@v5` defaults `persist-credentials: true`, leaving a token in `.git/config` while the install job runs repo code through npx) and closed a dependency-drift channel: npm installs the ROOT manifest, so a runtime dep declared only in `cli/package.json` would never reach an adopter while CI stayed green. **v0.18.3 fixed an install command that had NEVER worked.** The documented one-liner failed with ENOENT on every version ever tagged: there was no package.json at the repo root, and the command form passed a file path where npx expects a bin name. The `git clone` install used by the scaffolded workflow was unaffected, which is why CI stayed green for eighteen releases: the gate installed itself the way that works and documented the way that does not. A CI job now runs the documented install for real on ubuntu and windows. v0.18.2 was the doc-accuracy release: the claims fqe made about ITSELF had rotted in the places a skeptical engineer checks first. `npm test` was broken on Node 22 and CI could not see it because CI ran a different command (CI now runs `npm test`); `fqe explain` recited a hardcoded, wrong verdict.js size at runtime (it now reads the real file); 26 executable install pins were a release stale; the architecture doc still documented the pre-v0.14 fail-open (trusting a runner's own confidence interval) as current behavior. All of it is now enforced by `cli/test/doc_accuracy.test.js` rather than by another hand-pass, since v0.17.0's hand-pass did not survive one release. v0.18.1 acted on an external multi-LLM review (council + gauntlet, GPT/DeepSeek/Gemini) of the finished package. Recorded verdict, kept honest: internal dev-team use SHIP-WITH-CONDITIONS, required money-path gate NOT-YET (overall RECONSIDER, 66/100), capped by what only people and data can fix (no live-money-path proof, bus factor 1, HMAC-not-Sigstore-by-default). The two solo-fixable findings are closed: a source guard now ENFORCES the strictly-additive verdict invariant (no pass can clear a FLAG/FAIL, it was a convention before), and a new [docs/build-vs-buy.md](docs/build-vs-buy.md) gives the honest answer to the top staff-engineer objection ("why not Codecov + Stryker + Sigstore + branch protection?"). It also fixes a stale, security-behind `fqe init` scaffold pin (was fqe-v0.16.0, missing the v0.17 security fixes). v0.18.0 added `fqe scorecard` (the shadow-trial adoption metrics: false-red rate, gate wall-time, true catches, aggregated from a directory of receipts), fixed config-only framework discovery, and bumped CI off the deprecated Node 20. v0.17.0 was a full-codebase adversary sweep + hardening: closed a CRITICAL silent-pass (an empty UAT spec is no longer 100% covered), stripped fqe's signing key and other secrets from untrusted runner subprocesses, fixed the bypass-rate undercount and an over-broad `.fqeignore`, made oracle/golden matching case-insensitive, and removed the version-drift root cause (the version derives from package.json everywhere). v0.16.0 added receipt signing: `fqe receipt sign` / `verify` (HMAC-SHA256 over the commit + content-hash + inputs + verdict + bypass tuple, fail-closed on tamper) plus a Sigstore keyless CI recipe for non-repudiable, identity-bound signing, and an opt-in `require_nonempty_gate` that refuses a green from a gate with no teeth. v0.15.0 made money repos safe-by-default: `fqe init --payments` scaffolds a strict profile, and a money/contract runner is forced to be required, reconciled, strict-coverage, blocking-mutation, and never quarantined (loosening any of it FAILS validation). It also caps the abusable carve-outs (quarantine expires after a TTL and is banned on money classes; the mutation allowlist has a suppression-ratio cap; `min_mutants` has a ceiling) and adds a money-path heuristic that FLAGs money-looking code shipped with no money policy. v0.14.0 hardened the adversarial money gate: the Wilson interval is recomputed from raw counts, a blast-class runner must emit its stats, a malformed mutation report fails closed, and the `mutation:` block parses from `.fqe.yml`. Proven cold on third-party OSS (Python/pytest, Rust/cargo) on real CI. Not yet proven on a live production money path (that needs a sandbox). The receipt is content-hashed and HMAC-signable now, with Sigstore keyless signing as the CI recipe. Source: `github.com/booyajones/fqe` (public) and `github.com/booyajones/finexio-skills/fqe` (mirror).

## When to fire (auto-invoke triggers)

Auto-fire when Chris says or implies any of these:

- "ship", "ship it", "merge", "deploy", "land", "push it", "send it"
- "done", "ready", "good to go", "all set", "wrapped up"
- "qa", "test this", "quality check", "audit", "verify", "review"
- "gate this", "block-or-pass", "is this safe to merge"
- "add fqe to <repo>", "bootstrap fqe", "set up the gate"
- About to send an outbound email or push a financial model

Do NOT fire for: pure planning/brainstorming, read-only code exploration, documentation edits.

## The three architectural invariants (memorize these)

Every operation Chris asks for must hold these. If a request would violate one, push back and explain.

1. **No identity claim is ever read from a file the constrained actor wrote.** The bypass requester comes from the GitHub comments API (server-recorded comment author). Receipt content is informational, never trusted for identity.
2. **No LLM is in the verdict path.** `verdict.js` is a deterministic Node script. Same inputs produce the same output. You may surface the verdict but never author one.
3. **No required state lives only in the PR branch.** Receipts persist as workflow artifacts + Check Run outputs (server-side, immutable).

## How to use it: the cookbook

### Use case 1: Chris says "I'm about to ship X"

```bash
# Confirm fqe/pass is green on the PR
gh pr checks <pr-url-or-number>

# If not green, fetch the receipt
gh run download <run-id> -n qa-receipt-<sha>
cat QA-RESULT.md          # human-readable
fqe receipt parse QA-RESULT.yml | jq .verdict
```

Surface the verdict + reasons. **Never propose `git push --no-verify` or `--force`.** If something needs to bypass, that's a deliberate human act (an allowlisted maintainer posts a SHA-bound `/fqe-bypass <head-sha> <24h|48h|72h>` PR comment).

### Use case 2: Chris says "QA this" or "verify this"

Locally:
```bash
cd <repo>
fqe run --commit "$(git rev-parse HEAD)" --base main --output ./out/
cat out/QA-RESULT.md
echo "Exit: $?"   # 0=PASS  2=FAIL  3=FLAG
```

Surface the verdict. If FAIL, the reasons array tells you exactly which runner exited non-zero. If FLAG, the adversarial-stats table shows the Wilson 95% CI upper bound vs the canonical threshold.

### Use case 3: Chris says "add fqe to <repo>"

```bash
cd <repo>
fqe init                           # adds .fqe.yml + workflows + allowlists
# Edit .fqe.yml to declare actual runners for this repo's artifacts
# Commit on a branch and open a PR: the gate is now live
```

After init, the repo has:
- `.fqe.yml`: runner config (Chris edits to declare web/excel/mcp/outbound runners)
- `.github/workflows/fqe-quality.yml`: main gate
- `.github/workflows/fqe-second-approve.yml`: bypass-unblock
- `.github/fqe-bypass-allowlist.yml`: seeded with Chris's GitHub login
- `.github/fqe-second-reviewers.yml`: empty by default; Chris adds reviewers
- `.github/fqe-state/.gitkeep`: bypass-tally JSONL state dir

### Use case 4: Chris asks about thresholds or stats

The canonical thresholds are **locked** in `verdict.js`: they can't be passed in:

| Blast radius | Wilson CI-upper threshold |
|---|---|
| `outbound` | 0.05 |
| `mcp-read` | 0.03 |
| `mcp-write-or-financial` | 0.01 |

```bash
fqe thresholds                       # show the canonical map
fqe wilson 0 100                     # Wilson 95% CI for 0/100
fqe min-n 0.01                       # min N to defend ≤1% upper bound
```

### Use case 5: Bypass rate seems high

```bash
fqe bypass-tally rate --state-dir .github/fqe-state --window-days 14
```

If `rate > 0.10`, the `fqe/second-reviewer-required` check goes red on every PR until a non-bypass-requester from `.github/fqe-second-reviewers.yml` adds the `fqe-second-approved` label.

### Use case 6: full-suite QA (classes, policy, UAT, regression, scorecard)

Tag each runner with a `class` and set a `policy` so the right test types are required before merge, automatically stricter on money paths. A required class with no passing runner is a FAIL.

```yaml
# .fqe.yml
policy:
  require_classes: ["unit", "lint"]
  require_for:
    - when: ["src/payments/**", "src/ledger/**"]
      classes: ["money", "regression", "contract"]
```

```bash
fqe uat --spec uat.yml --results uat-results.json --strict   # acceptance gate
fqe golden capture --manifest golden.yml --dir goldens/      # snapshot regression baselines
fqe golden verify  --manifest golden.yml --dir goldens/      # FAIL on drift
fqe qa-report --receipt out/QA-RESULT.yml                    # one scorecard, per-class status + gaps
```

Classes: unit, integration, e2e, regression, contract, property, uat, lint, type, mutation, coverage, security, money. See `docs/recipes/test-taxonomy.md`, `docs/recipes/uat.md`, `docs/recipes/regression-golden.md`.

## Anti-patterns (HARD RULES)

- **Do not write the verdict as text.** Compute it via `fqe verdict` or `fqe run`.
- **Do not propose `--no-verify`, `--force-push`, or `--admin` overrides.** These bypass the gate without audit trail.
- **Do not hand-edit `QA-RESULT.yml`.** It's commit-SHA-bound: edits invalidate it.
- **Do not add yourself to `.github/fqe-bypass-allowlist.yml` in the same PR you want to bypass.** The allowlist is read at base commit, not HEAD, so this can't work anyway.
- **Do not propose posting a `/fqe-bypass <sha> <ttl>` PR comment on Chris's behalf without explicit "yes, do it".**
- **Do not use this skill to score finished prose**: that's `/gauntlet`.

## What's verified (real CI evidence)

- Unit tests on real ubuntu-latest: https://github.com/booyajones/fqe-smoke-test/actions/runs/26348987394
- Docker image build + in-container tools verified: https://github.com/booyajones/fqe-smoke-test/actions/runs/26348823911
- 7 rounds of multi-LLM code gauntlet; final score 88/100 SHIP, 0 fatal flaws
- 6 rounds of plan gauntlet; final 76/100 with 0 invariant-violating flaws
- v0.14.0: a 3-agent completeness-adversary pass + an Opus full-file code review + a technical gauntlet (no confirmed fatal flaw) found and closed a CRITICAL integrity fail-open (the adversarial money gate trusted a runner-supplied Wilson interval) plus its CLI-path siblings. (Suite has since grown; current count is in the Status line above.)

## Files in the skill

```
fqe/
├── SKILL.md                          # this file
├── README.md                         # architecture, plan trajectory
├── cli/
│   ├── package.json
│   ├── bin/fqe.js                    # entry point (~1070 LOC)
│   ├── lib/
│   │   ├── verdict.js                # deterministic verdict (no LLM)
│   │   ├── wilson.js                 # Wilson 95% CI (statsmodels-pinned)
│   │   ├── receipt.js                # build/serialize/parse/validate
│   │   ├── bypass_tally.js           # JSONL rolling rate
│   │   ├── orchestrator.js           # composes the pieces
│   │   └── init.js                   # one-command bootstrap
│   └── test/                         # the full suite
├── schemas/receipt-v1.yml            # receipt schema
├── workflows/
│   ├── fqe-quality.yml.template      # main CI gate
│   └── fqe-second-approve.yml.template
├── smoke/smoke_tools.py              # Phase 1 Day 1.0 verification
└── Dockerfile                        # ghcr.io/booyajones/fqe:0.1
```

## Quick reference card

```
fqe init                                            bootstrap a repo (scaffolds taxonomy + policy)
fqe run --commit SHA --output DIR                   orchestrate gate (enforces policy classes)
fqe verdict -                                       compute verdict from JSON stdin
fqe uat --spec uat.yml [--results R.json] [--strict] acceptance-criteria gate
fqe golden capture|verify --manifest M --dir D       golden-master regression engine
fqe qa-report --receipt FILE [--json] [--gate]       per-class QA scorecard + policy gaps
fqe validate                                        fail-closed .fqe.yml check (rejects bad class)
fqe oracle-guard                                    flag a PR editing its own answer key
fqe coverage-ratchet --report FILE                  coverage never drops
fqe mutation-gate --report stryker.json             tests must catch injected bugs
fqe spec-mutate --report R.json [--threshold N]      kill tautological tests (corrupt the requirement)
fqe trace --matrix M.json                            requirement<->test traceability gate
fqe reconcile --ledger L.json                        double-entry money HALT (debits==credits)
fqe receipt parse FILE                              parse + print verdict
fqe status publish --check N --commit S --state X   emit GitHub check-run
fqe bypass-tally rate --state-dir D [--format scalar] rolling bypass rate
fqe thresholds                                      show canonical thresholds
fqe wilson SUCCESSES N                              Wilson 95% CI

Test classes: unit integration e2e regression contract property uat lint type mutation spec-mutation coverage security money
Exit: 0=PASS  2=FAIL  3=FLAG  4=INFRA  1=error
```

## See also

- [PLAN-v6.md](C:\Users\chris\OneDrive\Desktop\Claude\audits\2026-05-22-qa-engine\PLAN-v6.md): canonical design + the three invariants
- [qa-pro skill](C:\Users\chris\.claude\skills\qa-pro\) v1.1.0: predecessor web-only gate; fqe orchestrates it as the web runner
- [qa-gate](C:\Users\chris\.claude\skills\finexio-skills\qa-gate\): Stop-hook enforcement that fqe receipts satisfy
- Gauntlet runs: `~/Downloads/gauntlet_runs/gauntlet_125a6e.md` (final SHIP)
- Smoke-test repo: https://github.com/booyajones/fqe-smoke-test
