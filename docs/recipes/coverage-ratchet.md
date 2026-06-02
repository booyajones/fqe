# Recipe: coverage ratchet

Stop coverage from silently sliding. Two rules, enforced by `fqe coverage-ratchet`:

1. **Patch rule:** the changed/new lines in a PR must hit a minimum coverage (default 80%). New code arrives tested.
2. **Ratchet rule:** total project coverage may never fall below a committed baseline. It can only hold or climb.

This is the highest-impact gate for regression protection: it makes coverage *compound* per PR instead of decaying. Deterministic, no LLM in the path (same as the rest of fqe).

## Why a ratchet beats a fixed threshold

A fixed "must be 80%" gate gets gamed: engineers learn the number and write just enough to clear it, and coverage plateaus. A ratchet gates on *direction*, not a level: every PR either holds the line or raises it, and a baseline that only moves up. There is no number to barely clear.

## How it works

```
fqe coverage-ratchet --report coverage.json \
    [--baseline coverage-baseline.json] \
    [--patch 87.5] [--patch-threshold 80] [--bump]
```

- `--report` (required): a coverage report. Auto-detects vitest/istanbul `json-summary`, `coverage.py` json, Cobertura XML, or lcov.
- `--baseline`: committed `{ "total": 73.41 }`. Missing baseline = first run, which passes and establishes it.
- `--patch`: coverage % of the changed lines (compute with `diff-cover` for Python, or `vitest --changed` coverage for TS). Omit to skip the patch rule.
- `--bump`: on a PASS that raised total coverage, writes the new (higher) baseline. Use this in a post-merge job, not on the PR.

Exit codes: **0 = pass, 2 = FAIL (merge blocked), 4 = INFRA** (coverage report unreadable, neutral, never blocks on fqe's own inability to read a file).

## Wire it into CI

Add to your test workflow, after producing a coverage report:

```yaml
      - name: tests with coverage
        run: npm test -- --coverage --coverage.reporter=json-summary
        # produces coverage/coverage-summary.json

      - name: coverage ratchet
        run: |
          npx --yes github:booyajones/fqe#fqe-v0.13.0 cli/bin/fqe.js coverage-ratchet \
            --report coverage/coverage-summary.json \
            --baseline coverage-baseline.json \
            --patch-threshold 80
```

Python:

```yaml
      - name: tests with coverage
        run: pytest --cov=src --cov-report=json   # -> coverage.json
      - name: patch coverage
        run: diff-cover coverage.xml --compare-branch=origin/main --json-report patch.json
      - name: coverage ratchet
        run: |
          fqe coverage-ratchet --report coverage.json \
            --patch "$(jq .total_percent_covered patch.json)" --patch-threshold 80
```

## The post-merge bump

On the PR, the ratchet only *checks*. On merge to the default branch, a small job bumps the baseline so the new floor is locked in:

```yaml
on:
  push:
    branches: [main]
jobs:
  bump-baseline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test -- --coverage --coverage.reporter=json-summary
      - run: fqe coverage-ratchet --report coverage/coverage-summary.json --bump
      - name: commit the new baseline
        run: |
          git config user.name "fqe-bot"
          git config user.email "fqe-bot@finexio.com"
          git add coverage-baseline.json
          git diff --cached --quiet || git commit -m "chore: bump coverage baseline [skip ci]"
          git push
```

## Seeding the first baseline

Run the ratchet once with no baseline file present. It passes (first run) and, with `--bump`, writes the current coverage as the starting floor. Commit that file.

## Notes

- **Gate on the patch rule from day one; ratchet the total gently.** Start the total floor at wherever you are today; the patch rule (80% on new code) is what drives the number up over time without a painful catch-up project.
- **A dropped baseline is a FAIL, not a FLAG.** Coverage regressions block merge. Override is a deliberate human act (the PR author justifies it and an allowlisted reviewer bypasses, logged like any other fqe bypass).
- **Pair with mutation testing.** Coverage tells you a line ran; mutation tells you a test would catch it breaking. The ratchet guards quantity; `docs/recipes/ai-test-generation.md` guards quality. Use both.
