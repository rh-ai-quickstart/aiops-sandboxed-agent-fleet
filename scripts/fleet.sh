#!/usr/bin/env bash
# fleet.sh — Part VI capstone: bring up the SRE copilot fleet from a simple spec, so you
# never repeat the per-agent setup by hand. Each line of the spec is:
#
#     name   backend   skill        # backend = host:port the agent may reach, or "-" for none
#
# e.g.   logs     logging-loki-gateway-http.openshift-logging.svc.cluster.local:8080   -
#        metrics  thanos-querier.openshift-monitoring.svc.cluster.local:9092           -
#        analyst  -                                                                    -
#
# For each agent this creates a sealed OpenShell sandbox whose deny-by-default policy allows
# ONLY that one telemetry backend (fleet-roles/<name>/policy.yaml, or one generated from the
# backend column), attaches the inference provider, and stages the agent's IDENTITY.md /
# SOUL.md, the cluster-telemetry skill, a 24h telemetry-reader token and its OpenClaw config.
#
# Runs inside the workshop pod (openshell CLI, kubectl, jq; namespaces from the chart env).
# Usage: fleet.sh up <spec> | status | down [<spec>]
# Env:   OPENSHELL_NAMESPACE, DEMO_NAMESPACE, OPENSHELL_GATEWAY_ENDPOINT_URL (chart),
#        NEMOCLAW_INFERENCE_PROVIDER, NEMOCLAW_MODEL, NEMOCLAW_INFERENCE_BASE_URL,
#        OPENCLAW_SANDBOX_IMAGE, FLEET_RECREATE=1 (recreate Ready sandboxes),
#        FLEET_READY_TIMEOUT (seconds, default 900), TELEMETRY_READER_SA.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/.." && pwd)"
if [[ -f "$REPO/.env" ]]; then set -a; # shellcheck disable=SC1091
  . "$REPO/.env"; set +a; fi

SA_NS_FILE=/var/run/secrets/kubernetes.io/serviceaccount/namespace
OPENSHELL_NS="${OPENSHELL_NAMESPACE:-$(cat "$SA_NS_FILE" 2>/dev/null || echo openshell)}"
DEMO_NS="${DEMO_NAMESPACE:-demo}"
# The CLI reads OPENSHELL_GATEWAY_ENDPOINT directly (a full http(s):// URL): no
# `gateway add/select` needed, and the right per-namespace gateway in lab mode.
export OPENSHELL_GATEWAY_ENDPOINT="${OPENSHELL_CLI_ENDPOINT:-${OPENSHELL_GATEWAY_ENDPOINT_URL:-http://openshell.${OPENSHELL_NS}.svc.cluster.local:8080}}"

IMAGE="${OPENCLAW_SANDBOX_IMAGE:-ghcr.io/ansjindal/openclaw-sandbox:2026.8.2}"
MODEL="${NEMOCLAW_MODEL:-}"
BASE_URL="${NEMOCLAW_INFERENCE_BASE_URL:-}"
PROVIDER="${NEMOCLAW_INFERENCE_PROVIDER:-default}"
API="${NEMOCLAW_INFERENCE_API:-openai-completions}"
TELEMETRY_SA="${TELEMETRY_READER_SA:-telemetry-reader}"
READY_TIMEOUT="${FLEET_READY_TIMEOUT:-900}"
# The OpenShell proxy does not resolve single-label hosts: always the namespace FQDN.
REG_HOST="registry.${OPENSHELL_NS}.svc.cluster.local"
REG="${REG_HOST}:4873"
ROLES="$REPO/manifests/openclaw/fleet-roles"
WORKSPACE="/sandbox/.openclaw/workspace"   # OpenClaw's default agent workspace (persona files)
SKILLDIR="$REPO/manifests/openclaw/skills/cluster-telemetry"   # the in-cluster telemetry skill
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fleet.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

