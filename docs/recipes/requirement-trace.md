# Recipe: requirement-trace

Prove you have the tests you NEED, not just that the tests you HAVE are honest. Coverage and mutation testing judge the tests in the repo. Neither notices a requirement that shipped with no test at all. `fqe trace` builds a requirement-to-test matrix and fails the build when a money or security requirement has no covering test, or a money or security test traces to no requirement.

Deterministic, no LLM in the path.

## The requirement-to-test matrix

The matrix is a bidirectional link between two declared lists.

- **requirements**: each has an `id` and a `class` (the fqe test-class: money, security, unit, ...).
- **tests**: each has a `name`, a `class`, and a `requirementIds` array naming the requirements it covers.

`fqe trace` walks both and produces three buckets:

- **covered**: requirement ids that have at least one covering test.
- **orphanRequirements**: requirement ids with NO covering test.
- **orphanTests**: names of strict-class tests whose `requirementIds` is empty.

A test pointing at a requirement id that was never declared does not invent a covered requirement. Coverage only counts requirements that actually exist.

The matrix JSON:

```json
{
  "requirements": [
    { "id": "REQ_FEE_BPS",       "class": "money" },
    { "id": "REQ_IDEMPOTENT",    "class": "money" },
    { "id": "REQ_WEBHOOK_HMAC",  "class": "security" },
    { "id": "REQ_LIST_SORT",     "class": "unit" }
  ],
  "tests": [
    { "name": "fee bps matches spec",   "class": "money",    "requirementIds": ["REQ_FEE_BPS"] },
    { "name": "duplicate key is no-op", "class": "money",    "requirementIds": ["REQ_IDEMPOTENT"] },
    { "name": "rejects forged webhook", "class": "security", "requirementIds": ["REQ_WEBHOOK_HMAC"] }
  ]
}
```

## Money and security are strict classes

The strict classes are `money` and `security`. Their traceability gaps are a hard FAIL that blocks the merge. The reasoning is plain:

- An untested money requirement is an un-reconciled balance waiting to happen.
- An untested security requirement is an un-audited attack surface.

Every other class (unit, integration, e2e, ...) is reported as a FLAG-level advisory gap. You see it, but it does not block. The strict set is locked in the gate so a caller can widen it but never quietly narrow it below policy.

Two ways a strict requirement fails the build:

1. **Uncovered requirement.** A money or security requirement appears in `requirements` but no test names its id. In the example above, if you delete the `duplicate key is no-op` test, `REQ_IDEMPOTENT` becomes an orphan requirement of class money, and the build FAILs.

2. **Orphan strict test.** A money or security test exists with an empty `requirementIds`. It is testing something nobody declared, or it lost its requirement link. Either way it is a strict gap and FAILs. Link it to a requirement or remove it.

## Orphan equals block

For the strict classes, orphan equals block. State it that way to the team so there is no ambiguity.

- An orphan money or security REQUIREMENT (no covering test) blocks the merge.
- An orphan money or security TEST (no requirement link) blocks the merge.

The gate also fails closed on classification. If there is an orphan requirement but no requirements list was passed in to classify it, or the orphan id is not present in the requirements list, the gate cannot prove the gap is harmless, so it FAILs. A gap it cannot classify is never treated as safe.

A malformed matrix (a non-array requirements or tests field, a requirement missing an id or class, a test missing a name or class, a non-array `requirementIds`) throws rather than being read as empty. A dropped requirement array cannot pass by looking like zero requirements.

## The `fqe trace` command

```
fqe trace --matrix matrix.json
```

- `--matrix` (required): the matrix JSON. `{ requirements, tests }`.

It prints the full matrix (covered, orphanRequirements, orphanTests) plus the verdict and reasons as one JSON object.

Exit codes: **0 = PASS, 2 = FAIL** (a strict gap blocks the merge), **3 = FLAG** (only non-strict advisory gaps, reported but not blocking).

The reason strings name the gap and the class. `TRACE_UNCOVERED_REQUIREMENT` for a strict requirement with no test, `TRACE_ORPHAN_TEST` for a strict test with no requirement, `TRACE_GAP (advisory)` for a non-strict requirement gap, and `TRACE_UNCLASSIFIED_ORPHAN` for the fail-closed case where a gap could not be classified.

## Keeping the matrix honest

The matrix is only as good as the declarations. Two practices keep it from rotting:

- **Tag the test class at the test, and the requirement class at the requirement.** Generate the matrix from those tags rather than hand-maintaining a third file that drifts.
- **Pair it with oracle-guard.** The matrix is an answer key. Editing it to delete a requirement is exactly the kind of self-greening move that `docs/recipes/oracle-tamper.md` watches for. Treat the matrix as ground truth.

## Notes

- **Trace answers a different question than coverage.** Coverage says a line ran. Mutation says a test would catch it breaking. Trace says a declared requirement has a test pointed at it at all. A requirement nobody wrote a test for has 0% coverage on a line that may not even exist yet, so coverage stays silent. Trace speaks up.
- **The strict set is policy, not preference.** Money and security block. Do not narrow them to get a red build green. A red trace on a money requirement is the gate doing its job.
- **A FLAG is a backlog item, not a pass.** Non-strict gaps do not block, but they are real holes. Work them down over time. The strict gaps are the ones that stop the merge today.
