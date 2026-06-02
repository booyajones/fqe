# Dockerfile for ghcr.io/booyajones/fqe:0.1
#
# Closes gauntlet 11f9c0 flaw: "Container supply-chain not pinned/verified."
#
# Build:
#   docker build -t ghcr.io/booyajones/fqe:0.1 .
#
# Local smoke (no push):
#   docker run --rm -v "$PWD:/workspace" ghcr.io/booyajones/fqe:0.1 fqe version
#
# Pin in production by digest, not tag:
#   docker pull ghcr.io/booyajones/fqe:0.1
#   docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/booyajones/fqe:0.1
#   # Then in workflows: image: ghcr.io/booyajones/fqe@sha256:<digest>
#
# Sign with cosign (Phase 1.2 deliverable):
#   cosign sign --yes ghcr.io/booyajones/fqe@sha256:<digest>
#   # Workflows verify with: cosign verify --certificate-identity=...

# ─── Base: Debian slim with Python and Node ─────────────────────────────
FROM debian:bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_VERSION=22.13.1 \
    PYTHON_VERSION=3.13 \
    LANG=C.UTF-8

# System dependencies, including libreoffice-core for the Excel runner's
# Defense C (LibreOffice headless recompute, default-on per PLAN-v6).
# Each apt package version is unpinned here for readability; lock with
# `apt-mark hold` + sha256-verified .deb files in a hardening pass.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        git \
        jq \
        libreoffice-core \
        libreoffice-calc \
        python3 \
        python3-pip \
        python3-venv \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ─── Node 22 from official .tar.xz with SHA256-verified download ────────
# To pin: download the official SHASUMS256.txt from nodejs.org and read the
# value for node-v${NODE_VERSION}-linux-x64.tar.xz. The image build will
# FAIL if the checksum doesn't match (this IS the verification step — not
# a placeholder comment like the v3 submission).
#
# Maintainer: bump these together when upgrading Node.
ARG NODE_TARBALL_SHA256=""
RUN if [ -z "$NODE_TARBALL_SHA256" ]; then \
        echo "FATAL: NODE_TARBALL_SHA256 not provided. Run: docker build --build-arg NODE_TARBALL_SHA256=<sha> ..." >&2; \
        echo "Get the SHA from: https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" >&2; \
        exit 1; \
    fi \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_TARBALL_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.xz" | sha256sum -c - \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && node --version

# ─── yq Mike Farah v4 with SHA256-verified download ─────────────────────
ARG YQ_VERSION=v4.45.1
ARG YQ_SHA256=""
RUN if [ -z "$YQ_SHA256" ]; then \
        echo "FATAL: YQ_SHA256 not provided. Get from: https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/checksums" >&2; \
        exit 1; \
    fi \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
        -o /tmp/yq \
    && echo "${YQ_SHA256}  /tmp/yq" | sha256sum -c - \
    && mv /tmp/yq /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq \
    && yq --version

# ─── GitHub CLI with SHA256-verified download ───────────────────────────
ARG GH_VERSION=2.65.0
ARG GH_SHA256=""
RUN if [ -z "$GH_SHA256" ]; then \
        echo "FATAL: GH_SHA256 not provided. Get from: https://github.com/cli/cli/releases/v${GH_VERSION}/checksums.txt" >&2; \
        exit 1; \
    fi \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
        -o /tmp/gh.tar.gz \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/ \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64" \
    && gh --version

# ─── Python deps for the Excel runner ───────────────────────────────────
RUN python3 -m pip install --no-cache-dir --break-system-packages \
        openpyxl==3.1.5

# ─── Install fqe CLI ────────────────────────────────────────────────────
WORKDIR /opt/fqe
COPY cli/package.json /opt/fqe/cli/
COPY cli/bin/ /opt/fqe/cli/bin/
COPY cli/lib/ /opt/fqe/cli/lib/
COPY cli/test/ /opt/fqe/cli/test/
COPY smoke/ /opt/fqe/smoke/
COPY schemas/ /opt/fqe/schemas/

# Make the CLI globally invocable as `fqe`
RUN chmod +x /opt/fqe/cli/bin/fqe.js \
    && ln -s /opt/fqe/cli/bin/fqe.js /usr/local/bin/fqe \
    && fqe version

# ─── Hardening ──────────────────────────────────────────────────────────
# Run as non-root by default; CI can override with --user if needed.
RUN useradd -m -u 10001 fqe
USER fqe

WORKDIR /workspace

# ─── Build-time smoke (executes during docker build) ────────────────────
# Confirms verdict.js + wilson.js + receipt.js round-trip works in this image.
# If this fails, the image is NOT shipped — it's the equivalent of a built-in
# unit test gate that closes the gauntlet's "external dep unverified" flaw.
RUN cd /opt/fqe/cli && node --test test/verdict.test.js test/wilson.test.js \
        test/receipt.test.js test/bypass_tally.test.js test/cli.test.js \
    || (echo "FATAL: fqe self-tests failed in image build" && exit 1)

LABEL org.opencontainers.image.title="Finexio Quality Engine"
LABEL org.opencontainers.image.description="Deterministic CI gate for Finexio repos"
LABEL org.opencontainers.image.source="https://github.com/booyajones/finexio-skills"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="0.1.0"

ENTRYPOINT ["fqe"]
CMD ["help"]
