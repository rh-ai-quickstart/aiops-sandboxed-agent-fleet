# Implementation contract (working document — merged into the guides at the end)

Shared between the `web/` work and the platform work (chart, scripts, manifests, policies).

## Target versions

| Component | Version |
|---|---|
| OpenShell chart / gateway / supervisor / CLI | 0.1.6 (`oci://ghcr.io/nvidia/openshell/helm-chart` 0.1.6; CLI = release asset `openshell-x86_64-unknown-linux-musl.tar.gz` + `openshell-checksums-sha256.txt`, verify sha256) |
| agent-sandbox (kubernetes-sigs) | v1.0.3 (`releases/download/v1.0.3/sandbox.yaml`, serves v1beta1 — CI-tested with OpenShell 0.1.6) |
| OpenClaw sandbox image | `ghcr.io/ansjindal/openclaw-sandbox:2026.8.2` (OpenClaw 2026.8.2, Node 22) |
| Node.js (workshop image, CI) | 24 (`node:24-bookworm`, `node:24-bookworm-slim`) |
| Next.js | 16.4.4 (security fixes) |

Verified on OCP 4.22 (spike, 2026-11-02): gateway 0.1.6 runs under `restricted-v2` (no privileged SCC);
OpenClaw 2026.8.2 runs as the namespace's arbitrary UID; `/sandbox` writable; `openshell forward` works;
a sandbox created WITHOUT `--policy` never becomes Ready (supervisor loops on "Server returned no policy").

## Modes

- **Single-instance (default)**: one instance per cluster, namespaces `openshell` + `demo`. `scripts/deploy.sh`.
- **Lab (multi-tenant)**: N attendees on one cluster. `scripts/lab.sh up <N>` → attendees `user01..userNN`.
  - Shared, deployed once: observability stack (operators, UWM, RustFS, Tempo, Loki, OTEL), agent-sandbox
    CRD + controller, `monitoring` namespace (Grafana + event-exporter), sandbox-image prepull DaemonSet
    (namespace `lab-shared`).
  - Per attendee `<u>`: namespace `<u>-openshell` (OpenShell gateway, Verdaccio registry, workshop pod,
    sandboxes) and namespace `<u>-demo` (demo app). Helm release `nemoclaw` in `<u>-openshell`.

## Environment contract — workshop container (set by chart/charts/workshop/templates/deployment.yaml)

| Variable | Example (single / lab) | Meaning |
|---|---|---|
| `OPENSHELL_NAMESPACE` | `openshell` / `user07-openshell` | namespace of the gateway, sandboxes, registry, workshop (= Release.Namespace) |
| `DEMO_NAMESPACE` | `demo` / `user07-demo` | namespace of the demo app (incident lab) |
| `LAB_USER` | `` / `user07` | attendee id (empty in single-instance mode); shown in the UI |
| `OPENSHELL_GATEWAY_ENDPOINT_URL` | `http://openshell.<ns>.svc.cluster.local:8080` | plaintext in-cluster gateway URL |
| `OPENSHELL_GATEWAY_ENDPOINT` | `http://openshell.<ns>.svc.cluster.local:8080` | full URL: the openshell 0.1.6 CLI reads this variable itself (`--gateway-endpoint`) and requires a scheme; server.mjs derives the gRPC host:port from it |
| `REGISTRY_HOST` | `registry.<ns>.svc.cluster.local` | Verdaccio host (port 4873) |
| `MONITORING_NAMESPACE` | `monitoring` | shared Grafana / monitoring-reader namespace |
| `NEXT_PUBLIC_CLUSTER_APPS_DOMAIN` | `apps.example.com` | apps domain for links |
| `WORKSHOP_HOST`, `OPENCLAW_HOST`, `GRAFANA_HOST` | `workshop-<ns>.<domain>` … | Route hostnames (UI links) |
| `NEMOCLAW_INFERENCE_BASE_URL`, `NEMOCLAW_MODEL`, `NEMOCLAW_API_KEY` | | real OpenAI-compatible endpoint, model id, key |
| `NEMOCLAW_INFERENCE_PROVIDER` | `default` | OpenShell provider name |
| `OPENCLAW_GATEWAY_PASSWORD`, `OPENCLAW_AGENT_NAME` | `openclaw`, `shifty` | unchanged |

