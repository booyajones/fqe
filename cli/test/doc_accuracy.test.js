'use strict';

/**
 * Doc-accuracy guards (v0.18.2).
 *
 * fqe's core pitch is auditability: "read the source yourself, it is small and
 * you can check every claim." That pitch dies the moment a reader checks one
 * claim and finds it false. Two claim families had rotted:
 *
 *   1. Executable install pins. v0.17.0's changelog says it updated "27 stale
 *      install/pin tags" BY HAND. One release later 26 of them were stale again,
 *      all still reading fqe-v0.17.0 at v0.18.1. A hand-fix does not hold; the
 *      only thing that holds is a test.
 *
 *   2. Source-size claims. Ten places across README/architecture/faq put verdict.js
 *      at 160 when the file was 516: it grew from 3 verdict passes to 12 across
 *      v0.9 -> v0.18 and no doc followed. SKILL.md put bin/fqe.js at 400 when it
 *      was 1069. Worst of all, `fqe explain` recited the stale figure at runtime,
 *      in two mutually contradictory sentences, to the engineer auditing whether
 *      to trust the tool. Someone who opens the file expecting a short read and
 *      finds triple that stops believing the rest of the page, which is a worse
 *      outcome than never having made the claim.
 *
 * These are the guards that make both loud. They read the REAL files and compare.
 *
 * SCOPE, stated honestly (a guard whose limits are unstated invites false trust):
 *   - Pin check covers EXECUTABLE pins only (npx / git clone / git checkout /
 *     FQE_TAG / --branch / github:booyajones/fqe# lines). Prose version mentions
 *     ("v0.16.0 added receipt signing") are deliberately NOT checked: they are
 *     historical statements, and they are correct as history.
 *   - CHANGELOG.md is excluded entirely. Every tag in it is history by definition.
 *   - Size claims are checked within a +/-15% band, not exactly. An exact match
 *     would turn every one-line edit to verdict.js into a docs chore, which is how
 *     guards get deleted. 15% catches 160-vs-516 and 400-vs-1069 with room to spare
 *     while staying quiet for ordinary drift.
 *   - Size claims are attributed to a source file by keyword. An unattributable
 *     claim (say a 50-line YAML block) is SKIPPED, so the guard cannot police prose it
 *     does not understand. The MIN_SIZE_CLAIMS floor below is what stops that
 *     skip-path from silently becoming "checked nothing."
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'cli', 'package.json'), 'utf8'));
const EXPECTED_TAG = `fqe-v${PKG.version}`;

const DOC_EXTS = new Set(['.md', '.yml', '.yaml', '.template', '.js', '.json']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.fqe-out', 'out']);
const EXCLUDE_FILES = new Set([path.join(REPO, 'CHANGELOG.md')]);

/** Lines on which a version tag is EXECUTABLE (a real pin), not prose. */
const PIN_CONTEXT = /npx\s|git\s+clone|git\s+checkout|FQE_TAG|--branch|github:booyajones\/fqe#|git\s+rev-parse/;

/** Any fqe release tag. */
const TAG_RE = /fqe-v(\d+\.\d+\.\d+)/g;

/** A source-size claim: "160 lines", "1,069 LOC", "~400 LOC". */
const SIZE_RE = /([\d,]+)\s*(?:lines|LOC)\b/gi;

/**
 * Attribute a size claim to the source file it describes, by scanning the claim's
 * own line plus ATTRIBUTION_WINDOW lines above it. A window is needed because
 * README's ASCII diagram names verdict.js on one line and gives its size on the
 * next. The window is 6 rather than 3 because explain.js carried a second stale
 * figure five lines below its subject, and a narrow window silently skipped it: a
 * too-narrow window does not fail, it just quietly checks less than you think.
 */
const ATTRIBUTION_WINDOW = 6;
const SIZE_CLAIM_TARGETS = [
  { file: 'cli/lib/verdict.js', keyword: /verdict/i },
  { file: 'cli/bin/fqe.js', keyword: /bin\/fqe\.js|entry point/i },
];

