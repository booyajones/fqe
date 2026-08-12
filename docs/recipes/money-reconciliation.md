# Recipe: money-reconciliation

Judge the ledger itself, not the tests. Coverage, mutation testing, and the verdict gate all judge the tests. `fqe reconcile` judges the books. It re-derives the double-entry invariant from the raw entries (sum of debits equals sum of credits, per-transaction AND in aggregate) and HALTs when the books do not balance or an authorization is stranded.

Deterministic, no LLM in the path. The same ledger always produces the same verdict.

## The deterministic double-entry reconcile

The engine takes raw entries and re-derives the invariant from scratch. It does not trust a precomputed balance field. It sums the debits, sums the credits, and demands they tie, both for the whole ledger and for every individual transaction.

Why both levels: a globally balanced ledger can still hide a per-transaction break. Transaction A is over by 100 cents, transaction B is under by 100 cents, the aggregate ties to zero, and a single per-txn check that only looked at the total would pass a broken book. The reconciler checks each transaction's net (debits minus credits) AND the aggregate drift.

The ledger JSON:

```json
{
  "entries": [
    { "txnId": "T1", "account": "supplier_payable", "debitCents": 28500, "creditCents": 0 },
    { "txnId": "T1", "account": "cash",              "debitCents": 0,     "creditCents": 28500 },
    { "txnId": "T2", "account": "fee_income",        "debitCents": 0,     "creditCents": 285 },
    { "txnId": "T2", "account": "supplier_payable",  "debitCents": 285,   "creditCents": 0 }
  ],
  "authorizations": [
    { "authId": "A1", "amountCents": 50000, "capturedCents": 50000, "voided": false, "expiresAt": "2026-06-30T00:00:00Z", "status": "captured" }
  ],
  "driftThresholdCents": 0,
  "now": "2026-05-31T00:00:00Z"
}
```

Each entry has exactly one of `debitCents` or `creditCents` greater than zero. An entry with both sides positive, or neither, is a malformed double-entry line and throws. It is never read as balanced.

## Integer-cents discipline

Money is handled in integer minor units (cents) only. There is one choke point, `assertCents`, and every monetary value passes through it.

A float cents value throws. `10.5` is rejected at the door. This is not pedantry. A reconciliation engine that silently rounds a float is exactly how a penny of drift hides a real defalcation. Rounding the problem away is how you stop seeing it. So the engine refuses floats, NaN, Infinity, negatives, and non-numbers. They throw rather than slip through as a tolerated rounding.

Carry money as integer cents everywhere upstream too. Convert to a display string only at the edge. The moment a float enters the math, the guarantee is gone.

## The drift threshold

`driftThresholdCents` is the tolerance for aggregate debit-credit drift, in cents. The default is 0, which means the books must tie to the penny. There is no slack.

Set it above zero only with a written reason, and keep it tiny. A non-zero threshold is a deliberate, reviewed decision, not a convenience to make a red reconcile green. The threshold value itself is part of the ledger input, so it is visible in the diff and reviewable like any other answer-key change.

Per-transaction imbalances are never subject to the threshold. The threshold applies to aggregate drift only. Any single transaction whose debits do not equal its credits is a break, full stop.

## Orphan authorizations

An orphan authorization is money authorized and then stranded. The classic uncaptured-auth leak. The reconciler flags an authorization as orphaned when all three hold:

- it is NOT voided (still live),
- it was under-captured (`capturedCents` is less than `amountCents`), AND
- it has already expired (`expiresAt` is before `now`).

That is funds the customer authorized, that were never fully taken, on an auth that can no longer be captured. It sits in limbo. The reconciler surfaces every orphan auth by id.

Time is passed in as `now`, an ISO string. The engine never reads the system clock, so a given (ledger, now) pair is reproducible forever. A bad or missing `now`, or a bad `expiresAt`, throws, so the orphan check can never silently no-op against an invalid time.

## The `fqe reconcile` command

```
fqe reconcile --ledger ledger.json
```

- `--ledger` (required): the ledger JSON. `{ entries, authorizations, driftThresholdCents, now }`.

It prints the full result (balanced, drift, totalDebits, totalCredits, perTxnImbalances, orphanAuths) plus the verdict and reasons.

Exit codes: **0 = PASS, 2 = FAIL (HALT)**. It HALTs when the ledger is not balanced (aggregate drift over threshold, or any per-txn imbalance) OR any orphan auth exists.

The reasons name the concrete break: `LEDGER_DRIFT` with the two totals and the gap, `PER_TXN_IMBALANCE` with the offending txn ids, `ORPHAN_AUTH` with the stranded auth ids.

## Running it continuously with an automatic halt on drift

The reconcile is not only a PR gate. Run it on a schedule against the live ledger so a break is caught within the cycle, not at month-end close.

The pattern: a scheduled job pulls the current ledger snapshot, runs `fqe reconcile`, and keys an automatic halt off the exit code. The exit code is the signal, not parsed text, so an unreadable snapshot fails closed rather than reporting clean.

```yaml
# .github/workflows/fqe-reconcile-watch.yml
on:
  schedule:
    - cron: "*/15 * * * *"   # every 15 minutes (GHA crons can lag; Vercel Cron is tighter)
jobs:
  reconcile-watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: snapshot the live ledger
        run: ./scripts/dump-ledger.sh > ledger.json   # your extract, integer cents
      - name: reconcile or halt
        run: |
          set +e
          npx --yes -p github:booyajones/fqe#fqe-v0.18.4 fqe \
            reconcile --ledger ledger.json
          RC=$?; set -e
          # 0 = balanced. 2 = HALT. anything else = could not run, fail closed.
          case "$RC" in
            0) echo "ledger balanced" ;;
            2) ./scripts/halt-payments.sh "reconcile HALT"; exit 1 ;;
            *) echo "::error::reconcile could not run (exit $RC), failing closed"; \
               ./scripts/halt-payments.sh "reconcile unrunnable"; exit 1 ;;
          esac
```

`halt-payments.sh` is the kill switch for the money path: flip a feature flag, drain the disbursement queue, page on-call. The reconcile is the trigger, the halt is the action. Wire the halt to whatever stop control your payment path already has.

## Notes

- **A halt is the correct outcome, not a failure of the tool.** When the books do not tie, stopping is right. Letting money keep moving on an unbalanced ledger is the actual failure.
- **The default threshold is zero, and that is the point.** Books tie to the penny. Any tolerance is a reviewed exception with a reason, kept tiny.
- **Pair it with property tests on the same invariants.** `docs/recipes/property-based-testing.md` proves conservation and idempotency across the whole input space before code merges. This reconcile proves the live ledger holds them right now. Pre-merge proof plus runtime backstop.
- **Integer cents, end to end.** The engine refuses floats. Keep the discipline upstream so the snapshot never carries one in.
