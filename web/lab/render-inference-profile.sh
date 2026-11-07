#!/bin/bash
# Render the workshop's OpenShell provider profile (id maas-openai) for the real inference
# endpoint in NEMOCLAW_INFERENCE_BASE_URL and print the path of the rendered file.
#
#   render-inference-profile.sh [output-path]
#
# Template: manifests/openclaw/inference-profile.yaml.tmpl (envsubst '${INFERENCE_HOST}
# ${INFERENCE_PORT}', the same rendering scripts/lib/common.sh configure_inference does).
# Falls back to an equivalent built-in profile when the template is not in the image.
# Exit 1 (nothing written) when NEMOCLAW_INFERENCE_BASE_URL is unset or unparsable.
set -euo pipefail

out="${1:-${NEMOCLAW_INFERENCE_PROFILE:-${HOME:-/tmp}/.config/nemoclaw/inference-profile.yaml}}"
tmpl="${NEMOCLAW_INFERENCE_PROFILE_TEMPLATE:-${LAB_CWD:-/app}/manifests/openclaw/inference-profile.yaml.tmpl}"
url="${NEMOCLAW_INFERENCE_BASE_URL:-}"
[[ -n "$url" && "$url" == *://* ]] || exit 1

scheme="${url%%://*}"
rest="${url#*://}"
hostport="${rest%%/*}"
hostport="${hostport##*@}"
INFERENCE_HOST="${hostport%%:*}"
INFERENCE_PORT=""
[[ "$hostport" == *:* ]] && INFERENCE_PORT="${hostport##*:}"
if [[ -z "$INFERENCE_PORT" ]]; then
  if [[ "$scheme" == "https" ]]; then INFERENCE_PORT=443; else INFERENCE_PORT=80; fi
fi
[[ -n "$INFERENCE_HOST" && "$INFERENCE_PORT" =~ ^[0-9]+$ ]] || exit 1
export INFERENCE_HOST INFERENCE_PORT

mkdir -p "$(dirname "$out")"
if [[ -f "$tmpl" ]]; then
  if command -v envsubst >/dev/null 2>&1; then
    # shellcheck disable=SC2016  # literal variable list for envsubst
    envsubst '${INFERENCE_HOST} ${INFERENCE_PORT}' <"$tmpl" >"$out.tmp"
  else
    sed -e "s|\${INFERENCE_HOST}|${INFERENCE_HOST}|g" -e "s|\${INFERENCE_PORT}|${INFERENCE_PORT}|g" "$tmpl" >"$out.tmp"
  fi
else
  cat >"$out.tmp" <<EOF
id: maas-openai
display_name: OpenAI-compatible inference (workshop)
description: OpenAI-compatible endpoint configured from NEMOCLAW_INFERENCE_BASE_URL
category: inference
inference_capable: true
credentials:
  - name: api_key
    description: API key for the inference endpoint
    env_vars: [OPENAI_API_KEY]
    required: true
    auth_style: bearer
    header_name: authorization
discovery:
  credentials: [api_key]
endpoints:
  - host: ${INFERENCE_HOST}
    port: ${INFERENCE_PORT}
    protocol: rest
    access: read-write
    enforcement: enforce
binaries: [/usr/local/bin/node, /usr/bin/node, /usr/local/bin/curl, /usr/bin/curl]
EOF
fi
mv "$out.tmp" "$out"
echo "$out"
