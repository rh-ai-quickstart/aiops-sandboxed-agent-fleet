#!/usr/bin/env bash
# Tear down the single-instance NemoClaw workshop stack — Helm releases, demo app,
# observability charts, orphaned cluster-scoped RBAC, and namespaces. Does NOT remove the
# agent-sandbox CRD/controller or the observability operators (shared cluster resources).
# For lab mode use: scripts/lab.sh down all [--shared]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
load_env

OPENSHELL_NS="${OPENSHELL_NAMESPACE:-openshell}"
DEMO_NS="${DEMO_NAMESPACE:-demo}"
MON_NS="${MONITORING_NAMESPACE:-monitoring}"

log "Step 1/5: Deleting sandboxes (the gateway owns their pods + workspace PVCs)"
oc -n "$OPENSHELL_NS" exec deploy/workshop -c workshop -- sh -c \
  'OPENSHELL_GATEWAY_ENDPOINT="${OPENSHELL_GATEWAY_ENDPOINT_URL:-$OPENSHELL_GATEWAY_ENDPOINT}" openshell sandbox delete --all' \
  >/dev/null 2>&1 && log "  sandboxes deleted" || warn "  could not delete sandboxes through the gateway (already gone?)"

log "Step 2/5: Removing Helm releases (openshell + workshop, monitoring)"
helm uninstall nemoclaw -n "$OPENSHELL_NS" --wait 2>/dev/null && log "  nemoclaw uninstalled" || warn "  nemoclaw release not found (already removed?)"
helm uninstall nemoclaw-monitoring -n "$MON_NS" 2>/dev/null && log "  nemoclaw-monitoring uninstalled" || warn "  nemoclaw-monitoring release not found (already removed?)"

log "Step 3/5: Removing the demo app"
oc -n "$DEMO_NS" delete -k "$REPO_ROOT/manifests/demo-app/" --ignore-not-found >/dev/null 2>&1 && log "  demo app removed" || warn "  demo app not found"

log "Step 4/5: Removing observability Helm releases (OTEL, Tempo, Loki, object storage)"
for rel_ns in otel:observability-hub tempo:observability-hub loki:openshift-logging object-storage:observability-hub; do
  rel="${rel_ns%%:*}"; ns="${rel_ns##*:}"
  helm uninstall "$rel" -n "$ns" 2>/dev/null && log "  $rel uninstalled from $ns" || warn "  $rel release not found in $ns"
done

log "  Cleaning leftover cluster-scoped RBAC of this instance (Helm normally removes it)"
oc delete clusterrolebinding "${OPENSHELL_NS}-workshop" "openshell-node-reader-${OPENSHELL_NS}" \
  "${MON_NS}-monitoring-view" "${MON_NS}-monitoring-reader-view" "${MON_NS}-grafana-monitoring-view" \
  "${MON_NS}-monitoring-reader-loki-tenant" "${MON_NS}-grafana-loki-tenant" --ignore-not-found >/dev/null 2>&1 || true
oc delete clusterrole "${OPENSHELL_NS}-workshop" "${OPENSHELL_NS}-telemetry-reader" \
  "openshell-node-reader-${OPENSHELL_NS}" --ignore-not-found >/dev/null 2>&1 || true

log "Step 5/5: Removing namespaces"
for ns in "$OPENSHELL_NS" "$MON_NS" "$DEMO_NS" observability-hub; do
  oc delete namespace "$ns" --ignore-not-found >/dev/null 2>&1 && log "  $ns deleted" || warn "  $ns not found"
done

warn "openshift-monitoring and openshift-logging are shared platform namespaces — not removed."
warn "The agent-sandbox CRD/controller and the observability operators are not removed. See README for manual steps."
log "Cleanup complete."