quiet() { grep -viE 'UNDICI|trace-warn' || true; }
os() { openshell "$@" </dev/null 2>&1 | quiet; }
ox() { openshell sandbox exec -n "$1" -- sh -c "$2" </dev/null 2>&1 | quiet; }
b64() { base64 | tr -d '\n'; }
phase_of() {
  openshell sandbox get "$1" -o json </dev/null 2>/dev/null \
    | jq -r '.phase // .sandbox.phase // empty' 2>/dev/null || true
}
# Committed files carry the default namespaces; substitute this instance's.
render() {
  sed -e "s/registry\.openshell\.svc\.cluster\.local/${REG_HOST}/g" \
      -e "s/{{DEMO_NS}}/${DEMO_NS}/g" -e "s/{{OPENSHELL_NS}}/${OPENSHELL_NS}/g" "$1"
}
stage() {                            # stage <sandbox> <local file> <dest path in sandbox>
  ox "$1" "mkdir -p '$(dirname "$3")' && echo $(render "$2" | b64) | base64 -d > '$3'"
}

policy_for() {                       # $1 = backend host:port (or "-")
  local be="$1" host="${1%%:*}" port="${1##*:}" extra=""
  if [[ "$be" != "-" && -n "$be" ]]; then
    extra="
  tool-egress:
    name: tool-egress
    endpoints: [ { host: ${host}, port: ${port}, access: full, protocol: rest, tls: skip } ]
    binaries: [ {path: /usr/bin/node}, {path: /usr/local/bin/node}, {path: /usr/bin/curl} ]"
  fi
  cat <<YAML
version: 1
filesystem_policy: { include_workdir: true, read_only: [/usr,/lib,/proc,/dev/urandom,/app,/etc,/var/log], read_write: [/sandbox,/tmp,/var/tmp,/dev/null] }
landlock: { compatibility: best_effort }
process: { run_as_user: sandbox, run_as_group: sandbox }
network_policies:
  in-cluster-registry:
    name: in-cluster-registry
    endpoints: [ { host: ${REG_HOST}, port: 4873, access: full, protocol: rest, allow_encoded_slash: true } ]
    binaries: [ {path: /usr/bin/npm}, {path: /usr/local/bin/npm}, {path: /usr/bin/node}, {path: /usr/local/bin/node} ]${extra}
YAML
}

wait_gone() {                        # wait until a deleted sandbox has disappeared
  local i
  for i in $(seq 1 60); do
    [[ -z "$(phase_of "$1")" ]] && return 0
    sleep 2
  done
  echo "   ! ${1} still present after delete (iteration ${i})"
}

