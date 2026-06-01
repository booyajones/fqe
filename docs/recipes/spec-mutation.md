# Recipe: spec-mutation

Kill the tautological test. Ordinary mutation testing mutates the CODE and asks whether the tests would catch a broken implementation. Spec-mutation mutates the REQUIREMENT and asks whether the tests are actually pinned to that requirement. A test that still passes when you corrupt the rule it claims to check never encoded the rule. It encoded the behavior. That is a tautology, and it is green theater.

Run it with `fqe spec-mutate`. Deterministic, no LLM in the path.

## What spec-mutation is

A test can pass for the wrong reason. The most common wrong reason at a payments company is a test written by reading the code, not the spec. The author runs the code, sees it output `0.05`, and writes `assert fee == 0.05`. The test now passes against the code and against any code-mutant the test was co-derived from, because the assertion was reverse-engineered from the behavior. The requirement was never in the test.

Spec-mutation finds these. The move is simple. Take the requirement, corrupt it, and prove a test fails.

- KILLED means the test suite FAILS against the corrupted requirement. The test was anchored to the rule, so breaking the rule breaks the test. Good.
- SURVIVED means the test suite still PASSES against the corrupted requirement. The test is not pinned to the rule. It is a tautology. Bad.

A single survivor is a proven tautology, so the default threshold is 1.0. Every spec-mutant must be killed.

## The spec line format

The spec is a machine-readable file, one rule per line. Each non-blank, non-comment line is `RULE_ID: expression`.

```
# Finexio fee + rounding rules (the requirement, authored by the spec owner)
CARD_FEE_BPS: fee_bps == 285
ROUNDING_MODE: round(amount, HALF_EVEN)
MIN_CAPTURE: captured_cents >= 1
DUPLICATE_KEY_IS_NOOP: apply(key) twice == apply(key) once
```

Rules of the format, enforced fail-closed by the parser:

- Blank lines and lines whose first non-whitespace char is `#` are skipped.
- Every other line must contain a colon. The part before the first colon is the id, the rest is the expression.
- An id must be a non-empty token of letters, digits, and underscores.
- An expression must be non-empty after trimming.
- A malformed line throws. The parser never silently drops a rule it could not read, because a dropped rule is an ungated requirement.

The mutation operators run against the expression. The frozen, named, deterministic set:

- **flip_comparison** swaps the first comparison operator (`<` to `<=`, `==` to `!=`, and the reverse). `>= 1` becomes `> 1`.
- **increment_literal** adds 1 to the first standalone numeric literal. `285` becomes `286`.
- **halve_literal** halves the first standalone numeric literal. `285` becomes `142.5`.
- **swap_boolean** flips the first `true` or `false`.
- **swap_rounding** swaps a rounding keyword. `HALF_EVEN` becomes `HALF_UP`, every other mode becomes `DOWN`.

Each operator that does not apply to a line is skipped, and a mutant identical to the original is skipped. The order is the deterministic generation order, so the same spec always yields the same mutants.

## Source independence is the whole point

Spec-mutation only works if three roles are separate.

1. The **spec author** writes the requirement (the spec lines above).
2. The **code author** writes the implementation.
3. The **test author** writes the assertions.

When one person plays all three, the test drifts toward the code by gravity. You assert what you just watched run. Spec-mutation breaks that gravity by making the spec a separate artifact that the test must agree with. Corrupt the spec, and a test that was secretly reading the code keeps passing. It gets caught.

The discipline that makes this real: the test reads its expected values FROM the spec, not from a hand-typed literal that happens to match the code.

## Wiring tests to read expected values from the spec

Do not hardcode the expected value in the test. Load it from the spec file. The test now has one source of truth for what is correct, and that source is not the code.

TypeScript, reading a parsed spec map:

```ts
import { test, expect } from "vitest";
import { loadSpec } from "./spec";        // parses RULE_ID: expression lines
import { feeBps } from "./pricing";       // production code under test

const spec = loadSpec("spec/pricing.spec");

test("CARD_FEE_BPS: fee matches the requirement, not the code", () => {
  // expected comes from the spec, never from a literal pasted in here
  const expected = spec.number("CARD_FEE_BPS");   // 285
  expect(feeBps()).toBe(expected);
});
```

Python, same shape:

```python
from spec import load_spec     # parses RULE_ID: expression lines
from pricing import fee_bps    # production code under test

SPEC = load_spec("spec/pricing.spec")

def test_card_fee_bps():
    # expected is read from the spec, so corrupting the spec line breaks this
    expected = SPEC.number("CARD_FEE_BPS")   # 285
    assert fee_bps() == expected
```

Now run the spec-mutation harness. It corrupts `CARD_FEE_BPS: fee_bps == 285` to `286`, re-runs the suite against the corrupted spec, and the test above fails because `feeBps()` still returns `285` while the spec now says `286`. The mutant is KILLED. The test was anchored.

If instead the test had been `expect(feeBps()).toBe(285)` with a hardcoded literal, corrupting the spec changes nothing the test reads, the test keeps passing, the mutant SURVIVES, and `fqe spec-mutate` fails the build. That is the tautology being caught.

## The `fqe spec-mutate` command

The harness that generates the mutants, re-runs the suite against each, and tallies kills produces a small report. `fqe spec-mutate` reads that report and renders the verdict.

```
fqe spec-mutate --report report.json [--threshold N]
```

The report declares two numbers:

```json
{ "mutantsTotal": 12, "mutantsKilled": 12 }
```

- `--report` (required): the spec-mutation report. `{ mutantsTotal, mutantsKilled }`.
- `--threshold` (optional, default 1.0): the minimum kill ratio. 1.0 means every spec-mutant must be killed, because one survivor is a proven tautology.

Exit codes: **0 = PASS, 2 = FAIL** (a spec-mutant survived). It fails closed: `mutantsTotal` of 0 throws, because with zero mutants you cannot prove the tests are anchored, and that is not a pass. `mutantsKilled` greater than `mutantsTotal`, a float count, or a negative count all throw rather than slip through.

The FAIL reason names the survivors and tells you the fix: re-anchor the assertion to the requirement.

## Notes

- **A surviving spec-mutant is never a false alarm.** It is a test that passes when the rule is wrong. Either the test reads a hardcoded literal instead of the spec, or the requirement is not actually exercised. Both are real.
- **Keep the spec separate from the test fixtures.** If the test author also owns the spec file, the gravity returns. The spec belongs to the spec owner.
- **Pair it with the mutation gate, do not replace it.** Code-mutation proves the tests catch a broken implementation. Spec-mutation proves the tests are pinned to the requirement. Different failure modes. Run both.
- **Start with the money rules.** Fee bps, rounding mode, idempotency, capture floors. These are the requirements whose corruption is a 2am page, and they are the ones most often tested by reading the code.
