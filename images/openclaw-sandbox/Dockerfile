# Custom OpenClaw sandbox image = the community sandbox image + a newer Node.js + OpenClaw.
#
# Why: the DuckDuckGo web-search plugin (key-free) and current OpenClaw releases need
# Node >= 22.19, newer than the community base's nodesource build. `n` installs the
# requested Node into /usr/local/bin (first on PATH); everything else (iproute2, the
# sandbox runtime, the agent CLIs) is inherited unchanged.
#
# Build + publish via .github/workflows/build-openclaw-sandbox.yml (pushes to
# ghcr.io/<owner>/openclaw-sandbox:<version>), then pin the chart value
# openshell.upstream.sandbox.image.{repository,tag} / OPENCLAW_SANDBOX_IMAGE to it.
# Local build: podman build --build-arg OPENCLAW_VERSION=2026.8.2 images/openclaw-sandbox
#
# BASE is pinned by manifest-list digest (the community image only publishes `latest`).
# Refresh it with: oc image info ghcr.io/nvidia/openshell-community/sandboxes/openclaw:latest
ARG BASE=ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550
FROM ${BASE}

ARG OPENCLAW_VERSION=2026.8.2
ARG NODE_VERSION=22.22.3

USER root
RUN npm install -g n \
 && n "${NODE_VERSION}" \
 && hash -r \
 && npm install -g "openclaw@${OPENCLAW_VERSION}" \
 && node --version \
 && openclaw --version
USER sandbox
