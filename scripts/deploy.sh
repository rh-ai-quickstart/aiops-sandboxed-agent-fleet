#!/usr/bin/env bash
# Deploy the NemoClaw workshop stack onto an existing OpenShift cluster — single-instance
# mode: one gateway + workshop in $OPENSHELL_NAMESPACE (default openshell), the demo app in
# $DEMO_NAMESPACE (default demo), Grafana in $MONITORING_NAMESPACE (default monitoring).
# For N attendees on one cluster use scripts/lab.sh instead.
#
# Optional env (see .env.example): WORKSHOP_IMAGE, OPENCLAW_SANDBOX_IMAGE, GHCR_TOKEN,
# NEMOCLAW_INFERENCE_BASE_URL / NEMOCLAW_MODEL / NEMOCLAW_API_KEY, SKIP_OBSERVABILITY=true,
# DEPLOY_DEMO_APP=false, DEPLOY_FLEET=false, PROVISION_AGENT=true, AGENT_SANDBOX_MIGRATE=1.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
load_env

"$HERE/00-preflight.sh"

OPENSHELL_NS="${OPENSHELL_NAMESPACE:-openshell}"
DEMO_NS="${DEMO_NAMESPACE:-demo}"
MON_NS="${MONITORING_NAMESPACE:-monitoring}"

guard_foreign_openshell "$OPENSHELL_NS"
DOMAIN="$(cluster_apps_domain)"

# Observability stack (operators + UWM + RustFS + Tempo + Loki + OTEL). Idempotent.
if [[ "${SKIP_OBSERVABILITY:-false}" != "true" ]]; then
  "$HERE/15-observability.sh"
fi

# Namespaces are created out-of-band (NOT via Helm — helm uninstall would delete them).
for ns in "$OPENSHELL_NS" "$DEMO_NS" "$MON_NS"; do
  ensure_namespace "$ns" app.kubernetes.io/part-of=nemoclaw
done

ensure_ghcr_pull_secret "$OPENSHELL_NS"

# Cluster-scoped Sandbox API (agent-sandbox v1.0.x, agents.x-k8s.io/v1beta1) — guarded.
ensure_agent_sandbox

log "Building Helm chart dependencies"
helm_deps_build

# Inference settings live in a Secret (envFrom) so the key never appears in Helm values,
# the release history or a command line.
inference_args=()
if [[ -n "${NEMOCLAW_INFERENCE_BASE_URL:-}" && -n "${NEMOCLAW_MODEL:-}" && -n "${NEMOCLAW_API_KEY:-}" ]]; then
  apply_secret_from_env "$OPENSHELL_NS" workshop-inference \
    NEMOCLAW_INFERENCE_BASE_URL NEMOCLAW_MODEL NEMOCLAW_API_KEY
  inference_args=(--set workshop.inference.existingSecret=workshop-inference)
else
  warn "Inference not configured (NEMOCLAW_INFERENCE_BASE_URL / NEMOCLAW_MODEL / NEMOCLAW_API_KEY) — agents deploy without a model."
fi
mapfile -t image_args < <(nemoclaw_image_args)

log "Installing openshell + workshop (release nemoclaw, namespace ${OPENSHELL_NS})"
helm upgrade --install nemoclaw "$REPO_ROOT/chart/" \
  -n "$OPENSHELL_NS" \
  -f "$REPO_ROOT/chart/values.yaml" \
  --set global.clusterAppsDomain="$DOMAIN" \
  --set global.demoNamespace="$DEMO_NS" \
  --set global.monitoringNamespace="$MON_NS" \
  --set-string workshop.inference.provider="${NEMOCLAW_INFERENCE_PROVIDER:-default}" \
  --set-string workshop.openclaw.gatewayPassword="${OPENCLAW_GATEWAY_PASSWORD:-openclaw}" \
  "${inference_args[@]}" "${image_args[@]}" \
  --wait --timeout 15m

# Gateway-side inference provider (provider profile + provider, OpenShell 0.1.x).
configure_inference "$OPENSHELL_NS" \
  || warn "Inference provider setup failed — re-run: source scripts/lib/common.sh && configure_inference $OPENSHELL_NS"

log "Installing monitoring (Grafana + event-exporter, namespace ${MON_NS})"
helm upgrade --install nemoclaw-monitoring "$REPO_ROOT/chart/charts/monitoring/" \
  -n "$MON_NS" \
  --set global.clusterAppsDomain="$DOMAIN" \
  --set-string grafana.adminPassword="${MONITORING_GRAFANA_PASSWORD:-openclaw}" \
  --wait --timeout 10m

# Demo app via Kustomize (NOT Helm-managed — the Incident Lab applies/deletes it). The
# kustomization is namespace-agnostic: the namespace comes from -n.
if [[ "${DEPLOY_DEMO_APP:-true}" == "true" ]]; then
  oc -n "$DEMO_NS" apply -k "$REPO_ROOT/manifests/demo-app/"
fi

# Bring up the SRE agent fleet from inside the workshop pod (openshell CLI, fleet.sh,
# fleet.txt and the fleet-role manifests are baked into the image).
if [[ "${DEPLOY_FLEET:-true}" == "true" ]]; then
  log "Bringing up the agent fleet (via workshop pod)"
  oc -n "$OPENSHELL_NS" exec deploy/workshop -c workshop -- \
    bash /app/scripts/fleet.sh up /app/fleet.txt \
    && log "Agent fleet is up" \
    || warn "Fleet setup failed — re-run: oc -n $OPENSHELL_NS exec deploy/workshop -c workshop -- bash /app/scripts/fleet.sh up /app/fleet.txt"
fi

if [[ "${PROVISION_AGENT:-false}" == "true" ]]; then
  OPENSHELL_NAMESPACE="$OPENSHELL_NS" "$HERE/45-openclaw.sh"
fi

log "Workshop:  https://workshop-${OPENSHELL_NS}.${DOMAIN}/"
log "Grafana:   https://grafana-${MON_NS}.${DOMAIN}/grafana"
log "Console:   https://console-openshift-console.${DOMAIN}/"
