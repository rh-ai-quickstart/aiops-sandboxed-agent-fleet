# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Helm umbrella chart and scripts that deploy NVIDIA OpenShell 0.1.6 + OpenClaw agents onto an existing OpenShift 4.19+ cluster. The deployment also includes the OpenShift operator-based observability stack (Prometheus/Thanos, Loki, Tempo, OTEL Collector), standalone Grafana, and an interactive Next.js workshop website. There are two modes:

- **Single instance** — `scripts/deploy.sh`: one copy per cluster, namespaces `openshell` + `demo`.
- **Lab (multi-tenant)** — `scripts/lab.sh up <N>`: attendees `user01..userNN`, each with `userNN-openshell` (gateway, registry, workshop, sandboxes) + `userNN-demo` (demo app). Shared: observability, agent-sandbox, Grafana (`monitoring`), prepull DaemonSet (`lab-shared`).

Inference comes from any OpenAI-compatible endpoint, or self-hosted with `scripts/maas.sh`: NVIDIA Nemotron 3 Nano 30B-A3B FP8 on a GPU node, served by llm-d/vLLM and published through OpenShift AI 3.5 Models-as-a-Service.

The umbrella chart has three subcharts: `openshell` (wraps upstream chart 0.1.6), `monitoring` (Grafana + event-exporter, installed as its own release), and `workshop` (web app + terminal bridge). Observability operators and backends come from `scripts/15-observability.sh`. Docs: `docs/ADMIN-GUIDE.md` (lab operators), `docs/USER-GUIDE.md` (attendees), `docs/CONTRACT.md` (env/RBAC/inference contract between web and platform).

## Build & CI Commands

### Workshop web app (`web/`, Node 24)
```bash
cd web && npm ci                 # install deps (includes native node-pty addon)
cd web && npm run build          # production build — typechecks TS + parses all MDX lessons
cd web && npm run dev            # dev server on :3000 (custom server.mjs, not next dev)
cd web && npm run lint           # eslint (eslint.config.mjs)
cd web && npm start              # production mode (NODE_ENV=production node server.mjs)
```

### Tests (`web/tests/`, Playwright)
```bash
cd web && npm test               # smoke — local dev server (auto-started), no cluster
cd web && E2E_BASE_URL=https://workshop-<ns>.<apps-domain> npm run test:e2e
cd web && E2E_BASE_URL=https://workshop-user01-openshell.<apps-domain> E2E_ACCESS_TOKEN=<token> \
  E2E_LAB_MODE=1 npm run test:e2e                                  # lab instance
cd web && E2E_BASE_URL=... E2E_ACCESS_TOKEN=<A's token> E2E_PEER_NAMESPACE_PREFIX=user30 \
  npm run test:isolation                                           # attendee A must not reach B
cd web && npm run test:ui        # interactive Playwright UI
```

Three projects (`playwright.config.ts`):
- **smoke** (`smoke.spec.ts`) — local dev server. Homepage, curriculum nav, every lesson page, code-block classification, navigation, 404, `/healthz`, `/api/lab`, `/api/check`, and the lab access gate (cookie via `?token=`, Bearer header, `/ws/term` token + Origin). `SMOKE_ACCESS_TOKEN` starts the dev server with the gate on.
- **e2e** (`e2e.spec.ts`) — live instance (`E2E_BASE_URL`, no default). Header/nav/theme, lesson pages, instance env (`/api/lab`, labrc, openshell CLI → own gateway), access gate, all API routes (GET schemas incl. 0.1.6 draft shape, POST 400), `/grafana` proxy, approvals, and read-only "Run in shell" blocks through `/api/check`. `E2E_ACCESS_TOKEN` is sent as `Authorization: Bearer`. `E2E_LAB_MODE=1` expects lab restrictions (e.g. exec Forbidden). `E2E_RUN_MUTATING=1` also runs the ordered, mutating lesson flow (dedicated test instance only).
- **isolation** (`isolation.spec.ts`) — lab mode. RBAC, network, token and workshop probes from A to B (`E2E_PEER_NAMESPACE_PREFIX`; optional `E2E_PEER_BASE_URL`, `E2E_PEER_SANDBOX_IP`).

Never hardcode a real cluster URL in tests. Pass it via env.

