'use strict';

/**
 * fqe baseline — turn the machine-readable spec a team already wrote into contract
 * tests, so backend coverage comes from the human spec (the highest-trust oracle)
 * rather than from an LLM guess.
 *
 * v0.12 scope: OpenAPI (JSON) operation counting + a scaffolded Schemathesis runner
 * block. The operation count is what coverage-liveness reconciles against, so a
 * contract suite that silently exercised zero operations cannot read green.
 *
 * Zero-dependency and FAIL-CLOSED: OpenAPI YAML is not parsed here (a hand-rolled YAML
 * parser would be fragile and could undercount, which is a fail-open for reconciliation).
 * Point at the JSON form of the spec (every OpenAPI toolchain can emit it). Anything we
 * cannot parse unambiguously throws, and the caller surfaces it as an error, never a 0.
 */

const HTTP_METHODS = Object.freeze(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);

/**
 * PURE: parse an OpenAPI/Swagger JSON document and return its operations.
 * @param {string} jsonText
 * @returns {Array<{method:string, path:string, operationId:string|null}>}
 */
function parseOpenApiOperations(jsonText) {
  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    throw new Error('baseline: OpenAPI spec is empty (fail closed)');
  }
  let doc;
  try { doc = JSON.parse(jsonText); }
  catch (e) {
    throw new Error(`baseline: spec is not valid JSON (${e.message}). Point at the JSON form of your OpenAPI spec (fail closed)`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('baseline: spec did not parse to an object (fail closed)');
  }
  // Must look like OpenAPI/Swagger.
  if (!doc.openapi && !doc.swagger) {
    throw new Error('baseline: no openapi/swagger version field; not an OpenAPI document (fail closed)');
  }
  const paths = doc.paths;
  if (!paths || typeof paths !== 'object') {
    throw new Error('baseline: spec has no paths object (fail closed)');
  }
  const ops = [];
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    // FAIL CLOSED on a $ref path item: its operations live in another document we do
    // not resolve, so counting it as 0 would UNDERCOUNT and let coverage-liveness pass
    // over a partial contract suite. Refuse rather than undercount.
    if (typeof item.$ref === 'string') {
      throw new Error(
        `baseline: path "${p}" is a $ref to a shared path item, which fqe baseline does not resolve. ` +
        'Dereference the spec first (e.g. redocly bundle --dereference, or swagger-cli bundle -r) so the ' +
        'operation count is correct (fail closed).'
      );
    }
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method.toLowerCase())) continue;
      ops.push({
        method: method.toLowerCase(),
        path: p,
        operationId: op && typeof op.operationId === 'string' ? op.operationId : null,
      });
    }
  }
  return ops;
}

/** PURE: how many operations the spec declares (the count coverage-liveness reconciles to). */
function countOperations(jsonText) {
  return parseOpenApiOperations(jsonText).length;
}

/**
 * Scaffold a contract-class runner block for .fqe.yml that runs Schemathesis against the
 * spec with coverage-liveness wired. The inventory_cmd counts operations from the same
 * spec, so a contract run that exercised fewer operations than the spec declares FAILs.
 * @param {{specPath:string, baseUrlEnv?:string}} opts
 * @returns {string} a YAML runner block
 */
function scaffoldContractRunner({ specPath, baseUrlEnv = 'BASE_URL' }) {
  const sp = String(specPath);
  // Reject anything but a safe relative path so the value cannot inject shell or break
  // the quoting when interpolated into the runner command lines below.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(sp)) {
    throw new Error(`baseline: spec path "${sp}" must be a safe relative path (letters, digits, _ . / -) to scaffold a runner`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseUrlEnv)) {
    throw new Error(`baseline: baseUrlEnv "${baseUrlEnv}" must be a valid env var name`);
  }
  return [
    'runners:',
    '  contract:',
    '    command: bash',
    `    args: ["-c", "schemathesis run --checks all --junit-xml=contract.xml ${sp} --base-url=$${baseUrlEnv}"]`,
    '    class: contract',
    '    always_run: true',
    '    required: true',
    '    report: junit:contract.xml',
    // Count via the fqe CLI already on PATH (the workflow links it), NOT a node module
    // path: fqe installs as a CLI, not an npm package named "fqe".
    `    inventory_cmd: "fqe baseline --spec ${sp} --count"`,
    '    inventory_format: count',
    '    min_tests: 1',
    '    reconcile: true',
    '    strict_coverage: true',
  ].join('\n');
}

module.exports = { parseOpenApiOperations, countOperations, scaffoldContractRunner, HTTP_METHODS };
