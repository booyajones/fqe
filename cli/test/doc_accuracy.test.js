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
// Generated / transient trees. `.stryker-tmp` and `reports` are gitignored build
// output: a Stryker sandbox holds a SNAPSHOT copy of package.json and the docs, so
// scanning it could report a stale pin sourced from a directory that is not part of
// the working tree at all. Cheap insurance, since a local `npx stryker run` before
// `npm test` is a workflow this repo documents.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.fqe-out', 'out', '.stryker-tmp', 'reports']);
/**
 * Files the repo scan does not read, and the only two reasons that is allowed.
 *
 *   CHANGELOG.md          every version tag in it is history, and history is correct.
 *   doc_accuracy.test.js  THIS file. It necessarily contains deliberately-wrong
 *                         counter-examples ("verdict.js is 160 lines") as unit-test
 *                         fixtures. Scanning them means the guard reports its own
 *                         test data as repo defects, so the only way to stay green
 *                         would be to delete the tests that prove it works.
 *
 * An exemption outlives the reason it was added, so this set is asserted below to
 * be EXACTLY these two. Adding a third requires editing that assertion on purpose,
 * in a diff a reviewer can see, rather than appending one line here.
 */
const EXCLUDE_FILES = new Set([
  path.join(REPO, 'CHANGELOG.md'),
  path.join(REPO, 'cli', 'test', 'doc_accuracy.test.js'),
]);

/** Lines on which a version tag is EXECUTABLE (a real pin), not prose. */
const PIN_CONTEXT = /npx\s|git\s+clone|git\s+checkout|FQE_TAG|--branch|github:booyajones\/fqe#|git\s+rev-parse/;

/** Any fqe release tag. */
const TAG_RE = /fqe-v(\d+\.\d+\.\d+)/g;

/**
 * How close a PIN_CONTEXT token must sit to a version tag for that tag to count as
 * an executable pin. Wide enough to span a real command
 * (`npx --yes -p github:booyajones/fqe#fqe-v0.0.0 fqe init`) and a sentence that
 * names the tag before the command it feeds, narrow enough that unrelated prose
 * elsewhere in a long paragraph cannot claim it.
 *
 * 160, not 80. At 80 this silently stopped inspecting SECURITY.md's supply-chain
 * line, where `git clone` sits 85 characters past the tag: coverage dropped from 25
 * pins to 24 and nothing went red, because the dropped one happened to be correct.
 * A window is a judgment call, and a judgment call that is only ever exercised
 * against today's files is untested by construction, which is why
 * `pinContextNear()` below is a pure function with its own boundary tests.
 */
const PIN_PROXIMITY = 160;

/**
 * Does an executable-pin context token sit within PIN_PROXIMITY of this match?
 *
 * Extracted for the same reason `attributeSizeClaim` was: the whole-repo scan can
 * only ever see today's docs, so a wrong window size, a wrong direction, or an
 * off-by-one at the boundary still passes as long as the current files happen to
 * fall on the forgiving side of it. Tested directly with synthetic fixtures below.
 */
function pinContextNear(line, matchIndex, matchLength, proximity = PIN_PROXIMITY) {
  const start = Math.max(0, matchIndex - proximity);
  const end = matchIndex + matchLength + proximity;
  return PIN_CONTEXT.test(line.slice(start, end));
}

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

/**
 * Attribute one size claim to one target file. NEAREST MENTION WINS.
 *
 * The first version of this did `TARGETS.find(t => t.keyword.test(window))`, which
 * returns the first entry in ARRAY ORDER whose keyword appears anywhere in the
 * window. Because `verdict` is listed first, it beat `bin/fqe.js` whenever both
 * appeared, no matter which one the claim was actually about. SKILL.md's file tree
 * passed only by luck: `bin/fqe.js  # entry point (~1070 LOC)` sits ABOVE the
 * `lib/verdict.js` line. Sort that tree alphabetically (lib/ before bin/) and the
 * guard reports `claims 1070 for cli/lib/verdict.js, actual 516 (107% off)` — red,
 * for the wrong file, with a message that sends you to fix a file that is correct.
 * A guard that cries wolf gets deleted, which is the failure mode this file exists
 * to prevent.
 *
 * Scanning outward from the claim line makes proximity decide, which is what a
 * human reader uses. Two targets named on the SAME nearest line is genuinely
 * ambiguous, so it fails loudly instead of silently picking one: guessing is how
 * you get a confident wrong answer.
 *
 * Pure and total: no I/O, no state. Exported below so it can be tested directly
 * with synthetic fixtures rather than only through the whole-repo scan, where a
 * bug like the one above hides behind whatever the real files happen to look like.
 *
 * @returns {{file: string}|{ambiguous: string[]}|null}
 */
