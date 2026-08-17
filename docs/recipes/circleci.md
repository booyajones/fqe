# Recipe: run the fqe gate on CircleCI

fqe ships GitHub Actions templates, but the CLI itself is just `node`, so it runs anywhere. If your team is on CircleCI, this is the equivalent gate. Nothing about the verdict, the receipt, or the gates changes. Only the YAML around them does.

## What stays the same

`fqe coverage-ratchet`, `fqe mutation-gate`, `fqe oracle-guard`, and `fqe validate` are plain commands with the same exit codes (0 PASS, 2 FAIL, 3 FLAG, 4 INFRA, 1 ERROR) on any CI. CircleCI fails the job on a non-zero exit, which is exactly what you want for a gate.

## A working .circleci/config.yml

Drop this at `.circleci/config.yml`. It installs the tag-pinned CLI once, validates the config fail-closed, then runs the gates.

```yaml
version: 2.1

jobs:
  fqe-gate:
    docker:
      - image: cimg/node:22.11
    steps:
      - checkout
      - run:
          name: Install fqe (tag-pinned)
          command: |
            set -euo pipefail
            # FQE_REF takes a tag OR a 40-char commit SHA. Fetch, do not
            # `clone --branch`: that flag takes a ref name only and fails on a SHA.
            FQE_REF="fqe-v0.18.18"
            # A fresh dir per build, not a fixed path under /tmp. Machine
            # executors and self-hosted runners share /tmp across builds, so a
            # predictable path is both a re-run hazard and a writable staging
            # area for code this step then executes. `rm -rf` does not fix that:
            # it fails under `set -e` if a prior build left it owned elsewhere.
            FQE_SRC="$(mktemp -d)"
            git -C "$FQE_SRC" init -q .
            git -C "$FQE_SRC" fetch -q --depth=1 https://github.com/booyajones/fqe.git "$FQE_REF"
            git -C "$FQE_SRC" checkout -q --detach FETCH_HEAD
            (cd "$FQE_SRC/cli" && npm ci --omit=dev)
            # Double quotes so $FQE_SRC is resolved NOW and baked into the
            # function; \$@ stays literal so it expands at call time. Later
            # steps get their own shell, so the path must be concrete here.
            # The baked path is quoted too: mktemp -d honours TMPDIR, so on an
            # executor whose TMPDIR contains a space an unquoted path would split
            # and every later fqe call would die with "Cannot find module".
            echo "fqe(){ node \"$FQE_SRC/cli/bin/fqe.js\" \"\$@\"; }" >> "$BASH_ENV"
      - run:
          name: Validate .fqe.yml (fail closed on a typo)
          command: fqe validate
      - run:
          name: Tests with coverage
          command: npm ci && npm test -- --coverage --coverage.reporter=json-summary
      - run:
          name: Coverage ratchet
          command: |
            fqe coverage-ratchet --report coverage/coverage-summary.json \
              --baseline coverage-baseline.json --patch-threshold 80
      - run:
          name: Mutation gate on changed files
          command: |
            CHANGED=$(git diff --name-only "origin/main...HEAD" | tr '\n' ',')
            npx stryker run --reporters json --mutate "$CHANGED" || true
            fqe mutation-gate --report reports/mutation/mutation.json \
              --threshold 70 --changed "$CHANGED"

workflows:
  pr-gate:
    jobs:
      - fqe-gate
```

## Make it block

CircleCI reports each job to GitHub as a status check. In your GitHub branch-protection settings, add `ci/circleci: fqe-gate` to the required checks. Until you do, the gate reports but does not block, which is the same caveat as the GitHub Actions path.

## Oracle-guard and the second reviewer

`fqe oracle-guard` runs fine as a CircleCI step, but the second-reviewer enforcement needs the GitHub reviews API. You have two clean options:

1. Keep `fqe-oracle-guard.yml` as a small GitHub Actions workflow even if the rest of CI is CircleCI. It only calls the GitHub API, so it belongs there anyway. This is the recommended split.
2. Run oracle-guard in CircleCI and call `gh api repos/$REPO/pulls/$PR/reviews` from the job using a `GH_TOKEN` context secret. Same logic as `workflows/fqe-oracle-guard.yml.template`, ported to a CircleCI step.

## Notes

- **Pin the ref, not HEAD.** The `FQE_REF` fetch is the supply-chain boundary. For higher assurance set it to a commit SHA, resolved without a local clone via `git ls-remote https://github.com/booyajones/fqe.git 'refs/tags/fqe-v0.18.18^{}' | cut -f1`; the fetch form accepts a tag or a SHA, which `git clone --branch` does not.
- **Cache `node_modules` if install time bothers you.** Use CircleCI's `restore_cache`/`save_cache` around `npm ci`. The fqe install is small and rarely the bottleneck.
- **The receipt is portable.** `fqe run` writes the same `QA-RESULT.{yml,md}` on CircleCI. Persist it with `store_artifacts` so the tamper-evident record survives the build.
