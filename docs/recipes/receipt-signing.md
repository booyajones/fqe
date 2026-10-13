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

Current HMAC signatures cover commit and content hashes, inputs, verdict, bypass authority, diff scope, workflow attempt, timestamps, runner results, required classes, reasons and evidence paths. Legacy signatures remain verifiable for their original field list; verification explicitly reports present fields the old signature never covered. Do not trust those fields without a fresh verification.

The commit identifies the tracked tree. The content hash binds changed working-tree bytes; it is not a hash of every receipt field. The signing key stays only in the trusted publisher. HMAC proves possession of that shared key; Sigstore is the separate identity-bound signing layer. Neither proves the business assertions were adequate or that a live payment path was tested.
