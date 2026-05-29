# Recipe: AI test generation + mutation testing

The durable half of this recipe works today with no external account: [Stryker](https://stryker-mutator.io) mutation-tests your suite and `fqe mutation-gate` blocks the merge if the kill rate is below the bar. The test *author* is pluggable: an AI generator writes candidate tests, the gate decides whether they actually catch bugs. The gate is the bouncer, and it does not care who wrote the test.

**On the generator (read this first).** The original open-source [Qodo Cover](https://github.com/qodo-ai/qodo-cover) is now archived and not installable from PyPI, so do not `pip install qodo-cover`. Your current options for the author are: [qodo-ai/qodo-ci](https://github.com/qodo-ai/qodo-ci) (the maintained Action), Qodo's hosted product, or any LLM that writes tests (Claude Code, a script, a human). Wire the gate first (it is the value), add an automated author later. The rest of this recipe is generator-agnostic.

## Why this recipe exists

Two published findings drive the architecture:

1. **Coverage lies.** Meta's [TestGen-LLM paper](https://arxiv.org/abs/2402.09171) showed that AI-generated tests with high coverage often miss real bugs because they mirror the implementation. The fix: filter mechanically against mutation testing before any human sees them.
2. **The harness, not the model, drives the outcome.** [Diffblue's March 2026 benchmark](https://diffblue.com) showed Claude Code unassisted reached 32% line coverage / 24% mutation kill. Their orchestration layer on top of the same Claude Code reached 81% / 61%. Same model. 2.5x lift from the harness.

This recipe wires the harness so the orchestration layer is fqe.

## What gets wired

```
PR opened
   ↓
AI author (qodo-ci / hosted Qodo / your LLM) generates candidate tests
   ↓   (optional: the gate also works on hand-written tests)
PR contains the candidate tests
   ↓
Stryker mutation-tests the whole suite (including the new tests)
   ↓
fqe reads exit code + mutation kill rate from Stryker JSON
   ↓
verdict: PASS if kill rate >= threshold for blast class; FAIL otherwise
```

## One-command install (JS/TS repos)

```bash
npx --yes github:booyajones/fqe#fqe-v0.4.1 cli/bin/fqe.js init --with-mutation
npm install --save-dev @stryker-mutator/core
git add .fqe.yml .github/ scripts/ stryker.conf.json package.json
git commit -m "Wire fqe + Stryker mutation gate"
```

That's the full setup. `init --with-mutation` writes the `stryker.conf.json`, the runner glue script at `scripts/fqe_stryker_runner.js`, and the `stryker-mutation` runner block in `.fqe.yml`. Open a PR, the gate fires.

For Python (mutmut), Java (PIT), or Go (go-mutesting), see "Common adjustments" below. The runner contract is the same; only the wrapped tool changes.

## Prerequisites

- Node, Python, Java, Go, or Ruby project with an existing test runner.
- An automated test author. **Optional and pluggable.** The mutation gate works without one (it judges whatever tests exist, AI- or human-written). When you want auto-generation, use [qodo-ai/qodo-ci](https://github.com/qodo-ai/qodo-ci) or Qodo's hosted product. Do not use the archived `qodo-cover` package. The runner command below is a placeholder for whichever author you pick.
- A mutation runner for your stack: [Stryker](https://stryker-mutator.io) (JS/TS, wired by `--with-mutation`), [mutmut](https://github.com/boxed/mutmut) (Python), [PIT](https://pitest.org) (Java), [go-mutesting](https://github.com/avito-tech/go-mutesting) (Go).

## `.fqe.yml`

```yaml
# AI-quality gate. The load-bearing runner is stryker-mutation: it is the gate.
# The test-author runner is OPTIONAL and pluggable. Start with just the gate.
#
# The author runner below is a PLACEHOLDER. Swap `command`/`args` for your chosen
# author: qodo-ci, a hosted-Qodo call, or your own LLM script. Keep it
# required: false so a flaky author never blocks a merge. The gate, not the
# author, is what blocks.

runners:
  # OPTIONAL test author. Delete this block to run gate-only. Replace the
  # command with your generator of choice (the archived `qodo-cover` is gone).
  test-author:
    command: "bash"
    args: ["scripts/fqe_qodo_runner.sh"]
    when: ["**/*.js", "**/*.ts", "**/*.py", "**/*.java", "**/*.go", "**/*.rb"]
    required: false   # an author never blocks; the gate does
    timeout_ms: 600000   # 10 min

  stryker-mutation:
    command: "node"
    args: ["scripts/fqe_stryker_runner.js"]
    when: ["**/*.js", "**/*.ts", "test/**", "stryker.conf.json"]
    required: true
    timeout_ms: 900000   # 15 min
```

## The Stryker runner script

```javascript
// scripts/fqe_stryker_runner.js
// Wraps Stryker so it emits a fqe-compatible JSON line on stdout.
// Mutation kill rate maps to adversarial_stats with blast_radius.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const r = spawnSync('npx', ['stryker', 'run', '--reporters', 'json,progress'], {
  encoding: 'utf8',
  timeout: 14 * 60 * 1000,
});

if (r.status !== 0 && r.status !== 1) {
  // Stryker exits 1 when below threshold; 0 when above. Both are fine for us
  // because we report the rate to fqe and let fqe decide.
  console.error('stryker crashed:', r.stderr);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync('reports/mutation/mutation.json', 'utf8'));
const allMutants = Object.values(report.files).flatMap(f => f.mutants);
const killed = allMutants.filter(m => m.status === 'Killed').length;
const survived = allMutants.filter(m => m.status === 'Survived').length;
const n = killed + survived;
const successes = survived;   // fqe convention: "successes" = bad outcomes

// Wilson 95% CI via fqe CLI (or inline math)
const wilson = spawnSync('fqe', ['wilson', String(successes), String(n)], {
  encoding: 'utf8',
});
const ci_95 = JSON.parse(wilson.stdout).ci_95;

console.log(JSON.stringify({
  runner: 'stryker-mutation',
  exit_code: 0,
  adversarial_stats: [{
    runner: 'stryker-mutation',
    n,
    successes,
    ci_95,
    blast_radius: 'mcp-write-or-financial',   // strictest: 1% survival ceiling
  }],
}));
process.exit(0);
```

## Threshold map by blast radius

The same threshold table fqe uses for outbound copy and MCP tool calls applies to mutation testing:

| Blast class | Mutation-survival Wilson CI upper bound | Engineering meaning |
|---|---|---|
| `outbound` | 5% | Code that generates customer-facing text. A few tests missing edge cases is recoverable. |
| `mcp-read` | 3% | Code that reads from external systems. Wrong reads are usually detectable downstream. |
| `mcp-write-or-financial` | 1% | Code that mutates state or touches money. Untested branches are unrecoverable. |

In Finexio practice: anything in `lib/payments/`, `lib/idempotency/`, `lib/reconciliation/`, or that touches partner webhook receivers (Increase, JAGGAER, Unimarket, Pairsoft, Craftable, Rillion) gets `mcp-write-or-financial`. Standard application code gets `mcp-read`. Outbound templates get `outbound`. Experimental code gets `required: false` until graduated.

## GitHub Action template

Drop this into `.github/workflows/fqe-quality.yml` alongside the existing fqe workflow:

```yaml
name: fqe-ai-quality

on:
  pull_request:
    paths:
      - "**/*.js"
      - "**/*.ts"
      - "test/**"
      - ".fqe.yml"

jobs:
  ai-quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - name: install
        run: npm ci
      # OPTIONAL test author. The archived qodo-cover pip package is gone; swap
      # this for qodo-ci or a hosted-Qodo call when you adopt one. The gate below
      # runs with or without it, so this step is allowed to no-op.
      - name: ai test author (optional)
        env: { ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" }
        run: bash scripts/fqe_qodo_runner.sh || echo "no author wired yet; gate-only"
      - name: stryker
        run: npx stryker run --reporters json
      - name: fqe verdict
        run: |
          npx --yes github:booyajones/fqe#fqe-v0.4.1 cli/bin/fqe.js run \
            --full --base origin/main --output ./out/
      - name: upload receipt
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-receipt-${{ github.sha }}
          path: out/QA-RESULT.*
```

## Live result: the full loop on real Finexio code

Run on `lib/brand.ts` in a real Finexio repo, 7 seconds per pass:

| Tests | mutation kill rate | survivors | `fqe mutation-gate` (threshold 70) |
|---|---|---|---|
| as written | 57.14% | 6 | **FAIL** |
| after strengthening (pin the literal values) | 100% | 0 | **PASS** |

The original tests had coverage on `brand.ts` and all passed, but they compared `functionColor(x)` to `functionColors[x]`, so mutating a brand color changed both sides of the assertion and the test stayed green. Stryker mutated the brand color `"#4a5568"` to `""` and the suite did not notice. The gate caught it (57% FAIL), the fix was to assert the exact hex values and the font stack, and the kill rate went to 100%.

That is the whole loop: the gate rejects coverage-without-assertion, the author (AI or human) strengthens the tests, the gate clears. No external account, no Qodo, no API key. It ran locally in seconds. Swap in an automated author later and the same gate judges its output.

## Live result on fqe itself (dogfooded)

We ran this exact pipeline on the fqe source code. Result on `cli/lib/verdict.js` + `cli/lib/wilson.js`:

```
File         | Mutation Score | Killed | Survived
-------------|---------------:|-------:|--------:
verdict.js   |         66.92% |     87 |       43
wilson.js    |         89.86% |     62 |        7
-------------|---------------|--------|--------
All          |         74.87% |    149 |       50
```

fqe has 162 hand-written tests pinned against `statsmodels.stats.proportion.proportion_confint` to 14 decimal places. Even so, Stryker found 50 mutations that the existing test suite does not catch. Specific examples:

- `wilson.js:76` arithmetic: `z2 * (1 - target) / target` → `z2 * (1 + target) / target`. Math sign flip. Tests still green.
- `wilson.js:71` conditional: `typeof target !== 'number'` → `false`. Type check disabled. Tests still green.

These are the bugs that would have shipped behind a "all tests pass" check. With this recipe wired in, fqe blocks them.

**Per blast class on the fqe codebase:** verdict.js at 66.92% violates the `mcp-write-or-financial` 99% kill-rate threshold by a wide margin. The gate would block, the engineer would either write more tests or have Qodo Cover generate them, and we re-run until clear.

## Notes

- **The gate needs no key; only the author does.** Stryker + `fqe mutation-gate` run with zero credentials (the live result above used none). An automated author (qodo-ci, hosted Qodo, your LLM) calls a model and needs a key, at roughly $0.05 to $0.50 per file iteration. Budget ~$50/month per engineer for the author, $0 for the gate.
- **Stryker is slow on large suites.** For a 1000-test suite expect 10-20 minutes per run. Scope tightly with `mutate: ["src/changed-module/**"]` if you can.
- **Mutation thresholds should rise over time.** Start the kill-rate threshold at 60%. Ratchet up by 5% each quarter. Engineers see the bar move and write better tests proactively.
- **Property-based tests amplify mutation testing.** Wire [fast-check](https://github.com/dubzzz/fast-check) for JS, [Hypothesis](https://hypothesis.readthedocs.io) for Python, [jqwik](https://jqwik.net) for Java. Mutation testing on property-based tests has the highest kill rate of any combination we've tested.

## Common adjustments

- **Python:** swap `stryker` for `cosmic-ray` (it runs on Windows and Linux). Avoid `mutmut` if any engineer is on Windows, it does not run there. The runner script changes; the fqe contract (a kill/surviving tally for `fqe mutation-gate`) does not.
- **Java:** swap for PIT. Same contract.
- **Monorepo:** run one mutation runner per package, each scoped via `when` and `mutate` patterns.
- **CI cost concerns:** scope mutation testing to changed files only (`mutate: ["${FQE_CHANGED_FILES}"]`). Full-suite mutation runs go on a nightly schedule, not per-PR.
