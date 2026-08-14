# Recipe: runtime-canary

The production runtime layer. Everything else in fqe gates a PR before it merges. This layer watches the live path after it ships, because some failures only appear against real infrastructure: a duplicate idempotency key racing itself, a webhook acknowledgement that never lands, a clock that skews between two services, a downstream that times out under load.

This recipe documents the design and the deterministic reconcile-halt that backs it. The runtime layer is the one part of fqe that cannot be proven on a laptop. It needs live test accounts and credentials.

## This needs Chris to provide live infrastructure

Be explicit. This layer cannot be built or run without Finexio production-adjacent access that only Chris can grant:

- **Live test accounts** on the payment rails (the J.P. Morgan and Grasshopper path, the card program), scoped to small-dollar synthetic transactions.
- **Credentials** for the live API, webhook endpoints, and the ledger read path, held as CI secrets, never in the repo.
- **A sandboxed money pool** the canary draws from, ring-fenced so a synthetic transaction can never touch a real supplier.
- **A kill switch** the reconcile-halt can pull (the same disbursement-queue drain and feature flag the scheduled reconcile uses).

Until those exist, this recipe is a design. The pre-merge layers (spec-mutation, trace, reconcile against a snapshot, property tests) run today on any machine. The runtime canary runs only against the live system Chris stands up.

## Synthetic small-dollar canary transactions

The canary pushes a real transaction through the live path on a schedule. Small-dollar, synthetic, against a ring-fenced test supplier, but otherwise the genuine production code path: the same API, the same queue, the same ledger writes, the same webhook round-trip.

The point is to exercise the path a customer hits, not a mock of it. A unit test proves a function. A canary proves the wiring between services, the credentials, the rate limits, the timeouts, and the rails, all of which only exist in production.

Each canary run:

1. Initiates a small-dollar payment through the live API with a fresh idempotency key.
2. Waits for the webhook acknowledgement that the rail accepted it.
3. Reads the resulting ledger entries back.
4. Hands those entries to `fqe reconcile`. If the books do not tie, halt.

A failed canary is an early warning that the live path is broken before a real customer finds out.

## Idempotency torture

Idempotency is the invariant most likely to hold in a unit test and break in production, because the production breaks are races and dropped messages that a single-threaded test never reproduces. The torture suite fires the failure modes on purpose.

- **Duplicate keys fired concurrently.** Two requests with the same idempotency key sent at the same instant, racing each other. The end state must equal one application of the operation. A naive check-then-write loses this race and double-pays. The canary fires N concurrent duplicates and reconciles the result.
- **Dropped webhook acknowledgements.** Initiate a payment, then drop or delay the rail's acknowledgement webhook. The system must not re-initiate and double-send when the ack goes missing. Retry safety means a retried request produces the same end state as a single successful call.
- **Clock skew.** Two services whose clocks disagree by seconds or minutes. An idempotency window, a TTL, or an expiry computed against the wrong clock is a real production break. The canary injects skew between the initiating service and the rail and checks the end state still reconciles.

Each torture case ends the same way every canary does: read the ledger back, run `fqe reconcile`, halt on a break.

## Chaos and fault injection

Beyond the scripted torture cases, inject faults into the live path and prove the system degrades safely rather than corrupting the ledger.

- Kill a downstream mid-transaction and confirm the transaction either completes or rolls back cleanly, never half-applied.
- Inject latency and timeouts on the rail call and confirm a timeout does not produce a phantom send.
- Drop the ledger write and confirm the system detects the missing entry rather than reporting success.

Chaos injection is opt-in and rate-limited, run on a schedule against the sandboxed pool, never against real disbursements. The success criterion is always the same: after the fault, the books reconcile, or the path halts.

## The deterministic reconcile-halt that backs it

Every runtime check, canary, torture case, and chaos run, terminates in the same deterministic backstop: `fqe reconcile`. The runtime layer is the thing that injects the interesting conditions. The reconcile is the thing that decides PASS or HALT, and it is deterministic with no LLM in the path, so the same ledger state always produces the same verdict.

This is the safe division of labor. The probes are messy and live and full of timing. The judgement is clean, reproducible, and integer-cents strict (see `docs/recipes/money-reconciliation.md`). A canary that cannot decide its own pass-fail would be theater. By routing every runtime check through the reconcile, the verdict is the same trustworthy gate the PR path uses.

The halt:

```yaml
# .github/workflows/fqe-runtime-canary.yml (runs only with live creds present)
on:
  schedule:
    - cron: "*/30 * * * *"
jobs:
  canary:
    runs-on: ubuntu-latest
    environment: production-canary    # holds the live test creds as secrets
    steps:
      - uses: actions/checkout@v4
      - name: run synthetic canary + torture suite
        env:
          FQE_CANARY_API_KEY: ${{ secrets.FQE_CANARY_API_KEY }}
          FQE_CANARY_SUPPLIER: ${{ secrets.FQE_CANARY_SUPPLIER }}
        run: ./scripts/run-canary.sh > ledger.json   # initiates, tortures, reads ledger back
      - name: reconcile or halt
        run: |
          set +e
          npx --yes -p github:booyajones/fqe#fqe-v0.18.14 fqe \
            reconcile --ledger ledger.json
          RC=$?; set -e
          case "$RC" in
            0) echo "canary balanced" ;;
            2) ./scripts/halt-payments.sh "canary HALT"; exit 1 ;;
            *) echo "::error::canary reconcile unrunnable (exit $RC), failing closed"; \
               ./scripts/halt-payments.sh "canary unrunnable"; exit 1 ;;
          esac
```

The exit code is the signal, not parsed text. 0 is balanced, 2 is HALT, anything else fails closed and pulls the halt anyway. A canary that cannot run is treated as a canary that failed, because a silent runtime gate is worse than none.

## Build order

1. **Stand up the sandbox.** Chris provisions live test accounts, credentials, the ring-fenced money pool, and the kill switch. Nothing below runs without these.
2. **Synthetic canary first.** Initiate, wait for ack, read ledger, reconcile. Prove the happy path through the live wiring.
3. **Idempotency torture next.** Concurrent duplicate keys, dropped acks, clock skew. These are the breaks that matter most for payments.
4. **Chaos last.** Fault injection once the canary and torture suite are stable, so a chaos failure is clearly the injected fault and not a flaky canary.

## Notes

- **This is the only fqe layer that needs live infrastructure.** Everything else is deterministic and laptop-runnable. State that clearly to anyone adopting fqe, so they do not expect the canary to work without the sandbox.
- **Synthetic only, ring-fenced always.** A canary transaction must never be able to reach a real supplier. The sandboxed pool and a dedicated test supplier are not optional.
- **The reconcile is the judge, the canary is the probe.** Keep them separate. The probe creates the condition. The deterministic reconcile decides the verdict. Do not let the probe grade itself.
- **A halt is the designed outcome.** When the live path breaks, stopping payments is correct. The canary exists to pull that halt before a customer does.
