# Coverage-liveness: make absence loud

A passing exit code does not prove tests ran. A suite can exit 0 having executed nothing:
an empty selection, an all-skipped run, or a runner mis-scoped to a subset. Coverage-liveness
makes that impossible to read as green. It is deterministic and fail-closed, with no model in
the decision.

## What it checks

For a runner that declares a report, fqe enforces three things after the runner exits:

1. **Fresh evidence is mandatory.** fqe deletes any prior report before the run, then requires
   the runner to have written a new one. A missing, stale, or unparseable report FAILs. This is
   clock-independent: it compares against the prior file's mtime, so a cached report cannot pass
   even if the delete fails on a locked filesystem.
2. **Something real ran.** It counts only non-skipped testcases (skip, xfail, Jest `pending`,
   disabled, and ignored do not count). Below `min_tests` (default 1) FAILs.
3. **The whole suite ran.** With `reconcile`, fqe compares the executed count to the count the
   framework collected. Fewer executed than collected means a mis-scoped or partial run. Under
   `strict_coverage` that FAILs; otherwise it FLAGs. A deflated inventory (more reported than
   collected) FAILs closed, since you cannot execute more tests than exist.

## Wire it (pytest)

```yaml
# .fqe.yml
version: 1
require_coverage_evidence: true   # a required runner with no report FAILs
runners:
  pytest:
    command: python
    args: ["-m", "pytest", "-q", "--junitxml=fqe-report.xml", "tests/"]
    class: unit
    always_run: true
    required: true
    report: junit:fqe-report.xml
    inventory_cmd: python -m pytest --collect-only -q tests/
    inventory_format: pytest-collect
    min_tests: 1
    reconcile: true
    strict_coverage: true
```

## Wire it (cargo / nextest)

Add `.config/nextest.toml` so nextest emits JUnit:

```toml
[profile.ci.junit]
path = "junit.xml"
```

```yaml
runners:
  cargo:
    command: cargo
    args: ["nextest", "run", "--profile", "ci"]
    class: unit
    always_run: true
    required: true
    report: junit:target/nextest/ci/junit.xml
    inventory_cmd: "cargo nextest list --profile ci --message-format json 2>/dev/null | jq '[.[\"rust-suites\"][].testcases | length] | add // 0'"
    inventory_format: count
    min_tests: 1
    reconcile: true
    strict_coverage: true
```

`inventory_format: count` means the command prints just the integer count of collected tests.
Compose it from your own tooling (any language), and fqe stays framework-agnostic.

## The honest limit

Reconciliation catches a runner that runs FEWER tests than its own inventory. A globally wrong
filter applied to BOTH the inventory and the runner (the same wrong test universe) is the residual
that the human who writes the spec still owns. fqe does not pretend to catch that.

## Proven

This pattern runs green on real third-party repos that fqe did not author: a more-itertools fork
(Python, 722 tests) and a semver fork (Rust, 34 tests), each on real CI, with a planted mis-scoped
run turning the gate red. See booyajones/fqe-proof-python and booyajones/fqe-proof-rust.
