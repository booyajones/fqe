#!/usr/bin/env node
'use strict';

/**
 * fqe — Finexio Quality Engine CLI entry.
 *
 * Pure orchestration. Each subcommand calls a lib function. No business logic
 * in this file. No LLM in any path. Same input -> same output -> same exit code.
 *
 * Subcommands:
 *   fqe verdict <results-json>           Compute verdict from runner results JSON
 *   fqe receipt build <ctx-json>         Build receipt object (stdout = YAML)
 *   fqe receipt write <ctx-json> <dir>   Build + write QA-RESULT.{yml,md}
 *   fqe receipt parse <path-to-yml>      Parse receipt, print verdict to stdout
 *   fqe receipt generate-bypass ...      Build a bypass-path receipt
 *   fqe bypass-tally append-run <dir>    Append a run event
 *   fqe bypass-tally append-bypass <dir> Append a bypass event
 *   fqe bypass-tally rate <dir>          Compute rolling rate
 *   fqe status print <yml-path>          Print suggested GitHub check state (success|failure)
 *   fqe smoke-tools                      Run Day 1.0 smoke test
 *   fqe version                          Print version
 *
 * Exit codes:
 *   0  success / verdict=PASS
 *   1  generic error (includes a malformed .fqe.yml: fail closed, never neutral)
 *   2  verdict = FAIL (build should not proceed)
 *   3  verdict = FLAG (build can proceed but is flagged)
 *   4  INFRA (fqe itself errored, e.g. gh API timeout; neutral Check Run, never blocks)
 */

const fs = require('node:fs');
const path = require('node:path');
const { computeVerdict, PASS, FLAG, FAIL, BLAST_RADIUS_THRESHOLDS } = require('../lib/verdict');
const { wilson95, minNForUpperBound } = require('../lib/wilson');
const {
  buildReceipt, serializeReceipt, parseReceiptYaml, writeReceiptFiles,
  hashFiles, hashString, REQUESTER_SOURCE_OK, REQUESTER_SOURCES_OK,
} = require('../lib/receipt');
const tally = require('../lib/bypass_tally');
const orchestrator = require('../lib/orchestrator');
const initLib = require('../lib/init');
const explainLib = require('../lib/explain');
const coverageRatchet = require('../lib/coverage_ratchet');
const mutationGate = require('../lib/mutation_gate');
const configSchema = require('../lib/config_schema');
const oracleGuard = require('../lib/oracle_guard');
const bypassGuard = require('../lib/bypass_guard');

const FQE_VERSION = '0.6.0';

// Exit code taxonomy (per council 1613ed kill-feature #5):
//   0 = PASS, 1 = unrecoverable error, 2 = FAIL (block), 3 = FLAG, 4 = INFRA (neutral)
const EXIT = Object.freeze({ PASS: 0, ERROR: 1, FAIL: 2, FLAG: 3, INFRA: 4 });

function die(msg, code = EXIT.ERROR) {
  process.stderr.write(`fqe: error: ${msg}\n`);
  process.exit(code);
}

/**
 * Wrap a function so that exceptions explicitly tagged as `{infra: true}`
 * exit with EXIT.INFRA (4) instead of EXIT.ERROR (1). CI workflows map exit 4
 * to a NEUTRAL Check Run (never blocks a merge — closes council kill-feature #5).
 */
function failInfra(msg) {
  process.stderr.write(`fqe: infra: ${msg}\n`);
  process.exit(EXIT.INFRA);
}

function readJsonInput(arg) {
  // accept either a file path or a literal "-" meaning stdin
  if (arg === '-' || arg === undefined) {
    const text = fs.readFileSync(0, 'utf8');
    return JSON.parse(text);
  }
  if (!fs.existsSync(arg)) die(`input file not found: ${arg}`);
  return JSON.parse(fs.readFileSync(arg, 'utf8'));
}