### Helm chart (`chart/`)
```bash
helm repo add grafana-community https://grafana-community.github.io/helm-charts
helm dependency build chart/charts/openshell && helm dependency build chart/charts/monitoring && helm dependency build chart
helm lint chart/ --set openshell.upstream.agentSandbox.preflight.enabled=false
# The upstream Agent Sandbox preflight needs a live cluster: always disable it for offline rendering.
helm template nemoclaw chart/ -n openshell \
  --set openshell.upstream.agentSandbox.preflight.enabled=false --set global.clusterAppsDomain=apps.test.example.com
helm template nemoclaw chart/ -n user01-openshell -f chart/values.yaml -f chart/values-lab.yaml \
  --set openshell.upstream.agentSandbox.preflight.enabled=false --set global.clusterAppsDomain=apps.test.example.com \
  --set global.demoNamespace=user01-demo --set global.lab.user=user01
```

### Container images (podman only)
```bash
podman build --platform linux/amd64 -f web/Dockerfile -t <registry>/nemoclaw-workshop:<tag> .   # from repo root
podman build --build-arg OPENCLAW_VERSION=2026.8.2 images/openclaw-sandbox                      # sandbox image
```
The workshop image must be built from the same revision as the chart. The chart default `v0.2.9` predates it, so set `WORKSHOP_IMAGE`. An in-cluster BuildConfig alternative is in `docs/ADMIN-GUIDE.md` §3.

### Shell scripts (all of `scripts/` incl. `lab.sh`, `lab-smoke.sh`, `maas.sh`)
```bash
shellcheck --severity=warning --external-sources --source-path=SCRIPTDIR scripts/*.sh scripts/lib/*.sh
for f in scripts/*.sh scripts/lib/*.sh; do bash -n "$f"; done
bash scripts/lab.sh --help && bash scripts/lab-smoke.sh --help   # no cluster needed
```

### CI (`.github/workflows/ci.yml`)
1. **web-build** — `npm ci && npm run build` (Node 24)
2. **shellcheck** — all scripts at warning severity, `bash -n`, `lab.sh`/`lab-smoke.sh --help`
3. **yaml-syntax** — all non-template YAML in `manifests/`, `policies/`, `deploy/`, chart values, workflows; `policies/openclaw-sandbox.json` in sync with the YAML; `manifests/demo-app` renders namespace-free
4. **helm** — dependency build, lint (single + lab, monitoring lab values, `deploy/lab-shared`), render single + two lab attendees and check isolation/collisions (`.github/scripts/check-render.py`), lint + render `deploy/observability/*`
5. **docker-build** — workshop `web/Dockerfile` builder stage (CI uses buildx; locally use podman)

## Architecture

### Single instance (`scripts/deploy.sh`)
1. Preflight (`00-preflight.sh`: `oc whoami`, helm, yq, jq, envsubst; inference vars optional, warns only)
2. Observability stack via `15-observability.sh` (skip with `SKIP_OBSERVABILITY=true`)
3. Namespaces out-of-band (`openshell`, `demo`, `monitoring`); `guard_foreign_openshell` refuses a gateway not owned by release `nemoclaw`
4. `ensure_agent_sandbox` (agent-sandbox v1.0.3, see gotchas)
5. `helm_deps_build`, then `helm upgrade --install nemoclaw chart/`. Inference vars go into Secret `workshop-inference` (envFrom), never into Helm values.
6. `configure_inference` — through `oc exec deploy/workshop`: import profile `maas-openai`, create/update provider `$NEMOCLAW_INFERENCE_PROVIDER`
7. Monitoring release `nemoclaw-monitoring` in `monitoring`
8. Demo app (`oc -n $DEMO_NS apply -k manifests/demo-app/`), fleet (`fleet.sh up` inside the workshop pod), optional `45-openclaw.sh` (`PROVISION_AGENT=true`)

### Lab mode (`scripts/lab.sh`)
- `lab.sh shared` (also run by `up`): observability, agent-sandbox, shared Grafana (`chart/charts/monitoring/values-lab.yaml`, anonymous Viewer, admin password in `.lab/`), prepull DaemonSet (`deploy/lab-shared`, namespace `lab-shared`).
- Per attendee (`lab.sh user <u>`, idempotent, logs in `.lab/logs/<u>.log`): namespaces labelled `lab.nemoclaw.io/{managed,user,role}`; Secrets `workshop-access` (`LAB_ACCESS_TOKEN`, random `OPENCLAW_GATEWAY_PASSWORD`) and `lab-inference` (per-attendee key from `LAB_INFERENCE_KEYS_FILE`); `helm upgrade --install nemoclaw chart/ -f values.yaml -f values-lab.yaml`; `configure_inference`; demo app.
- `lab.sh fleet|status|urls [--csv]|down <N|all> [--shared]`; `scripts/lab-smoke.sh` read-only health checks.
- `values-lab.yaml`: NetworkPolicies + LimitRange/ResourceQuota on (`chart/templates/isolation.yaml`), gateway Route off, per-release prepull off, registry emptyDir, `workshop.rbac.allowExec: false`.