up() {
  local spec="${1:?usage: fleet.sh up <spec>}"
  # Whitespace-separated columns:  name   backend(host:port|-)   skill(@scope/name|-)
  # (NOT colon-separated — backend hosts contain a colon, e.g. loki…:8080.)
  local -a NM BK SK POL NEW
  # Read the spec on FD 3 (the openshell commands below read stdin and would otherwise
  # eat the rest of the file).
  while read -r name backend skill <&3; do
    [[ -z "$name" || "$name" == \#* ]] && continue
    NM+=("$name"); BK+=("${backend:--}"); SK+=("${skill:--}")
  done 3< "$spec"

  local -a provider_args=()
  if openshell provider list --names </dev/null 2>/dev/null | grep -qx "$PROVIDER"; then
    provider_args=(--provider "$PROVIDER")
  else
    echo "note: inference provider '${PROVIDER}' not found on the gateway — agents start without a model"
  fi
  echo "Fleet: ${#NM[@]} agents, image ${IMAGE}, namespace ${OPENSHELL_NS} (app namespace ${DEMO_NS})"

  local i name ph
  for i in "${!NM[@]}"; do
    name="${NM[$i]}"
    # Prefer the committed per-role policy (fleet-roles/<name>/policy.yaml); fall back to
    # one generated from the backend column.
    POL[i]="$WORK/${name}.policy.yaml"
    if [[ -f "$ROLES/$name/policy.yaml" ]]; then
      render "$ROLES/$name/policy.yaml" > "${POL[i]}"
    else
      policy_for "${BK[i]}" > "${POL[i]}"
    fi
    ph="$(phase_of "$name")"
    if [[ "$ph" == "Ready" && "${FLEET_RECREATE:-0}" != "1" ]]; then
      NEW[i]=0
      echo "▶ ${name}  already Ready — re-staging files only (FLEET_RECREATE=1 recreates it)"
      continue
    fi
    NEW[i]=1
    echo "▶ ${name}  (egress=${BK[i]}  skill=${SK[i]})"
    if [[ -n "$ph" ]]; then
      os sandbox delete "$name" >/dev/null || true
      wait_gone "$name"
    fi
  done

  # Create concurrently so the agents bootstrap in parallel. Every sandbox gets a policy
  # (without one it never becomes Ready) and a main process that never exits
  # (`--detach -- sleep infinity`; a command that exits leaves the sandbox Completed).
  for i in "${!NM[@]}"; do
    [[ "${NEW[i]}" == 1 ]] || continue
    name="${NM[$i]}"
    openshell sandbox create --name "$name" --from "$IMAGE" --policy "${POL[i]}" \
      "${provider_args[@]}" --env OPENCLAW_CHILD_OOM_SCORE_ADJ=0 \
      --no-tty --detach -- sleep infinity </dev/null >"$WORK/${name}.create.log" 2>&1 &
  done
  echo "   …creating; waiting for each to reach phase Ready (they bootstrap concurrently)…"

  local deadline=$(( SECONDS + READY_TIMEOUT ))
  for i in "${!NM[@]}"; do
    name="${NM[$i]}"
    ph="$(phase_of "$name")"
    while [[ "$ph" != "Ready" && "$ph" != "Error" ]] && (( SECONDS < deadline )); do
      sleep 5; ph="$(phase_of "$name")"
    done
    if [[ "$ph" != "Ready" ]]; then
      echo "   ✗ ${name} not Ready (phase: ${ph:-none}) — create log:"
      tail -6 "$WORK/${name}.create.log" 2>/dev/null | quiet | sed 's/^/       /'
      continue
    fi
    # (Re-)apply the policy: also refreshes the registry host / backend of a reused sandbox.
    os policy set "$name" --policy "${POL[i]}" --wait >/dev/null || true
    # the agent's persona (IDENTITY.md / SOUL.md) from fleet-roles/<name>, staged into the
    # OpenClaw workspace where the agent actually loads it. BOOTSTRAP.md falls back to the shared
    # fleet-roles/BOOTSTRAP.md: without one, OpenClaw's default first-run template makes every
    # fresh session open with a "who am I?" interview instead of the task.
    local f src
    if [[ -d "$ROLES/$name" ]]; then
      for f in IDENTITY.md SOUL.md BOOTSTRAP.md; do
        src="$ROLES/$name/$f"
        [[ "$f" == BOOTSTRAP.md && ! -f "$src" ]] && src="$ROLES/BOOTSTRAP.md"
        [[ -f "$src" ]] && stage "$name" "$src" "$WORKSPACE/$f"
      done
    fi
    if [[ "${BK[i]}" != "-" && -n "${BK[i]}" ]]; then
      # A 24h token of this instance's telemetry-reader: it can only read metrics, logs and
      # pods of ${OPENSHELL_NS} and ${DEMO_NS} (Thanos 9092 / Loki / Tempo bearer auth).
      local tok
      tok="$(kubectl create token "$TELEMETRY_SA" -n "$OPENSHELL_NS" --duration=24h 2>/dev/null || true)"
      if [[ -n "$tok" ]]; then
        ox "$name" "umask 077; echo $(printf '%s' "$tok" | b64) | base64 -d > /sandbox/.monitoring-token"
      else
        echo "   ! ${name}: could not mint a ${TELEMETRY_SA} token (kubectl create token -n ${OPENSHELL_NS})"
      fi
      # the cluster-telemetry skill: web_fetch blocks internal hosts, the skill shells out to
      # curl, still bounded by the agent's single-backend egress policy.
      if [[ -d "$SKILLDIR" ]]; then
        for f in SKILL.md tq.js; do
          [[ -f "$SKILLDIR/$f" ]] && stage "$name" "$SKILLDIR/$f" "/sandbox/.agents/skills/cluster-telemetry/$f"
        done
      fi
    fi
    if [[ -n "$MODEL" && -n "$BASE_URL" && ${#provider_args[@]} -gt 0 ]]; then
      # OpenClaw talks to the REAL endpoint; its API key is the provider placeholder that the
      # sandbox sees in $OPENAI_API_KEY — the supervisor proxy swaps in the real key on egress
      # to the endpoint declared by the provider profile. The config keeps the literal
      # ${OPENAI_API_KEY} (OpenClaw substitutes it at process start): OpenShell 0.1.x versions the
      # placeholder (openshell:resolve:env:v<rev>_…) and stops resolving an old one once the
      # provider is updated, so a copied value would break the agent on the next update.
      local cfg
      # contextWindow must match the served model: OpenClaw otherwise assumes a small default
      # and rejects its own agent prompt with "Context overflow".
      # Fleet agents only run one telemetry probe through `exec`: a minimal tool profile, one
      # skill, a capped workspace and no memory plugin cut each turn's prompt ~10x (measured
      # 80k -> 8k input tokens), which is what keeps 30 attendees' fleets within one GPU's budget.
      cfg="$(jq -cn --arg m "$MODEL" --arg u "$BASE_URL" --arg api "$API" \
        --argjson cw "${NEMOCLAW_MODEL_CONTEXT_WINDOW:-65536}" --argjson mt "${NEMOCLAW_MODEL_MAX_TOKENS:-4096}" \
        '{agents:{defaults:{model:{primary:("custom/"+$m)},
                            skills:["cluster-telemetry"], bootstrapTotalMaxChars:6000}},
          tools:{profile:"minimal", alsoAllow:["exec"], exec:{host:"gateway"}},
          plugins:{entries:{"memory-core":{enabled:false}}},
          models:{providers:{custom:{baseUrl:$u,apiKey:"${OPENAI_API_KEY}",api:$api,
                                     models:[{id:$m,name:$m,contextWindow:$cw,maxTokens:$mt}]}}}}' | b64)"
      ox "$name" "mkdir -p /sandbox/.openclaw && echo $cfg | base64 -d > /sandbox/.openclaw/openclaw.json"
    fi
    # optional registry skill (best-effort — the agent still works via its SOUL if absent)
    if [[ "${SK[i]}" != "-" && -n "${SK[i]}" ]]; then
      local auth; auth="$(printf 'workshop:%s' "${OPENCLAW_REGISTRY_PASSWORD:-wad26-skills}" | b64)"
      ox "$name" "printf 'registry=http://${REG}/\n@workshop:registry=http://${REG}/\n//${REG}/:_auth=${auth}\n' > /sandbox/.npmrc"
      ox "$name" "NODE_NO_WARNINGS=1 openclaw plugins install '${SK[i]}' --accept-capabilities --force 2>&1 | tail -1 | sed 's/^/     /'" || true
    fi
    echo "   ✓ ${name} ready + configured"
  done
  # A create still blocked past the deadline is abandoned (the sandbox is reported above).
  local pid
  for pid in $(jobs -p); do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  echo "Done. Run './scripts/fleet.sh status' (or open the Fleet page in the workshop)."
}

status() { openshell sandbox list </dev/null 2>/dev/null | quiet; }
down() {
  local s="${1:-}" n
  if [[ -n "$s" ]]; then
    awk '!/^#/ && NF{print $1}' "$s"
  else
    openshell sandbox list --names </dev/null 2>/dev/null
  fi | while read -r n; do
    [[ -n "$n" ]] && openshell sandbox delete "$n" </dev/null >/dev/null 2>&1 && echo "removed $n"
  done
}

case "${1:-}" in
  up) shift; up "$@" ;;
  status) status ;;
  down) shift; down "$@" ;;
  *) echo "usage: fleet.sh up <spec> | status | down [<spec>]"; exit 1 ;;
esac
