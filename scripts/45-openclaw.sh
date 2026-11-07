#!/usr/bin/env bash
# Phase 45 (optional: deploy.sh PROVISION_AGENT=true) — pre-create the OpenClaw agent the
# STANDARD OpenShell way: a GATEWAY-managed sandbox (`openshell sandbox create` against the
# in-cluster gateway), NOT a hand-applied Sandbox CR. The supervisor seals the agent in its
# own network namespace and governs egress through its proxy (deny-by-default + our
# policy). The OpenClaw gateway then runs inside the sandbox; the workshop's
# openclaw-forward sidecar exposes its Control UI (`openshell forward`).
#
# The gateway is only reachable in-cluster (no public Route), so the work runs INSIDE the
# workshop pod (openshell CLI, policies and seed files are baked into its image). Only
# non-secret settings cross over; the inference key stays in the pod's environment.
set -euo pipefail

if [[ "${1:-}" != "--in-pod" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=lib/common.sh
  source "$HERE/lib/common.sh"
  load_env
  require_cmd oc
  NS="${OPENSHELL_NAMESPACE:-openshell}"
  log "Provisioning OpenClaw agent '${OPENCLAW_AGENT_NAME:-shifty}' through deploy/workshop in ${NS}"
  oc -n "$NS" rollout status deploy/workshop --timeout=300s >/dev/null
  exec oc -n "$NS" exec deploy/workshop -c workshop -- env \
    OPENCLAW_AGENT_NAME="${OPENCLAW_AGENT_NAME:-shifty}" \
    OPENCLAW_UI_PORT="${OPENCLAW_UI_PORT:-30789}" \
    OPENCLAW_SANDBOX_IMAGE="${OPENCLAW_SANDBOX_IMAGE:-ghcr.io/ansjindal/openclaw-sandbox:2026.8.2}" \
    OPENCLAW_READY_TIMEOUT="${OPENCLAW_READY_TIMEOUT:-900}" \
    NEMOCLAW_INFERENCE_API="${NEMOCLAW_INFERENCE_API:-openai-completions}" \
    bash -c "$(cat "${BASH_SOURCE[0]}")" 45-openclaw --in-pod
fi

# =========================== inside the workshop pod ===========================
log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
APP=/app
NS="${OPENSHELL_NAMESPACE:-$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace 2>/dev/null || echo openshell)}"
AGENT="${OPENCLAW_AGENT_NAME:-shifty}"
UI_PORT="${OPENCLAW_UI_PORT:-30789}"
GW_PASSWORD="${OPENCLAW_GATEWAY_PASSWORD:-openclaw}"
SANDBOX_IMAGE="${OPENCLAW_SANDBOX_IMAGE:-ghcr.io/ansjindal/openclaw-sandbox:2026.8.2}"
export OPENSHELL_GATEWAY_ENDPOINT="${OPENSHELL_GATEWAY_ENDPOINT_URL:-http://openshell.${NS}.svc.cluster.local:8080}"
REGISTRY_HOST="registry.${NS}.svc.cluster.local"
REGISTRY="${REGISTRY_HOST}:4873"

# Inference (OpenShell 0.1.x): the real endpoint + key live in a gateway-side provider
# (configure_inference in scripts/lib/common.sh: profile maas-openai + provider). The
# sandbox attaches it (--provider) and sees $OPENAI_API_KEY as a placeholder that the
# supervisor proxy swaps for the real key on egress to the profile's endpoint. OpenClaw
# therefore points at the REAL base URL, with the placeholder as its API key.
PROVIDER="${NEMOCLAW_INFERENCE_PROVIDER:-default}"
MODEL="${NEMOCLAW_MODEL:-}"
BASE_URL="${NEMOCLAW_INFERENCE_BASE_URL:-}"
INFERENCE_API="${NEMOCLAW_INFERENCE_API:-openai-completions}"
PROVIDER_ARGS=()
CONFIGURED=false
if openshell provider list --names </dev/null 2>/dev/null | grep -qx "$PROVIDER"; then
  PROVIDER_ARGS=(--provider "$PROVIDER")
  [[ -n "$MODEL" && -n "$BASE_URL" ]] && CONFIGURED=true
else
  warn "Inference provider '${PROVIDER}' not on the gateway — OpenClaw deploys UNCONFIGURED (add a model in the UI)."
fi

ox() { openshell sandbox exec -n "$AGENT" -- "$@" </dev/null; }
phase() { openshell sandbox get "$AGENT" -o json </dev/null 2>/dev/null | jq -r '.phase // empty' 2>/dev/null || true; }

# --- egress policy (deny-by-default). The registry host carries this namespace (the proxy
#     does not resolve single-label hosts). A sandbox without --policy never becomes Ready.
POLICY="$(mktemp /tmp/openclaw-policy.XXXXXX)"
trap 'rm -f "$POLICY"' EXIT
sed "s/registry\.openshell\.svc\.cluster\.local/${REGISTRY_HOST}/g" "$APP/policies/openclaw-sandbox.yaml" > "$POLICY"

log "Creating gateway sandbox '${AGENT}' from ${SANDBOX_IMAGE}"
if [[ -n "$(phase)" ]]; then
  openshell sandbox delete "$AGENT" </dev/null >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do [[ -z "$(phase)" ]] && break; sleep 2; done
fi
# --detach -- sleep infinity: a main process that never exits keeps the sandbox Ready
# (a command that exits leaves it Completed). create returns once the sandbox is Ready.
openshell sandbox create --name "$AGENT" --from "$SANDBOX_IMAGE" --policy "$POLICY" \
  "${PROVIDER_ARGS[@]}" --no-tty --detach -- sleep infinity </dev/null >/tmp/openclaw-create.log 2>&1 &
ready=false
deadline=$(( SECONDS + ${OPENCLAW_READY_TIMEOUT:-900} ))
while (( SECONDS < deadline )); do
  case "$(phase)" in
    Ready) ready=true; break ;;
    Error) break ;;
  esac
  sleep 5