Per-attendee isolation means sandbox names (`shifty`, `lab`, fleet roles) stay fixed: each attendee has
their own gateway. Pod / Sandbox CR names are now `default--<name>` (shared workspace mode).

## Inference (0.1.6 — `inference.local` / `openshell inference` are REMOVED)

1. Profile `manifests/openclaw/inference-profile.yaml.tmpl` (id `maas-openai`, credential env var
   `OPENAI_API_KEY`, `auth_style: bearer`, endpoint host/port parsed from `NEMOCLAW_INFERENCE_BASE_URL`,
   protocol rest, access read-write, binaries = node + curl paths). Rendered with envsubst.
2. Per gateway: `openshell provider profile import -f <rendered>` then
   `openshell provider create --name "$NEMOCLAW_INFERENCE_PROVIDER" --type maas-openai --credential OPENAI_API_KEY=<key>`.
3. Sandboxes: `openshell sandbox create … --provider "$NEMOCLAW_INFERENCE_PROVIDER"` (or
   `openshell sandbox provider attach <sb> <provider> --wait`).
4. Inside the sandbox `$OPENAI_API_KEY` is a placeholder (`openshell:resolve:env:…`); the supervisor
   proxy swaps it for the real key on egress to the profile endpoint (verified with an echo server).
   OpenClaw `baseUrl` = the REAL base URL; its API key = the `$OPENAI_API_KEY` placeholder.
5. Sandboxes must ALWAYS be created with `--policy` and kept alive with `--detach -- sleep infinity`
   (a trailing command that exits makes the sandbox Completed / not Ready).

## RBAC (lab mode) — workshop ServiceAccount, least privilege

- Role in `<u>-openshell`: get/list/watch pods, pods/log, services, endpoints, events, configmaps,
  deployments, statefulsets, replicasets, routes, sandboxes (`agents.x-k8s.io`); create pods/exec.
- RoleBinding to ClusterRole `admin` in `<u>-demo` (apply/delete/scale the demo app).
- Cluster-scoped, read-only only: nodes get/list, customresourcedefinitions get. NO cluster-wide exec,
  NO cluster-wide pod/log reads.
- Telemetry: queries scoped to the attendee's namespaces (see platform design).

## Ownership

- `web/**` → web workstream.
- `chart/**`, `scripts/**`, `manifests/**`, `policies/**`, `deploy/**`, `fleet.txt`, `.github/**`, `helm/**`,
  `.env.example`, `images/**` → platform workstream.
- `README.md`, `CLAUDE.md`, `README-DEPLOYMENT-REVIEW.md`, `docs/*.md` → integration (main session).

## Adopted multi-tenant design decisions (full design: scratchpad multitenant-design.md)

- Two namespaces per attendee: `<u>-openshell`, `<u>-demo`; labels `lab.nemoclaw.io/managed=true`,
  `lab.nemoclaw.io/user=<u>`, `lab.nemoclaw.io/role=openshell|demo`. New chart value `global.demoNamespace`
  (default `demo`); everything else derives from `.Release.Namespace`. Defaults reproduce single mode.
- Demo app kustomization becomes namespace-agnostic (no Namespace object, no `namespace:` fields, short
  service names); applied with `kubectl -n "$DEMO_NAMESPACE" apply -k` / `delete -k`. Namespaces are
  pre-created by deploy.sh / lab.sh.
- Registry host in sandbox policies MUST be the FQDN `registry.<ns>.svc.cluster.local` — verified on OCP:
  the OpenShell 0.1.6 proxy does NOT resolve single-label hosts (`http://echo:8080` → 000, FQDN → 200).
  Policies keep `registry.openshell.svc.cluster.local`; the workshop entrypoint / fleet.sh substitute
  the namespace at runtime when it is not `openshell`.
- Workshop access gate (lab): `LAB_ACCESS_TOKEN` env (Secret `workshop-access`), cookie set from
  `/?token=…`, required on HTTP, `/api/*` and the `/ws/term` upgrade (also `Authorization: Bearer`);
  ungated `/healthz` for probes. No token = gate off (single mode unchanged).
- Per-attendee random `OPENCLAW_GATEWAY_PASSWORD` in lab mode (Secret `workshop-access`).
- OpenShell gateway Route disabled by default (it exposes an unauthenticated gateway); value
  `openshell.route.enabled`.
