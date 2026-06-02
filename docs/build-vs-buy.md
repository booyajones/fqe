# Why fqe and not Codecov + Stryker + Sigstore + branch protection?

This is the first question a skeptical staff engineer asks, and it is the right question.
An external multi-LLM review (2026-06-02) named it the single most likely objection and the
one this project had not answered in writing. Here is the honest answer.

## Short version

fqe does not replace any of those tools. It composes them.

If your team is happy with a row of independent green checkmarks (one from Codecov, one from
Stryker, one from your test runner) and you do not need a single money-aware block/allow
decision over all of them, you do not need fqe. Adopt the mature tools and stop there.

fqe earns its place only when you want ONE deterministic, fail-closed verdict across
heterogeneous runners, with policy that understands money paths, emitted as a single required
check. Nothing off-the-shelf does that specific job. Everything else fqe touches, an
off-the-shelf tool does better, and fqe should defer to it.

## What the off-the-shelf stack already does well (use it)

| Need | Best off-the-shelf tool | fqe's stance |
|---|---|---|
| Coverage percentage + ratchet | Codecov / coveralls | Consume their report. fqe does not reimplement coverage measurement. |
| Mutation score | Stryker / mutmut / cargo-mutants | fqe runs mutation on the diff and reads the report. Stryker is the engine. |
| Cryptographic non-repudiation | Sigstore keyless (Fulcio + Rekor) | This is the signing layer fqe recommends. fqe's HMAC default is within-pipeline tamper-evidence only, not audit-grade. See [receipt-signing.md](recipes/receipt-signing.md). |
| Build provenance | SLSA provenance attestations | Out of fqe's scope. Adopt it directly. |
| Required checks + merge rules | GitHub rulesets / branch protection | fqe is one check those rules require. Rulesets own the enforcement and the bypass actors. |

For each of these, the honest recommendation is: adopt the mature, multi-maintainer tool. It
is battle-tested and it is not a bus-factor-of-one. fqe should sit on top, not in place.

## The one job nothing off-the-shelf does

Coverage percentage is an input. Mutation score is an input. A signature is an input. None of
them is a decision about whether a specific change to a money path is safe to merge.

That decision is policy, and on a payments path it is not generic:

- An adversarial attack-success rate on a money or state-changing runner must clear a Wilson
  95% confidence bar of 0.01, recomputed server-side from raw counts so a runner cannot submit
  a flattering interval. Codecov has no concept of this.
- A money repo must prove an idempotency invariant (a repeated request pays once) with a
  runner that actually executed real tests, not a no-op that claims a label.
- A green must not be mintable by a suite that ran nothing. Coverage-liveness reconciles the
  executed count against the framework's own collected count and fails closed when they do not
  agree.
- Money-looking code shipped with no money policy is flagged, and under the payments profile it
  blocks.

fqe's value is composing those signals into one verdict that fails closed on any ambiguity, and
binding that verdict to the exact commit and inputs in a tamper-evident, signable receipt. The
12 verdict passes are strictly additive: a pass may only add a FLAG or FAIL, never clear one.
That property is now enforced by a source guard, not just convention (see
[architecture.md](architecture.md)).

That is the whole thesis. If you do not need a money-aware composite verdict, the thesis does
not apply to you.

## The honest sequencing for a small team

1. Adopt Codecov (or equivalent) and Stryker first. Get per-tool signal flowing.
2. Turn on Sigstore keyless signing in CI. That is your non-repudiation, today, off-the-shelf.
3. Add fqe as a NON-BLOCKING status check that reads those outputs. Run the shadow scorecard
   (see [shadow-scorecard.md](recipes/shadow-scorecard.md)) for 30 days and measure the
   false-red rate and the added wall-time on a real repo.
4. Only promote fqe to a required gate, and only on a money path, after that data shows a
   false-red rate at or near zero. Until then it is an experiment, not infrastructure.

## What this means for adoption

fqe is a thin policy and verdict layer. It is not a test runner, not a coverage engine, and
not a certificate authority. Anywhere it overlaps a mature tool, prefer the mature tool and let
fqe read its output. The part fqe asks you to trust it for is small and specific: turning a set
of runner results into one money-aware, fail-closed, signed decision.

Judge it on that narrow claim. For the rest of the stack, buy, do not build.
