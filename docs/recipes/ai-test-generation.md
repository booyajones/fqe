# Recipe: AI test generation + mutation testing

Complete `.fqe.yml` for the modern AI-quality stack: AI generates tests with [Qodo Cover](https://github.com/qodo-ai/qodo-cover) (Meta TestGen-LLM filter pipeline), [Stryker](https://stryker-mutator.io) mutation-tests the survivors, fqe gates on the mutation kill rate.

## Why this recipe exists

Two published findings drive the architecture:

1. **Coverage lies.** Meta's [TestGen-LLM paper](https://arxiv.org/abs/2402.09171) showed that AI-generated tests with high coverage often miss real bugs because they mirror the implementation. The fix: filter mechanically against mutation testing before any human sees them.
2. **The harness, not the model, drives the outcome.** [Diffblue's March 2026 benchmark](https://diffblue.com) showed Claude Code unassisted reached 32% line coverage / 24% mutation kill. Their orchestration layer on top of the same Claude Code reached 81% / 61%. Same model. 2.5x lift from the harness.

This recipe wires the harness so the orchestration layer is fqe.

## What gets wired

```
PR opened
   ↓
Qodo Cover generates candidate tests for new/changed code
   ↓
(internal filter pipeline: mutate, compile, run, dedupe)
   ↓
PR contains the surviving tests
   ↓
Stryker mutation-tests the whole suite (including the new tests)
   ↓
fqe reads exit code + mutation kill rate from Stryker JSON
   ↓
verdict: PASS if kill rate >= threshold for blast class; FAIL otherwise
```

## One-command install (JS/TS repos)

```bash
npx --yes github:booyajones/fqe#fqe-v0.4.0 cli/bin/fqe.js init --with-mutation
npm install --save-dev @stryker-mutator/core
git add .fqe.yml .github/ scripts/ stryker.conf.json package.json
git commit -m "Wire fqe + Stryker mutation gate"
```

That's the full setup. `init --with-mutation` writes the `stryker.conf.json`, the runner glue script at `scripts/fqe_stryker_runner.js`, and the `stryker-mutation` runner block in `.fqe.yml`. Open a PR, the gate fires.

For Python (mutmut), Java (PIT), or Go (go-mutesting), see "Common adjustments" below. The runner contract is the same; only the wrapped tool changes.

## Prerequisites

- Node, Python, Java, Go, or Ruby project with an existing test runner.
- Qodo Cover (`pip install qodo-cover` or the [Qodo Cover GitHub Action](https://github.com/qodo-ai/qodo-cover-action)). Optional in week 1 (Stryker alone provides the gate; Qodo Cover provides the test author).
- A mutation runner for your stack: [Stryker](https://stryker-mutator.io) (JS/TS, wired by `--with-mutation`), [mutmut](https://github.com/boxed/mutmut) (Python), [PIT](https://pitest.org) (Java), [go-mutesting](https://github.com/avito-tech/go-mutesting) (Go).

## `.fqe.yml`

```yaml
# AI-quality gate. Two defenses on every PR with code changes:
# 1. Qodo Cover generates and filters tests via TestGen-LLM pipeline
# 2. Stryker mutation-tests the resulting suite; fqe gates on kill rate

runners:
  qodo-cover:
    command: "qodo-cover"
    args:
      - "--source-file-path"
      - "${FQE_CHANGED_FILES}"
      - "--test-file-path"
      - "test/"
      - "--code-coverage-report-path"
      - "coverage.xml"
      - "--coverage-type"
      - "cobertura"
      - "--desired-coverage"
      - "85"
      - "--max-iterations"
      - "3"
      - "--use-report-coverage-feature-flag"
    when: ["**/*.js", "**/*.ts", "**/*.py", "**/*.java", "**/*.go", "**/*.rb"]
    required: false   # informational in week 1; flip to required after tuning
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
      - name: qodo-cover
        env: { OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}" }
        run: |
          pip install qodo-cover
          qodo-cover --source-file-path src/ --test-file-path test/ --max-iterations 3
      - name: stryker
        run: npx stryker run --reporters json
      - name: fqe verdict
        run: |
          npx --yes github:booyajones/fqe#fqe-v0.4.0 cli/bin/fqe.js run \
            --full --base origin/main --output ./out/
      - name: upload receipt
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: qa-receipt-${{ github.sha }}
          path: out/QA-RESULT.*
```

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

- **Qodo Cover requires an LLM key.** It calls Claude or GPT to generate test candidates. Cost: ~$0.05 to $0.50 per file iteration for typical sizes. Budget ~$50/month per engineer.
- **Stryker is slow on large suites.** For a 1000-test suite expect 10-20 minutes per run. Scope tightly with `mutate: ["src/changed-module/**"]` if you can.
- **Mutation thresholds should rise over time.** Start the kill-rate threshold at 60%. Ratchet up by 5% each quarter. Engineers see the bar move and write better tests proactively.
- **Property-based tests amplify mutation testing.** Wire [fast-check](https://github.com/dubzzz/fast-check) for JS, [Hypothesis](https://hypothesis.readthedocs.io) for Python, [jqwik](https://jqwik.net) for Java. Mutation testing on property-based tests has the highest kill rate of any combination we've tested.

## Common adjustments

- **Python:** swap `stryker` for `mutmut`. The runner script changes; the fqe contract does not.
- **Java:** swap for PIT. Same contract.
- **Monorepo:** run one mutation runner per package, each scoped via `when` and `mutate` patterns.
- **CI cost concerns:** scope mutation testing to changed files only (`mutate: ["${FQE_CHANGED_FILES}"]`). Full-suite mutation runs go on a nightly schedule, not per-PR.
