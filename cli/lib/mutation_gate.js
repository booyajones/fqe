'use strict';

/**
 * fqe mutation gate.
 *
 * Coverage tells you a line ran. Mutation testing tells you a test would
 * actually CATCH that line breaking. This gate reads a mutation report and
 * fails the build if the kill rate is below a threshold. It is the "bouncer"
 * for AI-generated tests (and human ones): a test that does not raise the
 * mutation score is a test that proves nothing, and this rejects it.
 *
 * Deterministic, no LLM in the path (same as the rest of fqe).
 *
 * "Surviving" mutants are counted as Survived + Timeout + NoCoverage, because
 * a mutant that hangs the suite or was never exercised is not killed in any
 * useful sense. Ignored / CompileError / RuntimeError are excluded as
 * not-measurement-relevant (matches the Stryker runner glue).
 */

const KILLED = 'Killed';
const SURVIVING = new Set(['Survived', 'Timeout', 'NoCoverage']);

/**
 * Parse a Stryker mutation.json report into a flat per-file + total tally.
 * @param {string|object} report
 * @returns {{ total: number, killed: number, surviving: number,
 *             killRate: number|null, perFile: Record<string,{killed:number,surviving:number}> }}
 */
function parseStryker(report) {
  let j;
  try {
    j = typeof report === 'string' ? JSON.parse(report) : report;
  } catch {
    return { total: 0, killed: 0, surviving: 0, killRate: null, perFile: {} };
  }
  const files = j && j.files ? j.files : {};
  const perFile = {};
  let killed = 0;
  let surviving = 0;
  for (const [path, data] of Object.entries(files)) {
    const mutants = (data && data.mutants) || [];
    let k = 0;
    let s = 0;
    for (const m of mutants) {
      if (m.status === KILLED) k++;
      else if (SURVIVING.has(m.status)) s++;
    }
    perFile[path] = { killed: k, surviving: s };
    killed += k;
    surviving += s;
  }
  const total = killed + surviving;
  return {
    total,
    killed,
    surviving,
    killRate: total > 0 ? round2((killed / total) * 100) : null,
    perFile,
  };
}

/**
 * Evaluate the gate.
 * @param {object} o
 * @param {object} [o.tally]   a parsed tally (from parseStryker) OR
 * @param {number} [o.killed]  direct counts (for cosmic-ray / Python, which
 * @param {number} [o.surviving]  emit numbers, not a Stryker JSON)
 * @param {number} [o.threshold=70]  minimum kill rate %
 * @param {string[]|null} [o.changedFiles=null]  if set, only these files'
 *        mutants count (scope the gate to the PR diff)
 * @param {number} [o.minMutants=1]  if fewer measurable mutants than this,
 *        treat as INFRA (cannot judge) rather than pass/fail
 * @returns {{ pass: boolean, killRate: number|null, total: number,
 *             killed: number, surviving: number, reasons: string[],
 *             insufficient: boolean }}
 */
function evaluateMutationGate(o) {
  const { threshold = 70, changedFiles = null, minMutants = 1 } = o || {};

  let killed;
  let surviving;

  if (o && o.tally && typeof o.tally === 'object') {
    if (Array.isArray(changedFiles) && changedFiles.length > 0) {
      const set = new Set(changedFiles.map(normalizePath));
      killed = 0;
      surviving = 0;
      for (const [path, c] of Object.entries(o.tally.perFile || {})) {
        if (set.has(normalizePath(path))) {
          killed += c.killed;
          surviving += c.surviving;
        }
      }
    } else {
      killed = o.tally.killed;
      surviving = o.tally.surviving;
    }
  } else {
    killed = Number(o && o.killed);
    surviving = Number(o && o.surviving);
  }

  if (!Number.isFinite(killed) || !Number.isFinite(surviving)) {
    return {
      pass: false, killRate: null, total: 0, killed: 0, surviving: 0,
      reasons: ['MUTATION_REPORT_UNREADABLE: could not parse killed/surviving counts'],
      insufficient: true,
    };
  }

  const total = killed + surviving;
  if (total < minMutants) {
    return {
      pass: false, killRate: null, total, killed, surviving,
      reasons: [
        `MUTATION_INSUFFICIENT: only ${total} measurable mutant(s) in scope ` +
        `(need >= ${minMutants}). Cannot judge; treat as neutral, not a pass.`,
      ],
      insufficient: true,
    };
  }

  const killRate = round2((killed / total) * 100);
  const reasons = [];
  if (killRate < threshold - 0.01) {
    reasons.push(
      `MUTATION_KILL_RATE_LOW: ${killRate.toFixed(2)}% of mutants killed, ` +
      `below the ${threshold}% bar. ${surviving} mutant(s) survived: tests ran ` +
      `the code but would not catch it breaking. Strengthen the assertions.`
    );
  }
  return {
    pass: reasons.length === 0,
    killRate, total, killed, surviving, reasons, insufficient: false,
  };
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { parseStryker, evaluateMutationGate, KILLED, SURVIVING };