### Self-hosted inference (`scripts/maas.sh up|status|keys N|env|smoke|down`, `deploy/maas/`)
NFD, NVIDIA GPU Operator (v26.7), OpenShift AI (stable-3.x / 3.5), Red Hat Connectivity Link, LeaderWorkerSet. The script clones a GPU MachineSet (`g6e.2xlarge`, 1× L40S 48 GB, taint `nvidia.com/gpu`) and sets up a DataScienceCluster (dashboard, KServe, model registry, MaaS), Kuadrant + gateways (`maas-default-gateway` reuses the default ingress cert), and PostgreSQL. It serves `LLMInferenceService` `nemotron-3-nano` (modelcar, vLLM `qwen3_coder` tool calling, `nemotron_v3` reasoning parser) with `MaaSModelRef`/`MaaSAuthPolicy`/`MaaSSubscription` (token limit). The endpoint is `https://maas.<apps-domain>/maas-models/nemotron-3-nano/v1`, model `nemotron-3-nano`, API keys `sk-oai-…` (`keys N` → `.lab/maas-keys.csv`).

### Observability stack (`scripts/15-observability.sh`)
5 operators via `scripts/lib/operator-manager.sh` (Cluster Observability, OpenTelemetry, Tempo, Logging, Loki). UWM via `scripts/lib/enable-uwm.sh`, which merges into an existing `cluster-monitoring-config`; Alertmanager only with `UWM_ENABLE_ALERTMANAGER=true`. Then RustFS (Chainguard images, digest-pinned), TempoStack, LokiStack + ClusterLogForwarder, and OTEL Collector from `deploy/observability/`.

### Helm chart (`chart/`)
- **values.yaml** = single mode; **values-lab.yaml** = lab overrides; **templates/isolation.yaml** = NetworkPolicies, LimitRange, ResourceQuota for the release + demo namespaces.
- **openshell** — wraps `oci://ghcr.io/nvidia/openshell/helm-chart` 0.1.6 (alias `upstream`, `fullnameOverride: openshell`). Adds an optional Route (off), a sandbox prepull Job, and the Verdaccio registry. Sandbox image via `upstream.sandbox.image.*` (0.0.x `server.sandboxImage` is ignored).
- **monitoring** — Grafana (grafana-community chart 14.3.0, `nonroot-v2` SCC grant) + event-exporter; datasources Thanos/Loki/Tempo with bearer auth; Agent Fleet dashboard (vars `ns` / `demo`).
- **workshop** — Deployment + `openclaw-forward` sidecar (`openshell forward` on 30789), Service (3000 + 30789), Routes `workshop-<ns>` / `openclaw-ui-<ns>`, RBAC (ClusterRole `<ns>-workshop` read-only nodes/SCCs/CRDs; namespaced `view` + Role `workshop-self`; demo write; platform-namespace reads; `pods/exec` only if `rbac.allowExec`), `telemetry-reader` SA, per-instance event-exporter watching the demo namespace.

### Monitoring endpoints
All require bearer auth.

| Signal | Service | Port | Path prefix |
|---|---|---|---|
| Metrics (cluster-wide, needs `cluster-monitoring-view`) | `thanos-querier.openshift-monitoring` | 9091 | `/api/v1/query` |
| Metrics (tenancy, namespace-scoped — fleet/workshop) | `thanos-querier.openshift-monitoring` | 9092 | `/api/v1/query?namespace=<ns>` |
| Logs (application) | `logging-loki-gateway-http.openshift-logging` | 8080 | `/api/logs/v1/application/loki/api/v1/` |
| Logs (infrastructure) | `logging-loki-gateway-http.openshift-logging` | 8080 | `/api/logs/v1/infrastructure/loki/api/v1/` |
| Traces (query) | `tempo-tempostack-gateway.observability-hub` | 8080 | `/api/traces/v1/dev/tempo/api/` |
| Traces (OTLP ingest) | `otel-collector-collector.observability-hub` | 4318 | `/v1/traces` |

