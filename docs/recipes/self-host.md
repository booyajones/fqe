# Self-hosting the v0.8.0 backstop

fqe gates itself with the same three checks it ships: spec-mutation, requirement-trace, and money-reconciliation. This is the pattern any repo copies to put the autonomous-QA backstop on its own money paths. The proof that it works is that the fqe repo runs it on every push (`.github/workflows/fqe-selfhost.yml`).

The point of all three: a test that passes is not enough. The test has to be anchored to a written requirement, the requirement has to exist, and the money has to balance by deterministic arithmetic that no model can talk its way around.

## 1. Anchor your tests to a spec (spec-mutation)

Write your money rules in a machine-readable spec, one rule per line, as `RULE_ID: value`:

```
# spec/fqe-invariants.spec
BLAST_OUTBOUND: 0.05
BLAST_MCP_READ: 0.03
BLAST_MCP_WRITE_OR_FINANCIAL: 0.01
```

Write a test that reads the spec (not the code) for the expected values and asserts the code matches. The spec is the authority. See `cli/test/selfhost_spec.test.js` for the shape, including reading the spec path from `FQE_SPEC_PATH` so the runner can point it at a mutated copy.

A small runner generates a mutant for every rule, re-runs the test against each mutated spec, and tallies kills (`cli/scripts/fqe_specmutate_run.js`). A mutant is killed when the test fails against it. A surviving mutant means the test was a tautology pinned to the code, not the requirement.

```bash
node scripts/fqe_specmutate_run.js > spec-mutation-report.json   # {"mutantsTotal":N,"mutantsKilled":M}
fqe spec-mutate --report spec-mutation-report.json               # exit 0 PASS / 2 FAIL
```

The runner fails closed: it checks the baseline test passes on the unmutated spec first, and a spawn error is a runner failure, never counted as a kill.

## 2. Trace every money requirement to a test

Declare your requirements and which tests cover them in a matrix:

```json
{
  "requirements": [{ "id": "REQ-MONEY-RECONCILE-HALT", "class": "money" }],
  "tests": [{ "name": "test/reconcile.test.js", "class": "money", "requirementIds": ["REQ-MONEY-RECONCILE-HALT"] }]
}
```

```bash
fqe trace --matrix spec/fqe-trace.json   # exit 0 PASS / 2 FAIL / 3 FLAG
```

A money or security requirement with no covering test FAILs. A money or security test pointing at no real requirement FAILs. The money/security floor cannot be narrowed away by the caller.

## 3. Halt on a money imbalance (reconcile)

Feed a double-entry ledger snapshot (integer cents only):

```json
{
  "entries": [
    { "txnId": "t1", "account": "cash", "debitCents": 10000, "creditCents": 0 },
    { "txnId": "t1", "account": "revenue", "debitCents": 0, "creditCents": 10000 }
  ],
  "authorizations": [],
  "driftThresholdCents": 0,
  "now": "2026-06-01T00:00:00Z"
}
```

```bash
fqe reconcile --ledger spec/fqe-ledger-fixture.json   # exit 0 PASS / 2 FAIL (halt)
```

It halts on aggregate drift, a per-transaction imbalance, an orphaned authorization (expired and uncaptured), or an over-capture. Timestamps must carry a timezone, and cents must be safe integers, so the verdict is identical on every machine. No model is in this decision.

## Wire it into CI

Copy `.github/workflows/fqe-selfhost.yml`. It runs the three steps above on every push and pull request, and any one of them going red blocks the merge. For a payments repo, point the reconcile step at a real ledger snapshot from your database (a post-merge job that pulls the live balance), and make `reconcile` a required check.

## Why this is the floor under autonomous QA

A normal test suite tells you the code does what the tests say. Self-hosting tells you the tests say what the requirements say (spec-mutation), that every money requirement is actually tested (trace), and that the money balances by arithmetic a model cannot override (reconcile). That is the part a human QA owner used to hold in their head. Now it runs on every push.