const SUBCOMMANDS = {
  version() {
    process.stdout.write(`fqe ${FQE_VERSION}\n`);
  },

  explain(args) {
    // fqe explain [--dir D] [--json]
    // The staff-engineer 5-minute audit: invariants + thresholds + current
    // config + where to find the source. Council 1613ed kill-feature #2.
    const opts = parseFlags(args);
    const data = explainLib.explain({ dir: opts.dir || process.cwd() });
    if (opts.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      process.stdout.write(explainLib.renderExplainText(data) + '\n');
    }
  },

  init(args) {
    // fqe init [--dir D] [--force] [--actor LOGIN] [--with-mutation] [--with-qodo]
    // Bootstrap a repo with .fqe.yml + GitHub workflows + allowlists.
    // --with-mutation also drops in the Stryker runner glue + stryker.conf.json
    //   and adds a stryker-mutation runner block to .fqe.yml.
    // --with-qodo also drops in the Qodo Cover runner glue (uses ANTHROPIC_API_KEY
    //   by default, falls back to OPENAI_API_KEY) and adds a qodo-cover runner block.
    // See docs/recipes/ai-test-generation.md for the full pipeline rationale.
    const opts = parseFlags(args);
    const result = initLib.init({
      dir: opts.dir || process.cwd(),
      force: opts.force === true,
      actor: opts.actor,
      withMutation: opts['with-mutation'] === true,
      withQodo: opts['with-qodo'] === true,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.skipped.length > 0 && result.written.length === 0) {
      // Nothing written, all skipped — exit via die() so taxonomy is consistent
      die('init: all files already exist. Pass --force to overwrite, or this is a no-op.');
    }
  },

  verdict(args) {
    const input = readJsonInput(args[0]);
    const out = computeVerdict(input);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (out.verdict === FAIL) process.exit(2);
    if (out.verdict === FLAG) process.exit(3);
    process.exit(0);
  },

  run(args) {
    // fqe run [--full|--quick] --commit <sha> --output <dir> [--config <.fqe.yml>] [--base <sha>]
    // Composes verified pieces. Returns verdict + writes QA-RESULT.{yml,md}.
    const opts = parseFlags(args);
    requireFlags(opts, ['commit', 'output']);
    if (!/^[a-f0-9]{40}$/.test(opts.commit)) {
      die(`run: --commit must be 40-char hex, got '${opts.commit}'`);
    }
    const result = orchestrator.run({
      commitSha: opts.commit,
      baseSha: opts.base,
      prNumber: opts.pr,
      configPath: opts.config,
      outputDir: opts.output,
      repoDir: opts['repo-dir'],
      fqeVersion: FQE_VERSION,
    });
    process.stdout.write(JSON.stringify({
      verdict: result.verdict,
      reasons: result.reasons,
      ymlPath: result.ymlPath,
      mdPath: result.mdPath,
      runners_fired: result.classifier.runners_fired,
      changed_file_count: result.changed_files.length,
    }, null, 2) + '\n');
    if (result.verdict === FAIL) process.exit(2);
    if (result.verdict === FLAG) process.exit(3);
    process.exit(0);
  },

  validate(args) {
    // fqe validate [--config .fqe.yml] [--dir D]
    // Check .fqe.yml against the schema BEFORE it can silently disable a gate.
    // No config = no runners = always PASS, so a missing file is valid.
    // exit 0 = valid, exit 1 = invalid (same fail-closed code `run` uses).
    const opts = parseFlags(args);
    const dir = opts.dir || process.cwd();
    const configPath = opts.config || path.join(dir, '.fqe.yml');
    if (!fs.existsSync(configPath)) {
      process.stdout.write(JSON.stringify({
        valid: true, config: configPath, errors: [],
        note: 'no .fqe.yml present (no runners configured, gate passes)',
      }, null, 2) + '\n');
      return;
    }
    let parsed;
    try {
      parsed = orchestrator.parseConfigYaml(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      die(`validate: ${configPath} could not be parsed: ${e.message}`);
    }
    const result = configSchema.validateConfig(parsed);
    process.stdout.write(JSON.stringify({
      valid: result.valid, config: configPath, errors: result.errors,
    }, null, 2) + '\n');
    if (!result.valid) {
      for (const e of result.errors) process.stderr.write(`  ${e}\n`);
      die(`validate: ${result.errors.length} problem(s) in ${configPath}`);
    }
  },

  'oracle-guard'(args) {
    // fqe oracle-guard [--changed "a,b"] [--base SHA --head SHA] [--repo-dir D]
    //                  [--include-tests] [--block]
    // Detects when a PR edits the recorded ground truth / grading rules it is
    // judged by (golden masters, snapshots, cassettes, fixtures, seeds,
    // .fqe.yml, coverage-baseline.json, mutation config, reviewer allowlists),
    // or, with --include-tests, edits a test file alongside the source it
    // grades. Emits a signal the fqe-second-approve workflow uses to require a
    // second human. The guard detects; the workflow enforces.
    // exit 0 = clean / 3 = FLAG (signal, default) / 2 = FAIL (--block).
    const opts = parseFlags(args);
    const resolved = oracleGuard.resolveChangedFiles({
      changed: typeof opts.changed === 'string' ? opts.changed : undefined,
      baseSha: opts.base,
      headSha: opts.head,
      repoDir: opts['repo-dir'],
    });
    let result;
    if (!resolved.ok) {
      // Fail CLOSED. If the guard cannot see the diff, it must NOT report clean.
      // Treat an unreadable diff as "needs a second reviewer" so an unreadable
      // diff cannot silently turn the tamper guard off.
      result = {
        requires_second_review: true,
        tampered: true,
        oracle_files: [],
        test_files: [],
        source_files: [],
        reasons: [
          `ORACLE_DIFF_INDETERMINATE: could not read the PR diff (${resolved.reason}). ` +
          `Failing closed: a guard that cannot see the diff must not pass. ` +
          `Pass --base/--head or --changed so the guard can see the PR.`,
        ],
      };
    } else {
      result = oracleGuard.evaluateOracleGuard({
        files: resolved.files,
        includeTests: opts['include-tests'] === true,
      });
    }
    const exitCode = result.requires_second_review
      ? (opts.block === true ? EXIT.FAIL : EXIT.FLAG)
      : EXIT.PASS;
    // Runner-shaped JSON line so this can also be wired as an fqe runner.
    process.stdout.write(JSON.stringify({
      runner: 'oracle-guard',
      exit_code: exitCode,
      requires_second_review: result.requires_second_review,
      oracle_files: result.oracle_files,
      test_files: result.test_files,
      source_files: result.source_files,
      reasons: result.reasons,
    }, null, 2) + '\n');
    if (result.requires_second_review) {
      for (const r of result.reasons) process.stderr.write(`  ${r}\n`);
      process.exit(exitCode);
    }
  },

  'bypass-check'(args) {
    // fqe bypass-check --comments <file|-> --head <40hex>
    //                  (--allowed "a,b" | --allowlist-file <path>) [--now ISO]
    // Evaluates a SHA-bound /fqe-bypass <sha> <ttl> PR comment. The binding is
    // SHA equality, so a new push invalidates the bypass automatically. Identity
    // and time come from the server-recorded comment objects only.
    // exit 0 = a valid bypass applies (skip the gate); 3 = no valid bypass (run
    // the gate); 1 = malformed inputs. Fail closed: any non-zero means run the gate.
    const opts = parseFlags(args);
    requireFlags(opts, ['head']);
    if (!/^[a-f0-9]{40}$/.test(opts.head)) {
      die(`bypass-check: --head must be 40-char hex, got '${opts.head}'`);
    }
    const comments = readJsonInput(opts.comments);
    if (!Array.isArray(comments)) {
      die('bypass-check: --comments must be a JSON array of comment objects');
    }
    let allowlist = [];
    if (typeof opts.allowed === 'string') {
      allowlist = opts.allowed.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (opts['allowlist-file']) {
      if (!fs.existsSync(opts['allowlist-file'])) die(`bypass-check: allowlist file not found: ${opts['allowlist-file']}`);
      allowlist = fs.readFileSync(opts['allowlist-file'], 'utf8')
        .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    }
    const result = bypassGuard.evaluateBypass({
      comments, headSha: opts.head, allowlist, now: opts.now,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.bypass) {
      process.stderr.write(`  ${result.reason}\n`);
      process.exit(EXIT.FLAG); // 3 = no valid bypass; the gate should run normally
    }
  },

  'receipt'(args) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === 'build') {
      const ctx = readJsonInput(rest[0]);
      const r = buildReceipt(ctx);
      const { yaml } = serializeReceipt(r);
      process.stdout.write(yaml);
    } else if (sub === 'write') {
      const ctx = readJsonInput(rest[0]);
      const dir = rest[1];
      if (!dir) die('receipt write: <output-dir> required');
      const r = buildReceipt(ctx);
      const { ymlPath, mdPath } = writeReceiptFiles(r, dir);
      process.stdout.write(`${ymlPath}\n${mdPath}\n`);
    } else if (sub === 'parse') {
      const p = rest[0];
      if (!p) die('receipt parse: <yml-path> required');
      const yaml = fs.readFileSync(p, 'utf8');
      const parsed = parseReceiptYaml(yaml);
      process.stdout.write(JSON.stringify({ verdict: parsed.verdict, commit_sha: parsed.commit_sha }) + '\n');
    } else if (sub === 'generate-bypass') {
      // expects args: --commit X --pr N --actor X --requester-source X --reason-link X --output dir
      const opts = parseFlags(rest);
      requireFlags(opts, ['commit', 'pr', 'actor', 'requester-source', 'output']);
      if (!REQUESTER_SOURCES_OK.has(opts['requester-source'])) {
        die(`generate-bypass: requester-source MUST be one of ${[...REQUESTER_SOURCES_OK].join(', ')} (closes v5 identity flaw)`);
      }
      const now = new Date().toISOString();
      const ctx = {
        fqe_version: FQE_VERSION,
        run_id: opts['run-id'] || `bypass-${Date.now()}`,
        started_at: now,
        finished_at: now,
        commit_sha: opts.commit,
        // For a bypass we still need binding hashes — use empty-content sentinels
        // bound to the commit string itself so the receipt is reproducible.
        content_hash: hashString(`bypass-content:${opts.commit}`),
        inputs_hash: hashString(`bypass-inputs:${opts.commit}`),
        classifier_version: 1,
        runner_versions: { fqe: FQE_VERSION },
        runners_fired: [],
        runners: [],
        adversarial_stats: [],
        quarantined_tests: [],
        verdict: PASS,
        verdict_reasons: [`bypass by ${opts.actor} (source: ${opts['requester-source']})`],
        bypass: {
          requester: opts.actor,
          requester_source: opts['requester-source'],
          events_url: opts['events-url'] || `https://github.com/pr/${opts.pr}/events`,
          allowlist_version: opts['allowlist-version'] || 'sha256:' + '0'.repeat(64),
          timestamp: now,
        },
        evidence_paths: [],
      };
      const r = buildReceipt(ctx);
      const { ymlPath, mdPath } = writeReceiptFiles(r, opts.output);
      process.stdout.write(`${ymlPath}\n${mdPath}\n`);
    } else {
      die(`unknown receipt subcommand: ${sub}`);
    }
  },

  'bypass-tally'(args) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === 'append-run') {
      const opts = parseFlags(rest);
      requireFlags(opts, ['state-dir', 'pr', 'commit']);
      tally.appendRun(opts['state-dir'], { pr: parseInt(opts.pr, 10), commit: opts.commit });
      process.stdout.write('appended-run\n');
    } else if (sub === 'append-bypass') {
      const opts = parseFlags(rest);
      requireFlags(opts, ['state-dir', 'actor', 'pr', 'commit']);
      tally.appendBypass(opts['state-dir'], {
        actor: opts.actor,
        pr: parseInt(opts.pr, 10),
        commit: opts.commit,
      });
      process.stdout.write('appended-bypass\n');
    } else if (sub === 'rate') {
      const opts = parseFlags(rest);
      requireFlags(opts, ['state-dir']);
      const windowDays = opts['window-days'] ? parseInt(opts['window-days'], 10) : 14;
      const r = tally.rate(opts['state-dir'], { windowDays });
      // --format=scalar emits just the rate number for shell `[ "$RATE" > 0.10 ]` comparisons
      if (opts.format === 'scalar') {
        process.stdout.write(r.rate.toString() + '\n');
      } else {
        process.stdout.write(JSON.stringify(r) + '\n');
      }
    } else {
      die(`unknown bypass-tally subcommand: ${sub}`);
    }
  },

  'status'(args) {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === 'print') {
      const ymlPath = rest[0];
      if (!ymlPath) die('status print: <yml-path> required');
      const yaml = fs.readFileSync(ymlPath, 'utf8');
      const parsed = parseReceiptYaml(yaml);
      // Map verdict to GitHub check conclusion:
      //   PASS -> success (build can proceed)
      //   FLAG -> success on fqe/pass + flag emitted separately (FLAG is informational)
      //   FAIL -> failure
      const state = parsed.verdict === FAIL ? 'failure' : 'success';
      process.stdout.write(JSON.stringify({
        verdict: parsed.verdict,
        check_state: state,
        commit_sha: parsed.commit_sha,
        bypass: parsed.bypass ? true : false,
      }) + '\n');
    } else if (sub === 'publish') {
      // Publishes a GitHub Check Run via `gh` CLI. Requires gh authenticated
      // (GH_TOKEN env var or `gh auth login`).
      //
      // fqe status publish --check fqe/pass --commit SHA --state success|failure
      //                    [--description "..."] [--output-text "..."] [--repo owner/repo]
      //
      // Returns 0 on success, 1 on failure. Workflow integration step uses this.
      const opts = parseFlags(rest);
      requireFlags(opts, ['check', 'commit', 'state']);
      if (!['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out'].includes(opts.state)) {
        die(`status publish: invalid --state '${opts.state}' (must be success|failure|neutral|cancelled|skipped|timed_out)`);
      }
      if (!/^[a-f0-9]{40}$/.test(opts.commit)) {
        die(`status publish: --commit must be 40-char hex, got '${opts.commit}'`);
      }
      const repo = validateRepoFlag(opts.repo || process.env.GITHUB_REPOSITORY);
      if (!repo) {
        die('status publish: --repo or GITHUB_REPOSITORY env var required');
      }
      // Build the JSON body for the GitHub check-runs API.
      // Closes gauntlet 125882 fatal flaw: `-f 'output[title]=...'` would have
      // sent form fields, which GitHub's API doesn't parse as a nested JSON
      // body. The correct approach for nested objects is `gh api --input -`
      // with the JSON body piped via stdin.
      //
      // opts.description may be the literal empty string after the parseFlags
      // polish fix (gauntlet 125a6e item #1); coalesce only when undefined.
      const title = opts.description !== undefined ? opts.description : `fqe ${opts.state}`;
      const body = {
        name: opts.check,
        head_sha: opts.commit,
        status: 'completed',
        conclusion: opts.state,
        output: {
          title,
          // Check Run output text limit is 65,535 chars; truncate fail-closed.
          summary: (opts['output-text'] || '').slice(0, 65000),
        },
      };
      const ghArgs = [
        'api',
        '--method', 'POST',
        '--input', '-',
        `/repos/${repo}/check-runs`,
      ];
      // --dry-run is for tests / safety: doesn't call gh, just prints the
      // request body and exits 0. Workflows never set --dry-run.
      if (opts['dry-run']) {
        process.stdout.write(JSON.stringify({
          gh_command: ['gh', ...ghArgs],
          body,
        }, null, 2) + '\n');
        return;
      }
      const { spawnSync } = require('node:child_process');
      const r = spawnSync('gh', ghArgs, {
        input: JSON.stringify(body),
        encoding: 'utf8',
      });
      // All failure paths below are INFRASTRUCTURE failures (gh missing, gh
      // timed out, GitHub API 5xx). They exit 4 (INFRA) so CI maps them to a
      // NEUTRAL Check Run that does NOT block merges. Closes council 1613ed
      // kill-feature #5 — fqe's own bugs / GitHub flakes shouldn't lock the
      // team out of shipping.
      if (r.error && r.error.code === 'ENOENT') {
        failInfra(
          "status publish: 'gh' CLI not found on PATH. Install from https://cli.github.com/ " +
          "and run 'gh auth login', or set GH_TOKEN env in a CI environment that has it pre-installed."
        );
      }
      if (r.error) {
        failInfra(`status publish: failed to invoke gh: ${r.error.message}`);
      }
      if (r.status !== 0) {
        process.stderr.write(r.stderr || '');
        failInfra(`status publish: gh api call failed with exit ${r.status}`);
      }
      process.stdout.write(`published check ${opts.check} state=${opts.state} commit=${opts.commit}\n`);
    } else {
      die(`unknown status subcommand: ${sub} (known: print, publish)`);
    }
  },

  'coverage-ratchet'(args) {
    // fqe coverage-ratchet --report FILE [--baseline FILE] [--patch PCT]
    //                      [--patch-threshold 80] [--bump]
    // Enforces: changed lines >= patch-threshold, AND total never drops below
    // the committed baseline. Exit 2 (FAIL) blocks merge. Exit 0 passes.
    // With --bump, on a PASS that improved coverage, writes the new baseline.
    const opts = parseFlags(args);
    if (!opts.report) {
      die('coverage-ratchet: --report <coverage file> is required');
    }
    let reportText;
    try {
      reportText = fs.readFileSync(opts.report, 'utf8');
    } catch (e) {
      // A missing/unreadable coverage report is an infra problem, not a policy
      // violation: neutral, do not block the merge on fqe's own inability to read.
      return failInfra(`coverage-ratchet: cannot read report ${opts.report}: ${e.message}`);
    }
    const currentTotal = coverageRatchet.parseCoverage(reportText);

    let baselineTotal = null;
    const baselinePath = opts.baseline || 'coverage-baseline.json';
    if (fs.existsSync(baselinePath)) {
      try {
        baselineTotal = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).total;
      } catch { /* treat unreadable baseline as no baseline (first run) */ }
    }

    const patchCoverage =
      opts.patch !== undefined ? parseFloat(opts.patch) : null;
    const patchThreshold =
      opts['patch-threshold'] !== undefined ? parseFloat(opts['patch-threshold']) : 80;

    const result = coverageRatchet.evaluateRatchet({
      currentTotal,
      baselineTotal,
      patchCoverage,
      patchThreshold,
    });

    process.stdout.write(JSON.stringify({ ...result, currentTotal, baselineTotal }, null, 2) + '\n');

    // Optionally write the bumped baseline (post-merge step uses --bump).
    if (opts.bump === true && result.shouldBumpBaseline && result.newBaseline != null) {
      fs.writeFileSync(baselinePath, JSON.stringify({ total: result.newBaseline }, null, 2) + '\n');
      process.stderr.write(`coverage-ratchet: baseline bumped to ${result.newBaseline}%\n`);
    }

    if (!result.pass) {
      for (const r of result.reasons) process.stderr.write(`  ${r}\n`);
      process.exit(EXIT.FAIL);
    }
  },

  'mutation-gate'(args) {
    // fqe mutation-gate --report stryker.json [--threshold 70]
    //                   [--changed "a.ts,b.ts"] [--min-mutants 1]
    //   OR (Python/cosmic-ray): --killed N --surviving N [--threshold 70]
    // Rejects tests that run code but would not catch it breaking.
    // exit 0 pass / 2 FAIL (blocks) / 4 INFRA (insufficient mutants -> neutral).
    const opts = parseFlags(args);
    const threshold = opts.threshold !== undefined ? parseFloat(opts.threshold) : 70;
    const minMutants = opts['min-mutants'] !== undefined ? parseInt(opts['min-mutants'], 10) : 1;
    const changedFiles =
      typeof opts.changed === 'string' ? opts.changed.split(',').map((s) => s.trim()).filter(Boolean) : null;

    let gateInput;
    if (opts.report) {
      let text;
      try {
        text = fs.readFileSync(opts.report, 'utf8');
      } catch (e) {
        return failInfra(`mutation-gate: cannot read report ${opts.report}: ${e.message}`);
      }
      gateInput = { tally: mutationGate.parseStryker(text), threshold, changedFiles, minMutants };
    } else if (opts.killed !== undefined && opts.surviving !== undefined) {
      gateInput = { killed: parseFloat(opts.killed), surviving: parseFloat(opts.surviving), threshold, minMutants };
    } else {
      die('mutation-gate: provide --report <stryker.json> OR --killed N --surviving N');
    }

    const result = mutationGate.evaluateMutationGate(gateInput);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');

    if (result.insufficient) {
      // Cannot judge (no/too-few mutants, or unreadable): neutral, never block.
      for (const r of result.reasons) process.stderr.write(`  ${r}\n`);
      return failInfra('mutation-gate: insufficient data to judge; neutral.');
    }
    if (!result.pass) {
      for (const r of result.reasons) process.stderr.write(`  ${r}\n`);
      process.exit(EXIT.FAIL);
    }
  },

  wilson(args) {
    // utility: fqe wilson <successes> <n>
    const s = parseInt(args[0], 10);
    const n = parseInt(args[1], 10);
    const out = wilson95(s, n);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  },

  'min-n'(args) {
    // utility: fqe min-n <target>
    const target = parseFloat(args[0]);
    process.stdout.write(`${minNForUpperBound(target)}\n`);
  },

  'thresholds'() {
    process.stdout.write(JSON.stringify(BLAST_RADIUS_THRESHOLDS, null, 2) + '\n');
  },

  help() {
    process.stdout.write([
      'fqe — Finexio Quality Engine',
      '',
      'usage: fqe <subcommand> [args...]',
      '',
      'gate workflow:',
      '  init [--dir D] [--force]            bootstrap a repo with .fqe.yml + GitHub workflows',
      '  run --commit SHA --output DIR       orchestrate: classify diff -> spawn runners -> verdict + receipt',
      '                                        [--base SHA] [--config .fqe.yml] [--pr N] [--repo-dir D]',
      '  explain [--dir D] [--json]          5-minute architectural audit: invariants, thresholds, current config',
      '  validate [--config .fqe.yml]        check .fqe.yml fail-closed: unknown keys, bad types, never-fires runners',
      '  oracle-guard [--changed "a,b"]      flag a PR that edits its own ground truth / grading rules',
      '               [--base SHA --head SHA] [--include-tests] [--block]   (requires a second reviewer)',
      '  bypass-check --comments F --head SHA  validate a SHA-bound /fqe-bypass comment (TTL + allowlist,',
      '               (--allowed "a,b" | --allowlist-file F) [--now ISO]    head-bound; exit 0=bypass, 3=none)',
      '',
      'verdict + receipt primitives:',
      '  verdict <results-json|->            compute verdict deterministically (no LLM in path)',
      '  receipt build <ctx-json|->          emit YAML receipt to stdout',
      '  receipt write <ctx-json> <dir>      write QA-RESULT.{yml,md}',
      '  receipt parse <yml-path>            parse receipt, print verdict + commit_sha as JSON',
      '  receipt generate-bypass --commit SHA --pr N --actor X',
      '                          --requester-source github_events_api_v3',
      '                          [--events-url URL] [--allowlist-version SHA] --output DIR',
      '',
      'bypass tally (14-day rolling rate):',
      '  bypass-tally append-run    --state-dir D --pr N --commit SHA',
      '  bypass-tally append-bypass --state-dir D --actor X --pr N --commit SHA',
      '  bypass-tally rate          --state-dir D [--window-days N] [--format scalar|json]',
      '',
      'GitHub check publishing:',
      '  status print <yml-path>             map verdict -> GitHub check state JSON',
      '  status publish --check NAME --commit SHA --state success|failure|neutral',
      '                 [--description T] [--output-text BODY] [--repo OWNER/REPO]',
      '                 [--dry-run]         show what gh api call would be sent (no network)',
      '',
      'utilities:',
      '  version                             print fqe version',
      '  wilson <successes> <n>              Wilson 95% CI for a binomial proportion',
      '  min-n <target>                      min N to defend an upper bound (0 successes)',
      '  thresholds                          canonical blast-radius thresholds (Object.freeze\'d in verdict.js)',
      '  coverage-ratchet --report FILE      enforce coverage never drops + new code is tested',
      '                   [--baseline coverage-baseline.json] [--patch PCT]',
      '                   [--patch-threshold 80] [--bump]   exit 2 blocks merge',
      '  mutation-gate --report stryker.json  reject tests that run code but would not',
      '                [--threshold 70] [--changed "a.ts,b.ts"]   catch it breaking.',
      '                OR --killed N --surviving N (cosmic-ray/Python). exit 2 blocks; 4 if too few mutants',
      '  smoke-tools                         Phase 1 Day 1.0 verification (local)',
      '',
      'exit codes:',
      '   0  PASS — gate is green, merge can proceed',
      '   2  FAIL — policy violation, merge blocked',
      '   3  FLAG — informational, merge can proceed but a concern was raised',
      '   4  INFRA — fqe itself errored (gh API timeout, missing binary); Check Run is neutral, never blocks',
      '   1  ERROR — unrecoverable script error before verdict (should be rare)',
      '',
      'docs: https://github.com/booyajones/finexio-skills/tree/main/fqe',
      '',
    ].join('\n'));
  },
};

