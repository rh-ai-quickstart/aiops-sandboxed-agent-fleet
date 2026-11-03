#!/usr/bin/env bash
# Shared helpers + .env loading. Source this at the top of every phase script.
# Used by deploy.sh (single-instance mode) and lab.sh (multi-tenant lab mode), so the
# cluster-scoped prerequisites (agent-sandbox) and the per-gateway inference setup live in
# exactly one place.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- ANSI colors (used by operator-manager.sh and enable-uwm.sh) ---
# shellcheck disable=SC2034  # consumed by the scripts that source this file
RED='\033[0;31m'
# shellcheck disable=SC2034
GREEN='\033[0;32m'
# shellcheck disable=SC2034
YELLOW='\033[1;33m'
# shellcheck disable=SC2034
BLUE='\033[0;34m'
# shellcheck disable=SC2034
NC='\033[0m'

DEBUG="${DEBUG:-false}"

log()   { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
debug() { [[ "${DEBUG:-false}" == "true" ]] && echo -e "$@" || true; }

# Load .env if present (don't fail if missing — preflight reports what's needed).
load_env() {
  if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a; # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"; set +a
    log "Loaded $REPO_ROOT/.env"
  else
    warn "No .env found — copy .env.example to .env and fill it in."
  fi
}

require_var() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "Required variable '$name' is unset (set it in .env)."
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' not found in PATH."
}

check_tool_exists() {
  command -v "$1" >/dev/null 2>&1 || { echo -e "${RED}❌ $1 is required but not installed${NC}"; exit 1; }
}

check_file() {
  local file="$1" desc="${2:-File}"
  [[ -f "$file" ]] || { echo -e "${RED}❌ ${desc} not found: ${file}${NC}"; exit 1; }
}

check_openshift_login() {
  oc whoami >/dev/null 2>&1 || { echo -e "${RED}❌ Not logged in to OpenShift cluster${NC}"; echo -e "${YELLOW}   Please run: oc login${NC}"; exit 1; }
}

check_openshift_prerequisites() {
  debug "${BLUE}🔍 Checking prerequisites...${NC}"
  check_tool_exists "oc"
  check_openshift_login
  debug "${GREEN}✅ Prerequisites check passed${NC}"
}

# =========================================================================================
# Cluster helpers
# =========================================================================================

# The cluster's apps domain (Route hostnames). CLUSTER_APPS_DOMAIN overrides detection.
cluster_apps_domain() {
  local d="${CLUSTER_APPS_DOMAIN:-}"
  [[ -n "$d" ]] || d="$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}' 2>/dev/null || true)"
  [[ -n "$d" ]] || die "Could not detect the cluster apps domain — set CLUSTER_APPS_DOMAIN."
  printf '%s\n' "$d"
}

# Workshop image: WORKSHOP_IMAGE overrides the chart default (chart/values.yaml).
workshop_image() {
  if [[ -n "${WORKSHOP_IMAGE:-}" ]]; then
    printf '%s\n' "$WORKSHOP_IMAGE"
  else
    yq -r '.workshop.image' "$REPO_ROOT/chart/values.yaml"
  fi
}

# Default sandbox image of the OpenShell chart (OPENCLAW_SANDBOX_IMAGE overrides).
sandbox_image() {
  if [[ -n "${OPENCLAW_SANDBOX_IMAGE:-}" ]]; then
    printf '%s\n' "$OPENCLAW_SANDBOX_IMAGE"
  else
    local f="$REPO_ROOT/chart/charts/openshell/values.yaml" repo tag digest
    repo="$(yq -r '.upstream.sandbox.image.repository' "$f")"
    tag="$(yq -r '.upstream.sandbox.image.tag // "latest"' "$f")"
    digest="$(yq -r '.upstream.sandbox.image.digest // ""' "$f")"
    if [[ -n "$digest" ]]; then printf '%s@%s\n' "$repo" "$digest"; else printf '%s:%s\n' "$repo" "$tag"; fi
  fi
}

