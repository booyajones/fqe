# Recipe: flaky-test quarantine

One flaky test that everyone learns to "just re-run" destroys the gate's authority. After that, every red build is assumed to be flake, and a real regression walks through. This recipe keeps flakes out of the required lane without hiding them.

## The real fix: buy it

For a team under about 50 engineers, buy **Trunk Flaky Tests** or **BuildPulse** (roughly $30 to $50 per seat per month, or a flat team rate). They detect flakes from your existing CI runs, move them to a non-blocking lane automatically, and open a ticket. Building this yourself is a standing maintenance project that is not worth the engineering time at this size.

Do this before you invest in more tests. Adding tests on top of a suite nobody trusts just adds noise.

## The interim stopgap: retry once, and flag the flake

If you have to wait on the purchase, the holding pattern is retry-once-and-report. The rule that matters: a test that fails then passes on retry is a SIGNAL, not a success to swallow. Log it, count it, and open a ticket. Never silently re-run.

TypeScript (vitest):

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    retry: 1, // a flake passes on retry; a real failure stays red
    reporters: ["default", "json"], // the json report records retry counts
  },
});
```

Then a small step flags any test that needed a retry, so the flake is visible instead of buried:

```bash
node -e '
  const r = require("./test-report.json");
  const flaky = (r.testResults || []).flatMap(f => f.assertionResults || [])
    .filter(t => (t.retryReasons || []).length > 0 || t.status === "passed" && t.retries > 0)
    .map(t => t.fullName);
  if (flaky.length) { console.log("::warning::flaky (passed on retry): " + flaky.join(", ")); }
'
```

Python (pytest):

```bash
pip install pytest-rerunfailures
pytest --reruns 1 --reruns-delay 1 -r aR   # -r aR prints a "RERUN" section you can grep
```

A line in the RERUN section means a test passed only on retry. Capture that list, post it to the PR or a channel, and file the ticket.

## Wire it into fqe

A flaky test in a `required` runner is poison, because it makes the whole gate look unreliable. Pull known flakes out of the required set and run them in a separate non-blocking job until they are fixed or quarantined by the tool you buy. The required runner stays trustworthy, the flake stays visible.

Track the flake list in the repo (a short `flaky-tests.txt` or a tool dashboard) so a quarantined test does not become a forgotten test.

## Notes

- **A retry-pass is a flake signal, not a green light.** The whole failure mode is teams that re-run until green and learn nothing. Logging the signal is the point.
- **Quarantine has a half-life.** A quarantined test that nobody fixes is dead coverage. Put a date on it or a ticket against it.
- **Do not raise the retry count past 1 as a habit.** Two retries hides real intermittent bugs (a race in your own code is not a "flake", it is a bug).
- **This is a stopgap.** The moment the tool is bought, delete the retry hack and let the tool own detection.