function attributeSizeClaim(lines, index, targets = SIZE_CLAIM_TARGETS, window = ATTRIBUTION_WINDOW) {
  for (let i = index; i >= Math.max(0, index - window); i--) {
    const hits = targets.filter((t) => t.keyword.test(lines[i]));
    if (hits.length === 1) return { file: hits[0].file };
    if (hits.length > 1) return { ambiguous: hits.map((h) => h.file) };
  }
  return null;
}

const SIZE_TOLERANCE = 0.15;

/**
 * Floor on how many size claims the guard actually inspected. Without it, a
 * reword that stops matching SIZE_RE would make this file pass while checking
 * nothing, which reads as green and is the exact failure mode fqe exists to catch.
 * Set below the current count so ordinary doc edits do not trip it.
 */
const MIN_SIZE_CLAIMS = 8;

/**
 * The same floor, for pins. This one matters more than it looks.
 *
 * The pin check originally asserted only `checked > 0`, which is barely a floor at
 * all. This release exists because 26 stale pins across 15 files went unnoticed, so
 * "how many pins am I actually watching" is the number that decides whether the
 * guard is doing its job. A future PR that consolidates most install examples into
 * a form PIN_CONTEXT does not match (a Docker run, say) would drop coverage from 25
 * to 1 and still pass a "not zero" assertion, checking 96% less while looking
 * identical in CI. Set below the current count so ordinary edits do not trip it,
 * and high enough that a collapse is loud.
 */
