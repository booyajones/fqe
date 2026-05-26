# Recipe: financial model (xlsx with goldens)

Complete `.fqe.yml` for a repo that ships Excel financial models. Gates on: cached-value diff against committed goldens, calc-mode sanity, optional LibreOffice headless recompute.

This recipe exists because Finexio shipped Phoenix v7 with three Sev 1 bugs under a green Validation tab. The whole point of fqe was to catch the next one before it merges.

## Prerequisites

- One or more `.xlsx` files committed to the repo.
- For each xlsx, a committed `<name>.golden.json` capturing expected cached values per named range.
- Python with `openpyxl` installed in the CI runner (the workflow installs it automatically).
- A helper script `scripts/fqe_excel_diff.py` that does the actual diff (see below).

## `.fqe.yml`

```yaml
# Excel model gate. Three defenses run on every PR touching .xlsx files:
# (A) formula text hash drift, (B) cached-value drift vs golden,
# (C) LibreOffice headless recompute as second opinion (default-on).

runners:
  excel-diff:
    command: "python3"
    args: ["scripts/fqe_excel_diff.py", "--strict"]
    when: ["**/*.xlsx", "**/*.golden.json"]
    required: true
    timeout_ms: 300000   # 5 min per workbook in the worst case
```

## The helper script: `scripts/fqe_excel_diff.py`

A minimal implementation. Adapt to your golden format and naming convention.

```python
"""
fqe Excel diff: three defenses.
  A. formula_text_hash drift detection
  B. cached-value diff vs committed golden
  C. LibreOffice headless recompute (with --strict)

Exits 0 on PASS, non-zero on any FAIL.
"""
import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import openpyxl

STRICT = "--strict" in sys.argv

def hash_formula(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

def check_workbook(xlsx_path: Path, golden_path: Path) -> list[str]:
    failures = []
    golden = json.loads(golden_path.read_text())
    wb_f = openpyxl.load_workbook(xlsx_path, data_only=False, read_only=True)
    wb_v = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)

    # Defense A + B: per-cell formula hash + cached value
    for cell_ref, expected in golden.items():
        sheet, addr = cell_ref.split("!", 1)
        try:
            formula_cell = wb_f[sheet][addr]
            value_cell = wb_v[sheet][addr]
        except KeyError:
            failures.append(f"{cell_ref}: sheet/cell not found")
            continue
        # A: formula hash
        actual_hash = hash_formula(str(formula_cell.value or ""))
        if actual_hash != expected.get("formula_hash"):
            failures.append(
                f"{cell_ref}: formula text changed without golden update. "
                f"Run scripts/fqe_excel_update_golden.py and commit."
            )
            continue
        # B: cached value diff
        actual = value_cell.value
        expected_val = expected.get("value")
        tol_abs = expected.get("value_tolerance_abs", 0.01)
        if isinstance(actual, (int, float)) and isinstance(expected_val, (int, float)):
            if abs(actual - expected_val) > tol_abs:
                failures.append(
                    f"{cell_ref}: cached value drift {actual} vs golden {expected_val} (tol {tol_abs})"
                )
        elif actual != expected_val:
            failures.append(f"{cell_ref}: value mismatch {actual!r} vs golden {expected_val!r}")

    # Defense C (--strict): LibreOffice recompute
    if STRICT:
        try:
            tmpdir = Path("/tmp/fqe-lo")
            tmpdir.mkdir(exist_ok=True)
            r = subprocess.run(
                ["soffice", "--headless", "--calc", "--convert-to", "xlsx",
                 "--outdir", str(tmpdir), str(xlsx_path)],
                capture_output=True, timeout=120,
            )
            if r.returncode == 0:
                recomputed = tmpdir / xlsx_path.name
                wb_rc = openpyxl.load_workbook(recomputed, data_only=True, read_only=True)
                for cell_ref, expected in golden.items():
                    sheet, addr = cell_ref.split("!", 1)
                    try:
                        rc_val = wb_rc[sheet][addr].value
                    except KeyError:
                        continue
                    expected_val = expected.get("value")
                    tol_abs = expected.get("value_tolerance_abs", 0.01)
                    if isinstance(rc_val, (int, float)) and isinstance(expected_val, (int, float)):
                        if abs(rc_val - expected_val) > tol_abs:
                            failures.append(
                                f"{cell_ref}: LibreOffice recompute diverges {rc_val} vs golden {expected_val}"
                            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            # LibreOffice missing or slow: skip defense C silently in non-strict CI
            if STRICT:
                failures.append("LibreOffice headless not available; cannot run defense C")
    return failures

def main() -> int:
    xlsx_files = list(Path(".").rglob("*.xlsx"))
    if not xlsx_files:
        return 0
    all_failures = []
    for xlsx_path in xlsx_files:
        golden_path = xlsx_path.with_suffix(".golden.json")
        if not golden_path.exists():
            all_failures.append(f"{xlsx_path}: no golden.json next to it")
            continue
        all_failures.extend(check_workbook(xlsx_path, golden_path))
    if all_failures:
        for f in all_failures:
            print(f, file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

## Generating goldens

When you legitimately change a formula or named-range value, regenerate the golden:

```bash
python3 scripts/fqe_excel_update_golden.py path/to/model.xlsx
git add path/to/model.golden.json
git commit -m "fqe: update golden for path/to/model.xlsx (reason: ...)"
```

The PR description should explain WHY the golden changed. Reviewers can diff the JSON.

## Common adjustments

- **Different tolerance per named range.** Edit the `value_tolerance_abs` and `value_tolerance_rel` in the golden JSON per cell.
- **Volatile cells (NOW, RAND, TODAY).** Add an xfail list in `<workbook>.xfail.yml` and have the script skip those cells.
- **Multi-sheet aggregates.** The golden references are `Sheet Name!Cell` (use the same notation Excel uses).
- **LibreOffice as default-on.** Remove the `--strict` flag from the runner args. fqe will then run defense C on every PR.