done
if [[ "$ready" != true ]]; then
  warn "Sandbox not Ready (phase: $(phase)) — create log:"; tail -8 /tmp/openclaw-create.log
  exit 1
fi
log "Sandbox Ready after ${SECONDS}s"

# --- point the sandbox's npm at the private registry + provision a publish user ---------
# Skills are npm packages: the @workshop scope AND the default registry resolve to
# Verdaccio. The user is created via the registry's PUT API from INSIDE the sandbox.
REG_USER="${OPENCLAW_REGISTRY_USER:-workshop}"
REG_PASS="${OPENCLAW_REGISTRY_PASSWORD:-wad26-skills}"
log "Provisioning registry user '${REG_USER}' + pointing sandbox npm at ${REGISTRY}"
MKUSER_JS="const http=require(\"http\");const b=JSON.stringify({name:\"${REG_USER}\",password:\"${REG_PASS}\"});const r=http.request(\"http://${REGISTRY}/-/user/org.couchdb.user:${REG_USER}\",{method:\"PUT\",headers:{\"content-type\":\"application/json\",\"content-length\":Buffer.byteLength(b)}},res=>{res.resume();res.on(\"end\",()=>console.log(\"registry user status\",res.statusCode));});r.on(\"error\",e=>console.log(\"registry user ERR\",e.message));r.write(b);r.end();"
ox sh -c "echo $(printf '%s' "$MKUSER_JS" | base64 -w0) | base64 -d > /sandbox/mkuser.js && node /sandbox/mkuser.js" 2>&1 \
  | grep -i 'registry user' || warn "registry user provisioning unclear (see above)"
AUTH_B64="$(printf '%s:%s' "$REG_USER" "$REG_PASS" | base64 -w0)"
NPMRC="registry=http://${REGISTRY}/
@workshop:registry=http://${REGISTRY}/
//${REGISTRY}/:_auth=${AUTH_B64}
"
ox sh -c "echo $(printf '%s' "$NPMRC" | base64 -w0) | base64 -d > /sandbox/.npmrc" || warn "could not seed /sandbox/.npmrc"

# --- DuckDuckGo web search: a separate plugin since OpenClaw 2026.8 (version-matched; the
# gateway refuses to start with an enabled plugin that is missing or lacks capability consent).
DDG_PLUGIN="${OPENCLAW_DDG_PLUGIN:-@openclaw/duckduckgo-plugin@2026.8.2}"
ox sh -c "openclaw plugins install ${DDG_PLUGIN} --accept-capabilities" >/dev/null 2>&1 \
  || warn "Could not install ${DDG_PLUGIN} — web search stays off (see the web-search lesson)."

# --- OpenClaw config (inference + gateway auth) staged into /sandbox ----------------------
if [[ "$CONFIGURED" == true ]]; then
  log "Configuring OpenClaw model custom/${MODEL} -> ${BASE_URL} (key = provider placeholder)"
  OPENCLAW_JSON="$(jq -n \
    --arg url "$BASE_URL" --arg model "$MODEL" \
    --arg api "$INFERENCE_API" --arg pw "$GW_PASSWORD" --arg port "$UI_PORT" \
    --argjson cw "${NEMOCLAW_MODEL_CONTEXT_WINDOW:-65536}" \
    '{
       gateway: { port: ($port | tonumber), auth: { password: $pw }, trustedProxies: ["127.0.0.1/32"],
                  remote: { url: ("ws://127.0.0.1:" + $port), password: $pw },
                  controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
                  http: { endpoints: { chatCompletions: { enabled: true } } } },
       plugins: { entries: { duckduckgo: { enabled: true } } },
       tools:   { web: { search: { provider: "duckduckgo" } } },
       agents:  { defaults: { model: { primary: ("custom/" + $model) } } },
       models:  { providers: { custom: {
         baseUrl: $url, apiKey: "${OPENAI_API_KEY}", api: $api,
         models: [ { id: $model, name: $model, contextWindow: $cw, maxTokens: 4096 } ]
       } } }
     }')"