const MIN_PIN_CLAIMS = 20;

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
      for (const m of line.matchAll(TAG_RE)) {
        // PROXIMITY, not whole-line. A "line" in SKILL.md's status block is a
        // 4000-character paragraph, so testing the whole line meant one incidental
        // "npx" in prose marked every version token in the paragraph as an
        // executable pin, including correct historical mentions like "was
        // fqe-v0.16.0, missing the v0.17 security fixes". That is a false red on
        // accurate text, and a guard that cries wolf gets deleted.
        //
        // Third time this exact shape appeared: the size guard attributed by array
        // order over a window, the test-count guard excluded by whole line, and
        // this one matched by whole line. Scope the context to the CLAIM, never to
        // whatever container it happens to sit in.
        if (!pinContextNear(line, m.index, m[0].length)) continue;
        checked++;
        if (m[0] !== EXPECTED_TAG) {
          stale.push(`${path.relative(REPO, file)}:${i + 1} pins ${m[0]}, expected ${EXPECTED_TAG}`);
        }
      }
    });
  }

  assert.ok(
    checked >= MIN_PIN_CLAIMS,
    `only ${checked} install pin(s) inspected, expected at least ${MIN_PIN_CLAIMS}. ` +
      'Either the pin regex stopped matching the docs, or the docs stopped stating pins ' +
      'in a recognizable form. Both mean this guard is now watching far less than it ' +
      'appears to (fail closed rather than report a hollow pass).'
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
        const target = attributeSizeClaim(lines, i);
        // `continue`, NOT `return`. A bare return here exits the forEach callback
        // for the WHOLE LINE, so a line holding two claims would silently skip the
        // second one whenever the first was unattributable. That is a guard quietly
        // checking less than it reports.
        if (!target) continue; // unattributable prose claim, out of scope (see header)

        const claimed = Number(m[1].replace(/,/g, ''));

        if (target.ambiguous) {
          checked++;
          wrong.push(
            `${path.relative(REPO, file)}:${i + 1} claims ${claimed}, but its nearest line names ` +
              `more than one source file (${target.ambiguous.join(', ')}), so the guard cannot tell ` +
              `which one the claim is about. Reword so a single file is named nearest the number.`
          );
          continue;
        }

        checked++;
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

/**
 * Control tests for the pin-proximity rule.
 *
 * Same argument as the attribution tests below: the whole-repo scan only ever sees
 * today's docs, so a window that is too small, too large, or one-directional still
 * passes as long as the current files fall on the forgiving side of it. At 80 this
 * rule silently stopped inspecting a real SECURITY.md pin whose `git clone` sat 85
 * characters away, and nothing went red because the dropped pin happened to be
 * correct.
 *
 * THE WINDOW IS ASYMMETRIC, and none of the earlier comments here said so.
 * `pinContextNear` slices `[matchStart - proximity, matchEnd + proximity)`, so a
 * token BEFORE the tag need only START within `proximity`, while a token AFTER it
 * must END inside the window. The allowed gap is therefore a full `proximity`
 * leading but only `proximity - token.length` trailing. That asymmetry is exactly
 * why SECURITY.md's pin fell out at 80: `git clone` began 85 past the tag and had
 * to finish by 80.
 *
 * Two kinds of control below, because they answer different questions:
 *   - the PROX-parameterised pair pins the RULE, independent of the constant
 *   - the default-constant pair pins the CONSTANT itself
 * Only the first pair existed after v0.18.6, which left the shipped default
 * unconstrained downward: PIN_PROXIMITY could have been lowered to almost nothing
 * and every test stayed green. The v0.18.6 changelog claimed the reverse, that the
 * older control bounded the window only loosely. Working the arithmetic out, that
 * older control sat exactly at the lower edge and went red the moment the constant
 * dropped below 160, so the claim was wrong and the change traded a real bound for
 * a parameterised one. Keep both.
 */
const PROX = 50; // small, explicit, and independent of PIN_PROXIMITY

test('pin proximity: a trailing token ending exactly at the edge counts', () => {
  const tag = 'fqe-v1.2.3';
  // A trailing token must END within the window, so the gap it may sit after the
  // tag is `PROX - token.length`, not `PROX`.
  const line = `${tag}${'x'.repeat(PROX - 'git clone'.length)}git clone`;
  assert.strictEqual(pinContextNear(line, 0, tag.length, PROX), true);
});

test('pin proximity: a trailing token one character further does not count', () => {
  const tag = 'fqe-v1.2.3';
  const line = `${tag}${'x'.repeat(PROX - 'git clone'.length + 1)}git clone`;
  assert.strictEqual(
    pinContextNear(line, 0, tag.length, PROX),
    false,
    'one character past the window must flip the result, or the boundary is not ' +
      'where the parameter says it is and the window can drift silently'
  );
});

test('pin proximity: a leading token starting exactly at the edge counts', () => {
  const tag = 'fqe-v1.2.3';
  const verb = 'git clone';
  // Leading side is the asymmetric one: the token only has to START in the window.
  const line = `${verb}${'x'.repeat(PROX - verb.length)}${tag}`;
  assert.strictEqual(pinContextNear(line, line.indexOf(tag), tag.length, PROX), true);
});

test('pin proximity: a leading token one character further does not count', () => {
  const tag = 'fqe-v1.2.3';
  const verb = 'git clone';
  const line = `${verb}${'x'.repeat(PROX - verb.length + 1)}${tag}`;
  assert.strictEqual(pinContextNear(line, line.indexOf(tag), tag.length, PROX), false);
});

/**
 * These two pin the SHIPPED CONSTANT, not just the rule. Without them
 * `PIN_PROXIMITY` can be lowered freely and the parameterised tests above stay
 * green, which is how the real SECURITY.md pin was dropped in the first place.
 */
test('PIN_PROXIMITY is large enough for the real SECURITY.md-shaped pin', () => {
  const tag = 'fqe-v1.2.3';
  const verb = 'git clone';
  // The case that regressed at 80: the verb began 85 characters past the tag.
  const line = `${tag}${'x'.repeat(85)}${verb}`;
  assert.strictEqual(
    pinContextNear(line, 0, tag.length),
    true,
    `PIN_PROXIMITY (${PIN_PROXIMITY}) is too small: a context token 85 characters ` +
      'past the tag is a real shape in SECURITY.md, and dropping it silently shrinks ' +
      'pin coverage without turning anything red'
  );
});

test('PIN_PROXIMITY is small enough that distant prose cannot claim a tag', () => {
  const tag = 'fqe-v1.2.3';
  const line = `${tag}${'x'.repeat(PIN_PROXIMITY + 50)}git clone`;
  assert.strictEqual(
    pinContextNear(line, 0, tag.length),
    false,
    `PIN_PROXIMITY (${PIN_PROXIMITY}) is too large: an unrelated command far away ` +
      'would claim this tag, which is how one incidental "npx" in a 4000-character ' +
      'paragraph marked every version token in it as an executable pin'
  );
});

/**
 * Direct tests for the attribution rule, with synthetic fixtures.
 *
 * These exist because the whole-repo scan above CANNOT catch an attribution bug:
 * it only ever sees the real files, so a rule that picks the wrong target still
 * passes as long as today's files happen to be ordered favorably. That is exactly
 * how the array-order bug survived: SKILL.md listed bin/ above lib/, so the wrong
 * answer and the right answer coincided. Feed it the ordering that separates them.
 */
test('attribution: nearest named file wins, not array order', () => {
  // The real regression. SKILL.md's tree, sorted lib/ before bin/, which is the
  // plausible alphabetical ordering. The claim is about bin/fqe.js on its own line.
  const lines = [
    '|   +-- lib/',
    '|   |   +-- verdict.js                # deterministic verdict (no LLM)',
    '|   |   +-- orchestrator.js',
    '|   +-- bin/fqe.js                    # entry point (~1070 LOC)',
  ];
  assert.deepStrictEqual(
    attributeSizeClaim(lines, 3),
    { file: 'cli/bin/fqe.js' },
    'a claim on the bin/fqe.js line must attribute to bin/fqe.js even though ' +
      'verdict.js is named earlier in the window and earlier in SIZE_CLAIM_TARGETS'
  );
});

test('attribution: a mention on an earlier line still wins when nothing is nearer', () => {
  // README's ASCII diagram case: subject named one line above the number.
  const lines = ['|   verdict.js      |  <- no LLM in path', '|   (deterministic) |     pure JS, ~500 LOC'];
  assert.deepStrictEqual(attributeSizeClaim(lines, 1), { file: 'cli/lib/verdict.js' });
});

test('attribution: outside the window is unattributable, not a wrong guess', () => {
  const lines = ['verdict.js is the core', '', '', '', '', '', '', 'some unrelated thing is 42 lines'];
  assert.strictEqual(
    attributeSizeClaim(lines, 7),
    null,
    'a subject 7 lines away is beyond the 6-line window and must not be attributed'
  );
});

test('attribution: two files named on the same nearest line is ambiguous, not a guess', () => {
  const lines = ['bin/fqe.js dispatches to verdict.js in about 500 lines'];
  const got = attributeSizeClaim(lines, 0);
  assert.ok(got && got.ambiguous, 'expected an ambiguity signal rather than a silent pick');
  assert.deepStrictEqual(got.ambiguous.sort(), ['cli/bin/fqe.js', 'cli/lib/verdict.js']);
});

test('size guard checks EVERY claim on a line, not just the first', () => {
  // Regression test for `return` vs `continue` inside the forEach callback. The
  // first claim here is unattributable; the second is about verdict.js and wrong.
  // With a bare `return`, the second is never examined and the line reads clean.
  const lines = ['a 50-line block, whereas verdict.js is 160 lines'];
  const found = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SIZE_RE)) {
      const target = attributeSizeClaim(lines, i);
      if (!target || target.ambiguous) continue;
      found.push({ claimed: Number(m[1].replace(/,/g, '')), file: target.file });
    }
  });
  assert.ok(
    found.some((f) => f.claimed === 160),
    'the second claim on the line must still be inspected after the first is skipped'
  );
});

