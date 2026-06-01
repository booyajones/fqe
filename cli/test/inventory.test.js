'use strict';

/**
 * Tests for the FAIL-CLOSED inventory parser. The pytest-collect case uses REAL
 * `pytest --collect-only -q` output captured from pytest 9.x.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseInventory } = require('../lib/inventory');

const FIX = path.join(__dirname, 'fixtures');
const realCollect = fs.readFileSync(path.join(FIX, 'pytest_real_collect.txt'), 'utf8');

test('pytest-collect: real collect-only output counts collected tests', () => {
  // Fixture collected 6 tests (summary line agrees with the 6 id lines).
  assert.equal(parseInventory(realCollect, 'pytest-collect'), 6);
});

test("count: a bare integer", () => {
  assert.equal(parseInventory('6', 'count'), 6);
  assert.equal(parseInventory('0', 'count'), 0);
});

test("count: integer as the last line of a pipeline's output", () => {
  assert.equal(parseInventory('running collection...\n42\n', 'count'), 42);
});

test('count: FAIL CLOSED on non-integer output', () => {
  assert.throws(() => parseInventory('abc', 'count'), /expected an integer/);
  assert.throws(() => parseInventory('6 tests', 'count'), /expected an integer/);
});

test('count: FAIL CLOSED on empty output', () => {
  assert.throws(() => parseInventory('', 'count'), /no output/);
  assert.throws(() => parseInventory('   \n  ', 'count'), /no output/);
});

test('pytest-collect: FAIL CLOSED when id-line count disagrees with the summary', () => {
  const stdout = [
    'tests/test_a.py::test_one',
    'tests/test_a.py::test_two',
    '',
    '5 tests collected in 0.01s', // summary says 5, only 2 id lines => ambiguous
  ].join('\n');
  assert.throws(() => parseInventory(stdout, 'pytest-collect'), /ambiguous/);
});

test('pytest-collect: FAIL CLOSED when neither ids nor summary are present', () => {
  assert.throws(() => parseInventory('some unrelated output\n', 'pytest-collect'), /no test ids/);
});

test('pytest-collect: FAIL CLOSED on a summary with zero id lines (looks truncated)', () => {
  // Real `pytest --collect-only -q` always prints the id lines before the summary.
  // A summary with no id lines means the output was truncated or is the wrong
  // format, so we fail closed rather than trust a count we could not corroborate.
  // (Use inventory_format: count for a summary-only / integer-only command.)
  assert.throws(() => parseInventory('3 tests collected in 0.02s\n', 'pytest-collect'), /ambiguous/);
});

test('FAIL CLOSED on unknown inventory_format', () => {
  assert.throws(() => parseInventory('6', 'magic'), /unknown inventory_format/);
});

test('FAIL CLOSED on non-string stdout', () => {
  assert.throws(() => parseInventory(6, 'count'), /must be a string/);
});
