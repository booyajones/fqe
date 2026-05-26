# Architecture

This is the file the skeptical staff engineer reads. It explains the three architectural invariants that everything else in fqe holds, why each one matters, and what would break if any were violated.

If you'd rather see them in your terminal: `fqe explain` prints these inline.

## The three invariants

fqe's design was reviewed across seven rounds by multiple LLM judges (Claude, GPT, DeepSeek, Gemini chairman). Each round caught an architectural flaw and the next iteration fixed it. **This is design-time review by LLMs, not runtime gating by LLMs.** Invariant 2 below explicitly prohibits an LLM from being in the verdict path that decides whether a PR can merge. The two roles do not conflict: LLMs are useful for surfacing critique on a design, and they are unsuitable for non-deterministic operational decisions.

The invariants below are what's left when every fixable flaw in those seven rounds was fixed.

### Invariant 1: No identity claim is read from a file the constrained actor wrote

When a PR author bypasses the gate, fqe identifies them by querying the GitHub Events API:

```
GET /repos/{owner}/{repo}/issues/{pr}/events
```

That API returns the server-recorded `actor.login` field for each `labeled` event. fqe takes the actor of the most recent `labeled` event where `label.name` starts with `fqe/bypass-` or equals `fqe-bypass`.

**fqe does not read identity from any of these sources:**

- Commit message body
- PR body (description)
- Receipt content (`bypass.requester` in QA-RESULT.yml is informational, never trusted)
- A file in the PR branch (an attacker controls those)

**Why this matters:** an earlier design (gauntlet round 5) put the bypass requester in the receipt and read it back at second-approve time. The receipt lived in the PR branch. An adversarial bypass requester could have written `bypass.requester: alice` while actually being `bob`, then had Bob approve. The same-actor anti-collusion check would have passed. The fix was to source identity only from server-recorded GitHub events.

**Code that enforces this:** `cli/lib/receipt.js` `validateCtx` throws if `bypass.requester_source` is not literally `github_events_api_v3`. `cli/lib/explainer.js` `parseReceiptYaml` re-validates the same field on read.

### Invariant 2: No LLM is in the verdict path

The verdict (PASS, FLAG, FAIL) is computed by `cli/lib/verdict.js`. It is:

- A pure Node function. No `fetch`, no `spawn`, no file I/O.
- Deterministic. Same inputs produce the same output. No clock, no random.
- Table-driven tested. `cli/test/verdict.test.js` covers PASS, FAIL, FLAG, edge cases, attacker bypass attempts, malformed inputs.

**Wilson 95% confidence intervals** for adversarial-runner attack-success-rates are computed by `cli/lib/wilson.js`. The thresholds (`outbound ≤ 0.05`, `mcp-read ≤ 0.03`, `mcp-write-or-financial ≤ 0.01`) are `Object.freeze`'d constants in `verdict.js`. Callers select a class by name; they cannot pass an arbitrary threshold.

**Why this matters:** an LLM-in-the-loop verdict means:
1. **Non-determinism.** Same PR could pass on Tuesday and fail on Wednesday.
2. **Evaluator drift.** When Claude moves from Opus 4.7 to Opus 4.8, the gate's behavior changes silently.
3. **An evaluator with its own failure mode.** Prompt-injection in PR content could fool the verdict.
4. **Auditability collapse.** You can't read a model and know when it blocks.

You can read 160 lines of `verdict.js` and know exactly when fqe blocks. That readability is the design.

**Code that enforces this:** the verdict path is `bin/fqe.js` → `lib/orchestrator.js` → `lib/verdict.js`. No `require` of any LLM SDK. The only places fqe talks to an LLM are in user-configured runners (e.g., a Promptfoo runner the user adds to `.fqe.yml`). Those runners feed deterministic numbers back to `verdict.js`.

### Invariant 3: No required state lives only in the PR branch

Every output fqe needs at decision time persists in at least one of these server-side stores:

