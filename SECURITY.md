# Security

Report a suspected vulnerability privately to chris@finexio.com with subject `[fqe-security]`. Include the affected commit and a minimal reproduction; keep credentials out of the report.

## Trust boundaries

FQE aggregates configured tests. It cannot prove that those tests cover the product, or that an authorized maintainer is honest. A receipt is evidence of declared checks, not a certification of compliance or production readiness.

The generated `fqe-quality.yml` executes the exact PR head with a read-only token and `persist-credentials: false`. It produces a fresh receipt bound to the head SHA and source run/attempt. Runner environment filtering reduces accidental credential exposure; it is not a sandbox for arbitrary code.

The separate `fqe-publish.yml` runs from the default branch with `checks: write`. It never checks out or executes PR code. The publisher downloads source-run artifacts as data, validates their schema, live PR head, source workflow and attempt, and re-reads GitHub authority before publishing. Missing, malformed or stale evidence fails closed. Both workflows must pin the same reviewed FQE commit with `fqe init --ref <40-char-sha>`.

Protect the publisher, `.fqe.yml`, allowlists and test oracles with CODEOWNERS and repository rules requiring independent review. A user with permission to alter workflows or post competing checks can defeat an application-level gate. The repository owner must constrain those capabilities. GitHub Actions versions in the templates are major-version tags; organizations needing immutable action dependencies should replace them with reviewed full commit SHAs and keep an update process.

## Bypass and approval

Only an unedited, unexpired `/fqe-bypass <current-head-sha> <24h|48h|72h>` comment from a currently allowlisted GitHub account can authorize a bypass. Identity and timestamps come from the comments API, never receipt fields. The allowlist is read at the live default branch, not the PR base snapshot.

Current-head reviews are checked against the current reviewer allowlist. The author and bypass requester cannot second-approve. A later change request or dismissal invalidates an earlier approval. Oracle and grading-rule changes need independent approval even without a bypass.

For bypass requests, the 14-day bypass rate uses immutable Actions audit artifacts and server run metadata. Missing, expired, duplicate, misbound, unreadable or truncated history blocks verification. Each latest completed publisher run must have an audit record. The denominator counts distinct audited PR heads, including the current one; it is not a count of unique PRs. An empty history is unknown, not a measured zero. Rerun a failed publisher to repair a missing latest record.

Posting a bypass comment does not trigger a workflow. Rerun the FQE Publish run associated with the current head and verify both refreshed checks and its receipt.

Authorization is checked at publication time. GitHub does not automatically turn an existing green check red when a comment expires or an allowlist changes. Rerun verification after such changes and before a consequential merge. Merge queues, fork/review event behavior and your repository rules require a native integration test before deployment.

## Receipts and retention

Unsigned receipts can be altered by someone who controls the source job. In the trusted publisher, optional `FQE_SIGNING_KEY` signs the validated known evidence fields, including run identity, timestamps, runner results, reasons, hashes, verdict and applied bypass. Keep this key only in the publisher; never expose it to untrusted runners. Verification authenticates the declared signed fields, not unknown extensions or a signer's organizational authority. Legacy receipts keep their explicit signed scope. See [receipt signing](docs/recipes/receipt-signing.md).

Artifacts are retained for 90 days in the templates, subject to GitHub repository limits. This is a technical retention setting, not a regulatory opinion. If your approved retention requirement is longer, export verified receipts to controlled storage and test retrieval and access enforcement. Check output alone is not a complete evidence archive.

A publication error (CLI exit 4) does not create a neutral check. The publisher fails, and required checks may remain missing or retain an older result. Resolve the error, rerun the publisher and inspect its current-head results. GitHub accepts an actually published neutral or skipped required check as passing, so do not treat local exit codes as proof of enforcement. See [GitHub required-check guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

## Operator checks

1. Install the trusted publisher on the default branch before enabling required checks.
2. Pin both workflows to a reviewed full FQE commit SHA; tags can move.
3. Configure real required runners; the default empty scaffold blocks.
4. Require `fqe/pass` and `fqe/second-reviewer-required` under the intended GitHub App and enforce repository rules for administrators where appropriate.
5. Verify a passing PR, deliberate failure, stale receipt, missing report and independent approval in a dedicated sandbox.
6. Monitor missing publisher artifacts and periodically verify your evidence archive.

The local test suite includes negative controls for verdicts, mutation reports, receipt authentication, current-head authority and deleted audit history. Green unit tests do not establish production adoption or a live payment-path result.

Publisher signatures attest to validated commit/run binding and current server authority, while recording the source job's runner claims. They do not establish honest runner output: PR code can forge data inside its own evaluation job. Protected grading rules, independent review and meaningful negative controls remain necessary.

Bypass history is read only to authorize a bypass; missing history never cancels a clean ordinary test result. For a bypass request, missing or unsupported audit schemas fail closed. New artifacts use v2 names with the server-bound source head SHA so repeated attempts cannot dilute the rate.

When GitHub returns an empty source-run PR association list (including some fork events), publication still requires live head/run equality, while the PR number comes from the artifact context. Same-head PR ambiguity remains a native acceptance case; do not claim complete fork/merge-queue coverage from unit tests.