const SIZE_TOLERANCE = 0.15;

/**
 * Floor on how many size claims the guard actually inspected. Without it, a
 * reword that stops matching SIZE_RE would make this file pass while checking
 * nothing, which reads as green and is the exact failure mode fqe exists to catch.
 * Set below the current count so ordinary doc edits do not trip it.
 */
const MIN_SIZE_CLAIMS = 8;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (DOC_EXTS.has(path.extname(entry.name))) {
      const full = path.join(dir, entry.name);
      if (!EXCLUDE_FILES.has(full)) out.push(full);
    }
  }
  return out;
}

function lineCountOf(relPath) {
  const lines = fs.readFileSync(path.join(REPO, relPath), 'utf8').split('\n');
  // A trailing newline terminates the last line, it does not start a new one.
  // Without this the guard reports 517 for a 516-line file and disagrees with
  // `wc -l`, which is the number a reader checking the claim will actually run.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

const FILES = walk(REPO);

test('every executable install pin matches the current package.json version', () => {
  const stale = [];
  let checked = 0;

  for (const file of FILES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!PIN_CONTEXT.test(line)) return;
      for (const m of line.matchAll(TAG_RE)) {
        checked++;
        if (m[0] !== EXPECTED_TAG) {
          stale.push(`${path.relative(REPO, file)}:${i + 1} pins ${m[0]}, expected ${EXPECTED_TAG}`);
        }
      }
    });
  }

  assert.ok(
    checked > 0,
    'found zero executable install pins to check; the pin regex or the docs changed shape, ' +
      'so this guard is checking nothing (fail closed rather than report a hollow pass)'
  );
  assert.deepStrictEqual(
    stale,
    [],
    `stale install pin(s) found. A copy-pasted stale pin installs a version behind on ` +
      `security fixes. Update these to ${EXPECTED_TAG}:\n  ${stale.join('\n  ')}`
  );
});

test('every source-size claim in the docs is within 15% of the real file', () => {
  const wrong = [];
  let checked = 0;

  for (const file of FILES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(SIZE_RE)) {
        const context = lines.slice(Math.max(0, i - ATTRIBUTION_WINDOW), i + 1).join('\n');
        const target = SIZE_CLAIM_TARGETS.find((t) => t.keyword.test(context));
        if (!target) return; // unattributable prose claim, out of scope (see header)

        checked++;
        const claimed = Number(m[1].replace(/,/g, ''));
        const actual = lineCountOf(target.file);
        const drift = Math.abs(claimed - actual) / actual;
        if (drift > SIZE_TOLERANCE) {
          wrong.push(
            `${path.relative(REPO, file)}:${i + 1} claims ${claimed} for ${target.file}, ` +
              `actual ${actual} (${(drift * 100).toFixed(0)}% off)`
          );
        }
      }
    });
  }

  assert.ok(
    checked >= MIN_SIZE_CLAIMS,
    `only ${checked} size claim(s) inspected, expected at least ${MIN_SIZE_CLAIMS}. ` +
      'The claims were reworded out of the guard\'s reach, so it is no longer checking ' +
      'what it says it checks. Update SIZE_CLAIM_TARGETS or the floor deliberately.'
  );
  assert.deepStrictEqual(
    wrong,
    [],
    `source-size claim(s) drifted from reality. fqe asks readers to audit the source; ` +
      `a wrong size is the first thing they check:\n  ${wrong.join('\n  ')}`
  );
});

test('README status badge matches the current package.json version', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const m = readme.match(/status-v(\d+\.\d+\.\d+)-blue/);
  assert.ok(m, 'README status badge not found; it was removed or reshaped');
  assert.strictEqual(
    m[1],
    PKG.version,
    `README status badge says v${m[1]} but package.json says v${PKG.version}`
  );
});
