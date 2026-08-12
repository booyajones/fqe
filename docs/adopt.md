# Adopting fqe: the runbook for a small team

This is the playbook for turning fqe on and getting value from it without a big rollout. It is written for a team of a few engineers. Read it once, then it is a 10-minute setup per repo.

## What you actually have (three layers, one purpose)

The job is simple: make the checks you already have unskippable, and catch the bugs those checks cannot see. Three layers do that, and they do not overlap.

1. **The gate (`fqe run`).** Deterministic and blocking. It runs your configured runners (tests, lint, type-check, mutation, whatever), reads their exit codes, and emits one verdict plus a tamper-evident receipt. No AI decides pass or fail. This is the layer that *blocks* a merge.
2. **The mutation bouncer (`fqe mutation-gate`).** Quality, blocking. Coverage tells you a line ran. Mutation testing tells you a test would CATCH that line breaking. The bouncer rejects tests that run code without asserting anything. It is what lets you trust a test, yours or an AI's. We demonstrated it on real Finexio code: a file with green coverage left 6 of 14 mutations uncaught (a 57% kill rate), and the bouncer flagged exactly that and blocked.
3. **Claude review.** Advisory, non-blocking. Anthropic's Claude action reviews every PR on your own API key (no per-seat vendor) and comments on logic bugs the gate cannot see: float money math, missing idempotency, swallowed errors. It advises. It does not block.

Plus a **bypass** for emergencies: an allowlisted person posts `/fqe-bypass <head-sha> <24h|48h|72h>` on the PR. It is bound to that exact commit (a new push invalidates it), it expires, and every use is logged.

The rule of thumb: the gate and the bouncer block, Claude advises, the bypass is the audited escape hatch.

## Turn it on (about 10 minutes per repo)

```bash
# 1. Bootstrap the gate (writes .fqe.yml, the workflow, the allowlists)
npx --yes -p github:booyajones/fqe#fqe-v0.18.9 fqe init

# 2. Tell it your real runners. Edit .fqe.yml: point each runner at the
#    command you already use (npm test, pytest, your linter, Stryker).
#    Start with required: false so nothing blocks while you tune.

# 3. (Optional) Add Anthropic's Claude review action for advisory PR comments.
#    Add a workflow that uses anthropics/claude-code-action (see that action's README),
#    then set the secret:
gh secret set ANTHROPIC_API_KEY -R <owner>/<repo>   # paste your Anthropic key

# 4. Validate the config before it can silently disable a check:
npx --yes -p github:booyajones/fqe#fqe-v0.18.9 fqe validate

# 5. Commit and open a PR. The gate runs, Claude reviews. Both are advisory
#    until you do the next step.
```

To make it actually block, add `fqe/pass` (and your `test` check) to the branch's required status checks in Settings, Branches. That is the one switch that turns advisory into enforced. Do it when the team is ready, not before.

## Reading a result

- **Green `fqe/pass`.** Every runner passed, merge away.
- **Red, with a reason.** The receipt and the Check Run output give you the exact runner, the plain-English reason, and a copy-paste repro command. Fix it or, if it is a real emergency, bypass.
- **A Claude comment.** Advisory. Read it, decide. It is a second set of eyes, not a blocker.
- **An `fqe oracle-guard` flag.** The PR edited a golden file, a cassette, the coverage baseline, or `.fqe.yml`. That needs a second reviewer, because a PR should not be able to change its own answer key.

## Sizing it to a small team

- **Start advisory, enforce later.** Run the gate and the reviewer as non-blocking for a week so the team sees the value before the friction. Flip the required check once the signal is trusted.
- **Skip the paid tools for now.** At a few engineers you do not need a per-seat AI reviewer (Claude on your own key covers it), an automated test author (you write tests faster than you vet AI ones at this size), or a flaky-test service (the retry-and-flag stopgap is enough). Revisit each as you grow. See `docs/recipes/flaky-quarantine.md`.
- **Gate the suites you already have.** If you run Playwright, wrap it as a runner instead of rewriting anything. See `docs/recipes/playwright.md`.
- **Money paths get the strict bar.** Anything touching balances, idempotency, reconciliation, or partner webhooks gets the `mcp-write-or-financial` blast class and the tightest mutation threshold. Everything else can be looser.

## When you grow

The platform is built to add capability without rework:
- **Test classes and a policy.** Tag each runner with a `class` and set a `policy` so the right test types are required before merge, automatically stricter on money paths: `docs/recipes/test-taxonomy.md`. The `fqe qa-report` scorecard then shows per-class status and gaps in one view.
- **UAT as a gate.** Turn acceptance criteria into a pass/fail check with `fqe uat`: `docs/recipes/uat.md`.
- **Regression with golden masters.** Snapshot deterministic output and fail on drift with `fqe golden`: `docs/recipes/regression-golden.md`.
- An **automated test author** (Claude writes tests on demand, gated by the bouncer): `docs/recipes/ai-test-generation.md`.
- **Partner-API contract tests**, **golden-master tests**, and **property-based money invariants**: the three `docs/recipes/` files named for them.
- A **flaky-test service** (Trunk or BuildPulse) once you have enough tests and contributors that flakes start to bite.

## The honest one-liner for the team

fqe makes the checks you already trust impossible to skip, the mutation gate makes "tests pass" actually mean something, and Claude reads every PR for the logic bugs a machine check cannot. Start advisory, enforce when ready, and do not buy anything until you feel a specific pain.
