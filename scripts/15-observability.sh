#!/usr/bin/env bash
# Phase 15 — deploy the OpenShift observability stack.
# Installs operators (Loki, Tempo, CLO, OTEL, COO), enables User Workload Monitoring,
# and deploys RustFS object storage + TempoStack + LokiStack + ClusterLogForwarder + OTEL Collector.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
load_env

log "Phase 15 — OpenShift observability stack"

# --- required CLI tools for operator management ---
require_cmd envsubst
require_cmd yq
require_cmd jq

# --- install operators (idempotent — skips if already installed) ---
log "Installing observability operators"
declare -A OPERATOR_NS=(
  [observability]=openshift-cluster-observability-operator
  [otel]=openshift-opentelemetry-operator
  [tempo]=openshift-tempo-operator
  [logging]=openshift-logging
  [loki]=openshift-operators-redhat
)
# Detect the logging/loki channel once — both operators share the same release stream.
# The loki-operator PackageManifest may advertise a stale defaultChannel (e.g. "alpha"),
# so we derive the channel from cluster-logging which tracks the active release.
export CHANNEL
CHANNEL=$(oc get packagemanifest cluster-logging -o jsonpath='{.status.defaultChannel}' 2>/dev/null) || true
if [[ -z "$CHANNEL" ]]; then
  warn "Could not detect channel for cluster-logging — falling back to 'stable-6.6'"
  CHANNEL="stable-6.6"
fi
log "  logging/loki channel=$CHANNEL"

for op in observability otel tempo logging loki; do
  log "  ▶ $op → ${OPERATOR_NS[$op]}"
  "$HERE/lib/operator-manager.sh" -i "$op" -n "${OPERATOR_NS[$op]}"
done

# --- enable User Workload Monitoring ---
log "Enabling User Workload Monitoring"
"$HERE/lib/enable-uwm.sh"

# --- create namespace for Tempo / OTEL / object storage ---
oc create namespace observability-hub --dry-run=client -o yaml | oc apply -f -

# --- deploy RustFS (S3 object storage for Loki + Tempo) ---
log "Deploying RustFS object storage"
helm upgrade --install object-storage "$REPO_ROOT/deploy/observability/object-storage/" \
  -n observability-hub \
  --wait --timeout 5m

# --- deploy TempoStack ---
log "Deploying TempoStack"
helm upgrade --install tempo "$REPO_ROOT/deploy/observability/tempo/" \
  -n observability-hub \
  --wait --timeout 10m

# --- deploy LokiStack + ClusterLogForwarder ---
log "Deploying LokiStack + ClusterLogForwarder"
helm upgrade --install loki "$REPO_ROOT/deploy/observability/loki/" \
  -n openshift-logging \
  --wait --timeout 10m

# helm --wait only covers the CRs; the operators start the actual pods afterwards.
# Queries hang until the ingesters are up, so wait before agents start querying.
log "Waiting for TempoStack + LokiStack to become Ready"
oc wait tempostack --all -n observability-hub --for=condition=Ready --timeout=10m
oc wait lokistack --all -n openshift-logging --for=condition=Ready --timeout=10m

# --- deploy OTEL Collector ---
log "Deploying OTEL Collector"
helm upgrade --install otel "$REPO_ROOT/deploy/observability/otel-collector/" \
  -n observability-hub \
  --wait --timeout 5m

log "Phase 15 complete — observability stack deployed."
