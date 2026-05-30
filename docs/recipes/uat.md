# Recipe: user-acceptance testing as a gate

Turn your acceptance criteria into a deterministic, fail-closed check. Each criterion is either covered by an automated test that passed, or by a human sign-off. Anything else is a gap, and a gap blocks (or flags) the merge.

UAT in fqe is one command:

```bash
fqe uat --spec uat.yml [--results results.json] [--strict] [--json]
```

It reads a spec of acceptance criteria, matches each one against a test result or a manual sign-off, and emits a verdict. No LLM is in the path. Same spec plus same results gives the same answer every time.

## Why this matters for a payments shop

"All the tests pass" and "the thing we promised actually works" are not the same statement. A green suite tells you the code you wrote behaves the way you asserted. It does not tell you that the acceptance criterion the product owner signed off on is covered by any test at all.

UAT closes that gap. You write the acceptance criteria down, you point each one at the test (or the human) that proves it, and fqe refuses to call the release accepted until every criterion is accounted for. A missing automated result is never read as a pass. That is the whole posture: fail closed.

## The spec format

`uat.yml` has one top-level key, `criteria`, which is a list. Each criterion has an `id`, a `statement`, and a `verified_by`.

```yaml
criteria:
  - id: AC-1
    statement: "A duplicate webhook does not double-charge the customer"
    verified_by: "test:payments.webhook.idempotent_property"

  - id: AC-2
    statement: "A refund posts to the ledger within one billing cycle"
    verified_by: manual
    status: pass
    signoff: "Jane Doe <jane@finexio.com>"

  - id: AC-3
    statement: "Failed settlement retries with exponential backoff"
    verified_by: "test:settlement.retry.backoff"
```

`verified_by` is either `test:<testId>` (automated) or `manual`.

For a `manual` criterion you also give a `status` (`pass`, `fail`, or `pending`) and, for a `pass`, a non-empty `signoff`. A manual `pass` with no signer is not acceptance. It comes back as a gap.

A JSON spec works too (filename ending `.json`, or text starting with `{`), with the same `criteria` array.

## The three outcomes

Every criterion lands in exactly one bucket.

- **covered.** An automated criterion whose test result is `"pass"`, or a manual criterion with `status: pass` and a real signoff.
- **failed.** An automated test that reported `"fail"`, or a manual criterion with `status: fail`.
- **unverified.** A gap. The automated test has no result (a missing result is never a pass), the result is some value other than `"pass"` or `"fail"`, or a manual criterion is pending or unsigned.

The verdict rolls up from those buckets:

- any `failed` criterion gives **FAIL**
- otherwise, any `unverified` criterion gives **FLAG** (or **FAIL** under `--strict`)
- every criterion covered gives **PASS**

## Producing results.json

`results.json` is a flat map of `testId` to `"pass"` or `"fail"`. The `testId` is whatever you put after `test:` in the spec.

```json
{
  "payments.webhook.idempotent_property": "pass",
  "settlement.retry.backoff": "fail"
}
```

How you build that map is up to your test runner. Most JSON reporters give you per-test results you can reshape. A small example with a tap/JSON reporter:

```bash
# run the suite, emit per-test JSON, reshape to {testId: "pass"|"fail"}
npm test -- --reporter=json > raw.json
node scripts/to-uat-results.js raw.json > results.json
```

The only contract fqe cares about is the final shape: test id maps to `"pass"` or `"fail"`. A test id that never appears in the map is treated as a missing result, which is a gap, not a pass.

## Strict mode

By default an unverified criterion is a FLAG. The release is not accepted, but it does not hard-block, because the criterion might be covered by manual testing that is still in flight.

`--strict` turns every unverified criterion into a FAIL. Use it for the release branch, or for any criterion set where "we did not check" must block, not warn.

```bash
fqe uat --spec uat.yml --results results.json --strict
```

## Wire it as an fqe runner

Wrap the command in a script and add it as a runner with `class: uat` so a policy can require user-acceptance coverage before merge.

```bash
#!/usr/bin/env bash
# scripts/uat-check.sh: build the results map, then gate on the spec
set -euo pipefail
node scripts/to-uat-results.js < <(npm test --silent -- --reporter=json) > /tmp/uat-results.json
fqe uat --spec uat.yml --results /tmp/uat-results.json --strict
```

```yaml
# .fqe.yml
runners:
  uat:
    command: "bash"
    args: ["scripts/uat-check.sh"]
    when: ["src/**", "uat.yml"]
    required: true
    class: uat
```

The `class: uat` tag is what lets a policy demand acceptance coverage. See `docs/recipes/test-taxonomy.md` for `require_classes` and the diff-conditional `require_for`.

## Exit codes

- **0** PASS, every criterion covered.
- **3** FLAG, at least one criterion unverified and none failed (non-strict).
- **2** FAIL, a criterion failed, or any criterion is unverified under `--strict`.

These match the rest of the gate: 0 pass, 2 block, 3 flag.

## Notes

- **A missing result is never a pass.** This is the point of the recipe. If the spec names `test:foo` and `foo` is absent from `results.json`, the criterion is a gap. You cannot accept a release by forgetting to report a test.
- **A manual pass needs a named signer.** `status: pass` with an empty or missing `signoff` is unverified, not covered. Sign-off is a person putting their name on it, so fqe wants the name.
- **Keep the spec in the repo.** `uat.yml` is the acceptance contract. It belongs next to the code, reviewed in the same PR. An edit to the criteria is a change to what "accepted" means, so it shows up in review like any other change.
- **Pair strict with the release branch.** Run non-strict on feature branches so unverified criteria flag instead of block, then strict on the branch you actually ship from.
