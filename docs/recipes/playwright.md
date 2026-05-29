# Recipe: gate an existing Playwright suite

fqe defers writing end-to-end and visual tests, but it does not ignore the ones you already have. If a repo has a Playwright suite, wrap it as a required fqe runner so a broken end-to-end flow blocks the merge. No rewrite, no new framework, just a command and an exit code.

This is the on-ramp for a repo like a design system or a web app that already runs Playwright (including visual-regression configs). The suite stays exactly as it is. fqe reads its exit code and folds it into the one verdict.

## Why wrap it instead of rewriting it

Your Playwright suite is a real regression asset. The point of fqe is to make the checks you already trust unskippable, not to replace them. A runner is just a command that exits non-zero on failure, and `playwright test` already does that. So gating it is a five-line config change, not a project.

## How it works

Playwright exits 0 when every test passes and non-zero when any fails. fqe maps that to PASS or FAIL like any other runner.

```yaml
# .fqe.yml
runners:
  e2e:
    command: "npx"
    args: ["playwright", "test"]
    when: ["src/**", "app/**", "e2e/**", "tests/e2e/**", "playwright.config.*"]
    required: true
    timeout_ms: 600000   # 10 min; e2e is slower than unit
```

Exit codes: **0 = PASS, non-zero = FAIL** (merge blocked). The runner only fires when the diff touches the paths in `when`, so a docs-only PR does not pay the e2e cost.

## Visual regression

If you run a separate visual config (for example `playwright.visual.config.ts`), add it as its own runner so a pixel diff is a distinct, named signal:

```yaml
  e2e-visual:
    command: "npx"
    args: ["playwright", "test", "--config", "e2e/playwright.visual.config.ts"]
    when: ["src/**", "app/**", "e2e/**"]
    required: false   # start advisory; visual diffs are noisier than functional
    timeout_ms: 600000
```

Start visual as `required: false`. Pixel diffs are noisier than functional failures, so let the team see them for a week before they block.

## Wire it into CI

Playwright needs its browsers installed in CI before the runner fires:

```yaml
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      # fqe run will now fire the e2e runner on a matching diff
```

## The on-ramp

1. Confirm `npx playwright test` passes locally on the repo.
2. Add the `e2e` runner block above to `.fqe.yml`, keyed to the paths your app and tests live in.
3. Run `fqe validate` so a typo cannot silently disable it.
4. Keep `required: false` for a few PRs, then flip to `required: true`.

That is the whole on-ramp. The suite you already maintain now blocks a merge when an end-to-end flow breaks.

## Notes

- **Scope `when` tightly.** End-to-end is slow. Only fire it when the app or the e2e tests change, not on every PR.
- **Flaky e2e is real, so quarantine it.** Playwright flakes more than unit tests. Pair this with `docs/recipes/flaky-quarantine.md` so one flaky browser test does not erode trust in the gate.
- **fqe still does not write e2e tests for you.** That stays deliberate. This recipe gates the suite you have, it does not generate new browser tests.
- **A `playwright.config` change is a grading-rule change.** It is in the oracle-guard default patterns by extension, so a PR that edits the Playwright config alongside app code will ask for a second reviewer. That is intended.
