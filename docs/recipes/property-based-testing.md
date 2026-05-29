# Recipe: property-based testing

Stop testing example values and start testing the rule. Property-based testing asserts an invariant that must hold for EVERY input, then the framework throws hundreds of generated cases at it (and shrinks any failure to the smallest counterexample). An example-based test checks `add(2, 3) === 5`. A property test checks "for all a and b, `add(a, b) === add(b, a)`" and goes hunting for the input that breaks it.

## Why properties beat examples for payments

The bet-the-company tests at a payments company are money and state invariants, not specific numbers. Examples cover the inputs you thought of; properties cover the ones you did not, which is where the production incident lives.

The canonical payments invariants, written as properties:

- **Conservation:** sum of debits equals sum of credits. No money created or destroyed.
- **Rounding conserves cents:** splitting or allocating an amount never loses or invents a cent.
- **Idempotency:** an operation keyed by an idempotency key applied twice equals applied once.
- **Retry safety:** retrying a request produces the same end state as a single successful call.

These hold across the whole input space or they are bugs. That is exactly what a property test is built to check.

## Tooling

TypeScript: `fast-check`, runs inside vitest/jest. Python: `Hypothesis`, runs inside pytest.

```bash
npm i -D fast-check       # TS, alongside vitest
pip install hypothesis    # Python, alongside pytest
```

Minimal config worth setting on day one: a fixed seed and a bounded number of runs, so a failure is reproducible and CI time is predictable.

```ts
// vitest: fc.configureGlobal({ numRuns: 200, seed: 42 });
```
```python
# pytest: @settings(max_examples=200, derandomize=True)
```

## Example 1: a conservation invariant (TypeScript, fast-check)

`dedupeByCanonical` merges rows by canonical name and sums their counts. Its load-bearing rule is conservation: the total out equals the total in. This is the same shape as "no money is created or destroyed" in a ledger.

```ts
import { test } from "vitest";
import fc from "fast-check";
import { dedupeByCanonical } from "./aggregate";

// Rows with a name and a non-negative count.
const rowsArb = fc.array(
  fc.record({ name: fc.string({ minLength: 1, maxLength: 6 }), amount: fc.nat({ max: 100000 }) }),
  { maxLength: 60 },
);

// Case-fold the key so duplicates COLLIDE and the merge path actually runs.
const fold = (n: string) => n.toLowerCase();

test("CONSERVATION: total out == total in (none created or lost)", () => {
  fc.assert(
    fc.property(rowsArb, (rows) => {
      const out = dedupeByCanonical(rows, fold);
      const sumIn = rows.reduce((s, r) => s + r.amount, 0);
      const sumOut = out.reduce((s, r) => s + r.amount, 0);
      return sumIn === sumOut;
    }),
  );
});
```

The generator forces collisions on purpose. If every name were unique, the merge code would never run and the test would prove nothing.

## Example 2: an idempotency invariant (Python, Hypothesis)

Applying an operation under the same idempotency key twice must equal applying it once. The ledger after a duplicate request is identical to the ledger after a single request.

```python
from hypothesis import given, settings, strategies as st
from ledger import Ledger  # production code under test

postings = st.lists(
    st.tuples(st.text(min_size=1, max_size=8), st.integers(min_value=1, max_value=1_000_00)),
    max_size=40,
)

@settings(max_examples=200, derandomize=True)
@given(key=st.text(min_size=1, max_size=12), amount=st.integers(min_value=1, max_value=1_000_00))
def test_idempotent_apply(key, amount):
    once = Ledger()
    once.apply(key, amount)

    twice = Ledger()
    twice.apply(key, amount)
    twice.apply(key, amount)  # same key, must be a no-op the second time

    assert once.balance() == twice.balance()
    assert once.entries() == twice.entries()
```

`derandomize=True` plus a bounded `max_examples` keeps the run reproducible in CI. A failure shrinks to the smallest key and amount that breaks it, so the counterexample is readable.

## Wire it into fqe

There is nothing to wire. Property tests run under your normal test runner, so they flow through the existing fqe gate exactly like every other test. Your test command is already a runner in `.fqe.yml`, so a property added today is gated today, no new config.

A failing property is a normal test failure: a non-zero exit from vitest/pytest, which `fqe run` reads and maps to FAIL. Exit codes (the test command's own exit): **0 = pass, 2 = FAIL (merge blocked), 4 = INFRA** (runner could not start, neutral, never blocks on fqe's own failure to execute).

## The 10-minute on-ramp

Do not try to property-test the whole codebase. Pick your single highest-value money flow (the one whose corruption is a 2am page), write three to five invariants for it, done. Conservation and idempotency alone cover most of the real risk.

Ship those, watch them catch one regression, then add the next flow. A small set of invariants on the money path beats a large set on code that does not move money.

## Notes

- **Test the invariant, not the implementation.** "Output is sorted, then deduped, then summed" re-encodes the code and breaks on any refactor. "Total out equals total in" survives the rewrite and still catches the bug. Assert the rule, not the steps.
- **Weak generators hide bugs.** A generator that only emits small positive integers never reaches zero, the max, or an empty list. Generate the full domain (use `fc.nat`/`st.integers` with explicit bounds that include the edges) or the test is green theater.
- **Force collisions and duplicates.** Merge, dedupe, and idempotency paths only run when inputs actually overlap. Case-fold keys, reuse idempotency keys, repeat amounts. Otherwise you exercise the trivial all-unique branch and prove nothing about the path that matters.
- **Pin a seed and bound the sizes.** Unbounded generators produce non-deterministic flakes and slow CI. Set a fixed seed and a `numRuns`/`max_examples` cap so a red build is reproducible and a counterexample is the same every time.
- **Pair with the coverage ratchet.** Properties prove the money path is correct across inputs; the ratchet (`docs/recipes/coverage-ratchet.md`) proves the path stays covered as the code grows. Use both.