else
  OPENCLAW_JSON="$(jq -n --arg pw "$GW_PASSWORD" --arg port "$UI_PORT" \
    '{ gateway: { port: ($port | tonumber), auth: { password: $pw }, remote: { password: $pw }, trustedProxies: ["127.0.0.1/32"],
                  controlUi: { dangerouslyAllowHostHeaderOriginFallback: true } } }')"
fi
# apiKey stays the literal ${OPENAI_API_KEY}: OpenClaw substitutes the sandbox's current provider
# placeholder at process start. OpenShell 0.1.x versions that placeholder and stops resolving an old
# one after a provider update, so a copied value would break the agent (restart the gateway instead).
ox sh -c "mkdir -p /sandbox/.openclaw && echo $(printf '%s' "$OPENCLAW_JSON" | base64 -w0) | base64 -d > /sandbox/.openclaw/openclaw.json" \
  || warn "Could not stage openclaw.json."
ox openclaw config validate >/dev/null 2>&1 && log "openclaw.json valid." || warn "openclaw config validate failed."

# --- seed the agent's identity (IDENTITY.md / SOUL.md / BOOTSTRAP.md) ---------------------
SEED_DIR="$APP/manifests/openclaw/workspace-seed"
if [[ -d "$SEED_DIR" ]]; then
  log "Seeding agent workspace identity files"
  for f in "$SEED_DIR"/*; do
    [[ -f "$f" ]] || continue
    ox sh -c "mkdir -p /sandbox/.openclaw/workspace && echo $(base64 -w0 < "$f") | base64 -d > /sandbox/.openclaw/workspace/$(basename "$f")" || true
  done
fi

# --- start the OpenClaw gateway (Control UI + WebSocket) inside the sandbox ---------------
log "Starting the OpenClaw gateway on :${UI_PORT} (auth=password)"
# setsid: own session, so it survives the exec session ending.
start_gw="cd /sandbox && setsid nohup openclaw gateway run --port ${UI_PORT} --bind lan --auth password --password '${GW_PASSWORD}' --allow-unconfigured >/sandbox/gateway.log 2>&1 < /dev/null & echo \$! > /sandbox/gateway.pid"
ox sh -c "${start_gw}; sleep 7; tail -5 /sandbox/gateway.log" || warn "Could not start the OpenClaw gateway."

# --- bootstrap an admin operator device ---------------------------------------------------
# With --auth password the first device pairs with only `operator.pairing`, which cannot
# APPROVE another device. Pair the local operator, grant it the admin scopes in the
# gateway's device table, and restart so the gateway loads them.
log "Bootstrapping an admin operator device (so device-pairing approvals work out of the box)"
ox sh -c "openclaw devices list --url ws://127.0.0.1:${UI_PORT} --password '${GW_PASSWORD}' >/dev/null 2>&1 || true"
sleep 2
BOOTSTRAP_JS='const fs=require("fs");const dir="/sandbox/.openclaw/devices";const p=dir+"/paired.json";if(!fs.existsSync(p)){console.log("no paired devices yet");process.exit(0);}const d=JSON.parse(fs.readFileSync(p,"utf8"));const want=["operator.pairing","operator.admin","operator.approvals","operator.read","operator.write"];for(const k in d){d[k].scopes=want;d[k].approvedScopes=want;if(d[k].tokens&&d[k].tokens.operator){d[k].tokens.operator.scopes=want;}}fs.writeFileSync(p,JSON.stringify(d));try{fs.writeFileSync(dir+"/pending.json","{}");}catch(e){}console.log("admin-bootstrapped "+Object.keys(d).length+" device(s)");'
ox sh -c "echo $(printf '%s' "$BOOTSTRAP_JS" | base64 -w0) | base64 -d > /sandbox/bootstrap-admin.js && node /sandbox/bootstrap-admin.js" \
  || warn "Admin bootstrap step failed — device approvals may need a manual grant."
ox sh -c "cd /sandbox && pkill -f \"^openclaw-gateway\"; sleep 2; pkill -9 -f \"^openclaw-gateway\"; ${start_gw}; sleep 6; grep -E 'listening on ws' /sandbox/gateway.log | tail -1" \
  || warn "Gateway restart after admin bootstrap failed."

log "OpenClaw agent '${AGENT}' is a gateway-managed sandbox in namespace ${NS}:"
openshell sandbox list </dev/null 2>/dev/null | head
log "Control UI password: the workshop's OPENCLAW_GATEWAY_PASSWORD (first browser still needs device pairing approval)"