# Helm --set arguments shared by every `nemoclaw` release (single and lab mode). Prints one
# argument per line; read with: mapfile -t args < <(nemoclaw_image_args)
nemoclaw_image_args() {
  if [[ -n "${WORKSHOP_IMAGE:-}" ]]; then
    printf '%s\n' --set "workshop.image=${WORKSHOP_IMAGE}"
  fi
  if [[ -n "${OPENCLAW_SANDBOX_IMAGE:-}" ]]; then
    local img="$OPENCLAW_SANDBOX_IMAGE" repo tag
    printf '%s\n' --set-string "workshop.sandboxImage=${img}"
    if [[ "$img" == *@* ]]; then
      printf '%s\n' --set "openshell.upstream.sandbox.image.repository=${img%@*}" \
                    --set-string "openshell.upstream.sandbox.image.digest=${img#*@}"
    else
      repo="${img%:*}"; tag="${img##*:}"
      if [[ "$repo" == "$img" || "$tag" == */* ]]; then repo="$img"; tag="latest"; fi
      printf '%s\n' --set "openshell.upstream.sandbox.image.repository=${repo}" \
                    --set-string "openshell.upstream.sandbox.image.tag=${tag}"
    fi
  fi
  if [[ -n "${GHCR_TOKEN:-}" ]]; then
    printf '%s\n' --set "openshell.upstream.server.sandboxImagePullSecrets[0].name=ghcr-pull"
  fi
}

# Create (or update) a Namespace with labels/annotations without touching other metadata.
#   ensure_namespace <name> [key=value label...] [--annotate key=value...]
ensure_namespace() {
  local ns="$1"; shift
  local -a labels=() annotations=()
  local mode=label a
  for a in "$@"; do
    if [[ "$a" == --annotate ]]; then mode=annotate; continue; fi
    if [[ "$mode" == label ]]; then labels+=("$a"); else annotations+=("$a"); fi
  done
  if ! oc get namespace "$ns" >/dev/null 2>&1; then
    oc create namespace "$ns" >/dev/null
  fi
  if ((${#labels[@]})); then oc label namespace "$ns" --overwrite "${labels[@]}" >/dev/null; fi
  if ((${#annotations[@]})); then oc annotate namespace "$ns" --overwrite "${annotations[@]}" >/dev/null; fi
}

# Apply an Opaque Secret whose values come from environment variables. The values are read
# by jq from its environment (env[...]), so they never appear on any command line.
#   apply_secret_from_env <namespace> <secret-name> VAR [VAR...]
apply_secret_from_env() {
  local ns="$1" name="$2"; shift 2
  jq -n --arg ns "$ns" --arg name "$name" '
    { apiVersion: "v1", kind: "Secret", type: "Opaque",
      metadata: { name: $name, namespace: $ns,
                  labels: { "app.kubernetes.io/part-of": "nemoclaw" } },
      stringData: (reduce $ARGS.positional[] as $k ({}; .[$k] = (env[$k] // ""))) }' \
    --args "$@" | oc apply -f - >/dev/null
}

# Optional ghcr.io pull secret: anonymous pulls of the multi-GB sandbox image get throttled.
# The chart references it through openshell.upstream.server.sandboxImagePullSecrets
# (see nemoclaw_image_args).
ensure_ghcr_pull_secret() {
  local ns="$1"
  [[ -n "${GHCR_TOKEN:-}" ]] || return 0
  local auth
  auth="$(printf '%s:%s' "${GHCR_USER:-oauth2}" "$GHCR_TOKEN" | base64 | tr -d '\n')"
  GHCR_DOCKERCONFIG="$(printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' "$auth")" \
    jq -n --arg ns "$ns" '
      { apiVersion: "v1", kind: "Secret", type: "kubernetes.io/dockerconfigjson",
        metadata: { name: "ghcr-pull", namespace: $ns,
                    labels: { "app.kubernetes.io/part-of": "nemoclaw" } },
        stringData: { ".dockerconfigjson": env.GHCR_DOCKERCONFIG } }' | oc apply -f - >/dev/null
}

# Build the chart dependencies (helm dependency build is NOT recursive). The Grafana chart
# lives in the grafana-community repository, which `dependency build` needs registered.
helm_deps_build() {
  helm repo add grafana-community https://grafana-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update grafana-community >/dev/null 2>&1 || true
  helm dependency build "$REPO_ROOT/chart/charts/openshell/" >/dev/null
  helm dependency build "$REPO_ROOT/chart/charts/monitoring/" >/dev/null
  helm dependency build "$REPO_ROOT/chart/" >/dev/null
}

# Refuse to install over an OpenShell gateway this repo does not own (e.g. the one RHOAI
# ships): the chart would collide on the StatefulSet, Service and ServiceAccount names.
guard_foreign_openshell() {
  local ns="$1" owner
  if oc -n "$ns" get statefulset openshell >/dev/null 2>&1; then
    owner="$(oc -n "$ns" get statefulset openshell -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}' 2>/dev/null || true)"
    [[ "$owner" == "nemoclaw" ]] \
      || die "Namespace '$ns' already runs an OpenShell gateway not managed by this repo (Helm release '${owner:-none}'). Set OPENSHELL_NAMESPACE to another namespace."
  fi
}

# =========================================================================================
# agent-sandbox (kubernetes-sigs) — cluster-scoped prerequisite of the OpenShell gateway
# =========================================================================================
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v1.0.3}"
AGENT_SANDBOX_CRD="sandboxes.agents.x-k8s.io"

_ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

# Ensure a Sandbox API that OpenShell 0.1.x understands (agents.x-k8s.io/v1beta1):
#   - CRD owned by OLM (e.g. the RHOAI agent-sandbox operator): reuse it if it serves
#     v1beta1, otherwise stop — never fight an operator over its CRD.
#   - CRD from an older manual install serving only v1alpha1 (agent-sandbox <= v0.4.x, the
#     0.0.x gateway's API): stop with migration steps, or perform them when
#     AGENT_SANDBOX_MIGRATE=1 (deletes ALL Sandbox objects cluster-wide).
#   - CRD from a manual install that already serves v1beta1 at >= the pinned version: reuse.
#   - otherwise: apply agent-sandbox ${AGENT_SANDBOX_VERSION} (CRD + controller).
ensure_agent_sandbox() {
  local url="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox.yaml"
  local crd_json served olm ctrl_img ctrl_ver
  if crd_json="$(oc get crd "$AGENT_SANDBOX_CRD" -o json 2>/dev/null)"; then
    served="$(jq -r '[.spec.versions[] | select(.served) | .name] | join(" ")' <<<"$crd_json")"
    olm="$(jq -r '(.metadata.labels // {}) | to_entries
                  | map(select(.key == "olm.managed" or (.key | startswith("operators.coreos.com/"))))
                  | length' <<<"$crd_json")"
    if [[ "$olm" != "0" ]]; then
      [[ " $served " == *" v1beta1 "* ]] \
        || die "CRD $AGENT_SANDBOX_CRD is managed by OLM (an agent-sandbox operator) but serves only '$served'. OpenShell 0.1.x needs agents.x-k8s.io/v1beta1: upgrade that operator; this script will not replace an OLM-owned CRD."
      log "agent-sandbox: reusing the OLM-managed CRD (serves: $served)"
      return 0
    fi
    if [[ " $served " != *" v1beta1 "* ]]; then
      if [[ "${AGENT_SANDBOX_MIGRATE:-0}" != "1" ]]; then
        die "$(cat <<EOF
CRD $AGENT_SANDBOX_CRD serves only '$served' (agent-sandbox <= v0.4.x, used by OpenShell 0.0.x).
OpenShell 0.1.x needs agent-sandbox ${AGENT_SANDBOX_VERSION} (agents.x-k8s.io/v1beta1). Migration
(fresh reinstall — existing sandboxes cannot be converted):
  1. delete every sandbox:   oc delete sandboxes.agents.x-k8s.io --all -A --wait
  2. uninstall the old controller + CRDs, e.g. for v0.4.6:
       oc delete -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.4.6/manifest.yaml --ignore-not-found
  3. re-run this script.
Or re-run with AGENT_SANDBOX_MIGRATE=1 to perform steps 1-2 automatically (affects ALL namespaces).
EOF
)"
      fi
      _agent_sandbox_migrate
    else
      ctrl_img="$(oc -n agent-sandbox-system get deploy agent-sandbox-controller \
        -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
      ctrl_ver="${ctrl_img##*:}"
      if [[ "$ctrl_ver" == v* ]] && _ver_ge "$ctrl_ver" "$AGENT_SANDBOX_VERSION"; then
        log "agent-sandbox: controller $ctrl_ver already installed (serves: $served) — reusing"
        return 0
      fi
    fi
  fi
  log "agent-sandbox: applying ${AGENT_SANDBOX_VERSION} (CRD + controller)"
  oc apply --server-side --force-conflicts --field-manager=nemoclaw-deploy -f "$url" >/dev/null
  oc wait --for=condition=Established "crd/$AGENT_SANDBOX_CRD" --timeout=120s >/dev/null
  oc -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=300s >/dev/null \
    || warn "agent-sandbox controller not ready yet (oc -n agent-sandbox-system get pods)"
}

_agent_sandbox_migrate() {
  local ctrl_img old_ver crd
  warn "AGENT_SANDBOX_MIGRATE=1: deleting ALL Sandbox objects and the old agent-sandbox install"
  oc delete sandboxes.agents.x-k8s.io --all -A --wait --timeout=300s \
    || warn "some Sandbox objects did not delete cleanly (finalizers?) — continuing"
  ctrl_img="$(oc -n agent-sandbox-system get deploy agent-sandbox-controller \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
  old_ver="${ctrl_img##*:}"
  if [[ "$old_ver" == v0.* ]]; then
    oc delete --ignore-not-found --wait=true -f \
      "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${old_ver}/manifest.yaml" \
      || warn "could not delete the ${old_ver} manifest — removing the objects by name"
  fi
  for crd in $(oc get crd -o name 2>/dev/null | grep -E '\.agents\.x-k8s\.io$' || true); do
    oc delete "$crd" --ignore-not-found --wait=true
  done
  oc delete clusterrolebinding agent-sandbox-controller --ignore-not-found
  oc delete clusterrole agent-sandbox-controller --ignore-not-found
  oc -n agent-sandbox-system delete deploy agent-sandbox-controller --ignore-not-found --wait=true
}

# =========================================================================================
# Inference (OpenShell 0.1.x provider profiles; `openshell inference set` no longer exists)
# =========================================================================================

# Parse scheme://host[:port][/path] into INFERENCE_HOST / INFERENCE_PORT (globals).
# Port defaults to 80 for http and 443 for https.
parse_inference_endpoint() {
  local url="$1" scheme rest hostport
  scheme="${url%%://*}"
  [[ "$scheme" != "$url" ]] || return 1
  scheme="$(printf '%s' "$scheme" | tr '[:upper:]' '[:lower:]')"
  rest="${url#*://}"
  hostport="${rest%%/*}"; hostport="${hostport%%\?*}"; hostport="${hostport##*@}"
  INFERENCE_HOST="$(printf '%s' "${hostport%%:*}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$hostport" == *:* ]]; then
    INFERENCE_PORT="${hostport##*:}"
  else
    case "$scheme" in
      http) INFERENCE_PORT=80 ;;
      https) INFERENCE_PORT=443 ;;
      *) return 1 ;;
    esac
  fi
  [[ -n "$INFERENCE_HOST" && "$INFERENCE_PORT" =~ ^[0-9]+$ ]]
}

# Render manifests/openclaw/inference-profile.yaml.tmpl for a base URL (stdout).
render_inference_profile() {
  local base_url="$1"
  parse_inference_endpoint "$base_url" \
    || { warn "cannot parse NEMOCLAW_INFERENCE_BASE_URL '$base_url' (expected http(s)://host[:port]/...)"; return 1; }
  # shellcheck disable=SC2016  # envsubst SHELL-FORMAT: literal variable names
  INFERENCE_HOST="$INFERENCE_HOST" INFERENCE_PORT="$INFERENCE_PORT" \
    envsubst '${INFERENCE_HOST} ${INFERENCE_PORT}' < "$REPO_ROOT/manifests/openclaw/inference-profile.yaml.tmpl"
}

# Script run INSIDE the workshop pod (bash -c). Reads the profile on stdin. The key is
# taken from the pod's own env (NEMOCLAW_API_KEY, plain value or Secret via envFrom) and
# handed to the CLI as an env lookup (`--credential OPENAI_API_KEY`), so it never appears
# on any command line — neither here nor in the pod.
_inference_pod_script() {
  cat <<'SH'
set -uo pipefail
P="${NEMOCLAW_INFERENCE_PROVIDER:-default}"
# The CLI reads OPENSHELL_GATEWAY_ENDPOINT and needs a full http(s):// URL.
[ -n "${OPENSHELL_GATEWAY_ENDPOINT_URL:-}" ] && export OPENSHELL_GATEWAY_ENDPOINT="$OPENSHELL_GATEWAY_ENDPOINT_URL"
# The CLI picks the profile format from the file extension: keep `.yaml`.
D="$(mktemp -d /tmp/maas-openai-profile.XXXXXX)"
F="$D/maas-openai.yaml"
trap 'rm -rf "$D"' EXIT
cat > "$F"
os() { openshell "$@" 2>&1 | grep -v UNDICI; return "${PIPESTATUS[0]}"; }
# INFERENCE_UPDATE=0 keeps an existing profile/provider as is: every update re-issues the
# placeholder ($OPENAI_API_KEY = openshell:resolve:env:v<rev>_…) of all attached sandboxes, and an
# agent process started before it (a running OpenClaw gateway) stops resolving its old one.
UPDATE="${INFERENCE_UPDATE:-1}"
# `lint` checks against the gateway and rejects an id that already exists: lint only before the
# first import; an update is validated by `update` itself.
if openshell provider profile describe maas-openai >/dev/null 2>&1 && [ "$UPDATE" != 1 ]; then
  echo "profile maas-openai exists — kept"
elif openshell provider profile describe maas-openai >/dev/null 2>&1; then
  # `update` needs the current resource_version (optimistic concurrency): copy it from an export.
  rv="$(openshell provider profile export maas-openai -o json 2>/dev/null | jq -r '.resource_version // empty')"
  sed -i '/^resource_version:/d' "$F" && sed -i "/^id:/a resource_version: ${rv:-1}" "$F"
  os provider profile update maas-openai -f "$F" >/dev/null || exit 1
  echo "profile maas-openai updated"
else
  os provider profile lint -f "$F" >/dev/null || { os provider profile lint -f "$F"; exit 1; }
  os provider profile import -f "$F" >/dev/null || exit 1
  echo "profile maas-openai imported"
fi
export OPENAI_API_KEY="$NEMOCLAW_API_KEY"
existing="$(openshell provider list -o json 2>/dev/null \
  | jq -r --arg n "$P" '[.. | objects | select(.name? == $n and has("type")) | .type] | first // empty' 2>/dev/null)"
if [ -z "$existing" ]; then
  os provider create --name "$P" --type maas-openai --credential OPENAI_API_KEY >/dev/null || exit 1
  echo "provider '$P' created (type maas-openai)"
elif [ "$existing" = "maas-openai" ] && [ "$UPDATE" != 1 ]; then
  echo "provider '$P' exists — kept (INFERENCE_UPDATE=1 pushes a new key; running agents then need a restart)"
elif [ "$existing" = "maas-openai" ]; then
  os provider update "$P" --credential OPENAI_API_KEY >/dev/null || exit 1
  echo "provider '$P' updated (type maas-openai)"
else
  echo "provider '$P' already exists with type '$existing' — left untouched; set NEMOCLAW_INFERENCE_PROVIDER to another name" >&2
  exit 2
fi
SH
}

# configure_inference <namespace>
# Imports the maas-openai provider profile into the namespace's gateway and creates/updates
# the provider NEMOCLAW_INFERENCE_PROVIDER, all through `oc exec deploy/workshop` (the
# workshop pod has the openshell CLI and reaches the gateway in-cluster). Idempotent; never
# deletes a provider. Skips (returns 0) when the workshop has no inference settings.
# INFERENCE_UPDATE=0 (lab.sh default) leaves an existing profile/provider untouched.
configure_inference() {
  local ns="${1:?usage: configure_inference <namespace>}" base_url profile
  oc -n "$ns" rollout status deploy/workshop --timeout=300s >/dev/null 2>&1 \
    || { warn "[$ns] workshop not ready — inference provider not configured"; return 1; }
  base_url="$(oc -n "$ns" exec deploy/workshop -c workshop -- printenv NEMOCLAW_INFERENCE_BASE_URL 2>/dev/null || true)"
  if [[ -z "$base_url" ]] \
     || ! oc -n "$ns" exec deploy/workshop -c workshop -- sh -c 'test -n "${NEMOCLAW_API_KEY:-}" && test -n "${NEMOCLAW_MODEL:-}"' 2>/dev/null; then
    warn "[$ns] NEMOCLAW_INFERENCE_BASE_URL / NEMOCLAW_MODEL / NEMOCLAW_API_KEY not set in the workshop — agents deploy without a model."
    return 0
  fi
  profile="$(render_inference_profile "$base_url")" || return 1
  # render_inference_profile runs in a subshell: parse again here for the log line.
  parse_inference_endpoint "$base_url" || return 1
  log "[$ns] inference: profile maas-openai -> ${INFERENCE_HOST}:${INFERENCE_PORT}"
  printf '%s\n' "$profile" \
    | oc -n "$ns" exec -i deploy/workshop -c workshop -- env INFERENCE_UPDATE="${INFERENCE_UPDATE:-1}" \
        bash -c "$(_inference_pod_script)" \
    | sed "s/^/[$ns] /"
}
