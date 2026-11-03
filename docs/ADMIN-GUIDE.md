# Administrator Guide — Running the Sandboxed Agent Fleet Lab

This guide is for the person who prepares and runs the hands-on lab: one OpenShift cluster, N attendees
(tested with 2, sized for 30), each with an isolated copy of the workshop, an OpenShell gateway, an
OpenClaw agent fleet and a demo app, all backed by a self-hosted NVIDIA Nemotron model.

Attendees follow [USER-GUIDE.md](USER-GUIDE.md). The single-instance mode (one copy per cluster) is
described at the end and in the main [README](../README.md).

---

## 1. Architecture

```
                         ONE OpenShift cluster (4.19+, tested on 4.22)
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ SHARED (deployed once)                                                                   │
│  • Observability: COO, OpenTelemetry, Tempo, Logging, Loki operators, UWM, RustFS,        │
│    TempoStack, LokiStack + ClusterLogForwarder, OTEL collector   (scripts/15-observability)│
│  • agent-sandbox v1.0.3 CRD + controller (v1beta1)                                         │
│  • Grafana (namespace monitoring, anonymous Viewer)                                        │
│  • Image prepull DaemonSet (namespace lab-shared)                                          │
│  • Self-hosted inference "MaaS" (scripts/maas.sh):                                         │
│      GPU node(s) + NVIDIA GPU Operator + OpenShift AI 3.5 + Connectivity Link              │
│      Nemotron 3 Nano 30B-A3B FP8 (llm-d / vLLM) → https://maas.<apps-domain>/…  (API keys)  │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ PER ATTENDEE userNN (scripts/lab.sh)                                                      │
│  userNN-openshell: OpenShell 0.1.6 gateway, Verdaccio skill registry, workshop web app +   │
│                    terminal, event-exporter, telemetry-reader SA, sandboxes (agents)       │
│  userNN-demo:      demo shop app (the Incident Lab breaks and fixes it)                    │
│  NetworkPolicies (default-deny ingress), LimitRange, ResourceQuota, least-privilege RBAC   │
│  One MaaS API key (its own token rate limit)                                               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Why one namespace pair per attendee on a shared cluster

- **Cost and operations:** one cluster, one observability stack, one GPU pool, one place to watch.
- **Real isolation where it matters:** every attendee gets their own OpenShell gateway, so providers,
  policies and sandbox names (`shifty`, `lab`, the fleet roles) never collide, and an incident triggered
  by one attendee is invisible to the others (telemetry queries are scoped to the attendee's namespaces).
- **Least privilege:** attendees only act through their workshop terminal, whose ServiceAccount can
  read their own namespaces, manage their own demo app and read a few platform namespaces. It cannot
  exec into pods, read other attendees' namespaces or mint tokens outside its own namespace.
- **Single-instance mode is unchanged:** `scripts/deploy.sh` still deploys one copy in `openshell` +
  `demo`.

---

## 2. Prerequisites

| Item | Requirement |
|---|---|
| Cluster | OpenShift 4.19 or later (OpenShell 0.1.x needs Landlock + nested seccomp; tested on 4.22.18), cluster-admin |
| GPU | One or more NVIDIA GPUs with ≥ 48 GB (L40S, RTX PRO 6000, H100…). On AWS: `g6e.2xlarge` (1× L40S) per replica |
| Workers (CPU) | Measured per attendee: ~0.75 vCPU / ~3 GiB requests, ~14 pods; 30 attendees fit on 3 × m5a.8xlarge for CPU/RAM |
| Volumes | Every sandbox gets a 2 GiB EBS volume: ~8 per attendee (gateway + up to 7 sandboxes). AWS allows ~26 EBS attachments per node → plan ≥ 10 lab nodes for 30 attendees (see §8) |
| Workstation | `oc`, `helm` ≥ 3.17, `yq`, `jq`, `envsubst`, `openssl`, `curl`; `podman` only if you build images locally |
| Network | The workstation only needs the API and `*.apps` routes; all image pulls happen in the cluster |

Log in first (sandbox clusters often use a self-signed API certificate):

```bash
oc login https://api.<cluster-domain>:6443 -u <admin-user>
```

---

## 3. Build the workshop image

The chart default (`quay.io/mmurakam/nemoclaw-workshop:v0.2.9`) predates this version. Build the image
from this revision and point `WORKSHOP_IMAGE` at it.

**Option A — in the cluster (no local container runtime, native amd64):**

```bash
oc new-project lab-build
oc -n lab-build new-build --name nemoclaw-workshop --binary --strategy docker \
   --to nemoclaw-workshop:dev
