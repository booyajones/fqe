# Signing the receipt (v0.16): tamper-evident to tamper-proof

The content hash makes a receipt tamper-EVIDENT: you can tell it changed. It does not prove
WHO produced it, because anyone can recompute the hash over edited content. For a receipt an
auditor (SOC2, PCI) is meant to trust, the receipt must be SIGNED. fqe supports two layers.

## Layer 1: HMAC-SHA256 (deterministic, offline, built in)

`fqe receipt sign` computes an HMAC over the receipt's canonical field tuple
(`schema_version`, `fqe_version`, `commit_sha`, `content_hash`, `inputs_hash`, `verdict`, `bypass`) using
`FQE_SIGNING_KEY`. Because `content_hash` already covers every file at the commit and `bypass` carries the override authority, the signature
authenticates the whole claim: at this commit, over this content, with these inputs, the verdict
was X. `fqe receipt verify` recomputes the HMAC and fails closed (exit 2) on any tamper, a wrong
key, or a missing signature under `--require-signature`.

```yaml
# in the gate workflow, after fqe run writes the receipt:
- name: sign the receipt
  env:
    FQE_SIGNING_KEY: ${{ secrets.FQE_SIGNING_KEY }}   # a CI secret, never in the repo
  run: node cli/bin/fqe.js receipt sign out/QA-RESULT.yml

# anywhere downstream (audit, second job):
- name: verify the receipt
  env:
    FQE_SIGNING_KEY: ${{ secrets.FQE_SIGNING_KEY }}
  run: node cli/bin/fqe.js receipt verify out/QA-RESULT.yml --require-signature
```

What HMAC gives you: a forger now needs the key, not just the public content. What it does NOT
give you: non-repudiation. HMAC is symmetric, so anyone holding the key can sign. That is why
there is a second layer.

## Layer 2: Sigstore keyless (CI-only, identity-bound, the audit-grade answer)

Sigstore signs with the GitHub Actions OIDC identity (no long-lived key) and records the
signature in a public transparency log. The signer is bound to the workflow identity and cannot
later deny it. This runs in CI, where the OIDC token exists.

```yaml
permissions:
  id-token: write   # required for keyless OIDC signing
  contents: read
steps:
  - uses: sigstore/gh-action-sigstore-python@v3
    with:
      inputs: out/QA-RESULT.yml
  # produces out/QA-RESULT.yml.sigstore (bundle) committed alongside the receipt
```

Verify the bundle with `cosign verify-blob` or the sigstore CLI, asserting the expected workflow
identity and OIDC issuer. The HMAC layer stays as the deterministic, offline check; Sigstore is
the non-repudiation layer an external auditor verifies independently.

## Honest scope

- **What the signature covers:** the canonical tuple `schema_version`, `fqe_version`,
  `commit_sha`, `content_hash`, `inputs_hash`, `verdict`, and the `bypass` block. Because
  `content_hash` covers every file at the commit and `bypass` records the human override
  authority, tampering any of these (including injecting or altering a bypass) breaks the
  signature.
- **What it does NOT cover:** `verdict_reasons` and the `runners` evidence array. These are
  human-readable, reproducible by re-running fqe, and are left out so the signed payload stays
  stable across a YAML round-trip. Do not treat HMAC verification as proof those fields are
  untouched; re-run fqe, or use the Sigstore bundle over the full file, to attest them.
- HMAC proves key possession (the CI runner held `FQE_SIGNING_KEY`). It is a real step up from a
  bare hash, and it is fully deterministic and testable offline.
- Sigstore keyless is the SOC2 / PCI-grade answer: identity-bound, non-repudiable, logged. It
  needs CI (the OIDC token) and so is wired as a workflow step, not the offline default.
- The receipt is now tamper-proof against anyone who lacks the key; with Sigstore it is also
  attributable to a specific CI identity.