function parseFlags(args) {
  // Treat `--foo` as boolean true ONLY when next arg is missing, OR next arg
  // is an actual flag (matches /^--[A-Za-z]/, i.e. `--word`). String content
  // that happens to start with `--` (e.g. a YAML frontmatter delimiter `---`)
  // is a legitimate VALUE, not the start of another flag. This was a bug
  // caught by the real-CI PR test 2026-05-24: --output-text "$BODY" where
  // BODY starts with "---\n..." silently set --output-text to boolean true.
  //
  // Conventional rule (matches most CLI parsers): an arg is a flag only if it
  // starts with `--` followed by an ASCII letter. Anything else is a value.
  const FLAG_RE = /^--[A-Za-z]/;
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAG_RE.test(a)) {
      const key = a.slice(2);
      const hasNext = i + 1 < args.length;
      const next = hasNext ? args[i + 1] : undefined;
      if (!hasNext || FLAG_RE.test(next)) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function validateRepoFlag(repo) {
  if (!repo) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    die(`--repo must be in 'owner/name' format (got '${repo}')`);
  }
  return repo;
}

function requireFlags(opts, names) {
  for (const n of names) {
    if (opts[n] === undefined) die(`missing required flag: --${n}`);
  }
}

function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub || sub === '-h' || sub === '--help') {
    SUBCOMMANDS.help();
    return;
  }
  const fn = SUBCOMMANDS[sub];
  if (!fn) die(`unknown subcommand: ${sub}. Run 'fqe help' for usage.`);
  try {
    fn(rest);
  } catch (e) {
    // A malformed .fqe.yml MUST block (ERROR), never map to a neutral/INFRA
    // outcome. Bind that explicitly so a future refactor cannot regress it to
    // exit 4 and let a broken config pass green.
    if (e && e.fqeConfigInvalid) {
      process.stderr.write(`fqe: ${e.message}\n`);
      process.exit(EXIT.ERROR);
    }
    die(e.message || String(e));
  }
}

main();
