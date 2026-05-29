# Recipe: partner-API contract tests

Catch partner API drift in CI instead of in production. Record a real (sanitized) partner response once, commit it as a cassette, and replay it on every PR so a schema change you depend on fails fast.

A B2B payments orchestrator lives or dies by partner API drift. You sit between customers and banks, processors, and data partners (Increase, Grasshopper Bank, J.P. Morgan, ZoomInfo), and your single biggest regression surface is one of them quietly renaming a field, changing a type, or dropping a key you parse. Their change ships, your deserializer breaks, and you find out from a customer at 2am unless a recorded contract fails first in CI.

## Why a recorded contract beats a live integration test

A live integration test hits the real partner on every run. It is slow, it is flaky when the partner has a bad minute, and a partner outage turns into a red build on an unrelated PR. A recorded contract pins the exact response shape you committed to, replays it offline in milliseconds, and the only thing that makes it red is a difference between what you recorded and what your code now expects. That is the signal you want: drift, not weather.

## Two techniques, two jobs

1. **Record-replay (for partners you CALL).** Record a real partner response once, sanitize it, commit the cassette, and replay it in CI. A schema change in a partner you consume fails against the recorded shape. Tools: `vcrpy` (Python), `nock` or `PollyJS` (TypeScript).
2. **Consumer-driven contracts (for your OWN service-to-service).** When two services you both own talk to each other, use `Pact`. The consumer publishes the shape it needs, the provider verifies it can still produce that shape, and the provider's CI breaks if a change would break a known consumer.

Reach for record-replay when the other side is a third party you do not control (you cannot make J.P. Morgan run your contract suite). Reach for Pact when you own both sides and want the provider to find out at build time that it broke a downstream service.

## Sanitization is mandatory and it is loud

A recorded partner response contains secrets and PII: auth headers, bearer tokens, account numbers, names, tax IDs. An unsanitized cassette committed to the repo is a secret leak, full stop. Sanitize BEFORE the cassette is written to disk, never after, because "after" means it already touched the filesystem and your git history.

The hook below masks the auth header and account number on the way to disk. Anything that is a credential or could identify a real entity gets masked at record time.

## TTL and freshness

A cassette recorded once and never refreshed gives false confidence. The partner keeps evolving, your cassette does not, and your green build is testing a fossil. Stamp each cassette with a `recorded-at` date and fail (or at least flag) when it is older than a TTL, for example 90 days. That forces a scheduled re-record against the live partner, so the contract you replay stays close to the contract that actually ships.

## Worked example: an Increase balance call (Python, vcrpy)

This calls a mock "Increase" balance endpoint, sanitizes the auth header and account number before writing the cassette, and asserts the fields the code depends on still exist with the right types on replay. The schema assertion is what actually catches drift. The cassette replay just makes the partner response deterministic and offline.

```python
import datetime as dt
import vcr
import requests

# Mask secrets/PII BEFORE the cassette hits disk. Unsanitized = leak.
def scrub_request(request):
    if "Authorization" in request.headers:
        request.headers["Authorization"] = "Bearer REDACTED"
    return request

def scrub_response(response):
    body = response["body"]["string"].decode()
    # account_number is PII; replace with a stable masked token
    body = body.replace('"account_number":"123456789"', '"account_number":"REDACTED"')
    response["body"]["string"] = body.encode()
    return response

increase_vcr = vcr.VCR(
    cassette_library_dir="tests/cassettes/increase",
    record_mode="once",                 # record first run, replay forever after
    filter_headers=["authorization"],   # belt-and-suspenders on top of scrub_request
    before_record_request=scrub_request,
    before_record_response=scrub_response,
)

# TTL guard: a fossil cassette is false confidence. 90 days, then re-record.
def assert_fresh(cassette_path, max_age_days=90):
    stamp = cassette_path.with_suffix(".recorded-at")
    recorded = dt.date.fromisoformat(stamp.read_text().strip())
    age = (dt.date.today() - recorded).days
    assert age <= max_age_days, f"cassette {cassette_path.name} is {age}d old, re-record against live"

@increase_vcr.use_cassette("balance.yaml")
def test_increase_balance_contract():
    resp = requests.get(
        "https://api.increase.com/accounts/acct_test/balance",
        headers={"Authorization": "Bearer sk_live_REAL_KEY_AT_RECORD_TIME"},
    )
    body = resp.json()

    # SCHEMA ASSERTION: the 3-5 fields our code actually reads, and their types.
    # This is the line that catches drift. Keep it narrow.
    assert isinstance(body["available_balance"], int)   # cents, int
    assert isinstance(body["currency"], str)
    assert body["currency"] == "USD"
    assert isinstance(body["account_number"], str)       # masked in the cassette
```

