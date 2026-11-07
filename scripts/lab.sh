#!/usr/bin/env bash
# lab.sh — N attendees on ONE OpenShift cluster (multi-tenant lab mode, docs/CONTRACT.md).
#
# Usage:
#   lab.sh shared                          once per cluster: observability stack, agent-sandbox,
#                                          Grafana (anonymous Viewer), image prepull DaemonSet
#   lab.sh up <N> [--from M] [-P n]        shared (idempotent) + attendees userM..userN (M=1, n=5)
#   lab.sh user <user>                     (re)deploy one attendee, e.g. user07
#   lab.sh fleet [users...] [-P n]         pre-provision the agent fleet (default: every attendee, n=3)
#   lab.sh wake [users...] [-P n]          after a cluster stop/start: start every Stopped/Error
#                                          sandbox again (fleet + attendees' own), n=5
#   lab.sh status                          one line per attendee (workshop, gateway, sandboxes, demo)
#   lab.sh urls [--csv]                    attendee URLs + OpenClaw passwords (--csv: .lab/attendees.csv)
#   lab.sh down <N|all|users...> [--from M] [--shared]
#                                          remove attendees (sandboxes, release, both namespaces);
#                                          --shared also removes lab-shared and the Grafana release
#
# Per attendee <u>: namespaces <u>-openshell (gateway, registry, workshop, sandboxes) and
# <u>-demo (demo app), Helm release `nemoclaw` in <u>-openshell (chart/values-lab.yaml).
# Every step is idempotent; one attendee failing does not stop the others (logs in
# .lab/logs/<u>.log). Secrets are generated only when absent, so URLs / passwords survive
# re-runs.
#
# Env (.env is loaded): WORKSHOP_IMAGE, OPENCLAW_SANDBOX_IMAGE, GHCR_TOKEN / GHCR_USER,
#   NEMOCLAW_INFERENCE_BASE_URL / NEMOCLAW_MODEL / NEMOCLAW_API_KEY / NEMOCLAW_INFERENCE_PROVIDER,
#   LAB_INFERENCE_KEYS_FILE (CSV: user,key[,model[,base_url]] — per-attendee keys),
#   LAB_INFERENCE_UPDATE=1 (re-push key/endpoint to existing gateways; default keeps them),
#   LAB_USER_PREFIX (user), LAB_NODE_SELECTOR (node-role.kubernetes.io/lab= ; "none" = off;
#   ignored when no node carries the label), LAB_SKIP_OBSERVABILITY=1, LAB_DEMO_APP=false,
#   LAB_HELM_TIMEOUT (15m), LAB_PREPULL_TIMEOUT (1800s), MONITORING_GRAFANA_PASSWORD,
#   CLUSTER_APPS_DOMAIN, AGENT_SANDBOX_MIGRATE=1.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"

usage() { sed -n '2,/^set -euo/p' "$SELF" | sed '$d' | sed 's/^# \{0,1\}//'; }
case "${1:-}" in ""|-h|--help|help) usage; exit 0 ;; esac

# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
[[ "${LAB_ENV_LOADED:-}" == 1 ]] || { load_env; export LAB_ENV_LOADED=1; }
for c in oc helm yq jq openssl envsubst; do require_cmd "$c"; done

LAB_DIR="$REPO_ROOT/.lab"
LOG_DIR="$LAB_DIR/logs"
STATUS_DIR="$LAB_DIR/status"
PREFIX="${LAB_USER_PREFIX:-user}"
MON_NS="${MONITORING_NAMESPACE:-monitoring}"
SHARED_NS="lab-shared"
NODE_SELECTOR="${LAB_NODE_SELECTOR-node-role.kubernetes.io/lab=}"
HELM_TIMEOUT="${LAB_HELM_TIMEOUT:-15m}"
mkdir -p "$LOG_DIR" "$STATUS_DIR"

user_name() { printf '%s%02d' "$PREFIX" "$((10#$1))"; }
os_ns()     { printf '%s-openshell' "$1"; }
demo_ns()   { printf '%s-demo' "$1"; }

# Resolve the apps domain once, in the CURRENT shell (exported for the per-user children).
init_domain() {
  if [[ -z "${LAB_DOMAIN:-}" ]]; then LAB_DOMAIN="$(cluster_apps_domain)"; fi
  export LAB_DOMAIN
}

