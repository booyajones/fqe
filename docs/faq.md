# FAQ

## Why does this exist?

Finexio shipped a financial model with three Sev 1 bugs under a green Validation tab. Then we shipped a partner integration with four CRITICAL defects. Then we published a Webflow page where the FAQ schema rendered as visible body text instead of in `<head>`. Each one had a human who looked at the work and said "yes, ship." Each one had a machine check that would have caught it in under five seconds.

fqe makes those checks unskippable.

## What does it actually do?

fqe is a CI gate. On every PR, it runs a configurable set of runners (your own scripts, your own tools) against the diff and produces a deterministic verdict (PASS, FLAG, FAIL). The verdict gets posted as a GitHub Check Run, which branch protection can require for merge.

That's it. It is not a linter, not a test runner, not an LLM judge, not an SCA tool. It is an orchestrator that runs the tools you already trust and refuses to let humans skip them.

## What kinds of tests does it handle? Regressions? UAT?

All of them, as a single taxonomy. A runner declares a `class`: unit, integration, e2e, regression, contract, property, uat, lint, type, mutation, coverage, security, money. A `policy` then says which classes must pass before merge (`require_classes`), and which become required when specific paths change (`require_for`, so a payments change demands a `money` test automatically). A required class with no passing runner is a FAIL.

Two of these classes ship with their own command so you do not have to build them: `fqe golden` is a regression engine (snapshot deterministic output, fail on drift), and `fqe uat` turns acceptance criteria into a pass/fail gate (automated test = covered, manual needs a signoff, unverified = gap). `fqe qa-report` shows every class's status in one scorecard. fqe still does not author or run your unit/integration suites for you, it runs the commands you point it at and enforces that the right classes are green. See `recipes/test-taxonomy.md`, `recipes/uat.md`, and `recipes/regression-golden.md`.

## How is this different from `husky` / `lefthook` / pre-commit hooks?

Those run locally before push. fqe runs server-side on every PR. The two are complementary. Use pre-commit hooks for the fast local checks (formatting, simple lint) and use fqe for the things that absolutely cannot reach `main` regardless of what the engineer's local setup looks like.

## How is this different from `danger.js`?

Danger writes opinionated PR comments based on diff inspection. fqe runs runners as subprocesses and computes a deterministic verdict. Danger is great for "did you update the changelog?" style nudges. fqe is for "does this xlsx still produce the same numbers?" style hard gates.

## How is this different from just having `runs-on: ubuntu-latest` with a bunch of test steps in my own workflow?

Three differences:

1. **Deterministic verdict aggregation.** fqe reads exit codes from N runners and computes one verdict via about 500 lines of pure code. You can read that code. You can run it locally. You can audit it.
2. **Tamper-evident receipts.** fqe emits a QA-RESULT.yml bound to the commit SHA. You can prove what was checked.
3. **Server-authoritative bypass.** Your custom workflow can be bypassed by anyone with write access. fqe's bypass uses GitHub Events API identity, requires an allowlisted actor, and gets logged in a rolling rate that auto-escalates when abused.

If you're a 2-person team, you don't need fqe. If you're a 10-person team shipping financial models, you probably do.

## Can I use this without putting fqe between my team and production?

Yes. Empty `.fqe.yml` (or no `.fqe.yml` at all) means the gate runs but always passes. Use this to deploy the workflow infrastructure without enforcing anything, then add runners one at a time as the team agrees on each rule.

## What happens if fqe itself has a bug?

Exit code 4 (INFRA) maps to a neutral Check Run. It does NOT block merges. fqe's own bugs, GitHub API timeouts, missing binaries, and transient network failures all route here.

The only way fqe blocks your PR is if a runner you configured returned a non-zero exit code (FAIL), or if a configured adversarial stat exceeded its Wilson CI threshold (FLAG, informational, also doesn't block by default).

## How do I bypass the gate?

Post a SHA-bound PR comment: `/fqe-bypass <head-sha> <24h|48h|72h>`. (The old unbounded `fqe-bypass` label was removed in v0.4.0.) Caveats:

1. You must be on the `.github/fqe-bypass-allowlist.yml` list at the PR's BASE commit (a PR cannot add itself to the list).
1b. The `<head-sha>` must equal the live head SHA, so any new push invalidates the bypass; it also expires on the stated TTL.
2. Every bypass is logged in `bypass-tally.jsonl`.
3. If the rolling 14-day bypass rate exceeds 10%, the `fqe/second-reviewer-required` check goes red until a different allowlisted reviewer adds the `fqe-second-approved` label.

fqe does not punish bypass. It audits it. If you're consistently bypassing, the gate is wrong, not you.

## Can I run it locally before pushing?

Yes:

```bash
fqe run --full --base origin/main --output ./out/
```

Produces the same QA-RESULT.yml and QA-RESULT.md that CI would. Same verdict. Same explainer output. Iterate without round-tripping CI.

## Does it phone home?

No. The only network calls fqe makes are to the GitHub API for Check Run publishing and PR event reading. No telemetry, no analytics, no usage tracking.

## How do I uninstall?

Delete these files from your repo:

- `.fqe.yml`
- `.github/workflows/fqe-quality.yml`
- `.github/workflows/fqe-second-approve.yml`
- `.github/fqe-bypass-allowlist.yml`
- `.github/fqe-second-reviewers.yml`
- `.github/fqe-state/` (directory)

Then remove `fqe/pass` and `fqe/second-reviewer-required` from your branch protection's required status checks. The gate stops firing immediately.

## What's the upgrade path?

Tags follow semver: `fqe-v<major>.<minor>.<patch>`. To upgrade, find the new tag in github.com/booyajones/fqe, then update the `FQE_REF="fqe-v0.18.12"` line in `.github/workflows/fqe-quality.yml` (it takes a tag or a 40-char SHA). Breaking changes are called out per release in `CHANGELOG.md`.

## Who maintains it?

Chris Wyatt (@booyajones), with additional maintainers as the team scales. Bug reports go to issues on github.com/booyajones/fqe. Security reports go to chris.wyatt@finexio.com with subject `[fqe-security]` (see SECURITY.md).

## Will this slow my CI down?

About 20 seconds per PR for the install step (clone + npm install + yq download). Once the Docker image is published (planned for v0.2), this drops to ~3 seconds. The verdict + receipt generation itself is under 1 second for a typical PR.

If your configured runners are slow, that's your runner's cost, not fqe's. Use the `when` glob to scope runners tightly.

## Why is the verdict logic in JavaScript and not Python / Go / Rust?

Because the workflow already needs Node for the orchestrator, adding a second language doubles the install footprint. The verdict logic is about 500 lines of pure JS with no dependencies. It's not the bottleneck.

## Why Wilson confidence intervals specifically?

The Wilson score interval is the standard for small-n binomial proportions. It stays well-defined at p=0 and p=1 (unlike the normal approximation, which goes negative). It's the right choice for "what's the upper bound on the true rate of bad output given N samples and K observed failures."

Reference: Wilson, E. B. (1927). "Probable inference, the law of succession, and statistical inference." Journal of the American Statistical Association 22(158): 209-212. Our implementation is pinned against `statsmodels.stats.proportion.proportion_confint` to 14 decimal places.

## Why not score-based gates like SonarQube?

Score-based gates are calibratable. Engineers learn what score threshold they need to clear and configure their checks to barely clear it. fqe's gate is binary on each runner (the runner exited 0 or didn't) and uses statistical bounds on adversarial stats (Wilson CI, not point estimates). There is no "score" to game.

## Is this open source?

Yes. MIT license. The public source is github.com/booyajones/fqe.
