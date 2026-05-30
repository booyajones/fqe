# Recipe: regression testing with golden masters

Snapshot the output of a deterministic command once, commit it, and fail any future run that drifts from the snapshot. This is the regression engine built into fqe. It catches the silent format and value drift that example-based unit tests walk right past.

Two commands:

```bash
# snapshot deterministic command output into goldens/
fqe golden capture --manifest golden.yml --dir goldens/

# re-run each command, FAIL on any drift from the snapshot
fqe golden verify --manifest golden.yml --dir goldens/ [--json]
```

`capture` runs each command and writes its normalized stdout to a `.golden` file. `verify` re-runs the command and compares. A difference is a failure. No LLM is in the path, and the comparison is a byte-for-byte SHA-256 over normalized output.

## Why this matters for a payments shop

A reconciliation report, a rendered remittance, an invoice PDF, a serialized API payload: these are outputs where "same input gives the same output" is the contract. A unit test checks the fields you remembered to assert on. A golden master checks every byte you did not, which is exactly where a format regression hides.

For a small team, this is the cheapest way to make "the output changed and nobody noticed" impossible. You read the output once, trust it, freeze it, and from then on the diff does the watching.

## The manifest format

`golden.yml` has one top-level key, `goldens`, a list of `{name, command, args}` entries. The `name` is a flat identifier (no slashes, no `..`). The `command` and `args` run with no shell, so there is no quoting hazard.

```yaml
goldens:
  - name: remittance-render
    command: node
    args: ["scripts/render-remittance.js", "fixtures/batch-001.json"]

  - name: recon-report
    command: python3
    args: ["recon.py", "fixtures/2026-05-29.csv"]
```

A JSON manifest works too, with the same `goldens` array of `{name, command, args}`.

## Normalization

Before hashing, both the captured output and the stored golden are normalized:

- every CRLF (`\r\n`) and lone CR (`\r`) becomes LF (`\n`)
- exactly one trailing newline is stripped

This stops false drift when a golden is captured on one OS and verified on another, or when an editor rewrites line endings. Only one trailing newline is removed, so a deliberate blank final line still counts as a difference.

That is the entire normalization. fqe does not scrub volatile fields for you. If your command emits a timestamp, a UUID, or a random seed, the output is not deterministic yet, and you must make it deterministic first (see the note at the end).

## The fail-closed posture

`verify` returns PASS only when every golden matches. Three things each force a FAIL:

- **missing baseline.** No `.golden` file for a named golden. You cannot verify against nothing, so capture a baseline first.
- **run-failed.** The command exited non-zero (or did not exit normally). A failing command cannot be compared to its golden, so this blocks.
- **drift.** The command ran cleanly but its normalized output no longer matches the snapshot.

`capture` is fail-closed too. A command that exits non-zero is never snapshotted. You must not freeze a failing command as the baseline, because that would make every future verify a false pass.

## A worked payments example

Say `scripts/render-remittance.js` renders a remittance advice from a fixed batch fixture. Capture it once:

```bash
fqe golden capture --manifest golden.yml --dir goldens/
# writes goldens/remittance-render.golden and goldens/recon-report.golden
```

Read `goldens/remittance-render.golden` until you trust it. Then commit the whole directory:

```bash
git add goldens/
git commit -m "test: capture remittance and recon goldens"
```

From then on, `fqe golden verify` re-renders and diffs. If a refactor changes a line total, reorders columns, or shifts a field, verify reports drift and FAILs with the expected and actual SHAs. If the change is intended, you re-capture and commit the new golden in the same PR, where a reviewer sees the diff.

## Pair it with oracle-guard

A golden file is an answer key. A PR that can both change the code and quietly edit its own golden can make a real regression pass. That is the failure you have to close.

`fqe oracle-guard` flags a PR that edits a golden (and other grading-rule files) so it asks for a second reviewer. The golden directory is in its default patterns by extension. Keep it on, and a "fix the test" that is really "edit the answer key" cannot land on one approval.

## Wire it as an fqe runner

`verify` exits non-zero on any drift, missing baseline, or run failure, so it is a runner with no glue. Tag it `class: regression` so a policy can require regression coverage when money code changes.

```yaml
# .fqe.yml
runners:
  golden-regression:
    command: "fqe"
    args: ["golden", "verify", "--manifest", "golden.yml", "--dir", "goldens/"]
    when: ["src/**", "scripts/render-remittance.js", "recon.py", "goldens/**", "golden.yml"]
    required: true
    class: regression
```

The `class: regression` tag connects this runner to the full-suite policy. See `docs/recipes/test-taxonomy.md` for how `require_for` makes regression mandatory the moment a payments path changes.

## Exit codes

- `golden verify` exits **0** on PASS, **2** on FAIL (drift, missing baseline, or run-failed).
- `golden capture` exits **0** when every golden is written, and errors out if any command failed (nothing is snapshotted for the failures).

## Notes

- **Only snapshot deterministic output.** This is the one hard rule. If the command embeds a timestamp, a UUID, an unsorted map, or unseeded randomness, the golden drifts on every run and the check becomes noise. Make it deterministic first: pin the clock, seed the RNG, sort collections with a stable key, and pass a fixed fixture. Only then capture.
- **Keep goldens small and readable.** A reviewer reads the diff to decide whether money still moves correctly. One representative fixture per format beats a 5,000-line dump nobody reads.
- **Re-capturing is a deliberate, reviewed act.** When a change is correct, regenerate the golden and commit it in the same PR. oracle-guard makes sure a second person looks.
- **Drift is a FAIL, not a FLAG.** The output changed and no human signed off, so the merge blocks. Silent format drift is the exact failure mode this recipe buys protection against.
