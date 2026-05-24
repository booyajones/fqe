# Finexio Quality Engine (FQE)

A unified mechanical QA gate for Finexio's Claude-driven build workflow. Replaces ad-hoc discipline with enforced gates that survive six rounds of adversarial multi-LLM review.

## The problem this solves

Finexio's QA failures over the last 90 days all share one root cause: **trusted rules that never became enforced gates**. Concrete examples from memory:

- Phoenix v7 shipped with 6 bugs (3 Sev 1) under a green Validation tab
- Asignet v1.0 shipped with 4 CRITICAL defects despite "QA pass"
- Webflow FAQ schema rendered as visible body text on finexio.com because nothing checked the live URL
- Stale narrative numbers persisted across model versions because nothing scanned for them
- Discipline rules written in CLAUDE.md were discounted in-session under deadline pressure

FQE makes the rules mechanical. Once active, the gate cannot be rationalized around.

## Architecture in one diagram

```
                  CODE CHANGE
                       │
                       ▼
              git pre-push (local fast)
                       │
                       ▼
                  Push to GitHub
                       │
                       ▼
       fqe-quality.yml runs in Docker container
       ghcr.io/finexio/fqe:0.1
                       │
              ┌────────┴────────┐
              │ Bypass check    │  ◄── identity from Events API
              │ (server-side)   │      not from any file
              └────────┬────────┘
                       │
       ┌───────────────┼───────────────────┐
       │     Bypass    │    Normal         │
       │     ↓         │    ↓              │
       │  receipt      │  per-class        │
       │  +tally       │  runners          │
       │               │  ↓                │
       │               │  verdict.js       │ ◄── no LLM in path
       │               │  (deterministic)  │
       └───────────────┴───────────────────┘
                       │
                       ▼
              QA-RESULT.md (receipt)
              + workflow artifact
              + Check Run output
                       │
                       ▼
              fqe/pass status emitted
              (required check; cannot merge without)
                       │
                       ▼
              fqe/second-reviewer-required
              (failure if bypass rate > 10%)
```

## Three architectural invariants

These are the rules that survived six rounds of gauntlet review. Any v7 reviewer should test against them:

1. **No identity claim is ever read from a file the constrained actor wrote.** Bypass requester identity comes from the GitHub Events API. Receipt content is never trusted for identity.
2. **No LLM is in the verdict path.** `verdict.js` is a deterministic Node script. Unit-tested with table-driven cases against `node --test`.
3. **No required state lives only in the PR branch.** Receipts persist as workflow artifacts + Check Run outputs (server-side, immutable per run).

## What's here

| Path | Role | Status |
|---|---|---|
| `SKILL.md` | Claude Code entry point — triggers, behavior, anti-patterns | Complete |
| `cli/lib/verdict.js` | Deterministic verdict computation | Complete + unit-tested (10 cases) |
| `cli/lib/wilson.js` | Wilson 95% CI for adversarial stats | Complete + 12 cases pinned vs statsmodels |
| `cli/test/` | Unit tests (`node --test`) | 31/31 passing |
| `schemas/receipt-v1.yml` | Receipt schema, validation rules, decision table | Complete |
| `workflows/fqe-quality.yml.template` | Main CI gate workflow | Design intent; VERIFY markers for Phase 1.1 |
| `workflows/fqe-second-approve.yml.template` | Bypass-rate-exceeded unblock workflow | Design intent; VERIFY markers for Phase 1.1 |
| `smoke/smoke_tools.py` | Phase 1 Day 1.0 verification | Complete; 11/11 blocking checks passed against real Finexio workbooks |
| `hooks/pre-push.sh.template` | Local git pre-push hook | Pending Phase 1.1 |
| `setup/branch-protection-setup.sh` | One-time per-repo bootstrap | Pending Phase 1.1 |
| `cli/bin/fqe.js` | CLI entry point | Pending Phase 1.1 |
| `cli/lib/receipt.js` | Receipt generator + validator | Pending Phase 1.1 |

## Phase 1 Day 1.0 smoke results (2026-05-22)

Ran against your real Finexio artifacts:

