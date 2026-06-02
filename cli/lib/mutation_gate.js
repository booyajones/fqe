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
  // Fail LOUD on an unparseable report. Returning a zeroed tally here used to read
  // downstream as "0 mutants -> NEUTRAL -> silent pass", which is a fail-open on any
  // caller that hands raw file content to parseStryker (e.g. the `fqe mutation-gate`
  // CLI). A corrupt mutation report must block, never quietly pass. (HIGH-1, v0.14.0.)
  let j;
  if (typeof report === 'string') {
    try {
      j = JSON.parse(report);
    } catch (e) {
      throw new Error(`parseStryker: mutation report is not valid JSON: ${e.message}`);
    }
  } else {
    j = report;
  }
  const files = j && j.files ? j.files : {};
  const perFile = {};
  const survivors = [];
  let killed = 0;
  let surviving = 0;
  for (const [path, data] of Object.entries(files)) {
    const mutants = (data && data.mutants) || [];
    let k = 0;
    let s = 0;
    for (const m of mutants) {
      if (m.status === KILLED) k++;
      else if (SURVIVING.has(m.status)) {
        s++;
        survivors.push({ key: survivorKey(path, m), file: normalizePath(path), mutator: m.mutatorName || '?', status: m.status });
      }
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
    survivors,
  };
}

/**
 * Stable key for a surviving mutant so an equivalent-mutant allowlist survives across
 * runs (Stryker's per-run numeric ids do not). Key = file:line:mutator.
 */
function survivorKey(path, m) {
  const line = m && m.location && m.location.start && m.location.start.line != null ? m.location.start.line : '?';
  return `${normalizePath(path)}:${line}:${m && m.mutatorName ? m.mutatorName : '?'}`;
}

/**
 * Advisory-first mutation evaluation with governance (the council/gauntlet-required layer
 * over evaluateMutationGate). Applies an equivalent-mutant ALLOWLIST (suppress known
 * survivors so the gate never sprays chronic false reds), then maps the result to a verdict
 * by MODE: 'advisory' surfaces survivors as a FLAG (visible, non-blocking, the default while
 * the false-red rate is being measured), 'blocking' returns FAIL once ratcheted. Too few
 * mutants to judge is NEUTRAL (never a silent pass, never a block).
 *
 * @param {object} o
 * @param {object} [o.tally]  a parsed tally from parseStryker (with survivors)
 * @param {string} [o.mode='advisory']  'advisory' | 'blocking'
 * @param {number} [o.threshold=70]
 * @param {string[]|null} [o.changedFiles=null]  diff-scope
 * @param {number} [o.minMutants=1]
 * @param {string[]} [o.allowlist=[]]  survivor keys (file:line:mutator) known equivalent
 * @returns {{ verdict:'PASS'|'FLAG'|'FAIL'|'NEUTRAL', killRate:number|null, total:number,
 *             killed:number, surviving:number, suppressed:number, survivors:object[], reasons:string[] }}
 */
function evaluateMutationAdvisory(o) {
  const opts = o || {};
  const mode = opts.mode === 'blocking' ? 'blocking' : 'advisory';
  const allowlist = new Set(Array.isArray(opts.allowlist) ? opts.allowlist : []);

  // Filter survivors through the equivalent-mutant allowlist BEFORE counting.
  const tally = opts.tally && typeof opts.tally === 'object' ? opts.tally : null;
  let suppressed = 0;
  let liveSurvivors = [];
  let adjustedTally = tally;
  if (tally && Array.isArray(tally.survivors)) {
    // Respect diff-scope: only survivors in changed files (when provided) are in scope.
    const scope = Array.isArray(opts.changedFiles) && opts.changedFiles.length > 0
      ? new Set(opts.changedFiles.map(normalizePath)) : null;
    const inScope = tally.survivors.filter((s) => !scope || scope.has(normalizePath(s.file)));
    liveSurvivors = inScope.filter((s) => !allowlist.has(s.key));
    suppressed = inScope.length - liveSurvivors.length;
    // Recompute killed within scope so killRate reflects the diff + allowlist.
    let scopedKilled = tally.killed;
    if (scope) {
      scopedKilled = 0;
      for (const [path, c] of Object.entries(tally.perFile || {})) {
        if (scope.has(normalizePath(path))) scopedKilled += c.killed;
      }
    }
    adjustedTally = { killed: scopedKilled, surviving: liveSurvivors.length, perFile: tally.perFile };
  }

  const base = evaluateMutationGate({
    tally: adjustedTally || undefined,
    killed: adjustedTally ? undefined : opts.killed,
    surviving: adjustedTally ? undefined : opts.surviving,
    threshold: opts.threshold,
    minMutants: opts.minMutants,
    // changedFiles already applied above when a tally with survivors was given; pass it
    // through only for the direct-counts/no-survivors path.
    changedFiles: adjustedTally ? null : opts.changedFiles,
  });

  if (base.insufficient) {
    return {
      verdict: 'NEUTRAL', killRate: base.killRate, total: base.total, killed: base.killed,
      surviving: base.surviving, suppressed, survivors: liveSurvivors,
      reasons: [`mutation: cannot judge (${base.reasons[0] || 'insufficient mutants'}); neutral, not a pass`],
    };
  }
  if (base.pass) {
    return {
      verdict: 'PASS', killRate: base.killRate, total: base.total, killed: base.killed,
      surviving: base.surviving, suppressed, survivors: liveSurvivors, reasons: [],
    };
  }
  // Below threshold: advisory -> FLAG, blocking -> FAIL.
  const detail = `mutation kill rate ${base.killRate != null ? base.killRate.toFixed(2) : '?'}% below ${opts.threshold || 70}% ` +
    `(${base.surviving} live survivor(s)${suppressed ? `, ${suppressed} suppressed as equivalent` : ''})`;
  if (mode === 'blocking') {
    return { verdict: 'FAIL', killRate: base.killRate, total: base.total, killed: base.killed, surviving: base.surviving, suppressed, survivors: liveSurvivors, reasons: [`${detail} [blocking]`] };
  }
  return { verdict: 'FLAG', killRate: base.killRate, total: base.total, killed: base.killed, surviving: base.surviving, suppressed, survivors: liveSurvivors, reasons: [`${detail} [advisory]`] };
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

module.exports = { parseStryker, evaluateMutationGate, evaluateMutationAdvisory, survivorKey, KILLED, SURVIVING };
