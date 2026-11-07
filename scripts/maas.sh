#!/usr/bin/env bash
# Self-hosted inference for the lab ("MaaS"): GPU node(s) + NVIDIA GPU Operator + OpenShift AI 3.5,
# NVIDIA Nemotron 3 Nano 30B-A3B FP8 served by llm-d/vLLM, published through OpenShift AI
# Models-as-a-Service (Red Hat Connectivity Link: API keys + token rate limits).
#
#   scripts/maas.sh up            # everything below, idempotent (~30-45 min on a fresh cluster)
#   scripts/maas.sh status        # GPU nodes, OpenShift AI, model and MaaS readiness, endpoint
#   scripts/maas.sh keys <N>      # mint one API key per attendee user01..userNN -> .lab/maas-keys.csv
#                                 # (consumed by lab.sh via LAB_INFERENCE_KEYS_FILE); existing rows kept
#   scripts/maas.sh env           # print NEMOCLAW_INFERENCE_BASE_URL / NEMOCLAW_MODEL for .env
#   scripts/maas.sh smoke         # chat completion + tool call through the MaaS endpoint (needs a key)
#   scripts/maas.sh down          # delete the model + MaaS access objects, scale GPU MachineSets to 0
#                                 # (operators, OpenShift AI and PostgreSQL are kept)
#
# Tunables (env / .env): MAAS_GPU_INSTANCE_TYPE (g6e.2xlarge = 1x L40S 48GB), MAAS_GPU_REPLICAS (1),
# MAAS_MODEL_REPLICAS (= MAAS_GPU_REPLICAS), MAAS_GPU_SOURCE_MACHINESET (first worker MachineSet),
# MAAS_GPU_DISK_GB (200), MAAS_TOKENS_PER_MINUTE (5000000), MAAS_KEY_OWNER (current oc user).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
load_env

MAAS_DIR="$REPO_ROOT/deploy/maas"
LAB_DIR="$REPO_ROOT/.lab"
GPU_TYPE="${MAAS_GPU_INSTANCE_TYPE:-g6e.2xlarge}"
GPU_REPLICAS="${MAAS_GPU_REPLICAS:-1}"
MODEL_REPLICAS="${MAAS_MODEL_REPLICAS:-$GPU_REPLICAS}"
GPU_DISK_GB="${MAAS_GPU_DISK_GB:-200}"
MODEL=nemotron-3-nano
MODEL_NS=maas-models
MAAS_NS=models-as-a-service
INFRA_NS=redhat-ai-gateway-infra
MAPI=openshift-machine-api

# Retry a command: the API can be slow or drop connections from a remote laptop.
retry() { local n=0; until "$@"; do n=$((n + 1)); ((n >= 5)) && return 1; sleep 10; done; }

apps_domain() { oc get ingresses.config/cluster -o jsonpath='{.spec.domain}'; }
maas_url() { echo "https://maas.$(apps_domain)"; }

wait_csv() { # <namespace> <csv-name-prefix>
  local ns="$1" prefix="$2" phase="" _
  for _ in $(seq 1 60); do
    phase="$(oc -n "$ns" get csv --request-timeout=60s --no-headers 2>/dev/null | awk -v p="^$prefix" '$1 ~ p {print $NF; exit}')"
    [[ "$phase" == "Succeeded" ]] && { log "  $prefix: Succeeded"; return 0; }
    sleep 20
  done
  die "Operator $prefix in $ns did not reach Succeeded (last phase: ${phase:-none})."
}

wait_for() { # <description> <tries> <sleep> <command...>
  local desc="$1" tries="$2" pause="$3" _; shift 3
  for _ in $(seq 1 "$tries"); do "$@" >/dev/null 2>&1 && return 0; sleep "$pause"; done
  die "Timed out waiting for: $desc"
}

