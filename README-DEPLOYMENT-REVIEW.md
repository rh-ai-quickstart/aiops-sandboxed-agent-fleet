# Deployment Review & Upgrade Report

**Branch:** `feat/openshell-0.1-upgrade` · **Date:** November 2026 · **Audience:** repository maintainers

This report covers deploying the repository, what blocked or misbehaved, why the architecture changed,
everything that was changed, and how it was tested. Cluster hostnames, users and credentials are
intentionally omitted.

---

## 1. Context and decisions

### Goal

Run the workshop as a **hands-on lab for 30 attendees on a single OpenShift cluster**, within about two
weeks.

### Test environments

| | Cluster A | Cluster B (target) |
|---|---|---|
| OpenShift | 4.20.41 | 4.22.18 (AWS, 3 × m5a.8xlarge workers + 3 × m6a.4xlarge control plane) |
| Pre-existing | RHOAI 3.5 with its own OpenShell (`odh-openshell-gateway v0.1.2-rhaiv.5`) in namespace `openshell`, agent-sandbox operator v0.9.0 (OLM, v1beta1) | cert-manager and RHBK operators only |
| Outcome | **Not deployed**: the original `deploy.sh` would have broken the existing OpenShell (B2, B6) | Baseline deployed, then the new version deployed and tested |

### Decision 1: one namespace pair per attendee on a shared cluster

The original code assumes **one instance per cluster**:

- the `openshell` and `demo` namespaces are hardcoded in about 15 files;
- the gateway is single-tenant: one provider, one inference config, `allowUnauthenticatedUsers`;
- the lessons create fixed sandbox names (`shifty`, `lab`);
- the incident lab mutates a shared `demo` namespace.

With 30 people on one workshop URL, everyone would share one gateway, one `shifty` sandbox and one
incident.

The git history explains why "it already runs for several users" was true before. The first version
(June–July 2026) was an NVIDIA Brev launchable: one VM and one single-node OpenShift per attendee. The
August "OpenShift migration" kept the single-instance assumptions.

We kept that isolation but moved it into namespaces:

| | Components |
|---|---|
| Per attendee (`userNN-openshell`, `userNN-demo`) | OpenShell gateway, sandboxes, Verdaccio registry, workshop and terminal, event-exporter, demo app |
| Shared, deployed once | observability operators and backends, agent-sandbox controller, Grafana, image prepull, GPU inference |

Why this model:

- **Cost and operations:** one cluster, one observability stack, one GPU pool.
- **No lesson rewrites for names:** each attendee has their own gateway, so names never collide.
- **Least-privilege isolation:** enforced by RBAC, NetworkPolicies and namespace-scoped telemetry (§4.3).
- **Single mode unchanged:** single-instance mode (`deploy.sh`) behaves as before.

### Decision 2: migrate to OpenShell 0.1.6 now

OpenShell 0.0.71 had two problems:

- **API version:** it required agent-sandbox `v1alpha1`, which is incompatible with every cluster that
  runs agent-sandbox ≥ v0.5, including RHOAI 3.x.
- **Privileges:** it needed the `privileged` SCC for every sandbox. That is unacceptable for 30 attendees
  on one cluster.

OpenShell 0.1.6 fixes both: sandboxes run under `restricted-v2`, and the gateway speaks `v1beta1`. It is
also a breaking release. Upstream says there is no in-place upgrade, managed inference is removed, the
CLI changes and the protos change.

Before migrating, we ran a spike on cluster B and validated the gateway, an OpenClaw 2026.8.2 sandbox
running with an arbitrary UID, `forward`, and the new credential injection.

### Decision 3: self-hosted inference ("MaaS") on the cluster

The lab must not depend on an external endpoint, a shared personal key or the event Wi-Fi.

- **Model:** NVIDIA **Nemotron 3 Nano 30B-A3B FP8**, a Red Hat validated modelcar.
- **Serving:** OpenShift AI 3.5 llm-d on an L40S GPU node.
- **Access:** OpenShift AI **Models-as-a-Service**, with one API key per attendee and token rate limits.

---

## 2. Findings in the original repository

✅ = fixed in this branch · 📝 = documented

### 2.1 Blockers

| # | Finding | Status |
|---|---|---|
| B1 | **MinIO images can no longer be pulled.** `quay.io/minio/minio` and `quay.io/minio/mc` return `unauthorized`, and the images are gone from Docker Hub. `helm --wait` then times out and `deploy.sh` aborts in phase 15. | ✅ Fixed upstream in the meantime by replacing MinIO with RustFS (`deploy/observability/object-storage`, commit 47ef20e); this branch is rebased on it (our interim Chainguard-image fix was dropped) |
| B2 | **`deploy.sh` applies agent-sandbox v0.4.6 unconditionally.** On RHOAI clusters the CRD is OLM-managed (v1beta1), so this would replace it and start a second controller. | ✅ `ensure_agent_sandbox` reuses an OLM CRD that serves v1beta1, refuses older installs unless `AGENT_SANDBOX_MIGRATE=1`, and installs v1.0.3 otherwise |
| B3 | **The gateway pod is rejected by SCC on a clean OCP 4.22.** `fsGroup: 1000` and `runAsUser: 1000` leak through because Helm drops `null`s declared in an intermediate subchart's values (umbrella → wrapper → upstream). Verified with `helm template`. | ✅ The nulls are set at the umbrella level |
| B4 | **OpenShell 0.0.71 and agent-sandbox v0.4.6 (v1alpha1) are pinned.** The stack cannot coexist with RHOAI's OpenShell and needs the privileged SCC. | ✅ Migrated to 0.1.6 and v1.0.3 (§3) |
| B5 | **The `openshell` namespace is hardcoded in about 15 files**, so the stack cannot run next to another OpenShell or once per attendee. | ✅ Namespaces come from the release or env; the demo-app kustomization is namespace-agnostic |
| B6 | **`deploy.sh` would install over a foreign OpenShell** in `openshell`, colliding on the StatefulSet, Service and SA. | ✅ It now aborts if the gateway there is not owned by this chart |