test('the scan exemption list has not quietly grown', () => {
  const expected = [
    path.join(REPO, 'CHANGELOG.md'),
    path.join(REPO, 'cli', 'test', 'doc_accuracy.test.js'),
  ].sort();
  assert.deepStrictEqual(
    [...EXCLUDE_FILES].sort(),
    expected,
    'A file was exempted from the doc-accuracy scan. Exemptions are how a guard ' +
      'stops guarding: each one is a place false claims may live forever. If the new ' +
      'exemption is genuinely justified, update this assertion in the same commit so ' +
      'the decision is visible in review rather than buried in a set literal.'
  );
});

/**
 * Bare `node --test` (the package script) uses Node's DEFAULT discovery, which
 * treats ANY .js file under a directory named `test` as a test file, not just
 * `*.test.js`. Verified on Node 22.16: dropping `cli/test/fixtures/stray.js` in
 * place causes it to be discovered and EXECUTED as a test.
 *
 * `fixtures/` is deliberately scanned rather than skipped, because that is exactly
 * where the trap is: a contributor adding a `.js` fixture next to the existing
 * `.xml`/`.txt` ones is doing the natural thing, and would silently get it run as
 * a test. Skipping the directory would put the hole precisely where the risk is.
 *
 * Also verified: Node does NOT descend into dot-directories, so a crashed Stryker
 * run leaving `.stryker-tmp/sandbox-*/test/*.test.js` behind is not picked up
 * (0 phantom tests, suite count unchanged).
 */
