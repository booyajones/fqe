'use strict';

/**
 * Source hygiene guards. v0.16.1: orchestrator.js shipped with two literal NUL bytes
 * (raw 0x00 in `h.update('<NUL>')` hash delimiters) since an early version. It hashed
 * fine but made the file "binary" to grep/editors/diff and is fragile. This guard fails
 * loudly if any source file ever contains a NUL byte again. Use the '\\0' escape instead.
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
