"use client";
import { useState, type ReactNode } from "react";

// Detailed, interactive "OpenShell on Kubernetes" deployment — modelled on the NVIDIA
// deck's architecture slide. Click any object to see what it is, plus how THIS workshop
// maps to it. Grouped by where things actually live: external clients, the openshell
// namespace (gateway + its state), the agent-sandbox controller, and the sandbox pods.

const NV = "#76b900", BLUE = "#6f8fd0", PURPLE = "#a78bfa", AMBER = "#e0a800",
      GREEN = "#34d399", SLATE = "#94a3b8", CYAN = "#22d3ee", RED = "#ef6b6b";

type N = { id: string; label: string; sub?: string; color: string; what: ReactNode; ours: ReactNode };

const NODES: Record<string, N> = {
  cli: { id: "cli", label: "CLI / SDK / TUI", sub: "openshell …", color: SLATE,
    what: <>The operator surface. <code>openshell gateway add</code>, <code>sandbox create</code>, <code>policy set</code>, <code>provider create</code>. Authenticates with an mTLS client cert + (optionally) an OIDC JWT.</>,
    ours: <>Installed in the workshop shell and registered against the gateway via the in-cluster Service (no OIDC in this dev setup).</> },
  oidc: { id: "oidc", label: "OIDC Identity Provider", sub: "Keycloak / Entra ID", color: AMBER,
    what: <>Issues JWTs with role claims so the gateway can do per-method authorization (admin vs read-only user). Powers the OpenShell Console login.</>,
    ours: <>Disabled for the workshop — the gateway runs with <code>allowUnauthenticatedUsers</code> so the CLI works with no SSO. That&apos;s why it stays in-cluster; a multi-user lab gives each attendee their own gateway instead.</> },
  grpcroute: { id: "grpcroute", label: "Service", sub: "ClusterIP :8080", color: BLUE,
    what: <>Inbound gRPC reaches the gateway through a Kubernetes <strong>Service</strong>, optionally fronted by an OpenShift <strong>Route</strong> (edge TLS + HTTP/2) for external access.</>,
    ours: <>ClusterIP only — the gateway Route is <strong>off</strong> by default, because this gateway accepts unauthenticated clients. The workshop shell and API reach it at <code>http://openshell.&lt;ns&gt;.svc.cluster.local:8080</code>.</> },
  gw: { id: "gw", label: "Gateway StatefulSet", sub: "API · state · policy · credentials", color: NV,
    what: <>The control plane. Serves the gRPC API, stores provider credentials, delivers policy (including provider-composed rules), and <strong>authenticates each sandbox&apos;s supervisor</strong>. StatefulSet on SQLite (or HA Deployment on Postgres).</>,
    ours: <>StatefulSet <code>openshell</code> (SQLite), OpenShell <strong>0.1.6</strong>, <code>disableTls</code> (plaintext in-cluster) for simplicity, running under the default <code>restricted-v2</code> SCC. Its Kubernetes compute driver watches the Sandbox CRD.</> },
  pvc: { id: "pvc", label: "PVC", sub: "durable state", color: GREEN,
    what: <>Persists the gateway&apos;s SQLite DB (sandbox registry, policy revisions, provider config) across restarts.</>,
    ours: <>Bound via the cluster&apos;s default storage provisioner.</> },
  secrets: { id: "secrets", label: "Secrets", sub: "PKI + SSH handshake", color: RED,
    what: <>The gateway-minted sandbox-JWT signing keys + the mTLS PKI used for the supervisor handshake and exec/SSH relay.</>,
    ours: <>No mTLS PKI here (plaintext in-cluster gateway); sandbox identity uses the gateway-minted JWT signing key, mounted with <code>sandboxJwt.secretDefaultMode: 0444</code> so the random-UID gateway pod can read it.</> },
  rbac: { id: "rbac", label: "RBAC", sub: "SA + Role bindings", color: PURPLE,
    what: <>The gateway + sandbox ServiceAccounts and their Roles — what the compute driver may do (create Sandboxes, read pods) and what each sandbox&apos;s SA may do.</>,
    ours: <>No extra OpenShift SCC grants: gateway and sandboxes run under <code>restricted-v2</code>. The chart&apos;s one cluster-scoped grant (a node reader for the gateway) is named per namespace, so several gateways can coexist.</> },
  pki: { id: "pki", label: "pkiInitJob", sub: "cert bootstrap", color: CYAN,
    what: <>A pre-install hook (<code>openshell-gateway generate-certs</code>) that creates the server + client mTLS Secrets in-cluster — or cert-manager Issuers for auto-rotation.</>,
    ours: <>Not needed for this plaintext in-cluster setup; enable it (or cert-manager) together with TLS when you expose the gateway.</> },
  ctrl: { id: "ctrl", label: "agent-sandbox controller", sub: "agents.x-k8s.io · CRDs", color: BLUE,
    what: <>The kubernetes-sigs/agent-sandbox operator. Reconciles each <code>Sandbox</code> CR into a Pod (+ PVC), in its own <code>agent-sandbox-system</code> namespace.</>,
    ours: <><strong>v1.0.3</strong>, serving <code>agents.x-k8s.io/v1beta1</code> — the API the 0.1.6 gateway speaks. Installed once per cluster, shared by every gateway.</> },
  pod: { id: "pod", label: "Sandbox Pod", sub: "agent + its supervisor", color: PURPLE,
    what: <>Each sandbox is a Pod running the <strong>agent</strong> container (OpenClaw, Claude Code, a custom claw…), governed by a <strong>supervisor</strong> the gateway delivers. The supervisor dials the gateway and checks every connection the agent opens against the policy (destination, binary, then L7).</>,
    ours: <>Created by <code>openshell sandbox create</code> in the gateway&apos;s own namespace as <code>default--&lt;name&gt;</code> (plus an <code>os-supervisor-…</code> pod), on the community OpenClaw sandbox image.</> },
  guard: { id: "guard", label: "Network Guardrail + Credential Brokering", sub: "egress · placeholders", color: AMBER,
    what: <>Every outbound connection is checked (deny-by-default, per-binary). Attached <strong>providers</strong> give the sandbox only a placeholder credential; the egress proxy swaps in the real secret, only toward the endpoint the provider profile allows.</>,
    ours: <>Your agent&apos;s OpenClaw config points at the real OpenAI-compatible endpoint (in this lab, Nemotron on the cluster&apos;s GPU via OpenShift AI MaaS) with the placeholder key; the provider profile allows that one host for <code>node</code>/<code>curl</code>.</> },
  addons: { id: "addons", label: "Optional add-ons", sub: "Envoy · cert-manager · LB · GPU", color: SLATE,
    what: <>Envoy Gateway (Gateway API + GRPCRoute), cert-manager (auto cert rotation), a LoadBalancer Service (external addr + SSH relay), and a GPU device plugin (for GPU sandboxes).</>,
    ours: <>Routes expose the workshop and the agent UI; the sandboxes are CPU-only (the lab&apos;s GPU node serves the model through OpenShift AI). The OpenShift observability operators add Prometheus/Loki/Tempo, plus a standalone Grafana.</> },
};

function Chip({ id, sel, onSelect, w }: { id: string; sel: string; onSelect: (id: string) => void; w?: string }) {
  const n = NODES[id];
  return (
    <button onClick={() => onSelect(id)} className={`rounded-lg border px-2.5 py-1.5 text-left transition ${w ?? "w-full"}`}
      style={{ borderColor: n.color, background: sel === id ? `${n.color}26` : "transparent",
               boxShadow: sel === id ? `0 0 0 1px ${n.color}` : "none", opacity: sel === id ? 1 : 0.82 }}>
      <div className="text-[12px] font-semibold leading-tight" style={{ color: n.color }}>{n.label}</div>
      {n.sub && <div className="text-[9.5px] text-[var(--color-fg-mut)]">{n.sub}</div>}
    </button>
  );
}

const Box = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="rounded-lg border border-dashed border-[var(--color-line-2)] p-2">
    <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-[var(--color-fg-mut)]">{title}</div>
    {children}
  </div>
);