oc -n lab-build patch bc nemoclaw-workshop --type merge \
   -p '{"spec":{"strategy":{"dockerStrategy":{"dockerfilePath":"web/Dockerfile"}}}}'
oc -n lab-build start-build nemoclaw-workshop --from-dir=. --follow
oc policy add-role-to-group system:image-puller system:serviceaccounts -n lab-build
# WORKSHOP_IMAGE=image-registry.openshift-image-registry.svc:5000/lab-build/nemoclaw-workshop:dev
```

**Option B — podman, then push to a registry the cluster can pull from:**

```bash
podman build --platform linux/amd64 -f web/Dockerfile -t quay.io/<org>/nemoclaw-workshop:<tag> .
podman push quay.io/<org>/nemoclaw-workshop:<tag>
```

The GitHub workflow `build-workshop.yml` publishes to `vars.WORKSHOP_IMAGE_REPO`.

---

## 4. Self-hosted inference (MaaS)

```bash
scripts/maas.sh up        # ~30-45 min on a fresh cluster (GPU node, operators, ~33 GB model pull)
scripts/maas.sh status
scripts/maas.sh keys 30   # one API key per attendee → .lab/maas-keys.csv (mode 600, gitignored)
scripts/maas.sh smoke     # chat completion + tool call through the MaaS gateway
scripts/maas.sh env       # values for .env
```

What `maas.sh up` does (manifests in `deploy/maas/`):

1. Operators: NFD, NVIDIA GPU Operator (v26.7), OpenShift AI (stable-3.x), Red Hat Connectivity Link,
   LeaderWorkerSet.
2. A GPU MachineSet cloned from a worker MachineSet (`MAAS_GPU_INSTANCE_TYPE`, default `g6e.2xlarge`;
   label `node-role.kubernetes.io/gpu`, taint `nvidia.com/gpu=true:NoSchedule`, 200 GB root disk).
3. `DataScienceCluster` with only dashboard, KServe, model registry and Models-as-a-Service enabled.
4. Kuadrant + Authorino TLS, Gateways `openshift-ai-inference` and `maas-default-gateway`
   (`https://maas.<apps-domain>`, using the cluster's default ingress certificate), PostgreSQL for MaaS
   (credentials generated in the cluster, never in git).
5. `LLMInferenceService` **nemotron-3-nano**: `registry.redhat.io/rhai/modelcar-nvidia-nemotron-3-nano-30b-a3b-fp8:3.0`,
   vLLM flags for tool calling (`qwen3_coder`), reasoning parser `nemotron_v3` (reasoning off by
   default), 32k context, FP8 KV cache.
6. `MaaSModelRef`, `MaaSAuthPolicy`, `MaaSSubscription` (group `nemoclaw-lab`, token limit
   `MAAS_TOKENS_PER_MINUTE`, default 5,000,000/min).

Endpoint for clients: `https://maas.<apps-domain>/maas-models/nemotron-3-nano/v1` with model
`nemotron-3-nano` and `Authorization: Bearer sk-oai-…`.

**Capacity:** one L40S keeps roughly 100-150 agent requests in flight (estimate). If 30 attendees press
"Investigate" together (~450 calls), the burst takes several minutes to drain on one GPU. Use
`MAAS_GPU_REPLICAS=2` (two GPU nodes, two model replicas; llm-d routes by prefix-cache affinity) for the
event, and stagger the Incident Lab.

**External endpoint instead:** skip `maas.sh` and set `NEMOCLAW_INFERENCE_BASE_URL`, `NEMOCLAW_MODEL`,
`NEMOCLAW_API_KEY` in `.env` (an OpenAI-compatible endpoint with a publicly trusted certificate, or plain
http in-cluster: the OpenShell proxy only swaps the key placeholder over TLS it can verify).

---

## 5. Configure `.env`

```bash
cp .env.example .env
```

Minimum for a lab with self-hosted inference:

```bash
WORKSHOP_IMAGE="<image from §3>"
NEMOCLAW_INFERENCE_BASE_URL="https://maas.<apps-domain>/maas-models/nemotron-3-nano/v1"
NEMOCLAW_MODEL="nemotron-3-nano"
LAB_INFERENCE_KEYS_FILE="$PWD/.lab/maas-keys.csv"   # one key per attendee
# Optional:
# GHCR_TOKEN=…                      # avoids ghcr.io throttling on the 5.8 GB sandbox image
# LAB_SKIP_OBSERVABILITY=1          # observability stack already deployed
# AGENT_SANDBOX_MIGRATE=1           # replace an old v1alpha1-only agent-sandbox (deletes ALL Sandboxes)
```

