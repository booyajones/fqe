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
3. **No required state lives only in the PR branch.** Receipts persist as workflow artifacts AND Check Run outputs (server-side, immutable per run). Post-merge, receipts get committed to `audits/<sha>/` on the protected branch for human audit.

## Supply chain

- **fqe-v0.1.0 tag** is the only pinned reference workflows use. To pin tighter, replace the tag with a 40-char SHA in `.github/workflows/fqe-quality.yml`.
- **Node, yq, gh CLI**: SHA256-pinned in the workflow's install step. Failed verification means the workflow fails closed.
- **LibreOffice**: installed from the Ubuntu apt repository inside the GitHub-hosted runner (no third-party mirror).
- **No `curl | bash`**. All downloads are checksum-verified.
- **No telemetry**. fqe does not phone home. The only network calls are to the GitHub API for Check Run publishing and event reading.

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
