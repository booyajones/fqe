# fqe

**A CI gate that runs the checks you already have, refuses to let humans skip them, and emits a tamper-evident receipt of what was checked.**

[![tests](https://img.shields.io/badge/tests-839%20passing-brightgreen)](cli/test/) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![status](https://img.shields.io/badge/status-v0.18.19-blue)](CHANGELOG.md)

fqe is an orchestrator. It does not lint, test, or judge. It runs the runners you configure, reads their exit codes, and computes one deterministic verdict in about 500 lines of pure JavaScript with no dependencies. You can read it, run it locally, and audit it.

It also emits a tamper-evident receipt and uses a server-authoritative bypass mechanism, so the gate cannot be skipped silently.

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.18.19 fqe init
git add .fqe.yml .github/
git commit -m "Add fqe quality gate"
```

That's the install. The gate is now live on every PR. To make it actually block merges, add `fqe/pass` to your branch protection's required checks (one click).

> **Before adopting on production-critical repos, read [Known limitations](#known-limitations-read-this-before-adopting-on-a-critical-path) below.** The install command above pins to a git tag, which is force-pushable. For production, use the SHA-pinned install in [docs/getting-started.md](docs/getting-started.md#production-install-sha-pinned).

## The problem

The shipping engineer looks at the work. They say "yes, ship." Six hours later production breaks because the check that would have caught the bug was never run.

- A financial model ships with three Sev 1 bugs under a green Validation tab.
- A partner integration ships with four CRITICAL defects.
- A web page ships with the FAQ schema rendered as visible body text instead of in `<head>`.

In all three cases, a machine check would have caught it in under five seconds. In all three cases, no machine check was wired to the merge.

fqe makes those checks unskippable.

## How it works

```
                  PR opened
                       │
                       ▼
              fqe workflow fires
                       │
              ┌────────┴────────┐
              │ Bypass comment? │  ← /fqe-bypass <sha>, identity from
              │ (server-side)   │     the comments API, not a file
              └────────┬────────┘
                       │
       ┌───────────────┼───────────────────┐
       │   bypass      │   normal          │
       │     ↓         │   ↓               │
       │   receipt     │   run configured  │
       │   + tally     │   runners         │
       │               │   ↓               │
       │               │   verdict.js      │  ← no LLM in path
       │               │   (deterministic) │     pure JS, ~500 LOC
       └───────────────┴───────────────────┘
                       │
                       ▼
              QA-RESULT.yml + .md
              (artifact + Check Run)
                       │
                       ▼
              fqe/pass status published
              (required check; cannot merge without)
```

Three architectural invariants the design holds to:

1. **No identity claim is read from a file the PR author wrote.** Bypass identity comes from the server-recorded comment author (the comments API), never a PR-branch file.
2. **No LLM decides the verdict.** `verdict.js` is a deterministic Node script with table-driven unit tests. Claude reviews PRs and can write tests, but those advise and author around the gate, they never compute PASS/FAIL.
3. **No required state lives only in the PR branch.** Receipts persist as workflow artifacts plus Check Run outputs (server-side, immutable per run).

If you need to verify any of these, read [docs/architecture.md](docs/architecture.md). If you'd rather skip the theory and start using it, jump to [Getting Started](docs/getting-started.md).

## What you get

- **A required GitHub Check Run** (`fqe/pass`) you can wire to branch protection.
- **Plain-English failure explanations** in the Check Run output. Every failure includes the repro command.
- **A tamper-evident receipt** (`QA-RESULT.yml`) bound to the commit SHA, uploaded as an artifact and posted to the Check Run.
- **A SHA-bound, self-auditing bypass.** Bypass is a PR comment, `/fqe-bypass <head-sha> <24h|48h|72h>`, by an allowlisted maintainer. The named SHA must equal the live head, so any new push invalidates it (no bypassing a clean commit then pushing bad code), it expires on a TTL, and every bypass is logged. If the rolling 14-day rate exceeds 10%, a second `fqe/second-reviewer-required` check goes red until a different allowlisted reviewer signs off.
- **Statistical guard rails on adversarial stats.** When a runner emits Wilson-CI confidence bounds (for LLM eval-style runners), fqe enforces the right threshold for the blast radius class.
- **An answer-key guard.** `fqe oracle-guard` requires a second reviewer when a PR edits the golden masters, cassettes, coverage baseline, or `.fqe.yml` it is judged by, so a PR cannot pass by moving the goalposts.
- **Fail-closed config validation.** `fqe validate` (and `fqe run`) reject a malformed `.fqe.yml` instead of silently skipping the misconfigured check.
- **Full-suite QA, not just a test gate.** Tag each runner with a `class` (unit, integration, e2e, regression, contract, property, uat, money, ...) and set a `policy`. A required class with no passing runner is a FAIL, and `require_for` makes money paths demand their strict classes automatically. `fqe uat` gates on acceptance criteria, `fqe golden` is a drift-catching regression engine, and `fqe qa-report` rolls a run up into one per-class scorecard. See [docs/recipes/test-taxonomy.md](docs/recipes/test-taxonomy.md).
- **Recipes** for the repo types we built this for (Node web, Python API, financial model, MCP server, outbound comms) plus the payments QA set: property-based, partner-contract, golden-master, oracle-tamper, and flaky quarantine.

## Where the LLM is, and is not

fqe uses Claude in two places, both **around** the gate: it reviews every PR (advisory comments) and it can write tests for you (the optional auto-author, gated by the mutation bouncer). What it never does is let an LLM **decide the merge**.

- **No LLM decides PASS/FAIL.** The verdict is `verdict.js`, about 500 lines of pure deterministic code, no AI, no dependencies. This is the point: a merge gate must be deterministic (same PR, same answer), auditable (you can show exactly what blocked it), and immune to prompt injection (a PR cannot talk its way to green). Claude advises and authors; the gate decides.
- **It does not run your runners.** You configure runners (your tests, linters, dependency audits). fqe orchestrates them and reads their exit codes. It does not bring its own test/lint/audit tools.
- **It does not punish bypass.** It audits bypass. If your team is consistently bypassing, the gate is wrong, not your team.
- **It does not replace your CI.** It runs alongside your existing workflows as an additional required check.

## Docs

| Doc | For |
|---|---|
| [Adopting fqe (runbook)](docs/adopt.md) | The small-team playbook: the 3 layers, 10-minute turn-on, when to enforce. Start here. |
| [Why fqe and not off-the-shelf?](docs/build-vs-buy.md) | The honest build-vs-buy answer: what to buy (Codecov, Stryker, Sigstore, branch protection) and the one narrow job fqe owns. |
| [Getting Started](docs/getting-started.md) | First-time setup. 5 minutes to a gated PR. |
| [Writing a Runner](docs/writing-a-runner.md) | The contract every runner must satisfy. |
| [Architecture](docs/architecture.md) | The three invariants, the verdict logic, why it's deterministic. |
| [Troubleshooting](docs/troubleshooting.md) | Exact error to exact fix. |
| [FAQ](docs/faq.md) | Pre-empts the 10 questions every engineer asks. |
| [Security](SECURITY.md) | Threat model. What fqe protects against and what it does not. |
| [Contributing](CONTRIBUTING.md) | PR process and ground rules. |
| [Changelog](CHANGELOG.md) | What shipped in each release (0.1.0 to 0.18.2). |

## Recipes

Copy-paste a `.fqe.yml` for your stack:

| Stack | Recipe |
|---|---|
| Next.js / React / Vue / Svelte | [docs/recipes/node-web.md](docs/recipes/node-web.md) |
| FastAPI / Flask / Django | [docs/recipes/python-api.md](docs/recipes/python-api.md) |
| Excel financial model (xlsx + goldens) | [docs/recipes/financial-model.md](docs/recipes/financial-model.md) |
| Model Context Protocol server | [docs/recipes/mcp-server.md](docs/recipes/mcp-server.md) |
| Outbound communications (cold email, nurture) | [docs/recipes/outbound-comms.md](docs/recipes/outbound-comms.md) |

Payments QA techniques (the bet-the-company tests):

| Technique | Recipe |
|---|---|
| Property-based money invariants | [docs/recipes/property-based-testing.md](docs/recipes/property-based-testing.md) |
| Partner-API contract / record-replay | [docs/recipes/partner-contract.md](docs/recipes/partner-contract.md) |
| Golden-master (NACHA / CSV / PDF) | [docs/recipes/golden-master.md](docs/recipes/golden-master.md) |
| Oracle-tamper guard (second reviewer) | [docs/recipes/oracle-tamper.md](docs/recipes/oracle-tamper.md) |
| Coverage ratchet | [docs/recipes/coverage-ratchet.md](docs/recipes/coverage-ratchet.md) |
| AI test generation (mutation-gated) | [docs/recipes/ai-test-generation.md](docs/recipes/ai-test-generation.md) |
| Flaky-test quarantine | [docs/recipes/flaky-quarantine.md](docs/recipes/flaky-quarantine.md) |
| Gate an existing Playwright suite | [docs/recipes/playwright.md](docs/recipes/playwright.md) |
| Run the gate on CircleCI | [docs/recipes/circleci.md](docs/recipes/circleci.md) |
| Test classes and the full-suite policy | [docs/recipes/test-taxonomy.md](docs/recipes/test-taxonomy.md) |
| User-acceptance testing as a gate | [docs/recipes/uat.md](docs/recipes/uat.md) |
| Regression testing with golden masters | [docs/recipes/regression-golden.md](docs/recipes/regression-golden.md) |

## Local development loop

```bash
# Same verdict CI computes, run on your laptop:
fqe run --base origin/main --output ./out/

# See what fqe will check on the current diff:
fqe explain

# Validate .fqe.yml before it can silently disable a check (fail closed on typos):
fqe validate

# Check whether a PR edits its own ground truth / grading rules:
fqe oracle-guard --base origin/main --head HEAD
```

The local CLI emits the same `QA-RESULT.yml` and `QA-RESULT.md` that CI produces. Same verdict math. Same plain-English explainer. Iterate locally, push when green.

## Verdict logic

fqe reads exit codes and emits one of five outcomes:

| Code | Meaning | Effect |
|---|---|---|
| 0 | PASS: all runners clean | Merge allowed |
| 1 | ERROR: fqe itself crashed | Re-run, file issue if persists |
| 2 | FAIL: a required runner exited non-zero | Merge blocked |
| 3 | FLAG: adversarial CI bound exceeded | Informational only, does not block |
| 4 | INFRA: transient (GitHub API timeout, missing binary) | Neutral Check Run, does not block |

You can read the full taxonomy in [`cli/lib/verdict.js`](cli/lib/verdict.js). It's about 500 lines, a large share of them comments recording why each check exists and which review caught the gap it closes.

## Statistical guard rails

For runners that produce statistical output (LLM evals, adversarial probes), fqe uses Wilson 95% confidence intervals to bound the observed failure rate. Per blast-radius class:

| Class | Threshold | Examples |
|---|---|---|
| `outbound` | 5% upper bound | Cold email, marketing copy |
| `mcp-read` | 3% upper bound | Read-only MCP servers |
| `mcp-write-or-financial` | 1% upper bound | MCP servers that mutate state, financial models |

Wilson over normal approximation because it stays well-defined at p=0 and p=1. See [the FAQ entry](docs/faq.md#why-wilson-confidence-intervals-specifically) for the full citation and how the implementation is pinned against `statsmodels.stats.proportion.proportion_confint`.

## Status

**v0.18.19.** 839 tests passing on Linux and Windows across Node 20 and 22 (one symlink test self-skips on a Windows box without developer mode, since it cannot create the symlink), CI green on every push, and the gate self-hosts (fqe runs its own spec-mutation, requirement-trace, and reconcile checks on itself). The repo is open source under MIT. Public source: github.com/booyajones/fqe.

**Proven cold on real third-party code, not just demos.** fqe is plugged into a fork of [more-itertools](https://github.com/more-itertools/more-itertools) (Python, ~720 tests) and [semver](https://github.com/dtolnay/semver) (Rust) and runs their own untouched suites through the gate on real GitHub Actions, with a planted mis-scoped run proven to turn the gate red. Three stacks proven (TypeScript, Python, Rust).

What each release added: coverage-liveness (v0.9.0, no green over an empty/mis-scoped suite), inter-suite discovery + flaky/quarantine + human-review telemetry (v0.10.0), a mandatory money-idempotency invariant (v0.11.0), contract baseline from an OpenAPI spec (v0.12.0), an advisory-first mutation-on-diff judge (v0.13.0), adversarial-stat integrity hardening (v0.14.0), the money-strict profile and foot-gun caps (v0.15.0), receipt signing (v0.16.0), a full-codebase adversary sweep (v0.17.0), the shadow-trial scorecard (v0.18.0), and doc-accuracy guards (v0.18.2). See the [Changelog](CHANGELOG.md).

## Known limitations (read this before adopting on a critical path)

These are the honest gaps as of 0.18.2. The architectural invariants are real and the earlier bypass/retention limitations are now fixed (head-SHA-bound TTL bypass in 0.4.0, allowlist read at default-branch HEAD and 365-day receipt retention in 0.6.0).

1. **Proven on third-party OSS and earlier on an internal repo, not yet on a live production service.** The cold-plug proofs run on real third-party repos and the gate caught real bugs on an internal TypeScript service earlier, but the v0.9.0+ capabilities have not yet run against a live production money path. That proof needs a sandbox environment.

2. **The mutation judge ships ADVISORY by default.** Surviving mutants are a FLAG, not a block, on purpose, so it never sprays false reds before you have measured the false-red rate on your own repo. Ratchet it to `blocking` once that rate is near zero. Its real CI-time and false-positive rate on a given repo are an operational measurement, not a published number.

3. **The receipt is content-hashed and signable.** It is tamper-evident (any edit changes the hash) and, as of v0.16.0, can be cryptographically signed: `fqe receipt sign` / `fqe receipt verify` (HMAC-SHA256 over the commit + content-hash + inputs + verdict + bypass tuple, fail-closed on tamper). Sigstore keyless signing (OIDC, non-repudiable) is documented as a CI recipe in [docs/recipes/receipt-signing.md](docs/recipes/receipt-signing.md). The HMAC signing key must be kept out of untrusted runner subprocesses (fqe strips it from the runner env).

4. **The default install pins a git tag, which is force-pushable.** For production, pin to a commit SHA. See [docs/getting-started.md](docs/getting-started.md#production-install-sha-pinned).

5. **The runtime layer (synthetic canaries, shadow replay) ships as recipes, not running code.** Wiring it needs a sandbox endpoint and credentials.

**Planned next** (receipt signing shipped in v0.16.0 and is no longer on this list):

- The runtime/canary layer, once a sandbox endpoint and credentials exist.
- Ratcheting the mutation gate to blocking, after the false-red rate is measured on a real repo.
- Sigstore keyless signing as the default rather than a documented recipe.
- More recipes (Go, monorepo).

## Compared to alternatives

| | fqe | husky / lefthook | danger.js | a custom workflow |
|---|---|---|---|---|
| Runs server-side | Yes | No (local-only) | Yes | Yes |
| Deterministic verdict | Yes (~500 LOC, readable) | N/A | No (opinionated) | Depends on your code |
| Tamper-evident receipt | Yes (SHA-bound) | No | No | Depends |
| Server-authoritative bypass | Yes (Events API) | No | No | No (file-based) |
| Statistical bounds on AI evals | Yes (Wilson CI) | No | No | No |
| LLM in the verdict path | No | N/A | No | Depends |

fqe and husky are complementary. Use husky for fast local checks before push. Use fqe for the hard gates that absolutely cannot reach `main`.

## Uninstall

```bash
rm .fqe.yml
rm -r .github/workflows/fqe-quality.yml .github/workflows/fqe-second-approve.yml
rm .github/fqe-bypass-allowlist.yml .github/fqe-second-reviewers.yml
rm -r .github/fqe-state/
```

Then remove `fqe/pass` from your branch protection's required checks. Gate stops firing immediately.

## Who built this

Chris Wyatt (@booyajones), Finexio's CSO/CPO. The artifact is the audit trail.

## License

MIT. See [LICENSE](LICENSE).

## Security

Security reports to `chris.wyatt@finexio.com` with subject `[fqe-security]`. See [SECURITY.md](SECURITY.md) for the threat model.