`.env` and `.lab/` are gitignored. Never commit keys, passwords or cluster URLs.

---

## 6. Deploy the lab

```bash
# Optional but recommended: dedicate worker nodes to attendee pods (keeps them off control-plane nodes)
oc label node <worker> node-role.kubernetes.io/lab=

scripts/lab.sh up 30 -P 5           # shared components + user01..user30, 5 in parallel
scripts/lab-smoke.sh                # every attendee: /healthz, /api/lab, gateway, demo app
scripts/lab.sh status               # one line per attendee
scripts/lab.sh urls --csv           # .lab/attendees.csv: workshop URL (with access token),
                                    # OpenClaw UI URL + password, Grafana URL
scripts/lab.sh fleet -P 3           # optional: pre-provision every attendee's 5-agent fleet
```

Each attendee's deployment is independent and idempotent (logs in `.lab/logs/<user>.log`); re-run
`scripts/lab.sh user user07` to repair one attendee. Secrets (access token, OpenClaw password) are
generated once, so URLs survive re-runs.

A re-run also **keeps each attendee's existing inference provider**. To push a new key or endpoint,
set `LAB_INFERENCE_UPDATE=1`. OpenShell then re-issues the placeholder (`$OPENAI_API_KEY`) of every
attached sandbox: fleet agents start a fresh process per turn and pick it up, but an attendee's
running OpenClaw gateway (`shifty`) keeps the old one until restarted (step 2 of the **Configure**
lesson). Avoid it during a session.

Hand each attendee **only their own row** of `.lab/attendees.csv` (the URL contains their access token).

---

## 7. During the lab

| Task | Command |
|---|---|
| Overall health | `scripts/lab.sh status` / `scripts/lab-smoke.sh` |
| One attendee is broken | `scripts/lab.sh user userNN` (redeploys, keeps their token and password) |
| After a cluster stop/start | `scripts/maas.sh up` (recreates the stopped GPU node, ~20 min), then `scripts/lab.sh wake` (starts every Stopped sandbox, ~2 min for 9 attendees), then `scripts/lab-smoke.sh` |
| Rebuild one attendee's fleet | `oc -n userNN-openshell exec deploy/workshop -c workshop -- env FLEET_RECREATE=1 bash /app/scripts/fleet.sh up /app/fleet.txt` |
| Model / MaaS health | `scripts/maas.sh status`; GPU usage: console → Observe → Metrics, query `DCGM_FI_DEV_GPU_UTIL` |
| Revoke / re-issue a key | OpenShift AI dashboard → Models-as-a-Service → API keys, then remove the attendee's row from `.lab/maas-keys.csv`, `scripts/maas.sh keys <N>`, `scripts/lab.sh user userNN` |
| Observability | Grafana `https://grafana-monitoring.<apps-domain>/grafana` (dashboard variables `ns` / `demo` per attendee) |

**What attendees can and cannot do** (verified by `web/tests/isolation.spec.ts`):

- Can: run lessons in their terminal, create/delete sandboxes on their own gateway, deploy/break/fix
  their own demo app, read nodes/SCCs/CRDs, read their own telemetry.
- Cannot: read or change other attendees' namespaces, exec into pods, list cluster-wide pods/routes,
  reach another attendee's gateway, registry, sandboxes or demo app (NetworkPolicies), query another
  attendee's metrics or logs, open another attendee's workshop without its token.

---

## 8. Capacity planning (AWS)

Measured on a 9-attendee load test (one cluster, 3 × m5a.8xlarge lab nodes, 1 × L40S):

| Resource | Measured (9 attendees, 47 sandboxes) | 30 attendees | Notes |
|---|---|---|---|
| CPU / memory on lab nodes | 3-4 % CPU, ~10 % memory | fine on 3 × m5a.8xlarge | not a constraint |
| EBS attachments | 57 PVCs; nodes at **26 / 23 / 17** (limit ≈ 26) | ~250 → **≈ 10-11 lab nodes** | **binding constraint** |
| GPU (Nemotron 3 Nano FP8) | 9 simultaneous investigations in **61 s**, no queue (median prompt 3.9k tokens) | ≈ 2-4 min on 1 GPU (estimate) | 2 replicas halve it; or stagger "Investigate" |
| `lab.sh up` | 9 attendees in ~3.5 min (5 in parallel) | ≈ 12 min | |
| Fleet creation | 9 attendees in ~12 min (3 in parallel) | ≈ 40 min (pre-provision before the lab) | re-staging configs: ~20 s |