| Output | Storage |
|---|---|
| Receipt (QA-RESULT.yml + QA-RESULT.md) | (a) GitHub Actions workflow artifact, (b) GitHub Check Run output text |
| Verdict | (a) GitHub Check Run conclusion (success/failure/neutral), (b) `fqe status print` reads server-side state |
| Bypass identity | GitHub Events API (`/issues/{pr}/events`) |
| Bypass-tally state | `.github/fqe-state/bypass-tally.jsonl` committed to the protected branch (not PR branch). Read-only from the PR's perspective. |
| Allowlist | `.github/fqe-bypass-allowlist.yml` at the PR's BASE commit (a PR cannot modify its own allowlist) |

**Why this matters:** the receipt was originally committed to the PR branch as `audits/<sha>/QA-RESULT.yml`. An attacker could have edited it post-write. The mitigation is two-layer: (a) the workflow artifact is immutable per run, (b) the Check Run output text is server-side. Both are pinned to the commit SHA they were generated against.

**Code that enforces this:** the workflow template at `cli/lib/init.js` `FILES['.github/workflows/fqe-quality.yml']` uses `actions/upload-artifact@v4` plus an explicit `fqe status publish` step. The receipt's `commit_sha` field is checked at `status publish` time against `github.event.pull_request.head.sha`.

## What the verdict logic actually does

```
For each runner:
  if runner.required === true AND runner.ran !== true:
    -> hasFail = true, reason "required runner X did not run"

  if runner.ran === true:
    if exit_code is NOT a number OR is NaN:
      -> hasFail = true, reason "runner X ran but exit_code is not a number"
    elif exit_code !== 0:
      -> hasFail = true, reason "runner X exited N"

For each adversarial_stat:
  if blast_radius is missing or unknown:
    -> hasFail = true, reason "unknown blast_radius"
  if ci_95[1] > BLAST_RADIUS_THRESHOLDS[blast_radius]:
    -> hasFlag = true, reason "Wilson CI upper X exceeds canonical threshold Y"

if hasFail: verdict = FAIL (exit 2)
elif hasFlag: verdict = FLAG (exit 3)
else: verdict = PASS (exit 0)
```

That's it. 160 lines. No LLM. Same inputs always produce the same output.

## What fqe deliberately does NOT do

Bounded scope is a trust signal. fqe does not:

- **Decide what's a good code change.** That's code review.
- **Run static analysis.** Use ESLint, Ruff, Semgrep. fqe runs them via your `.fqe.yml` and reads their exit codes.
- **Replace your existing CI.** It runs alongside. Your Playwright, your Jest, your pytest all keep running.
- **Score subjective quality.** No "code beauty" runner. No "this commit message is mid" runner.
- **Block based on coverage delta.** Coverage gates are configurable in your own CI, not in fqe.
- **Auto-merge anything.** Verdict says yes or no. Merge is a human action.

## Three commitments that shape every decision

1. **Engineers don't get locked out by fqe's own bugs.** Exit code 4 (INFRA) emits a Check Run with conclusion `neutral`. GitHub API timeouts, missing `gh` binary, transient runner crashes all map here. **A neutral conclusion does NOT block merges in GitHub's branch protection model: required checks treat `neutral` as success.** If you observe `neutral` blocking, the issue is your branch-protection setting "Require branches to be up to date before merging" combined with a state quirk, not `fqe` policy. Tested behavior is documented in the integration test at `cli/test/check-run-neutral.test.js`.

2. **Bypass is a deliberate, audited act.** Every bypass writes to `bypass-tally.jsonl`, posts to a Check Run, gets archived in `audits/<sha>/`. Rolling rate above 10% in 14 days flips the `fqe/second-reviewer-required` check to FAIL, requiring an allowlisted second approver.

3. **Engineers can read the source and run it locally.** No proprietary binaries. No closed-source dependency. `fqe explain` prints the audit. `fqe run --base origin/main --output ./out/` reproduces the CI behavior on your laptop.

## See also

- [docs/getting-started.md](getting-started.md), the 5-minute onboarding.
- [docs/writing-a-runner.md](writing-a-runner.md), how to add a runner to your `.fqe.yml`.
- [docs/troubleshooting.md](troubleshooting.md), exact-error to exact-fix lookup.
- [SECURITY.md](../SECURITY.md), threat model and reporting.
- The actual verdict source: `cli/lib/verdict.js` (it's 160 lines, read it).