### Workshop web app (`web/`)
Next.js 16.4.4, React 19.3, MDX lessons. `server.mjs` adds the `/ws/term` terminal bridge (node-pty), `/api/check` (runs a lesson block), ungated `/healthz`, and the optional lab access gate (`LAB_ACCESS_TOKEN`: cookie from `/?token=…` or `Authorization: Bearer`). In-cluster, `oc`/`kubectl`/`openshell` use the projected SA token and `OPENSHELL_GATEWAY_ENDPOINT`.
- `src/lib/lab-env.ts` / `useLabEnv.ts` + `GET /api/lab` — namespaces, lab user, URLs from the env contract (`docs/CONTRACT.md`); never hardcode `openshell`/`demo`
- `src/lib/curriculum.ts` — parts/lessons; each maps to `src/content/<slug>.mdx` (lessons use `$OPENSHELL_NS` / `$DEMO_NS`)
- `src/lib/gateway-grpc.ts` — gRPC client; protos vendored from OpenShell v0.1.6 in `web/proto/` (`openshell`, `datamodel`, `sandbox`, `options`)
- `src/app/api/` — `agent-logs`, `devices`, `drafts`, `fleet`, `incident`, `lab`, `openshell`, `orchestrate`
- `next.config.ts` — MDX, `serverExternalPackages` (node-pty, gRPC), `/grafana` proxy rewrite

### Demo app (`manifests/demo-app/`)
NOT Helm-managed and **namespace-agnostic** (no Namespace object, no `namespace:` fields; CI enforces this). It is applied with `kubectl -n "$DEMO_NAMESPACE" apply -k` / `delete -k` by deploy.sh, lab.sh and `api/incident/route.ts`. Spans carry `k8s.namespace.name`. `manifests/openclaw/demo-app.yaml` is the simpler nginx shop (fleet capstone).

### Fleet (`scripts/fleet.sh` + `fleet.txt`)
Runs **inside the workshop pod** (`oc exec deploy/workshop -c workshop -- bash /app/scripts/fleet.sh up /app/fleet.txt`). It creates logs/metrics/traces/events/analyst sandboxes with per-role policies (`manifests/openclaw/fleet-roles/<role>/`), `--provider`, identity files, the telemetry skill, and a 24h `telemetry-reader` token. `FLEET_RECREATE=1` recreates them.

### Policies (`policies/`)
Deny-by-default OpenShell policies in YAML + JSON (CI checks they match):
```bash
python3 -c "import yaml,json,sys; json.dump(yaml.safe_load(open('policies/openclaw-sandbox.yaml')), sys.stdout, indent=2)" > policies/openclaw-sandbox.json
```

## Key Gotchas

