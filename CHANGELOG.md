# Changelog

All notable changes to fqe. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Semver: MAJOR for invariant changes, MINOR for new features under stable invariants, PATCH for bug fixes.

## [0.1.0] - 2026-05-24

Initial public release. Tag: `fqe-v0.1.0`. Source: github.com/booyajones/fqe.

### Added

- **`fqe run`** orchestrator that classifies the PR diff against `.fqe.yml` and dispatches matching runners as subprocesses.
- **`fqe verdict`** deterministic Node function computing PASS/FLAG/FAIL from runner exit codes + Wilson 95% CI bounds on adversarial stats.
- **`fqe explain`** staff-engineer 5-minute audit. Renders the three architectural invariants, canonical thresholds, current config, exit code taxonomy.
- **`fqe init`** with smart-detect repo bootstrap. Sniffs `package.json`, `pyproject.toml`, `.xlsx` files, `.vale.ini`, `templates/`, MCP markers. Generates context-aware `.fqe.yml` with commented suggestions per detected stack.
- **`fqe receipt`** subcommand suite (build, write, parse, generate-bypass) producing tamper-evident QA-RESULT.{yml,md} bound to `commit_sha + content_hash + inputs_hash`.
- **`fqe status publish`** that calls the GitHub Checks API via `gh api --input -` (nested JSON body, not form fields).
- **`fqe bypass-tally`** JSONL-based 14-day rolling rate tracker with separate run and bypass append commands.
- **`fqe wilson`**, **`fqe min-n`**, **`fqe thresholds`** utility commands for engineers debugging adversarial stat configs.
- **Engineer-grade failure explanations** in receipt markdown bodies. Every FAIL or FLAG includes plain-English reason, fix suggestion, copy-pasteable repro command.
- **Exit code taxonomy**: 0=PASS, 2=FAIL (block), 3=FLAG (informational), 4=INFRA (neutral Check Run, never blocks), 1=ERROR.
- **GitHub Actions workflow templates** (`fqe-quality.yml`, `fqe-second-approve.yml`) with tag-pinned clone of `booyajones/fqe@fqe-v0.1.0` and SHA256-verified yq install.
- **Auto-detect default branch** during `fqe init` (works on `main`, `master`, `develop`).
- **Three architectural invariants enforced in code**: (1) identity from GitHub Events API only, (2) no LLM in verdict path, (3) no required state only in PR branch.

### Tested

- 162 tests pass (unit + integration), 1 properly-skipped (symlink test on Windows).
- Wilson CI math pinned against `statsmodels.stats.proportion.proportion_confint` to 14 decimal places.
- Real GitHub Actions verification: https://github.com/booyajones/fqe-smoke-test/pull/1 (merged, both Check Runs SUCCESS).
- Excel runner validated against external 13,383-formula `vinci1it2000/formulas` test fixture (EUPL-1.1, public).

### Known limitations (planned for 0.2)

- **No JSON Schema for `.fqe.yml`** yet. VSCode autocomplete pending.
- **No published Docker image**. Workflows clone-and-install (about 20s overhead per CI run). Once published, swap `container: ghcr.io/booyajones/fqe:0.1`.
- **TTL bypass labels** (`fqe/bypass-24h`, `fqe/bypass-48h`, `fqe/bypass-72h`) are designed but not yet wired in the workflow template. v0.1 uses a single `fqe-bypass` label without TTL.
- **No `create-fqe-runner` scaffold**. Plugin authoring is doc-driven only.

### Migration notes

This is v0.1.0. No prior version to migrate from.
