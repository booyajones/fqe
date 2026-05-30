# Recipe: test classes and the full-suite policy

This is what turns fqe from "run my checks" into a real QA suite. Every runner can declare what kind of test it is, a policy can demand that certain kinds of tests exist and pass, and a single scorecard shows a QA lead the whole picture in one view.

The mechanism is small: a `class:` field on a runner, a `policy:` block in `.fqe.yml`, and `fqe qa-report`.

## The `class:` field

Any runner can carry a `class`. It tags the runner with the kind of test it is, so the gate can require that kind of test to exist and the scorecard can group results.

```yaml
runners:
  unit:
    command: "npm"
    args: ["test"]
    when: ["src/**"]
    required: true
    class: unit
```

The class set is locked. A typo'd class is rejected by `fqe validate` rather than silently accepted, because a class nobody can satisfy would make a policy unsatisfiable.

The full `KNOWN_CLASSES` list:

- **unit** a single function or module in isolation
- **integration** multiple units together (db, http, fs)
- **e2e** a full user flow through the running system
- **regression** characterization / golden-master: output must not drift
- **contract** a partner or provider API contract holds
- **property** property-based / invariant checks
- **uat** user-acceptance: an acceptance criterion is satisfied
- **lint** static style and formatting
- **type** static type check
- **mutation** mutation-testing bouncer (tests actually catch bugs)
- **coverage** coverage ratchet
- **security** security / SAST / secret scan
- **money** money-path correctness (balances, idempotency, reconciliation)

## The `policy` block

The optional top-level `policy` block says which classes must be covered before a merge. It has two keys.

`require_classes` is the always-required set. These classes must have a runner that ran and passed on every PR.

`require_for` is diff-conditional. When the PR touches the globs in `when`, the listed `classes` become required for that PR. This is how you put a strict bar on money paths without slowing down a docs change.

```yaml
# .fqe.yml
policy:
  require_classes: ["unit", "lint"]
  require_for:
    - when: ["src/payments/**", "src/ledger/**"]
      classes: ["money", "regression", "contract"]
```

Read that as: every PR needs a passing unit runner and a passing lint runner. A PR that changes `src/payments/` or `src/ledger/` also needs passing `money`, `regression`, and `contract` runners. A docs-only PR needs neither.

## The catch: a required class with no passing runner is a FAIL

This is the rule that makes the policy mean something. At verdict time, for every required class (always-required, or pulled in by `require_for` because the diff matched), fqe looks for a runner of that class that ran and passed. If there is none, the verdict is FAIL.

A class with no runner at all does not slip through. It is a gap, and a gap blocks.

That is the "you changed money code but shipped no money test" catch. You cannot satisfy `classes: ["money"]` by simply not having a money runner. The absence is the failure. To clear it you add (or fix) a runner tagged `class: money` and make it pass.

## The scorecard: `fqe qa-report`

The verdict answers "does this merge?". The scorecard answers "what did QA actually cover, and where are the gaps?". It is the human-facing roll-up over a parsed receipt.

```bash
fqe qa-report --receipt QA-RESULT.yml [--json] [--gate]
```

It groups runners by class, shows per-class status, lists policy-required classes with covered-or-GAP status, and prints any gaps in plain English. By default it is report-only. Add `--gate` to map the receipt verdict to the exit code (0 PASS, 2 FAIL, 3 FLAG).

A sample scorecard:

```
QA SCORECARD
Overall verdict: FAIL
Commit: 4aceea34
Runners: 7 total, 5 passed, 1 failed, 1 not run

| Class      | Ran | Passed | Failed | Status  |
|------------|-----|--------|--------|---------|
| unit       | 1   | 1      | 0      | pass    |
| regression | 1   | 1      | 0      | pass    |
| contract   | 1   | 0      | 1      | fail    |
| lint       | 1   | 1      | 0      | pass    |
| money      | 0   | 0      | 0      | not-run |
| type       | 1   | 1      | 0      | pass    |

Policy-required classes:
  unit: covered
  lint: covered
  money: GAP
  regression: covered
  contract: GAP

GAPS:
  - class "money" is required by policy but has no passing runner
  - class "contract" is required by policy but has no passing runner
```

Two gaps here. The `money` class has no runner that ran at all (a missing money test on a payments PR), and `contract` ran but failed. Both block. A QA lead reads this one view and knows exactly what is missing and what is broken.

## How this makes fqe a full QA suite

Three things come together.

Every test type has a home. Unit, integration, e2e, regression, contract, property, uat, lint, type, mutation, coverage, security, and money each map to a class, so nothing falls outside the scorecard.

Money paths get the strict bar automatically. `require_for` watches the payments and ledger globs, and the moment a PR touches them, the money, regression, and contract bars switch on without anyone remembering to ask.

The scorecard is the one view a QA lead reads. Per-class status, policy coverage, and the exact gaps, in one deterministic table, bound to a commit. No spelunking through logs.

## Notes

- **A required class with no runner is a GAP, not a silent pass.** The scorecard and the verdict use the same definition of "passed" (the runner ran and exited 0), so they never disagree about coverage.
- **`require_for` is the lever for money discipline.** Keep the always-required set small (unit, lint) and let the diff-conditional rules add the heavy bars only where they matter. This keeps fast PRs fast and slow-but-critical PRs thorough.
- **Validate the policy.** A typo'd class name in `require_classes` or `require_for` would be unsatisfiable, so `fqe validate` rejects it up front rather than letting it block every PR later.
- **Tag your runners as you add them.** See `docs/recipes/uat.md` (`class: uat`) and `docs/recipes/regression-golden.md` (`class: regression`) for two runners that plug straight into a money-path policy.
