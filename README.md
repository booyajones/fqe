# fqe

**A CI gate that runs the checks you already have, refuses to let humans skip them, and emits a tamper-evident receipt of what was checked.**

[![tests](https://img.shields.io/badge/tests-162%20passing-brightgreen)](cli/test/) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![status](https://img.shields.io/badge/status-v0.1.0%20stable-blue)](CHANGELOG.md)

fqe is an orchestrator. It does not lint, test, or judge. It runs the runners you configure, reads their exit codes, and computes one deterministic verdict in 160 lines of pure JavaScript with no dependencies. You can read it, run it locally, and audit it.

It also emits a tamper-evident receipt and uses a server-authoritative bypass mechanism, so the gate cannot be skipped silently.

```bash
npx --yes github:booyajones/fqe#fqe-v0.1.0 cli/bin/fqe.js init
git add .fqe.yml .github/
git commit -m "Add fqe quality gate"
```

That's the install. The gate is now live on every PR. To make it actually block merges, add `fqe/pass` to your branch protection's required checks (one click).

> **Before adopting on production-critical repos, read [Known limitations in 0.1.0](#known-limitations-in-010-read-this-before-adopting) below.** The install command above pins to a git tag, which is force-pushable. For production, use the SHA-pinned install in [docs/getting-started.md](docs/getting-started.md#production-install-sha-pinned).

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
              │ Bypass label?   │  ← identity from GitHub Events API
              │ (server-side)   │     not from any file
              └────────┬────────┘
                       │
       ┌───────────────┼───────────────────┐
       │   bypass      │   normal          │
       │     ↓         │   ↓               │
       │   receipt     │   run configured  │
       │   + tally     │   runners         │
       │               │   ↓               │
       │               │   verdict.js      │  ← no LLM in path
       │               │   (deterministic) │     pure JS, 160 LOC
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

1. **No identity claim is read from a file the PR author wrote.** Bypass-requester identity comes from the GitHub Events API.
2. **No LLM is in the verdict path.** `verdict.js` is a deterministic Node script with table-driven unit tests.
3. **No required state lives only in the PR branch.** Receipts persist as workflow artifacts plus Check Run outputs (server-side, immutable per run).

If you need to verify any of these, read [docs/architecture.md](docs/architecture.md). If you'd rather skip the theory and start using it, jump to [Getting Started](docs/getting-started.md).

## What you get

- **A required GitHub Check Run** (`fqe/pass`) you can wire to branch protection.
- **Plain-English failure explanations** in the Check Run output. Every failure includes the repro command.
- **A tamper-evident receipt** (`QA-RESULT.yml`) bound to the commit SHA, uploaded as an artifact and posted to the Check Run.
- **A bypass mechanism that audits itself.** Every bypass is logged. If the rolling 14-day rate exceeds 10%, a second `fqe/second-reviewer-required` check goes red until a different allowlisted reviewer signs off.
- **Statistical guard rails on adversarial stats.** When a runner emits Wilson-CI confidence bounds (for LLM eval-style runners), fqe enforces the right threshold for the blast radius class.
- **Recipes** for the five repo types we built this for: Node web, Python API, financial model (xlsx), MCP server, outbound communications.

## What it deliberately does not do

- It does not run runners. **You configure runners.** fqe is the orchestrator.
- It does not write tests for you, lint your code, or audit your dependencies. **Your existing tools do those.** fqe reads their exit codes.
- It does not have an LLM in the verdict path. The verdict is `verdict.js`, 160 lines, no AI, no dependencies.
- It does not punish bypass. It audits bypass. If your team is consistently bypassing, the gate is wrong, not your team.
- It does not replace your existing CI workflows. It runs alongside them as an additional required check.

## Docs

| Doc | For |
|---|---|
| [Getting Started](docs/getting-started.md) | First-time setup. 5 minutes to a gated PR. |
| [Writing a Runner](docs/writing-a-runner.md) | The contract every runner must satisfy. |
| [Architecture](docs/architecture.md) | The three invariants, the verdict logic, why it's deterministic. |
| [Troubleshooting](docs/troubleshooting.md) | Exact error to exact fix. |
| [FAQ](docs/faq.md) | Pre-empts the 10 questions every engineer asks. |
| [Security](SECURITY.md) | Threat model. What fqe protects against and what it does not. |
| [Contributing](CONTRIBUTING.md) | PR process and ground rules. |
| [Changelog](CHANGELOG.md) | What shipped in 0.1.0 and what's planned for 0.2. |

## Recipes (copy-paste a `.fqe.yml` for your stack)

| Stack | Recipe |
|---|---|
| Next.js / React / Vue / Svelte | [docs/recipes/node-web.md](docs/recipes/node-web.md) |
| FastAPI / Flask / Django | [docs/recipes/python-api.md](docs/recipes/python-api.md) |
| Excel financial model (xlsx + goldens) | [docs/recipes/financial-model.md](docs/recipes/financial-model.md) |
| Model Context Protocol server | [docs/recipes/mcp-server.md](docs/recipes/mcp-server.md) |
| Outbound communications (cold email, nurture) | [docs/recipes/outbound-comms.md](docs/recipes/outbound-comms.md) |

## Local development loop

```bash
# Same verdict CI computes, run on your laptop:
fqe run --full --base origin/main --output ./out/

# See what fqe will check on the current diff:
fqe explain

# Validate a hand-edited .fqe.yml:
fqe verdict --check ./out/QA-RESULT.yml
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

You can read the full taxonomy in [`cli/lib/verdict.js`](cli/lib/verdict.js). It's 160 lines.

## Statistical guard rails

For runners that produce statistical output (LLM evals, adversarial probes), fqe uses Wilson 95% confidence intervals to bound the observed failure rate. Per blast-radius class:

| Class | Threshold | Examples |
|---|---|---|
| `outbound` | 5% upper bound | Cold email, marketing copy |
| `mcp-read` | 3% upper bound | Read-only MCP servers |
| `mcp-write-or-financial` | 1% upper bound | MCP servers that mutate state, financial models |

Wilson over normal approximation because it stays well-defined at p=0 and p=1. See [docs/faq.md#wilson](docs/faq.md) for the full citation and how the implementation is pinned against `statsmodels.stats.proportion.proportion_confint`.

## Status

**v0.1.0 stable.** 162 tests passing. Validated against three production Finexio repos plus the [vinci1it2000/formulas](https://github.com/vinci1it2000/formulas) test corpus (13,383-formula xlsx). The repo is open source under MIT. Public source: github.com/booyajones/fqe.

## Known limitations in 0.1.0 (read this before adopting)

The architectural invariants are real. The implementation does not yet enforce all of them on the hard threats. If you are putting fqe on the critical path of a production repo, you need to know these:

1. **Default install uses a tag, not a SHA.** Git tags are force-pushable, so a maintainer-account compromise can silently change what `fqe-v0.1.0` resolves to. The README install command is tag-pinned for ergonomic onboarding. **For production: pin to a commit SHA.** See [docs/getting-started.md](docs/getting-started.md#production-install-sha-pinned). The `ghcr.io/finexio/fqe:0.1` Docker image planned for 0.2 will be pinned by digest.

2. **Bypass labels are not bound to the head SHA.** Once an allowlisted user adds `fqe-bypass`, the label persists across subsequent pushes to that PR. If the allowlisted account is compromised mid-PR, the attacker can push malicious commits without re-triggering the gate. **Mitigation today: branch protection rule "Dismiss stale pull request approvals when new commits are pushed" combined with a no-push-after-bypass team norm.** TTL-bound labels with head-SHA binding are the 0.2 fix.

3. **Allowlist is read at the PR's BASE commit, not at `refs/heads/main` HEAD.** This means a long-lived PR branch that diverged before someone was removed from the allowlist still treats that person as allowlisted. **Mitigation today: short-lived PRs and pruning the allowlist on departure.** The 0.2 fix is to fetch the allowlist from the default branch at workflow-run time.

4. **Receipt durability is bounded by GitHub artifact retention (90 days default).** The Check Run output text persists with the commit indefinitely but is limited to ~65KB and not exportable in bulk. **For SOX-grade (7-year) retention: mirror receipts to an external object store via a post-merge workflow.** See [docs/recipes/](docs/recipes/) for the pattern, or wait for 0.2 which ships an opt-in `audits/<sha>/` post-merge archiver.

5. **The rolling bypass tally writes JSONL to the protected branch from a workflow.** Fork PRs (read-only `GITHUB_TOKEN`) cannot bypass at all, which is intentional. First-party PRs that bypass record to `.github/fqe-state/bypass-tally.jsonl` via a `workflow_run` event after merge, not from the PR's own workflow. **Concurrency:** if two bypasses are recorded inside the same second, the second one rebases on top. Stress-tested up to ~5 concurrent merges. **For higher concurrency:** move state to an external KV in 0.2.

These are documented because they are real. If they are deal-breakers for your repo, do not enable `fqe/pass` as a required check until 0.2.

**Planned for 0.2:**

- Docker image (`ghcr.io/finexio/fqe:0.1`) pinned by digest, default install path
- TTL-bound bypass labels (`fqe-bypass-24h`, `-48h`, `-72h`) with head-SHA binding
- Allowlist read from `refs/heads/main` at workflow-run time
- Optional post-merge `audits/<sha>/` archiver for durable receipt retention
- External KV state backend for bypass tally
- `fqe doctor` subcommand to diagnose environment issues
- More recipes (Go, Rust, monorepo)

## Compared to alternatives

| | fqe | husky / lefthook | danger.js | a custom workflow |
|---|---|---|---|---|
| Runs server-side | Yes | No (local-only) | Yes | Yes |
| Deterministic verdict | Yes (160 LOC, readable) | N/A | No (opinionated) | Depends on your code |
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
