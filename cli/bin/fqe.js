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
 *   1  generic error
 *   2  verdict = FAIL (build should not proceed)
 *   3  verdict = FLAG (build can proceed but is flagged)
 */

const fs = require('node:fs');
const path = require('node:path');
const { computeVerdict, PASS, FLAG, FAIL, BLAST_RADIUS_THRESHOLDS } = require('../lib/verdict');
const { wilson95, minNForUpperBound } = require('../lib/wilson');
const {
  buildReceipt, serializeReceipt, parseReceiptYaml, writeReceiptFiles,
  hashFiles, hashString, REQUESTER_SOURCE_OK,
} = require('../lib/receipt');
const tally = require('../lib/bypass_tally');
const orchestrator = require('../lib/orchestrator');
const initLib = require('../lib/init');
const explainLib = require('../lib/explain');

const FQE_VERSION = '0.1.0';

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
      if (opts['requester-source'] !== REQUESTER_SOURCE_OK) {
        die(`generate-bypass: requester-source MUST be '${REQUESTER_SOURCE_OK}' (closes v5 identity flaw)`);
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
    die(e.message || String(e));
  }
}

main();