- **agent-sandbox v1.0.3 / `agents.x-k8s.io/v1beta1`** (release asset `sandbox.yaml`). OpenShell 0.1.x does not speak v1alpha1. `ensure_agent_sandbox` reuses an OLM-managed CRD if it serves v1beta1 and never replaces an OLM-owned CRD. It stops on a v1alpha1-only (v0.4.x) install unless `AGENT_SANDBOX_MIGRATE=1`, which deletes ALL Sandboxes cluster-wide. 0.0.x → 0.1.x is a fresh reinstall.
- **restricted-v2, no privileged SCC** — the gateway and sandboxes run under `restricted-v2` (Landlock + nested seccomp → OpenShift 4.19+). Do not re-add SCC grants for OpenShell.
- **Helm nested-null** — `openshell.upstream.podSecurityContext.fsGroup: null` and `securityContext.runAsUser: null` MUST stay in the umbrella `chart/values.yaml`. Helm drops nulls declared in an intermediate subchart, so upstream 1000 leaks through and the pods are rejected (`fsGroup 1000 not allowed`).
- **Sandbox create** — always pass `--policy` (without one, the sandbox is stuck in `Provisioning` with supervisor log "Server returned no policy"). Keep it alive with `--detach -- sleep infinity` (a command that exits → Completed/not Ready). Add `--provider <name>` for inference.
- **Names** — Sandbox CR and pod are `default--<name>`, plus an `os-supervisor-<id>` pod per sandbox. The CLI uses `<name>` (`shifty`); `oc` sees `default--shifty`.
- **Inference** — `inference.local` / `openshell inference set` are gone. Use provider profile `maas-openai` (`manifests/openclaw/inference-profile.yaml.tmpl`, rendered with envsubst) + `openshell provider create --type maas-openai --credential OPENAI_API_KEY`. The sandbox sees a placeholder `$OPENAI_API_KEY` (OpenClaw `baseUrl` = the real URL), and the supervisor swaps the real key on egress. This only works over plain http or a publicly trusted TLS cert (for service-CA endpoints, use the http port).
- **Provider profile CLI** — the file needs a `.yaml` extension (the format is picked from the extension; otherwise "unsupported provider profile file format"). `provider profile update` needs the current `resource_version` (copy it from `provider profile export -o json`).
- **OpenShell CLI 0.1.6** — `OPENSHELL_GATEWAY_ENDPOINT` must be a full `http://` URL. `gateway info` is admin-gated (use `gateway list -o json`). `policy update --add-deny` needs `--rule-name` + `--binary`/`--any-binary`. `gateway add https://<route>` fails without mTLS certs, so use in-cluster http. Draft RPCs need `workspaceScope`, and approval needs `reviewToken`.
- **OpenClaw needs `TMPDIR=/tmp` in 0.1.6 sandboxes** — Landlock allows `/tmp` but not `/var/tmp`. SQLite (OpenClaw session store) tries `/var/tmp` first and fails with `fts5: error creating shadow table … unable to open database file`. Set it wherever OpenClaw is started (fleet.sh, the orchestrate route, the lessons).
- **OpenClaw model entries need explicit `contextWindow` and `maxTokens`** matching the served model (e.g. 32k context for the self-hosted Nemotron). The values are still being tuned.
- **FQDN registry host** — policies must use `registry.<ns>.svc.cluster.local`, because the 0.1.6 proxy does not resolve single-label hosts. Files keep `registry.openshell.svc.cluster.local`, and the workshop entrypoint / fleet.sh rewrite the namespace at runtime.
- **Gateway Route off by default** (`openshell.route.enabled`) — the gateway is plaintext (`disableTls: true`) and unauthenticated. If enabled: edge TLS + `haproxy.router.openshift.io/enable-http2: "true"` for gRPC (passthrough cannot work).
- JWT secret mode must be `0444` (OpenShift's random UID cannot read `0400`).
- `ws://127.0.0.1:30789` in API routes is correct — those commands run inside the sandbox via `openshell sandbox exec`, where 30789 is the local OpenClaw gateway.
- The `nemoclaw` CLI is **not used** — this repo deploys via Helm + CRD directly.
- **Telemetry auth** — Thanos 9091 needs `cluster-monitoring-view` (Grafana, shared `monitoring-reader` only). Fleet agents and the workshop use the per-instance `telemetry-reader` token, valid only on Thanos tenancy port 9092 with `?namespace=` and on Loki/Tempo filtered by namespace.
- **Events in Loki** — the per-instance event-exporter in `<ns>-openshell` watches the demo namespace and writes to stdout (the upstream v1.7 Loki sink hangs on `http.DefaultClient`). Events land in the application tenant under `{kubernetes_namespace_name="<openshell ns>",kubernetes_container_name="event-exporter"}`.
- **MaaS** — the route is `/<namespace>/<model>/v1` (`/maas-models/nemotron-3-nano/v1`), not `/llm/<model>/v1`. The model HTTPRoute must reference `maas-default-gateway`, otherwise minting keys fails with "subscription is in Failed phase".
- **Single-GPU rollout deadlock** — with one GPU per replica, a model rolling update waits forever. `maas.sh up` deletes the old ReplicaSet; manually: `oc -n maas-models delete rs <old-rs>`.
- **`VLLM_ADDITIONAL_ARGS` is shell-parsed** — quote JSON values with single quotes (see `deploy/maas/60-model.yaml`), else vLLM fails with `invalid loads value`.
- **Lab capacity** — every sandbox gets a 2 GiB PVC. On AWS the ~26 EBS attachments per node limit is binding before CPU/RAM.
- **Provider placeholders are versioned** (OpenShell 0.1.x: `openshell:resolve:env:v<rev>_OPENAI_API_KEY`) and re-issued on every provider update; an old one stops resolving (`HTTP 500 credential_unavailable`). OpenClaw configs must keep the literal `${OPENAI_API_KEY}` (substituted at process start), never a copy of the value. `lab.sh` re-runs keep an existing provider unless `LAB_INFERENCE_UPDATE=1`.
- **Cluster stop/start** — instances added after install (GPU node, extra workers) stay `stopped` (`maas.sh up` recreates the GPU machine) and every sandbox comes back `Stopped`/`Error`: run `scripts/lab.sh wake` (`openshell sandbox start` for each).
