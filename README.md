# AIOps on OpenShift — A Sandboxed Agent Fleet for Incident Response

*A Sample Implementation Using OpenShell and OpenClaw*

[![CI](https://github.com/rh-ai-quickstart/aiops-sandboxed-agent-fleet/actions/workflows/ci.yml/badge.svg)](https://github.com/rh-ai-quickstart/aiops-sandboxed-agent-fleet/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/rh-ai-quickstart/aiops-sandboxed-agent-fleet?sort=semver)](https://github.com/rh-ai-quickstart/aiops-sandboxed-agent-fleet/releases/latest)
[![License: MIT](https://img.shields.io/github/license/rh-ai-quickstart/aiops-sandboxed-agent-fleet)](LICENSE)
![OpenShift](https://img.shields.io/badge/OpenShift-4.19%2B-ee0000?logo=redhatopenshift&logoColor=white)
![OpenShell](https://img.shields.io/badge/OpenShell%200.1.6%20·%20OpenClaw-76b900?logo=nvidia&logoColor=white)
![Next.js](https://img.shields.io/badge/site-Next.js%2016-black?logo=nextdotjs)

A fleet of sandboxed AI agents investigates a real application outage on Red Hat OpenShift. Each agent is scoped to exactly one observability backend and governed by a deny-by-default policy. An analyst agent combines their findings into a root-cause diagnosis and a recommended fix.

Inference comes from **any OpenAI-compatible endpoint** (no GPU needed), or from **NVIDIA Nemotron 3 Nano self-hosted on the cluster's GPU** and published through OpenShift AI Models-as-a-Service. You can deploy one instance per cluster, or a **hands-on lab where every attendee gets an isolated copy** on one shared cluster.

> **Running a workshop for many people?** See [Run it as a multi-attendee lab](#run-it-as-a-multi-attendee-lab), then follow the [Administrator Guide](docs/ADMIN-GUIDE.md). Attendees use the [Attendee Guide](docs/USER-GUIDE.md).

Built by Anshul Jindal and Max Murakami.

## Table of Contents

- [Detailed description](#detailed-description)
  - [The SRE use case](#the-sre-use-case)
  - [Architecture diagram](#architecture-diagram)
  - [Workshop curriculum](#workshop-curriculum)
- [Run it as a multi-attendee lab](#run-it-as-a-multi-attendee-lab)
- [Requirements](#requirements)
  - [Minimum hardware requirements](#minimum-hardware-requirements)
  - [Minimum software requirements](#minimum-software-requirements)
- [Deploy](#deploy)
  - [Prerequisites](#prerequisites)
  - [Deployment](#deployment)
  - [Configuration options](#configuration-options)
  - [Validating the deployment](#validating-the-deployment)
  - [Provisioning the OpenClaw agent](#provisioning-the-openclaw-agent)
  - [Delete](#delete)
- [Technical details](#technical-details)
  - [Architecture](#architecture)
  - [Helm chart structure](#helm-chart-structure)
  - [Key design decisions](#key-design-decisions)
  - [Components](#components)
- [Changes in this version](#changes-in-this-version)
- [Reference](#reference)
- [Tags](#tags)

## Detailed description

### The SRE Use Case

An instrumented shop application runs on OpenShift with a continuous load generator. A real dependency, the `payments` microservice, is killed (`kubectl scale deploy/payments --replicas=0`), and checkout requests start failing with connection-refused errors. The error rate climbs to 100%.

Five sealed AI agents investigate the incident in parallel. Each runs in its own sandbox pod with a deny-by-default egress policy:

![Fleet orchestration flow](docs/fleet-orchestration.png)

| Agent | Backend | What it finds |
|-------|---------|---------------|
| **Scout** (logs) | Loki Operator gateway | `"checkout failed: payment call failed"` |
| **Gauge** (metrics) | Thanos Querier (tenancy port) | 5xx spike, request success rate drops to 0% |
| **Trace** (traces) | Tempo gateway | Failing `charge-payment` span in error traces |
| **Probe** (events) | Loki Operator gateway (event-exporter stream) | `payments scaled to 0` Kubernetes event |
| **Sage** (analyst) | None (zero egress) | Combines all findings into a root cause and a fix |

Each specialist can reach only its assigned telemetry backend. It cannot touch the cluster API, other backends, or the internet, and its telemetry token reads only its own instance's namespaces. The analyst has no tools and no egress at all; it only reasons over the other agents' findings. A fixed orchestrator (no LLM "planning" step) sends one prescribed probe to each specialist, collects the results, and hands them to the analyst.

**Outcome:** The analyst concludes that the root cause is a dependency outage (`payments` scaled to zero) and recommends `kubectl scale deploy/payments --replicas=1`. The human reviews, approves, and applies the fix, and the error rate drops to zero. The agents never modify the cluster; they only read telemetry.

The instrumented workload produces all three signal types (metrics, logs, traces). Each specialist agent reads exactly one backend:

![Demo architecture](docs/demo-architecture.png)

This project deploys the full stack needed to run this scenario on an existing OpenShift cluster:

- **OpenShell gateway** (0.1.6): the agent control plane. It manages sandboxed agent pods through the `agent-sandbox` CRD (v1.0.3, `agents.x-k8s.io/v1beta1`).
- **OpenClaw agents**: sandboxed AI agents governed by deny-by-default network and API policies. They run under the default `restricted-v2` SCC, with no privileged access.
- **Observability stack**: OpenShift operator-based monitoring (Prometheus/Thanos Querier, Loki Operator, Tempo Operator, OTEL Collector), plus standalone Grafana for dashboards.
- **Interactive workshop website**: a Next.js app with 30 guided lessons and a live in-browser terminal that walks you through building the entire system from scratch.
- **Optional self-hosted inference** (`scripts/maas.sh`): NVIDIA Nemotron 3 Nano on a cluster GPU, served by llm-d/vLLM, with per-attendee API keys and token rate limits.

The agents never hold the real inference key. A sandbox sees only a placeholder `$OPENAI_API_KEY`, and the OpenShell supervisor swaps in the real key when the request leaves the sandbox for the inference endpoint.

### Architecture Diagram

![Stack diagram](docs/stack-diagram.png)

```
OpenShift cluster (4.19+, tested on 4.22.18)
  ├─ agent-sandbox v1.0.3 CRD + controller (agents.x-k8s.io/v1beta1, ns agent-sandbox-system)
  ├─ openshell namespace                       lab mode: userNN-openshell, one per attendee
  │    ├─ OpenShell 0.1.6 gateway (StatefulSet, plaintext gRPC :8080, in-cluster Service only;
  │    │    optional edge TLS + HTTP/2 Route, off by default)
  │    ├─ Workshop web app (Deployment + openclaw-forward sidecar)
  │    │    ├─ Next.js on port 3000             (Route: workshop-<ns>.<apps-domain>)
  │    │    └─ OpenClaw Control UI on port 30789 (Route: openclaw-ui-<ns>.<apps-domain>)
  │    ├─ Verdaccio skill registry
  │    ├─ telemetry-reader ServiceAccount + event-exporter (watches the demo namespace)
  │    └─ Sandboxes (restricted-v2): pod default--<name> + pod os-supervisor-<id> each
  ├─ demo namespace                            lab mode: userNN-demo
  │    └─ Instrumented shop app (Kustomize)
  ├─ openshift-monitoring (Cluster Monitoring Operator)
  │    └─ Prometheus + user workload monitoring, Thanos Querier (:9091, tenancy :9092)
  ├─ openshift-logging: LokiStack (multi-tenant) + ClusterLogForwarder
  ├─ observability-hub: TempoStack, OTEL Collector, RustFS (S3 for Loki + Tempo)
  ├─ monitoring: Grafana (Route: grafana-monitoring.<apps-domain>/grafana; lab: anonymous Viewer)
  │              + event-exporter
  ├─ lab-shared (lab mode only): image prepull DaemonSet on every lab node
  └─ Self-hosted inference (optional, scripts/maas.sh)
       ├─ GPU MachineSet (g6e.2xlarge, 1× NVIDIA L40S 48 GB) + NFD + NVIDIA GPU Operator v26.7
       ├─ OpenShift AI 3.5 (Models-as-a-Service) + Red Hat Connectivity Link + LeaderWorkerSet
       └─ maas-models: Nemotron 3 Nano 30B-A3B FP8 (llm-d LLMInferenceService, vLLM tool calling)
            → https://maas.<apps-domain>/maas-models/nemotron-3-nano/v1   (API keys sk-oai-…)
```

### Workshop Curriculum

The workshop is organized into seven parts with 30 lessons:

| Part | Topic | Lessons |
|------|-------|---------|
| **I. Welcome** | The event, the platform, what you need | 2 |
| **II. What's Already Running** | Inspect the deployed stack with `oc` | 4 |
| **III. How OpenShell Works** | Control plane, policies, sandbox lifecycle | 2 |
| **IV. Build Your Agent** | Register inference, create, configure, and talk to an OpenClaw agent | 6 |
| **V. Make It Yours & Operate** | Identity, tools, skills, heartbeat, OpenAI API | 6 |
| **VI. Build Something Useful** | Capstone: multi-agent SRE copilot fleet | 6 |
| **VII. Reference** | Live views, observability, troubleshooting | 4 |

Most lessons include a live in-browser terminal connected to the cluster for hands-on exercises. The lessons use `$OPENSHELL_NS` and `$DEMO_NS`, so the same content works in single-instance mode (`openshell` / `demo`) and in lab mode (`userNN-openshell` / `userNN-demo`).

## Run it as a multi-attendee lab

`scripts/lab.sh up <N>` deploys N attendees (`user01` … `userNN`) on **one** OpenShift cluster. Each attendee gets a namespace pair:

- **`userNN-openshell`**: their own OpenShell gateway, Verdaccio skill registry, workshop web app and terminal, event-exporter, `telemetry-reader` ServiceAccount, and sandboxes (agents).
- **`userNN-demo`**: their own demo shop app, which the Incident Lab breaks and fixes.

The observability stack, the agent-sandbox controller, Grafana (anonymous Viewer), the image prepull DaemonSet (`lab-shared`), and the optional self-hosted model are deployed **once** and shared.

**Why one namespace pair per attendee on a shared cluster:**

- **Cost and operations:** one cluster, one observability stack, one GPU pool, and one place to watch.
- **Isolation where it matters:** each attendee has their own gateway, so providers, policies and sandbox names (`shifty`, `lab`, the fleet roles) never collide. An incident one attendee triggers is invisible to the others, because telemetry is scoped per namespace (Thanos tenancy port 9092, Loki and Tempo filtered by namespace).
- **Least privilege:** attendees act only through their workshop terminal. Its ServiceAccount can read its own namespaces, manage its own demo app, and read a few platform namespaces. It has no cluster-wide exec and cannot read other attendees' namespaces. NetworkPolicies (default-deny ingress), a LimitRange and a ResourceQuota fence each namespace, and each workshop sits behind its own access token.
- **Single-instance mode is unchanged:** `scripts/deploy.sh` still deploys one copy in `openshell` + `demo`.

Quick start (details, sizing and troubleshooting are in the [Administrator Guide](docs/ADMIN-GUIDE.md)):

```bash
cp .env.example .env              # set WORKSHOP_IMAGE (see "Build the workshop image")
scripts/maas.sh up                # optional: self-hosted Nemotron on a GPU node (~30-45 min)
scripts/maas.sh keys 30           # one MaaS API key per attendee -> .lab/maas-keys.csv
scripts/maas.sh env               # NEMOCLAW_INFERENCE_BASE_URL / NEMOCLAW_MODEL for .env;
                                  # also set LAB_INFERENCE_KEYS_FILE="$PWD/.lab/maas-keys.csv"
scripts/lab.sh up 30 -P 5         # shared components + user01..user30, 5 in parallel
scripts/lab-smoke.sh              # per-attendee health checks
scripts/lab.sh urls --csv         # .lab/attendees.csv: workshop URL (with token), OpenClaw UI + password, Grafana
```

Give each attendee **only their own row** of `.lab/attendees.csv`, because the URL contains their access token. The [Attendee Guide](docs/USER-GUIDE.md) explains what they receive, how to use the workshop, and the shared-cluster rules.

## Requirements

### Minimum hardware requirements

**Single instance:**
- 2 worker nodes (or 3+ control-plane nodes with scheduling enabled)
- 4 vCPU / 16 GiB memory per worker (for the observability stack + OpenShell + workshop)
- A default StorageClass: every sandbox gets a 2 GiB workspace volume

**Lab mode (measured):**
- Per attendee: about 0.75 vCPU / 3 GiB of requests, about 14 pods (+1 supervisor pod per sandbox), and about 8 volumes
- 30 attendees fit on 3 × m5a.8xlarge for CPU and memory. On AWS the EBS attachment limit (about 26 per node) is the binding constraint, so plan at least 10 lab nodes for 30 attendees. See [ADMIN-GUIDE §8](docs/ADMIN-GUIDE.md#8-capacity-planning-aws).

**GPU: optional.** Only needed for self-hosted inference. You need one NVIDIA GPU with at least 48 GB per model replica (for example L40S, RTX PRO 6000, H100). On AWS, `scripts/maas.sh` creates a `g6e.2xlarge` (1× L40S) MachineSet. Use two replicas for 30 attendees. With a remote OpenAI-compatible endpoint, no GPU is needed.

### Minimum software requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Red Hat OpenShift | 4.19 or later | OpenShell 0.1.x needs Landlock + nested seccomp. Tested on 4.22.18. `cluster-admin` access. |
| `oc` CLI | Matching cluster version | Logged in (`oc login`) |
| `helm` CLI | 3.17 or later (3.18+ recommended) | CI uses v3.22.1; the preflight warns below 3.18 |
| `yq`, `jq`, `envsubst`, `openssl`, `curl` | Any | Used by the deploy, lab and operator scripts |
| `podman` | Any | Only to build images locally |
| Inference | — | An OpenAI-compatible endpoint (`/v1/chat/completions`) with a publicly trusted certificate or plain http, **or** a GPU for `scripts/maas.sh` |

### Why cluster-admin access is required

The deployment creates several cluster-scoped resources that only a `cluster-admin` can manage:

| Category | Resource | Why it's needed |
|----------|----------|-----------------|
| **CRDs** | `sandboxes.agents.x-k8s.io` (agent-sandbox v1.0.3, `v1beta1`) | The OpenShell gateway's Kubernetes driver manages sandbox pods through this CRD. `ensure_agent_sandbox` reuses an OLM-managed CRD that serves `v1beta1` and never replaces an operator's CRD. |
| **Operators** | 5 OLM Subscriptions (Cluster Observability, OpenTelemetry, Tempo, Logging, Loki) | Provide the observability stack. Each operator creates its own CRDs and controllers. |
| **Operators (optional)** | NFD, NVIDIA GPU Operator, OpenShift AI, Red Hat Connectivity Link, LeaderWorkerSet | Self-hosted inference (`scripts/maas.sh`) |
| **Machine API (optional)** | GPU MachineSet in `openshift-machine-api` | Cloned from a worker MachineSet by `scripts/maas.sh` |
| **Namespaces** | `openshell`, `demo`, `monitoring`, `observability-hub` (lab: `userNN-openshell`, `userNN-demo`, `lab-shared`) | Created out-of-band (not Helm-managed), so `helm uninstall` does not delete them along with the non-Helm resources inside. |
| **Cluster config** | `cluster-monitoring-config` ConfigMap in `openshift-monitoring` | Enables User Workload Monitoring. The script merges `enableUserWorkload: true` into any existing config, and the UWM Alertmanager is opt-in. |
| **ClusterRoles** | `<namespace>-workshop` | Read-only access to nodes, SCCs and CRDs for the workshop lessons. Everything else is namespaced: `view` + a Role in its own namespace, write access to the demo namespace, read access to a few platform namespaces, and `pods/exec` only in single-instance mode. |
| **ClusterRoles** | `<namespace>-telemetry-reader` | Bound with RoleBindings **only** in the instance's two namespaces. The fleet agents' 24h token comes from this ServiceAccount. |
| **ClusterRoleBindings** | `*-monitoring-view`, `*-grafana-monitoring-view`, `*-monitoring-reader-view`, `*-loki-tenant` | Let Grafana and the shared `monitoring-reader` query Thanos Querier, the Loki gateway and the Tempo gateway. |
| **ClusterRoles** | `openshell-node-reader-<namespace>` (upstream chart) | Lets the gateway create `TokenReview`s (sandbox bootstrap) and read cluster-scoped scheduling objects. Unique per release namespace. |
| **SCC grants** | `nonroot-v2` SCC → `grafana` SA | Grafana runs as UID 472. **No privileged SCC**: the gateway and the sandboxes run under `restricted-v2`. |

**Cluster config read:** the scripts also read the cluster-scoped `ingresses.config/cluster` resource to detect the `*.apps` domain for Route hostnames. To skip this, set `CLUSTER_APPS_DOMAIN` in `.env`.

## Deploy

### Prerequisites

Before deploying, make sure you have:

1. Access to a Red Hat OpenShift 4.19+ cluster with `cluster-admin` privileges
2. `oc` CLI installed and logged in to the cluster (`oc login https://api.<cluster-domain>:6443`)
3. `helm` (3.17+, 3.18+ recommended), `yq`, `jq`, `envsubst`, `openssl` and `curl` installed
4. An inference source: an OpenAI-compatible endpoint (e.g. [NVIDIA NIM](https://build.nvidia.com/), OpenAI, Azure OpenAI, vLLM) **or** a GPU node for the self-hosted model

### Deployment

1. **Clone the repository and navigate to its root folder.**

2. **Build the workshop image.** The chart default (`quay.io/mmurakam/nemoclaw-workshop:v0.2.9`) predates this version. Build the image from this revision (`web/Dockerfile`) and point `WORKSHOP_IMAGE` at it.

   In the cluster (no local container runtime needed):

   ```bash
   oc new-project lab-build
   oc -n lab-build new-build --name nemoclaw-workshop --binary --strategy docker --to nemoclaw-workshop:dev
   oc -n lab-build patch bc nemoclaw-workshop --type merge \
      -p '{"spec":{"strategy":{"dockerStrategy":{"dockerfilePath":"web/Dockerfile"}}}}'
   oc -n lab-build start-build nemoclaw-workshop --from-dir=. --follow
   oc policy add-role-to-group system:image-puller system:serviceaccounts -n lab-build
   # WORKSHOP_IMAGE=image-registry.openshift-image-registry.svc:5000/lab-build/nemoclaw-workshop:dev
   ```

   Or with podman, then push to a registry the cluster can pull from:

   ```bash
   podman build --platform linux/amd64 -f web/Dockerfile -t quay.io/<org>/nemoclaw-workshop:<tag> .
   podman push quay.io/<org>/nemoclaw-workshop:<tag>
   ```

3. **Configure your environment:**

   ```bash
   cp .env.example .env
   ```

   Then fill in the workshop image and **one** inference source.

   **Option A: a remote OpenAI-compatible endpoint**

   ```bash
   WORKSHOP_IMAGE="quay.io/<org>/nemoclaw-workshop:<tag>"
   NEMOCLAW_INFERENCE_BASE_URL="https://<inference-host>/v1"   # publicly trusted TLS, or plain http in-cluster
   NEMOCLAW_MODEL="<model-id>"
   NEMOCLAW_API_KEY="<your-api-key>"
   ```

   **Option B: self-hosted Nemotron 3 Nano on the cluster's GPU**

   ```bash
   scripts/maas.sh up        # NFD, GPU Operator, OpenShift AI 3.5, Connectivity Link, GPU node, model
   scripts/maas.sh status
   scripts/maas.sh keys 1    # mints an API key (sk-oai-…) -> .lab/maas-keys.csv (mode 600, gitignored)
   scripts/maas.sh smoke     # chat completion + tool call through the MaaS gateway
   scripts/maas.sh env       # prints the values below
   ```

   ```bash
   NEMOCLAW_INFERENCE_BASE_URL="https://maas.<apps-domain>/maas-models/nemotron-3-nano/v1"
   NEMOCLAW_MODEL="nemotron-3-nano"
   NEMOCLAW_API_KEY="<key from .lab/maas-keys.csv>"   # lab mode: LAB_INFERENCE_KEYS_FILE instead
   ```

   The OpenShell proxy swaps in the real key only over plain http or TLS it can verify. That is why the MaaS gateway reuses the cluster's default ingress certificate, which must be publicly trusted.

4. **Deploy.** Choose one mode.

   **Single instance** (one copy per cluster, namespaces `openshell` + `demo`):

   ```bash
   ./scripts/deploy.sh
   ```

   The script:
   - Runs preflight checks (login, CLI tools, inference settings)
   - Deploys the observability stack (5 operators, UWM, RustFS object storage, TempoStack, LokiStack, OTEL Collector, waits for TempoStack/LokiStack Ready), unless `SKIP_OBSERVABILITY=true`
   - Creates the `openshell`, `demo` and `monitoring` namespaces out-of-band, and refuses to install over an OpenShell gateway it does not own
   - Ensures agent-sandbox v1.0.3 (`ensure_agent_sandbox`). It reuses a compatible install, including an OLM-managed CRD that serves `v1beta1`, and never touches an OLM-owned CRD. It stops on a `v1alpha1`-only CRD unless `AGENT_SANDBOX_MIGRATE=1`.
   - Builds the chart dependencies and installs the **openshell + workshop** release (`nemoclaw`) in `openshell`. The inference settings go into a Secret, never into Helm values.
   - Registers the inference provider on the gateway: provider profile `maas-openai` + `openshell provider create --type maas-openai`
   - Installs the **monitoring** release (Grafana + event-exporter) in `monitoring`
   - Applies the demo app to `demo` and brings up the 5-agent fleet from inside the workshop pod (turn these off with `DEPLOY_DEMO_APP=false` / `DEPLOY_FLEET=false`)

   **Lab mode** (N attendees on one cluster):

   ```bash
   scripts/lab.sh up 30 -P 5
   ```

   See [Run it as a multi-attendee lab](#run-it-as-a-multi-attendee-lab) and the [Administrator Guide](docs/ADMIN-GUIDE.md).

5. **Access the workshop (single instance):**

   ```bash
   DOMAIN="$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}')"
   echo "Workshop:  https://workshop-openshell.${DOMAIN}/"
   echo "Grafana:   https://grafana-monitoring.${DOMAIN}/grafana"
   echo "Console:   https://console-openshift-console.${DOMAIN}/"
   ```

   Open the workshop URL in your browser and follow the guided lessons. In lab mode, each attendee gets `https://workshop-userNN-openshell.<apps-domain>/?token=…` from `scripts/lab.sh urls --csv`.

### Configuration Options

All configuration goes through `.env`, which `deploy.sh`, `lab.sh` and `maas.sh` source (see [`.env.example`](.env.example)). Never commit the filled-in `.env` or `.lab/`.

**Common**

| Variable | Default | Description |
|----------|---------|-------------|
| `CLUSTER_APPS_DOMAIN` | Auto-detected | The cluster's `*.apps` domain for Route hostnames |
| `NEMOCLAW_INFERENCE_BASE_URL` | — | OpenAI-compatible base URL. Its host/port become the endpoint of the provider profile `maas-openai`. Blank = agents deploy without a model. |
| `NEMOCLAW_MODEL` | — | Model ID served by the endpoint |
| `NEMOCLAW_API_KEY` | — | Key for the endpoint (stored in a Secret, never in Helm values) |
| `NEMOCLAW_INFERENCE_PROVIDER` | `default` | OpenShell provider name the sandboxes attach (`--provider`) |
| `NEMOCLAW_INFERENCE_API` | `openai-completions` | OpenClaw provider API flavour |
| `OPENCLAW_GATEWAY_PASSWORD` | `openclaw` | OpenClaw Control UI password (single instance; lab mode generates one per attendee) |
| `MONITORING_GRAFANA_PASSWORD` | `openclaw` (lab: generated) | Grafana admin password |
| `GHCR_USER` / `GHCR_TOKEN` | Anonymous | GitHub PAT with `read:packages`. Creates Secret `ghcr-pull` to avoid ghcr.io throttling on the multi-GB sandbox image. |
| `WORKSHOP_IMAGE` | Chart default | Workshop image built from this revision (`web/Dockerfile`) |
| `OPENCLAW_SANDBOX_IMAGE` | `ghcr.io/ansjindal/openclaw-sandbox:2026.8.2` | OpenClaw sandbox image (`images/openclaw-sandbox`) |
| `AGENT_SANDBOX_VERSION` | `v1.0.3` | agent-sandbox release applied when none is installed |
| `AGENT_SANDBOX_MIGRATE` | `0` | `1` replaces an old `v1alpha1`-only agent-sandbox install. **This deletes ALL Sandboxes cluster-wide.** |

**Single instance (`scripts/deploy.sh`)**

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSHELL_NAMESPACE` | `openshell` | Gateway, registry, workshop, sandboxes |
| `DEMO_NAMESPACE` | `demo` | Demo app (Incident Lab) |
| `MONITORING_NAMESPACE` | `monitoring` | Grafana + event-exporter (shared in lab mode) |
| `SKIP_OBSERVABILITY` | `false` | `true` skips `scripts/15-observability.sh` |
| `DEPLOY_DEMO_APP` | `true` | Apply `manifests/demo-app` to the demo namespace |
| `DEPLOY_FLEET` | `true` | Pre-create the 5 fleet agents |
| `PROVISION_AGENT` | `false` | Also pre-create the `shifty` agent (`scripts/45-openclaw.sh`) |
| `UWM_ENABLE_ALERTMANAGER` | `false` | Also enable the user-workload Alertmanager |

**Lab mode (`scripts/lab.sh`)**

| Variable | Default | Description |
|----------|---------|-------------|
| `LAB_USER_PREFIX` | `user` | Attendees `user01` … `userNN` |
| `LAB_NODE_SELECTOR` | `node-role.kubernetes.io/lab=` | Keeps lab pods on labelled workers; `none` = off; ignored when no node has the label |
| `LAB_INFERENCE_KEYS_FILE` | — | CSV `user,key[,model[,base_url]]` with per-attendee keys (e.g. `.lab/maas-keys.csv`) |
| `LAB_SKIP_OBSERVABILITY` | — | `1` = observability stack already deployed |
| `LAB_DEMO_APP` | `true` | Deploy the demo app per attendee |
| `LAB_HELM_TIMEOUT` | `15m` | Helm timeout per attendee |
| `LAB_PREPULL_TIMEOUT` | `1800` | Seconds to wait for the prepull DaemonSet |

**Self-hosted inference (`scripts/maas.sh`)**

| Variable | Default | Description |
|----------|---------|-------------|
| `MAAS_GPU_INSTANCE_TYPE` | `g6e.2xlarge` | GPU node type (1× L40S 48 GB; the FP8 model is 32.7 GB) |
| `MAAS_GPU_REPLICAS` | `1` | GPU nodes = model replicas; 2 recommended for 30 attendees |
| `MAAS_GPU_SOURCE_MACHINESET` | First worker MachineSet | MachineSet to clone for the GPU node |
| `MAAS_GPU_DISK_GB` | `200` | GPU node root disk |
| `MAAS_TOKENS_PER_MINUTE` | `5000000` | `MaaSSubscription` token rate limit |
| `MAAS_KEY_OWNER` | `oc whoami` | OpenShift user that mints the keys |

**Notable chart values** (`chart/values.yaml`; lab overrides in `chart/values-lab.yaml`)

| Value | Single | Lab | Description |
|-------|--------|-----|-------------|
| `openshell.route.enabled` | `false` | `false` | Public Route to the (unauthenticated) gateway. Keep it off; in-cluster callers use the Service. |
| `isolation.networkPolicies.enabled` | `false` | `true` | Default-deny ingress + same-namespace / router / monitoring allowances |
| `isolation.limits.enabled` | `false` | `true` | LimitRange + ResourceQuota in both namespaces (`isolation.limits.quota.*`) |
| `workshop.rbac.allowExec` | `true` | `false` | `pods/exec` for the workshop terminal |
| `openshell.sandboxPrepull.enabled` | `true` | `false` | Per-release prepull Job (lab: shared DaemonSet in `lab-shared`) |
| `global.demoNamespace` | `demo` | `userNN-demo` | Demo app namespace |

### Validating the Deployment

Single instance:

```bash
# All pods Running (each sandbox = pod default--<name> + pod os-supervisor-<id>)
oc get pods -n openshell
oc get pods -n monitoring
oc get pods -n observability-hub
oc get pods -n openshift-logging

# Sandbox API: must list v1beta1
oc get crd sandboxes.agents.x-k8s.io -o jsonpath='{.spec.versions[*].name}{"\n"}'

DOMAIN="$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}')"

# Workshop health (ungated endpoint)
curl -sk -o /dev/null -w '%{http_code}\n' "https://workshop-openshell.${DOMAIN}/healthz"

# Gateway readiness + version (through the workshop API)
curl -sk "https://workshop-openshell.${DOMAIN}/api/openshell"

# Sandboxes as the gateway sees them (openshell CLI baked into the workshop image)
oc -n openshell exec deploy/workshop -c workshop -- openshell sandbox list
```

Expected output from `/api/openshell`:

```json
{"ok":true,"namespace":"openshell","gateway":{"ready":true,"version":"0.1.6"},"sandboxes":[...],"inference":...,"at":"..."}
```

Lab mode:

```bash
scripts/lab-smoke.sh        # per attendee: /healthz, /api/lab (with the access token), gateway Ready, demo app Ready
scripts/lab.sh status   # lab.sh wake: restart sandboxes after a cluster stop/start       # one line per attendee: workshop, gateway, sandboxes, demo
scripts/maas.sh status      # GPU nodes, OpenShift AI, model and MaaS readiness (self-hosted inference)
```

The Playwright suites in `web/tests/` also run against a live deployment: `e2e` (any instance) and `isolation` (lab mode, attendee A must not reach attendee B). See `web/playwright.config.ts`.

### Provisioning the OpenClaw Agent

By default, `deploy.sh` brings up the 5-agent SRE fleet but not the `shifty` agent from Part IV. To provision `shifty`:

**Option A: auto-provision during deploy**
```bash
PROVISION_AGENT=true ./scripts/deploy.sh
```

**Option B: provision after deploy** (runs inside the workshop pod, which has the `openshell` CLI and reaches the gateway in-cluster)
```bash
./scripts/45-openclaw.sh
```

**Option C: follow the workshop.** Part IV walks you through creating the agent step by step from the in-browser terminal.

Every sandbox is created with `--policy` (without one it stays in `Provisioning`), `--provider` (inference), and `--detach -- sleep infinity` (keeps it Ready). Once the agent is provisioned, the OpenClaw Control UI is available at:

```bash
echo "https://openclaw-ui-openshell.$(oc get ingresses.config/cluster -o jsonpath='{.spec.domain}')/"
```

In lab mode, `scripts/lab.sh fleet -P 3` pre-provisions every attendee's fleet.

### Delete

```bash
scripts/lab.sh down all            # lab: every attendee (sandboxes, releases, both namespaces)
scripts/lab.sh down all --shared   # lab: + lab-shared and the shared Grafana release
scripts/maas.sh down               # self-hosted inference: model + MaaS objects, GPU MachineSets scaled to 0
./scripts/cleanup.sh               # single instance: sandboxes, Helm releases, demo app,
                                   # observability releases, cluster-scoped RBAC, namespaces
```

> **Note:** these scripts do not remove the agent-sandbox CRD/controller or any operators (observability, GPU, OpenShift AI, Connectivity Link), because those are shared cluster resources. `maas.sh down` keeps the operators, OpenShift AI and PostgreSQL. See below for manual removal.

**Remove the agent-sandbox CRD and controller (optional)**

Only remove these if no other users or projects depend on them, and never when the CRD is managed by OLM (for example by OpenShift AI's agent-sandbox operator):

```bash
oc delete -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.3/sandbox.yaml" --ignore-not-found
```

**Remove the observability operators (optional)**

Only remove these if no other projects on the cluster depend on them. Uninstall each operator with the operator manager script:

```bash
HERE="$(pwd)/scripts/lib"

# Uninstall in reverse dependency order
"$HERE/operator-manager.sh" -u otel -n openshift-opentelemetry-operator
"$HERE/operator-manager.sh" -u tempo -n openshift-tempo-operator
"$HERE/operator-manager.sh" -u logging -n openshift-logging
"$HERE/operator-manager.sh" -u loki -n openshift-operators-redhat
"$HERE/operator-manager.sh" -u observability -n openshift-cluster-observability-operator
```

> **Note:** Operator uninstall preserves CRDs by design (OLM best practice). To fully remove operator CRDs, delete them manually with `oc delete crd <crd-name>`. Be aware that this cascade-deletes all custom resources of that type cluster-wide.

The self-hosted inference operators (NFD, NVIDIA GPU Operator, OpenShift AI, Connectivity Link, LeaderWorkerSet) can be removed from OperatorHub if the cluster is reused for something else.

## Technical Details

### Architecture

**What this is (and isn't):** this stack is **OpenShell + OpenClaw on OpenShift**. NemoClaw is a reference layer (CLI + blueprint + policies) with no gateway of its own; the gateway *is* OpenShell's. The `nemoclaw` CLI is **not used** here. This repo deploys with Helm and the agent-sandbox CRD directly.

| Gateway | Port | Role |
|---------|------|------|
| **OpenShell gateway** | 8080 | Sandbox control plane (gRPC), plaintext, in-cluster Service only |
| **OpenClaw gateway** | 30789 | Agent's own Control UI, inside the sandbox; exposed by the workshop's `openclaw-forward` sidecar (`openshell forward`) |

The OpenClaw agent runs under a **deny-by-default policy** at two layers:
- **L4 (network):** Kubernetes NetworkPolicies. The upstream chart restricts SSH ingress on sandbox pods to the gateway. In lab mode, `chart/templates/isolation.yaml` adds default-deny ingress per attendee namespace and keeps sandbox workload pods reachable only by their supervisor.
- **L7 (application):** the OpenShell supervisor proxy enforces the per-binary/host/method/path policies in [`policies/`](policies/) and `manifests/openclaw/fleet-roles/*/policy.yaml`. It also swaps the inference-key placeholder for the real key, but only toward the provider profile's endpoint.

![Security layers](docs/security-layers.png)

![Policy explorer](docs/policy-explorer.png)

### Helm Chart Structure

```
chart/
├── Chart.yaml           # umbrella chart (3 local subcharts)
├── values.yaml          # defaults = single-instance mode (global.*, isolation.* off, Helm nested-null fix)
├── values-lab.yaml      # lab overrides: isolation on, gateway Route + per-release prepull off, no exec
├── templates/
│   └── isolation.yaml   # NetworkPolicies + LimitRange/ResourceQuota for the release and demo namespaces
└── charts/
    ├── openshell/       # wraps oci://ghcr.io/nvidia/openshell/helm-chart 0.1.6 (alias upstream)
    │   └── templates/   # optional Route (edge TLS + HTTP/2, off), sandbox prepull Job, Verdaccio registry
    ├── monitoring/      # Grafana (grafana-community chart 14.3.0) + event-exporter, separate release
    │   ├── values-lab.yaml  # anonymous Viewer for attendees
    │   └── templates/   # Grafana Route, datasources (Thanos/Loki/Tempo), RBAC, nonroot-v2 SCC grant
    └── workshop/        # containerized Next.js web app
        └── templates/   # Deployment (+ openclaw-forward sidecar), Service, Routes, RBAC (cluster read-only
                         # + namespaced), telemetry-reader SA, per-instance event-exporter

deploy/
├── observability/       # RustFS object storage, TempoStack, LokiStack + ClusterLogForwarder, OTEL Collector charts
├── lab-shared/          # lab mode: image prepull DaemonSet (namespace lab-shared)
└── maas/                # self-hosted inference: operators, NFD, GPU ClusterPolicy, DataScienceCluster,
                         # Kuadrant + LWS, gateways, PostgreSQL, Nemotron LLMInferenceService, MaaS access
```

The observability backends are deployed separately from `deploy/observability/`, not as subcharts, because they target other namespaces (`observability-hub`, `openshift-logging`).

The monitoring subchart is a **separate Helm release** (`nemoclaw-monitoring`) in the `monitoring` namespace, so `{{ .Release.Namespace }}` resolves correctly for all monitoring resources and one Grafana serves every lab attendee.

### Key Design Decisions

- **Two modes, one chart.** Single-instance mode uses `chart/values.yaml` (namespaces `openshell` + `demo`). Lab mode layers `chart/values-lab.yaml` per attendee (`userNN-openshell` + `userNN-demo`). Every namespace derives from `.Release.Namespace` and `global.demoNamespace`.
- **No privileged SCC.** OpenShell 0.1.x sandboxes and the gateway run under `restricted-v2` (Landlock + nested seccomp, hence OpenShift 4.19+). The old privileged SCC grant is gone.
- **Helm nested-null fix.** Helm drops `null`s declared in an intermediate subchart's values when it coalesces a nested dependency. So `openshell.upstream.podSecurityContext.fsGroup: null` and `securityContext.runAsUser: null` **must** stay in the umbrella `chart/values.yaml`. Otherwise the upstream defaults (1000) leak through and `restricted-v2` rejects the pods.
- **agent-sandbox applied out-of-band and guarded.** The CRD is cluster-scoped and must not be owned by a namespaced release. `ensure_agent_sandbox` reuses an OLM-managed CRD that serves `v1beta1` and refuses to replace an operator's CRD. It replaces an old `v1alpha1`-only install only with `AGENT_SANDBOX_MIGRATE=1`.
- **Inference through a provider profile.** `inference.local` and `openshell inference set` were removed upstream. The profile `maas-openai` (`manifests/openclaw/inference-profile.yaml.tmpl`) and a provider created with `--credential OPENAI_API_KEY` keep the real key in the gateway. Sandboxes attach the provider with `--provider` and see only a placeholder.
- **Gateway not exposed.** The gateway runs plaintext (`disableTls: true`) and does not authenticate callers, so its Route is off by default (`openshell.route.enabled`). Scripts drive it from inside the workshop pod. If you enable the Route, it uses edge TLS + `haproxy.router.openshift.io/enable-http2` for gRPC.
- **FQDN registry host.** Sandbox policies reference the skill registry as `registry.<namespace>.svc.cluster.local`, because the OpenShell 0.1.6 proxy does not resolve single-label hosts. Policies ship with `registry.openshell.svc.cluster.local`, and the workshop entrypoint and `fleet.sh` rewrite the namespace at runtime.
- **OpenShift operator-based monitoring.** Prometheus, Loki and Tempo are managed by Red Hat operators rather than bundled Helm charts.
- **Namespace-scoped telemetry.** Grafana uses its own SA token (`$__file{}`). Fleet agents get a 24h token of the per-instance `telemetry-reader` SA: metrics come through the Thanos tenancy port 9092 (`?namespace=`), Loki is filtered on `kubernetes_namespace_name`, and Tempo on `k8s.namespace.name`.
- **Namespaces created out-of-band.** `helm uninstall` deletes Helm-managed namespaces, which would destroy non-Helm resources in them.
- **Demo app stays as Kustomize, namespace-agnostic.** The Incident Lab applies and deletes it with `kubectl -n "$DEMO_NAMESPACE" apply -k`, and Helm ownership of the same objects would conflict.
- **`fullnameOverride` on subcharts.** Pins service names (e.g., `openshell`, `grafana`) so they stay stable regardless of the Helm release name.

### Components

| Component | Image / Chart | Role |
|-----------|---------------|------|
| OpenShell gateway + supervisor | `oci://ghcr.io/nvidia/openshell/helm-chart` 0.1.6 | Sandbox control plane (gRPC) |
| OpenShell CLI | v0.1.6 (static musl build, sha256-verified, in the workshop image) | Used by the lessons, `fleet.sh`, `45-openclaw.sh` |
| agent-sandbox controller | `kubernetes-sigs/agent-sandbox` v1.0.3 (`sandbox.yaml`, `v1beta1`) | CRD controller for sandbox lifecycle |
| OpenClaw sandbox | `ghcr.io/ansjindal/openclaw-sandbox:2026.8.2` (`images/openclaw-sandbox`) | Sealed agent pod with OpenClaw 2026.8.2 |
| Workshop web app | Built from `web/Dockerfile` (`WORKSHOP_IMAGE`) | Next.js 16.4.4 + React 19.3 on Node 24, terminal bridge, API routes |
| Thanos Querier | OpenShift Cluster Monitoring Operator | PromQL API (9091; tenancy 9092) |
| Grafana | `grafana-community/grafana` chart 14.3.0 | Dashboards and visualization |
| Loki Operator + LokiStack | Red Hat Loki Operator (OLM) | Log aggregation (multi-tenant gateway) |
| Tempo Operator + TempoStack | Red Hat Tempo Operator (OLM) | Distributed tracing |
| OTEL Collector | Red Hat OpenTelemetry Operator (OLM) | Trace ingestion (OTLP → Tempo) |
| ClusterLogForwarder | Red Hat Cluster Logging Operator (OLM) | Pod log collection → Loki |
| RustFS | `deploy/observability/object-storage/` chart | S3-compatible object storage for Loki + Tempo |
| Event exporter | `ghcr.io/resmoio/kubernetes-event-exporter:v1.7` | Kubernetes events → stdout → Loki |
| Verdaccio | `docker.io/verdaccio/verdaccio:6.11.1` | Private npm registry for OpenClaw skills |
| Image prepull (lab) | `deploy/lab-shared/` DaemonSet | Warms the sandbox, gateway and workshop images on every lab node |
| Self-hosted model (optional) | `registry.redhat.io/rhai/modelcar-nvidia-nemotron-3-nano-30b-a3b-fp8:3.0` | NVIDIA Nemotron 3 Nano 30B-A3B FP8, llm-d `LLMInferenceService` + vLLM (`qwen3_coder` tool calling) |
| OpenShift AI (optional) | `rhods-operator` stable-3.x (3.5) | KServe/llm-d + Models-as-a-Service (API keys, token limits) |
| GPU stack (optional) | NFD + NVIDIA GPU Operator v26.7 | GPU node enablement |
| Red Hat Connectivity Link (optional) | `rhcl-operator` (Kuadrant, Authorino) | MaaS gateway auth and rate limiting |
| LeaderWorkerSet (optional) | `leader-worker-set` operator | Operator prerequisite installed by `scripts/maas.sh` |

## Changes in this version

This version moves the stack from OpenShell 0.0.71 to **0.1.6** and agent-sandbox v0.4.6 to **v1.0.3** (`v1beta1`). It drops the privileged SCC (sandboxes run under `restricted-v2`, OpenShift 4.19+) and replaces `inference.local` with OpenShell provider profiles. It also adds the multi-attendee lab mode (`scripts/lab.sh`, `scripts/lab-smoke.sh`, `chart/values-lab.yaml`, `deploy/lab-shared/`) and self-hosted inference (`scripts/maas.sh`, `deploy/maas/`), and updates the workshop to Next.js 16.4.4 / Node 24. The legacy install path was removed: `scripts/30-openshell.sh`, `scripts/70-workshop.sh`, `helm/openshell-values.yaml`, `manifests/openshell-route.yaml`, `manifests/openclaw/registry.yaml` and `brev/launchable.md`.

See [README-DEPLOYMENT-REVIEW.md](README-DEPLOYMENT-REVIEW.md) for the review report: findings, changes, and test results.

## Reference

- [Administrator Guide](docs/ADMIN-GUIDE.md) · [Attendee Guide](docs/USER-GUIDE.md)
- [OpenShell](https://github.com/NVIDIA/OpenShell) · [Helm chart docs](https://github.com/NVIDIA/OpenShell/blob/main/deploy/helm/openshell/README.md)
- [NemoClaw](https://github.com/NVIDIA/NemoClaw)
- [OpenClaw](https://github.com/AgiFlow/OpenClaw)
- [agent-sandbox CRD](https://github.com/kubernetes-sigs/agent-sandbox)
- [Red Hat OpenShift](https://www.redhat.com/en/technologies/cloud-computing/openshift)
- [Red Hat OpenShift AI](https://www.redhat.com/en/products/ai/openshift-ai)

## Tags

* **Industry:** Cross-industry
* **Product:** Red Hat OpenShift, Red Hat OpenShift AI
* **Use case:** AI agents, sandbox governance, SRE automation, observability
* **Contributor org:** Red Hat, NVIDIA
