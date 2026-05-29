# Troubleshooting

Exact error message, exact fix. If you hit an error not listed here, please open an issue with the error string and the PR/run-id where it happened. We add cases as we hit them.

## CI errors

### `fatal: could not read Username for 'https://github.com': No such device or address`

**Where it appears:** the "Install fqe CLI" step of `fqe-quality.yml`.

**Root cause:** the workflow tried to clone `booyajones/fqe` at a tag, but the repo URL was for a PRIVATE repo and the workflow's `GITHUB_TOKEN` doesn't have access to other private repos.

**Fix:** the public source for fqe is `https://github.com/booyajones/fqe` (public). Your workflow YAML may be pointing at the wrong URL. Check `.github/workflows/fqe-quality.yml` for the `git clone` line. It should be `https://github.com/booyajones/fqe.git`, not `booyajones/finexio-skills` or anything else private.

### `fqe: error: (opts.output-text || "").slice is not a function`

**Where it appears:** the "Publish fqe/pass Check Run" step.

**Root cause:** an old version of the `parseFlags` helper treated `--output-text "$BODY"` as a boolean true when `$BODY` started with `--` (e.g., a YAML frontmatter delimiter `---`).

**Fix:** upgrade to `fqe-v0.1.0` or later. Re-pin the workflow's `git clone --branch fqe-v0.2.0` (the current tag) to pick up the fix. If you've pinned an older SHA, bump it.

### `fqe: error: 'gh' CLI not found on PATH`

**Where it appears:** the "Publish fqe/pass Check Run" step.

**Root cause:** the runner image doesn't have `gh` installed. GitHub-hosted `ubuntu-latest` has it by default. Self-hosted runners often don't.

**Fix:** the workflow exits with code 4 (INFRA) here, which maps to a neutral Check Run. It does NOT block your merge. If you want to fix it: install `gh` on your runner image, OR switch to `runs-on: ubuntu-latest`.

### `fqe: infra: gh api call failed with exit N`

**Where it appears:** the "Publish fqe/pass" step.

**Root cause:** GitHub API returned an error (rate limit, 5xx, network blip).

**Fix:** wait and re-run. Exit code 4 means the Check Run is neutral. Your merge is NOT blocked. If it persists for hours, GitHub may be having an incident. Check status.github.com.

### `fqe: error: required runner "X" did not run`

**Where it appears:** the receipt's "What this means" section.

**Root cause:** you set `required: true` on a runner in `.fqe.yml` but its `when` globs didn't match any files in this PR's diff, AND `always_run` is not set.

**Fix:** either widen the `when` glob, OR set `always_run: true` for runners that should fire on every PR regardless of diff.

### `Wilson CI upper X.XXXX exceeds canonical threshold Y.YYYY for blast_radius=Z on runner=W`

**Where it appears:** the receipt's "What this means" section. Verdict is FLAG (informational, does not block).

**Root cause:** the "W" runner has an attack-success rate whose Wilson 95% upper bound exceeds the canonical threshold for blast-radius class "Z". The canonical thresholds are locked in `cli/lib/verdict.js`: outbound ≤ 0.05, mcp-read ≤ 0.03, mcp-write-or-financial ≤ 0.01.

**Fix:** the Wilson CI shrinks based on BOTH your failure count AND your sample size. Two honest levers:
1. **Reduce failures.** Tighten prompts, filters, or generation logic in "W" so fewer adversarial attempts succeed. Each removed failure shifts the CI down substantially.
2. **Increase sample size** (only if your failure rate is already below the threshold). Run more attempts so the CI tightens around your observed rate. Use `fqe min-n <threshold>` to see how many attempts you'd need with zero failures.

Adding samples to a run that has any failures may not be enough by itself.

### `adversarial stat for "X" missing blast_radius`

**Where it appears:** the receipt's "What this means" section. Verdict is FAIL.

**Root cause:** the "X" runner emitted adversarial stats but didn't tag a `blast_radius` class.

**Fix:** in your runner's JSON output, add `"blast_radius": "outbound"` (or `mcp-read`, or `mcp-write-or-financial`) to each entry in `adversarial_stats`. See `docs/writing-a-runner.md` for the runner output format. Run `fqe thresholds` to see the full canonical class list.

### `adversarial stat for "X" has unknown blast_radius "Y"; known classes: ...`

**Root cause:** the "X" runner used a `blast_radius` value that isn't in the canonical map. The orchestrator cannot invent classes (closes a security gap).

**Fix:** change your runner's `blast_radius` to one of the known classes (`outbound`, `mcp-read`, or `mcp-write-or-financial`). The class determines the Wilson-CI threshold. "outbound" is most lenient (0.05), financial is strictest (0.01).

## Local errors

### `fqe: error: --commit must be 40-char hex`

**Root cause:** you passed a short SHA or an empty string to `fqe run`.

**Fix:** use the full 40-character SHA: `fqe run --commit $(git rev-parse HEAD) --output ./out/`.

### `init: target dir does not exist`

**Root cause:** you ran `fqe init --dir <path>` with a path that doesn't exist.

**Fix:** create the directory first, OR `cd` into the right place and run `fqe init` without `--dir`.

### `init: <path> is not a git repo. Run 'git init' first or pass --force.`

**Root cause:** `fqe init` refuses to bootstrap a directory that isn't a git repo.

**Fix:** run `git init` in the target directory first. Or pass `--force` if you know what you're doing.

### `init: all files already exist. Pass --force to overwrite, or this is a no-op.`

**Root cause:** `fqe init` is idempotent. It won't overwrite existing files without explicit consent.

**Fix:** pass `--force` if you want to regenerate. WARNING: this rewrites `.fqe.yml` and the workflow files. Any local customizations are lost.

## "It's not blocking but I want it to"

If you've added `fqe-quality.yml` to your repo and it's running, but PRs can still merge without it being green, you haven't configured branch protection. See [docs/getting-started.md#step-5-make-it-block-merges](getting-started.md#step-5-make-it-block-merges).

## "It's blocking and I need to ship NOW"

Two paths:

1. **Fix the underlying failure.** Run `fqe run` locally, read the explainer output, apply the fix. Usually 2-5 minutes.
2. **Bypass with the `fqe-bypass` label** if you have repo-write permission and you're on the `.github/fqe-bypass-allowlist.yml`. Bypass is logged in the rolling tally. If your team's bypass rate goes above 10% in a 14-day window, the `fqe/second-reviewer-required` check goes red until a different allowlisted reviewer adds the `fqe-second-approved` label.

`fqe` does not punish bypass. It audits it.

## "It's not detecting my repo correctly"

`fqe init --force` re-runs the smart-detect against the current state of the repo. If a marker you expect isn't being detected, open an issue with the marker name and what your repo looks like.

Currently detected markers:
- `package.json` → Node project
- `next.config.{js,mjs,ts}` → Next.js app
- `pyproject.toml` / `requirements.txt` / `setup.py` → Python project
- `*.xlsx` files at root or in `data/`, `models/`, `finance/` → Excel financial model
- `.vale.ini` → Vale prose linter
- `templates/`, `emails/`, `outbound/` directories → outbound communications
- `mcp/`, `mcp.json`, `manifest.json` → MCP server

## Still stuck?

1. Run `fqe explain` (in the affected repo). Paste the output.
2. Run `node --version`, `gh --version`, `yq --version`. Paste the output.
3. Open an issue at github.com/booyajones/fqe with the PR or run-id where the error occurred.