# Attendee namespaces that exist on the cluster (sorted user ids).
existing_users() {
  oc get ns -l lab.nemoclaw.io/managed=true,lab.nemoclaw.io/role=openshell \
    -o jsonpath='{range .items[*]}{.metadata.labels.lab\.nemoclaw\.io/user}{"\n"}{end}' 2>/dev/null | sort
}

# Node selector for lab pods ("key=value"), empty when disabled or no node carries it.
lab_node_selector() {
  [[ -n "$NODE_SELECTOR" && "$NODE_SELECTOR" != none ]] || return 0
  if [[ -n "$(oc get nodes -l "$NODE_SELECTOR" -o name 2>/dev/null | head -1)" ]]; then
    printf '%s\n' "$NODE_SELECTOR"
  fi
}

ensure_deps() {
  if [[ "${LAB_DEPS_READY:-}" != 1 ]]; then
    log "Building Helm chart dependencies"
    helm_deps_build
    export LAB_DEPS_READY=1
  fi
}

# --------------------------------------------------------------------------------------
# shared (once per cluster)
# --------------------------------------------------------------------------------------
prepull_images() {
  local ver
  local -a tgz=("$REPO_ROOT"/chart/charts/openshell/charts/helm-chart-*.tgz)
  ver="$(tar -xOzf "${tgz[0]}" helm-chart/Chart.yaml | yq -r '.appVersion')"
  {
    sandbox_image
    printf '%s\n' "ghcr.io/nvidia/openshell/gateway:${ver}" \
                  "ghcr.io/nvidia/openshell/supervisor:${ver}" \
                  "ghcr.io/nvidia/openshell/sandbox:${ver}"
    workshop_image
    yq -r '.registry.image' "$REPO_ROOT/chart/charts/openshell/values.yaml"
    yq -r '.eventExporter.image' "$REPO_ROOT/chart/charts/workshop/values.yaml"
    yq -r '.spec.template.spec.containers[]?.image' \
      "$REPO_ROOT/manifests/demo-app/loadgen.yaml" "$REPO_ROOT/manifests/demo-app/payments.yaml"
  } | grep -vE '^(null|---)?$' | sort -u
}