export function OpenShellOnK8s() {
  const [sel, setSel] = useState("gw");
  const a = NODES[sel];

  return (
    <figure className="my-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      <figcaption className="mb-3 text-sm text-[var(--color-fg-mut)]">OpenShell on Kubernetes — click any object (detail shows how <em>this</em> workshop maps to it)</figcaption>
      <div className="grid gap-2 lg:grid-cols-[150px_1fr_140px]">
        {/* external clients */}
        <div className="flex flex-col gap-2">
          <Box title="clients"><div className="space-y-2"><Chip sel={sel} onSelect={setSel} id="cli" /><Chip sel={sel} onSelect={setSel} id="oidc" /></div></Box>
        </div>
        {/* the cluster */}
        <div className="rounded-xl border-2 p-2" style={{ borderColor: SLATE }}>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: SLATE }}>Kubernetes cluster</div>
          <div className="rounded-lg border-2 p-2" style={{ borderColor: NV }}>
            <div className="mb-1 text-[10px] font-bold" style={{ color: NV }}>namespace: &lt;user&gt;-openshell (single: openshell)</div>
            <div className="mb-2"><Chip sel={sel} onSelect={setSel} id="grpcroute" /></div>
            <div className="mb-2"><Chip sel={sel} onSelect={setSel} id="gw" /></div>
            <div className="mb-2 grid grid-cols-4 gap-1.5"><Chip sel={sel} onSelect={setSel} id="pvc" /><Chip sel={sel} onSelect={setSel} id="secrets" /><Chip sel={sel} onSelect={setSel} id="rbac" /><Chip sel={sel} onSelect={setSel} id="pki" /></div>
            {/* sandboxes land in the SAME namespace as the gateway (sandboxNamespace: "") */}
            <Chip sel={sel} onSelect={setSel} id="pod" />
          </div>
          <div className="mt-2"><Box title="agent-sandbox-system"><Chip sel={sel} onSelect={setSel} id="ctrl" /></Box></div>
          <div className="mt-2"><Chip sel={sel} onSelect={setSel} id="guard" /></div>
        </div>
        {/* add-ons */}
        <div className="flex flex-col gap-2"><Box title="cluster add-ons"><Chip sel={sel} onSelect={setSel} id="addons" /></Box></div>
      </div>
      <div className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)] p-4 text-sm text-[var(--color-fg-dim)]">
        <div className="mb-1 text-xs font-semibold" style={{ color: a.color }}>{a.label}</div>
        <div className="mb-2">{a.what}</div>
        <div className="rounded border-l-2 pl-2 text-[13px]" style={{ borderColor: NV }}>
          <span className="text-[10px] font-semibold uppercase" style={{ color: NV }}>in this workshop&nbsp;</span>{a.ours}
        </div>
      </div>
    </figure>
  );
}
