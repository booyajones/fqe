# Mutation-on-diff: prove a test would catch a bug (v0.13, Stage B)

Coverage-liveness (v0.9.0) proves a test RAN. Mutation testing proves it would CATCH the
code breaking. It is the only deterministic way to expose an assert-nothing test, which is
exactly the test an LLM is most likely to write. This is the linchpin that lets fqe trust
AI-authored tests without a human reading each one.

It ships ADVISORY first on purpose: surviving mutants are a FLAG, not a block, while you
measure the false-red rate. Ratchet it to blocking once that rate is near zero.

## Configure (advisory by default)

```yaml
# .fqe.yml
mutation:
  mode: advisory          # advisory (FLAG survivors) -> blocking (FAIL) once ratcheted
  threshold: 70           # minimum kill rate %
  min_mutants: 1          # below this in the diff, NEUTRAL (cannot judge, never a silent pass)
  # equivalent mutants to suppress, so the gate never sprays false reds. Inline
  # list: this block takes flat `key: value` lines, not a nested `- item` block.
  allowlist: ["src/money/round.ts:42:ArithmeticOperator"]

runners:
  mutation:
    command: bash
    args: ["-c", "npx stryker run --incremental && cat reports/mutation/mutation.json"]
    class: mutation
    when: ["src/**"]
    required: true
```

The mutation runner emits its report so fqe can read it. Two shapes are accepted:
- **Stryker (JS/TS):** print `reports/mutation/mutation.json` and fqe parses it.
- **Any tool (Python mutmut, Rust cargo-mutants, etc.):** emit a JSON line
  `{"runner":"mutation","exit_code":0,"mutation":{"killed":N,"surviving":M,"survivors":[{"key":"file:line:Mutator"}],"perFile":{...}}}`.

fqe scopes mutation to the PR diff, applies the equivalent-mutant allowlist, then maps the
result: survivors below threshold are a FLAG (advisory) or FAIL (blocking); too few mutants is
NEUTRAL. The mutation judge can only ADD a FLAG/FAIL, never clear one, so it sits below
contracts and money-invariants in the trust hierarchy by construction.

## Cost control (the gauntlet's blind spot)

Diff-scope every PR (`stryker --incremental`, `cargo-mutants --in-diff`, mutmut on changed
files) with a strict runner `timeout_ms`. Run full-repo mutation nightly, off the critical
path. Never promote to `blocking` until the false-red rate on real PRs is near zero, and use
the allowlist for the equivalent mutants that will never die.

## AI authoring, deterministically filtered

This is what makes AI authoring safe. Generate candidate tests (e.g. `fqe init --with-qodo`,
which uses ANTHROPIC_API_KEY), run them, and let this mutation judge decide which ones count.
An LLM test that runs the changed line but asserts nothing leaves the mutant alive, so the
gate FLAGs it and it never contributes to a green. The human reviews the surfaced drafts and
adopts the ones that genuinely raise the mutation score. The LLM proposes, the deterministic
judge disposes.

## Why advisory-first

Dropping a hard mutation gate on a team sprays false reds (equivalent mutants, flaky kills)
and the team removes the gate within a week. Advisory mode surfaces the signal without
blocking, you tune the allowlist and threshold against real data, and only then ratchet to
blocking. A gate the team trusts is worth more than a strict gate they route around.