### 2.2 Bugs

| # | Finding | Status |
|---|---|---|
| G1 | `deploy.sh --set openclaw.gatewayPassword` is ignored because the key is `workshop.openclaw.gatewayPassword` (`helm template`: 0 occurrences). | ✅ |
| G2 | The default OpenClaw password is `openclaw` in the chart but `openshell-wad26` in scripts, entrypoint, labrc, an API route and 6 lessons. | ✅ Unified on `openclaw`; random per attendee in lab mode |
| G3 | `web/package.json` `test:e2e` hardcoded an old real cluster URL. | ✅ Uses `E2E_BASE_URL` |
| G4 | The e2e harness split multi-line commands per line, so `sandbox create … \` ran alone. | ✅ Each block runs as one script |
| G5 | `Approvals.tsx` compared `draftVersion` (a uint64 string) with `typeof === "number"`, which is always false. | ✅ |
| G6 | `policies/openclaw-sandbox.json` was out of sync with the YAML (missing the `npm-registry` block). | ✅ Regenerated; CI now checks the sync |
| G7 | `fleet.sh` read `NEMOCLAW_INFERENCE_PROVIDER` and never used it (SC2034), plus 20 other shellcheck warnings. | ✅ All scripts are clean at warning level |

### 2.3 Risky behaviour on shared clusters

| # | Finding | Status |
|---|---|---|
| R1 | `enable-uwm.sh` overwrote an existing `cluster-monitoring-config` (retention, storage, nodeSelectors). | ✅ Merged with yq |
| R2 | The UWM Alertmanager was always enabled. | ✅ Opt-in via `UWM_ENABLE_ALERTMANAGER=true` |
| R3 | The gateway Route exposed an unauthenticated plaintext gateway on the public router. | ✅ Route disabled by default |
| R4 | The workshop SA had **cluster-wide `pods/exec`** and `cluster-monitoring-view`, and the terminal runs as that SA. | ✅ Namespaced least-privilege RBAC; no exec in lab mode |
| R5 | The workshop had no authentication, and `/api/check` runs bash as that SA. | ✅ Access-token gate (cookie or Bearer) in lab mode |
| R6 | Grafana sidecars watched all namespaces, and its ClusterRole could read **secrets cluster-wide**. | ✅ Namespaced RBAC; sidecars limited to their own namespace |
| R7 | The fleet telemetry token came from `monitoring-reader` (cluster `view` + `cluster-monitoring-view`, 7 days). | ✅ Per-attendee `telemetry-reader` SA, 24 h tokens |
| R8 | Telemetry was not scoped: with N demo apps, every fleet would see every incident. | ✅ Thanos tenancy port 9092, Loki and TraceQL namespace filters, per-attendee event-exporter |
| R9 | `deploy.sh` ran `openshell provider delete <name>` before recreating it. | ✅ Create or update only; never delete |
| R10 | The ClusterLogForwarder collects every application namespace. | 📝 Kept (the lab needs it); documented |
| R11 | The workshop sets `NODE_TLS_REJECT_UNAUTHORIZED=0`. | 📝 Kept (in-cluster self-signed endpoints); documented |

### 2.4 Inconsistencies and stale content

| Finding | Status |
|---|---|
| `.env.example`: 6 unused variables, wrong `OPENSHELL_VERSION` comment, provider name `nvidia` vs `default` | ✅ Rewritten |
| Two parallel install paths (`deploy.sh` umbrella chart vs `30-openshell.sh`). `70-workshop.sh`, still called by `setup.sh`, built the site on a Brev VM with apt-get/sudo. | ✅ Legacy scripts removed |
| Stale comments: gateway `0.0.70`, "Intel Gaudi", channel fallback `stable-6.1`, `tempo.monitoring.svc` OTLP default | ✅ |
| `web/Dockerfile`: exact Debian version pins (break on point releases), openshell install `\|\| true`, unpinned `oc` | ✅ Apt pins dropped; `oc` and the CLI pinned and checksum-verified; the build fails on error |
| README badges point to the old repository; `brev/launchable.md` and `RELEASE_NOTES.md` describe the Brev launchable | ✅ README updated; the Brev doc removed |
| CI never ran on this repository (no workflow runs), and its YAML job would fail on Helm templates (19/48 files) | ✅ CI fixed (§4.6) |
| `next 16.2.9` has critical RCE/SSRF advisories; Node 20 is EOL; `mermaid` and `framer-motion` are unused (mermaid pulls a critical `dompurify` vulnerability) | ✅ Next 16.4.4, Node 24, both removed; `npm audit --omit=dev` reports 0 vulnerabilities |
| The Grafana Helm repository moved (`grafana.github.io` is deprecated) | ✅ `grafana-community` 14.3.0 |
| LokiStack had no explicit `storage.schemas` (silently v11) | ✅ v13 added |

---

## 3. OpenShell 0.0.71 → 0.1.6

| Upstream change | Handling |
|---|---|
| No in-place upgrade: the StatefulSet `serviceName` changed and sandboxes must be recreated | Documented migration: uninstall, then `AGENT_SANDBOX_MIGRATE=1` |
| `server.sandboxImage` is silently ignored | `sandbox.image.{repository,tag}` = `ghcr.io/ansjindal/openclaw-sandbox:2026.8.2` |
| `supervisor.sideloadMethod` removed; the privileged SCC is no longer needed | Removed |
| `inference.local` and `openshell inference` removed | Provider profile `maas-openai`, then `provider create` and `sandbox create --provider`. The agent sees only a placeholder `$OPENAI_API_KEY`; the supervisor swaps in the real key on egress (verified with an echo server). |
| `sandbox create … -- true` leaves the sandbox `Completed` and never Ready | `--detach -- sleep infinity` |
| A sandbox created **without `--policy`** never becomes Ready: the supervisor loops on "Server returned no policy" (found in the spike) | A policy is always passed |
| Pod and CR names are now `default--<name>`, plus an `os-supervisor-<id>` pod per sandbox | API routes, lessons and tests updated |
| `policy update --add-deny` syntax changed; `policy prove` removed | Lessons updated |
| `provider profile update` needs the current `resource_version`; profile files need a `.yaml` extension | Handled in `configure_inference` and in the inference lesson |
| Protos changed: `inference.proto` gone, drafts need `workspaceScope` and `reviewToken`, Timestamp fields | Re-vendored; drafts route and Approvals UI rewritten |
| The OpenShell proxy does **not** resolve single-label hosts (`http://registry:4873` fails, the FQDN works; verified) | Policies keep the FQDN; the entrypoint rewrites the namespace |
| The CLI reads `OPENSHELL_GATEWAY_ENDPOINT` itself and requires a scheme | The variable holds a full URL; `server.mjs` derives the gRPC target from it |