shared() {
  local sel images_json gvalues
  "$HERE/00-preflight.sh"
  init_domain
  if [[ "${LAB_SKIP_OBSERVABILITY:-0}" != 1 ]]; then
    "$HERE/15-observability.sh"
  fi
  ensure_agent_sandbox
  ensure_deps

  # Grafana: one shared instance, anonymous Viewer for attendees; admin password generated
  # once and kept in .lab/ (never on a command line).
  ensure_namespace "$MON_NS" app.kubernetes.io/part-of=nemoclaw
  gvalues="$LAB_DIR/grafana-admin.yaml"
  if [[ ! -s "$gvalues" ]]; then
    (umask 077
     MONITORING_GRAFANA_PASSWORD="${MONITORING_GRAFANA_PASSWORD:-$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)}" \
       yq -n '.grafana.adminPassword = strenv(MONITORING_GRAFANA_PASSWORD)' > "$gvalues")
  fi
  log "Installing shared Grafana (namespace ${MON_NS}, anonymous Viewer)"
  helm upgrade --install nemoclaw-monitoring "$REPO_ROOT/chart/charts/monitoring/" -n "$MON_NS" \
    -f "$REPO_ROOT/chart/charts/monitoring/values.yaml" \
    -f "$REPO_ROOT/chart/charts/monitoring/values-lab.yaml" \
    -f "$gvalues" \
    --set global.clusterAppsDomain="$LAB_DOMAIN" \
    --wait --timeout 10m

  # Image prepull on every lab node (the sandbox image is several GB).
  ensure_namespace "$SHARED_NS" app.kubernetes.io/part-of=nemoclaw lab.nemoclaw.io/managed=true lab.nemoclaw.io/role=shared
  ensure_ghcr_pull_secret "$SHARED_NS"
  images_json="$(prepull_images | jq -R . | jq -sc .)"
  local -a ds_args=(--set-json "images=${images_json}")
  sel="$(lab_node_selector)"
  if [[ -n "$sel" ]]; then
    ds_args+=(--set-json "nodeSelector=$(jq -cn --arg k "${sel%%=*}" --arg v "${sel#*=}" '{($k): $v}')")
  else
    warn "No node matches LAB_NODE_SELECTOR='${NODE_SELECTOR}' — lab pods may land on any schedulable node (incl. control plane)."
  fi
  [[ -n "${GHCR_TOKEN:-}" ]] && ds_args+=(--set "imagePullSecrets[0].name=ghcr-pull")
  log "Prepulling $(jq length <<<"$images_json") images on every lab node (DaemonSet ${SHARED_NS}/lab-prepull)"
  helm upgrade --install lab-shared "$REPO_ROOT/deploy/lab-shared/" -n "$SHARED_NS" "${ds_args[@]}"
  oc -n "$SHARED_NS" rollout status ds/lab-prepull --timeout="${LAB_PREPULL_TIMEOUT:-1800}s" \
    || warn "Prepull not complete yet (oc -n ${SHARED_NS} get pods -o wide) — attendees can still be deployed."
  log "Shared lab components ready."
}

# --------------------------------------------------------------------------------------
# one attendee
# --------------------------------------------------------------------------------------
ensure_access_secret() {
  local ns="$1"
  oc -n "$ns" get secret workshop-access >/dev/null 2>&1 && return 0
  (
    LAB_ACCESS_TOKEN="$(openssl rand -hex 24)"
    OPENCLAW_GATEWAY_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)"
    export LAB_ACCESS_TOKEN OPENCLAW_GATEWAY_PASSWORD
    apply_secret_from_env "$ns" workshop-access LAB_ACCESS_TOKEN OPENCLAW_GATEWAY_PASSWORD
  )
}

# Creates/updates Secret lab-inference; prints a hash of its content (empty = no inference).
ensure_inference_secret() {
  local u="$1" ns="$2" base="${NEMOCLAW_INFERENCE_BASE_URL:-}" model="${NEMOCLAW_MODEL:-}" key="${NEMOCLAW_API_KEY:-}"
  local line _u k m b
  if [[ -n "${LAB_INFERENCE_KEYS_FILE:-}" && -f "${LAB_INFERENCE_KEYS_FILE}" ]]; then
    line="$(awk -F, -v u="$u" '$1 == u { print; exit }' "$LAB_INFERENCE_KEYS_FILE")"
    if [[ -n "$line" ]]; then
      IFS=, read -r _u k m b <<<"$line"
      key="$k"; [[ -n "$m" ]] && model="$m"; [[ -n "$b" ]] && base="$b"
    fi
  fi
  if [[ -z "$base" || -z "$model" || -z "$key" ]]; then
    oc -n "$ns" delete secret lab-inference --ignore-not-found >/dev/null
    return 0
  fi
  (
    NEMOCLAW_INFERENCE_BASE_URL="$base" NEMOCLAW_MODEL="$model" NEMOCLAW_API_KEY="$key"
    export NEMOCLAW_INFERENCE_BASE_URL NEMOCLAW_MODEL NEMOCLAW_API_KEY
    apply_secret_from_env "$ns" lab-inference NEMOCLAW_INFERENCE_BASE_URL NEMOCLAW_MODEL NEMOCLAW_API_KEY
  )
  printf '%s\n%s\n%s\n' "$base" "$model" "$key" | openssl dgst -sha256 | awk '{print substr($NF, 1, 16)}'
}

deploy_user() {
  local u="$1" ns dns sel inference_hash
  [[ "$u" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "invalid attendee id '$u'"
  ns="$(os_ns "$u")"; dns="$(demo_ns "$u")"
  init_domain
  oc get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1 || die "agent-sandbox is not installed — run: $0 shared"
  ensure_deps

  log "[$u] namespaces ${ns} + ${dns}"
  local -a ann=()
  sel="$(lab_node_selector)"
  [[ -n "$sel" ]] && ann=(--annotate "openshift.io/node-selector=${sel}")
  ensure_namespace "$ns" app.kubernetes.io/part-of=nemoclaw lab.nemoclaw.io/managed=true \
    "lab.nemoclaw.io/user=$u" lab.nemoclaw.io/role=openshell "${ann[@]}"
  ensure_namespace "$dns" app.kubernetes.io/part-of=nemoclaw lab.nemoclaw.io/managed=true \
    "lab.nemoclaw.io/user=$u" lab.nemoclaw.io/role=demo "${ann[@]}"
  guard_foreign_openshell "$ns"

  log "[$u] secrets"
  ensure_access_secret "$ns"
  ensure_ghcr_pull_secret "$ns"
  inference_hash="$(ensure_inference_secret "$u" "$ns")"
  local -a args=()
  if [[ -n "$inference_hash" ]]; then
    args+=(--set-string "workshop.podAnnotations.lab\.nemoclaw\.io/inference-hash=${inference_hash}")
  else
    warn "[$u] no inference settings — agents start without a model"
    args+=(--set workshop.inference.existingSecret=)
  fi
  local -a image_args
  mapfile -t image_args < <(nemoclaw_image_args)

  log "[$u] helm upgrade --install nemoclaw (namespace ${ns})"
  helm upgrade --install nemoclaw "$REPO_ROOT/chart/" -n "$ns" \
    -f "$REPO_ROOT/chart/values.yaml" -f "$REPO_ROOT/chart/values-lab.yaml" \
    --set global.clusterAppsDomain="$LAB_DOMAIN" \
    --set global.demoNamespace="$dns" \
    --set global.monitoringNamespace="$MON_NS" \
    --set global.lab.user="$u" \
    --set-string workshop.inference.provider="${NEMOCLAW_INFERENCE_PROVIDER:-default}" \
    "${args[@]}" "${image_args[@]}" \
    --wait --timeout "$HELM_TIMEOUT"

  if [[ -n "$inference_hash" ]]; then
    # A re-run keeps an existing provider: updating it would strand the attendees' running agents
    # on a stale placeholder. LAB_INFERENCE_UPDATE=1 pushes a new key/endpoint on purpose.
    INFERENCE_UPDATE="${LAB_INFERENCE_UPDATE:-0}" configure_inference "$ns" \
      || warn "[$u] inference provider setup failed (re-run: $0 user $u)"
  fi
  if [[ "${LAB_DEMO_APP:-true}" == "true" ]]; then
    log "[$u] demo app -> ${dns}"
    oc -n "$dns" apply -k "$REPO_ROOT/manifests/demo-app/" >/dev/null
  fi
  log "[$u] ready: https://workshop-${ns}.${LAB_DOMAIN}/"
}

# Run "<self> <cmd> <user>" for each user, n in parallel, one log per user; never aborts
# on a single failure. Prints one result line per user and returns 1 if any failed.
fan_out() {
  local par="$1" cmd="$2"; shift 2
  (($#)) || { warn "no attendees selected"; return 0; }
  export LAB_DEPS_READY LAB_DOMAIN
  log "${cmd}: $# attendee(s), ${par} in parallel — logs in ${LOG_DIR}/<user>.log"
  # shellcheck disable=SC2016  # the inner script is single-quoted on purpose (args via $1..$5)
  printf '%s\n' "$@" | xargs -P "$par" -I{} bash -c '
      self="$1" cmd="$2" u="$3" logs="$4" st="$5"
      if "$self" "$cmd" "$u" >"$logs/$u.log" 2>&1; then rc=0; else rc=$?; fi
      echo "$rc" > "$st/$u.$cmd"
      if [ "$rc" -eq 0 ]; then echo "  ✓ $u"; else echo "  ✗ $u (exit $rc, see $logs/$u.log)"; fi
    ' _ "$SELF" "$cmd" {} "$LOG_DIR" "$STATUS_DIR" || true
  local u failed=0
  for u in "$@"; do
    [[ "$(cat "$STATUS_DIR/$u.$cmd" 2>/dev/null || echo 1)" == 0 ]] || failed=$((failed + 1))
  done
  if ((failed)); then warn "${cmd}: ${failed}/$# attendee(s) failed"; return 1; fi
  log "${cmd}: all $# attendee(s) OK"
}

# --------------------------------------------------------------------------------------
# fleet / status / urls / down
# --------------------------------------------------------------------------------------
fleet_user() {
  local u="$1" ns; ns="$(os_ns "$u")"
  oc -n "$ns" rollout status deploy/workshop --timeout=300s >/dev/null
  oc -n "$ns" exec deploy/workshop -c workshop -- bash /app/scripts/fleet.sh up /app/fleet.txt
}

# A cluster stop/start leaves every sandbox Stopped (or Error): start them again — fleet agents
# and the attendees' own (shifty, lab). Sandboxes that still fail to start are recreated by
# `lab.sh fleet` (fleet roles) or by re-running the lesson (attendee sandboxes).
wake_user() {
  local u="$1" ns; ns="$(os_ns "$u")"
  oc -n "$ns" rollout status deploy/workshop --timeout=300s >/dev/null
  # shellcheck disable=SC2016  # expanded inside the workshop pod
  oc -n "$ns" exec deploy/workshop -c workshop -- bash -c '
    for s in $(openshell sandbox list 2>/dev/null | awk "NR>1 && (\$NF==\"Stopped\" || \$NF==\"Error\") {print \$1}"); do
      if openshell sandbox start "$s" >/dev/null 2>&1; then echo "started $s"; else echo "could not start $s"; fi
    done'
}

ready_of() {   # ready_of <ns> <kind/name>  -> "ready/desired" or "-"
  oc -n "$1" get "$2" -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' 2>/dev/null \
    | sed 's#^/#0/#' || echo "-"
}

status() {
  local u ns dns ws gw sb sbr demo
  init_domain
  printf '%-10s %-9s %-8s %-10s %-6s %s\n' USER WORKSHOP GATEWAY SANDBOXES DEMO URL
  while read -r u; do
    [[ -n "$u" ]] || continue
    ns="$(os_ns "$u")"; dns="$(demo_ns "$u")"
    ws="$(ready_of "$ns" deploy/workshop)"; ws="${ws:--}"
    gw="$(ready_of "$ns" statefulset/openshell)"; gw="${gw:--}"
    sb="$(oc -n "$ns" get sandboxes.agents.x-k8s.io --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    sbr="$(oc -n "$ns" get sandboxes.agents.x-k8s.io \
      -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
      | grep -c True || true)"
    if [[ "$(ready_of "$dns" deploy/shop-app)" == 1/1 && "$(ready_of "$dns" deploy/payments)" == 1/1 ]]; then
      demo=ok
    elif oc -n "$dns" get deploy shop-app >/dev/null 2>&1; then demo=down; else demo=none; fi
    printf '%-10s %-9s %-8s %-10s %-6s %s\n' "$u" "$ws" "$gw" "${sbr}/${sb}" "$demo" "https://workshop-${ns}.${LAB_DOMAIN}/"
  done < <(existing_users)
}

urls() {
  local csv=false u ns token pw out domain
  [[ "${1:-}" == "--csv" ]] && csv=true
  init_domain; domain="$LAB_DOMAIN"
  out="$LAB_DIR/attendees.csv"
  {
    echo "user,workshop_url,openclaw_ui_url,openclaw_password,grafana_url"
    while read -r u; do
      [[ -n "$u" ]] || continue
      ns="$(os_ns "$u")"
      token="$(oc -n "$ns" get secret workshop-access -o jsonpath='{.data.LAB_ACCESS_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)"
      pw="$(oc -n "$ns" get secret workshop-access -o jsonpath='{.data.OPENCLAW_GATEWAY_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || true)"
      echo "${u},https://workshop-${ns}.${domain}/?token=${token},https://openclaw-ui-${ns}.${domain}/,${pw},https://grafana-${MON_NS}.${domain}/grafana/"
    done < <(existing_users)
  } > "$out.tmp"
  chmod 600 "$out.tmp"
  if [[ "$csv" == true ]]; then
    mv "$out.tmp" "$out"; log "Wrote $out (contains access tokens — share per attendee only)"
  else
    column -s, -t < "$out.tmp" 2>/dev/null || cat "$out.tmp"; rm -f "$out.tmp"
  fi
}

teardown_user() {
  local u="$1" ns dns; ns="$(os_ns "$u")"; dns="$(demo_ns "$u")"
  log "[$u] deleting sandboxes, release and namespaces"
  if oc -n "$ns" get deploy workshop >/dev/null 2>&1; then
    oc -n "$ns" exec deploy/workshop -c workshop -- sh -c \
      'OPENSHELL_GATEWAY_ENDPOINT="${OPENSHELL_GATEWAY_ENDPOINT_URL:-$OPENSHELL_GATEWAY_ENDPOINT}" openshell sandbox delete --all' \
      >/dev/null 2>&1 || true
  fi
  oc -n "$ns" delete sandboxes.agents.x-k8s.io --all --wait=false >/dev/null 2>&1 || true
  helm uninstall nemoclaw -n "$ns" --wait --timeout 5m >/dev/null 2>&1 || true
  oc delete namespace "$ns" "$dns" --ignore-not-found --wait=false >/dev/null
}

down() {
  local from=1 shared=false n="" u
  local -a users=()
  while (($#)); do
    case "$1" in
      --from) from="$2"; shift 2 ;;
      --shared) shared=true; shift ;;
      all) mapfile -t users < <(existing_users); shift ;;
      [0-9]*) n="$1"; shift ;;
      *) users+=("$1"); shift ;;
    esac
  done
  if [[ -n "$n" ]]; then
    for ((i = 10#$from; i <= 10#$n; i++)); do users+=("$(user_name "$i")"); done
  fi
  for u in "${users[@]}"; do teardown_user "$u"; done
  for u in "${users[@]}"; do
    oc wait --for=delete "namespace/$(os_ns "$u")" "namespace/$(demo_ns "$u")" --timeout=600s >/dev/null 2>&1 \
      || warn "[$u] namespaces still terminating (oc get ns | grep $u)"
  done
  if [[ "$shared" == true ]]; then
    log "Removing shared lab components (${SHARED_NS}, Grafana in ${MON_NS})"
    helm uninstall lab-shared -n "$SHARED_NS" >/dev/null 2>&1 || true
    oc delete namespace "$SHARED_NS" --ignore-not-found >/dev/null
    helm uninstall nemoclaw-monitoring -n "$MON_NS" >/dev/null 2>&1 || true
    oc delete namespace "$MON_NS" --ignore-not-found >/dev/null
    rm -f "$LAB_DIR/grafana-admin.yaml"
    warn "Observability stack and agent-sandbox are left in place (scripts/cleanup.sh removes the observability releases)."
  fi
  log "down: done"
}

# --------------------------------------------------------------------------------------
cmd="$1"; shift
case "$cmd" in
  shared) shared ;;
  up)
    n="${1:?usage: lab.sh up <N> [--from M] [-P n]}"; shift
    from=1; par=5
    while (($#)); do
      case "$1" in
        --from) from="$2"; shift 2 ;;
        -P) par="$2"; shift 2 ;;
        *) die "unknown option '$1'" ;;
      esac
    done
    [[ "$n" =~ ^[0-9]+$ && "$from" =~ ^[0-9]+$ ]] || die "N and M must be numbers"
    shared
    users=()
    for ((i = 10#$from; i <= 10#$n; i++)); do users+=("$(user_name "$i")"); done
    fan_out "$par" user "${users[@]}"
    ;;
  user) deploy_user "${1:?usage: lab.sh user <user>}" ;;
  fleet)
    par=3; users=()
    while (($#)); do
      case "$1" in
        -P) par="$2"; shift 2 ;;
        *) users+=("$1"); shift ;;
      esac
    done
    ((${#users[@]})) || mapfile -t users < <(existing_users)
    fan_out "$par" fleet-user "${users[@]}"
    ;;
  fleet-user) fleet_user "${1:?}" ;;
  wake)
    par=5; users=()
    while (($#)); do
      case "$1" in
        -P) par="$2"; shift 2 ;;
        *) users+=("$1"); shift ;;
      esac
    done
    ((${#users[@]})) || mapfile -t users < <(existing_users)
    fan_out "$par" wake-user "${users[@]}"
    ;;
  wake-user) wake_user "${1:?}" ;;
  status) status ;;
  urls) urls "$@" ;;
  down) (($#)) || die "usage: lab.sh down <N|all|users...> [--from M] [--shared]"; down "$@" ;;
  *) usage; exit 1 ;;
esac
