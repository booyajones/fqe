#!/usr/bin/env node
'use strict';

// Run against an isolated fixture with @stryker-mutator/core already installed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { init } = require('../lib/init');

assert.ok(process.argv[2], 'Pass an isolated fixture directory');
const dir = path.resolve(process.argv[2]);
assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'Use an isolated fixture, not a checkout');
init({ dir, actor: 'smoke', withMutation: true, force: true });
const manifest = path.join(dir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
pkg.scripts = { test: 'node test.cjs' };
fs.writeFileSync(manifest, JSON.stringify(pkg));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'src/value.js'), 'module.exports = true;\n');
const config = JSON.parse(fs.readFileSync(path.join(dir, 'stryker.conf.json'), 'utf8'));
config.concurrency = 1;
fs.writeFileSync(path.join(dir, 'stryker.conf.json'), JSON.stringify(config));
const wrapper = path.join(dir, 'scripts/fqe_stryker_runner.js');
const report = path.join(dir, 'reports/mutation/mutation.json');
function run() {
  return spawnSync(process.execPath, [wrapper], { cwd: dir, encoding: 'utf8', timeout: 120000 });
}
function payload(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const line = result.stdout.trim().split(/\r?\n/).findLast(line => line.startsWith('{"runner":'));
  assert.ok(line, result.stdout + result.stderr);
  return Object.values(JSON.parse(line).mutation_report.files).flatMap(file => file.mutants);
}

fs.writeFileSync(path.join(dir, 'test.cjs'), "require('node:assert/strict').equal(require('./src/value.js'), true);\n");
const killed = payload(run());
assert.ok(killed.length > 0);
assert.ok(killed.every(mutant => mutant.status === 'Killed'));
fs.writeFileSync(path.join(dir, 'test.cjs'), "require('./src/value.js');\n");
const survived = payload(run());
assert.ok(survived.some(mutant => mutant.status === 'Survived'));
fs.writeFileSync(path.join(dir, 'test.cjs'), "throw new Error('intentional failed dry run');\n");
const failed = run();
assert.equal(failed.status, 1, failed.stdout + failed.stderr);
assert.equal(fs.existsSync(report), false, 'A crashed run must remove the preceding mutation report');
assert.doesNotMatch(failed.stdout, /\{"runner":/);
console.log('Real Stryker: killed, surviving, and failed-run freshness checks passed.');