test('cli/test holds only *.test.js, so bare `node --test` runs exactly the suite', () => {
  const strays = [];
  (function scan(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        strays.push(path.relative(REPO, full));
      }
    }
  })(__dirname);

  assert.deepStrictEqual(
    strays,
    [],
    'non-test .js file(s) live under cli/test/. Node\'s default discovery executes ' +
      'these as test files under `npm test`, so a helper or fixture module runs as ' +
      'if it were a suite. Put shared code in cli/lib/, or name it *.test.js:\n  ' +
      strays.join('\n  ')
  );
});

/**
 * The repo now has TWO package.json files and they must agree.
 *
 * The root one exists so `npx github:booyajones/fqe#<tag>` resolves at all: npm
 * clones the repo and immediately reads package.json from the root, so without one
 * the documented install failed with ENOENT on every version ever tagged. Adding
 * it fixed the install and created a new drift risk in the same stroke, because
 * the CLI reports its version from cli/package.json while npm reports the root's.
 * Two numbers for one release is precisely how the original rot started.
 */
test('root and cli package.json versions agree', () => {
  const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.strictEqual(
    root.version,
    PKG.version,
    `root package.json is ${root.version} but cli/package.json is ${PKG.version}. ` +
      'npm would advertise one version while `fqe version` printed the other.'
  );
});

/**
 * The root package.json's `bin` must point at the real CLI entry point, since
 * that mapping IS the documented install: `npx -p github:booyajones/fqe#<tag> fqe`
 * resolves the `fqe` bin and nothing else. A typo here reintroduces exactly the
 * bug this file was extended to close, and it would not show up in any doc scan.
 */
test('root package.json bin points at a CLI entry point that exists', () => {
  const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(root.bin && root.bin.fqe, 'root package.json must declare a `fqe` bin');
  const target = path.join(REPO, root.bin.fqe);
  assert.ok(fs.existsSync(target), `root package.json bin.fqe points at ${root.bin.fqe}, which does not exist`);
});

/**
 * The ROOT manifest is what npm installs, so ITS dependency fields are what an
 * adopter actually gets. This is the same shape as the bug this release fixed.
 *
 * `cli/lib/*` gaining a runtime dependency would naturally be added to
 * cli/package.json, where NOTHING installs it for an adopter. The install job
 * would stay green, because `fqe version` / `init` / `validate` do not exercise a
 * dependency used only by, say, reconcile.js. Green CI here, MODULE_NOT_FOUND in
 * the adopter's gate — the tested path differing from the shipped path, which is
 * exactly how the install stayed broken for eighteen releases.
 *
 * ALL FIVE install-bearing spellings are compared, not just `dependencies`.
 * `optionalDependencies`, `peerDependencies` (npm 7+ installs these automatically),
 * `bundleDependencies` and its real npm alias `bundledDependencies` each satisfy the
 * same "declared here, never installed there" shape. Guarding one spelling of the
 * defect is not guarding the defect, which is why the alias is here: npm folds it
 * into `bundleDependencies` at install time, and this guard reads raw JSON, so it
 * would never see the normalization.
 *
 * All five are empty today, so this is preventive. That is the point: it fails on
 * the commit that introduces the divergence, not on the bug report months later.
 */