If Increase renames `available_balance` to `available_amount`, or ships it as a float, the schema assertion goes red on the next PR. That is the regression caught in CI instead of in your balance reconciliation job.

## Wire it in as an fqe runner

There is almost nothing to wire. Your contract test is a `pytest` (or `vitest`) command, so it flows through the existing fqe gate exactly like any other test: a non-zero exit is a FAIL. Key the runner to the partner-client paths so it only runs when the relevant code or cassettes change.

```yaml
# .fqe.yml
runners:
  partner-contracts:
    command: "pytest"
    args: ["tests/contracts/", "-x", "--tb=short", "--no-header"]
    when: ["src/clients/**", "tests/contracts/**", "tests/cassettes/**"]
    required: true
    timeout_ms: 300000   # 5 min
```

TypeScript shape is the same, swap the command for your runner:

```yaml
  partner-contracts:
    command: "npx"
    args: ["vitest", "run", "tests/contracts"]
    when: ["src/clients/**", "tests/contracts/**", "tests/cassettes/**"]
    required: true
```

Once it is a runner, `fqe run` fires it whenever a matching file changes, reads its exit code, and folds it into the one verdict and receipt. No special invocation needed beyond the `.fqe.yml` block above.

Exit codes (the contract command's own exit, which fqe reads): **0 = PASS, 2 = FAIL (merge blocked), 4 = INFRA** (the live partner was unreachable during a scheduled refresh, neutral, so a partner outage does not block unrelated merges).

## The 10-minute on-ramp

Do not try to contract-test every partner call. Pick your single most business-critical partner call, the one whose silent drift pages you at 2am. Record one sanitized cassette of it, then add a schema assertion on the 3 to 5 fields your code actually consumes. That alone catches the drift that hurts most.

Ship it, watch it catch one partner change, then add the next call. One real contract on the bet-the-company integration beats fifty cassettes on calls nobody depends on.

## Notes

- **Drift is a FAIL, not a FLAG.** A field your code consumes that changed name or type breaks production. The contract test going red is the whole point. Block the merge.
- **A stale cassette past TTL is at least a FLAG.** An expired cassette is testing a partner that no longer exists. At minimum flag it and open a re-record ticket. On a critical partner, make the TTL guard a FAIL so the cassette cannot rot silently.
- **Never commit an unsanitized cassette.** Treat a leaked cassette like a leaked key: rotate the credential and scrub git history. Sanitize at record time with a `before_record_response` hook, and add a secret scanner (gitleaks) over `tests/cassettes/**` as a backstop.
- **Record against a sandbox or sanitized account, never a real customer.** Use the partner's test environment and a throwaway account. The cassette is committed to a public-ish repo forever, so the data in it must never be real customer data.
- **Keep the schema assertion narrow.** Assert the fields you actually consume, not the whole payload. A cosmetic field the partner adds (a new `metadata` block you ignore) should not turn your build red. Assert what you read, ignore the rest.
- **Pair with property-based tests.** Contract tests prove the partner's shape has not drifted. Property tests (`docs/recipes/property-based-testing.md`) prove your money math is correct on whatever shape comes back. The first guards the boundary, the second guards the math. Use both.
