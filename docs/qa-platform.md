# The Finexio QA platform

This is the plan for taking a team from "tests run on every PR" (table stakes) to a regression-and-unit-test capability that compounds on its own. It came out of a multi-LLM council review and is sequenced by what unlocks what.

The principle: **the test suite should write and guard itself, so it survives without one person babysitting it.** Quantity is guarded by the coverage ratchet; quality is guarded by the mutation gate; the labor is done by AI, fenced in by the mutation gate so it cannot flood the repo with meaningless tests.

## What fqe gives you today (shipped)

| Capability | Command | What it enforces |
|---|---|---|
| Deterministic gate | `fqe run` | Reads runner exit codes, one verdict, tamper-evident receipt |
| Coverage ratchet | `fqe coverage-ratchet` | New code is tested (patch rule) + total coverage never drops |
| Mutation gate | `fqe mutation-gate` | Tests must actually catch bugs, not just run code |
| Oracle-tamper guard | `fqe oracle-guard` | A PR that edits its own ground truth or grading rules needs a second reviewer |
| Config validation | `fqe validate` | A malformed `.fqe.yml` fails closed, never silently disables a check |
| Wilson-CI stat gate | built into `fqe run` | Bounds adversarial/eval failure rates by blast class |
| Test-class taxonomy + policy | `policy` block, enforced in `fqe run` | A required class (unit, regression, contract, money, ...) with no passing runner is a FAIL. `require_for` makes money paths strict automatically. See `recipes/test-taxonomy.md` |
| UAT gate | `fqe uat` | Acceptance criteria become pass/fail: automated test = covered, manual needs a signoff, unverified = gap. See `recipes/uat.md` |
| Regression engine | `fqe golden` | Snapshot deterministic output, FAIL on drift. See `recipes/regression-golden.md` |
| QA scorecard | `fqe qa-report` | One per-class status view with policy gaps, over a QA-RESULT receipt |

The ratchet guards quantity. The mutation gate guards quality. The oracle-tamper guard keeps the answer key honest. Config validation keeps a typo from disabling any of them. The taxonomy and policy make every test type a first-class, enforceable gate (unit through UAT), and the scorecard shows the whole picture in one view. Together they are the floor under which coverage cannot fall and quality cannot be faked.

## The rollout sequence

### Phase 1: trust gates (do these before anything else)

1. **Coverage ratchet** (shipped). Wire `fqe coverage-ratchet` into every repo's test workflow. See `docs/recipes/coverage-ratchet.md`. Without this, every other investment decays silently.

2. **Oracle-tamper guard** (shipped). Wire `fqe oracle-guard` so a PR that edits its own answer key (a golden master, a partner cassette, the coverage baseline, `.fqe.yml`) requires a second reviewer. Coverage and mutation testing both miss this move. See `docs/recipes/oracle-tamper.md`. Turn on `--include-tests` if agents author code and tests together.

3. **Flaky-test quarantine** (BUY, do not build). For a small team, buy **Trunk Flaky Tests** or **BuildPulse** (roughly $30-50/seat/mo or a flat team rate). They auto-detect flakes, move them to a non-blocking lane, and open a ticket. Do this *before* adding more tests: one flaky test that everyone learns to "re-run" destroys the gate's authority. Building this yourself is a maintenance project that is not worth it under ~50 engineers. Interim stopgap until you buy: retry-once and flag the retry-pass as a flake signal. See `docs/recipes/flaky-quarantine.md`.

### Phase 2: the AI test factory (ends hand-writing tests)

4. **Qodo Cover, gated by the mutation gate.** Install Qodo Cover as a GitHub App. On a PR that drops patch coverage, it generates tests for the uncovered lines and pushes them to the PR. The critical step that makes this safe: run mutation testing on the changed files and reject the generated tests if they do not clear the kill-rate bar. AI test generators are notorious for assertionless, snapshot-style tests that look green and prove nothing; the mutation gate is the bouncer. See `docs/recipes/ai-test-generation.md` and the workflow template below.

   Requires (human action): install the Qodo Cover GitHub App, add `ANTHROPIC_API_KEY` to repo secrets (uses the existing Claude budget, no new vendor).

### Phase 3: payments correctness (the bet-the-company tests)

5. **Property-based tests** for money/state invariants. Python: Hypothesis. TS: fast-check. Test invariants, not example values: sum of debits equals sum of credits, idempotency keys never double-apply, rounding conserves cents, retries are idempotent. Three to five of these on the highest-value money flow catch the regressions example-based tests structurally cannot. See `docs/recipes/property-based-testing.md`.

6. **Partner-API contract / record-replay tests.** A B2B payments company lives or dies by partner API drift (banks, processors, KYC). Record real (sanitized) partner responses with a TTL and replay them in CI, so a partner schema change fails in CI, not in production. Tools: vcrpy (Python), PollyJS/nock (TS), Pact for your own service-to-service. See `docs/recipes/partner-contract.md`.

7. **Golden-master (approval) tests** for generated financial artifacts (NACHA files, remittance CSVs, invoice PDFs). Normalize timestamps/IDs, commit the verified output, and diff future output for human approval. Tool: ApprovalTests. See `docs/recipes/golden-master.md`.

### Deliberately deferred

Visual-regression, end-to-end browser, and performance testing. For a backend-heavy payments shop, silent money-path corruption and partner drift are the real risks, not CSS. These earn their place later, not now.

## The one liability to fix in parallel

The fqe bypass mechanism must be auto-expiring, head-bound, and logged before a payments company puts it on the critical path. An auditor (SOC 2 / PCI) and an attacker both look there first. **Closed in 0.4.0** (designed via a 3-LLM council): bypass is a SHA-bound, TTL'd PR comment, `/fqe-bypass <head-sha> <24h/48h/72h>`. Identity and time come from the comments API, SHA equality is the binding so any new push invalidates it, edited comments are rejected, and it fails closed. See `cli/lib/bypass_guard.js`.

## The Phase-2 workflow template (Qodo + mutation gate)

See `docs/recipes/ai-test-generation.md` for the full version. The shape:

```yaml
name: ai-test-factory
on: pull_request
jobs:
  generate-and-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci
      # 1. Patch coverage; if it dropped, Qodo Cover fills the gap
      - run: npm test -- --coverage --coverage.reporter=json-summary
      - name: qodo cover (only if patch coverage low)
        env: { ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" }
        run: npx qodo-cover --source src/ --test test/ --max-iterations 3
      # 2. Mutation gate on the changed files: reject weak/AI tests
      - run: npx stryker run --reporters json --mutate "$(git diff --name-only origin/main... | tr '\n' ',')"
      - run: |
          npx --yes -p github:booyajones/fqe#fqe-v0.18.4 fqe mutation-gate \
            --report reports/mutation/mutation.json --threshold 70 \
            --changed "$(git diff --name-only origin/main... | tr '\n' ',')"
```