- **cashflow v22b** (`Board Financials (Cashflow) May 2026.xlsx`): all 4 Excel runner defenses verified. Formulas read correctly (`=340408.324607506*POWER(1+Assumptions!$B$4,0)`), cached values numeric, `calcPr` element readable as `calcMode=auto fullCalcOnLoad=0`. Content hash computed.
- **AvidX Final** (`AvidX Diligence Response - Project Franklin - April 24 FINAL.xlsx`): formulas read correctly BUT cached values are null. **This is exactly the v6 design decision validated** — LibreOffice headless recompute is default-on (not `--strict` opt-in) precisely because workbooks like this exist. Without LibreOffice recompute, defense D (cached vs golden diff) would be useless for AvidX-class workbooks. The plan was right to mandate it.
- **Phoenix v7**: not at expected .xlsx paths. Per memory, it lives as a Google Sheet (ID `1VJpl8...`). **Architectural learning:** v1 Phase 2C needs an additional `gspread`-backed Google Sheets runner, not just openpyxl. This is the kind of finding Day 1.0 is supposed to surface before Phase 2 commits to a runner.

Full report: [tool-smoke.md](../../OneDrive/Desktop/Claude/audits/2026-05-22-qa-engine/tool-smoke.md)

## Plan trajectory (six iterations)

| Version | Score | Verdict | Fatal flaws | Key change |
|---|---|---|---|---|
| v1 | 60 | REVISE | 5 | Initial Claude-skill design |
| v2 | 60 | REVISE | 3 | Deterministic CLI replaces self-enforcing skill |
| v3 | 68 | REVISE | 2 | Drop xlwings; eliminate self-hosted Windows runner |
| v4 | 66 | REVISE | 2 | Triple-defense Excel; required checks pre-registered |
| v5 | 55 | REWORK | 3 | **Regressed** — receipt became attacker-controlled |
| **v6** | **76** | **SHIP*** | **0** | Identity from GitHub Events API; receipts as artifacts + Check Run outputs |

*both judges (Claude + GPT) concordant at 76, zero invariant-violating fatal flaws; chairman's qualitative verdict was SHIP

## Tooling (leverage, not build)

Pull in (all MIT/Apache/MPL): Playwright, axe-core, Lighthouse CI, Unlighthouse, openpyxl, LibreOffice headless, Promptfoo, Inspect AI, MCP Inspector CLI, Vale, Pandera, Stagehand (surgical), dorny/paths-filter.

Avoid: Lost Pixel (archived), Skyvern (AGPL), Pact (overkill for solo), xlcalculator (formula engine gaps), xlwings (security on self-hosted Windows runners), OpenAI Evals (stale), all closed SaaS.

## What's next

1. **Phase 1.1 work** — build out `cli/bin/fqe.js`, `cli/lib/receipt.js`, the CLI subcommands `fqe run`, `fqe verdict`, `fqe receipt generate`, `fqe bypass-tally`, `fqe status publish`. Roughly 200 LOC.
2. **Phase 1.2 work** — build and publish `ghcr.io/finexio/fqe:0.1` Docker image. Cosign-sign.
3. **Phase 1.3 work** — finalize workflow YAMLs against the real GitHub API (Events API pagination, Check Run output 65K char limit, cross-workflow artifact download — every `VERIFY` marker in the templates resolved).
4. **Phase 1.4 work** — run `branch-protection-setup.sh` against one Finexio repo as a pilot. Adversarial dry-runs from PLAN-v6 Section 5 Day 1.9.
5. **Phase 1 acceptance** — all 12 adversarial dry-run scenarios produce expected outcomes. Then live with the gate for 14 days, tracking bypass rate as the canary.

## References

- Canonical design: [PLAN-v6.md](../../OneDrive/Desktop/Claude/audits/2026-05-22-qa-engine/PLAN-v6.md)
- Iteration history: [PLAN-v1.md](../../OneDrive/Desktop/Claude/audits/2026-05-22-qa-engine/PLAN-v1.md) through PLAN-v5.md
- Adversarial reviews: [gauntlet_runs/](../../Downloads/gauntlet_runs/) (six reports)
- Expert advisory: [council_runs/](../../Downloads/council_runs/) (one heavy synthesis)
- Predecessor: [qa-pro skill](../qa-pro/) v1.1.0
