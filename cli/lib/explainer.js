'use strict';

/**
 * fqe explainer — turns terse machine reasons into engineer-readable English
 * with copy-pasteable fix commands.
 *
 * Per council 1613ed: failure messages that read like a senior engineer wrote
 * them are the #1 determinant of "respect vs mutiny" on first failure.
 *
 * Pure function: same reason in -> same explanation out. No I/O.
 * Called by receipt.js (markdown body) and fqe.js (--explain flag).
 */

const { wilson95 } = require('./wilson');

/**
 * Given a single reason string from verdict.js, return:
 *   { code, plain_english, fix, repro_command }
 *
 * Falls back to the original reason if no pattern matches (better than nothing).
 *
 * @param {string} reason
 * @param {{commit_sha?:string, base_sha?:string}} [ctx]
 * @returns {{code:string, plain_english:string, fix:string, repro_command:string}}
 */
function explainReason(reason, ctx = {}) {
  const baseCmd = ctx.base_sha ? `--base ${ctx.base_sha.slice(0, 7)}` : '--base origin/main';
  // `--commit` is REQUIRED by the parser. Every repro command here used to omit
  // it and pass `--full` and `--verbose`, neither of which exists, so the command
  // fqe printed to a blocked engineer failed on the first try with
  // "missing required flag: --commit". The parser accepted the phantom flags
  // silently, which is why they survived into six docs and this file.
  const commitCmd = ctx.commit_sha ? `--commit ${ctx.commit_sha}` : '--commit $(git rev-parse HEAD)';
  const repro = `fqe run ${commitCmd} ${baseCmd} --output ./out/`;

  // Pattern 0: the runner could not be started at all. Must be matched BEFORE
  // the generic "did not run", which it would otherwise fall through to.
  let m = reason.match(/^required runner "([^"]+)" FAILED TO START \(([^)]*)\)/);
  if (m) {
    const [, name, err] = m;
    return {
      code: 'RUNNER_SPAWN_FAILED',
      plain_english:
        `The "${name}" runner never started, so there is no exit code and nothing was tested. ` +
        `The operating system reported: ${err}. This is not a test failure; the command could not be executed.`,
      fix:
        `Check "${name}".command in .fqe.yml. On Windows, npm / npx / yarn / pnpm are .cmd shims and cannot be ` +
        `spawned directly: use command: "cmd" with args: ["/c", "npm", "test"]. On Linux and macOS, confirm the ` +
        `binary exists on PATH inside the runner environment (a devDependency binary needs npm ci to have run first).`,
      repro_command: repro,
    };
  }

  // Pattern 1: required runner did not run
  m = reason.match(/^required runner "([^"]+)" did not run$/);
  if (m) {
    const name = m[1];
    return {
      code: 'REQUIRED_RUNNER_MISSING',
      plain_english: `The "${name}" runner is configured as required in .fqe.yml but didn't fire on this PR. Either no files matched its "when" globs, or its command didn't execute.`,
      fix: `Check .fqe.yml: is "${name}".when set to a pattern that matches your changed files? If "${name}" should run on every PR, set "${name}".always_run: true.`,
      repro_command: repro,
    };
  }

  // Pattern 2: runner exited non-zero
  m = reason.match(/^runner "([^"]+)" exited (-?\d+)$/);
  if (m) {
    const [, name, exit] = m;
    return {
      code: 'RUNNER_EXIT_NONZERO',
      plain_english: `The "${name}" runner exited with code ${exit}, which fqe treats as a failure. The runner's own logs (uploaded as a workflow artifact) explain why.`,
      fix: `Download the qa-receipt artifact from this PR's workflow run to see the runner's stderr. Then reproduce locally with the repro command below.`,
      repro_command: repro,
    };
  }

  // Pattern 3: runner exit_code not a number — capture the actual malformed value
  m = reason.match(/^runner "([^"]+)" ran but exit_code is not a number \(got (.+)\)$/);
  if (m) {
    const [, name, badValue] = m;
    return {
      code: 'RUNNER_EXIT_MALFORMED',
      plain_english:
        `The "${name}" runner produced no usable exit code (got \`${badValue}\`). The most common cause by far is that the process never started, ` +
        `so there was no exit code to report. On Windows that happens with \`command: "npm"\` (and yarn, pnpm, npx), because those are \`.cmd\` shims and fqe spawns without a shell. ` +
        `Check the runner's duration in the receipt: a few milliseconds for a suite that takes seconds means nothing ran. It can also mean the process was killed by a signal or timed out.`,
      fix:
        `On Windows, use \`command: "cmd"\` with \`args: ["/c", "npm", "test"]\` (or point at the binary directly). On Linux/macOS, confirm the command exists on PATH in the runner environment. ` +
        `If your runner emits the optional stdout JSON line, check it parses: {"runner":"${name}","exit_code":<integer>,...}. ` +
        `To bypass in an emergency, an allowlisted maintainer posts \`/fqe-bypass <head-sha> <24h|48h|72h>\` as a PR comment.`,
      repro_command: repro,
    };
  }

  // Pattern 4: Wilson CI exceeds canonical threshold (v0.14: now carries an
  // optional "(recomputed from N/M)" segment because the interval is re-derived
  // from the raw counts in verdict Pass 3).
  m = reason.match(/^Wilson CI upper ([\d.]+) (?:\(recomputed from \d+\/\d+\) )?exceeds canonical threshold ([\d.]+) for blast_radius=(\S+) on runner=(\S+)$/);
  if (m) {
    const [, ciUpper, threshold, blast, runner] = m;
    const ciUpperNum = parseFloat(ciUpper);
    const thresholdNum = parseFloat(threshold);
    const gap = (ciUpperNum - thresholdNum).toFixed(4);
    return {
      code: 'ADVERSARIAL_CI_EXCEEDED',
      plain_english:
        `The "${runner}" runner generates content in blast-radius class "${blast}". On its sample, the Wilson 95% upper-bound attack-success-rate is ${ciUpper} — that's ${gap} above the canonical ${threshold} ceiling for this class. ` +
        `Plain English: at 95% confidence, the true rate of bad output could be as high as ${(ciUpperNum * 100).toFixed(2)}%, and the policy for "${blast}" says it must be at most ${(thresholdNum * 100).toFixed(2)}%.`,
      fix:
        `The Wilson upper bound depends on BOTH your failure count AND your sample size. There are two honest levers:\n` +
        `  (a) Reduce failures: tighten prompts/filters in the "${runner}" runner so fewer adversarial attempts succeed. Each failure removed shifts the CI down substantially.\n` +
        `  (b) Increase sample size (only helps if your failure RATE is already below ${threshold}): run more attempts so the CI tightens around your observed rate. Use 'fqe min-n ${threshold}' to see the minimum N needed to defend that bound with ZERO failures — adding samples to a run that has any failures may not be enough by itself.`,
      repro_command:
        `# Iterate locally to find a config that passes:\n` +
        `fqe min-n ${threshold}     # min N to defend ${threshold} with 0 failures\n` +
        `fqe wilson <successes> <n>  # check CI for any specific (k, n) pair`,
    };
  }

  // Pattern 5: missing blast_radius
  m = reason.match(/^adversarial stat for "([^"]+)" missing blast_radius$/);
  if (m) {
    const name = m[1];
    return {
      code: 'ADVERSARIAL_MISSING_BLAST_RADIUS',
      plain_english: `The "${name}" runner emitted adversarial stats but didn't tag a blast_radius class. fqe needs to know whether this affects outbound copy (≤5% ceiling), MCP-read (≤3%), or MCP-write-or-financial (≤1%) — different classes have different acceptable failure rates.`,
      fix: `In your runner's JSON output, add "blast_radius": "outbound" (or mcp-read, mcp-write-or-financial) to each adversarial_stats entry. See examples/ in github.com/booyajones/fqe for runner output format.`,
      repro_command: `fqe thresholds   # see the canonical blast-radius -> threshold map`,
    };
  }

  // Pattern 6: unknown blast_radius
  m = reason.match(/^adversarial stat for "([^"]+)" has unknown blast_radius "([^"]+)"; known classes: (.+)$/);
  if (m) {
    const [, name, bad, known] = m;
    return {
      code: 'ADVERSARIAL_UNKNOWN_BLAST_RADIUS',
      plain_english: `The "${name}" runner used blast_radius "${bad}" which isn't a known class. This is locked to ${known} — orchestrator cannot invent classes (closes a security gap).`,
      fix: `Change your runner's adversarial_stats[].blast_radius to one of: ${known}. The class determines the Wilson-CI threshold; outbound is most lenient, financial is strictest.`,
      repro_command: `fqe thresholds`,
    };
  }

  // Fallback: wrap with framing rather than leaking raw machine strings
  return {
    code: 'UNKNOWN_REASON',
    plain_english:
      `fqe produced a failure reason that doesn't match any known pattern: \`${reason}\`. ` +
      `This usually means a newer version of fqe is emitting reason text that this explainer hasn't been updated for, or the orchestrator passed a malformed reason. The verdict itself (PASS/FLAG/FAIL) is still trustworthy — only the friendly explanation is missing.`,
    fix: `File an issue at github.com/booyajones/fqe with the run-id from this PR. Pending fix, check the QA-RESULT.md artifact on this workflow run for full context.`,
    repro_command: `${repro} && cat ./out/QA-RESULT.md`,
  };
}