---

## 4. Changes in this branch

### 4.1 Platform

- **Chart:**
  - OpenShell subchart moved to 0.1.6. The gateway Route is optional; the prepull Job is off in lab mode.
  - Verdaccio pinned to 6.11.1, with emptyDir in lab mode.
  - New `chart/values-lab.yaml` and `chart/templates/isolation.yaml` (NetworkPolicies, LimitRange, ResourceQuota).
  - Workshop RBAC in `rbac-namespaces.yaml`; the ClusterRole keeps read-only nodes/SCC/CRDs only.
  - New `telemetry-reader`, per-instance event-exporter, access Secret, and `/healthz` probes.
- **Scripts:**
  - `scripts/lib/common.sh` gains `ensure_agent_sandbox`, `configure_inference`, `guard_foreign_openshell` and others.
  - New `scripts/lab.sh` (`shared|up|user|fleet|status|urls|down`) and `scripts/lab-smoke.sh`.
  - `deploy.sh` rewritten for single mode; `fleet.sh` and `45-openclaw.sh` moved to 0.1.6.
  - Legacy scripts removed.
- **Lab shared:** `deploy/lab-shared/` holds the prepull DaemonSet chart.
- **Observability:**
  - Loki schema v13; OTEL values deduplicated.
  - Operator CSVs bumped: COO v1.5.3, OTEL v0.158.0, Tempo v0.22.0-4.
  - Grafana 14.3.0, hardened, with per-attendee dashboard variables.
- **Demo app:** namespace-agnostic; spans carry `k8s.namespace.name`; Node 24 images.

### 4.2 Self-hosted inference (`scripts/maas.sh`, `deploy/maas/`)

| Piece | What is deployed |
|---|---|
| Operators | NFD, NVIDIA GPU Operator v26.7.2, OpenShift AI 3.5.2, Connectivity Link 1.4.3, LeaderWorkerSet |
| GPU | A MachineSet cloned from a worker set (g6e.2xlarge, L40S 48 GB, tainted) |
| Gateway and MaaS backing | Gateways, Authorino TLS, PostgreSQL for MaaS |
| Model | `LLMInferenceService` **nemotron-3-nano**: vLLM tool calling (`qwen3_coder`), reasoning off by default |
| Access control | `MaaSModelRef`, `MaaSAuthPolicy`, `MaaSSubscription` |
| Script commands | `keys <N>` mints one key per attendee; `smoke` runs a completion and a tool call |

Endpoint: `https://maas.<apps-domain>/maas-models/nemotron-3-nano/v1`.

### 4.3 Multi-tenant isolation (lab mode)

