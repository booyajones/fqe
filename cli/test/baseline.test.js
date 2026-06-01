'use strict';

/**
 * Tests for `fqe baseline`: count operations from an OpenAPI JSON spec (the count
 * coverage-liveness reconciles a contract suite against) and fail closed on anything
 * unparseable, so a bad spec can never yield a misleadingly low 0.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpenApiOperations, countOperations, scaffoldContractRunner } = require('../lib/baseline');

const SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'pay', version: '1.0' },
  paths: {
    '/payments': {
      get: { operationId: 'listPayments' },
      post: { operationId: 'createPayment' },
      parameters: [], // not an http method, must be ignored
    },
    '/payments/{id}': {
      get: { operationId: 'getPayment' },
      delete: { operationId: 'cancelPayment' },
    },
  },
});

test('counts operations across paths and methods (ignores non-method keys)', () => {
  assert.equal(countOperations(SPEC), 4);
  const ops = parseOpenApiOperations(SPEC);
  assert.ok(ops.find((o) => o.method === 'post' && o.path === '/payments'));
  assert.ok(ops.every((o) => o.method !== 'parameters'));
});

test('swagger 2.0 documents are accepted', () => {
  const sw = JSON.stringify({ swagger: '2.0', paths: { '/x': { get: {} } } });
  assert.equal(countOperations(sw), 1);
});

test('FAIL CLOSED: empty spec throws', () => {
  assert.throws(() => countOperations(''), /empty/);
});

test('FAIL CLOSED: non-JSON (e.g. a YAML spec) throws with guidance', () => {
  assert.throws(() => countOperations('openapi: 3.0.3\npaths: {}'), /not valid JSON/);
});

test('FAIL CLOSED: valid JSON that is not OpenAPI throws', () => {
  assert.throws(() => countOperations('{"hello":"world"}'), /not an OpenAPI document/);
});

test('FAIL CLOSED: OpenAPI doc with no paths throws', () => {
  assert.throws(() => countOperations('{"openapi":"3.0.3"}'), /no paths/);
});

test('a spec with paths but zero operations counts 0 (valid, not an error)', () => {
  assert.equal(countOperations('{"openapi":"3.0.3","paths":{"/x":{"description":"x"}}}'), 0);
});

test('FAIL CLOSED: a $ref path item throws (would otherwise undercount = fail-open)', () => {
  const spec = JSON.stringify({ openapi: '3.0.3', paths: { '/shared': { $ref: 'common.json#/paths/shared' }, '/x': { get: {} } } });
  assert.throws(() => countOperations(spec), /\$ref/);
});

test('scaffoldContractRunner emits a contract runner with coverage-liveness wired', () => {
  const block = scaffoldContractRunner({ specPath: 'openapi.json' });
  assert.match(block, /class: contract/);
  assert.match(block, /report: junit:contract\.xml/);
  assert.match(block, /reconcile: true/);
  assert.match(block, /inventory_format: count/);
});

test('scaffold inventory_cmd uses the fqe CLI on PATH, not a node module path', () => {
  const block = scaffoldContractRunner({ specPath: 'openapi.json' });
  assert.match(block, /fqe baseline --spec openapi\.json --count/);
  assert.doesNotMatch(block, /require\('fqe/);
  assert.doesNotMatch(block, /node -e/);
});

test('scaffold REJECTS an unsafe spec path (injection surface closed)', () => {
  assert.throws(() => scaffoldContractRunner({ specPath: 'a";rm -rf /;"b.json' }), /safe relative path/);
  assert.throws(() => scaffoldContractRunner({ specPath: '$(whoami).json' }), /safe relative path/);
});
