'use strict';

/**
 * fqe discover — make absence loud ACROSS suites (not just within one).
 *
 * v0.9.0 coverage-liveness proved a declared suite actually ran something. But a
 * confident green can still hide a WHOLE suite that no runner targets: a pytest
 * tree with no pytest runner, a Playwright project nobody wired, a Go package with
 * *_test.go and no `go test` runner. On a 10-person team nobody hand-maintains a
 * complete .fqe.yml, so fqe must detect the frameworks present and FLAG (or FAIL
 * under strict) any that are not wired to a runner.
 *
 * Split for testability and to keep detection deterministic:
 *   - detectFrameworks({files, manifests})  PURE: evidence -> detected frameworks
 *   - matchWired(detected, runners)         PURE: which detected frameworks a
 *                                           declared runner plausibly covers
 *   - discover(repoDir, config, opts)       IO: walk the repo, read manifests, call
 *                                           the pure functions, return a report
 *
 * No LLM. Fail-loud, not fail-open: when detection is ambiguous it reports the
 * framework as present (loud) rather than hiding it.
 */

const fs = require('node:fs');
const path = require('node:path');

// Directories never worth walking for test-source detection.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build', 'vendor', '.next', 'coverage',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'out',
]);

/**
 * Framework registry. Each entry:
 *   id, lang
 *   manifestHit(manifests): true if a manifest declares the framework
 *   fileHit(files): true if test files for this framework exist in the tree
 *   binaries: tokens that, appearing in a runner's command line, mean it is wired
 */