| Layer | Mechanism |
|---|---|
| Access | Per-attendee access token (cookie or Bearer); random OpenClaw password per attendee |
| Kubernetes API | Workshop SA gets: `view` + Role `workshop-self` in its own namespace, write rules in its demo namespace, read-only access to platform namespaces, and read-only nodes/SCC/CRDs. No `pods/exec`, no cluster-wide pods/routes. |
| Network | Default-deny ingress in both namespaces; same-namespace allowed; router → workshop; monitoring → demo |
| Telemetry | `telemetry-reader` SA bound only to the attendee's namespaces; Thanos 9092 (`?namespace=`); Loki and TraceQL namespace filters |
| Resources | LimitRange + ResourceQuota (openshell namespace: 30 pods, 10 sandboxes, 12 PVCs, requests of 6 CPU / 12 Gi) |
| Placement | Namespace node-selector `node-role.kubernetes.io/lab=` |
| Inference | One MaaS API key per attendee |

### 4.4 Workshop web app

- **Dependencies:** Next 16.4.4, React 19.3.1, Node 24, gRPC 1.14.7, Playwright 1.64.1. `mermaid` and `framer-motion` removed.
- **Lint:** ESLint flat config added. Lint was broken before because there was no config.
- **Protos:** re-vendored from 0.1.6.
- **API routes:** drafts, openshell, incident, orchestrate and fleet rewritten; new `GET /api/lab`.
- **Server:** access gate in `server.mjs`; `/healthz` endpoint.
- **Lessons:** 27 updated for 0.1.6 and lab mode:
  - `$OPENSHELL_NS` / `$DEMO_NS` variables;
  - the new inference flow;
  - `default--` sandbox names;
  - an "exec is Forbidden in lab mode" callout.
- **Dockerfile:**
  - Node 24.
  - oc 4.22 and openshell 0.1.6, both checksum-verified.
  - devDependencies pruned.
  - `allowScripts` for node-pty (npm 11).

### 4.5 Documentation

| File | Content |
|---|---|
| `docs/ADMIN-GUIDE.md` | Preparation, MaaS, deployment, operations, capacity, troubleshooting, teardown |
| `docs/USER-GUIDE.md` | What attendees receive, their environment, rules, troubleshooting |
| `docs/CONTRACT.md` | Env contract between the chart and the web app; design decisions |
| README, CLAUDE.md | Updated |

### 4.6 CI (`.github/workflows/ci.yml`)

- Node 24 and current action majors; Helm version pinned.
- `helm dependency build` runs before lint.
- Renders single mode plus two lab attendees and checks for cluster-scoped collisions (`.github/scripts/check-render.py`).
- Lints the observability charts.
- Shellcheck on all scripts at warning level.
- YAML check excludes Helm templates and verifies the policy JSON/YAML sync.
- Checks that the kustomize output is namespace-free.

---

## 5. Test report

### 5.1 Baseline (original code, cluster B)

| Check | Result |
|---|---|
| `deploy.sh` (original) | Failed at MinIO (B1). After the MinIO fix it failed at the gateway SCC (B3), then completed after patching the StatefulSet live. |
| Original e2e suite (75 tests, Playwright 1.62.1) | **60 passed / 15 failed**, all "Run in shell". Causes: harness line-splitting (G4); a cascade because `shifty` was never created; `cd ~/nemoclaw-openshift-launchable` failing under `/api/check`. |
| shellcheck `--severity=error` | Clean (20 findings at warning level) |
| CI YAML job as written | 19/48 files rejected (Helm templates) |

### 5.2 New version — static and local checks

These ran in containers: podman, or pods on the cluster.

| Check | Result |
|---|---|
| `npm ci` / `npm run lint` / `npm run build` (Node 24) | ✅ 0 lint errors; 36 pages and all 30 MDX lessons prerendered |
| Playwright `smoke` (gate off / gate on) | ✅ 11 passed + 4 skipped / 15 passed |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities (16 moderate in the dev-only eslint toolchain) |
| Every `openshell …` command in the lessons parsed by the real 0.1.6 CLI | ✅ 74 commands |
| shellcheck `--severity=warning`, all scripts | ✅ Clean |
| `helm lint` + `helm template`: single, 2 lab attendees, monitoring, lab-shared, observability charts | ✅ No cluster-scoped collisions |
| YAML syntax, policy JSON sync, namespace-free kustomize | ✅ |
| Workshop image built from `web/Dockerfile` (amd64, in-cluster BuildConfig) | ✅ |

### 5.3 New version — on cluster B (OpenShift 4.22.18)

