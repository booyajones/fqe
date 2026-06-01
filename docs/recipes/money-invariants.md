# Money invariants: make a double-pay impossible to ship green (v0.11)

For a payments company the single highest-severity bug is paying twice: a retry storm, a
crash between debit and credit, a duplicated webhook. A unit test that checks the happy path
does not catch it. A property test does, and fqe can REFUSE a green for a money repo that
never proved it.

## Require it in the gate

```yaml
# .fqe.yml
require_money_idempotency: true   # no green without a passing idempotency-invariant test

runners:
  money-invariants:
    command: python
    args: ["-m", "pytest", "-q", "--junitxml=inv.xml", "tests/test_money_invariants.py"]
    class: money
    always_run: true
    required: true
    invariant: [idempotency, double-spend]   # what this runner proves
    report: junit:inv.xml
    inventory_cmd: python -m pytest --collect-only -q tests/test_money_invariants.py
    inventory_format: pytest-collect
    min_tests: 1
    reconcile: true
    strict_coverage: true
```

With `require_money_idempotency: true`, fqe FAILs unless a runner ran AND passed AND declares
`invariant: [idempotency]`. Pair it with coverage-liveness (above) so the invariant test
cannot be empty or skipped.

## The invariant (Python, Hypothesis)

```python
# tests/test_money_invariants.py
from hypothesis import given, strategies as st

# idempotency: settling the SAME payment id twice moves money exactly once.
@given(amount_cents=st.integers(min_value=1, max_value=10_000_000),
       times=st.integers(min_value=2, max_value=5))
def test_settle_is_idempotent(amount_cents, times):
    ledger = Ledger()
    pid = "pay-123"
    for _ in range(times):
        settle(ledger, payment_id=pid, amount_cents=amount_cents)
    assert ledger.balance_for(pid) == -amount_cents   # debited exactly once
    assert ledger.transfer_count(pid) == 1

# double-spend: concurrent/duplicated settle of one id never pays more than once.
@given(amount_cents=st.integers(min_value=1, max_value=10_000_000))
def test_no_double_spend_under_duplicate(amount_cents):
    ledger = Ledger()
    pid = "pay-456"
    results = [settle(ledger, payment_id=pid, amount_cents=amount_cents) for _ in range(3)]
    assert sum(1 for r in results if r.moved_money) == 1
```

## The invariant (JS/TS, fast-check)

```ts
import fc from 'fast-check';
test('settle is idempotent', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 2, max: 5 }),
    (cents, times) => {
      const ledger = new Ledger();
      for (let i = 0; i < times; i++) settle(ledger, { paymentId: 'pay-123', cents });
      expect(ledger.balanceFor('pay-123')).toBe(-cents);
      expect(ledger.transferCount('pay-123')).toBe(1);
    }));
});
```

## Why a property test, not an example

An example test checks one input. A property test generates thousands and shrinks any failure
to the smallest reproducer, so it finds the boundary (a zero amount, a max-int overflow, the
third retry) you did not think to write by hand. The human still authors the PROPERTY (the
invariant that must hold), which is the irreducible spec-owner role. fqe makes sure that
property exists and passes before money code ships.

## Add a chaos dimension (Toxiproxy, optional)

Run the invariant with a Toxiproxy stub injecting a timeout between debit and credit, so the
idempotency proof holds under the crash window that causes real double-pays. Declare it as a
`class: integration` runner so coverage-liveness still proves it executed.
