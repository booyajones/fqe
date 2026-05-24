'use strict';

/**
 * fqe bypass-tally — JSONL-based rolling rate tracker.
 *
 * Closes gauntlet 11f9c0 flaw "bypass-tally persistence mechanism is undefined".
 *
 * Design:
 *   - One append-only JSONL file per repo (default: .github/fqe-state/bypass-tally.jsonl)
 *   - Each line: {"ts": "<iso8601>", "actor": "<login>", "pr": <num>, "commit": "<sha>"}
 *   - rate(windowDays) counts bypass events in the trailing window AND total PR runs
 *     (the denominator) from a paired total-tally file.
 *
 * Why JSONL + file:
 *   - Atomic appends via fs.appendFileSync (POSIX-guaranteed for small writes; on
 *     GitHub Actions ubuntu-latest workspace this is safe)
 *   - Trivially auditable
 *   - No database dependency
 *   - Survives worker restart
 *
 * Denominator note:
 *   - Pure bypass count alone isn't the rate — we need total PR runs in the same
 *     window. The CI workflow appends to total-tally.jsonl unconditionally and to
 *     bypass-tally.jsonl only on bypass.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STATE_DIR = '.github/fqe-state';
const BYPASS_FILE = 'bypass-tally.jsonl';
const TOTAL_FILE = 'total-tally.jsonl';

/**
 * Append a bypass event.
 * @param {string} stateDir - directory containing the tally files
 * @param {{actor:string, pr:number, commit:string, ts?:string}} event
 */
function appendBypass(stateDir, event) {
  validateEvent(event);
  fs.mkdirSync(stateDir, { recursive: true });
  const row = {
    ts: event.ts || new Date().toISOString(),
    actor: event.actor,
    pr: event.pr,
    commit: event.commit,
  };
  fs.appendFileSync(path.join(stateDir, BYPASS_FILE), JSON.stringify(row) + '\n');
}

/**
 * Append a "PR run" event — used as the denominator for rate computation.
 * Call this on EVERY fqe-quality.yml run, not just bypasses.
 */
function appendRun(stateDir, event) {
  validateEvent(event);
  fs.mkdirSync(stateDir, { recursive: true });
  const row = {
    ts: event.ts || new Date().toISOString(),
    pr: event.pr,
    commit: event.commit,
  };
  fs.appendFileSync(path.join(stateDir, TOTAL_FILE), JSON.stringify(row) + '\n');
}

function validateEvent(e) {
  if (!e || typeof e !== 'object') throw new Error('event must be an object');
  if (e.pr !== undefined && (!Number.isInteger(e.pr) || e.pr <= 0)) {
    throw new Error(`event.pr must be a positive integer, got ${e.pr}`);
  }
  if (e.commit !== undefined && !/^[a-f0-9]{40}$/.test(e.commit)) {
    throw new Error(`event.commit must be 40-char hex, got '${e.commit}'`);
  }
  if (e.ts !== undefined && Number.isNaN(Date.parse(e.ts))) {
    throw new Error(`event.ts must be parseable ISO 8601, got '${e.ts}'`);
  }
  if (e.actor !== undefined && (typeof e.actor !== 'string' || e.actor.length === 0)) {
    throw new Error('event.actor must be a non-empty string');
  }
}

/**
 * Read JSONL file and return parsed rows.
 * Missing file -> empty array (not an error; first run).
 */
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`bypass_tally: line ${i + 1} not valid JSON in ${filePath}: ${e.message}`);
      }
    });
}

/**
 * Compute the rolling bypass rate within a window.
 * Returns { numerator, denominator, rate } where rate = num/den (0 if den=0).
 *
 * @param {string} stateDir
 * @param {{windowDays?:number, now?:Date}} opts
 */
function rate(stateDir, opts = {}) {
  const windowDays = opts.windowDays ?? 14;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    throw new Error(`rate: windowDays must be positive, got ${windowDays}`);
  }
  const now = opts.now ? new Date(opts.now) : new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const bypasses = readJsonl(path.join(stateDir, BYPASS_FILE));
  const totals = readJsonl(path.join(stateDir, TOTAL_FILE));

  const numerator = bypasses.filter(b => new Date(b.ts) >= cutoff && new Date(b.ts) <= now).length;
  const denominator = totals.filter(t => new Date(t.ts) >= cutoff && new Date(t.ts) <= now).length;
  const r = denominator === 0 ? 0 : numerator / denominator;
  return { numerator, denominator, rate: r, window_days: windowDays, computed_at: now.toISOString() };
}

module.exports = {
  DEFAULT_STATE_DIR,
  BYPASS_FILE,
  TOTAL_FILE,
  appendBypass,
  appendRun,
  rate,
  // exported for tests:
  _readJsonl: readJsonl,
};
