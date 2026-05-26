# Security

## Reporting a vulnerability

Email **chris.wyatt@finexio.com** with subject `[fqe-security]`. Encrypt with PGP if the issue is sensitive (key on request). We acknowledge within 24 hours, triage within 72.

Do **not** open public issues for vulnerabilities. Don't tweet about them. Don't post in Slack channels with non-employees.

## Threat model

fqe is a CI gate. It runs inside GitHub Actions with a `GITHUB_TOKEN` and (when bypass is requested) reads PR-level metadata. The threat model has three core actors.

### Actor 1: Untrusted PR author (fork or untrusted contributor)

**Goal:** bypass the gate to merge bad code, escalate to repo write.

**Mitigation:** identity is read ONLY from the GitHub Events API (server-recorded). Bypass requires a label that's restricted by repo permissions. PR-branch files (commit messages, PR body, receipt content) are never trusted for identity decisions.

### Actor 2: Compromised dependency in the runner toolchain

**Goal:** inject arbitrary code into the gate's runtime via Node, yq, gh CLI, LibreOffice, etc.

**Mitigation:** every binary download verifies a SHA256 pin. The `fqe-v0.1.0` tag in `booyajones/fqe` is the only thing workflows clone, and the workflow uses `git clone --branch fqe-v0.1.0` (not HEAD).

### Actor 3: Compromised maintainer or stolen GitHub token

**Goal:** push a malicious patch under the `fqe-v0.1.0` tag and have it executed automatically by every gated repo.

**Mitigation:** tags can be force-moved, which is the supply-chain risk here. Defences: (1) signed commits on the public repo, (2) branch protection on `main` requiring review, (3) the workflow can be re-pinned to a SHA instead of a tag for higher assurance (`--branch fqe-v0.1.0` becomes `--branch <40-char SHA>`).

## Architectural invariants

Three commitments the codebase enforces. If you find code that violates one, that's a critical bug. Report it.

1. **No identity claim is read from a file the constrained actor wrote.** Bypass requester identity comes from `gh api /repos/{owner}/{repo}/issues/{pr}/events` (server-recorded `actor.login`). Receipt content is informational only. `bypass.requester_source` MUST equal `github_events_api_v3` or `buildReceipt` throws.
2. **No LLM is in the verdict path.** `cli/lib/verdict.js` is a pure deterministic Node function. Same inputs produce the same output. 162 unit + integration tests cover the failure paths. No language model is ever asked "is this PR good?"
3. **No required state lives only in the PR branch.** Receipts persist as workflow artifacts AND Check Run outputs (server-side, immutable per run). In 0.1.0, GitHub workflow artifacts default to 90-day retention (configurable down, not up without an Enterprise plan). Check Run outputs are limited to ~65KB but persist with the commit indefinitely. **For SOX-grade 7-year retention, mirror the receipt to an external object store via a post-merge `workflow_run` job.** The 0.2 release ships an opt-in `audits/<sha>/` archiver that commits the receipt to the protected branch automatically.

## Supply chain

- **fqe-v0.1.0 tag** is the only pinned reference workflows use. To pin tighter, replace the tag with a 40-char SHA in `.github/workflows/fqe-quality.yml`.
- **Node, yq, gh CLI**: SHA256-pinned in the workflow's install step. Failed verification means the workflow fails closed.
- **LibreOffice**: installed from the Ubuntu apt repository inside the GitHub-hosted runner (no third-party mirror).
- **No `curl | bash`**. All downloads are checksum-verified.
- **No telemetry**. fqe does not phone home. The only network calls are to the GitHub API for Check Run publishing and event reading.

## Known issues in 0.1.0 (acknowledged, prioritized for 0.2)

Reviewed by three independent LLM judges plus a Gemini chairman. These five issues were flagged unanimously. They are real. They are documented here, prioritized for 0.2, and they have interim mitigations:

| # | Issue | Today's mitigation | 0.2 fix |
|---|---|---|---|
| 1 | Default install pins to a force-pushable git tag | See `docs/getting-started.md#production-install-sha-pinned`. Pin to a SHA. | Docker image pinned by digest, default install path. |
| 2 | `fqe-bypass` label is not bound to the head SHA | Branch protection rule "Dismiss stale PR approvals on push" + team norm "no push after bypass." | TTL-bound bypass labels with explicit head-SHA binding (`fqe-bypass-24h`, `-48h`, `-72h`). |
| 3 | Allowlist is read at PR BASE commit, not at default-branch HEAD | Short-lived PRs (under one week) + prune the allowlist immediately on departure. | Workflow fetches allowlist from `refs/heads/main` at run time. |
| 4 | Workflow artifacts (receipts) expire at 90 days by default | Mirror receipts to an external object store via post-merge `workflow_run`. Check Run output (~65KB cap, indefinite persistence) is still bound to the commit. | Opt-in post-merge `audits/<sha>/` archiver, commits the receipt to the protected branch. |
| 5 | Bypass-tally JSONL writes to the protected branch from the workflow | The tally is updated by a `workflow_run` event AFTER merge, not from the PR's own workflow. Fork PRs have read-only `GITHUB_TOKEN` and cannot bypass. Concurrency stress-tested up to ~5 concurrent merges. | External KV state backend (SQLite cache + signed JSONL fallback). |

If any of these is a deal-breaker for your repo, **do not enable `fqe/pass` as a required check until 0.2 ships.** Run it as informational only and tighten as the fixes land.

## What fqe does NOT protect against

- **A malicious runner in your `.fqe.yml`.** If you configure a runner that runs arbitrary code (which is the point), fqe runs it. Treat `.fqe.yml` as code that requires code review.
- **GitHub itself being compromised.** Identity flows through the GitHub API. If GitHub is breached, so is fqe.
- **A maintainer with repo-write access deciding to bypass.** Bypass is auditable (logged in `bypass-tally.jsonl`, posted as a Check Run output, archived in `audits/<sha>/`). It is not preventable.
- **Logic bugs in your own runners.** fqe's verdict is deterministic on what the runners report. If a runner falsely says PASS, fqe says PASS.

## Hardening above defaults

For Finexio production repos:

1. **Required status checks** on the protected branch: `fqe/pass` and `fqe/second-reviewer-required`.
2. **Enforce admins** ON in branch protection. No admin-merge override.
3. **Pin `fqe-v0.1.0` to a SHA** in your workflow (look up via `git rev-parse fqe-v0.1.0`).
4. **Restrict `fqe/bypass-*` label addition** to specific users via `.github/fqe-bypass-allowlist.yml`. The workflow checks this list at the BASE commit so a PR cannot add itself.
5. **Enable Dependabot** on your gated repo for the GitHub Actions used in `fqe-quality.yml`.
6. **Audit `.github/fqe-state/bypass-tally.jsonl`** weekly. Rolling rate above 10% triggers the second-reviewer requirement automatically.

## Disclosure history

None yet. This is v0.1.0.