/**
 * Given a target threshold and observed CI upper, estimate how many more
 * passing samples (with the same n+success rate trajectory) it would take
 * to bring the CI below the threshold. Approximation: solve for k such that
 * wilson95(k, n+delta).hi ~= threshold. Rough heuristic.
 */
function howManyMoreToClear(currentCiUpper, threshold) {
  // Heuristic: roughly the CI shrinks like 1/sqrt(n). Estimate the n-multiplier.
  if (currentCiUpper <= threshold) return 0;
  const ratio = currentCiUpper / threshold;
  const multiplier = Math.ceil(ratio * ratio);  // n needs to grow by ratio^2
  // Estimate: assuming current run had n=20 (smoke), n=100 (full), or n=250 (deep)
  // we can't know exactly, so just give a directional number.
  return `~${multiplier * 10}-${multiplier * 50} additional clean attempts`;
}

/**
 * Explain a full verdict result. Returns markdown-friendly text.
 *
 * @param {{verdict:string, reasons:string[]}} verdictOutput
 * @param {{commit_sha?:string, base_sha?:string}} [ctx]
 * @returns {string} markdown
 */
function explainVerdict(verdictOutput, ctx = {}) {
  const { verdict, reasons } = verdictOutput;
  if (verdict === 'PASS') {
    return `### ✅ PASS\nAll runners exited cleanly. No adversarial CI ceilings exceeded.`;
  }
  const head = verdict === 'FAIL'
    ? `### ❌ FAIL — this PR cannot merge until fixed`
    : `### ⚠️ FLAG — informational; does not block merge`;
  const sections = [head, ''];
  if (reasons.length === 0) {
    // Defensive: verdict.js shouldn't ever emit FAIL/FLAG with no reasons,
    // but if it does, say something useful instead of just a header.
    sections.push(
      `No reasons were recorded for this ${verdict} verdict. This is likely an fqe orchestration bug ` +
      `(verdict.js produced ${verdict} but the reasons array is empty). File an issue at ` +
      `github.com/booyajones/fqe with this PR's run-id and the QA-RESULT.yml artifact.`
    );
    return sections.join('\n');
  }
  reasons.forEach((reason, i) => {
    const ex = explainReason(reason, ctx);
    sections.push(`**${i + 1}. ${ex.code}**`);
    sections.push('');
    sections.push(ex.plain_english);
    sections.push('');
    sections.push(`**Fix:** ${ex.fix}`);
    sections.push('');
    sections.push('**Reproduce locally:**');
    sections.push('```bash');
    sections.push(ex.repro_command);
    sections.push('```');
    sections.push('');
  });
  return sections.join('\n');
}

module.exports = { explainReason, explainVerdict };
