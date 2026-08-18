#!/usr/bin/env node
'use strict';

/**
 * Guard: every test-count claim in the docs equals the real number of tests.
 *
 * WHY THIS EXISTS
 * The v0.18.2 audit found the count stated four different ways at once: README
 * said 749, SECURITY.md said 749 while backing the "no LLM in the verdict path"
 * invariant, CONTRIBUTING.md said 749 next to a command that did not run, and
 * SKILL.md's tree said 749. The real number was 762. A reader who runs the suite
 * to check the headline number and gets a different one stops believing the page,
 * and this number is load-bearing: it is the evidence offered for the invariant a
 * skeptic cares most about.
 *
 * WHY IT IS NOT A TEST
 * A suite cannot count itself. Calling `node --test` from inside a test spawns the
 * suite, whose copy of this check spawns it again, forever. So this runs as a
 * separate CI step, after the suite, and spawns exactly one child.
 *
 * WHAT IT CHECKS
 * Every `N tests` / `tests-N` claim in the repo's Markdown, except:
 *   - CHANGELOG.md, where per-release counts are history and correct as history.
 *   - Lines naming a third-party proof repo (more-itertools, semver, Python, Rust).
 *     Those counts describe someone else's suite. This exclusion is by NAME on the
 *     same line, not a file allowlist, so it cannot silently widen.
 *
 * Compares against `# tests` (total), not `# pass`, because the pass count differs
 * by platform: one symlink test is skipped on Windows and runs on Linux. Total is
 * the number that is the same everywhere, so it is the one a doc can safely state.
 *
 * Usage:  node scripts/check_test_count.js        (spawns the suite itself)
 *         node scripts/check_test_count.js 772    (trusts a count you already have)
 * Exit 0 = every claim matches. Exit 1 = a claim drifted, or the count is unreadable.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..');
const REPO = path.resolve(CLI, '..');

/**
 * A count sitting NEXT TO a third-party repo name is someone else's count.
 *
 * Proximity, not the whole line. The first version excluded any line naming a
 * third-party repo, which silently swallowed SKILL.md's own count: that file's
 * status block is one long paragraph stating fqe's count near the start and
 * mentioning the Python/Rust proof repos far later, so the entire claim went
 * unchecked while the check reported success. Same attribution failure as the
 * size guard's array-order bug: scope the context to the claim, not the container.
 */
const THIRD_PARTY = /more-itertools|semver|Python|Rust/i;
const PROXIMITY = 60; // characters either side of the number

/** "765 tests", "tests-765" (the shields.io badge slug). */
const COUNT_RE = /(?:tests-(\d+)|(\d+)\s+tests)\b/g;

function realTestCount() {
  if (process.argv[2]) {
    const n = Number(process.argv[2]);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`check_test_count: "${process.argv[2]}" is not a positive integer`);
      process.exit(1);
    }
    return n;
  }
  const res = spawnSync(process.execPath, ['--test'], { cwd: CLI, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (res.stdout || '') + (res.stderr || '');
  const m = out.match(/^# tests (\d+)$/m);
  if (!m) {
    // Fail closed. An unreadable count must never be reported as "all claims fine".
    console.error('check_test_count: could not read "# tests N" from the runner output.');
    console.error(out.slice(-2000));
    process.exit(1);
  }
  return Number(m[1]);
}

/**
 * Same rule as `doc_accuracy.test.js`, and here for the same reason: a nested
 * CHECKOUT is not part of this working tree, so its docs are not claims this
 * repo is making. `.claude/worktrees/<name>/` is a full second checkout made by
 * the agent tooling this repo is developed with, and git does not report it as
 * untracked, so a worktree parked on an older branch reported its stale counts
 * as stale claims on main. Keyed on a `.git` entry (a FILE for a worktree, a
 * directory for a clone) rather than on names, so it holds wherever the checkout
 * lives. The two guards were fixed together: the name lists had already drifted
 * apart — this one never had `.fqe.yml`'s `reports` or `.fqe-out` — and fixing
 * one sibling while leaving the other is the exact miss this release keeps
 * finding.
 */
function isNestedCheckout(dir) {
  // Validate the marker rather than trusting its NAME. `existsSync` alone reads a
  // stray file or empty directory called `.git` — a misplaced fixture, a debug
  // artifact — as a checkout and prunes that whole subtree from the scan,
  // silently. A guard quietly checking less while still reporting success is the
  // defect this rule was added to fix, so it must not reintroduce it one level
  // down. A worktree's `.git` is a file whose first line is `gitdir:`; a clone's
  // is a directory containing `HEAD`. Anything else is not a checkout and gets
  // scanned like the ordinary directory it is.
  const marker = path.join(dir, '.git');
  let st;
  try {
    st = fs.statSync(marker);
  } catch (_) {
    return false; // absent, or unreadable: not a checkout we can confirm
  }
  if (st.isDirectory()) return fs.existsSync(path.join(marker, 'HEAD'));
  if (!st.isFile()) return false;
  try {
    return /^gitdir:/.test(fs.readFileSync(marker, 'utf8').trimStart());
  } catch (_) {
    return false;
  }
}

function markdownFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['.git', 'node_modules', '.stryker-tmp', 'out', '.claude'].includes(e.name)) continue;
      const child = path.join(dir, e.name);
      if (isNestedCheckout(child)) continue;
      markdownFiles(child, out);
    } else if (e.name.endsWith('.md') && e.name !== 'CHANGELOG.md') {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const actual = realTestCount();
const wrong = [];
let checked = 0;

for (const file of markdownFiles(REPO)) {
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(COUNT_RE)) {
        const near = line.slice(Math.max(0, m.index - PROXIMITY), m.index + m[0].length + PROXIMITY);
        if (THIRD_PARTY.test(near)) continue; // someone else's suite
        const claimed = Number(m[1] || m[2]);
        checked++;
        if (claimed !== actual) {
          wrong.push(`${path.relative(REPO, file)}:${i + 1} claims ${claimed} tests, actual ${actual}`);
        }
      }
    });
}

/**
 * The claims this check exists to verify: README's badge, README's status
 * paragraph, SKILL.md's status paragraph.
 *
 * A `checked === 0` floor was the only one here, which meant losing two of the
 * three still read as success — and `doc_accuracy.test.js` next door carries
 * named MIN_PIN_CLAIMS / MIN_SIZE_CLAIMS floors for exactly that reason, with a
 * comment saying a skip-path must not silently become "checked nothing." This
 * file had the weaker half of that idea. Raising the floor to the real number
 * makes a DROP loud rather than only a wipe-out; adding a claim is not blocked,
 * since the floor is a minimum.
 */
const MIN_COUNT_CLAIMS = 3;

if (checked < MIN_COUNT_CLAIMS) {
  console.error(
    `check_test_count: only ${checked} test-count claim(s) found, expected at least ` +
      `${MIN_COUNT_CLAIMS} (README badge, README status, SKILL.md status). A claim was ` +
      'removed or reworded out of recognition, so this check is now verifying less than ' +
      'it was written to. Restore it, or lower MIN_COUNT_CLAIMS in the same commit so the ' +
      'reduction is a decision someone made on purpose rather than one this check hid.'
  );
  process.exit(1);
}

if (wrong.length > 0) {
  console.error(`check_test_count: ${wrong.length} stale test-count claim(s):`);
  for (const w of wrong) console.error(`  ${w}`);
  console.error(`\nThe suite reports ${actual} tests. Update the claims above, or stop stating a number.`);
  process.exit(1);
}

console.log(`check_test_count: OK, ${checked} claim(s) all agree the suite has ${actual} tests.`);