test('root and cli package.json dependency fields agree', () => {
  const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  // FIVE spellings, not four. npm accepts `bundledDependencies` (with the d) as an
  // alias and normalize-package-data folds it into `bundleDependencies` at install
  // time. This guard reads raw JSON, so it never sees that normalization: declaring
  // the alias in cli/package.json only would leave both `bundleDependencies` keys
  // undefined, the assertion green, and npm honoring a bundle the adopter's root
  // install never gets. Which is this test's own finding, one alias later.
  const FIELDS = [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ];
  for (const field of FIELDS) {
    const empty = field.startsWith('bundle') ? [] : {};
    const rootVal = root[field] || empty;
    const cliVal = PKG[field] || empty;
    // Symmetric message for a symmetric assertion, computed from the ACTUAL key
    // sets rather than inferred from "is the root side empty".
    //
    // The previous version asked only whether rootVal was empty and then asserted a
    // conclusion about which side held the extra key. That is right in two of four
    // shapes and wrong in the two that matter: {a} vs {a,b} is the exact drift this
    // guard exists for (a dep added to cli/) and it reported the root; {a:^1} vs
    // {a:^2} is a version skew with no extra key on either side and it also reported
    // the root. A failure message that names the wrong file sends you to edit the
    // one that was already correct, which is the rot class in the docblock above.
    const keysOf = (v) => (Array.isArray(v) ? v.slice() : Object.keys(v));
    const rootKeys = keysOf(rootVal);
    const cliKeys = keysOf(cliVal);
    const extraInRoot = rootKeys.filter((k) => !cliKeys.includes(k));
    const extraInCli = cliKeys.filter((k) => !rootKeys.includes(k));
    const where = [
      extraInCli.length ? `only in cli/package.json: ${extraInCli.join(', ')}` : '',
      extraInRoot.length ? `only in the root package.json: ${extraInRoot.join(', ')}` : '',
      // The bundle* fields are ARRAYS, so equal membership with unequal content
      // means order or a duplicate, not a version skew. Saying "version skew" there
      // sends the reader hunting for a version that does not exist.
      !extraInCli.length && !extraInRoot.length
        ? Array.isArray(rootVal)
          ? 'same entries on both sides, so the order or a duplicate differs'
          : 'same keys on both sides, so the values differ (a version skew)'
        : '',
    ]
      .filter(Boolean)
      .join('; ');
    assert.deepStrictEqual(
      rootVal,
      cliVal,
      `${field} differs between the manifests (${where}). npm installs the ROOT manifest, ` +
        `so anything declared only in cli/package.json never reaches an adopter, and anything ` +
        `declared only in the root is invisible to the CLI's own tests. Declare it in both, ` +
        `with the same value.`
    );
  }
});

/**
 * No doc may tell a reader to run the install form that cannot work.
 *
 * `npx <pkg> cli/bin/fqe.js <sub>` passes the PATH as the subcommand, so the CLI
 * exits with "unknown subcommand: cli/bin/fqe.js". Thirteen documented commands
 * were in that form across nine files, including the README's headline install,
 * and the pin guard happily confirmed every one of them named the current version
 * while none of them ran. Checking that a claim is CURRENT is not checking that it
 * is TRUE.
 */
test('nothing uses the npx form that passes a path as the subcommand', () => {
  const broken = [];
  for (const file of FILES) {
    // Every scanned extension, NOT just .md. The first version of this test
    // narrowed to Markdown and therefore missed the one occurrence that actually
    // mattered: workflows/fqe-oracle-guard.yml.template, which adopters COPY into
    // their own .github/workflows/ rather than read. There, the broken command
    // makes fqe exit "unknown subcommand", which the template scores as ERROR and
    // fails closed, so every PR in that repo demands a second reviewer while the
    // guard never once reads the diff. The narrower scope excluded precisely the
    // files that get EXECUTED instead of read.
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/npx\s[^\n]*github:booyajones\/fqe[^\n]*cli\/bin\/fqe\.js/.test(line)) {
          broken.push(`${path.relative(REPO, file)}:${i + 1}`);
        }
      });
  }
  assert.deepStrictEqual(
    broken,
    [],
    'these commands pass cli/bin/fqe.js to npx as if it were a subcommand, which ' +
      'exits with "unknown subcommand". Use `npx --yes -p github:booyajones/fqe#<tag> fqe <sub>`:\n  ' +
      broken.join('\n  ')
  );
});

/**
 * SKILL.md's status paragraph must LEAD with the release its number claims.
 *
 * v0.18.4 fixed a two-release drift here: the label read v0.18.4 while the story
 * ran "v0.18.2 is a doc-accuracy release: ...", so an evaluating engineer landed on
 * a page labelled v0.18.4 and found the two newest releases missing, including the
 * one that fixed an install that had never worked. v0.18.5 then restarted that
 * drift at one release in the very commit that fixed it, because guarding the
 * NUMBER cannot see that the prose it labels is out of date.
 *
 * The convention is mechanically checkable, so check it: the first version token
 * after the status label must be the current version.
 */
