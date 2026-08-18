# Changelog

All notable changes to fqe. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Semver: MAJOR for invariant changes, MINOR for new features under stable invariants, PATCH for bug fixes.

## [Unreleased]

### Fixed (config parser, fail-closed)

- **A line at the wrong indent under `runners:` was silently discarded.** The parser keyed on EXACT indent (2 = runner name, 4 = field) and let every other indent fall through both branches with no throw and no warning. `required: true` written with three spaces instead of four vanished, and `validateConfig` still reported `valid: true` — so the author believed the runner was required and the gate was quietly weaker than the config said. This is the same failure the sibling fix was written for: "a typo'd key would otherwise parse, disable a runner, and pass the gate green." Every indent other than 2 and 4 was affected, tabs included.
- **The worst case was a mis-indented `class:` line, which stripped a money runner of every money protection.** v0.15 makes money and contract runners safe by default: such a runner is FORCED to be `required`, reconciled, strict-coverage and junit-reporting, and loosening any of it fails validation. All of that keys on the `class` field, so a one-space typo on `class: money` deleted the class and every one of those rules stopped applying at once, with nothing reporting it. Measured end-to-end through the real binary on v0.18.20: the runner fires as an ordinary runner and `fqe run` returns **verdict PASS, exit 0**, with the receipt recording `runners_fired: ["money-check"]` and `verdict_reasons: []`.
- Scoped honestly, because the money class is not defenceless everywhere: a mis-indented `required: true` on a runner that still carries `class: money` IS caught, since the money rule demands `required === true` and an absent field fails it. The silent-pass cases are a dropped `required` on a non-money runner, a dropped `class`, and a dropped runner name.
- **A mis-indented runner NAME emptied `runners` entirely.** `unit:` at three spaces produced `runners: {}`, which validates clean even alongside `policy: require_classes: ["money"]`, and `require_nonempty_gate` is opt-in, so the default outcome was a gate that ran nothing.
- **A runner field before any runner name** (indent 4 with no name opened) was discarded the same way. It now throws.
- **The `policy:` block had the identical shape.** `indent !== 2` hit a bare `continue`, so a mis-indented `require_for:` silently dropped a diff-conditional money requirement while the config parsed and validated clean. The nested lines under a well-formed `require_for` are consumed by `parseRequireFor`, which advances the cursor past them, so any line reaching that branch was mis-indented by definition. It now throws with the real file line number.
- The new indent guards name the line number, the offending text, and the indent found. Older error sites in this parser still vary in what they report; that is untouched here.
- **An indented line under a top-level key that takes no block was silently discarded too.** The outer `if (indent === 0) ... else if (current === 'runners')` chain had no final `else`, so the first round of this fix closed the drop inside the `runners` branch and left the identical one beside it. A `version: 0.15` line placed between two runners reset the current key, and every runner after it vanished with `validateConfig` still reporting valid. Found by review, reproduced end-to-end, now throws.
- **A duplicate key silently replaced the earlier one, everywhere it could.** A second `runners:` block deleted the first block whole; a repeated runner name, runner field, policy key or mutation key overwrote in place. All of them now throw. This is the v0.18.18 duplicate-key defect, which was fixed in the generator that emitted it but was still reachable at the parser for any hand-written config.
- **A `require_for` entry written without its leading `- ` merged into the previous entry.** Both keys overwrote the first item's, so `when: ["src/payments/**"] / classes: ["money"]` followed by an un-dashed second entry collapsed to a single rule and the payments requirement was gone, `valid: true`. `computeRequiredClasses` then returned no money classes for a payments diff. Duplicate keys within one entry now throw.
- **A block-scalar introducer (`key: |`) parsed to the one-character string `"|"`.** It is now rejected where the author wrote it, and a block sequence under a runner field is named as such rather than reported only as a bad indent, since that is the shape `docs/writing-a-runner.md` shipped until v0.18.20. A tab-indented line says so outright instead of reporting `found 1`, which is what a tab measures as and not what the author typed.
- **A repeated `require_for:` still replaced the earlier one,** because that key is handled in its own branch that assigned unconditionally and so sat outside the duplicate guard added beside it. The one policy key where losing a rule matters most was the one key the guard missed.
- **`require_for:` with no entries parsed to `[]`,** which `validateConfig` accepts and the verdict then ignores, so a diff-conditional money requirement disappeared with the config reporting valid. Same when every item was commented out. The sibling branch for `require_classes:` already threw for exactly this reason, with the argument written next to it; this key now matches.
- **`require_for: []`, the inline spelling of the empty block above, still parsed clean.** Same end state, so the block form throwing while this one passed was an asymmetry with nothing behind it. Both throw now.
- **A reserved-key error could print `at line 0`,** a line that cannot exist, because three call sites passed a literal `0`. `parseRequireFor` had the real file lines available through its caller and simply was not given them, so they are threaded now; `parseFlatMapBlock` has none, so it omits the clause rather than faking one. This is the same degraded-error path that `parsePolicyBlock`'s `lineNos = []` default produced earlier in this release, deleted rather than carried, and it reappeared one function over.
- **A runner named `__proto__` vanished whole.** `result.runners['__proto__'] = {}` goes through `Object.prototype`'s setter and re-points the map's prototype instead of adding a key, so `Object.keys(runners)` came back empty, the duplicate guard read false, every field landed on the prototype, and `runners: {}` validated clean. `__proto__`, `constructor` and `prototype` are now rejected as top-level keys, runner names, runner fields, policy keys, `require_for` keys and mutation keys. Rejected by name rather than by switching these maps to null-prototype objects, which would change what every downstream consumer receives.
- **Every parse throw is now tagged `fqeConfigInvalid`,** so it takes the pinned `EXIT.ERROR` branch in `bin/fqe.js` rather than falling through to `die()`'s default. That default is the same code today, so behaviour is unchanged, but the binding carries a comment saying a refactor must never let a malformed config reach the neutral `EXIT.INFRA` and pass, and nothing held these throws to it. A CLI test now drives the real binary against a mis-indented money config and asserts a non-zero, non-`INFRA` exit with no receipt written.

### Changed (behavior)

- **A value containing an unquoted ` #` now ends at the `#`.** That is YAML's rule and it is what the trailing-comment fix necessarily means, but it changes what a repo gets if it wrote a literal `#` after a space without quoting it — `command: echo done # here` becomes `echo done`. Nothing in this repo, in any of the four `fqe init` templates, or in any of the 43 fenced yaml blocks in its docs does that; the differential sweep is what establishes it rather than an assumption. Quoting the value (`"echo done # here"`) preserves it, as it always has in YAML. A `#` not preceded by whitespace (`./run#1.sh`, `--tag=#42`) is untouched.
- **This turns configs that previously parsed into hard parse errors.** A repo carrying a mis-indented runner or policy line has been running a gate weaker than its config claimed; that config now fails to parse instead of silently dropping the line. This is the intended direction (fail closed), but it is a breaking change for any such repo. The fix is to correct the indentation the error message points at: runner names exactly 2 spaces, runner fields exactly 4, policy keys exactly 2.
- **An interior empty element in an inline list was filtered away silently.** `[a, , b]`, a doubled-comma typo, became two elements with no complaint. Pre-existing for `policy` and `mutation` lists and newly reachable from runner fields, so it is closed here rather than carried. A single trailing comma stays benign, because `[a, b,]` is two elements in YAML too.
- **A quote was treated as special anywhere in an element, not just at its start.** `[dont, it's, fine]` reported an unterminated single quote for what is an ordinary apostrophe, and YAML's own rule is that a quote only opens a quoted scalar at the start of one. Both of these were found by a differential sweep of the new list handling against `ad5ab10` rather than by reading it.
- **An inline list split on every comma, including one inside a quoted element.** `args: [jest, '--testPathPattern=payments,ledger']` became three arguments where the author wrote two, silently, on a money runner. The naive `inner.split(',')` was latent for `policy` and `mutation` lists and became reachable from runner fields when those moved off a bare `JSON.parse` in this same release, so the fix is a quote-aware split in `parseFlowList`, once, for all four callers. An unterminated quote now throws rather than being guessed at. This one was introduced by an earlier commit in this PR and caught in review before merge: turning a hard error into a silent corruption is the defect this PR exists to remove, so it is recorded rather than quietly squashed.
- Inline-list errors now name the key and the line (`malformed inline list at runners.m.args, line 4`). `parseFlowList` has four callers and its throw previously named neither, while every other throw in the parser carried a line number.
- **A runner field holding an inline list went through a bare `JSON.parse`,** so it rejected the unquoted YAML-flow form (`invariant: [idempotency, double-spend]`) that `parseMaybeList` accepts for every other list in this parser, and it failed with an untagged `SyntaxError` naming neither the key nor the line. `docs/recipes/money-invariants.md` ships exactly that form, so the parser and the shipped recipe disagreed and the parser was the odd one out. Routed through `parseFlowList`, which keeps strict JSON parsing exact and adds the tolerant form.
- Swept every fixture, template, doc example and recipe in this repo before making it throw. All four `fqe init` variants (default, `--payments`, `--with-mutation`, `--with-qodo`) generate configs that parse clean. One doc was affected and is fixed below. Two recipe examples (`money-invariants.md`, `mutation-advisory.md`) already failed to parse on v0.18.20 and still do, for reasons this release does not address: `money-invariants.md` carries a trailing inline comment after a value (`[idempotency, double-spend]   # what this runner proves`), which this parser never strips, and `mutation-advisory.md` uses a nested `- item` block where the `mutation:` block takes flat `key: value` lines. Both predate this work, both are verified identical against `git show HEAD:cli/lib/orchestrator.js`, and both deserve their own pass. Fixing the flow-list handling above improved `money-invariants.md`'s error message without resolving it, which is worth stating plainly: the unquoted list was not the whole cause. **Both are now fixed, in the section below.** That pass found the count was wrong: it is 11 of the 24 examples, not two.

### Fixed (config parser, trailing comments)

- **A trailing `# comment` after a value was never stripped, so it became part of the value.** This parser has always honoured a whole-line comment and never a trailing one, which is half of YAML's rule and the half authors reach for least often — so the half that was missing went unnoticed. The two recipe failures logged above as out of scope were the visible tip: the real count is **11 of the 24 fqe-shaped config examples this repo ships in its own docs**, and one authoring mistake produced three different behaviours depending on which field it landed on.
- **On a list it threw.** `invariant: [idempotency, double-spend]   # what this runner proves` does not end with `]` once the comment is attached, so `parseFlowList` rejected it. This is `docs/recipes/money-invariants.md`, and it is the only one of the three that was loud.
- **On a typed scalar it produced a validation error that named the wrong cause.** `timeout_ms: 300000   # 5 min` parsed to the string `"300000   # 5 min"` and `validateConfig` reported `'timeout_ms' must be a positive integer` — true, but it points at the type and not at the comment, and the author is looking at a line that plainly says `300000`. Six recipes shipped this shape (`node-web`, `playwright`, `python-api`, `financial-model`, `partner-contract`, `ai-test-generation`), plus `retries` in `discovery-and-trust` and `require_coverage_evidence` in `coverage-liveness`. An adopter copying any of them got a config the gate refuses to run.
- **On a free-form string it did nothing at all.** `command`, `report` and `inventory_cmd` carry the comment into the value and `validateConfig` returns `valid: true`. Scoped honestly, because this is NOT the silent-pass class the sibling fix above closed: measured end-to-end through the real binary, a `report:` path and a `command:` each carrying a trailing comment return **exit 2 (FAIL)** where the same config without the comment returns **exit 0 (PASS)**. It fails closed at the point the runner spawns. But a config that is wrong in a way nothing reports until then is still worth removing, and it is the one shape where the parser handed back a value the author never wrote.
- `class:` is the one field where this could have repeated the sibling fix's worst case — stripping a money runner of every money protection, all of which key on that field. It cannot, and this was checked rather than assumed: an unknown class is rejected by name, so `class: money  # the money class` fails validation instead of quietly becoming a non-money runner.
- **The fix is a quote-aware strip applied to the VALUE, at all seven sites that read one** (top-level, runner name, runner field, `policy`, `mutation`, and both `require_for` branches). Scoping it to the value rather than the line is the whole of the risk: scanning from the start of the line leaves a quoted value's opening `"` unrecognised, because the key's own letters clear the element-start flag, so `report: "junit:a #b.xml"` would strip at the space and corrupt the value to `"junit:a` — turning a hard error into a silent corruption, which is the defect this family exists to remove. The rules are YAML's own: `#` opens a comment only at the start of a value or after whitespace, never inside a quoted scalar, and a quote opens a scalar only at the start of an element — the same element-start rule `splitFlowElements` applies one function down, so the apostrophe in `[dont, it's, fine]` stays an apostrophe. An unterminated quote is handed on untouched rather than guessed at.
- **The first version of the strip truncated a single-quoted scalar containing YAML's `''` escape, and review caught it.** A quote inside a single-quoted scalar is escaped by doubling it; closing on the first of the pair left the scanner OUTSIDE the string for the rest of the value, so `command: 'echo it''s done # not a comment'` had its tail read as unquoted, the ` #` taken for a comment, and the value truncated to `'echo it''s done` — accepted by `validateConfig`, since `command` is any non-empty string. **That is a silent corruption introduced by the fix, in the one release whose entire subject is removing them,** and it is recorded rather than quietly squashed. The scanner now knows the pair does not end the scalar. It does not collapse it: `parseInlineScalar` does not either, and deciding where a comment starts is not the same job as deciding what the value is, so the result is byte-identical to what the parser produced before stripping existed.
- **An ordinary comma in a plain scalar was being treated as a flow-list element boundary.** The element-start rule that lets a quote open a scalar after `[` or `,` belongs to flow lists and only to them; applied to a plain scalar, an unmatched apostrophe just after a comma (`report: results,'twas green # note`) opened a quote that never closed, the unterminated-quote fallback handed the value back whole, and the trailing comment survived into it. Both spellings behave identically on `ad5ab10`, so this is the fix reaching a shape it had missed rather than a regression — but it is the same silent carry-through, so it is closed here. Gated on the value actually being a flow list.
- **`runners:  # your runners` now opens a block.** It used to parse to the string `"# your runners"`, which reset the current key and took every runner under it down with a confusing indent error.
- **A block sequence under a flat-map key is now named as one from the branch that actually stops.** `mutation:`'s `allowlist:` + `- "file:1:Mutator"` reported `key 'allowlist' must have an inline value`, which asks for a value without saying that a list is allowed or that `- item` is not how to write one. The message that DOES explain it fired only when the `- item` line was reached — and it was reached only because the trailing comment on the key line carried it past the empty-value branch. Stripping that comment moved the shape to the branch with the worse message, so that branch now carries the explanation too. The uncommented spelling always stopped there and always got the vaguer message; it is fixed for the first time here.

### Fixed (docs)

