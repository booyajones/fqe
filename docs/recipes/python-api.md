# Recipe: Python API (FastAPI / Flask / Django)

Complete `.fqe.yml` for a Python service. Gates on: pytest, ruff, mypy, pip-audit.

## Prerequisites

- `pyproject.toml` or `requirements.txt`.
- Test suite using pytest.
- Ruff installed for linting.
- Optional: mypy for type checking, pip-audit for CVE scanning.

## `.fqe.yml`

```yaml
# Python API gate. Catches: failing tests, lint violations, type errors,
# known CVEs in dependencies.

runners:
  pytest:
    command: "pytest"
    args: ["-x", "--tb=short", "--no-header"]
    when: ["**/*.py", "pyproject.toml", "requirements.txt"]
    required: true
    timeout_ms: 600000   # 10 min

  ruff:
    command: "ruff"
    args: ["check", "."]
    when: ["**/*.py", "pyproject.toml", "ruff.toml", ".ruff.toml"]
    required: true

  mypy:
    command: "mypy"
    args: ["--strict", "."]
    when: ["**/*.py", "pyproject.toml", "mypy.ini"]
    required: false   # strict mypy is aspirational on most repos. Flip to required when ready.
    timeout_ms: 300000

  pip-audit:
    command: "pip-audit"
    args: ["--strict", "--require-hashes"]
    when: ["requirements.txt", "requirements*.txt", "pyproject.toml"]
    required: true   # CVEs in deps are a hard block
    timeout_ms: 180000
```

## Notes

- **`pytest -x`** stops at the first failure. Faster feedback. If you'd rather see the full failure set, use `--maxfail=10` or drop `-x`.
- **`ruff check .`** is the default lint. If you want to fail on style issues that auto-fix is fine with, use `ruff check --fix --exit-non-zero-on-fix .`.
- **`mypy --strict`** is the aggressive setting. On a brand-new codebase this is fine. On legacy, start with non-strict and ratchet up.
- **`pip-audit --require-hashes`** demands that `requirements.txt` has hash pins. This is the right setting for production. If you're using pyproject only, drop `--require-hashes`.

## Common adjustments

- **Django:** add `python manage.py check --deploy` as a runner.
- **FastAPI with OpenAPI spec:** add a runner that re-generates the spec and diffs against a checked-in golden, to catch unexpected API surface changes.
- **Slow integration tests:** scope them to `when: ["tests/integration/**"]` and mark `required: false` initially.
- **Coverage threshold:** use `pytest --cov --cov-fail-under=80` (require 80% coverage).
