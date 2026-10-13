# Recipe: AI test proposals and mutation testing

An AI can propose tests. Engineers review and apply them; FQE and a mutation runner then judge the resulting commit using deterministic evidence. Mutation strength does not establish that a test encodes the correct business rule.

## Wire the gate first

```bash
npx --yes -p github:booyajones/fqe#fqe-v0.19.1 fqe init --with-mutation
npm install --save-dev @stryker-mutator/core
```

This guide targets v0.19.1. Until its tag exists, use the reviewed full commit SHA and pass the same SHA to `init --ref`. Review the generated config and both workflows. Bootstrap the publisher on the default branch before requiring its checks.

The canonical [Stryker wrapper](../../cli/templates/fqe_stryker_runner.js) removes stale reports, executes Stryker and emits a fresh `mutation_report`. The configured mutation judge evaluates killed/surviving counts, file scope, threshold, minimum mutants and suppression caps. Missing evidence fails according to advisory/blocking mode. The standard profile starts advisory; `--payments --with-mutation` selects a blocking judge. Measure false reds and runtime before enforcing a threshold.

```yaml
mutation:
  mode: advisory
  threshold: 80
  min_mutants: 1
runners:
  stryker-mutation:
    command: node
    args: [scripts/fqe_stryker_runner.js]
    always_run: true
    required: true
    class: mutation
    timeout_ms: 900000
```

Do not convert mutants into Wilson attack-success trials. Generated code transformations are not a sampled independent adversarial experiment. Keep the parser's full counts; do not discard no-coverage or other unfavorable outcomes to improve the result. For formats other than Stryker, preserve the report's honest aggregate counts and scope.

The wrapper resolves the project's installed `@stryker-mutator/core` and runs its JavaScript CLI through Node, including on Windows. It never downloads a missing runner through `npx`; install Stryker before running the gate. CI exercises the generated wrapper against real Stryker on Linux and Windows, including killed mutants, surviving mutants and failed-run report freshness.

## Optional Claude proposals

Install [the proposal template](../../workflows/fqe-write-tests.yml.template) at `.github/workflows/fqe-write-tests.yml` through normal review and configure the provider key according to your approved account policy. A trusted engineer adds the `fqe-write-tests` label to an open same-repository PR.

The workflow runs from the default branch, resolves the live PR head and protected base, and checks out only the base. It supplies the action's explicit read-only GitHub token, treats the diff as untrusted input and does not run project commands. Output is a `test-proposal-<run>-<attempt>` artifact containing an untested patch and the intended head SHA. It cannot push, approve or merge through that token.

Download and inspect the patch. Confirm the PR still has the named head, apply it in a review branch, and run CI. A path allowlist prevents publishing non-test changes; this is still a proposal, not proof that the generated tests pass. Provider execution, spending and generated-test quality require a dedicated sandbox run and actual usage receipts.

People must define money-path invariants for balances, idempotency, rounding, reconciliation and partner contracts. A model can kill mutants while asserting the wrong financial rule. Use proposals for ordinary plumbing where reviewers can validate the expected behavior.

`--with-qodo` remains a compatibility hook for a separately configured test author. It does not provision a provider, install an archived package or prove that generation occurred. Keep authorship outside the trusted publisher and do not put provider credentials into untrusted PR runners. The gate works with human-authored tests alone.

## Acceptance before adoption

Verify a valid report passes, a surviving mutant is reported, missing/stale evidence blocks as configured, and a failed required runner blocks. Inspect the exact-head receipt and the native publisher result. For a payments application, add independently defined money invariants and a representative payment sandbox; a mutation score cannot substitute for that acceptance.