- **`docs/recipes/mutation-advisory.md` used a YAML block sequence for the mutation allowlist.** `allowlist:` followed by `- "src/money/round.ts:42:ArithmeticOperator"` cannot be read by the `mutation:` block, which takes flat `key: value` lines. This one is the recipe's fault rather than the parser's, and it is fixed on the recipe side: block sequences are not supported anywhere in this parser by design, `docs/writing-a-runner.md` was moved off them in this same release, and the error message already prescribed the inline form. Confirmed against the gate rather than against the message before changing it — `evaluateMutationAdvisory` matches allowlist entries against `survivorKey`'s `file:line:Mutator`, and the inline list now parses, validates and suppresses a matching survivor end-to-end.
- **`docs/recipes/discovery-and-trust.md` documented `quarantined: true` without `quarantined_since`,** which fqe requires, so the example failed validation and the gate would refuse to run. The prose beside it promises the quarantine "cannot become silently permanent" — `quarantined_since` is the field that makes that true, and it appeared in no doc in the repo. Found by the sweep below, not reported; it was previously masked by a trailing-comment error on the line above it.
- **`docs/writing-a-runner.md` documented a runner whose script was silently thrown away.** The `outbound-eval` example passed `args:` as a YAML block sequence with a `|` block scalar, which this parser has never supported: it parsed to `args: []`, so the documented runner would have run bare `node`, read an empty stdin, exited 0, and passed green as a REQUIRED runner while executing none of the example's code. The example now uses the inline-list form the neighbouring examples use and puts the script in its own file, with a note that block sequences and block scalars are not read.
- `CHANGELOG.md`: the `[0.18.19]` section claimed `Tag: fqe-v0.18.20`, contradicting its own header. v0.18.20's release commit find-replaced the version too broadly.
- `SKILL.md`: the Status paragraph credited v0.18.20 with the four platform defects that were v0.18.19's, from the same over-broad find-replace, and v0.18.20's own ten-round diff-scope work had no sentence at all. Both corrected.

### Notes

- **No test had ever read a doc example, which is why both recipe failures shipped.** `cli/test/doc_config_examples.test.js` now parses every fqe-shaped fenced yaml block in every `.md` in the repo — 24 of them — with the parser this repo ships. Selection is by vocabulary rather than by filename or a marker comment: a block counts when its top-level keys are a non-empty subset of `TOP_LEVEL_KEYS`, the same list `validateConfig` rejects unknown keys against. That admits bare `runners:` fragments (most of them) and excludes the GitHub Actions, CircleCI, Vale, UAT-spec, golden-manifest and receipt-schema blocks beside them — including `circleci.md`'s `version: 2.1`, which shares a key name with fqe's own `version` and is separated by its `jobs`/`workflows` keys. A new fqe key is picked up the moment it joins that list.
- The sweep asserts parse, deliberately not `validateConfig`. Some examples are illustrative fragments — `writing-a-runner.md`'s timeout snippet is three lines with `command: "..."` and no `when` — and forcing every snippet to be a complete runnable config would make the docs worse to read. Unparseable is unambiguously wrong; incomplete is not. A second test asserts the sweep found at least 20 blocks and names both repaired recipes, so a broken fence regex cannot make the first test pass by checking nothing.
- **Blast radius swept before the parser changed, differentially against the pristine parser.** 52 inputs: every fenced yaml block in every `.md` (all 43, not only the fqe-shaped ones), every `.yml` in the repo, and the `.fqe.yml` generated by all four `fqe init` variants in real `git init` directories. Result: **zero regressions.** All four init configs parse byte-identical and validate clean. 11 inputs changed value, every one of them a line carrying a trailing comment, and every change from a corrupted value to the written one. 1 newly parses (`money-invariants.md`). The 23 that throw under both parsers are the non-fqe YAML the classifier excludes.
- Doc validation across those 24 examples went from 9 invalid to 1, and the one that remains is the deliberate fragment described above.
- Two more controls for the review round, same protocol: removing the doubled-`''` branch turns exactly its own test red, and removing the flow-list gate on the element-start reset turns exactly its own test red. The differential sweep was re-run after both and still reports zero regressions with all four `fqe init` configs byte-identical.
- **The review round is the same shape as the sibling fix's four rounds, one level down.** This work went looking for a class (a trailing comment) and closed it, then introduced a new member of the class it was closing — the `''` truncation — in the very code doing the closing. Two of the six original controls had already found their own defects; review found the seventh. Fixing the reported instance is not the same as fixing the class, and writing the guard is not the same as being outside it.
- 910 tests (was 862, and 896 before this pass). The new cases cover every indent that previously fell through, on both the runner-name and runner-field axes, plus tabs, the field-before-name case, the dropped-`class` case, the policy axis, the outer-chain case, every duplicate-key path, the un-dashed `require_for` entry, and the block sequence and block scalar shapes. Three are false-positive controls: canonical indentation, comments and blank lines inside blocks, and CRLF input.
- **The first round of this fix was itself incomplete, and review caught it.** It closed the drop inside the `runners:` branch while the same class stayed live in the outer chain, in every duplicate-key path, and in `parseRequireFor`. All three were reproduced end-to-end before being closed. A guard added beside a defect is not the same as a guard added around it.
- The tagging pass had the same shape of miss one level down: the first attempt converted only the single-line throw sites, because the new throws are multi-line and did not match. Twelve of the thirteen were still untagged, and the check that caught it was asserting the flag on all thirteen shapes rather than trusting the edit.
- Four rounds in total, each one finding the last member of a family the previous round had closed most of: the guard beside the branch instead of around it, the duplicate check the `require_for` branch skipped by assigning first, the empty-block case its sibling already threw for, and the key name that is not an own property at all. The pattern is consistent enough to be worth naming: fixing the reported instance is not the same as fixing the class, and each round's fix defined where the next round had to look.
- Negative-controlled individually, in line with this repo's convention. Disabling the `runners:` guard alone turns exactly its seven tests red and leaves both policy tests and the positive control green. Disabling the `policy:` guard alone turns exactly its two tests red. Disabling the outer `else` turns exactly the outer-chain test red. Replacing the real file-line lookup with a hardcoded offset turns exactly the line-number test red, which is what pins that threading: the earlier fixtures all sat where the two values coincide, so review could swap the whole mechanism for `i + 2` and keep the suite green.
- The trailing-comment work was negative-controlled the same way, six controls applied one at a time with the source restored from a saved copy and verified by md5 between each. Making `stripInlineComment` return its input turns exactly its nine tests red and leaves the false-positive controls and the unterminated-quote test green. Removing the quote tracking turns exactly two red — the false-positive controls and the unterminated-quote test — while every "the comment is stripped" test stays green, which is what isolates the risky half from the useful half. Removing the "only after whitespace" rule turns exactly the false-positive controls red. Reverting `mutation-advisory.md` turns exactly the doc sweep red, naming that file. Forcing the block-sequence hint off turns exactly its own test red. Pointing the doc sweep at a directory with no docs leaves the parse test **green over an empty set** and turns the selection guard red — which is the whole reason that second test exists.
- Splitting the false-positive controls into their own test was itself a negative-control finding: the first version mixed an apostrophe-plus-comment case in with them, so disabling stripping turned the control red and the control stopped being able to say anything about over-stripping. The two directions are now separate tests.
- The block-sequence hint was also a negative-control finding rather than a review one. Reverting the recipe showed the error message had changed, and chasing why showed the better message had been firing by accident — the trailing comment carried the key line past the branch that stops first.

## [0.18.21] - 2026-08-18

