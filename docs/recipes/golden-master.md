# Recipe: golden-master (approval) tests

Lock the exact bytes of a generated financial artifact and fail any future run that drifts from the approved copy.

Golden-master testing (also called approval or characterization testing) is simple: you generate the artifact once, eyeball it, commit that verified output as the "golden" copy, and every future run regenerates the artifact and diffs it against the golden. A diff is a failure. A human reads the diff, decides whether the change is correct, and only then updates the golden. The committed file is the spec.

## Why this matters for a payments shop

NACHA ACH files, remittance CSVs, and invoice PDFs are fixed-width, position-sensitive formats where one wrong character moves money to the wrong place or breaks the file at the bank. A routing number that slides one column, a batch total off by a cent, an amount field padded with the wrong character: these corrupt money movement silently and the unit tests stay green.

Example-based unit tests check the fields you remembered to assert on. A golden-master test checks every byte you did not think to assert on, which is exactly where format regressions hide. For a ten-person team shipping NACHA, this is the cheapest way to make "the file changed and nobody noticed" impossible.

## The key technique: normalize volatile fields before diffing

A raw artifact changes on every run for boring reasons: the file-creation date in the header, batch and trace sequence numbers, UUIDs, run timestamps. If you diff raw output, every run fails and the test becomes noise.

So you normalize first. Run the output through a small scrubber that blanks the volatile fields to a stable token, then diff the normalized text. Only meaningful changes survive to the diff.

```js
// normalize-nacha.js: blank the fields that change every run
export function normalizeNacha(text) {
  return text
    // file-header creation date (positions) + time, to a stable token
    .replace(/(?<=^1.{17})\d{6}\d{4}/gm, "YYMMDDHHMM")
    // batch number in the batch-control "8" record (last 7 digits)
    .replace(/(?<=^8.{73})\d{7}/gm, "0000000")
    // generic UUIDs that leak into filenames or remittance rows
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID");
}
```

Field positions are illustrative. Pin them to your generator's actual layout. The rule that matters: normalize a field only because it is non-deterministic, never because it is inconvenient to get right.

## A worked NACHA example

Say the generator emits this (trimmed to two records):

```
101 021000021 1234567890506291430A094101FINEXIO BANK    ACME PAYMENTS INC
8200000002021000020000000000000000000150000123456780000001
```

Two fields move on every run. In the `1` file-header record, `0506291430` is the creation date (`YYMMDD`) and time (`HHMM`). In the `8` batch-control record, the trailing `0000001` is the batch number. Everything else (routing positions, the `150000` amount total) is meaningful and must stay byte-stable.

Normalize:

```
101 021000021 123456789YYMMDDHHMMA094101FINEXIO BANK    ACME PAYMENTS INC
8200000002021000020000000000000000000150000123456780000000
```

Approve and commit the golden:

```bash
node generate-nacha.js | node -e 'import("./normalize-nacha.js").then(m=>{let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(m.normalizeNacha(s)))})' \
  > test/golden/payroll.nacha.approved.txt
git add test/golden/payroll.nacha.approved.txt
git commit -m "test: approve payroll NACHA golden"
```

From then on, the test regenerates, normalizes, and diffs against that file. The `150000` total changing, or a routing position shifting, fails the test. The creation date changing does not.

## Two ways to run it

**Framework path, ApprovalTests.** ApprovalTests has JS (`approvals`) and Python (`approvaltests`) ports. You hand it the normalized output and a name. It compares against the committed `.approved` file and writes a `.received` file on mismatch for review.

```js
import { verify } from "approvals";
import { normalizeNacha } from "./normalize-nacha.js";

test("payroll NACHA matches golden", () => {
  const file = generateNacha(fixturePayroll);
  verify(normalizeNacha(file)); // diffs against payroll-NACHA.approved.txt
});
```

```python
from approvaltests import verify
from normalize_nacha import normalize_nacha

def test_payroll_nacha_matches_golden():
    verify(normalize_nacha(generate_nacha(FIXTURE_PAYROLL)))
```

**Zero-dep path, write a file and `git diff`.** For teams that want no new dependency, regenerate the artifact to the golden's path and let git tell you if it moved.

```bash
node generate-nacha.js | node normalize-cli.js > test/golden/payroll.nacha.approved.txt
git diff --exit-code test/golden/payroll.nacha.approved.txt   # exit 1 if the golden moved
```

## Wire it as an fqe runner

An fqe runner is any command that exits non-zero on failure. Wrap the regenerate-normalize-diff step in a script, and fqe maps a non-zero exit to FAIL.

```bash
#!/usr/bin/env bash
# scripts/golden-check.sh: regenerate, normalize, diff against committed golden
set -euo pipefail
node generate-nacha.js | node normalize-cli.js > /tmp/payroll.received.txt
diff -u test/golden/payroll.nacha.approved.txt /tmp/payroll.received.txt
# diff exits 1 on any difference, which fqe reads as FAIL
```

Add the runner to `.fqe.yml` (runners is a map of name to config, and it fires on a matching diff):

```yaml
runners:
  golden-nacha:
    command: "bash"
    args: ["scripts/golden-check.sh"]
    when: ["src/nacha/**", "scripts/generate-nacha.js", "test/golden/**"]
    required: true
```

`required: true` makes an unapproved diff block the merge. To run the check on every PR regardless of the diff, swap `when` for `always_run: true`. fqe records the runner exit in the receipt like any other gate, and `fqe validate` will reject this block if a key is misspelled.

## 10-minute on-ramp

1. Pick your one highest-stakes generated artifact. For a payments shop this is almost certainly the NACHA generator.
2. Run it once, read the output until you trust it, normalize the date and batch number, and commit the result as the golden.
3. Drop in `scripts/golden-check.sh` and the runner block above.

That is the whole thing. One artifact, one golden, one diff. Add the remittance CSV and invoice PDF next.

## Notes

- **An unapproved diff is a FAIL, not a FLAG.** The artifact changed and no human signed off, so the merge blocks. This is the entire point: silent format drift is the failure mode you are buying protection against.
- **Updating the golden is a deliberate reviewed act.** When a change is correct, you regenerate the `.approved` file and commit it in the same PR. The diff shows up in code review and a human approves it there, the same place every other change gets approved.
- **Keep goldens small and human-readable.** A reviewer has to read the diff and decide if money still moves correctly. One representative fixture per format beats a 5,000-line dump that nobody reads.
- **Never normalize away a field that affects money.** Amounts, routing numbers, account numbers, and totals must stay byte-stable in the golden. Normalize the file-creation date and the sequence numbers. If you are unsure whether a field is volatile or meaningful, treat it as meaningful and let the diff fail loudly.