To add lab nodes, scale a worker MachineSet and label its template:

```bash
oc -n openshift-machine-api scale machineset <worker-machineset> --replicas=<n>
oc label node <new-node> node-role.kubernetes.io/lab=
```

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Workshop pod rejected by SCC (`fsGroup 1000 not allowed`) | Helm drops nulls of a nested subchart; the umbrella `chart/values.yaml` sets `openshell.upstream.podSecurityContext.fsGroup: null` and `securityContext.runAsUser: null`. Keep them. |
| `agent-sandbox CRD serves only v1alpha1` | An old v0.4.x install. Re-run with `AGENT_SANDBOX_MIGRATE=1` (deletes all Sandboxes). OLM-managed CRDs (RHOAI) are reused if they serve v1beta1. |
| Sandbox stuck in `Provisioning`, supervisor logs "Server returned no policy" | A sandbox was created without `--policy`. Always pass a policy (fleet.sh and the lessons do). |
| Model pod `Pending` after a change | With one GPU per replica, a rolling update deadlocks. `scripts/maas.sh up` deletes the old ReplicaSet; manually: `oc -n maas-models delete rs <old-rs>`. |
| vLLM `invalid loads value` | `VLLM_ADDITIONAL_ARGS` is parsed by a shell: quote JSON values with single quotes (see `deploy/maas/60-model.yaml`). |
| MaaS 404 on `/llm/<model>/v1` | The route is `/<namespace>/<model>/v1` (`/maas-models/nemotron-3-nano/v1`); `/v1/models` lists the published ids. |
| `subscription is in Failed phase` when minting keys | The model's HTTPRoute must reference `maas-default-gateway` (set in `60-model.yaml`). |
| `provider profile lint failed: unsupported provider profile file format` | The CLI needs a `.yaml` extension on profile files (fixed in `scripts/lib/common.sh`). |
| Agent turns fail with `HTTP 500 "credential_unavailable"`; sandbox logs show `DENIED … engine:credential-binding` | The agent holds an outdated provider placeholder: a config with a **copy** of the placeholder (configs must say `${OPENAI_API_KEY}`, as `fleet.sh`, `45-openclaw.sh` and the lessons do), or a process started before a provider update. Fleet: `scripts/lab.sh fleet userNN` re-stages it. `shifty`: re-run step 2 of the Configure lesson. |
| `pods "…" is forbidden: exceeded quota` | Raise `isolation.limits.quota.*` in `chart/values-lab.yaml` and `scripts/lab.sh user userNN`. |
| `0/N nodes … max volume count` | EBS attachment limit reached: add lab nodes (§8). |
| `oc` commands time out from your laptop | The scripts retry; for long runs prefer a bastion close to the cluster. |
| After a cluster stop/start, the GPU node (or extra workers) stays `NotReady` with taints `node.kubernetes.io/unreachable` / `…/shutdown` | Instances added after installation stay **stopped** in the cloud and the Machine API does not restart them. `scripts/maas.sh up` recreates stopped GPU machines; for extra workers: `oc -n openshift-machine-api delete machine <stopped-machine>` (its MachineSet creates a new one). Allow ~20 min for the GPU node + driver + model reload before the lab. |

---

## 10. Teardown

```bash
scripts/lab.sh down all              # every attendee (sandboxes, releases, namespaces)
scripts/lab.sh down all --shared     # + lab-shared and the shared Grafana
scripts/maas.sh down                 # model + MaaS objects, GPU MachineSets scaled to 0 (stops GPU cost)
scripts/cleanup.sh                   # single-instance stack + observability releases
```

Operators (observability, GPU, OpenShift AI, Connectivity Link) and the agent-sandbox controller are
cluster-wide and kept; remove them from OperatorHub if the cluster is reused for something else.

---

## 11. Single-instance mode

```bash
cp .env.example .env    # set WORKSHOP_IMAGE and the inference variables
scripts/deploy.sh       # observability, agent-sandbox, Grafana, gateway + workshop (namespace openshell), demo app, fleet
```

Same chart with default values: namespaces `openshell` and `demo`, `pods/exec` allowed, no access token.
