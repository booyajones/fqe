'use strict';

/**
 * Tests for the FAIL-CLOSED JUnit parser. Uses REAL pytest output captured from
 * pytest 9.x (test/fixtures/pytest_real_report.xml and pytest_allskipped_report.xml),
 * not hand-written XML, so the skip/xfail handling is verified against reality.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseJUnit } = require('../lib/junit');

const FIX = path.join(__dirname, 'fixtures');
const realReport = fs.readFileSync(path.join(FIX, 'pytest_real_report.xml'), 'utf8');
const allSkipped = fs.readFileSync(path.join(FIX, 'pytest_allskipped_report.xml'), 'utf8');

test('real pytest report: counts non-skipped as executed (skip AND xfail are skipped)', () => {
  const r = parseJUnit(realReport);
  // Fixture has 6 testcases: 4 real (pass/fail-raises), 1 @skip, 1 @xfail.
  assert.equal(r.reported, 6);
  assert.equal(r.skipped, 2, 'both @pytest.mark.skip and @pytest.mark.xfail render as <skipped>');
  assert.equal(r.executed, 4);
});

test('real pytest report: ids are extracted best-effort', () => {
  const r = parseJUnit(realReport);
  assert.ok(r.ids.includes('tests.test_money::test_cents_add'));
  assert.equal(r.ids.length, 6);
});

test('all-skipped real report: executed is 0 (the dangerous false-green case)', () => {
  const r = parseJUnit(allSkipped);
  assert.equal(r.reported, 2);
  assert.equal(r.skipped, 2);
  assert.equal(r.executed, 0, 'a suite that skipped everything executed nothing');
});

test('a well-formed report with zero testcases is valid (executed 0), not an error', () => {
  const xml = '<?xml version="1.0"?><testsuites><testsuite name="x" tests="0"></testsuite></testsuites>';
  const r = parseJUnit(xml);
  assert.equal(r.reported, 0);
  assert.equal(r.executed, 0);
});

test('FAIL CLOSED: empty input throws', () => {
  assert.throws(() => parseJUnit(''), /empty/);
  assert.throws(() => parseJUnit('   '), /empty/);
});

test('FAIL CLOSED: non-string input throws', () => {
  assert.throws(() => parseJUnit(null), /must be a string/);
  assert.throws(() => parseJUnit(42), /must be a string/);
});

test('FAIL CLOSED: non-JUnit text throws (no testsuite root)', () => {
  assert.throws(() => parseJUnit('<html><body>not a report</body></html>'), /not a JUnit report/);
  assert.throws(() => parseJUnit('just some logs\nPASS\n'), /not a JUnit report/);
});

test('FAIL CLOSED: a truncated/malformed testcase tag throws (ambiguous parse)', () => {
  // One complete testcase + one opening <testcase with no close => openTags(2) != parsed(1).
  const xml =
    '<testsuites><testsuite>' +
    '<testcase classname="a" name="ok" />' +
    '<testcase classname="a" name="broken"' + // never closed
    '</testsuite></testsuites>';
  assert.throws(() => parseJUnit(xml), /ambiguous parse/);
});

test('status="skipped"/"ignored" attribute form also counts as skipped', () => {
  const xml =
    '<testsuites><testsuite>' +
    '<testcase name="a" status="skipped" />' +
    '<testcase name="b" status="ignored" />' +
    '<testcase name="c" />' +
    '</testsuite></testsuites>';
  const r = parseJUnit(xml);
  assert.equal(r.reported, 3);
  assert.equal(r.skipped, 2);
  assert.equal(r.executed, 1);
});

test('failures and errors count as EXECUTED (they ran)', () => {
  const xml =
    '<testsuites><testsuite>' +
    '<testcase name="a"><failure message="boom">trace</failure></testcase>' +
    '<testcase name="b"><error message="x">trace</error></testcase>' +
    '<testcase name="c" />' +
    '</testsuite></testsuites>';
  const r = parseJUnit(xml);
  assert.equal(r.executed, 3, 'a failing test still executed');
  assert.equal(r.skipped, 0);
});