| Check | Result |
|---|---|
| `scripts/maas.sh` steps: GPU node, operators, OpenShift AI, MaaS, model | ✅ Nemotron Ready; MaaSModelRef Ready; subscription Active |
| `scripts/maas.sh smoke` (completion + tool call through MaaS) | ✅ `ready` in 0.6–1.4 s; structured `tool_calls` (`query_metrics` with PromQL) |
| `scripts/lab.sh up 2` (shared + user01 + user02) | ✅ After fixing the integration bugs in §5.4 |
| `scripts/lab-smoke.sh` | ✅ Both attendees: `/healthz` 200, `/api/lab` 200, gateway ok, demo ok |
| Pod security | ✅ Every attendee pod (gateway, sandboxes, supervisors, workshop, registry, exporter) runs under `restricted-v2` on lab nodes |
| `lab.sh fleet user02` | ✅ 5 agents + 5 supervisors Running |
| e2e read-only + isolation, **user01** (lab mode) | ✅ **97 passed, 0 failed**. 22 skipped: blocks that need sandboxes user01 never created. |
| e2e full mutating flow + isolation, **user02** (lab mode, real inference) | 102 passed, 1 failed. The failure is fixed: the inference lesson's profile `update` needed the `resource_version`. Re-run result in §5.5. |
| Incident Lab (fleet on Nemotron, user02): deploy → break → investigate → fix, with user01 unaffected | See §5.5 |
| 30-attendee load test | See §5.5 |

### 5.4 Integration bugs found by the live tests (all fixed)

1. `configure_inference` logged variables that were set inside a subshell, so `set -u` aborted the script.
2. The provider-profile temp file had no `.yaml` extension ("unsupported provider profile file format").
3. `provider profile update` needs the current `resource_version`.
4. The `openclaw-forward` sidecar's `gateway add` could hang for about 90 s; it is now bounded with `timeout 15`.
5. Two test-side issues: an ambiguous locator in the Approvals test, and the isolation exec test targeting a sandbox that does not exist.
6. MaaS:
   - the model's HTTPRoute must reference `maas-default-gateway`;
   - the model path is `/<ns>/<model>/v1`, not the documented `/llm/<model>/v1`;
   - JSON inside `VLLM_ADDITIONAL_ARGS` needs single quotes;
   - with one GPU, a model rollout deadlocks, so `maas.sh` now releases the old ReplicaSet;
   - the documented `maasAuthPolicies` dashboard flag is rejected as deprecated.
7. The preflight warned about a missing key even when per-attendee keys are used.

### 5.5 Incident Lab and load tests (cluster B, 1 × L40S, Nemotron 3 Nano 30B FP8)

**Incident Lab, one attendee, repeated rounds.** user02 ran deploy → break → investigate → fix twice in
a row while user01 stayed untouched:

- **Isolation held both times.** user02 went to 100 % errors (`payments-down`) while user01 stayed at 0 %.
- **Investigation took 48 s.** The four investigators ran in parallel, then the analyst synthesised.
- **The analyst was right both times:** *ROOT CAUSE: `payments` scaled down to 0 → checkout `ECONNREFUSED`*,
  with `RECOMMENDED_ACTION: scale the payments deployment back up`. After the fix the error rate went
  back to 0 %.

Bugs this run exposed, all fixed:

- OpenClaw's SQLite could not create temp files under Landlock (`/var/tmp`).
- OpenClaw assumed a context window that was too small.
- The AWS load balancer dropped the stream after 60 s idle. A 15 s heartbeat fixes it.
- An agent sometimes skipped its tool call. The orchestrator now attaches a verified probe output.
- Events from earlier break/fix rounds misled the analyst. The Loki window is now 15 minutes.

**Load test, 9 attendees on one cluster.** All 9 attendees were deployed with `lab.sh up 9` and each
had its fleet: 47 sandboxes in total. All 9 demo apps were broken, then **9 investigations were started
at the same time** (36 investigator agents + 9 analysts):

| | Run 1: default OpenClaw prompt | Run 2: fleet agents on a minimal tool profile |
|---|---|---|
| 9 concurrent investigations, wall time | 247 s | **61 s** |
| Per attendee | 225–246 s | **37–61 s** |
| Investigator turns hitting the 120 s budget | almost all (results came from verified probes) | **none** (9–38 s) |
| Correct analyst diagnosis + action | 9/9 | **9/9** |
| All 9 apps healthy after the fix | ✅ | ✅ |
| vLLM: max requests running / waiting | 13 / **30** | 19 / **0** |
| vLLM: median prompt per request | **30,664 tokens** | **3,920 tokens** |
| vLLM: peak prompt throughput | 64,400 tok/s | 5,100 tok/s |
| vLLM: max KV-cache usage | 20 % | 8 % |

**Why run 2 is faster.** OpenClaw's default agent prompt (all tools, skills, plugins, workspace files)
was about 30k tokens per call, roughly 80k input tokens per investigator turn. The fleet agents only
run one `exec` probe, so their config now sets:

- `tools.profile: minimal` with `alsoAllow: [exec]` and `exec.host: gateway`;
- a single skill;
- `bootstrapTotalMaxChars: 6000`;
- the memory plugin disabled.

That brings an investigator turn down to about 8k input tokens (measured), and the probe still runs.
The lesson agent (`shifty`) keeps its full toolset.

**Other measurements:**

| Item | Measured |
|---|---|
| `lab.sh up 9` (5 in parallel) | 209–222 s |
| Fleet creation for 9 attendees (3 in parallel) | 708 s for the first creation; 18 s to re-stage config |
| CPU / memory on the 3 lab nodes (m5a.8xlarge) | 3–4 % CPU, ~10 % memory |
| EBS attachments per lab node | **26 / 23 / 17** (AWS limit ≈ 26): the binding constraint |
| Attendee PVCs for 9 attendees | 57 |

