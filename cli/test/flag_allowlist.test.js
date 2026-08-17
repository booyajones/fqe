'use strict';

/**
 * The flag allowlist must never be hand-maintained again.
 *
 * v0.18.19 shipped a hand-transcribed KNOWN_FLAGS map that hard-`die`d on nine
 * flags the docs tell users to run, including `coverage-ratchet --patch`, which
 * appears four times in its own recipe. A cry-wolf gate is worse than no gate:
 * it teaches people the tool is broken, and this one was introduced by the very
 * change meant to stop silently swallowing typos.
 *
 * Two independent guards, because either alone is defeatable:
 *   1. DRIFT  - re-derive the allowlist from the subcommand bodies and require
 *               the committed map to match exactly. A new `opts.foo` read with
 *               no map entry fails here, so the map cannot rot.
 *   2. DOCS   - every `--flag` the docs show under a subcommand must be accepted
 *               by that subcommand. This is the user-facing contract, and it
 *               catches the case where code and map agree but both are wrong.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(__dirname, '..', 'bin', 'fqe.js');
const SRC = fs.readFileSync(BIN, 'utf8');

const { KNOWN_FLAGS } = require('../bin/fqe.js');

/** Flags each subcommand body actually reads, derived from source. */
function deriveFlags() {
  const out = {};
  const re = /^ {2}(?:'([a-z0-9-]+)'|([a-z0-9-]+))\(args\)\s*\{/gm;
  const starts = [];
  let m;
  while ((m = re.exec(SRC)) !== null) starts.push({ name: m[1] || m[2], i: m.index });
  assert.ok(starts.length > 10, `expected to find subcommand bodies, found ${starts.length}`);

  starts.forEach((st, k) => {
    const body = SRC.slice(st.i, (starts[k + 1] || { i: SRC.length }).i);
    const flags = new Set();
    for (const f of body.matchAll(/opts\.([a-zA-Z][a-zA-Z0-9]*)/g)) {
      flags.add(f[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
    }
    for (const f of body.matchAll(/opts\['([a-z0-9-]+)'\]/g)) flags.add(f[1]);
    for (const f of body.matchAll(/requireFlags\(opts,\s*\[([^\]]*)\]/g)) {
      for (const q of f[1].matchAll(/'([a-z0-9-]+)'/g)) flags.add(q[1]);
    }
    out[st.name] = [...flags].sort();
  });
  return out;
}

test('allowlist matches the flags the code actually reads (no drift)', () => {
  const derived = deriveFlags();

  for (const [sub, flags] of Object.entries(derived)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(KNOWN_FLAGS, sub),
      `subcommand '${sub}' has no KNOWN_FLAGS entry - add one or it accepts nothing`
    );
    assert.deepStrictEqual(
      [...KNOWN_FLAGS[sub]].sort(),
      flags,
      `KNOWN_FLAGS['${sub}'] drifted from the flags the body reads.\n` +
        `  reads:   ${JSON.stringify(flags)}\n` +
        `  allows:  ${JSON.stringify([...KNOWN_FLAGS[sub]].sort())}\n` +
        `Do not hand-edit: regenerate from the opts.X reads.`
    );
  }
});

/** Every `fqe <sub> --flag` occurrence in the shipped docs. */
function docFlagPairs() {
  const roots = [path.join(ROOT, 'docs'), path.join(ROOT, 'README.md')];
  const files = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    else if (/\.(md|ya?ml|template)$/.test(p)) files.push(p);
  };
  roots.forEach(walk);

  const pairs = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    // `fqe <sub>` followed by its flags, stopping at the end of the line.
    for (const m of text.matchAll(/\bfqe\s+([a-z][a-z0-9-]*)((?:\s+--?[a-zA-Z][^\n`]*)?)/g)) {
      const sub = m[1];
      if (!Object.prototype.hasOwnProperty.call(KNOWN_FLAGS, sub)) continue;
      for (const fm of (m[2] || '').matchAll(/--([a-z][a-z0-9-]*)/g)) {
        const key = `${sub} --${fm[1]}`;
        if (!pairs.has(key)) pairs.set(key, { sub, flag: fm[1], file: path.relative(ROOT, f) });
      }
    }
  }
  return [...pairs.values()];
}

test('every flag the docs show is accepted by that subcommand', () => {
  const pairs = docFlagPairs();
  assert.ok(pairs.length >= 20, `expected to scrape real doc flags, found ${pairs.length}`);

  const rejected = [];
  for (const p of pairs) {
    const r = spawnSync(process.execPath, [BIN, p.sub, `--${p.flag}`, 'x'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (/unknown flag/i.test(out)) rejected.push(`${p.sub} --${p.flag}  (documented in ${p.file})`);
  }

  assert.deepStrictEqual(
    rejected,
    [],
    `The CLI rejects flags its own docs tell users to run:\n  ${rejected.join('\n  ')}`
  );
});

test('the allowlist still rejects a typo (the gate is not vacuous)', () => {
  const r = spawnSync(process.execPath, [BIN, 'run', '--confg', 'x'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.match(out, /unknown flag/i, 'a mistyped --confg must still be rejected');
  assert.notStrictEqual(r.status, 0, 'a mistyped flag must be a non-zero exit');
});