test("SKILL.md's status narrative leads with the release its number claims", () => {
  const text = fs.readFileSync(path.join(REPO, 'SKILL.md'), 'utf8');
  const label = text.match(/\*\*Status:\*\*\s*v(\d+\.\d+\.\d+)\.?/);
  assert.ok(label, 'SKILL.md has no **Status:** vX.Y.Z label');
  assert.strictEqual(label[1], PKG.version, `SKILL.md status label is v${label[1]}, expected v${PKG.version}`);

  // Bounded to the status PARAGRAPH, not the rest of the file.
  //
  // Slicing to EOF meant a gutted status paragraph could be satisfied by any version
  // token further down SKILL.md. That is latent rather than theoretical: every other
  // doc in this repo carries an install pin, and adding one below the status block
  // would hand this guard a `v0.18.x` that has nothing to do with the narrative. It
  // fails closed on the paragraph it actually names.
  // Split on a BLANK line, so this bounds the paragraph the comment and the failure
  // message both name. `.split('\n')[0]` bounded the LINE instead, which coincides
  // today only because the status block is one ~4000-character line. Hard-wrapping
  // it would have turned this guard red with "names no release after its label",
  // pointing at a formatting change rather than at drift.
  const after = text.slice(label.index + label[0].length).split(/\n\s*\n/)[0];
  const firstVersion = after.match(/v(\d+\.\d+\.\d+)/);
  assert.ok(
    firstVersion,
    'the status paragraph names no release after its label, so the guard cannot tell ' +
      'whether the narrative leads with the current version'
  );
  assert.strictEqual(
    firstVersion[1],
    PKG.version,
    `SKILL.md is labelled v${PKG.version} but its release story opens at v${firstVersion[1]}. ` +
      'A reader lands on the current version and finds the newest releases missing from ' +
      'the narrative. Lead with what this version actually changed.'
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

/**
 * The PROSE status label, not just the badge.
 *
 * The badge check above passed at v0.18.3 while README's own Status paragraph and
 * SKILL.md's `**Status:**` line both still read v0.18.2. Guarding the machine-
 * readable badge and not the sentence a human actually reads is a guard aimed at
 * the wrong target: the badge is decoration, the paragraph is the claim.
 */
test('prose "current release" labels match the package.json version', () => {
  // PER-PATTERN floors, not one shared total.
  //
  // A single `checked > 0` lets either pattern rot to zero matches while the
  // other keeps the count non-zero. There is exactly one match of each in the
  // repo today, so rewording README's opener to `**v0.19.0** —` (dropping the
  // trailing period, a perfectly plausible edit) would make that pattern match
  // nothing, the assertion still pass on SKILL.md's single hit, and README's
  // prose label rot silently forever. That is the v0.18.3 bug verbatim: green
  // guard, stale sentence. Each pattern now has to find its own subject.
  const PATTERNS = [
    { name: 'SKILL.md `**Status:** vX.Y.Z`', re: /\*\*Status:\*\*\s*v(\d+\.\d+\.\d+)/g, min: 1 },
    { name: "README's Status paragraph opener `**vX.Y.Z.**`", re: /^\*\*v(\d+\.\d+\.\d+)\.\*\*/gm, min: 1 },
  ];
  const wrong = [];
  const counts = new Map(PATTERNS.map((p) => [p.name, 0]));

  for (const file of FILES) {
    if (path.extname(file) !== '.md') continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const p of PATTERNS) {
      for (const m of text.matchAll(p.re)) {
        counts.set(p.name, counts.get(p.name) + 1);
        if (m[1] !== PKG.version) {
          wrong.push(`${path.relative(REPO, file)} labels the current release v${m[1]}, expected v${PKG.version}`);
        }
      }
    }
  }

  for (const p of PATTERNS) {
    assert.ok(
      counts.get(p.name) >= p.min,
      `found ${counts.get(p.name)} match(es) for ${p.name}, expected at least ${p.min}. ` +
        'That label was reworded out of this guard\'s reach, so it can now rot unnoticed ' +
        'while the other pattern keeps this test green.'
    );
  }
  assert.deepStrictEqual(wrong, [], `stale current-release label(s):\n  ${wrong.join('\n  ')}`);
});