Tag: `fqe-v0.18.21`. The payments scaffold, over five review rounds (PR #25): `fqe init --payments` generated a gate no pull request could pass.

### Fixed



- **`fqe init --payments` generated a config that could not pass ANY pull request.** The money and contract runners shipped LIVE and `when`-scoped to `src/payments/**`, `src/ledger/**`, `src/billing/**`. But in fqe `required: true` means "this runner must fire on THIS pull request" (see docs/troubleshooting.md), and the validator FORCES every money/contract runner to be required. So any PR whose diff missed those globs FAILED with `required runner "money" did not run`. On top of that, the scaffold's `policy.require_for` globs named paths a repo may not have, and a dead `require_for` glob is itself a BLOCK under the `require_money_policy_when_detected: true` the same scaffold sets, and `require_money_idempotency: true` FAILs while no runner exists to prove the invariant. A fresh `git init` + `fqe init --payments` + a one-line README commit returned exit 2 with six blocking reasons.

  This was NOT confined to fresh repos: a repo that already has `src/payments/`, `src/ledger/` and `src/billing/` — so every glob is live and every dead-glob signal is silent — still failed a docs-only PR on `required runner "money" did not run`. The profile was unusable everywhere.

  The money/contract runners, `policy.require_for` and `require_money_idempotency` now ship COMMENTED OUT behind `ARM 1 of 2` / `ARM 2 of 2` markers, the way the default scaffold ships its runner examples. What stays LIVE is `require_money_policy_when_detected: true`, so the profile keeps its teeth: the first pull request that adds money-looking code with no armed policy still FAILs, and the reason names the cause. The armed template uses `always_run: true` instead of `when` globs, matching `docs/recipes/money-invariants.md` — under fqe's `required` semantics that is the only self-consistent shape for a money runner, and a change outside `src/payments` that breaks a payment is exactly what the money suite must catch.

  Pre-existing since v0.15.0. Found by an independent review checking that the payments scaffold still RUNS: the only test on it asserted that it VALIDATES, which it did. Validates and usable are different claims and only the first was tested.

- **The armed payments template FAILed every money pull request, on a second cause.** Its `policy.require_for` declared `classes: ["money", "regression"]` while the template provides no `class: regression` runner, so verdict Pass 5 blocked with `required test class "regression" has no runner that ran and passed` on exactly the pull requests the profile exists to guard. `require_for` now names only `money`, which the template's runners satisfy, with the `regression` pairing (class list plus a `fqe golden verify` runner, per docs/recipes/regression-golden.md) spelled out in a comment beneath it. Also pre-existing since v0.15.0.

  Found by review of the first fix in this entry. The four tests written for that fix all diffed `README.md` only, so none of them ever exercised a money-path PR — the same "I tested the case I imagined" gap, on the axis of *which files the pull request touches*. `MS U5` closes it.

- **The armed template FAILed every pull request in a repo with an ordinary directory layout.** `policy.require_for`'s `when` globs were hardcoded to `src/payments/**`, `src/ledger/**`, `src/billing/**`. A repo with only `src/payments/` armed the template exactly as instructed, wired real passing scripts, and then got `BLOCKED (dead policy glob)` on **every** pull request, money-related or not — `require_money_policy_when_detected` (live in this profile) makes that check a FAIL rather than a FLAG. Third instance of the same shape, and the one the earlier tests were structurally blind to: every test repo had been seeded to match the template's own globs.

  Both optional pieces carry their own `>>> OPTIONAL n of 2 ... >>>` sentinels, and one position-based `uncommentBlocks()` now backs both `armPaymentsTemplate()` and the new `enableOptionalPolicy()`. The first version of the test that covered this uncommented by matching a hand-listed set of YAML key names; review broke it by adding one plausible field (`report:`) to the template, and the test still passed while that line stayed commented — a green over a config no human would produce. Uncommenting is a property of *where* a line is, never of what it says. `MS U9` now also asserts that no line inside either optional block survives commented, which is exactly what the key-name version could not check.

  `appendRunnerBlock` now emits a blank line before an appended block. `\s*$` eats the template's trailing newline, and the payments template ends with a commented-out runner example, so `--with-mutation` was landing a live `stryker-mutation:` on the line immediately after the inert example — it read as part of it. `MS U10` pins it: through `init()` for the case the CLI actually generates, and by driving `appendRunnerBlock` directly for all three of its branches.

  The optional `require_for` example ships as two pieces, each positioned so that uncommenting it *where it sits* lands it at the right level — the policy at the top level, the regression runner under `runners:`. The earlier single-block form put the runner inside the `policy:` stanza when uncommented the way a person selects a visual block; that threw rather than silently dropping the runner, so it was fail-loud, but the reader's only protection was a prose line sitting inside the very block they were selecting. Prose is not a mechanism. `MS U9` pins the mechanism.

  `policy.require_for` is no longer part of arming. The armed runners are `always_run`, so the money and contract classes are already demanded on every PR and `require_for` added nothing for them. It now ships as an OPTIONAL block *outside* the ARM markers — so arming leaves it commented — carrying both warnings that make it usable: every glob must match a real file in your repo, and every class named must have a runner that provides it. `MS U8` pins both halves: an ordinary layout arms clean, and a dead glob still blocks when you do turn the policy on. The shared test seed is now an ordinary layout (`src/payments/` only), so this class of defect cannot hide behind a purpose-built repo again.

- **The scaffold header claimed arming only part of the template "stops the gate".** False for ARM 2: a money-class runner arms the idempotency requirement by itself (`orchestrator.js`), so uncommenting just the runners yields a working, narrower gate — with no `require_for` path binding, and nothing saying so. The header now states both halves accurately and `MS U6` pins them. `armPaymentsTemplate()` also now throws on an unclosed ARM marker (it previously uncommented the rest of the file and failed later in the YAML parser — fail-loud by accident, not by construction), and the header's money-keyword list was missing three real stems and implied the detector is exhaustive when it is a heuristic that misses e.g. `src/txn/`.
### Notes

- 872 tests (+10 over v0.18.20). Every fix below was negative-controlled individually: reverted alone, in a scratch copy, to confirm one specific test goes red, then restored byte-identical.
- The payments-scaffold rounds added 10 tests (MS U1-U10). `MS U1` drives the real binary through `fqe init --payments` in a fresh git repo and asserts a non-payments PR reaches a non-FAIL verdict — the gap the old test left open. `MS U2` asserts the inert scaffold still BLOCKS the first PR that adds money code, so the fix cannot be "remove the gate". `MS U3` uncomments the shipped template through the ARM markers and validates it, so the commented block cannot rot into a config that fails the moment somebody arms it. `MS U4` runs both shapes in a repo that HAS the money paths and pins the contrast: `always_run` PASSes a docs-only PR, `when`-globs FAIL it. `MS U5` arms the template and opens a pull request that CHANGES `src/payments/**` — the axis U1–U4 all missed. `MS U6` pins both halves of the partial-arm claim in the header. `MS U7` pins the unclosed-marker throw. `MS U8` arms in a repo that does NOT have the template's example directories. `MS U9` uncomments each OPTIONAL piece where it sits and checks it lands at the right level.
- `MS I2` was asserting `/class: money/` against the generated file. That regex is satisfied by the commented line `#     class: money` just as well as by a live runner, so it would have kept passing while measuring nothing. It now asserts on live lines and on the parsed runner map.

## [0.18.20] - 2026-08-18

Tag: `fqe-v0.18.21`.

Ten review rounds against v0.18.19, all in one subsystem: **deciding which range to gate, and reporting that honestly.** Every round's fix produced the next round's defect, so the entries below are as much a record of what the fixes broke as of what they fixed. Nothing here is tagged yet.

### Fixed (scope determination)

- **`fqe run` without `--base` silently gated only the last commit.** The diff fell back to `HEAD~1..HEAD`, a guess at the pull request's range that is wrong for every multi-commit PR. Measured: a 3-commit PR whose break is in commit 1 and whose commit 2 is docs-only returned PASS, exit 0, `runners_fired: []`. `git` SUCCEEDED, so `diff.ok` was true and the indeterminate-diff guard never ran — five rounds of hardening "the diff did not resolve" could not see it, because nothing failed. The guess is gone; not knowing the range is now what `ok: false` means.
- **The range was two-dot, not merge-base anchored.** `git diff base..head` compares two tree snapshots, so when the base branch independently reaches the same content the PR reached, the changed file vanishes. Measured: fork has `app.js` "original", the PR makes it "BUGGY", main independently also becomes "BUGGY" — two-dot returns zero files and the gate reports a clean, resolved diff over a PR that changed gated code. Now anchored at the merge base, which is what GitHub's own "Files changed" view uses.
- **A degenerate range succeeded.** `git diff X..X` exits 0 with zero files, so `--base HEAD --commit HEAD` over a real regression gave PASS with `indeterminate: false`. Two distinct causes are now detected and separately labelled: `degenerate-range` (a self-targeting declared pair) and `head-is-ancestor-of-base` (a PR with nothing ahead of its base — a stale re-run after merge).
- **Unrelated histories succeeded too.** `git diff` happily compares commits with no common ancestor; that result is not the PR's change set.
- **A shallow clone disarmed the guard entirely.** `repoHasHistory()` counts commits reachable from HEAD, and a shallow clone reports 1 regardless of real history — `fetch-depth: 1` is the `actions/checkout` default. An explicitly-named base that failed to resolve was swallowed and the run reported PASS over zero evaluated files, with `require_resolvable_diff` set, on the money path. Silence must now be earned: it is granted only for a genuinely new repository with no base named, proven via `git rev-parse --is-shallow-repository`.
- **Truncated history is no longer conflated with unrelated history.** A shallow clone whose merge base is unreachable falls back to the two-dot range and still runs the runners, so a real regression still blocks — briefly, that case was treated as unusable, which downgraded a caught regression to a non-blocking FLAG.
- **`--base ''` silently demoted the run to "no base named."** An unresolved shell variable is a misconfiguration, not a request. Rejected loudly.
- **An explicitly empty `FQE_CHANGED_FILES` is never excused by repo history.** That is the caller asserting its own diff came back empty; a fact about the checkout has no bearing on it.
- **`isGitRepo()` conflated "git said no" with "git could not answer,"** and the second is the branch that grants silence. A dubious-ownership refusal, a broken `GIT_DIR`, git missing from PATH, or a moved worktree all read as "brand-new repo" and minted a clean green. Now keyed on a `.git` marker at or above the directory, so a git failure reads as suspicious rather than as newness.
- **The adjacent guards contradicted the main one.** `computeRequiredClasses` and `detectMoneyPaths` took the raw `!diff.ok` while the main guard applied the first-run qualifier, so the state one deliberately exonerated was hard-blocked by the other. One qualified value, computed once, shared by all three.

### Fixed (the receipt)

- **The receipt recorded nothing about scope,** so a blind PASS and a genuinely clean PASS were byte-identical after the fact — the product failing its own thesis. It now carries `diff_scope`: `source` (git or env), `base` (null unless a diff actually ran against it), `declared_base`, `range_start` (the merge base actually used), `confidence`, `indeterminate` (the field that answers whether this scope was trustworthy at all), `truncated_history`, `changed_file_count`, `unusable_reason`, and `tree_commit`.
- **The receipt could claim a base it never diffed against.** With `FQE_CHANGED_FILES` set, the file list comes from the environment and no `git diff` runs — but `diff_scope.base` was filled from `--base` anyway, so an env list of nonexistent paths plus a correct `--base` read as a git-verified clean run.
- **The receipt contradicted itself on truncated clones.** `diff_indeterminate` meant "zero information" until it also came to mean "approximate range, the runners did run" — and the sentence rendering it was never revisited, so a receipt asserted "evaluated ZERO changed files. Any runner gated on `when` was skipped" two lines above `runners_fired: ["unit"]` and `changed_file_count: 1`. Scope confidence is now three states (`exact`, `approximate`, `unknown`) and each renders a sentence that is true for it.

### Fixed (signing)

- **`diff_scope` is signed.** The field that distinguishes "clean because nothing was wrong" from "clean because nothing was evaluated" sat outside the MAC, so it was forgeable after signing.
- **Adding it broke verification of every previously-signed receipt.** `verifyReceipt` always used the current field list, so an untampered, in-retention artifact verified as "signature mismatch (receipt was tampered)" — from the tool whose product is tamper-evidence, under a scaffold that retains receipts for 365 days. `signature.covers` was already being written for exactly this purpose and never read back; it is now the authority on verify, restricted to known field names.
- **Verification no longer prints a bare OK when it cannot vouch for a field.** A receipt signed before a field existed never covered it, so that field can be rewritten with the signature block untouched and still verify — no forgery of `covers` required. The receipt is authentic for what it covers, so it still verifies, but `verifyReceipt` now returns `unsigned_fields` and `fqe receipt verify` names them.

### Fixed (runners, flags, explanations)

- **A timed-out runner was reported as never having started.** `spawnSync` sets `.error` when a child "failed OR timed out", so a suite that ran its full timeout was recorded as never started — the exact lie the release existed to remove, reintroduced by the fix for it. Detection now keys on positive evidence of execution.
- **The flag allowlist rejected nine documented flags,** including `coverage-ratchet --patch`, which appears four times in its own recipe. Derived from the code now, and pinned by a drift test plus a docs sweep. `fqe version --bogus` also silently exited 0; no-argument subcommands were invisible to the derivation.
- **`receipt verify --require-signature`** was rejected while both new allowlist tests passed — the map and the derivation shared a blind spot, so the drift test was comparing it to itself.
- **The whole diff-scope reason family had no explanation.** It rendered as "file an issue, this explainer hasn't been updated" for conditions fqe understands completely; the approximate-range case now names the remedy (`fetch-depth: 0`).
- **A timeout was explained in only one of the three shapes the verdict emits,** so the blocking quarantine-expired case sent the reader to the issue tracker.
- **Runner logs are uploaded by CI.** `evidence_paths` named `out/runner-<name>.log` while the workflow uploaded only `QA-RESULT.*`, so the receipt pointed at files no reader could reach. A `#` comment inside the `path: |` block scalar was also being passed to `upload-artifact` as three glob patterns.

### Fixed (docs)

- **`verdict.js` had outgrown its own documented size** in six places across `README.md`, `docs/faq.md` and `docs/architecture.md` (claimed ~500 lines, actually ~600). fqe asks readers to audit that file themselves, so a wrong size is the first thing they check. Caught by the repo's own doc-accuracy guard and corrected rather than silenced.

### Notes

- 862 tests. Every fix in this range was negative-controlled **individually** — reverted alone, in a scratch copy, to confirm a specific test goes red. Batch-controlling hid two hollow tests of my own, both of which passed with their fix reverted.
- A green suite was never the evidence here. 808, 826, 839, 846 and 851 passing tests each accompanied a product with a live silent-PASS defect.


## [0.18.19] - 2026-08-17

Tag: `fqe-v0.18.19`. (v0.18.18 shipped WITHOUT these: the push went to `fix/coldstart-text` while the PR tracked `fix/cold-start-text`, one hyphen apart, so the merge carried only the doc tier. Caught by cold-starting the published tag rather than trusting the merge.) Acts on a 3-engineer cold start (42 findings, 40 reproduced, 2 of 3 hard-stopped) and on CodeRabbit's first real review of this repo. Fixes the four defects that made fqe unusable for a first-time adopter, not just the docs describing them.

### Fixed (platform)

- **The receipt claimed a process ran when it never started.** `command: "npm"` on Windows cannot be spawned (npm is a `.cmd` shim), so fqe recorded `ran: true`, `exit_code: null` and a 7ms duration for a 74-second suite, blocked the merge, and told the engineer their runner's JSON was malformed. A tamper-evident receipt asserting a process ran is the worst thing this tool can get wrong, because the receipt IS the product. A spawn failure now reports `ran: false` with the OS error and, on Windows, the `cmd /c` workaround. It still blocks; it just tells the truth about why.
- **Unknown flags were accepted silently.** A one-character typo in `--config` made fqe load the DEFAULT config, turning a fail-closed gate into a green PASS. It is also why `--full`, a flag that never existed, survived into six docs and every generated receipt: nothing ever objected. Unknown flags are now rejected per subcommand.
- **An unresolvable base ref was swallowed.** `--base origin/main` against a `master`-default repo made git error, the error was discarded, `changed_file_count` came back 0, every `when`-gated runner sat out, and the gate returned PASS over a typo. Now surfaced. Scoped to an explicitly-named base so a fresh single-commit repo does not cry wolf.
- **`evidence_paths` was hardcoded to `[]`** while three docs promised the runner's stderr and the repro command told you to `cat ./out/runner-<name>.log`, a file nothing ever wrote. Runner stdout/stderr is now written to exactly that path and referenced by the receipt.

### Fixed (from CodeRabbit's review)

- `workflows/fqe-quality.yml.template` still emitted `fqe run --full`, the second time a reference template survived a fix that landed everywhere else.
- A CI guard now verifies on `main` that the pinned tag actually resolves. The doc guard only proved pins MATCH package.json, never that the tag EXISTS, so a release could ship pins pointing at nothing.
- Step 2's heading still promised detection that does not exist; `fqe doctor` and the smart-detect instruction removed from README and troubleshooting.

### Notes

- 808 tests. `cli/test/platform_fixes.test.js` reproduces each of the four defects as behaviour, end-to-end through the CLI and the real receipt.
- One of those tests was initially vacuous: it imported `runOne`, which is not exported, and returned early, reporting `ok` while asserting nothing. Rewritten to drive the real binary, at which point it FAILED and exposed that the spawn detail was being dropped in the mapping into the verdict input. The honest test found a real bug the green one hid.

## [0.18.17] - 2026-08-14

Tag: `fqe-v0.18.17`. Moves the proof into the suite, and fixes two pieces of text that had gone stale under their own code.

### Fixed

- **The "catches five spellings" claim had no committed evidence.** v0.18.16 proved it with a scratch script that hand-mutated `init.js` and was then deleted, so the suite carried none of it. The rule is now a pure `pathLandingsBeforeVerify()` with **six** committed counter-examples, plus one asserting the safe ordering is not flagged and one asserting a git-fetched install is out of scope. A claim about what a guard catches belongs in the guard's own tests, not in a changelog.
- **A sixth spelling, found while writing those tests.** `PATH_DIR` required a trailing `/`, so a bare directory target was invisible: `sudo install -m 0755 "$TMP" /usr/local/bin` is the identical defect and matched nothing. Now matched whether or not a filename follows.
- **The docblock still described the invariant this line of releases retired** — "never fetch into a PATH directory" — while the code below it had become an ordering rule. A comment describing something other than the code, in the file whose entire subject is that defect.
- **A dropped subject in `SKILL.md`.** A previous edit left "it keyed on wget/curl, and&nbsp;&nbsp;has neither", with the `sudo install` that "has neither" removed. That is the file an agent loads to decide whether to fire fqe.

### Notes

- 798 tests. Two gaps stay open and are recorded rather than fixed: the hollow-pass floor for this guard is shared across both generated workflows rather than per-file, and the ordering check binds to "some checksum ran earlier in this step" rather than to the specific artifact being installed. Both are latent while `init` emits two files with one fetch each. They are restructures, not corrections.

## [0.18.16] - 2026-08-14

Tag: `fqe-v0.18.16`. The v0.18.15 guard caught one spelling of the defect. There are at least five.

### Fixed

- **Swapping two lines reproduced the identical vulnerability with the guard green.** v0.18.15 asserted that no workflow downloads into a PATH directory, keyed on a `wget`/`curl` line. But `sudo install -m 0755 "$YQ_TMP" /usr/local/bin/yq` placed *before* the `sha256sum -c` is the same unverified-binary-on-PATH window, and that line contains neither `wget` nor `curl`, so the scanner skipped it entirely. Its changelog called the invariant "positional and hard to fake"; it was neither.
- The rule is now an **ordering** one and scoped per step: within any step that fetches something, nothing may land on a PATH directory before a checksum verification in that same step. Tested against five spellings of one defect: `wget -O` straight to `/usr/local/bin`, install-before-verify, `--output-document=`, a `curl` redirect into `/bin`, and a pipe into `sudo tee`. All five caught; previous versions caught one or two.
- `PATH_DIR` no longer enumerates a handful of directories. On `ubuntu-latest` `/bin` is a symlink to `/usr/bin`, so naming one and not the other guarded nothing; `/sbin`, `/usr/sbin` and `$HOME/.local/bin` were also absent.
- **Step scoping also removed a false positive the whole-file version introduced.** The fqe CLI reaches PATH by `ln -sf` from a git-fetched, ref-pinned checkout, which has no checksum to wait for. A file-wide ordering rule flagged it, which is the cry-wolf failure this file elsewhere calls its own worst outcome.
- A hollow-pass floor, matching every other whole-file scan here. Reshaping the install to an unmatched idiom would otherwise leave the guard green while inspecting zero lines.

### Notes

- 790 tests. The lesson across v0.18.14 → v0.18.16, worth more than the fix: each guard was written against the exact form of the bug just repaired, so each one caught that form and missed the property. Enumerate several spellings of a defect and test the guard against all of them **before** claiming it holds.

## [0.18.15] - 2026-08-14

Tag: `fqe-v0.18.15`. The v0.18.14 guard could not see the defect it was written for.

### Fixed

- **The download-onto-PATH guard matched the download URL, which is identical in the safe and the vulnerable form.** `/yq_linux_amd64/` appears in both `wget … -O "$YQ_TMP"` and `wget … -O /usr/local/bin/yq`, so reverting to the inverted order left the suite green. Proven by doing exactly that and watching it pass. This matters more than most: the inversion is the one defect here with a demonstrated recurrence rate, having shipped in v0.18.12 and again in v0.18.13. A guard written in response to a recurring defect, which cannot detect that defect, is worse than no guard, because it is cited as protection. The invariant is now positional and hard to fake: **no generated workflow may fetch a binary into a PATH directory.** Verified by reverting to the vulnerable form and watching it go red.
- **The yq staging path ignored the rule the same file argues for.** `mktemp` with no argument resolves to `/tmp` on GitHub-hosted runners, which do not set `TMPDIR` — the world-writable, sticky, job-persistent directory the fqe source staging deliberately avoids a few steps above. Now staged under `RUNNER_TEMP` like everything else.

### Notes

- 790 tests. Known and deliberately left: the binary guard scans per FILE rather than per JOB, and `findIndex` takes the first install site. Latent today because `init` emits two files with one job and one install each, so deleting either copy is caught by the other file's scan. It would go blind if a second job or a matrix leg were added inside one file. Recorded rather than fixed, because the fix is a real restructure and this release is a correction.

## [0.18.14] - 2026-08-14

Tag: `fqe-v0.18.14`. Hardens the yq step from v0.18.13 and the guard that was supposed to protect it.

### Security

- **The SHA256-pinned download landed on `PATH` before it was verified.** `wget -O /usr/local/bin/yq` writes first and `sha256sum -c` runs second, so an unverified binary sat on `PATH` in between. It fails closed as written (`set -e` aborts before `chmod +x`, and runner VMs are fresh), so this was not exploitable, but a pin only means something if nothing executable lands ahead of it — and v0.18.13 shipped a second copy of the inverted order. Both steps now download to `mktemp`, verify, then `install -m 0755` onto `PATH`. That is the order this repo's own `Dockerfile` already used.

### Fixed

- **The binary guard accepted a CALL as proof of an install.** Its `fqe` predicate alternated on `fqe version`, which is itself a call, so a workflow that only ever invoked fqe satisfied it. Its `yq` predicate matched `install .*yq`, which hit the step's own `name:` label. Both now match the actual install mechanism (`ln -sf …bin/fqe.js`, the `yq_linux_amd64` download).
- **The guard was order-blind**, testing "calls it" and "installs it" against the whole file independently. Moving the yq step below the step that uses it left the guard green while the workflow died at runtime — reachable by pure reordering, in a job whose steps are hand-ordered and where the fix had been a step insertion. It now requires every call to come after the install line.
- **Its call regex matched nothing at all.** Written narrowly to avoid comments, it failed to match even `yq --version`, let alone the real `if ! yq '.allowed_actors[]' …` invocation, so the yq half was silently inspecting zero lines. Comments and `name:` labels are now blanked before scanning, and the pattern recognises a `!`-negated call.

### Notes

- 789 tests. Three evasions negative-controlled: deleting the install step, replacing it with a bare call, and pure reordering. The reordering control initially reported a false MISS — the probe anchored on a filename that also appears in `init.js`'s doc comment, so it relocated the *other* workflow's step and produced a duplicate rather than a move. The guard was right and the harness was wrong, which is worth recording: a control that fails to reproduce its own scenario looks exactly like a guard that does not work.

## [0.18.13] - 2026-08-14

Tag: `fqe-v0.18.13`. Finishes the v0.18.12 fix, which moved a failure rather than removing it.

### Fixed

- **The container also supplied `yq`, and v0.18.12 did not replace it.** The generated `fqe-second-approve.yml` parses the second-reviewer allowlist with `yq`, which came from `ghcr.io/booyajones/fqe:0.1` (built with a SHA256-verified yq). Dropping `container:` without adding the install traded "fails at image pull" for `yq: command not found` three steps later. Still a workflow that cannot complete, and arguably worse because it now fails *after* doing work. It installs yq with the same SHA256-verified step the gate uses.
- **The container guard missed the string shorthand.** GitHub Actions accepts `container: ghcr.io/...` on one line as well as the block form, and the guard only matched the block. So the negative control held for the exact form just removed and not for the one a person would naturally write next.
- **`SECURITY.md` contradicted itself and rendered wrong.** It still said "**Three** install mechanisms ship" and "all three are mutable" directly above a paragraph saying there is no third, and that paragraph sat flush against the table with no blank line, so GFM consumed it as another table row.

### Added

- **A guard that every binary a generated workflow calls is installed in it.** This is the class behind the yq regression, not just the instance. Scope is the tools fqe introduces (`yq`, `fqe`); `git`, `node`, `npm`, `sudo`, `wget` and `gh` ship on GitHub-hosted runners and are not fqe's to install. Negative-controlled by deleting the yq step and confirming the guard names it.

### Notes

- 789 tests. The pattern worth recording: v0.18.12 removed a dependency without asking what else that dependency provided. The fix for a missing thing is not always deletion, and "it no longer fails the way it used to" is not the same as "it works".

## [0.18.12] - 2026-08-14

Tag: `fqe-v0.18.12`. Cleanup of the v0.18.11 handoff list, which turned up a workflow that could never have run.

### Fixed

- **`fqe init` generated a second-approve workflow that could not start.** It declared `container: ghcr.io/booyajones/fqe:0.1` and then called a bare `fqe`. That image has never been published: the authenticated GitHub Packages API returns 404 for the package and the owner has **zero** container packages. A job declaring it fails on image pull before its first step, so every adopter who ran `fqe init` received a broken bypass-rate unblock, which is precisely the path you need working on a bad day. It now installs the CLI the same ref-pinned `git fetch` + `npm ci` way the gate does. Both reference templates in `workflows/` had the same declaration and are now comments explaining why it was removed.
- Earlier releases described this image as a "mutable tag whose digest can change under you". That presumed a published tag. `SECURITY.md` now states the resolved fact: it does not exist, and nothing ships that depends on it.
- **`cli/package-lock.json` root `version` had drifted to `0.1.0`** against `0.18.12` in the manifest. `npm ci` validates the dependency tree rather than that field and the CLI has zero runtime deps, so it never failed, but the scaffold now runs `npm ci`, which makes the lockfile load-bearing.
- `docs/recipes/circleci.md` still used `npm install --omit=dev` while the Actions scaffold moved to `npm ci` in v0.18.11, an inconsistency that release introduced.
- **Both documented ways to resolve a tag to a SHA only worked with the tag already local.** A bare `git rev-parse fqe-v…` fails without a fetch, and on an annotated tag it can resolve to the tag object rather than the commit. Replaced with `git ls-remote <url> 'refs/tags/<tag>^{}' | cut -f1`, verified to return the same commit `git rev-parse` does.

### Added

- **A guard that no generated workflow declares a container.** Runs `init` into a temp dir and scans the output, so it checks what an adopter actually receives rather than the template source. If the image is ever published and pinned by digest, delete this test deliberately rather than working around it.
- **A hollow-pass floor on the container-org guard**, matching `MIN_PIN_CLAIMS` and `MIN_SIZE_CLAIMS`. Without it, removing every reference left it green while checking nothing.
- **A guard that all three manifests agree on the version** (root, `cli/`, and the lockfile, including the lockfile's own root package entry). Two were pinned to each other since v0.18.4; the lockfile was the unguarded third and was the one that had rotted.

### Notes

- 788 tests. All three new guards negative-controlled: re-introducing the container into the generated workflow, drifting the lockfile version, and blinding the org guard each turn the right test red. Generated workflows re-checked for container declarations and YAML validity.

## [0.18.11] - 2026-08-12

Tag: `fqe-v0.18.11`. Follow-ups to v0.18.10, and the last release of this session.

### Fixed

- **The `RUNNER_TEMP` fallback was dead code for the case it was written for.** The step opens with `set -euo pipefail`, so under `set -u` an UNSET `RUNNER_TEMP` aborts on the expansion itself with `unbound variable` and the following fallback never runs. It caught only set-but-empty. Unset is the normal state outside GitHub Actions (`act`, a bare-shell copy-paste), which is precisely who the fallback exists for. Now `${RUNNER_TEMP:-/tmp}`, escaped for the JS template literal that generates it. Verified both directions: the new form creates a directory with `RUNNER_TEMP` unset under `set -u`; the old form dies with `unbound variable`.
- **The SECURITY.md table under-reported in the direction it was written to fix.** It attributed the container form to "the two files an adopter copies", but `fqe init` **generates** it too, into `.github/workflows/fqe-second-approve.yml`. So "what init scaffolds" was not a synonym for the fetch row. It also graded two rows on their optional hardening and the third on its shipped state: **as shipped all three are mutable pins**. The table now separates "as shipped" from "ceiling if hardened" and says which files are generated rather than copied.
- **The CircleCI baked path was unquoted inside the emitted shell function.** `mktemp -d` honours `TMPDIR`, so an executor with a space in `TMPDIR` would split the path and every later `fqe` call would fail with `Cannot find module`.
- The scaffold now runs `npm ci --omit=dev` rather than `npm install`. `cli/package-lock.json` is checked in and was just fetched, so `ci` installs exactly it and fails closed when manifest and lock disagree. Identical today (zero runtime deps); the moment one is added, `install` could resolve outside the lockfile, which is the same drift channel v0.18.4 closed on the manifest side.

### Added

- **A guard that the container org is `booyajones`.** v0.17.0's changelog claimed this was made consistent by hand; it was not, and v0.18.10 fixed it by hand again. Two hand-fixes of the same fact is the signal to write the test. Negative-controlled: reverting one template to `finexio` turns it red and names the file.

### Notes

- 786 tests. Seven review rounds on this file line, every one finding something real. The findings shrank steadily (a broken headline install, then a broken hardening path, then a dead fallback, then a quoting bug) but never hit zero, so this stops on a judgment call rather than on a clean sweep. The remaining known gap is stated plainly above: the container image is a mutable tag and is not production-ready until it is published and pinned by digest.

## [0.18.10] - 2026-08-12

Tag: `fqe-v0.18.10`. Supply-chain follow-ups to v0.18.9, all found by review of it.

### Security

- **The scaffolded step staged fetched code at a predictable path in world-writable `/tmp`, then executed it.** `/tmp` is sticky (1777) and persists across jobs on self-hosted runners, so a fixed `/tmp/fqe-src` was a writable staging area another UID on the box could prepare first. The `rm -rf` added in v0.18.9 addressed the re-run symptom rather than the class, and could itself fail closed under `set -e` when the directory belonged to someone else. The step now stages in a fresh `mktemp -d` under `RUNNER_TEMP`. Verified: the exact generated sequence runs twice cleanly and resolves a raw SHA. The CircleCI recipe carried the same shape.
- **Two shipped workflow templates pulled a container image from the wrong org**, `ghcr.io/finexio/fqe` rather than `ghcr.io/booyajones/fqe`. The v0.17.0 changelog claimed the Docker org had been made consistent. It had not, in the two files an adopter actually copies.
- **`SECURITY.md` described two install mechanisms when three ship.** The templates install a container image on a MUTABLE tag carrying an unresolved pin-by-digest note, which is the weakest of the three. All three are now tabulated with their pin strength stated plainly, and the page says so rather than implying the strongest one covers everything.

### Fixed

- The upper-bound control flipped at 309 while its message said 300, because a trailing token must END inside the window. The gap now subtracts the token length so the stated number is the real one. Verified: green at 299, red at 300, green at 94, red at 93.
- `SKILL.md` had lost the subject of a sentence, leaving a stray parenthetical where `git clone --branch` belonged. It is the file an agent loads to decide whether to fire fqe.

### Notes

- 785 tests. The `mktemp` change first shipped broken: backticks and a `${...}` shell default inside a JS template literal terminated the string and made `init.js` unparseable, taking 34 tests red. Caught by running the suite, fixed, re-verified. Worth recording because that file is a template that GENERATES shell, so shell idioms and JS string syntax collide silently in it.

## [0.18.9] - 2026-08-12

Tag: `fqe-v0.18.9`. Follow-ups to v0.18.8, all found by review of it.

### Fixed

- **The scaffolded install was not re-runnable.** It used mkdir -p plus git remote add origin, and /tmp persists across jobs on a self-hosted runner, so a second run died on `fatal: remote origin already exists`. It failed closed, so no stale code could execute, but it was a red gate for no reason. Now rm -rf first, fetch the URL directly (no remote needed), and use git -C so the step cwd is untouched. Verified by running the generated sequence twice in a row and with a raw SHA. The CircleCI recipe carried the same shape and is fixed too.
- **docs/faq.md told upgraders to edit a variable the scaffold no longer writes.** The v0.18.8 rename to `FQE_REF` left the documented upgrade path pointing at `FQE_TAG=`, which an adopter would search for and not find. Invisible to the doc guard, which matches version tokens and not the variable name around them.
- **SECURITY.md made a universal claim about a mechanism only one of two workflows uses.** `fqe-oracle-guard.yml` installs via npx, where npm commit-ish accepts a tag or a SHA, so it was never affected by the --branch bug. Both are now named.
- **The v0.18.8 upper bound was loose while its entry read as tight.** A fixed 1000-character gap only went red once PIN_PROXIMITY reached ~1009, pinning the constant to roughly [94, 1008]: 900 stayed green, deep inside the failure the constant exists to prevent. Tightened to 300, verified red at 400 and at 80, green at 160.

### Notes

- 785 tests. This is the last correction round of the session. What remains from review is genuinely cosmetic, and the changelog for v0.18.5 through v0.18.9 is an honest record of a guard file that needed five passes to stop being wrong about itself.

## [0.18.8] - 2026-08-12

Tag: `fqe-v0.18.8`. The documented production hardening did not work, and two of v0.18.7's own claims were wrong.

### Security

- **SHA-pinning, this repo's recommended production hardening, broke the gate instead of hardening it.** `SECURITY.md` said to replace `--branch fqe-v…` with `--branch <40-char SHA>`, and the scaffolded workflow cloned with `--branch "$FQE_TAG"`. `git clone --branch` accepts a ref NAME only: passing a commit SHA fails with `Remote branch <sha> not found in upstream origin`. Verified against the live repo. An adopter following the security guidance got a workflow that could not install fqe at all. The scaffolded step now sets `FQE_REF` and uses `git fetch --depth=1 origin "$FQE_REF"` plus `git checkout --detach FETCH_HEAD`, which is verified working for **both** a tag and a raw 40-char SHA.

### Fixed

- **v0.18.7's headline second finding was false: the window is not asymmetric.** For a token of length L at gap g, trailing admits it iff `matchEnd + g + L <= matchEnd + proximity` and leading iff `matchStart - proximity <= matchStart - g - L`. Both reduce to `g <= proximity - L`. Confirmed by running it: at proximity 50 with a 9-character verb, both sides flip between g=41 and g=42. What actually put SECURITY.md's pin out of reach at 80 is that the token's LENGTH eats into the allowance, which is true on either side.
- **v0.18.7's upper-bound control was a tautology, and the entry claimed it as proof.** The fixture was `'x'.repeat(PIN_PROXIMITY + 50)`, so the gap grew in lockstep with the window and the assertion held for every possible value. The changelog said the constant was "pinned in both directions (verified: 80 too small, 5000 too large)"; the 5000 run went red for an unrelated reason, which was misread as confirmation. The fixture is now a fixed 1000 characters, and the two bounds are verified to fire independently: 80 trips the lower bound, 1200 trips the upper, 160 is green.
- The array-vs-object wording branch now keys off the same predicate that decides the field's type, rather than off `Array.isArray` of a value that only defaults to an array.

### Notes

- 785 tests. `fqe init` output re-generated and checked: the step is valid YAML and the fetch form resolves both ref kinds.

## [0.18.7] - 2026-08-12

Tag: `fqe-v0.18.7`. Corrections to v0.18.6, including a false claim in its own changelog entry.

### Fixed

- **v0.18.6 traded a real bound for a parameterised one, and said the opposite.** Its entry claimed the older proximity control "only asserted that the window was somewhere between 161 and 399". Working the arithmetic out, that control placed `git clone` ending at index 169 against a slice ending at `matchEnd + proximity`, so it went red the moment `PIN_PROXIMITY` dropped below 160: it was pinned exactly at the lower edge. Replacing it with tests that pass `proximity` explicitly pinned the RULE but left the shipped CONSTANT unconstrained downward, which is the very thing that dropped a real SECURITY.md pin at 80. Both kinds of control now exist, and the constant is pinned in both directions (verified: 80 goes red as too small, 5000 as too large).
- **The proximity window is asymmetric and no comment said so.** A token before the tag need only START within `proximity`; one after it must END inside the window, so the trailing allowance is `proximity - token.length`. That asymmetry is exactly why SECURITY.md's `git clone`, beginning 85 characters past the tag, fell out at 80. Three comments describing the trailing edge as "exactly at the boundary" were wrong about which character the boundary applies to.
- **"A version skew" was the wrong phrase for the `bundle*` fields**, whose values are arrays: equal membership with unequal content is an order or duplicate difference, and the message sent readers hunting for a version that did not exist.
- **The narrative guard bounded a LINE while its comment and failure message both said PARAGRAPH.** They coincide only because SKILL.md's status block is one ~4000-character line, so hard-wrapping it would have turned the guard red pointing at formatting rather than drift. Now split on a blank line.

### Not fixed, deliberately

- The two `bundle*` spellings are still compared independently, so declaring `bundledDependencies` in one manifest and `bundleDependencies` in the other fails even though npm normalizes them to the same thing. That is a false red on config that is correct in effect. Folding the alias before comparing would fix it, but it also widens what the guard reasons about, and this release is a correction pass rather than a feature pass. Fail-closed is the right default in the meantime.

### Notes

- 785 tests. This is the fourth consecutive round to find defects only in the guards. The bugs are getting smaller each time (a wrong noun, a bound off by a token length) but they are still the same class, so this release deliberately adds no new guard family: every change is a correction to something already shipped.

## [0.18.6] - 2026-08-12

Tag: `fqe-v0.18.6`. A third review round on the guards, and the honest headline is that v0.18.5 shipped with the defect it was written to fix.

### Fixed

- **The misattached docblock returned, in the commit that fixed it.** v0.18.5 moved the `dependencies` test out from between the `bin` test and its docblock, then inserted the new pin-proximity block between the attribution docblock and the attribution tests. So the first proximity test carried two stacked comments and the attribution tests carried none. Third occurrence of one mistake in one file, which is a fact about how easily a comment detaches from its subject when tests are inserted by anchor rather than by position. Each docblock now sits directly above the tests it names.
- **The proximity controls bracketed the boundary instead of pinning it.** They ran against the default constant with the negative case 240 characters past the edge, so they only asserted that the window was somewhere between 161 and 399. `PIN_PROXIMITY` could have drifted to almost any value and stayed green. They now pass `proximity` explicitly and check both edges at exactly the boundary and exactly one character past it.
- **The dependency-mismatch message named the wrong file in the case it exists for.** It inferred "which side has the extra key" from whether the root side was empty, which is right for two of four shapes and wrong for the two that matter: `{a}` vs `{a,b}` is precisely the drift of a dependency added to `cli/`, and it blamed the root; `{a:^1}` vs `{a:^2}` has no extra key at all, and it also blamed the root. Now computed from the actual key sets, with a distinct message for a version skew.
- **The dependency docblock said "ALL FOUR" while the code compared five.** The `bundledDependencies` alias added in v0.18.5 was never added to the prose beside it, so a reader auditing coverage from the comment would conclude the alias was unguarded. That is this release line's own defect, sitting inside the guard for it.
- **The SKILL.md narrative guard searched to end of file.** A gutted status paragraph could be satisfied by any version token further down, and every other doc in the repo carries an install pin. Bounded to the paragraph it names.

### Notes

- 783 tests. Nine positive-control scenarios still catch.
- Three consecutive rounds have now found defects only in the guards, twice reintroducing a defect in the commit fixing it. That is a signal about this file's density rather than about any one bug: it is 650 lines of judgment rules whose subject is their own accuracy. Future changes here should move one rule at a time and re-read the docblock boundaries afterward.

## [0.18.5] - 2026-08-12

Tag: `fqe-v0.18.5`. Acting on the review of v0.18.4. Every finding was a defect in the guards themselves, which is the honest state of a release line about self-inspection: the guards are now the thing most likely to be wrong.

### Fixed

- **A docblock was attached to the wrong test.** The new `dependencies` assertion was inserted between the `bin` test and the docblock describing it, so one test carried two stacked comments (the first describing a different assertion) and the other carried none. In this file, whose entire thesis is that a comment describing something other than reality is the defect, that is the rot class it exists to catch.
- **Only `dependencies` was compared between the two manifests.** `optionalDependencies`, `peerDependencies` (npm 7+ installs these automatically) and `bundleDependencies` all satisfy the same "declared in `cli/`, never installed for the adopter" shape and all slipped through. Guarding one spelling of a defect is not guarding the defect. All five spellings are compared now, including the `bundledDependencies` alias below.
- **The prose-label guard used one shared `checked > 0` floor across two patterns.** There is exactly one match of each in the repo, so one pattern rotting to zero matches was masked by the other. Rewording README's opener to drop its trailing period would have made that pattern match nothing while the assertion stayed green and the label rotted forever, which is the v0.18.3 bug verbatim. Each pattern now has its own floor.
- **The pin guard matched PIN_CONTEXT against the whole line.** A "line" in SKILL.md's status block is a 4000-character paragraph, so one incidental "npx" in prose marked every version token in it as an executable pin, including correct historical mentions. Now scoped by proximity to the tag. This is the third appearance of one shape: the size guard attributed by array order over a window, the test-count guard excluded by whole line, this one matched by whole line. **Scope the context to the claim, never to whatever container it sits in.**
- **`SKILL.md`'s number was correct while the paragraph under it was two releases stale**, describing v0.18.2 in the present tense with no mention of v0.18.3 or v0.18.4, so a reader landed on a page labelled v0.18.4 and found the never-worked-install fix missing from the release story. Guarding the number cannot see that the prose it labels is out of date.
- **The `persist-credentials` blocks were written by a regex that doubled every newline**, leaving a blank line between each line of the `with:` block, and the same rationale copy-pasted into jobs where it did not apply. Collapsed, and each job now states its own reason.
- **The proximity fix silently shrank pin coverage by five characters.** At `PIN_PROXIMITY = 80` the guard stopped inspecting SECURITY.md's supply-chain pin, whose `git clone` sits 85 characters past the tag: 25 pins became 24 and nothing went red, because the dropped one happened to be correct. Widened to 160, and the rule is now a pure `pinContextNear()` with boundary tests, for the same reason `attributeSizeClaim` was extracted: a window that is only ever exercised against today's files is untested by construction.
- **`bundledDependencies` (with the d) is a real npm alias** that `normalize-package-data` folds into `bundleDependencies` at install time. This guard reads raw JSON and never sees that, so declaring the alias in `cli/package.json` alone would pass green while npm honored a bundle the adopter never got. Five spellings compared now, not four.
- **The dependency message was directional while the assertion is symmetric**, so a key present only in the root manifest produced a failure telling you to edit the file that was already correct.
- **SKILL.md restarted the drift it had just fixed.** v0.18.4 corrected a two-release gap between the status label and the narrative under it; v0.18.5 reopened it at one release in the same commit. Guarding the number cannot see the prose, so the narrative lead is now checked too.

### Notes

- 782 tests. All nine positive-control scenarios still catch, verified after the proximity change loosened the pin guard, since loosening is exactly when a guard quietly stops catching.

## [0.18.4] - 2026-08-12

Tag: `fqe-v0.18.4`. Acting on the CodeRabbit and Claude reviews of v0.18.3. Two of the three findings are the same defect class this release line exists to close: the path that gets tested differing from the path that ships.

### Security

- **`actions/checkout@v5` persisted credentials into every job.** It defaults `persist-credentials: true`, leaving a `GITHUB_TOKEN` in `.git/config` while the new install job executes repository code through `npx`. No step needs authenticated git, so all three checkouts now set `persist-credentials: false`.

### Fixed

- **The two manifests could diverge on `dependencies`, and only the root one is installed.** A runtime dependency added to `cli/package.json` (the natural place) would never be installed for an adopter, and the install job would stay green because `version` / `init` / `validate` do not exercise a dependency used by, say, `reconcile.js`. Green CI, `MODULE_NOT_FOUND` in the adopter's gate. Now asserted equal. Both are empty today, so this fails on the commit that introduces the divergence rather than on the bug report months later.
- **The prose release label was stale while the badge was correct.** v0.18.3 guarded the shields.io badge and not the sentence underneath it, so README's Status paragraph and SKILL.md's `**Status:**` line both still read v0.18.2 on a green build. The badge is decoration; the paragraph is the claim. Both are now guarded.

### Notes

- 778 tests. Both new guards negative-controlled: a runtime dep in only the root manifest, and a stale prose label, each planted alone and each caught.

## [0.18.3] - 2026-08-12

Tag: `fqe-v0.18.3`. **The documented install had never worked.** v0.18.2 shipped guards that proved every install pin named the current version. Running one revealed that none of those commands ran at all.

### Fixed

- **`npx --yes github:booyajones/fqe#<tag> cli/bin/fqe.js …` failed on every version ever tagged.** Verified identical `ENOENT` on v0.13.0, v0.17.0 and v0.18.2. Two independent causes, both now closed:
  1. **No `package.json` at the repo root.** npm clones the repo and immediately reads the root manifest to install it; fqe's manifest lives in `cli/`, so npm died before running anything. A root manifest now exists, declaring `bin: { fqe: "cli/bin/fqe.js" }`.
  2. **The command form passed a path where npx expects a binary name.** `npx <pkg> cli/bin/fqe.js init` makes `cli/bin/fqe.js` the subcommand, so the CLI exits with `unknown subcommand: cli/bin/fqe.js`. All 14 documented commands across nine files are now `npx --yes -p github:booyajones/fqe#<tag> fqe <subcommand>`.

  The `git clone --branch` install used by the CircleCI recipe and the scaffolded workflow was never affected, which is why CI stayed green: the gate installs itself the way that works and documents the way that does not.

### Added

- **A CI job that runs the documented install** on ubuntu and windows: `npx`-installs the commit under review from `file:`, asserts the reported version equals the root manifest's, then runs `fqe init` and `fqe validate` in a scratch repo. This is the check that would have caught the defect. Installing from the checkout rather than a tag means it validates the commit being reviewed, not the last release.
- **Three guards** in `doc_accuracy.test.js`: the root and `cli/` manifest versions must agree (adding the root one created a fresh drift risk in the same stroke, since npm advertises one version while `fqe version` prints the other); `bin.fqe` must point at a file that exists; and no doc may use the npx form that passes a path as a subcommand.

### Notes

- 776 tests, green on ubuntu + windows across Node 20 and 22.
- The lesson worth keeping: v0.18.2's pin guard confirmed all 25 pins named the current version while not one of those commands could run. **Checking that a claim is current is not checking that it is true.** The only guard that closes that gap executes the thing.

## [0.18.2] - 2026-08-12

Tag: `fqe-v0.18.2`. Doc-accuracy release. A cold re-read of the repo found that the claims fqe makes about ITSELF had rotted, in the exact places a skeptical engineer checks first. Nothing in the verdict core was wrong; everything describing it was. The fix is guards, not another hand-pass, because v0.17.0 already did a hand-pass and it did not hold for one release.

### Fixed

- **`npm test` was broken and CI could not see it.** The package script was `node --test test/`, which fails with MODULE_NOT_FOUND on Node 22 (both with and without the trailing slash). CI stayed green the whole time because `tests.yml` ran its own `node --test test/*.test.js` instead. The script is now bare `node --test`, which relies on Node's own test discovery and therefore needs no shell glob expansion on any platform, and **CI now runs `npm test`** so the documented command is the one CI proves. A command CI never runs is a command nobody has tested.
- **`fqe explain` recited a false number at runtime.** It hardcoded verdict.js at "~160 lines" in one sentence and "140 lines" in the very next, to the engineer running the 5-minute audit. It now reads the real file and reports its actual size, so it cannot drift again. Same single-source-of-truth fix v0.17.0 applied to the version string.
- **26 stale executable install pins.** Every `npx` / `git clone` / `FQE_TAG` pin across 15 files still read `fqe-v0.17.0` at v0.18.1, so anyone copy-pasting the documented install got a release behind on the v0.18.1 security-relevant scaffold fix.
- **Source-size claims were off by 3x.** Ten places put verdict.js at 160 lines; it is 516, having grown from 3 verdict passes to 12 across v0.9 -> v0.18. SKILL.md put bin/fqe.js at ~400 LOC; it is 1069.
- **`docs/architecture.md` documented a vulnerability as current behavior.** Its verdict pseudocode showed `if ci_95[1] > threshold`, that is, trusting the runner's own confidence interval. That is precisely the CRITICAL fail-open closed in v0.14.0, where a fabricated tight interval on a real 50/100 attack run sailed past the 0.01 money bar. It also showed 3 of the 12 passes and reported every CI breach as an advisory FLAG, omitting that a money/state breach is a hard FAIL. Rewritten to match the code.
- **README self-contradiction:** receipt signing was listed under "Planned next" while limitation #3 on the same page said it shipped in v0.16.0. Stale status block (v0.17.0 / 749 tests), stale "as of 0.13.0" caption, and a changelog description stopping at 0.13.0 are all corrected.

### Fixed (second pass, from PR review)

- **The new guard's attribution picked by ARRAY ORDER, not proximity.** `TARGETS.find(t => t.keyword.test(window))` returns the first entry listed, so `verdict` beat `bin/fqe.js` whenever both appeared in the 6-line window. SKILL.md passed only by luck of line ordering: sort that file tree alphabetically and the guard reports "claims 1070 for verdict.js, actual 516 (107% off)" — red, for the wrong file, on a doc that was correct. A guard that cries wolf gets deleted, which is the failure it exists to prevent. Now nearest mention wins, two files on the same nearest line report ambiguity rather than guessing, and the rule is a pure `attributeSizeClaim()` tested directly with synthetic fixtures (the whole-repo scan cannot catch this class: it only sees today's files, where the right and wrong answers coincided).
- **`return` instead of `continue`** inside the per-line match loop exited the callback for the entire line, so a second size claim on a line was skipped whenever the first was unattributable.
- **Three test-count claims were stale in files this release had already edited** (749 in `SECURITY.md`, `CONTRIBUTING.md`, `SKILL.md`), including the count backing the "no LLM in the verdict path" invariant in the threat model. `CONTRIBUTING.md` also told contributors to run `node --test test/` — the exact broken command this release fixes.
- **Three version mentions asserted the CURRENT pin but dodged the pin guard** (`SECURITY.md` x2, `docs/getting-started.md`), so at the next release they would have contradicted the guarded command ten lines above them in the same file. Reworded to name no version at all: an unrottable claim beats a guarded one.
- **Two overclaims this release itself introduced** in `docs/architecture.md`: "fails the build if either accumulator is *ever* assigned anything but `true`" promised AST-level coverage that a regex-over-source guard does not have (it misses aliasing and destructuring), and "the order does not matter to the outcome" was wrong for the `reasons` list, since a throw in Pass 3 means Passes 4-12 never contribute theirs. Both narrowed to what is actually true.
- **`fqe explain` read `verdict.js` twice per load** via two call sites in the module-scope array. Hoisted to one `VERDICT_SIZE` constant, which also makes it structurally impossible for the two sentences to disagree again — the original bug.

### Added

- **`cli/scripts/check_test_count.js`**: verifies every documented test count against the real suite. It runs as a separate CI job rather than a test, because a suite cannot count itself without spawning itself forever. Counts next to a third-party repo name (the more-itertools and semver proof forks) are excluded by proximity to the number, not by whole line — the first version excluded any line naming a third-party repo and silently swallowed SKILL.md's own count, which sits in a long paragraph that mentions the proof repos much later.
- **CI matrix**: ubuntu + windows, Node 20 and 22. `engines` declares `>=20` and a floor nothing runs is a claim rather than a fact; the repo also asserts cross-platform behavior ("1 Windows-symlink skip") that only Windows can observe.
- **A guard that `cli/test/` holds only `*.test.js`.** Bare `node --test` uses Node's default discovery, which executes ANY `.js` under a `test/` directory. Verified on Node 22.16 by dropping a `.js` into `test/fixtures/` and watching it run as a test, so `fixtures/` is deliberately scanned rather than skipped: that is exactly where a contributor would put one. Also verified Node does NOT descend into dot-directories, so a crashed Stryker run leaving `.stryker-tmp/sandbox-*/test/*.test.js` is not picked up.
- **A real floor on the pin guard.** It asserted only `checked > 0`. Since this release exists because 26 stale pins went unnoticed, a future PR consolidating 25 pin mentions down to 1 would have passed while watching 96% less. Now `MIN_PIN_CLAIMS`.

- **`cli/test/doc_accuracy.test.js`**: three guards that make all of the above self-enforcing. (1) Every executable install pin must equal `package.json`'s version. (2) Every source-size claim in the docs must be within 15% of the real file, attributed to its subject by keyword within a 6-line window. (3) The README status badge must match `package.json`. Each guard also fails when it finds NOTHING to inspect, so a reword cannot turn it into a hollow green. Scope is documented in the file header: prose version mentions and CHANGELOG history are deliberately out of scope, since they are correct as history.

### Notes

- 765 tests (764 pass, 1 Windows-symlink skip). Each guard was verified by planting its regression one at a time and confirming the right guard went red with the right message, including the two hollow-pass paths. A guard that has only ever passed is not evidence.
- Unchanged and still the real adoption blockers: no live production money-path proof, bus factor 1, HMAC rather than Sigstore by default, mutation gate advisory by default.

## [0.18.1] - 2026-06-02

Tag: `fqe-v0.18.1`. Acting on an external multi-LLM review (council + gauntlet, GPT/DeepSeek/Gemini) of the finished v0.18.0 package. The verdict is recorded honestly: internal dev-team use SHIP-WITH-CONDITIONS (~63/100), required money-path gate NOT-YET (~25/100), overall RECONSIDER (66/100), capped by what only people and data can fix (no live-money-path proof, bus factor 1, HMAC-not-Sigstore-by-default). This patch closes the two findings that were solo-fixable and were the structural blind spots a Claude-only review had missed.

### Added
- **`docs/build-vs-buy.md`**: the honest answer to the single most likely staff-engineer objection the review named ("why not Codecov + Stryker + Sigstore + branch protection?"). fqe does not replace those tools, it composes them; its only unique job is one deterministic, fail-closed, money-aware verdict across heterogeneous runners. For everything else: buy, do not build. Includes the honest adoption sequencing (off-the-shelf first, fqe as a non-blocking layer, required gate only after shadow-trial data).
- **Strictly-additive invariant guard** (`cli/test/source_hygiene.test.js`): fqe's strongest claim was that a verdict pass can only ADD a FLAG/FAIL and never clear one, but that was a convention enforced by discipline alone (the fragility the review flagged: "a Pass 13 by a tired human could silently break it"). A source guard now proves the two verdict accumulators in `verdict.js` are initialized once to `false` and thereafter only ever assigned the literal `true`. Any direct clear (`= false`, `&&=`, `||=`, `??=`, or a non-literal RHS) fails the test. Scope kept honest: it covers direct assignment, not aliasing/destructuring (verdict.js uses plain locals, so it is complete for the code as written).

### Fixed
- **`fqe init` scaffold pinned a stale, security-behind release.** The payments workflow `fqe init` writes pinned `FQE_TAG="fqe-v0.16.0"`, so new adopters got a version missing the v0.17 security fixes (the signing-key environment leak and the empty-UAT silent PASS). Bumped to `fqe-v0.18.1`.
- **`fqe init` scaffold emitted soon-deprecated CI actions.** Bumped the scaffolded `actions/checkout` and `actions/setup-node` to `@v5` to match the repo's own CI (GitHub deprecates the node20 action runtime in 2026). `upload-artifact` stays at `@v4` (current major).

## [0.18.0] - 2026-06-02

Tag: `fqe-v0.18.0`. The buildable backlog: the shadow-trial scorecard (the adoption-winning artifact), the last discovery gap, the CI-actions bump, and the doc nits.

### Added
- **`fqe scorecard --dir <receipts-dir>`** (`cli/lib/scorecard.js`): aggregates a directory of QA-RESULT receipts into the shadow-trial scorecard the red-team named as the precondition for trusting a required gate. Reports the three metrics: false-red rate (fraction of FAILs that were bypassed), gate wall-time (p50/p95/max), and true catches (FAILs that stuck). Plus verdict distribution, bypass count, and modeled human-review minutes. A report, not a gate (always exits 0). `--format json` for machine use.

### Fixed
- **M3:** a framework configured only via its config file (e.g. `vitest.config.ts` with no `package.json` devDep/script) is now detected — `discover()` populates the `configMarker` the framework's `manifestHit` reads. Previously such a suite was invisible.

### Changed
- CI actions bumped off the deprecated Node 20: `actions/checkout` and `actions/setup-node` to `@v5` across the workflow templates and the repo's own CI.
- Doc accuracy: `writing-a-runner` now states `ci_95` is recomputed/ignored since v0.14 and that a config `blast_radius` is authoritative; removed the broken `docs/releasing.md` and `claude-review.yml` references and the stale "628 tests" line.

### Notes
- 758 tests (757 pass, 1 Windows-symlink skip). The false-red signal is the deterministic proxy "a FAIL that a human bypassed"; the wall-time ratio target needs the team's own CI baseline, which is not in the receipt, so the scorecard reports the gate's own time and leaves the ratio to the operator.

## [0.17.0] - 2026-06-02

Tag: `fqe-v0.17.0`. Full-codebase adversary sweep + hardening. Prompted by "are you sure there is nothing else to do?", three adversaries audited the WHOLE codebase (not just diffs) — the per-version reviews had only ever seen diffs. They found a CRITICAL silent-pass, three HIGH fail-opens, and extensive doc drift, none diff-catchable.

### Fixed (fail-closed)
- **CRITICAL: an empty UAT spec is no longer a silent PASS.** `evaluateUat` now FAILs (coverage 0) when a spec declares zero criteria, at the source, so neither the YAML nor the JSON parser branch can mint a green from nothing (the YAML branch guarded this; the JSON branch did not).
- **The signing key is stripped from runner subprocesses.** Runner + inventory_cmd subprocesses ran with the full `process.env`, exposing `FQE_SIGNING_KEY` (and other CI secrets) to PR-controlled commands, which could exfiltrate the key and forge signed receipts. They now get a sanitized env with secret-named vars removed.
- **Bypass-rate undercount fixed.** A bypass row with a missing/unparseable timestamp was silently dropped from the rolling-rate numerator (a way to keep the abuse alarm quiet). It now counts (fail closed toward detection); undatable totals do not dilute the denominator.
- **`.fqeignore` no longer over-matches.** A bare pattern (`src`) matched any prefix (`src_test.py`), which could hide whole test suites from discovery. It now matches only the exact path or a path-segment boundary.
- **Oracle/golden/config matching is case-insensitive**, so a case-variant rename (`.FQE.YML`, `*.GOLDEN`) on a case-insensitive filesystem can no longer evade the tamper guard.
- **A malformed lcov payload (`LH:xyz`) is UNREADABLE, not 0** (no longer coerced via `|| 0` into a confident wrong coverage number).
- **Source hygiene:** removed two literal NUL bytes from `orchestrator.js` (`computeContentHash` used a raw `0x00` delimiter instead of the `\0` escape; same hash, but it made the file read as binary to grep/editors). Added a guard test that fails if any source file ever contains a NUL byte.
- **Receipt signing key_id check is unconditional** (an absent key_id no longer skips the check); `key_id` is domain-separated. The signed tuple now explicitly includes `bypass` (override authority).

### Changed
- **Version drift root cause removed.** `bin/fqe.js` and `lib/explain.js` no longer hardcode the version (explain.js was stuck at 0.7.0 and printed it at runtime); both derive it from `package.json`, the single source of truth.
- **Docs honesty pass:** 27 stale install/pin tags updated to `fqe-v0.17.0`; stale test counts (162/407/613/740) and version badges corrected; the removed `fqe-bypass` label is replaced with the `/fqe-bypass` comment everywhere; the architecture doc's stale Events-API identity path and a broken `validateCtx` reference are corrected; the Docker image org is consistent (`ghcr.io/booyajones/fqe`).

### Added
- opt-in `require_nonempty_gate` (shipped in 0.16; documented). `cli/test/hardening_v017.test.js` + `source_hygiene.test.js`. 749 tests (748 pass, 1 Windows-symlink skip).

### Notes
- Confirmed clean by the sweep: bypass_guard, golden, reconcile, trace, junit, inventory, qa_report, and the core verdict / bypass-identity / prototype-pollution / command-injection defenses all held. One audit finding (runner stdout in the receipt) was verified a false positive: stdout is captured for line-parsing but never serialized into the receipt or Check Run.

## [0.16.0] - 2026-06-02

Tag: `fqe-v0.16.0`. Trust hardening: the receipt goes from tamper-EVIDENT (a hash) to tamper-PROOF (a signature), closing the red-team's "a bare hash is compliance theater" objection. Plus an opt-in empty-gate guard.

### Added
- **Receipt signing** (`cli/lib/signature.js`, `fqe receipt sign` / `fqe receipt verify`). HMAC-SHA256 over a canonical field tuple (`schema_version`, `fqe_version`, `commit_sha`, `content_hash`, `inputs_hash`, `verdict`); `content_hash` already covers every file, so the signature authenticates the full claim. Signing is deterministic (the caller passes `signed_at`; it is metadata, not part of the signed payload) and the tuple is robust to YAML round-trip. `verify` fails closed (exit 2) on any tamper, a wrong key, or a missing signature under `--require-signature`. A `key_id` records which key signed.
- **Sigstore keyless recipe** (`docs/recipes/receipt-signing.md`): the CI workflow step for OIDC identity-bound, non-repudiable, transparency-logged signing — the SOC2/PCI-grade layer above HMAC.
- **F2 (opt-in) empty/hollow-gate guard**: with top-level `require_nonempty_gate: true`, a gate with no teeth (no required runner, no required test class, no money-idempotency requirement) FAILs instead of minting a green that protects nothing. Default off, so the documented "no runners = PASS" behavior is unchanged.

### Notes
- HMAC proves key possession (the CI runner held `FQE_SIGNING_KEY`); Sigstore keyless is the non-repudiation answer and runs in CI. Honest scope documented in the recipe. 740 tests (739 pass, 1 Windows-symlink skip).

## [0.15.0] - 2026-06-02

Tag: `fqe-v0.15.0`. Money-aware strict profile + foot-gun caps. fqe's fail-closed guarantees were real but opt-in: strict protections defaulted off and the abusable carve-outs were unbounded. v0.15.0 makes money repos safe-by-default and caps the carve-outs. Designed via a parallel agent workflow (one designer per feature, synthesized into one conflict-aware build plan).

### Added
- **`fqe init --payments`**: scaffolds a strict money profile (`PAYMENTS_FQE_YML`) with required, reconciled, strict-coverage, blocking-mutation money/contract runners and `require_money_idempotency`.
- **Money-strict validation (MS)**: a `class: money`/`class: contract` runner must be `required: true`, declare a `report`, set `reconcile: true` and `strict_coverage: true`, and may not be `quarantined`. Loosening any of these FAILS validation loudly. Under a money policy, `mutation.mode` must be `blocking`, the allowlist is capped at 10, and `max_suppression_ratio` may not exceed 0.5.
- **F1 quarantine TTL**: a `quarantined: true` runner must carry a `quarantined_since` ISO date and expires after `quarantine_ttl_days` (default 14, max 90). An expired quarantine no longer shields a failure (it FAILs). Quarantine is banned on money/contract classes. The clock lives in the orchestrator; verdict.js stays clock-free.
- **F6 mutation allowlist suppression-ratio cap**: if more than half the in-scope survivors are allowlisted as equivalent, the advisory gate FLAGs the suppression (configurable via `mutation.max_suppression_ratio`, default 0.5).
- **F8 `min_mutants` ceiling**: capped at 5, so a high floor cannot pin the gate to NEUTRAL forever.
- **A4 money-path heuristic** (`cli/lib/money_scan.js`): detects money-looking code in the diff (by path and keyword) and FLAGs it when no money policy is configured (FAIL under `require_money_policy_when_detected`). Detection is by real signal; a blind diff is handled fail-closed by `require_for` activation, not a noisy universal flag.
- **F9 dead `require_for` glob detection**: a policy glob that matches no repo file is reported (FLAG, or FAIL under the strict flag), catching a typo that would silently guard nothing.

### Notes
- Backward compatible for non-money repos: the strict rules key on the money/contract class, and the new top-level flags default off. 720 tests (719 pass, 1 Windows-symlink skip). Still NOT proven on a live production money path.

## [0.14.0] - 2026-06-02

Tag: `fqe-v0.14.0`. Integrity hardening. A completeness-adversary pass (find what is MISSING, not what is wrong) plus an Opus code review found fail-opens that five prior "done" releases shipped past, including a CRITICAL one in the exact part built to defend the money / MCP-write blast radius.

### Fixed (fail-closed)
- **Adversarial Wilson CI is recomputed from raw counts (CRITICAL).** verdict Pass 3 used to trust a runner-supplied `ci_95`, so a runner reporting a real 50/100 attack run with a fabricated tight interval passed the 0.01 money bar. The interval is now recomputed via `wilson95(successes, n)` inside the deterministic core; any supplied `ci_95` is ignored. A runner controls only the raw counts, not the inference.
- **`require_stats_for` is now wired in the real `fqe run` path.** A runner that declares a `blast_radius` must emit its adversarial stats; a dropped payload fails closed. The orchestrator derives the requirement from config (previously the check was dead code never populated outside the raw `fqe verdict` JSON path).
- **`blast_radius` is bound from config, not trusted from runner output.** A money-class runner cannot self-label a weaker class to dodge the bar. A `blast_radius` runner must be `required: true` so a diff that misses its `when` globs cannot skip the stat requirement.
- **A malformed mutation report fails closed.** A declared mutation gate with an unparseable or junk report now FAILs (blocking) or FLAGs (advisory) instead of silently going NEUTRAL. `parseStryker` throws on invalid JSON instead of returning a zeroed tally, so the `fqe mutation-gate` CLI path cannot pass a corrupt report.
- **The `mutation:` block now parses from `.fqe.yml`.** It previously fell through to `{}`, so the mutation gate was unreachable through `fqe run` (configurable only via the raw `fqe verdict` JSON path).
- **`reconcile` with no numeric collected count fails closed** instead of silently skipping reconciliation.
- **`fqe verdict` CLI fails closed to exit 2 (FAIL)** on a rejected input, matching the orchestrator, rather than surfacing as an infra error (exit 1).

### Added
- `blast_radius` runner config key (validated against the canonical blast classes).
- `cli/test/integrity_v014.test.js` plus CLI and schema regressions. 628 tests (627 pass, 1 Windows-symlink skip).

### Honesty
- `package.json` version was stale at 0.7.0 (now 0.14.0); SKILL.md was frozen at v0.7.0/410 tests; `fqe init` scaffolded a stale `fqe-v0.7.0` tag; a doc cited a test that does not exist; README/getting-started carried stale 0.1/0.7 anchors and a wrong Docker org. All corrected.

### Notes
- Reviewed by a 3-agent completeness adversary, an Opus code review (full files), and a technical gauntlet (no confirmed fatal flaw). Still NOT proven on a live production money path; that needs a sandbox. The receipt is content-hashed, not cryptographically signed (planned).

## [0.13.0] - 2026-06-01

Tag: `fqe-v0.13.0`. Stage B linchpin: the mutation-on-diff judge with advisory-first governance. Coverage-liveness proves a test RAN, mutation proves it would CATCH the code breaking. This is what lets fqe trust AI-authored tests without a human reading each one.

### Added
- **Top-level `mutation` block** (mode advisory|blocking, threshold, min_mutants, allowlist) + verdict Pass 9. A `class: mutation` runner emits a Stryker report or a direct `{killed,surviving,survivors}` tally; fqe scopes it to the PR diff, applies the equivalent-mutant allowlist, and maps survivors below threshold to a FLAG (advisory, the default) or FAIL (blocking, once ratcheted). Too few mutants is NEUTRAL (cannot judge, never a silent pass, never a block). The mutation judge can only ADD a FLAG/FAIL, never clear one, so it sits below contracts and money-invariants in the trust hierarchy.
- `evaluateMutationAdvisory` + survivor keys (file:line:Mutator) so an allowlist survives across runs. Built on the existing `parseStryker`/`evaluateMutationGate`.
- docs/recipes/mutation-advisory.md (advisory-first, diff-scope cost control, the AI-authoring-through-the-gate pipeline, and why advisory-first beats a hard gate for adoption).

### Notes
- Backward compatible (no mutation block = no mutation signal). Advisory by default so it never sprays false reds. Ratchet to blocking once the false-red rate on real PRs is near zero.

## [0.12.0] - 2026-06-01

Tag: `fqe-v0.12.0`. `fqe baseline`: contract coverage from the spec a team already wrote (the highest-trust oracle), no LLM guessing.

### Added
- **`fqe baseline --spec openapi.json`** (lib/baseline.js): count operations in an OpenAPI/Swagger JSON spec and scaffold a `contract`-class Schemathesis runner with coverage-liveness wired, so a contract suite that exercised fewer operations than the spec declares FAILs. Fail-closed: an empty, non-JSON, or non-OpenAPI spec throws rather than yielding a misleading 0 (OpenAPI YAML must be passed as JSON, which every toolchain can emit).

### Notes
- Backward compatible. The $0.01 sandbox canary (needs a payment-sandbox credential) and Stage B (mutation-on-diff advisory-first + AI authoring through the gate) are still ahead.

## [0.11.0] - 2026-06-01

Tag: `fqe-v0.11.0`. Stage A part 2: the mandatory money-idempotency invariant, the single highest-severity payments control. fqe now refuses a green for a money-movement repo that never proved a repeated request pays once.

### Added
- **`require_money_idempotency`** (top-level) + a runner `invariant: [idempotency, double-spend, conservation, no-negative-balance]` field. verdict Pass 8: with the flag on, a runner must have ran AND passed AND declared the `idempotency` invariant, else FAIL. Closes the worst payments failure class (double-pay under retry/crash) at the gate.
- docs/recipes/money-invariants.md: real Hypothesis and fast-check idempotency + double-spend property tests, the coverage-liveness pairing, and an optional Toxiproxy crash-window dimension.

### Notes
- Fully backward compatible (flag defaults off).
- Remaining v0.11 (separate, deterministic): `fqe baseline` (OpenAPI/DB DDL into Schemathesis). The $0.01 sandbox canary needs a payment sandbox credential and a safe target. Stage B (mutation + AI authoring, advisory-first) follows Checkpoint 1.

## [0.10.0] - 2026-06-01

Tag: `fqe-v0.10.0`. Stage A of the near-autonomy roadmap (researched + council/gauntlet vetted): trust hygiene and inter-suite discovery, the deterministic foundation the mutation/AI layer (Stage B) sits on. Sequenced cheap-deterministic-wins-first on the council's correction.

### Added
- **`fqe discover`** (lib/discover.js): detect test frameworks (pytest, jest, vitest, mocha, playwright, cargo-test, go-test) from manifests and test files, and report any with no matching declared runner. Extends "make absence loud" from inside a suite (v0.9.0) to ACROSS suites. verdict Pass 7: an unwired suite is a FLAG, FAIL under `require_all_suites_wired`. Honors `.fqeignore`. Fail-loud: ambiguous evidence reports the framework rather than hiding it.
- **Flaky-retry + quarantine** (trust hygiene): a runner `retries: N` re-runs on failure; fail-then-pass is FLAKY, a loud FLAG, never a silent PASS and never a blocking FAIL. `quarantined: true` makes a known-flaky runner's failure a neutral FLAG (stays visible in the receipt) so one unstable suite cannot hold a 10-person team hostage. A non-quarantined failure still FAILs.
- **Human-review telemetry**: the receipt reports a review queue (flags, flaky, quarantined, unwired suites, AI drafts) with estimated minutes, so the near-autonomy target (3 to 6 team-hours per week) is observed, not asserted.
- docs/recipes/discovery-and-trust.md (discover, retries/quarantine, deterministic helpers, the review queue).

### Notes
- Fully backward compatible: runners without the new fields are unaffected.
- Stage A only. Mutation-on-diff and AI authoring (Stage B) are advisory-first and land in v0.12 after Checkpoint 1.

## [0.9.0] - 2026-06-01

Tag: `fqe-v0.9.0`. Coverage-liveness ("make absence loud"): a green can no longer be minted by a suite that ran nothing. Proven by plugging fqe COLD into real third-party Python (more-itertools) and Rust (semver) repos on real CI, turning the "works on any stack" claim from a design property into a reproducible fact (n=3 stacks: TypeScript, Python, Rust).

### Added
- **Coverage-liveness in the verdict path** (no LLM, fail-closed). New opt-in runner fields: `report: junit:<path>`, `inventory_cmd`, `inventory_format` (`count` or `pytest-collect`), `min_tests` (>= 1), `reconcile`, `strict_coverage`; plus a top-level `require_coverage_evidence`.
  - A required runner with no fresh, parseable report FAILs (mandatory evidence).
  - Non-skipped executed count below `min_tests` FAILs (catches empty and all-skipped suites; pytest renders skip AND xfail as `<skipped>`).
  - Collected-vs-executed reconciliation: fewer testcases reported than the framework collected FAILs under `strict_coverage` (else FLAG). Count-based, so it needs no brittle id-string normalization and works on pytest and cargo-nextest alike. A deflated inventory (reported > collected) FAILs closed.
- `cli/lib/junit.js` (zero-dep JUnit parser: counts only non-skipped cases, fails closed on ambiguity, strips XML comments, accepts both quote styles, handles Jest `pending`) and `cli/lib/inventory.js` (collected-count parser).
- Report freshness is clock-INDEPENDENT: fqe records any prior report's mtime, deletes it before the run, and requires the runner to have rewritten it, so a stale or cached report cannot pass even if the delete fails.
- Proof repos: booyajones/fqe-proof-python (more-itertools fork) and booyajones/fqe-proof-rust (semver fork), each green through fqe with a planted mis-scoped run proven RED on real CI.

### Notes
- Fully backward compatible: runners that declare no coverage fields are unaffected.
- Hardened across three plan-gauntlet rounds and two code reviews; every identified fail-open seam was closed before release.

## [0.8.1] - 2026-06-01

Tag: `fqe-v0.8.1`. fqe now self-hosts its own v0.8.0 backstop: the QA engine is gated by the same anti-tautology and money checks it ships.

### Added
- **Self-host gate** (`.github/workflows/fqe-selfhost.yml`): on every push, fqe runs `spec-mutate`, `trace`, and `reconcile` against its own invariants.
- `cli/spec/fqe-invariants.spec` (the canonical blast-radius thresholds), `cli/test/selfhost_spec.test.js` (asserts `verdict.js` matches the spec, source-independent), and `cli/scripts/fqe_specmutate_run.js` (generates spec-mutants, runs the anchored test against each, tallies kills, fails closed on a spawn error, signal/timeout, or a broken baseline).
- `cli/spec/fqe-trace.json` (fqe's money/security requirements mapped to tests) and `cli/spec/fqe-ledger-fixture.json` (a balanced ledger for the reconcile self-check).
- `docs/recipes/self-host.md`: the turnkey pattern any repo copies to gate its own money paths.

### Proven
- All three gates PASS on fqe's real invariants and FAIL (exit 2) on planted defects: an untested money requirement, a surviving spec-mutant, and a one-cent ledger drift. 512 tests, 511 pass, 1 skipped (Windows symlink).

## [0.8.0] - 2026-06-01

Tag: `fqe-v0.8.0`. The autonomous-QA linchpin: three new pure, deterministic, fail-closed modules (no LLM in the verdict), built via an agent swarm and hardened through adversarial review plus two gauntlet rounds.

### Added
- **`spec-mutate`**: mutate the requirement and prove a test fails. A surviving spec-mutant is a tautological test pinned to the code, not the spec.
- **`trace`**: requirement-to-test traceability. A money or security requirement with no covering test, or a money/security test with no real requirement, FAILs.
- **`reconcile`**: deterministic integer-cents double-entry money HALT. Per-transaction and aggregate balance, orphan and over-captured authorizations, timezone-anchored expiry, safe-integer enforcement.
- `spec-mutation` added to the test-class taxonomy.

### Hardening (review + gauntlet findings, all fixed before release)
- spec-mutate: gate on the exact (not rounded) kill ratio, reject threshold 0, mutate every comparison and literal (both range bounds).
- trace: flag a test pointing only at a non-existent requirement, money/security floor cannot be narrowed, duplicate requirement ids throw.
- reconcile: over-capture halts, expiry-at-now is expired, ISO timestamps require a timezone, cents must be safe integers.

## [0.7.0] - 2026-05-30

Tag: `fqe-v0.7.0`. Source: github.com/booyajones/fqe. Turns fqe from a gate over whatever tests you have into a full-suite QA capability: it now understands and enforces every test class an engineering team needs (unit, regression, integration, contract, property, e2e, UAT, money), reports them as one scorecard, and blocks merges by policy. Built with a backbone-then-parallel-agents approach, code-reviewed, and all review findings fixed before ship.

### Added

- **Test-class taxonomy.** A runner can declare a `class` (unit, integration, e2e, regression, contract, property, uat, lint, type, mutation, coverage, security, money). The set is locked in `verdict.js` (`KNOWN_CLASSES`); a typo'd class is rejected by `fqe validate`.
- **Full-suite policy.** A new `policy` block in `.fqe.yml`: `require_classes` (classes that must always have a passing runner) and `require_for` (diff-conditional: when these globs change, these classes become required). A required class with no ran-and-passed runner is a FAIL in `verdict.js`. This is how "money paths get the strict bar" works, and it closes the v0.6.0 tracked deferral (financial runners required by policy). Fails closed: if the diff cannot be read, every `require_for` entry activates.
- **`fqe uat`** — user-acceptance testing as a gate. `uat --spec uat.yml [--results R.json] [--strict]`. A criterion verified by an automated test that passed is covered; a manual criterion needs a signoff; an unverified criterion is a gap (a missing automated result is never a pass). Strict mode makes a gap a FAIL.
- **`fqe golden`** — golden-master regression engine. `golden capture` snapshots deterministic command output; `golden verify` re-runs and FAILs on drift, missing baseline, or a failed command. Pairs with `oracle-guard` so a PR cannot edit its own golden.
- **`fqe qa-report`** — the single-pane QA scorecard. Rolls a QA-RESULT receipt up into per-class status, policy gaps, coverage, and the adversarial summary. Report-only by default; `--gate` maps the verdict to the exit code.
- The receipt now carries each runner's `class` and the run's `required_classes`. `fqe init` scaffolds the taxonomy and a commented policy block.

### Review findings fixed (pre-ship code review)

- Policy parser fails closed: a `require_for` entry with an empty `when:`/`classes:`, or any policy key with no value, throws instead of parsing to a droppable null.
- Diff-indeterminate runs require the strictest class set rather than silently dropping diff-conditional requirements.
- An unknown required class is reported as a likely typo (still fail closed).
- An empty golden manifest is an error, not a green pass. UAT results file must be a JSON object. Golden capture is all-or-nothing on a bad name. UAT spec parsing strips a BOM and refuses to silently yield zero criteria from a non-empty file.

### Tested

- 408 tests, 407 pass, 1 skipped (Windows symlink). No LLM in the verdict path.

## [0.6.0] - 2026-05-29

Tag: `fqe-v0.6.0`. Source: github.com/booyajones/fqe. Acts on an independent gauntlet (52/REWORK) and a 3-LLM council review. The two findings that capped the score are operational decisions, not code: rotate the exposed Anthropic key, and enforce the gate on a real money-path repo. The code, workflow, and doc findings are fixed here.

### Changed (security)

- **A money/state Wilson-CI breach now FAILs (blocks); it is no longer an advisory FLAG.** `verdict.js` adds `BLAST_RADIUS_BLOCKS`: a `mcp-write-or-financial` threshold breach blocks the merge, while looser classes (`outbound`, `mcp-read`) still FLAG. Closes the council finding "a FLAG that does not block is advisory theater."
- **The bypass allowlist is read at the default-branch HEAD, not the PR base ref.** Closes an offboarding / stale-allowlist hole (a PR branched from an old commit could otherwise carry a stale allowlist). SECURITY.md limitation #3 FIXED.
- **Receipt artifact retention raised 90 -> 365 days** for the SOC2/PCI 1-year minimum. SECURITY.md limitation #4 mitigated.

### Added

- **`verdict` `require_stats_for`**: a runner named in this list that emits no `adversarial_stats` is a FAIL. A compromised or misconfigured orchestrator cannot pass by dropping the stats array (fail closed).

### Docs and honesty

- The auto-test-author must NOT write money-path tests (mutation survival is not financial correctness; a human authors money invariants). Warning added to the recipe and the workflow-template prompt.
- Softened "proven" claims to honest framing: the Claude-review demo was n=1 with planted bugs; the mutation result is a real 57% -> 100% demonstration.
- SECURITY.md threat-model prose updated to the comment-based bypass and the current test count.

### Still open (your call, and what capped the review)

- **Rotate the exposed Anthropic API key.** Both reviewers led with this as the #1 disqualifier. It is free, and it caps the grade until done.
- **Enforce on a real money-path repo** with one real golden-master or partner-contract test. An advisory gate on a sandbox is, per the council, "a linter with good PR."
- Tracked: a runner-class field so financial runners can be required by policy (a non-required money runner is currently a config foot-gun).

### Tested

- 262 tests, 261 pass, 1 skipped (Windows symlink).

## [0.5.0] - 2026-05-29

Tag: `fqe-v0.5.0`. Source: github.com/booyajones/fqe. The "set up for success" release: completes the AI layer on your own Anthropic key (no per-seat vendor) and makes the platform adoptable by a small team.

### Added

- **Claude PR review** (`.github/workflows/claude-review.yml`, live on this repo). Anthropic's `claude-code-action` reviews every PR on your own `ANTHROPIC_API_KEY` and comments on the logic bugs the deterministic gate cannot see (float money math, missing idempotency, swallowed errors). Advisory, never blocks. Demonstrated on one PR (n=1, with bugs we planted, so this shows recall on known bugs, not novel ones): it caught four planted payments bugs plus missing tests and noted, unprompted, that the fqe gate could not catch them.
- **Auto-test-author** (`workflows/fqe-write-tests.yml.template`). Label a PR `fqe-write-tests` and Claude writes tests for the changed files on your key, commits them, and the new commit re-runs the gate so the mutation bouncer judges them. The $0 path to "tests write themselves," gated so a weak AI test cannot merge. Upgrades cleanly to qodo-ci or hosted Qodo later (same bouncer, different author).
- **Adoption runbook** (`docs/adopt.md`). The small-team playbook: the three layers, the 10-minute turn-on per repo, how to read a result, when to bypass, and honest sizing guidance (start advisory, skip the paid tools until you grow).
- **Playwright on-ramp recipe** (`docs/recipes/playwright.md`). Wrap an existing Playwright suite (including visual-regression configs) as a required runner. No rewrite.

### Notes

- The AI review and the auto-author both run on Anthropic's official action, so there is no new per-seat vendor. fqe stays the deterministic, blocking, auditable gate; Claude advises and authors; the mutation gate keeps the authored tests honest.

## [0.4.1] - 2026-05-29

Tag: `fqe-v0.4.1`. Source: github.com/booyajones/fqe. Accuracy + dogfooding patch.

### Fixed

- **The AI-test-generation recipe and the `fqe init --with-qodo` glue told people to `pip install qodo-cover`, which does not work.** The open-source Qodo Cover package is archived and not on PyPI. The recipe is now **generator-agnostic**: the mutation gate is the durable bouncer that works today with zero external account, and the test author is pluggable (qodo-ai/qodo-ci, Qodo's hosted product, or any LLM). The glue script is now a fail-safe no-op until you wire `FQE_TEST_AUTHOR_CMD`, so `--with-qodo` no longer generates a broken runner.
- Python mutation guidance corrected from `mutmut` (does not run on Windows) to `cosmic-ray`.

### Added

- **fqe now runs its own test suite in CI** (`.github/workflows/tests.yml`) and `main` is branch-protected requiring the `test` check. A QA tool with no CI on itself is not credible.
- A live, reproducible result in the recipe: on real Finexio code (`brand.ts`), the gate caught a 57% kill rate (coverage without assertions), and strengthening the tests took it to 100%. Ran locally in 7 seconds, no key, no Qodo.

## [0.4.0] - 2026-05-29

Tag: `fqe-v0.4.0`. Source: github.com/booyajones/fqe. This release closes the one security liability the council flagged for a payments company: the bypass mechanism. The design came from a 3-LLM council (claude + gpt + gemini chairman).

### Changed (security, breaking)

- **Bypass is now a SHA-bound, TTL'd PR comment, not a label.** An allowlisted maintainer posts `/fqe-bypass <40-hex-head-sha> <24h|48h|72h>`. The binding is SHA equality: the comment names the exact head it authorizes, so any new push changes `pull.head.sha`, the named SHA no longer matches, and the bypass evaporates with no forgeable inputs (git commit timestamps are forgeable, so the design never trusts them). Identity and time come only from the server-recorded comment object (`user.login`, `created_at`). Edited comments are rejected (`updated_at != created_at`). Full 40-hex SHA only. Fails closed on any error.
- **The legacy unbounded `fqe-bypass` label is no longer honored.** This is a breaking change to the bypass UX. Remove the old label from branch automation and tell maintainers to use the comment.
- The generated `fqe-quality.yml` reads the bypass from the comments API, validates with `fqe bypass-check`, and records `requester_source: github_comments_api_v3` in the receipt.

### Added

- **`fqe bypass-check`** (`cli/lib/bypass_guard.js`, 17 tests). The deterministic core of the bypass decision: TTL + allowlist + edit-guard + SHA binding, all fail-closed. Exit 0 = a valid bypass applies, 3 = no valid bypass (run the gate), 1 = malformed inputs.
- `receipt` now accepts `github_comments_api_v3` as a server-recorded identity source (alongside the legacy events source).

### Tested

- 259 tests, 258 pass, 1 skipped (Windows symlink). No LLM in the verdict path.
- The bypass design was validated by a 3-LLM council; the implementation was reviewed by a gauntlet (no fatal flaws; the edit-guard was hardened to fail closed on unverifiable timestamps).

### Closes

- SECURITY.md limitation #2 (bypass not bound to head SHA, no TTL).

## [0.3.0] - 2026-05-29

Tag: `fqe-v0.3.0`. Source: github.com/booyajones/fqe. This release adds the two gates the gate itself was missing: a guard against a PR editing its own answer key, and fail-closed config validation so a typo cannot silently disable a check. It also fills the payments QA recipe set and adds a CircleCI path so the gate is not GitHub-Actions-only.

### Added

- **`fqe oracle-guard`** (`cli/lib/oracle_guard.js`, 20 tests). Flags a PR that edits the recorded ground truth or grading rules it is judged by (golden masters, snapshots, partner cassettes, fixtures, seeds, `.fqe.yml`, `coverage-baseline.json`, `stryker.conf.json`, the bypass/reviewer allowlists). With `--include-tests`, also flags a test changed alongside the source it grades, while a pure test-writing PR stays frictionless. Exit 0 clean / 3 FLAG (default) / 2 FAIL (`--block`). The companion `workflows/fqe-oracle-guard.yml.template` requires a second reviewer (not the author) before such a PR can merge. The mutation gate proves a test is strong; this keeps the answer key honest.
- **`fqe validate`** plus fail-closed validation inside `fqe run` (`cli/lib/config_schema.js`, 20 tests, `schemas/fqe-config.schema.json`). Rejects unknown keys (a typo'd `whne:` no longer silently disables a runner), wrong types, and runners that can never fire. A JSON Schema drives editor autocomplete.
- **Recipes**: `docs/recipes/property-based-testing.md` (closes the broken link from the rollout plan), `golden-master.md`, `partner-contract.md`, `oracle-tamper.md`, `flaky-quarantine.md`, and `circleci.md`.

### Changed

- **`fqe run` now ERRORs (exit 1) on a malformed `.fqe.yml`** instead of parsing past the problem, dropping the misconfigured runner, and passing green. This is a fail-closed behavior change: a config that used to "work" by silently skipping a check now blocks until fixed. Run `fqe validate` to see why.
- **`FQE_VERSION` bumped to 0.3.0.** It was still reporting `0.1.0` from `fqe version` and in receipts.

### Tested

- 240 tests, 239 pass, 1 skipped (Windows symlink). No LLM in the verdict path.
- The oracle-guard capability was scored by a multi-LLM gauntlet (technical mode, council): no fail-open or data-corruption flaws, fail-closed verified at the CLI and workflow layers.

## [0.2.0] - 2026-05-29

Tag: `fqe-v0.2.0`. Source: github.com/booyajones/fqe. The two quantity/quality gates below were the council's Phase-1 priority. They landed on `main` after the `fqe-v0.1.0` tag was cut, so this release tags them and re-points every pinned install reference at `fqe-v0.2.0`. Repos that pinned `fqe-v0.1.0` should bump their `FQE_TAG`.

### Added

- **`fqe coverage-ratchet --report FILE [--baseline coverage-baseline.json] [--patch-threshold 80] [--bump]`** (`cli/lib/coverage_ratchet.js`, 17 tests). The regression-quantity gate: enforces a patch rule (new lines at least 80% covered) plus total coverage never drops below a committed baseline. Auto-detects vitest/istanbul json-summary, coverage.py json, Cobertura, and lcov. Exit 0 / 2 (FAIL) / 4 (INFRA, unreadable report).
- **`fqe mutation-gate --report stryker.json [--threshold 70] [--changed "a,b"]`** or `--killed N --surviving N` (`cli/lib/mutation_gate.js`, 12 tests). The regression-quality gate and the bouncer for AI-generated tests: rejects tests that execute code without catching mutations. Surviving = Survived + Timeout + NoCoverage. Exit 0 / 2 (FAIL) / 4 (too-few-mutants, neutral).
- **`fqe init --with-mutation`** drops in the Stryker glue (`scripts/fqe_stryker_runner.js` + `stryker.conf.json`) and **`--with-qodo`** drops in a Qodo Cover wrapper that uses `ANTHROPIC_API_KEY` (Claude by default, no new vendor).
- **QA platform rollout plan** (`docs/qa-platform.md`) sequenced from a multi-LLM council review: Phase 1 trust gates (ratchet, flaky quarantine), Phase 2 the mutation-gated AI test factory, Phase 3 payments correctness (property-based, partner-contract, golden-master).
- **Recipes**: `docs/recipes/coverage-ratchet.md` and `docs/recipes/ai-test-generation.md`.

### Tested

- 179 tests pass (`node --test`). The new gates have no LLM in the verdict path, same as the rest of fqe.

### Changed

- Every pinned install/invocation reference moved from `fqe-v0.1.0` to `fqe-v0.2.0` (README, getting-started, faq, qa-platform, the recipes, SECURITY, and the `FQE_TAG` written by `fqe init`).

## [0.1.0] - 2026-05-24

Initial public release. Tag: `fqe-v0.1.0`. Source: github.com/booyajones/fqe.

### Added

- **`fqe run`** orchestrator that classifies the PR diff against `.fqe.yml` and dispatches matching runners as subprocesses.
- **`fqe verdict`** deterministic Node function computing PASS/FLAG/FAIL from runner exit codes + Wilson 95% CI bounds on adversarial stats.
- **`fqe explain`** staff-engineer 5-minute audit. Renders the three architectural invariants, canonical thresholds, current config, exit code taxonomy.
- **`fqe init`** with smart-detect repo bootstrap. Sniffs `package.json`, `pyproject.toml`, `.xlsx` files, `.vale.ini`, `templates/`, MCP markers. Generates context-aware `.fqe.yml` with commented suggestions per detected stack.
- **`fqe receipt`** subcommand suite (build, write, parse, generate-bypass) producing tamper-evident QA-RESULT.{yml,md} bound to `commit_sha + content_hash + inputs_hash`.
- **`fqe status publish`** that calls the GitHub Checks API via `gh api --input -` (nested JSON body, not form fields).
- **`fqe bypass-tally`** JSONL-based 14-day rolling rate tracker with separate run and bypass append commands.
- **`fqe wilson`**, **`fqe min-n`**, **`fqe thresholds`** utility commands for engineers debugging adversarial stat configs.
- **Engineer-grade failure explanations** in receipt markdown bodies. Every FAIL or FLAG includes plain-English reason, fix suggestion, copy-pasteable repro command.
- **Exit code taxonomy**: 0=PASS, 2=FAIL (block), 3=FLAG (informational), 4=INFRA (neutral Check Run, never blocks), 1=ERROR.
- **GitHub Actions workflow templates** (`fqe-quality.yml`, `fqe-second-approve.yml`) with tag-pinned clone of `booyajones/fqe@fqe-v0.1.0` and SHA256-verified yq install.
- **Auto-detect default branch** during `fqe init` (works on `main`, `master`, `develop`).
- **Three architectural invariants enforced in code**: (1) identity from GitHub Events API only, (2) no LLM in verdict path, (3) no required state only in PR branch.

### Tested

- 162 tests pass (unit + integration), 1 properly-skipped (symlink test on Windows).
- Wilson CI math pinned against `statsmodels.stats.proportion.proportion_confint` to 14 decimal places.
- Real GitHub Actions verification: https://github.com/booyajones/fqe-smoke-test/pull/1 (merged, both Check Runs SUCCESS).
- Excel runner validated against external 13,383-formula `vinci1it2000/formulas` test fixture (EUPL-1.1, public).

### Known limitations (planned for 0.2)

These five were flagged unanimously by a 3-judge LLM council before release. They are real architectural gaps, documented in SECURITY.md with today's mitigations.

- **Default install pins to a git tag**, which is force-pushable. Use the SHA-pinned install for production. 0.2 ships a digest-pinned Docker image.
- **`fqe-bypass` label is not bound to the head SHA.** Once applied, it persists across subsequent pushes. 0.2 ships TTL-bound bypass labels (`fqe-bypass-24h`, `-48h`, `-72h`) with head-SHA binding.
- **Allowlist is read at the PR's BASE commit**, not at default-branch HEAD. 0.2 fetches allowlist from `refs/heads/main` at workflow-run time.
- **Receipts default to 90-day GitHub artifact retention.** Check Run output persists indefinitely (with a 65KB cap). 0.2 ships an opt-in post-merge `audits/<sha>/` archiver.
- **Bypass-tally JSONL writes to the protected branch from a `workflow_run` event.** Fork PRs cannot bypass (intentional, read-only token). Concurrency stress-tested to ~5 simultaneous merges. 0.2 moves state to an external KV.

Also:

- **No JSON Schema for `.fqe.yml`** yet. VSCode autocomplete pending.
- **No published Docker image**. Workflows clone-and-install (about 20s overhead per CI run). Once published, swap `container: ghcr.io/booyajones/fqe:0.1`.
- **No `create-fqe-runner` scaffold**. Plugin authoring is doc-driven only.

### Migration notes

This is v0.1.0. No prior version to migrate from.
