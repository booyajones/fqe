'use strict';

/**
 * Source hygiene guards. v0.16.1: orchestrator.js shipped with two literal NUL bytes
 * (raw 0x00 in `h.update('<NUL>')` hash delimiters) since an early version. It hashed
 * fine but made the file "binary" to grep/editors/diff and is fragile. This guard fails
 * loudly if any source file ever contains a NUL byte again. Use the '\\0' escape instead.
 *
 * v0.18.1: the STRICTLY-ADDITIVE INVARIANT guard. fqe's strongest claim is that the 12
 * verdict passes can only ever ADD a FLAG/FAIL, never clear one (a later pass cannot turn a
 * failing run green). Until now that was a CONVENTION: every pass writes `hasFail = true` /
 * `hasFlag = true` and never `= false`, enforced by nothing but discipline. An external
 * multi-LLM review (council/gauntlet, 2026-06-02) named it the structural fragility a
 * Claude-only review would miss: "a Pass 13 written by a tired human could silently break it,
 * and the invariant is a convention, not a type-enforced guarantee." This guard makes it a
 * tested property: in verdict.js the two accumulators may be INITIALIZED once to `false` and
 * thereafter assigned ONLY the literal `true`. Any `hasFail = false`, compound assignment
 * (`&&=`, `||=`, `??=`), or `= <expr>` fails this test loudly, so monotonicity can no longer be
 * broken silently.
 *
 * SCOPE (verified by code review 2026-06-02, kept honest deliberately): this is a DIRECT-
 * ASSIGNMENT guard. It catches `hasFail = <anything-but-true>` in verdict.js source. It does
 * NOT catch indirect clears via aliasing (`let h = hasFail; h = false`), destructuring
 * (`[hasFail] = [false]`), or property writes (`Object.assign(x, {hasFail: false})`), which a
 * regex cannot see. verdict.js uses both accumulators ONLY as plain locals assigned directly,
 * so the guard is COMPLETE for the code as written. The standing rule for any future refactor:
 * keep `hasFail`/`hasFlag` as plain directly-assigned locals, or extend this guard (an AST pass)
 * before introducing aliasing. The claim is "direct clears are impossible," not "all clears."
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function walk(dir, acc) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f === '.git') continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(js|json|md|yml|yaml|ts)$/.test(f)) acc.push(p);
  }
  return acc;
}

test('no source file contains a raw NUL byte (use the \\0 escape, never a literal 0x00)', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  for (const p of walk(root, [])) {
    if (fs.readFileSync(p).indexOf(0) >= 0) offenders.push(path.relative(root, p));
  }
  assert.deepEqual(offenders, [], `files with a literal NUL byte: ${offenders.join(', ')}`);
});

/**
 * PURE analyzer for the strictly-additive invariant. Given verdict.js source, return the
 * list of assignments to a verdict accumulator that VIOLATE "init once to false, thereafter
 * only literal true". Each accumulator may appear exactly as `let <name> = false` (the
 * initializer) any number of 0..1 times; every other assignment must be `<name> = true`.
 *
 * It matches an accumulator name followed by any assignment operator (`=` excluding `==`/`=>`,
 * plus the compound forms `&&=` `||=` `??=` `+=` `-=`) and inspects the operator + RHS. A read
 * (e.g. `if (hasFail)`) is not an assignment and is ignored. Comments are stripped first so a
 * doc line mentioning the token cannot trip or hide a real assignment.
 */
function findAdditiveViolations(src, accumulators) {
  // Strip line + block comments so prose mentioning the tokens is not analyzed.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const names = accumulators.join('|');
  const re = new RegExp(
    `(\\blet\\s+|\\bconst\\s+|\\bvar\\s+)?\\b(${names})\\b\\s*(=(?![=>])|&&=|\\|\\|=|\\?\\?=|\\+=|-=)\\s*([^;\\n]*)`,
    'g'
  );
  const violations = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    const decl = (m[1] || '').trim();
    const name = m[2];
    const op = m[3];
    const rhs = (m[4] || '').trim();
    if (decl) {
      // The one allowed initializer shape: `let <name> = false`.
      if (!(decl === 'let' && op === '=' && rhs === 'false')) {
        violations.push(`${decl} ${name} ${op} ${rhs}  (the only allowed declaration is "let ${name} = false")`);
      }
      continue;
    }
    // Post-init: only `<name> = true` is permitted. Everything else can clear/weaken a verdict.
    if (!(op === '=' && rhs === 'true')) {
      violations.push(`${name} ${op} ${rhs}  (a verdict accumulator may only be set to the literal true; this could clear a FLAG/FAIL)`);
    }
  }
  return violations;
}

test('verdict.js obeys the strictly-additive invariant: accumulators only ever go false->true, never back', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verdict.js'), 'utf8');
  const violations = findAdditiveViolations(src, ['hasFail', 'hasFlag']);
  assert.deepEqual(
    violations, [],
    'verdict.js breaks the strictly-additive invariant (a pass must only ADD a FLAG/FAIL, never clear one). ' +
    'Offending assignments:\n  ' + violations.join('\n  ')
  );
});

test('the additive-invariant guard has teeth: it catches a planted clear, every compound op, and an expr RHS', () => {
  // A future "Pass 13" that silently un-fails the run. Each compound operator is exercised so a
  // regression that drops one from the alternation is caught here, not in production verdict.js.
  const planted = [
    'let hasFail = false;',
    'let hasFlag = false;',
    'if (x) hasFail = true;',             // the one legal post-init form
    'if (override) hasFail = false;',     // the classic silent fail-open
    'hasFlag &&= keepIt;',                // &&= can clear
    'hasFail ||= false;',                 // ||= can clear
    'hasFlag ??= maybeTrue;',             // ??= can clear
    'hasFail = someBypassFlag;',          // a non-literal RHS
  ].join('\n');
  const violations = findAdditiveViolations(planted, ['hasFail', 'hasFlag']);
  assert.equal(violations.length, 5, `expected exactly 5 violations, got: ${JSON.stringify(violations)}`);
  assert.ok(violations.some((v) => /hasFail = false/.test(v)), 'must catch the planted clear');
  assert.ok(violations.some((v) => /&&=/.test(v)), 'must catch the &&= compound op');
  assert.ok(violations.some((v) => /\|\|=/.test(v)), 'must catch the ||= compound op');
  assert.ok(violations.some((v) => /\?\?=/.test(v)), 'must catch the ??= compound op');
  assert.ok(violations.some((v) => /someBypassFlag/.test(v)), 'must catch the non-literal RHS');
});
