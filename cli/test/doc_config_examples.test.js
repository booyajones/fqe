'use strict';

/**
 * Every `.fqe.yml` example this repo ships in its docs must parse with the
 * parser this repo ships.
 *
 * Two recipes failed this for the whole of v0.18.x and nothing noticed, because
 * no test had ever read a doc example: `money-invariants.md` carried a trailing
 * `# comment` after a value, which the parser did not strip, and
 * `mutation-advisory.md` used a nested `- item` block under `mutation:`, which
 * takes flat `key: value` lines. Both were copy-paste starting points on the
 * money path. An example the shipped parser cannot read is a defect whichever
 * side is wrong, so this pins the whole class rather than those two files.
 *
 * Selection is by vocabulary, not by filename or a marker comment: a fenced
 * yaml block counts as an fqe config when its top-level keys are a non-empty
 * subset of `TOP_LEVEL_KEYS`, the same list `validateConfig` rejects unknown
 * keys against. That admits fragments (a bare `runners:` block, which is most of
 * them) and excludes the GitHub Actions, CircleCI, codecov, UAT-spec and
 * golden-manifest blocks that sit beside them in the same files — including
 * `circleci.md`'s `version: 2.1`, which shares a key name with fqe's own
 * `version` and is separated by its `jobs`/`workflows` keys. A new fqe key is
 * picked up here the moment it is added to that list.
 *
 * Parse only, deliberately not `validateConfig`. Some examples are illustrative
 * fragments — `writing-a-runner.md`'s timeout snippet is three lines with
 * `command: "..."` and no `when`, which is the clearest way to document one
 * field — and forcing every snippet to be a complete, runnable config would
 * make the docs worse to read. Unparseable is unambiguously wrong; incomplete
 * is not.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseConfigYaml } = require('../lib/orchestrator');
const { TOP_LEVEL_KEYS } = require('../lib/config_schema');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// `.claude` holds git worktrees of this same repo, so walking it would find and
// re-test every checkout's copy of these docs.
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

function markdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function fqeConfigBlocks() {
  const blocks = [];
  for (const file of markdownFiles(REPO_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    const fence = /```yaml\r?\n([\s\S]*?)```/g;
    let m;
    let n = 0;
    while ((m = fence.exec(text)) !== null) {
      n++;
      const body = m[1];
      const keys = [...new Set(
        body.split(/\r?\n/)
          .filter((l) => /^[A-Za-z_][\w-]*:/.test(l))
          .map((l) => l.match(/^([A-Za-z_][\w-]*):/)[1])
      )];
      if (keys.length === 0 || !keys.every((k) => TOP_LEVEL_KEYS.includes(k))) continue;
      blocks.push({
        id: `${path.relative(REPO_ROOT, file).split(path.sep).join('/')} (yaml block #${n})`,
        body,
      });
    }
  }
  return blocks;
}

test('every .fqe.yml example in the docs parses with the shipped parser', () => {
  const blocks = fqeConfigBlocks();
  const failures = [];
  for (const b of blocks) {
    try {
      parseConfigYaml(b.body);
    } catch (e) {
      failures.push(`${b.id}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], `doc config examples that do not parse:\n${failures.join('\n')}`);
});

test('the doc sweep actually finds the examples it claims to check', () => {
  // Without this, a broken fence regex or a wrong repo root makes the test above
  // pass by checking nothing — the silent-empty-set failure mode this repo has
  // now hit in the diff-scope guards and in require_for.
  const blocks = fqeConfigBlocks();
  assert.ok(blocks.length >= 20, `expected >= 20 fqe config examples in docs, found ${blocks.length}`);
  const ids = blocks.map((b) => b.id);
  // The two that were broken, pinned by name so a rename cannot quietly drop them.
  assert.ok(
    ids.some((i) => i.startsWith('docs/recipes/money-invariants.md')),
    `money-invariants.md not among the swept blocks: ${ids.join(', ')}`
  );
  assert.ok(
    ids.some((i) => i.startsWith('docs/recipes/mutation-advisory.md')),
    `mutation-advisory.md not among the swept blocks: ${ids.join(', ')}`
  );
});