const FRAMEWORKS = Object.freeze([
  {
    id: 'pytest', lang: 'python',
    manifestHit: (m) => /\bpytest\b/i.test(m.pyproject || '') || /\bpytest\b/i.test(m.setupCfg || '') || /\bpytest\b/i.test(m.requirements || ''),
    fileHit: (files) => files.some((f) => /(^|\/)test_[^/]*\.py$/.test(f) || /(^|\/)[^/]*_test\.py$/.test(f)),
    binaries: ['pytest'],
  },
  {
    id: 'jest', lang: 'js',
    manifestHit: (m) => /["']jest["']\s*:/.test(m.packageJson || '') || /\bjest\b/.test(m.packageJsonScripts || ''),
    fileHit: (files) => files.some((f) => /\.(test|spec)\.(jsx?|tsx?)$/.test(f) || /(^|\/)__tests__\//.test(f)),
    binaries: ['jest'],
  },
  {
    id: 'vitest', lang: 'js',
    manifestHit: (m) => /["']vitest["']\s*:/.test(m.packageJson || '') || /\bvitest\b/.test(m.packageJsonScripts || '') || /(^|\/)vitest\.config\./.test(m.configMarker || ''),
    fileHit: () => false, // .test/.spec patterns overlap jest; rely on the manifest signal
    binaries: ['vitest'],
  },
  {
    id: 'mocha', lang: 'js',
    manifestHit: (m) => /["']mocha["']\s*:/.test(m.packageJson || '') || /\bmocha\b/.test(m.packageJsonScripts || ''),
    fileHit: () => false, // mocha file patterns overlap jest/vitest; rely on the manifest
    binaries: ['mocha'],
  },
  {
    id: 'playwright', lang: 'js',
    manifestHit: (m) => /@playwright\/test/.test(m.packageJson || ''),
    fileHit: (files) => files.some((f) => /(^|\/)playwright\.config\.[jt]s$/.test(f) || /\.(e2e|pw)\.(jsx?|tsx?)$/.test(f)),
    binaries: ['playwright'],
  },
  {
    id: 'cargo-test', lang: 'rust',
    manifestHit: (m) => typeof m.cargoToml === 'string',
    fileHit: (files) => files.some((f) => /(^|\/)tests\/[^/]+\.rs$/.test(f)),
    binaries: ['cargo test', 'nextest'],
  },
  {
    id: 'go-test', lang: 'go',
    manifestHit: (m) => typeof m.goMod === 'string',
    fileHit: (files) => files.some((f) => /(^|\/)[^/]*_test\.go$/.test(f)),
    binaries: ['go test', 'gotestsum'],
  },
]);

/**
 * PURE: from a file list and manifest contents, return detected frameworks with
 * the evidence that triggered them. A framework is detected if a manifest declares
 * it OR its test files are present (fail-loud: either signal is enough).
 * @returns {Array<{id:string, lang:string, evidence:string}>}
 */
function detectFrameworks({ files = [], manifests = {} }) {
  const out = [];
  for (const fw of FRAMEWORKS) {
    const byManifest = !!fw.manifestHit(manifests);
    const byFiles = !!fw.fileHit(files, manifests);
    if (byManifest || byFiles) {
      const evidence = [byManifest && 'manifest', byFiles && 'test files'].filter(Boolean).join(' + ');
      out.push({ id: fw.id, lang: fw.lang, evidence });
    }
  }
  return out;
}

/** Build the searchable command line for a runner (command + args + inventory_cmd). */
function runnerCmdLine(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  const parts = [];
  if (typeof cfg.command === 'string') parts.push(cfg.command);
  if (Array.isArray(cfg.args)) parts.push(cfg.args.join(' '));
  if (typeof cfg.inventory_cmd === 'string') parts.push(cfg.inventory_cmd);
  return parts.join(' ').toLowerCase();
}

/**
 * PURE: split detected frameworks into wired (some runner's command references one
 * of the framework's binaries) and unwired.
 * @returns {{wired:Array, unwired:Array}}
 */
function matchWired(detected, runners) {
  const reg = new Map(FRAMEWORKS.map((f) => [f.id, f]));
  const cmdLines = Object.entries(runners || {}).map(([name, cfg]) => ({ name, line: runnerCmdLine(cfg) }));
  const wired = [];
  const unwired = [];
  for (const d of detected) {
    const fw = reg.get(d.id);
    const bins = fw ? fw.binaries : [];
    const hit = cmdLines.find((r) => bins.some((b) => r.line.includes(b)));
    if (hit) wired.push({ ...d, runner: hit.name });
    else unwired.push(d);
  }
  return { wired, unwired };
}

/** Bounded recursive walk of repo-relative file paths, skipping SKIP_DIRS. */
function walkFiles(repoDir, ignore) {
  const results = [];
  const MAX = 20000;
  const stack = [''];
  while (stack.length && results.length < MAX) {
    const rel = stack.pop();
    const abs = path.join(repoDir, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (ignore && ignore(childRel + '/')) continue;
        stack.push(childRel);
      } else if (e.isFile()) {
        if (ignore && ignore(childRel)) continue;
        results.push(childRel);
      }
    }
  }
  return results;
}

function readIf(repoDir, rel) {
  try { return fs.readFileSync(path.join(repoDir, rel), 'utf8'); } catch (_) { return undefined; }
}

/** Parse a simple .fqeignore (gitignore-lite: exact prefixes / suffixes). */
function loadIgnore(repoDir) {
  const txt = readIf(repoDir, '.fqeignore');
  if (!txt) return null;
  const pats = txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (pats.length === 0) return null;
  return (p) => pats.some((pat) => {
    if (pat.endsWith('/')) return p.startsWith(pat) || p.startsWith(pat.replace(/\/$/, '') + '/');
    if (pat.startsWith('*')) return p.endsWith(pat.slice(1));
    return p === pat || p.startsWith(pat + '/') || p.startsWith(pat);
  });
}

/**
 * IO: discover frameworks in repoDir and reconcile against config.runners.
 * @returns {{detected:Array, wired:Array, unwired:Array}}
 */
function discover(repoDir, config, opts = {}) {
  const dir = repoDir || process.cwd();
  const ignore = loadIgnore(dir);
  const files = walkFiles(dir, ignore);
  const manifests = {
    packageJson: readIf(dir, 'package.json'),
    pyproject: readIf(dir, 'pyproject.toml'),
    setupCfg: readIf(dir, 'setup.cfg'),
    requirements: readIf(dir, 'requirements.txt'),
    cargoToml: readIf(dir, 'Cargo.toml'),
    goMod: readIf(dir, 'go.mod'),
  };
  // package.json scripts are a strong wiring signal for JS frameworks.
  try {
    if (manifests.packageJson) {
      const pj = JSON.parse(manifests.packageJson);
      manifests.packageJsonScripts = JSON.stringify(pj.scripts || {});
    }
  } catch (_) { manifests.packageJsonScripts = ''; }

  const detected = detectFrameworks({ files, manifests });
  const runners = (config && config.runners) || {};
  const { wired, unwired } = matchWired(detected, runners);
  // v0.15 (F9): expose the scanned repo files so the orchestrator can detect
  // policy.require_for `when` globs that match nothing (a dead/typo'd money glob).
  return { detected, wired, unwired, scanned_files: files };
}

module.exports = { detectFrameworks, matchWired, runnerCmdLine, discover, FRAMEWORKS };
