# Recipe: oracle-tamper guard

Stop a PR from making itself green by editing its own answer key. `fqe oracle-guard` reads the diff and requires a second human when a PR touches the recorded ground truth or the grading rules it is judged by.

The mutation gate proves a test is strong. It does not catch the move where someone (or an agent) makes a red PR green by changing the recorded answer instead of fixing the code: regenerating a golden master so a regression looks correct, re-recording a partner cassette to match broken output, lowering the coverage baseline, or deleting a runner from `.fqe.yml`. Deterministic, no LLM in the path.

## Why this is a separate gate

Coverage tells you a line ran. Mutation testing tells you a test would catch that line breaking. Neither looks at *what the test is graded against*. If the grading artifact itself is in the diff, every other gate can pass while the thing being measured quietly moved. The guard watches the answer key, not the code.

## What counts as the answer key

Two triggers, both tuned for high signal and low false-positive.

1. **Ground truth and grading rules (always).** Golden masters and snapshots (`**/__approved__/**`, `**/*.snap`), recorded partner cassettes (`**/cassettes/**`), fixtures and seeds (`**/fixtures/**`, `**/testdata/**`, `**/seeds/**`, `**/*.golden`), and the rules themselves (`.fqe.yml`, `coverage-baseline.json`, `stryker.conf.json`, the bypass and reviewer allowlists). These change rarely and carry weight, so any change to them gets a second look.

2. **Test co-change (opt-in, `--include-tests`).** A test file changed in the same PR as a non-test source file. A pure test-writing PR stays frictionless, because you want people adding tests. The pattern worth a second look is editing the test that grades your code in the same breath as the code.

## How it works

```
fqe oracle-guard [--changed "a,b,c"] [--base SHA --head SHA] [--repo-dir D] \
                 [--include-tests] [--block]
```

It resolves the changed files from `--changed`, then the `FQE_CHANGED_FILES` env var, then `git diff base..head`. It prints a runner-shaped JSON line with `requires_second_review`, the matched `oracle_files`, and plain-English `reasons`.

Exit codes: **0 = clean, 3 = FLAG** (the answer key changed, default), **2 = FAIL** (same condition, with `--block`). The guard only detects. Enforcement (the actual second-reviewer requirement) is done by the workflow below.

## Wire it into CI

Copy `workflows/fqe-oracle-guard.yml.template` to `.github/workflows/fqe-oracle-guard.yml`. It runs the guard on the PR diff and, when the answer key changed, passes only if a reviewer other than the author has approved:

```yaml
      - name: Run oracle-guard on the PR diff
        id: guard
        run: |
          set +e
          npx --yes github:booyajones/fqe#fqe-v0.4.1 cli/bin/fqe.js \
            oracle-guard --base "$BASE_SHA" --head "$HEAD_SHA"
          GUARD_EXIT=$?; set -e
          # The exit code is the signal, not parsed text (a parse fallback can
          # fail open). 0 = clean, 2/3 = needs review, anything else = fail closed.
          case "$GUARD_EXIT" in
            0) NEEDS=false ;;
            2|3) NEEDS=true ;;
            *) echo "::error::oracle-guard could not run (exit $GUARD_EXIT), failing closed"; NEEDS=true ;;
          esac
          echo "needs_review=$NEEDS" >> "$GITHUB_OUTPUT"

      - name: Require a second reviewer when the answer key changed
        if: steps.guard.outputs.needs_review == 'true'
        run: |
          APPROVERS=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate \
            --jq "[.[] | select(.state==\"APPROVED\") | .user.login] | unique | map(select(. != \"$AUTHOR\")) | length")
          [ "$APPROVERS" -ge 1 ] || { echo "::error::PR edits its own ground truth; a second reviewer must approve."; exit 1; }
```

The workflow re-runs on `pull_request_review`, so adding the approval clears the check without a new push.

## Make it actually block

Add the `oracle-guard` job to branch protection as a **required status check**. Without that, the guard reports but cannot stop a merge. This is a one-time repo setting and a team-workflow decision, so agree on it with the team first.

## Notes

- **This targets the dangerous edits, not every PR.** A normal code change, or a pure test-writing PR, sails through with zero friction. The guard only speaks up when the recorded ground truth or the rules are in the diff.
- **A legitimate golden update still needs the second reviewer, and that is the point.** Regenerating goldens after an intended format change is exactly the high-stakes change where a second pair of eyes belongs.
- **Pair it with the mutation gate, do not replace it.** Mutation testing keeps the tests strong. Oracle-guard keeps the answer key honest. Different failure modes, both real.
- **`--include-tests` is the agent-heavy setting.** If agents author code and tests together, turn it on so a human eyeballs every PR that changes a test next to the source it grades.
- **It fails closed.** If the guard cannot read the diff (a git error, a missing base SHA, a shallow clone), it does not report clean. It requires the second reviewer (exit 3) and the workflow keys off the exit code, not parsed text, so an unreadable diff cannot quietly switch the guard off. A security guard that fails open is worse than no guard.
- **The patterns are an allowlist, so extend them for your repo.** The defaults cover the common conventions (goldens, snapshots, cassettes, fixtures, `*.approved`, `*.expected`, `*.received`). A determined insider could rename a golden to an extension the defaults do not list to dodge the guard, so add your repo's own golden and config paths. Treat oracle-guard as one layer next to the mutation gate, the coverage ratchet, and human review, not the only one.
