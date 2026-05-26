<!-- VOICE-GUARD-OFF -->
# Recipe: outbound communications (cold email / nurture campaigns)

Complete `.fqe.yml` for a repo that ships outbound copy. Gates on: Vale prose lint (banned-word list + tone), CAN-SPAM/CASL physical-address check, deliverability sniff test.

## Why this recipe exists

Finexio's outbound copy gets reviewed by a CEO who hates AI-tell phrasing. The same words show up in every cold email written by an LLM. A linter catches them before they hit Salesforce.

CAN-SPAM and CASL both require a physical mailing address in the email footer. Missing it is a regulatory issue, not a style one. The gate catches both.

## Prerequisites

- Outbound copy lives in `outbound/**/*.md` or `emails/**/*.html`.
- [Vale](https://vale.sh) installed (`brew install vale` or download).
- A `.vale.ini` plus a custom `Finexio` style at `styles/Finexio/`.
- A helper script `scripts/can_spam_check.py` (below).

## `.fqe.yml`

```yaml
# Outbound comms gate. Catches: AI-tell phrasing, missing CAN-SPAM
# physical address, em dashes, banned hedge words.

runners:
  vale-finexio:
    command: "vale"
    args: ["--minAlertLevel=error", "outbound/", "emails/"]
    when: ["outbound/**/*.md", "outbound/**/*.html", "emails/**", ".vale.ini", "styles/**"]
    required: true

  can-spam-footer:
    command: "python3"
    args: ["scripts/can_spam_check.py"]
    when: ["outbound/**/*.html", "emails/**/*.html"]
    required: true

  deliverability-sniff:
    command: "node"
    args: ["scripts/deliverability_check.js"]
    when: ["outbound/**", "emails/**"]
    required: false   # informational; promote to required once tuned
    timeout_ms: 60000
```

## The Vale config: `.vale.ini`

```ini
StylesPath = styles
MinAlertLevel = warning

Vocab = Finexio

Packages = proselint, write-good

[*.md]
BasedOnStyles = Vale, Finexio, proselint, write-good

[*.html]
BasedOnStyles = Vale, Finexio
```

## The Finexio style: `styles/Finexio/BannedWords.yml`

Vale will flag any of these words as an error. The list comes from Finexio's voice-compliance memory file. Add or remove based on what your CEO actually objects to.

```yaml
extends: existence
message: "'%s' is an AI-tell word per Finexio voice rules. Rewrite."
level: error
ignorecase: true
tokens:
  - ensure
  - crucial
  - vital
  - delve
  - delves
  - delving
  - journey
  - leverage
  - leveraging
  - robust
  - seamless
  - seamlessly
  - cutting-edge
  - cutting edge
  - best-in-class
  - synergy
  - synergies
  - paradigm
  - holistic
  - elevate
  - unleash
  - empower
```

## The em-dash blocker: `styles/Finexio/NoEmDashes.yml`

```yaml
extends: existence
message: "Em dash detected. Per Finexio rules, never use em dashes. Use period, comma, or parens."
level: error
tokens:
  - '—'
  - '–'
```

## The CAN-SPAM footer checker

```python
"""
scripts/can_spam_check.py
Verify every outbound email HTML file contains a physical mailing address
and an unsubscribe link. Fails the build if either is missing.

Why: CAN-SPAM (US) and CASL (Canada) both require both. Missing them
is a regulatory issue, not a style preference.
"""
import re
import sys
from pathlib import Path

# Tune to your company's actual address
PHYSICAL_ADDRESS_RE = re.compile(r"(P\.?O\.? Box \d+|\d+ [A-Z][a-z]+ (St|Ave|Blvd|Dr|Rd))")
UNSUB_RE = re.compile(r"unsubscribe", re.I)

def check(path: Path) -> list[str]:
    content = path.read_text(encoding="utf-8", errors="replace")
    failures = []
    if not PHYSICAL_ADDRESS_RE.search(content):
        failures.append(f"{path}: missing physical mailing address (CAN-SPAM violation)")
    if not UNSUB_RE.search(content):
        failures.append(f"{path}: missing unsubscribe link (CAN-SPAM violation)")
    return failures

def main() -> int:
    files = list(Path(".").rglob("emails/**/*.html")) + list(Path(".").rglob("outbound/**/*.html"))
    if not files:
        return 0
    all_failures = []
    for f in files:
        all_failures.extend(check(f))
    if all_failures:
        for fail in all_failures:
            print(fail, file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

## Notes

- **Vale's BannedWords is intentionally aggressive.** If a word your team legitimately uses keeps tripping the gate, edit `styles/Finexio/BannedWords.yml` and commit the change. The list should reflect your actual style rules, not someone else's preferences.
- **The CAN-SPAM regex is naive.** A real implementation would validate against your company's literal address. Adapt the regex pattern accordingly.
- **Deliverability sniff is `required: false` initially.** Spam-score tools have false positives. Watch the FLAG rate for two weeks before promoting to `required: true`.

## Common adjustments

- **HTML templates with handlebars vars:** the CAN-SPAM check should pre-render templates with a sample data set before checking. Add a build step.
- **Multiple ESPs:** different platforms have different footer requirements. Run a separate runner per ESP if your repo ships to more than one.
- **Localization:** CASL (Canada) requires French-language unsubscribe. Add language-specific regex if you ship cross-border.