gpu_node_ready() { oc get nodes -l node-role.kubernetes.io/gpu --no-headers 2>/dev/null | awk '$2 == "Ready"' | grep -q .; }
# Any Ready GPU node with a GPU (a recreated machine can leave the old NotReady node listed first).
gpu_allocatable() { oc get nodes -l node-role.kubernetes.io/gpu -o json 2>/dev/null | jq -e '[.items[]
  | select(any(.status.conditions[]; .type == "Ready" and .status == "True"))
  | (.status.allocatable["nvidia.com/gpu"] // "0" | tonumber)] | any(. >= 1)' >/dev/null; }
kuadrant_ready() { [[ "$(oc -n kuadrant-system get kuadrant kuadrant -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" == "True" ]]; }
model_ready() { [[ "$(oc -n "$MODEL_NS" get llminferenceservice "$MODEL" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" == "True" ]]; }
subscription_active() { [[ "$(oc -n "$MAAS_NS" get maassubscription nemoclaw-lab -o jsonpath='{.status.phase}' 2>/dev/null)" == "Active" ]]; }

# A cluster stop/start (e.g. scheduled sandbox environments) only restarts the instances the
# cluster was installed with: machines added later stay "stopped" and the Machine API does not
# start them again. Deleting the Machine makes its MachineSet create a fresh instance.
recover_stopped_machines() { # <machineset>
  local m
  for m in $(oc -n "$MAPI" get machines -l "machine.openshift.io/cluster-api-machineset=$1" -o json \
      | jq -r '.items[] | select(.metadata.annotations["machine.openshift.io/instance-state"] == "stopped") | .metadata.name'); do
    warn "Machine $m is stopped in the cloud (cluster restart?) — recreating it"
    oc -n "$MAPI" delete machine "$m" --wait=false
  done
}

ensure_gpu_machineset() {
  local src="${MAAS_GPU_SOURCE_MACHINESET:-}" infra zone name
  [[ -n "$src" ]] || src="$(oc -n "$MAPI" get machineset -o name | awk -F/ '$2 !~ /-gpu-/ {print $2; exit}')"
  [[ -n "$src" ]] || die "No worker MachineSet found to clone (set MAAS_GPU_SOURCE_MACHINESET)."
  infra="$(oc get infrastructure cluster -o jsonpath='{.status.infrastructureName}')"
  zone="$(oc -n "$MAPI" get machineset "$src" -o jsonpath='{.spec.template.spec.providerSpec.value.placement.availabilityZone}')"
  name="${infra}-gpu-${zone}"
  log "GPU MachineSet $name ($GPU_TYPE x$GPU_REPLICAS, cloned from $src)"
  # Clone a worker MachineSet: GPU instance type, bigger root disk (images + model weights),
  # gpu role label and a NoSchedule taint so only GPU workloads (the model) land there.
  oc -n "$MAPI" get machineset "$src" -o json | jq --arg name "$name" --arg type "$GPU_TYPE" \
    --argjson replicas "$GPU_REPLICAS" --argjson disk "$GPU_DISK_GB" '
      del(.metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp, .metadata.generation,
          .metadata.annotations, .metadata.managedFields, .status)
      | .metadata.name = $name
      | .spec.replicas = $replicas
      | .spec.selector.matchLabels["machine.openshift.io/cluster-api-machineset"] = $name
      | .spec.template.metadata.labels["machine.openshift.io/cluster-api-machineset"] = $name
      | .spec.template.spec.metadata.labels = {"node-role.kubernetes.io/gpu": "", "nvidia.com/gpu.workload.config": "container"}
      | .spec.template.spec.taints = [{"key": "nvidia.com/gpu", "value": "true", "effect": "NoSchedule"}]
      | .spec.template.spec.providerSpec.value.instanceType = $type
      | .spec.template.spec.providerSpec.value.blockDevices[0].ebs.volumeSize = $disk' \
    | retry oc apply -f -
  recover_stopped_machines "$name"
  log "Waiting for a Ready GPU node (AWS provisioning + node join: ~5-10 min)"
  wait_for "a Ready GPU node — check: oc -n $MAPI get machines (AWS GPU quota/capacity)" 60 20 gpu_node_ready
}

# Copy the cluster's default ingress certificate for https://maas.<apps-domain> (a publicly trusted
# certificate matters: the OpenShell proxy only swaps the API-key placeholder over TLS it can verify).
ensure_maas_tls() {
  local cert
  cert="$(oc -n openshift-ingress-operator get ingresscontroller default -o jsonpath='{.spec.defaultCertificate.name}')"
  [[ -n "$cert" ]] || cert=router-certs-default
  oc -n openshift-ingress get secret "$cert" -o json \
    | jq '{apiVersion: "v1", kind: "Secret", type: .type,
           metadata: {name: "maas-tls-cert", namespace: "openshift-ingress"},
           data: {"tls.crt": .data["tls.crt"], "tls.key": .data["tls.key"]}}' \
    | retry oc apply -f -
}

ensure_authorino_tls() { # OpenShift AI 3.5 MaaS guide, "Configure Authorino TLS"
  oc annotate service authorino-authorino-authorization -n kuadrant-system \
    service.beta.openshift.io/serving-cert-secret-name=authorino-server-cert --overwrite
  oc patch authorino authorino -n kuadrant-system --type=merge \
    -p '{"spec":{"listener":{"tls":{"enabled":true,"certSecretRef":{"name":"authorino-server-cert"}}}}}'
  oc -n kuadrant-system set env deployment/authorino \
    SSL_CERT_FILE=/etc/ssl/certs/openshift-service-ca/service-ca-bundle.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/openshift-service-ca/service-ca-bundle.crt
}

ensure_postgres() { # credentials generated once, never committed
  oc create namespace "$INFRA_NS" --dry-run=client -o yaml | retry oc apply -f -
  if ! oc -n "$INFRA_NS" get secret maas-postgres >/dev/null 2>&1; then
    oc -n "$INFRA_NS" create secret generic maas-postgres --from-literal=POSTGRESQL_USER=maas \
      --from-literal=POSTGRESQL_PASSWORD="$(openssl rand -hex 16)" --from-literal=POSTGRESQL_DATABASE=maas >/dev/null
  fi
  local pw
  pw="$(oc -n "$INFRA_NS" get secret maas-postgres -o jsonpath='{.data.POSTGRESQL_PASSWORD}' | base64 -d)"
  oc -n "$INFRA_NS" create secret generic maas-db-config \
    --from-literal=DB_CONNECTION_URL="postgresql://maas:${pw}@maas-postgres.${INFRA_NS}.svc.cluster.local:5432/maas?sslmode=disable" \
    --dry-run=client -o yaml | retry oc apply -f - >/dev/null
  retry oc apply -f "$MAAS_DIR/55-postgres.yaml"
  oc -n "$INFRA_NS" rollout status deploy/maas-postgres --timeout=300s
}

# Each model replica needs a whole GPU and the generated Deployment rolls out with maxSurge>0 and
# maxUnavailable=0: with no spare GPU, any spec change deadlocks (new pod Pending, the old pod keeps
# the GPU). Drop the older ReplicaSets so the new revision can take the GPU (brief downtime).
release_gpu_for_rollout() {
  local dep="$MODEL-kserve" rev rs
  rev="$(oc -n "$MODEL_NS" get deploy "$dep" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null)" || return 0
  [[ -n "$rev" ]] || return 0
  for rs in $(oc -n "$MODEL_NS" get rs -o json | jq -r --arg d "$dep" --arg r "$rev" \
      '.items[] | select(.metadata.ownerReferences[]?.name == $d)
                | select(.metadata.annotations["deployment.kubernetes.io/revision"] != $r) | .metadata.name'); do
    log "  releasing the GPU held by old revision $rs"
    oc -n "$MODEL_NS" delete rs "$rs" --wait=false
  done
}

cmd_up() {
  require_cmd oc; require_cmd jq; require_cmd envsubst; require_cmd openssl
  local domain; domain="$(apps_domain)"
  log "Operators: NFD, NVIDIA GPU Operator, OpenShift AI, Connectivity Link, LeaderWorkerSet"
  retry oc apply -f "$MAAS_DIR/00-operators.yaml"
  wait_csv openshift-nfd nfd
  wait_csv nvidia-gpu-operator gpu-operator-certified
  wait_csv redhat-ods-operator rhods-operator
  wait_csv openshift-operators rhcl-operator
  wait_csv openshift-lws-operator leader-worker-set
  retry oc apply -f "$MAAS_DIR/10-nfd-instance.yaml" -f "$MAAS_DIR/20-gpu-clusterpolicy.yaml"
  ensure_gpu_machineset
  log "Waiting for the NVIDIA driver stack on the GPU node (nvidia.com/gpu allocatable)"
  wait_for "nvidia.com/gpu allocatable on the GPU node" 60 20 gpu_allocatable
  log "OpenShift AI DataScienceCluster + Kuadrant + LeaderWorkerSet"
  retry oc apply -f "$MAAS_DIR/30-datasciencecluster.yaml" -f "$MAAS_DIR/40-kuadrant-lws.yaml"
  wait_for "Kuadrant Ready" 60 10 kuadrant_ready
  ensure_authorino_tls
  log "Gateways (maas.$domain) + PostgreSQL"
  ensure_maas_tls
  APPS_DOMAIN="$domain" envsubst '${APPS_DOMAIN}' < "$MAAS_DIR/50-gateways.yaml.tmpl" | retry oc apply -f -
  ensure_postgres
  oc -n redhat-ods-applications patch odhdashboardconfig odh-dashboard-config --type=merge \
    -p '{"spec":{"dashboardConfig":{"modelAsService":true,"genAiStudio":true}}}' || warn "dashboard flags not set"
  log "Model $MODEL (llm-d, $MODEL_REPLICAS replica(s)) — first start pulls ~33 GB"
  retry oc apply -f "$MAAS_DIR/60-model.yaml"
  oc -n "$MODEL_NS" patch llminferenceservice "$MODEL" --type=merge -p "{\"spec\":{\"replicas\":$MODEL_REPLICAS}}"
  sleep 20 && release_gpu_for_rollout
  MAAS_KEY_OWNER="${MAAS_KEY_OWNER:-$(oc whoami)}" MAAS_TOKENS_PER_MINUTE="${MAAS_TOKENS_PER_MINUTE:-5000000}" \
    envsubst '${MAAS_KEY_OWNER} ${MAAS_TOKENS_PER_MINUTE}' < "$MAAS_DIR/70-maas-access.yaml.tmpl" | retry oc apply -f -
  wait_for "model $MODEL Ready (oc -n $MODEL_NS get llminferenceservice $MODEL)" 90 20 model_ready
  wait_for "MaaSSubscription nemoclaw-lab Active" 30 10 subscription_active
  cmd_status
  cmd_env
}

cmd_status() {
  log "GPU nodes:"
  oc get nodes -l node-role.kubernetes.io/gpu -o custom-columns=NAME:.metadata.name,GPU:.status.allocatable.nvidia\\.com/gpu,PRODUCT:.metadata.labels.nvidia\\.com/gpu\\.product 2>/dev/null || true
  log "DataScienceCluster: $(oc get dsc default-dsc -o jsonpath='{.status.phase}' 2>/dev/null || echo absent)"
  log "Kuadrant Ready: $(oc -n kuadrant-system get kuadrant kuadrant -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo absent)"
  log "Model $MODEL Ready: $(oc -n "$MODEL_NS" get llminferenceservice "$MODEL" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo absent)"
  log "MaaSModelRef: $(oc -n "$MODEL_NS" get maasmodelref "$MODEL" -o jsonpath='{.status.phase}' 2>/dev/null || echo absent)  MaaSSubscription: $(oc -n "$MAAS_NS" get maassubscription nemoclaw-lab -o jsonpath='{.status.phase}' 2>/dev/null || echo absent)"
  log "Endpoint: $(maas_url)/$MODEL_NS/$MODEL/v1"
}

cmd_env() {
  echo "NEMOCLAW_INFERENCE_BASE_URL=\"$(maas_url)/$MODEL_NS/$MODEL/v1\""
  echo "NEMOCLAW_MODEL=\"$MODEL\""
  echo "# NEMOCLAW_API_KEY: one key per attendee via 'scripts/maas.sh keys <N>' + LAB_INFERENCE_KEYS_FILE=.lab/maas-keys.csv"
}

# One API key per attendee (one rate-limit identity per attendee). The key is shown once by the MaaS
# API, so it is written to .lab/maas-keys.csv (gitignored, mode 600). Rows already present are kept.
cmd_keys() {
  local n="${1:?usage: maas.sh keys <N>}" csv="$LAB_DIR/maas-keys.csv" base token i u
  [[ "$n" =~ ^[0-9]+$ ]] || die "keys: N must be a number"
  mkdir -p "$LAB_DIR"; touch "$csv"; chmod 600 "$csv"
  base="$(maas_url)/$MODEL_NS/$MODEL/v1"
  token="$(oc whoami -t)" || die "keys: needs an oc login with a token (oc whoami -t)."
  for ((i = 1; i <= n; i++)); do
    printf -v u 'user%02d' "$i"
    awk -F, -v u="$u" '$1 == u {found=1} END {exit !found}' "$csv" && continue
    local key
    key="$(curl -fsS -m 30 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d "{\"name\":\"nemoclaw-$u\",\"subscription\":\"nemoclaw-lab\"}" "$(maas_url)/maas-api/v1/api-keys" | jq -r '.key')" \
      || die "keys: API key creation failed for $u (is the subscription Active? scripts/maas.sh status)"
    [[ "$key" == sk-* ]] || die "keys: unexpected response for $u"
    printf '%s,%s,%s,%s\n' "$u" "$key" "$MODEL" "$base" >> "$csv"
    log "  key minted for $u"
  done
  log "Keys in $csv — run: LAB_INFERENCE_KEYS_FILE=$csv scripts/lab.sh up $n"
}

# End-to-end check through the MaaS gateway: plain completion + a forced tool call.
cmd_smoke() {
  local key="${NEMOCLAW_API_KEY:-}" url
  [[ -n "$key" ]] || key="$(awk -F, 'NR == 1 {print $2}' "$LAB_DIR/maas-keys.csv" 2>/dev/null)"
  [[ -n "$key" ]] || die "smoke: set NEMOCLAW_API_KEY or run 'scripts/maas.sh keys 1' first."
  url="$(maas_url)/$MODEL_NS/$MODEL/v1/chat/completions"
  log "Chat completion"
  curl -fsS -m 120 -H "Authorization: Bearer $key" -H 'Content-Type: application/json' "$url" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: ready\"}]}" \
    | jq -r '.choices[0].message.content'
  log "Tool call"
  curl -fsS -m 120 -H "Authorization: Bearer $key" -H 'Content-Type: application/json' "$url" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":256,\"tool_choice\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the error rate of the payments service? Use the tool.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"query_metrics\",\"description\":\"Run a PromQL query\",\"parameters\":{\"type\":\"object\",\"properties\":{\"promql\":{\"type\":\"string\"}},\"required\":[\"promql\"]}}}]}" \
    | jq -c '.choices[0].message.tool_calls // .choices[0].message.content'
}

cmd_down() {
  [[ -f "$MAAS_DIR/60-model.yaml" ]] && oc delete -f "$MAAS_DIR/60-model.yaml" --ignore-not-found || true
  oc -n "$MAAS_NS" delete maassubscription,maasauthpolicy nemoclaw-lab --ignore-not-found || true
  local ms
  for ms in $(oc -n "$MAPI" get machineset -o name | awk -F/ '$2 ~ /-gpu-/ {print $2}'); do
    log "Scaling $ms to 0"; oc -n "$MAPI" scale machineset "$ms" --replicas=0
  done
}

case "${1:-}" in
  up) cmd_up ;;
  status) cmd_status ;;
  keys) shift; cmd_keys "$@" ;;
  env) cmd_env ;;
  smoke) cmd_smoke ;;
  down) cmd_down ;;
  -h|--help|"") sed -n '2,17p' "$0" ;;
  *) die "Unknown command '$1' (see --help)" ;;
esac
