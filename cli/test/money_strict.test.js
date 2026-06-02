'use strict';

/**
 * v0.15 MS: the money-aware strict profile (fqe init --payments) + the scaffold validating clean.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateConfig } = require('../lib/config_schema');
const { parseConfigYaml } = require('../lib/orchestrator');
const { init, PAYMENTS_FQE_YML } = require('../lib/init');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fqe-ms-'));
}

test('MS S10: the PAYMENTS scaffold parses and validates clean', () => {
  const cfg = parseConfigYaml(PAYMENTS_FQE_YML);
  const r = validateConfig(cfg);
  assert.equal(r.valid, true, r.errors.join(' | '));
});

test('MS I1: init --payments writes the payments scaffold as .fqe.yml', () => {
  const dir = tmpRepo();
  const res = init({ dir, force: true, payments: true });
  assert.ok(res.written.includes('.fqe.yml'), 'should write .fqe.yml');
  const body = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  assert.equal(body, PAYMENTS_FQE_YML);
});

test('MS I2: init --payments + --with-mutation keeps the payments body valid', () => {
  const dir = tmpRepo();
  init({ dir, force: true, payments: true, withMutation: true });
  const body = fs.readFileSync(path.join(dir, '.fqe.yml'), 'utf8');
  assert.match(body, /class: money/);
  const r = validateConfig(parseConfigYaml(body));
  assert.equal(r.valid, true, r.errors.join(' | '));
});