- RBAC: ClusterRole `<ns>-workshop` read-only nodes/SCC/CRDs only; `view` + Role `workshop-self`
  (sandboxes get/list/watch, `serviceaccounts/token` create for `telemetry-reader`, pods/exec create only
  if `workshop.rbac.allowExec` — true single, false lab) in `<u>-openshell`; demo write rules + `view` in
  `<u>-demo`; read-only pods/services/routes in platform namespaces (openshift-monitoring,
  openshift-logging, observability-hub, monitoring). No more `cluster-monitoring-view` for the workshop,
  no Role in the shared `monitoring` namespace.
- NetworkPolicies (value `isolation.networkPolicies.enabled`, true in lab): default-deny ingress +
  allow same-namespace in both namespaces; allow OpenShift router → workshop; allow monitoring → demo.
- Telemetry: per-attendee SA `telemetry-reader` in `<u>-openshell` (RoleBindings in both attendee
  namespaces); fleet token from it (24h). Metrics via Thanos tenancy port 9092 `?namespace=$DEMO_NAMESPACE`;
  Loki filtered on `kubernetes_namespace_name`; per-instance event-exporter in `<u>-openshell` watching
  `<u>-demo`; demo app spans carry `k8s.namespace.name` (downward API) and TraceQL filters on it.
- Grafana: sidecars restricted to their own namespace, namespaced RBAC; anonymous Viewer in lab mode.
- LimitRange + ResourceQuota per attendee namespace; namespace node-selector annotation keeps lab pods
  off control-plane nodes (label workers `node-role.kubernetes.io/lab=`).
- Shared prepull DaemonSet in `lab-shared` (sandbox, supervisor, gateway, workshop images…); per-release
  prepull disabled in lab mode.
- Capacity: every sandbox gets a 2Gi EBS PVC (workspace); ~8 per attendee → ~248 attachments for 30,
  cluster has 156 (26/node). Needs more workers (MachineSets) — decision deferred to the scale test.

## OpenShell 0.0.71 → 0.1.6 migration notes (from the research report)

- Fresh reinstall only (StatefulSet serviceName changed; sandboxes must be recreated).
- Chart values: `server.sandboxImage`/`sandboxImagePullPolicy` are IGNORED → use
  `sandbox.image.{repository,tag,pullPolicy}`; `supervisor.sideloadMethod` REMOVED; `server.disableTls`,
  `auth.allowUnauthenticatedUsers` (deprecated alias, still works), `sandboxJwt.secretDefaultMode`,
  `networkPolicy.enabled` still valid; podSecurityContext `null` + securityContext.runAsUser `null`
  (umbrella level, Helm nested-null bug); `agentSandbox.preflight.enabled` must be false for offline
  `helm template`/lint (CI); new `workspaceStorageClass`.
- Privileged SCC no longer needed (sandboxes run restricted-v2) → drop scc-grants.
- Cluster-scoped objects of the chart: ClusterRole/Binding `<fullname>-node-reader-<release ns>` (unique
  per namespace).
- CLI breaking: `openshell inference set|get|update` removed; `sandbox create … -- true` → use
  `--detach -- sleep infinity`; `policy update --add-deny` needs `--rule-name` + `--binary`/`--any-binary`;
  `policy prove` removed; `gateway info` admin-gated → `gateway list -o json`; Sandbox CR / pod names are
  `default--<name>`, plus a supervisor pod `os-supervisor-<id>` per sandbox; `--provider <name>` on create
  or `sandbox provider attach <sb> <provider> --wait`; `forward start <port> <sb>` needs `ssh` (present in
  the workshop image). `gateway add https://<route> --local` fails without mTLS certs → use in-cluster http.
- Protos: re-vendor `openshell.proto`, `datamodel.proto`, `sandbox.proto`, `options.proto` from the v0.1.6
  tag (`proto/`); `inference.proto` deleted; options.proto imports google/protobuf/descriptor.proto
  (proto-loader includeDirs). Draft RPCs: `name` → `sandbox`, `workspaceScope: {workspace: "default"}`
  required, ApproveDraftChunk needs `reviewToken` from GetDraftPolicy, `requestId` optional, `*_at_ms`
  → Timestamp `*_time`; uint64 `draftVersion` comes back as string.
- Upstream source checkout for reference: scratchpad/research/os-0.1.6 (proto/, docs/, providers/,
  crates/), rendered chart: scratchpad/research/chart-0.1.6/helm-chart.
