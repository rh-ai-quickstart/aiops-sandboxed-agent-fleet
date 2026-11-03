# Workshop image: Next.js site + terminal bridge + oc/kubectl + openshell CLI.
# Build from the repo root:  podman build -f web/Dockerfile -t <registry>/<image>:<tag> .
ARG NODE_MAJOR=24

# ---------------------------------------------------------------------------------------------
# builder: install deps (node-pty compiles its native addon here), build, then drop devDeps
# ---------------------------------------------------------------------------------------------
FROM docker.io/library/node:${NODE_MAJOR}-bookworm AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---------------------------------------------------------------------------------------------
# runtime: same Node major + Debian release as the builder, so node-pty's addon (built above
# against bookworm's glibc and this Node ABI) loads as-is — no compiler toolchain at runtime.
# ---------------------------------------------------------------------------------------------
FROM docker.io/library/node:${NODE_MAJOR}-bookworm-slim

ARG TARGETARCH=amd64
# oc/kubectl from the OpenShift 4.22 stable channel (checksum-verified against the mirror).
ARG OC_CHANNEL=stable-4.22
# OpenShell CLI, pinned to the gateway version (release asset verified against the release's
# published sha256 list). The build fails if download or verification fails.
ARG OPENSHELL_VERSION=v0.1.6

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl jq gettext-base openssh-client procps nano vim-tiny \
 && rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# oc + kubectl
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) oc_tgz=openshift-client-linux.tar.gz ;; \
      arm64) oc_tgz=openshift-client-linux-arm64.tar.gz ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="https://mirror.openshift.com/pub/openshift-v4/clients/ocp/${OC_CHANNEL}"; \
    tmp="$(mktemp -d)"; cd "$tmp"; \
    curl -fsSLo "$oc_tgz" "$base/$oc_tgz"; \
    curl -fsSLo sha256sum.txt "$base/sha256sum.txt"; \
    expected="$(awk -v n="$oc_tgz" '$2 == n || $2 == "*" n { print $1; exit }' sha256sum.txt)"; \
    test -n "$expected"; \
    echo "${expected}  ${oc_tgz}" | sha256sum -c -; \
    tar -xzf "$oc_tgz" -C /usr/local/bin oc kubectl; \
    chmod 0755 /usr/local/bin/oc /usr/local/bin/kubectl; \
    cd /; rm -rf "$tmp"; \
    oc version --client

# openshell CLI (static musl build)
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) triple=x86_64-unknown-linux-musl ;; \
      arm64) triple=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    asset="openshell-${triple}.tar.gz"; \
    base="https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_VERSION}"; \
    tmp="$(mktemp -d)"; cd "$tmp"; \
    curl -fsSLo "$asset" "$base/$asset"; \
    curl -fsSLo checksums.txt "$base/openshell-checksums-sha256.txt"; \
    expected="$(awk -v n="$asset" '$2 == n || $2 == "*" n { print $1; exit }' checksums.txt)"; \
    test -n "$expected"; \
    echo "${expected}  ${asset}" | sha256sum -c -; \
    mkdir x; tar -xzf "$asset" -C x; \
    bin="$(find x -type f -name openshell | head -n1)"; \
    test -n "$bin"; \
    install -m 0755 "$bin" /usr/local/bin/openshell; \
    cd /; rm -rf "$tmp"; \
    openshell --version

WORKDIR /app

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
# next.config.ts is build-time only: rewrites (incl. the /grafana proxy) are compiled into
# .next/routes-manifest.json, so the runtime needs neither the TS config nor typescript.
COPY --from=builder /app/package.json /app/server.mjs ./
COPY --from=builder /app/proto ./proto
COPY --from=builder /app/lab ./lab

# Manifests, policies and scripts used by the API routes, the lessons and fleet.sh.
COPY manifests/demo-app /app/manifests/demo-app
COPY manifests/openclaw /app/manifests/openclaw
COPY policies /app/policies
COPY scripts/fleet.sh scripts/lib /app/scripts/
COPY scripts/lib /app/scripts/lib
COPY fleet.txt /app/fleet.txt

COPY web/entrypoint.sh /app/entrypoint.sh
# OpenShift runs the container with a random UID in group 0: the entrypoint writes /app/.env and
# rewrites the registry host in the policy files when the namespace is not `openshell`.
RUN chmod 0755 /app/entrypoint.sh /app/lab/render-inference-profile.sh \
 && chgrp -R 0 /app/policies /app/manifests/openclaw \
 && chmod -R g+w /app/policies /app/manifests/openclaw \
 && chmod g+w /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LAB_CWD=/app \
    HOME=/tmp

USER 1001
EXPOSE 3000

ENTRYPOINT ["bash", "/app/entrypoint.sh"]
