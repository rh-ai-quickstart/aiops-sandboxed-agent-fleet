#!/bin/bash
# Workshop container entrypoint: prepare the lab environment, then start the web server.
# Works in single-instance mode (namespaces openshell + demo) and lab mode (userNN-openshell +
# userNN-demo): every namespace comes from the env the chart sets (docs/CONTRACT.md).
APP_DIR="${LAB_CWD:-/app}"
export HOME="${HOME:-/tmp}"

# --- namespaces ---------------------------------------------------------------------------
SA_NS_FILE=/var/run/secrets/kubernetes.io/serviceaccount/namespace
: "${OPENSHELL_NAMESPACE:=${OPENSHELL_NS:-$(cat "$SA_NS_FILE" 2>/dev/null || echo openshell)}}"
: "${DEMO_NAMESPACE:=${DEMO_NS:-demo}}"
export OPENSHELL_NAMESPACE DEMO_NAMESPACE
export OPENSHELL_NS="$OPENSHELL_NAMESPACE" DEMO_NS="$DEMO_NAMESPACE"
export REGISTRY_HOST="${REGISTRY_HOST:-registry.${OPENSHELL_NAMESPACE}.svc.cluster.local}"

# --- OpenShell gateway (plaintext, in-cluster) ------------------------------------------------
# The CLI reads OPENSHELL_GATEWAY_ENDPOINT as a gateway URL override; register the gateway under
# a name instead and keep that variable out of the CLI's way (server.mjs moves it to
# OPENSHELL_GRPC_TARGET for the gRPC client).
GW_URL="${OPENSHELL_GATEWAY_ENDPOINT_URL:-http://openshell.${OPENSHELL_NAMESPACE}.svc.cluster.local:8080}"
# `gateway add` stores the registration first, then probes the gateway (up to ~90s when it is
# unreachable, e.g. while the gateway pod is still starting) — bound it so startup never stalls.
(
  unset OPENSHELL_GATEWAY_ENDPOINT
  openshell gateway remove cluster >/dev/null 2>&1 || true
  timeout 15 openshell gateway add "$GW_URL" --local --name cluster >/dev/null 2>&1 || true
  openshell gateway select cluster >/dev/null 2>&1 \
    || echo "entrypoint: could not register gateway $GW_URL (continuing)" >&2
)

# --- registry host in sandbox policies ----------------------------------------------------------
# Policies ship the FQDN registry.openshell.svc.cluster.local (the 0.1.6 proxy does not resolve
# single-label hosts); point them at this instance's registry when the namespace differs.
if [[ "$OPENSHELL_NAMESPACE" != "openshell" ]]; then
  while IFS= read -r -d '' f; do
    sed -i "s/registry\.openshell\.svc/registry.${OPENSHELL_NAMESPACE}.svc/g" "$f" 2>/dev/null \
      || echo "entrypoint: cannot rewrite registry host in $f (read-only?)" >&2
  done < <(
    find "$APP_DIR/policies" -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.json' \) -print0 2>/dev/null
    find "$APP_DIR/manifests/openclaw" -type f -name 'policy.yaml' -print0 2>/dev/null
  )
fi

# --- compatibility path used by the lessons + fleet scripts ------------------------------------
ln -sfn "$APP_DIR" "$HOME/nemoclaw-openshift-launchable" 2>/dev/null || true

# --- inference (OpenShell 0.1.6 provider profile) ----------------------------------------------
# The sandbox never receives the real key: a provider of type maas-openai (created from this
# profile by configure_inference or by the inference lesson) is attached to the sandbox, which
# sees a placeholder that the supervisor swaps for the key on egress to this endpoint only.
export NEMOCLAW_INFERENCE_PROVIDER="${NEMOCLAW_INFERENCE_PROVIDER:-default}"
export NEMOCLAW_INFERENCE_PROFILE_ID="${NEMOCLAW_INFERENCE_PROFILE_ID:-maas-openai}"
export NEMOCLAW_INFERENCE_PROFILE="${NEMOCLAW_INFERENCE_PROFILE:-$HOME/.config/nemoclaw/inference-profile.yaml}"
bash "$APP_DIR/lab/render-inference-profile.sh" "$NEMOCLAW_INFERENCE_PROFILE" >/dev/null 2>&1 \
  || echo "entrypoint: NEMOCLAW_INFERENCE_BASE_URL not set — inference profile not rendered" >&2

# --- .env for the lessons (`set -a; . .env`) ---------------------------------------------------
export OPENCLAW_GATEWAY_PASSWORD="${OPENCLAW_GATEWAY_PASSWORD:-openclaw}"
(
  umask 077
  cat > "$APP_DIR/.env" <<EOF
OPENCLAW_GATEWAY_PASSWORD=${OPENCLAW_GATEWAY_PASSWORD}
NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL:-}
NEMOCLAW_MODEL=${NEMOCLAW_MODEL:-}
NEMOCLAW_API_KEY=${NEMOCLAW_API_KEY:-}
NEMOCLAW_INFERENCE_PROVIDER=${NEMOCLAW_INFERENCE_PROVIDER}
EOF
) 2>/dev/null || echo "entrypoint: cannot write $APP_DIR/.env" >&2

cd "$APP_DIR" || exit 1
exec node server.mjs
