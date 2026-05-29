# Security

## Reporting a vulnerability

Email **chris.wyatt@finexio.com** with subject `[fqe-security]`. Encrypt with PGP if the issue is sensitive (key on request). We acknowledge within 24 hours, triage within 72.

Do **not** open public issues for vulnerabilities. Don't tweet about them. Don't post in Slack channels with non-employees.

## Threat model

fqe is a CI gate. It runs inside GitHub Actions with a `GITHUB_TOKEN` and (when bypass is requested) reads PR-level metadata. The threat model has three core actors.

### Actor 1: Untrusted PR author (fork or untrusted contributor)

**Goal:** bypass the gate to merge bad code, escalate to repo write.

**Mitigation:** identity is read ONLY from a server-recorded GitHub source (the comment author via the comments API). Bypass requires a SHA-bound `/fqe-bypass <head-sha> <ttl>` comment from an allowlisted maintainer. PR-branch files (commit messages, PR body, receipt content) are never trusted for identity decisions.

### Actor 2: Compromised dependency in the runner toolchain

**Goal:** inject arbitrary code into the gate's runtime via Node, yq, gh CLI, LibreOffice, etc.

**Mitigation:** every binary download verifies a SHA256 pin. The `fqe-v0.6.0` tag in `booyajones/fqe` is the only thing workflows clone, and the workflow uses `git clone --branch fqe-v0.6.0` (not HEAD).

### Actor 3: Compromised maintainer or stolen GitHub token

**Goal:** push a malicious patch under the `fqe-v0.6.0` tag and have it executed automatically by every gated repo.

**Mitigation:** tags can be force-moved, which is the supply-chain risk here. Defences: (1) signed commits on the public repo, (2) branch protection on `main` requiring review, (3) the workflow can be re-pinned to a SHA instead of a tag for higher assurance (`--branch fqe-v0.6.0` becomes `--branch <40-char SHA>`).

## Architectural invariants

Three commitments the codebase enforces. If you find code that violates one, that's a critical bug. Report it.

1. **No identity claim is read from a file the constrained actor wrote.** Bypass requester identity comes from the server-recorded comment author (`gh api /repos/{owner}/{repo}/issues/{pr}/comments`, `user.login`). Receipt content is informational only. `bypass.requester_source` MUST be a server-recorded source (`github_comments_api_v3`, or the legacy `github_events_api_v3`) or `buildReceipt` throws.
2. **No LLM is in the verdict path.** `cli/lib/verdict.js` is a pure deterministic Node function. Same inputs produce the same output. 261 tests cover the failure paths (Claude reviews and can author tests, but never computes the verdict). No language model is ever asked "is this PR good?"
3. **No required state lives only in the PR branch.** Receipts persist as workflow artifacts AND Check Run outputs (server-side, immutable per run). In 0.1.0, GitHub workflow artifacts default to 90-day retention (configurable down, not up without an Enterprise plan). Check Run outputs are limited to ~65KB but persist with the commit indefinitely. **For SOX-grade 7-year retention, mirror the receipt to an external object store via a post-merge `workflow_run` job.** The 0.2 release ships an opt-in `audits/<sha>/` archiver that commits the receipt to the protected branch automatically.

## Supply chain

- **fqe-v0.6.0 tag** is the only pinned reference workflows use. To pin tighter, replace the tag with a 40-char SHA in `.github/workflows/fqe-quality.yml`.
- **Node, yq, gh CLI**: SHA256-pinned in the workflow's install step. Failed verification means the workflow fails closed.
- **LibreOffice**: installed from the Ubuntu apt repository inside the GitHub-hosted runner (no third-party mirror).
- **No `curl | bash`**. All downloads are checksum-verified.
- **No telemetry**. fqe does not phone home. The only network calls are to the GitHub API for Check Run publishing and event reading.

## Known issues in 0.1.0 (acknowledged, prioritized for 0.2)

Surfaced during adversarial design review and corroborated by Finexio's internal threat modeling. These five issues were flagged unanimously by independent reviewers. They are real. They are documented here, prioritized for 0.2, and they have interim mitigations:

| # | Issue | Today's mitigation | 0.2 fix |
|---|---|---|---|
| 1 | Default install pins to a force-pushable git tag | See `docs/getting-started.md#production-install-sha-pinned`. Pin to a SHA. | Docker image pinned by digest, default install path. |
| 2 | Bypass was an unbounded label, not bound to the head SHA | **FIXED in 0.4.0.** | Bypass is now a SHA-bound, TTL'd PR comment: `/fqe-bypass <40-hex-head-sha> <24h/48h/72h>`. Identity and time come from the comments API (server-recorded), SHA equality is the binding (any new push changes `head.sha` and the bypass evaporates), edited comments are rejected, and it fails closed. See `cli/lib/bypass_guard.js`. |
| 3 | Allowlist could be read at a stale ref (offboarding hole) | **FIXED in 0.6.0.** | The workflow reads the allowlist at the live default-branch HEAD (`gh api repos/{repo} .default_branch`, then `contents?ref=<default>`), so removing someone takes effect immediately, even on in-flight PRs branched from an old commit. |
| 4 | Workflow artifacts (receipts) expired at 90 days, under the SOC2/PCI 1-year minimum | **Mitigated in 0.6.0.** | Receipt artifact retention raised to 365 days (`retention-days: 365`); the repo's max-retention setting must allow it. Check Run output also persists with the commit. For 7-year SOX, mirror receipts to object storage via a post-merge job. |
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
3. **Pin `fqe-v0.6.0` to a SHA** in your workflow (look up via `git rev-parse fqe-v0.6.0`).
4. **Restrict who is on `.github/fqe-bypass-allowlist.yml`.** The workflow reads it at the default-branch HEAD, so a PR cannot add itself and a removal takes effect immediately on in-flight PRs.
5. **Enable Dependabot** on your gated repo for the GitHub Actions used in `fqe-quality.yml`.
6. **Audit `.github/fqe-state/bypass-tally.jsonl`** weekly. Rolling rate above 10% triggers the second-reviewer requirement automatically.

## Disclosure history

None yet. This is v0.1.0.
