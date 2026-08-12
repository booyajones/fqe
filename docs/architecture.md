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

**Code that enforces this:** `cli/lib/receipt.js` `buildReceipt` (via `validateCtx`) and `parseReceiptYaml` both reject a `bypass.requester_source` that is not a server-recorded GitHub source. The current bypass path is the SHA-bound `/fqe-bypass` PR comment, so the accepted sources are `github_comments_api_v3` (comment author) and `github_events_api_v3` (legacy labeled-event actor); identity never comes from a PR-branch file.

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

You can read about 500 lines of `verdict.js` and know exactly when fqe blocks. That readability is the design.

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

`computeVerdict` runs a fixed sequence of passes over its input. Each pass may only
ADD a FLAG or a FAIL. No pass clears one, which is why the order does not matter to
the verdict and why a new pass cannot weaken an existing guarantee. That property is
not left to convention: `test/source_hygiene.test.js` fails the build if either
accumulator is assigned anything but the literal `true`. Its reach is honest rather
than total, and worth knowing: it is a regex over stripped source, so it catches
every *direct* assignment but not aliasing (`let h = hasFail; h = false`),
destructuring, or property writes. `verdict.js` uses plain directly-assigned locals,
so that is sufficient for the code as written, and the guard is what makes changing
that a visible decision.

Order does not matter to the *verdict*. It can matter to the `reasons` list: a
malformed adversarial count makes `wilson95()` throw inside Pass 3, so Passes 4-12
never run and their reasons never appear. That fails closed, so the merge decision
is unaffected, but a receipt read alongside this table may hold fewer reasons than
the table implies.

```
Pass 1   required runner declared but did not run            -> FAIL
Pass 2   runner ran: exit_code non-numeric / NaN / non-zero  -> FAIL
           (an ACTIVE quarantine downgrades it to FLAG; an
            EXPIRED quarantine does not shield it)
           passed only after a retry                         -> FLAG
Pass 3   adversarial stats: Wilson 95% upper bound is
           RECOMPUTED here from raw (successes, n). Any
           runner-supplied ci_95 is IGNORED.
           bound > canonical threshold for blast_radius      -> FLAG
           ...same breach on mcp-write-or-financial          -> FAIL
           missing / unknown blast_radius                    -> FAIL
Pass 4   a runner owing adversarial stats emitted none       -> FAIL
Pass 5   a required test class has no runner that passed     -> FAIL
Pass 6   coverage-liveness: declared report missing, stale
           or unparseable / too few non-skipped tests ran /
           inventory reconciliation impossible               -> FAIL
           ran fewer tests than were collected               -> FLAG (FAIL if strict)
Pass 7   a test suite exists that no runner targets          -> FLAG (FAIL if strict)
Pass 8   require_money_idempotency on, but no passing runner
           PROVED the idempotency invariant with coverage    -> FAIL
Pass 9   mutation judge: surviving mutants on the diff       -> FLAG (FAIL if blocking)
Pass 10  money-looking code changed, no money policy set     -> FLAG (FAIL if strict)
Pass 11  a policy require_for glob matches no file           -> FLAG (FAIL if strict)
Pass 12  require_nonempty_gate on, but the gate has no teeth -> FAIL

if hasFail: verdict = FAIL (exit 2)
elif hasFlag: verdict = FLAG (exit 3)
else: verdict = PASS (exit 0)
```

That is the whole decision surface: about 500 lines, no LLM, no clock, no I/O, no
randomness. Same inputs always produce the same output.

The recompute in Pass 3 is worth dwelling on, because the earlier version of this
document described the opposite behavior. Until v0.14.0 the gate trusted the
interval a runner reported. A runner could then report a real 50-out-of-100
attack run alongside a fabricated interval of [0, 0.0001] and sail past the 0.01
money bar. The statistical method is policy, so it now lives in the deterministic
core: a runner supplies raw counts and nothing else.

## What fqe deliberately does NOT do

Bounded scope is a trust signal. fqe does not:

- **Decide what's a good code change.** That's code review.
- **Run static analysis.** Use ESLint, Ruff, Semgrep. fqe runs them via your `.fqe.yml` and reads their exit codes.
- **Replace your existing CI.** It runs alongside. Your Playwright, your Jest, your pytest all keep running.
- **Score subjective quality.** No "code beauty" runner. No "this commit message is mid" runner.
- **Block based on coverage delta.** Coverage gates are configurable in your own CI, not in fqe.
- **Auto-merge anything.** Verdict says yes or no. Merge is a human action.

## Three commitments that shape every decision

1. **Engineers don't get locked out by fqe's own bugs.** Exit code 4 (INFRA) emits a Check Run with conclusion `neutral`. GitHub API timeouts, missing `gh` binary, transient runner crashes all map here. **A neutral conclusion does NOT block merges in GitHub's branch protection model: required checks treat `neutral` as success.** If you observe `neutral` blocking, the issue is your branch-protection setting "Require branches to be up to date before merging" combined with a state quirk, not `fqe` policy. The exit-code taxonomy (0 PASS, 1 ERROR, 2 FAIL, 3 FLAG, 4 INFRA/neutral) is defined in `cli/bin/fqe.js`, and the verdict logic that produces it is pinned in `cli/test/verdict.test.js`.

2. **Bypass is a deliberate, audited act.** Every bypass writes to `bypass-tally.jsonl`, posts to a Check Run, gets archived in `audits/<sha>/`. Rolling rate above 10% in 14 days flips the `fqe/second-reviewer-required` check to FAIL, requiring an allowlisted second approver.

3. **Engineers can read the source and run it locally.** No proprietary binaries. No closed-source dependency. `fqe explain` prints the audit. `fqe run --base origin/main --output ./out/` reproduces the CI behavior on your laptop.

## See also

- [docs/getting-started.md](getting-started.md), the 5-minute onboarding.
- [docs/writing-a-runner.md](writing-a-runner.md), how to add a runner to your `.fqe.yml`.
- [docs/troubleshooting.md](troubleshooting.md), exact-error to exact-fix lookup.
- [SECURITY.md](../SECURITY.md), threat model and reporting.
- The actual verdict source: `cli/lib/verdict.js` (about 500 lines, read it).
