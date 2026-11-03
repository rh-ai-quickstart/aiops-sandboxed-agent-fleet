#!/usr/bin/env bash
# Phase 00 — preflight. Validates that the user is logged into an OpenShift cluster
# and has the required CLI tools. No GPU needed — inference is remote.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
load_env

log "Preflight checks"

# --- required CLI tools ---
require_cmd oc
require_cmd helm
require_cmd yq
require_cmd jq
require_cmd envsubst

# --- OpenShift login ---
if oc whoami >/dev/null 2>&1; then
  log "Logged in to OpenShift as $(oc whoami) on $(oc whoami --show-server 2>/dev/null || echo '(unknown server)')"
else
  die "Not logged in to OpenShift — run 'oc login' first."
fi

# --- oc / helm versions (informational) ---
OC_VER="$(oc version --client 2>/dev/null | head -1 || echo unknown)"
HELM_VER="$(helm version --short 2>/dev/null || echo unknown)"
log "oc: ${OC_VER}  |  helm: ${HELM_VER}"

# Helm < 3.18 drops null overrides that an intermediate subchart declares for its own
# dependency (umbrella -> openshell wrapper -> upstream), which used to leave the gateway with a
# hardcoded UID/fsGroup 1000 that restricted-v2 rejects. chart/values.yaml now sets those nulls
# at the umbrella level, which works on older Helm too (validated with 3.17), so only warn.
HELM_MIN="3.18.0"
HELM_SEMVER="$(helm version --template '{{.Version}}' 2>/dev/null | sed 's/^v//; s/[-+].*//')"
if [[ "$(printf '%s\n' "$HELM_MIN" "$HELM_SEMVER" | sort -V | head -1)" != "$HELM_MIN" ]]; then
  warn "helm ${HELM_SEMVER:-unknown} < ${HELM_MIN}: supported (the gateway's securityContext nulls are set at the umbrella level), but ${HELM_MIN}+ is recommended."
fi

# --- inference endpoint (OPTIONAL) ---
# If set, the gateway gets an OpenShell provider (profile maas-openai) and the agents a model;
# if not, everything deploys UNCONFIGURED and a model can be added later. Warn, never fail.
# Lab mode can carry one key per attendee in LAB_INFERENCE_KEYS_FILE instead of NEMOCLAW_API_KEY.
_key_source="${NEMOCLAW_API_KEY:-}"
[[ -z "$_key_source" && -n "${LAB_INFERENCE_KEYS_FILE:-}" && -s "${LAB_INFERENCE_KEYS_FILE}" ]] && _key_source="file"
if [[ -z "${NEMOCLAW_INFERENCE_BASE_URL:-}" || -z "${NEMOCLAW_MODEL:-}" || -z "$_key_source" ]]; then
  warn "NEMOCLAW_INFERENCE_BASE_URL / NEMOCLAW_MODEL / NEMOCLAW_API_KEY not all set — agents deploy without a model."
elif [[ ! "${NEMOCLAW_INFERENCE_BASE_URL}" =~ ^[Hh][Tt][Tt][Pp][Ss]?:// ]]; then
  die "NEMOCLAW_INFERENCE_BASE_URL must start with http:// or https:// (got '${NEMOCLAW_INFERENCE_BASE_URL}')."
fi

log "Preflight complete."