**What this means for 30 attendees.**

- **CPU and memory** are not a concern.
- **EBS:** add worker nodes. With 9 attendees one node is already at 26/26 attachments; 30 attendees need roughly 10–11 lab nodes.
- **One L40S** served 9 simultaneous investigations with no queue. Extrapolating from 61 s for 9, 30 simultaneous investigations would take an estimated 2–4 minutes. A second GPU replica (`MAAS_GPU_REPLICAS=2`) halves that; staggering the "Investigate" clicks is the zero-cost alternative.
- **After a cluster stop/start,** the instances added after installation (GPU node, extra workers) stay `stopped`. `maas.sh up` recreates stopped GPU machines; recreate extra workers the same way (ADMIN-GUIDE §9).

### 5.6 Rebase on `main` and final end-to-end pass

This branch is rebased on `main` (RustFS object storage, workshop 0.2.9, observability readiness waits,
BOOTSTRAP/workspace staging, orchestrate retries). After the rebase:

| Check | Result |
|---|---|
| `15-observability.sh` with the upstream RustFS chart (replacing the earlier MinIO release) | ✅ LokiStack and TempoStack Ready on RustFS |
| shellcheck (warning), helm lint/template single + 2 lab attendees, observability charts, YAML/policy sync | ✅ |
| E2E read-only + isolation (user01, lab mode) | ✅ **97 passed, 0 failed** |
| Real cluster stop/start | ✅ `maas.sh up` recreated the stopped GPU machine and reloaded the model; `lab.sh wake` restarted every Stopped/Error sandbox of 9 attendees in ~2 min |
| E2E full mutating lesson flow + isolation on a fresh attendee (user01, build #17; **119/0/0 on build #19 after the audit, §5.7**) | ✅ **112 passed, 1 failed** (heartbeat `activeHours` format; fixed, then the Heartbeat lesson re-run on build #18: **3/3 passed**) |
| E2E read-only + isolation on the final image (build #18, user03, peer user04) | ✅ **97 passed, 0 failed** (22 skipped: mutating or state-dependent blocks; the harness now tolerates an empty `grep 'a\|b'`) |
| Incident Lab through the merged orchestrate route (user02, build #17) | ✅ user02 at 100 % errors while user04 stayed at 0 %; 39 s; 0 refused calls; analyst: payments scaled to 0 (ECONNREFUSED in logs and traces, pod deleted in events) → "scale the payments deployment back up"; healthy again after the fix |
| Investigation of a healthy app (user03, user05) | ✅ `evidence-check` in 15–17 s: "none found — the telemetry shows the app healthy" |
| `/api/check` with a 75 s command through the AWS load balancer | ✅ returns its JSON (before: empty reply after 60 s) |

**Provider placeholder rotation (found in the final pass, fixed).** In the first post-rebase Incident
Lab run the right answer came only from the verified probes. Every model call of the fleet had been
refused by the sandbox proxy with `HTTP 500 "credential_unavailable"` (OCSF:
`DENIED … engine:credential-binding`), so the analyst never ran.

- **Cause.** OpenShell 0.1.x versions the credential placeholder
  (`openshell:resolve:env:v<revision>_OPENAI_API_KEY`) and re-issues it on every provider update;
  an old one stops resolving. `fleet.sh`, `45-openclaw.sh` and the Configure lesson copied the
  placeholder **value** into `openclaw.json`. The redeploy in this pass re-ran `configure_inference`,
  which updated each attendee's provider, so every fleet created earlier was stranded. A fresh shell
  in the same sandbox still worked, because it receives the new placeholder.
- **Reproduced** on a second attendee (user03): 16 refused calls and no analyst output.
- **Fix.**
  - The configs keep the literal `${OPENAI_API_KEY}`, which OpenClaw substitutes at process start;
    fleet agents start a fresh process for every turn.
  - `lab.sh` re-runs leave an existing provider untouched unless `LAB_INFERENCE_UPDATE=1`.
  - Admin guide: troubleshooting row and the key-rotation procedure.
- **Validated.** user02 and user03 re-staged: 0 refused calls, analyst synthesis restored, correct
  root cause.
  - Deliberate rotation on user03 (`LAB_INFERENCE_UPDATE=1`, 7 provider updates): the re-staged fleet
    kept working, with 0 refused calls and analyst synthesis.
  - A plain `lab.sh up 9` re-run now keeps all 9 providers: 0 `UpdateProvider` calls.
  - Incident Lab on user01 after the fix: 36 s, 0 refused calls, analyst synthesis, correct root
    cause and action; user04 stayed healthy.

**Analyst on a healthy app.** Asked "checkout is failing" while the app was healthy, the analyst
named the textbook cause (payments scaled to 0) with no evidence for it.

- **Why.** The events agent had not run its command. It "reported" the example from its own
  instructions (`payment-service scaled down to 0 replicas`, dated 2021). The orchestrator appended
  the verified probe (`entries=0`) next to that invented text, and the analyst believed the text.
- **First fix, not enough.** When a reply does not contain the tool's real output, the finding is
  now the verified probe output alone, without the agent's narrative. With clean findings (0 error
  logs, 0 error traces, 0 events, only 200s), the analyst still named the textbook cause on two
  healthy attendees: its prompt assumed a change existed.
- **Final fix: a deterministic evidence check.**
  - The orchestrator reads the counts from the probe outputs: error log lines, error traces, recent
    events and 5xx rate.
  - When every probe answered and none shows a failure, it reports the app healthy itself
    (`synthesizedBy: evidence-check`, `RECOMMENDED_ACTION: none — no fault found in the telemetry`).
  - Otherwise the analyst receives the computed counts with the findings, and its "what changed?"
    rule is now conditional.

Validated: user03 and user05 (healthy) → `evidence-check`, "none found", in 15–17 s; user02 (broken)
→ the analyst still names the right cause and action. In these runs the agents mostly paraphrased
their tool output instead of quoting it, so every finding came from the verified probes (the
timeline marks them `verified`).

**OpenClaw 2026.8.2 behaviour the lessons now handle.** Each item was found by the full lesson flow
and validated live before fixing:

- **Gateway readiness:** the gateway logs `[gateway] ready` instead of `listening on ws`.
- **`--local` is refused while a gateway owns the state directory:**
  - the agent config sets `gateway.port: 30789`;
  - the lessons call the gateway without `--local`.
- **DuckDuckGo is no longer bundled:**
  - install `@openclaw/duckduckgo-plugin@2026.8.2`, version-matched, since newer releases need OpenClaw ≥ 2026.10.10;
  - every plugin install needs `--accept-capabilities`, otherwise the gateway refuses to start.
- **Prompts name the tool.** A small model uses its tools reliably when the prompt names them, e.g.
  "use your write tool", "use your web_search tool": 3/3 vs. occasional misses.
- **The skill scaffold asks for `openclaw@latest`.** The current release (2026.10.10) needs Node ≥ 24.16
  while the sandbox image ships Node 22, and 2026.8.2's package has a broken `preinstall`.
  - The Skills lesson now links the sandbox's own OpenClaw (`npm root -g`) and installs with
    `--omit=peer`, with the npm cache in `/tmp`.
  - `node_modules` shrinks from about 1.5 GB to 57 MB; before, it filled the 2 GiB workspace (`ENOSPC`).
- **`heartbeat.activeHours` is an object.** The schema expects `{start, end, timezone?}`; the Heartbeat
  lesson's `"09:00-18:00"` string failed validation. It now sets
  `{"start":"09:00","end":"18:00"}` with `--strict-json`.
- **A local plugin install needs `--force`.** OpenClaw refuses sources outside ClawHub (a local
  folder) unless confirmed with `--force`; the Skills lesson now passes it.
- **The registry-login one-liner never returned.** Its `node -e` request did not read the response,
  so `end` never fired, and Node 22's keep-alive agent held the process. The step hung and
  `/sandbox/.npmrc` was never written. It now calls `r.resume()` with `agent:false`: 6 s.
- **`/api/check` cut at 60 s.** Plugin installs from the registry take up to about 150 s, and the AWS
  load balancer drops connections idle for 60 s. `/api/check` now sends its headers at once and a
  space every 15 s (leading whitespace is valid JSON), like the orchestrate heartbeat.
- **Intended refusals are tested:**
  - lesson blocks that demonstrate a refusal carry `# … (expect-fail: <regex>)`;
  - the E2E harness asserts that those commands fail with that output.

### 5.7 Content audit of every lesson after the 0.1.6 migration

**Method.** Every lesson, diagram and curriculum string was read and checked against:
- the help of the installed CLIs, dumped from the cluster (OpenShell 0.1.6 and OpenClaw 2026.8.2);
- the OpenShell 0.1.6 source and docs (policy schema, provider placeholders);
- the repo's own scripts and API routes.

Five parallel audits produced about 100 findings. Every finding was verified before fixing; the ones
below that change behaviour were also reproduced live.

| Finding | Evidence | Fix |
|---|---|---|
| **The Heartbeat lesson never produced a beat.** With no `heartbeat.target`, OpenClaw 2026.8.2 skips every scheduled beat when no chat channel exists. | 1-minute interval, 150 s: no beat. With `target none`: a beat every minute, model calls 200, `system heartbeat last` → `status: ok-empty, reason: interval`. | The lesson sets `target none` and checks the beat with `openclaw system heartbeat last --json`. The old check matched `[heartbeat] started`, so it passed without any beat. |
| **"Into the Sandbox" described the 0.0.71 network model** (a private network namespace and an `HTTPS_PROXY` to the supervisor). | Same network namespace for the agent's shell and the pod's shell; no `*_PROXY` variable. Agent connections appear as `NET:OPEN … ALLOWED [policy:websearch engine:opa]`; a host outside the policy is refused. | Rewrote the lesson (and `access`, `openshell`, two diagrams) for 0.1.x transparent mediation. |
| **The policy schema in the OpenShell lesson, `policies/README.md` and `presets/github.yaml` used the old format**: a list instead of a map, plain binaries, top-level `rules`, `filesystem:` and `allowed_binaries`. The preset also called the `nemoclaw` CLI. | OpenShell 0.1.6 schema docs. The rewritten preset was merged into a running sandbox's policy, loaded by the gateway (rules stored as `allow:`), then the original policy was restored. | All three now use the 0.1.6 schema (`network_policies` map, `path:` binaries, per-endpoint `rules: - allow:`, `filesystem_policy`, `run_as_group`). |
| `openclaw devices approve --latest` presented as approving | Help: "Show the most recent pending request to approve explicitly". | Pairing and Troubleshooting approve by request id. |
| `openclaw config get` without a path; `policy get` without `--full` presented as the effective policy | Help: `config get <path>`; `--full` adds the provider-composed rules. | Fixed in Chat. |
| The Alerts exercise ("Build your own") would get a 403 | The Alertmanager tenancy proxy authorizes `prometheusrules` in the namespace; `telemetry-reader` cannot (`oc auth can-i` → no). | The lesson gives the RoleBinding (`monitoring-rules-view`). |
| A registry skill in `fleet.txt` would never install | `fleet.sh` ran `plugins install` without `--accept-capabilities --force`, hidden behind `\|\| true`. | Flags added. |
| Inference described as "remote, no GPU" in 12 places | The lab serves Nemotron on the cluster GPU. | Neutral wording: an OpenAI-compatible endpoint, in this lab on the cluster's GPU through OpenShift AI. |

Other fixes:
- Prose that contradicted the commands next to it:
  - the npm cache and registry flow in Skills;
  - "restart the gateway" where it hot-reloads;
  - the 15-minute Loki window and Tempo path in Orchestration;
  - the analyst's "what changed?" prompt.
- Stale facts:
  - the analyst described as "no egress" (it reaches the skill registry and the model, not telemetry);
  - a nonexistent `latency` fault and `DEPLOY_MONITORING` flag;
  - operator namespaces, file sizes and counts.
- Forbidden or wrong commands in lab mode (`kubectl scale` without `-n "$DEMO_NS"`, `openshell forward list` in the wrong container).

Validation on the rebuilt image (build #19):
- full mutating lesson flow + isolation on a fresh attendee: **119 passed, 0 failed, 0 skipped**;
- healthy app: `evidence-check`, "none found", 18 s;
- Incident Lab: right root cause and action in 31 s, 0 refused model calls, other attendee
  unaffected, healthy again after the fix.

---

### 5.8 Second cluster: 20 attendees on an RHDP cluster with an external MaaS

The lab was deployed with `lab.sh up 20` on a second OpenShift 4.22.18 cluster (AWS, 13 nodes). That
cluster already ran an earlier single-instance install and an OpenShift AI MaaS that forwards to an
**external** Nemotron server.

- **Cleanup:** the earlier install (OpenShell 0.0.71, agent-sandbox v0.4.6) was removed, and
  agent-sandbox was migrated to v1.0.3 with `AGENT_SANDBOX_MIGRATE=1`. The workshop image was built
  in the cluster from this branch.
- **Inference:** one MaaS API key per RHDP user (`user1`…`user20`), each on its own subscription
  (1M tokens/24 h), written to `.lab/maas-keys.csv`; the MaaS was already published on a public Route.
- **Found and fixed in the chart:**
  - updating an existing Grafana deadlocked on its ReadWriteOnce volume (`Multi-Attach`), fixed with
    `deploymentStrategy: Recreate`;
  - the Loki datasource now has a fixed `uid`.
- **Found outside the lab:** the external model server rejected tool calls (`"auto" tool choice
  requires --enable-auto-tool-choice`), so every agent turn failed. It was fixed on that server; no
  change was needed in the lab.
- **Results:**
  - 20 attendees healthy, 20 fleets;
  - healthy app: `evidence-check`;
  - Incident Lab: right root cause and action in 38 s, other attendee unaffected, healthy after the fix;
  - **full lesson flow + isolation on a fresh attendee: 119 passed, 0 failed, 0 skipped**.

## 6. Known limitations and follow-ups

- **EBS attachments are the binding constraint for 30 attendees.** Each sandbox has a 2 Gi EBS workspace: about 8 volumes per attendee, against about 26 per AWS node. Add lab nodes (ADMIN-GUIDE §8).
- **GPU capacity.** One L40S keeps an estimated 100–150 agent requests in flight. Use 2 GPU replicas for 30 attendees and stagger the Incident Lab.
- **Workshop image.**
  - It must be published somewhere the cluster can pull from (`build-workshop.yml` → `vars.WORKSHOP_IMAGE_REPO`).
  - The chart default still points at `quay.io/mmurakam/nemoclaw-workshop:v0.2.9`, which predates this branch.
  - Until a new tag is published, set `WORKSHOP_IMAGE`.
- **eslint 9 is end-of-life upstream.** Moving to eslint 10 is future work.
- **Tempo `jaegerQuery`.** Deprecated in Tempo 3.11 but kept: nothing in the repo uses it, and removing it is untested.
- **Legacy lesson path.** Lessons still use `~/nemoclaw-openshift-launchable`. The entrypoint keeps it working through a symlink, so this is cosmetic only.
