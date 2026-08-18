# Discovery and trust hygiene (v0.10)

Two cheap, deterministic moves that make fqe usable as a near-autonomous gate on a small
team: catch whole unwired suites, and stop a single flake from blocking a merge.

## Make absence loud across suites: `fqe discover`

v0.9.0 stopped a green being minted by a suite that ran nothing. v0.10 stops a green being
minted while a whole suite is not wired at all.

```bash
fqe discover            # exit 0 = every detected framework is wired, 3 = FLAG, 2 = strict FAIL
```

It detects pytest, jest, vitest, mocha, playwright, cargo-test, and go-test from manifests
and test files, then reports any with no matching runner in `.fqe.yml`. Inside `fqe run` an
unwired suite is a FLAG by default. To make it block:

```yaml
# .fqe.yml
require_all_suites_wired: true
```

False positives on a helper directory? Add a `.fqeignore` (gitignore-lite):

```
scripts/
*.fixture.py
```

## Stop a flake from blocking a merge: retries and quarantine

One random red erodes trust in the gate, and a gate the team does not trust gets removed.
Two fail-loud-but-neutral controls:

```yaml
runners:
  e2e:
    command: npx
    args: ["playwright", "test"]
    class: e2e
    always_run: true
    required: true
    retries: 2          # re-run on failure; fail-then-pass = FLAKY (a FLAG, not a FAIL)
  legacy-ui:
    command: npm
    args: ["run", "test:legacy"]
    class: e2e
    when: ["legacy/**"]
    quarantined: true   # known-flaky, being fixed: a failure is a neutral FLAG, stays visible
    quarantined_since: "2026-01-15"   # REQUIRED with quarantined; expires after quarantine_ttl_days (default 14)
```

- `retries: N` re-runs a failed runner up to N times. If it fails then passes, fqe marks it
  FLAKY: a FLAG (loud, tracked), never a silent PASS, never a blocking FAIL.
- `quarantined: true` makes a failing runner a neutral FLAG instead of a blocking FAIL. It
  stays in the receipt so the quarantine cannot become silently permanent. Un-quarantine it
  once fixed. `quarantined_since` (an ISO date) is REQUIRED alongside it and is what makes
  that guarantee real: the quarantine expires after `quarantine_ttl_days` (default 14) and
  the runner goes back to blocking on its own. Without the date the config fails validation.

Neither weakens a healthy runner: a non-quarantined runner that fails still FAILs.

## Deterministic helpers (reproducibility)

Flaky tests usually come from real time and unseeded randomness. Freeze both so a suite is
reproducible, which is what makes retries meaningful and mutation testing stable later.

- Time: `freezegun` (Python `@freeze_time("2026-06-01")`), `@sinonjs/fake-timers` or vitest
  `vi.useFakeTimers()` (JS), and inject a clock in Rust rather than calling `SystemTime::now()`.
- Randomness: seed every RNG (`random.seed(0)`, a seeded `faker`, `StdRng::seed_from_u64`).
- Data: build fixtures from a fixed seed, never from "now" or a live resource.

## The human-review queue

Every `fqe run` receipt now reports a review queue so the near-autonomy target (3 to 6
team-hours per week) is observed, not asserted:

```
Human review queue: ~6 min (flags 2, flaky 1, quarantined 0, unwired suites 1, AI drafts 0)
```

The minutes are a documented per-item model, not a measurement, but they let a team watch the
residual human effort trend down as coverage and trust improve.
