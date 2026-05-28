'use strict';

/**
 * fqe init tests.
 *
 * Asserts that init writes the right files, is idempotent, refuses
 * non-repo dirs unless --force, and seeds the bypass allowlist with the
 * detected gh actor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initLib = require('../lib/init');

function freshGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-init-'));
  // Simulate a git repo by creating .git/
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

test('init: refuses non-git dir without --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-nogit-'));
  assert.throws(() => initLib.init({ dir }), /not a git repo/);
});

test('init: accepts non-git dir with --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-force-'));
  const result = initLib.init({ dir, force: true, actor: 'test-user' });
  assert.ok(result.written.length > 0);
});

test('init: writes all expected files in a fresh repo', () => {
  const dir = freshGitRepo();
  const result = initLib.init({ dir, actor: 'chris-wyatt' });
  assert.ok(result.written.includes('.fqe.yml'));
  assert.ok(result.written.includes('.github/workflows/fqe-quality.yml'));
  assert.ok(result.written.includes('.github/workflows/fqe-second-approve.yml'));
  assert.ok(result.written.includes('.github/fqe-bypass-allowlist.yml'));
  assert.ok(result.written.includes('.github/fqe-second-reviewers.yml'));
  assert.equal(result.skipped.length, 0);
  for (const f of result.written) {
    assert.ok(fs.existsSync(path.join(dir, f)), `expected ${f} to exist`);
  }
});

test('init: idempotent — second run skips all', () => {
  const dir = freshGitRepo();
  initLib.init({ dir, actor: 'chris-wyatt' });
  const second = initLib.init({ dir, actor: 'chris-wyatt' });
  assert.equal(second.written.length, 0);
  assert.ok(second.skipped.length >= 5);
});

test('init: --force overwrites existing files', () => {
  const dir = freshGitRepo();
  initLib.init({ dir, actor: 'chris-wyatt' });
  const overridden = initLib.init({ dir, actor: 'another-user', force: true });
  assert.ok(overridden.written.length > 0);
  // The bypass-allowlist should now contain 'another-user'
  const list = fs.readFileSync(path.join(dir, '.github/fqe-bypass-allowlist.yml'), 'utf8');
  assert.match(list, /- another-user/);
});

test('init: seeded allowlist contains the actor', () => {
  const dir = freshGitRepo();
  initLib.init({ dir, actor: 'chris-wyatt' });
  const list = fs.readFileSync(path.join(dir, '.github/fqe-bypass-allowlist.yml'), 'utf8');
  assert.match(list, /- chris-wyatt/);
});

test('init: second-reviewers list is empty by default', () => {
  const dir = freshGitRepo();
  initLib.init({ dir, actor: 'chris-wyatt' });
  const list = fs.readFileSync(path.join(dir, '.github/fqe-second-reviewers.yml'), 'utf8');
  assert.match(list, /allowed_actors:\s*\[\]/);
});

test('init: .fqe.yml has empty runners (gate is no-op until configured)', () => {
  const dir = freshGitRepo();
  initLib.init({ dir, actor: 'chris-wyatt' });
  const cfg = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  assert.match(cfg, /^runners:\s*\{\}$/m);
});

test('init: workflow files contain Events-API identity lookup (invariant #1)', () => {
  const dir = freshGitRepo();
  initLib.init({ dir, actor: 'chris-wyatt' });
  const quality = fs.readFileSync(path.join(dir, '.github/workflows/fqe-quality.yml'), 'utf8');
  assert.match(quality, /events/);
  assert.match(quality, /actor\.login/);
  assert.match(quality, /fqe-bypass/);
});

test('init: state dir is created with .gitkeep', () => {
  const dir = freshGitRepo();
  initLib.init({ dir, actor: 'chris-wyatt' });
  assert.ok(fs.existsSync(path.join(dir, '.github/fqe-state/.gitkeep')));
});

test('init --with-mutation: writes the Stryker glue + config + runner block', () => {
  const dir = freshGitRepo();
  const result = initLib.init({ dir, actor: 'chris-wyatt', withMutation: true });
  assert.ok(result.written.includes('scripts/fqe_stryker_runner.js'),
    'mutation flag should write the runner glue script');
  assert.ok(result.written.includes('stryker.conf.json'),
    'mutation flag should write the Stryker config');
  const yml = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  assert.match(yml, /stryker-mutation:/, '.fqe.yml should have the stryker runner block');
  assert.match(yml, /scripts\/fqe_stryker_runner\.js/, 'runner block should reference the glue script');
  assert.doesNotMatch(yml, /^runners:\s*\{\}\s*$/m,
    'runners: {} should have been replaced with the populated map');
  assert.ok(result.notes && result.notes.some((n) => n.includes('npm install')),
    'should hand the engineer the npm install next-step');
});

test('init without --with-mutation: leaves runners: {} and no Stryker files', () => {
  const dir = freshGitRepo();
  const result = initLib.init({ dir, actor: 'chris-wyatt' });
  assert.ok(!result.written.includes('scripts/fqe_stryker_runner.js'));
  assert.ok(!result.written.includes('stryker.conf.json'));
  const yml = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  assert.match(yml, /^runners:\s*\{\}\s*$/m, 'vanilla path must preserve empty runners');
});
