# Shadow-trial scorecard (v0.18): earn the "required gate" decision

Before a team makes `fqe/pass` a REQUIRED check, the fair question is: "if you had run over our
recent history, would you have lied to us?" `fqe scorecard` answers it from the receipts fqe
already emits, so you can run a non-blocking shadow trial first and decide on evidence.

## Run it

fqe writes a `QA-RESULT.yml` receipt every run (uploaded as a workflow artifact). Collect the
last N runs' receipts into one directory, then:

```bash
# download the qa-receipt artifacts from recent runs into ./receipts/, then:
fqe scorecard --dir ./receipts/
fqe scorecard --dir ./receipts/ --format json   # for dashboards
```

## What it reports (the three adoption metrics)

1. **false-red rate** (target ~0%): the fraction of FAIL verdicts that a human bypassed. A
   bypassed FAIL is the operational signal of a red the team judged wrong. If this is high, the
   gate is too strict and would lose trust as a required check.
2. **gate wall-time** (p50 / p95 / max): the gate's own runtime, from each receipt's
   `started_at`/`finished_at`. Compare it to your total CI time for the "< X%" bar (the receipt
   does not know your total CI time, so the scorecard reports the gate's time and leaves the
   ratio to you).
3. **true catches** (target >= 1): FAIL verdicts that stuck (were not bypassed). At least one
   real catch over the trial is the evidence that the gate earns its place.

Plus the verdict distribution, the bypass count, and the modeled human-review minutes.

## The shadow trial

1. `fqe init`, wire your runners, but do NOT add `fqe/pass` to required checks yet.
2. Let it run on real PRs for ~30 days, emitting receipts.
3. Run `fqe scorecard` over the collected receipts.
4. Decide: if false-red rate is ~0, wall-time is acceptable, and there was at least one true
   catch, promote `fqe/pass` to a required check. If not, the gate is wrong, not your team, so
   tune the runners first.

`fqe scorecard` is a report. It never decides PASS/FAIL and always exits 0.
