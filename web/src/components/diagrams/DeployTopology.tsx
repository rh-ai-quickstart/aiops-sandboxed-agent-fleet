"use client";
import { useState, type ReactNode } from "react";

// Fleet-demo-style end-to-end topology of THIS workshop: OpenShift cluster with
// the OpenShell gateway, the agent-sandbox controller, and the sandbox pods, plus how
// you reach them (Routes) and remote inference. Click a box.

const NV = "#76b900", BLUE = "#6f8fd0", PURPLE = "#a78bfa", AMBER = "#e0a800",
      GREEN = "#34d399", SLATE = "#94a3b8", CYAN = "#22d3ee";

type Box = { id: string; label: string; sub?: string; color: string; detail: ReactNode };

const BOXES: Record<string, Box> = {
  gw:    { id: "gw", label: "OpenShell Gateway", sub: "StatefulSet · gRPC :8080", color: NV,
           detail: <>Helm-installed control plane (OpenShell 0.1.6). Compute driver watches the Sandbox CRD; mints sandbox JWTs; stores policy and provider credentials. Reached through its in-cluster Service only — no public Route (it accepts unauthenticated clients).</> },
  ctrl:  { id: "ctrl", label: "agent-sandbox controller", sub: "agent-sandbox-system · v1.0.3", color: BLUE,
           detail: <>kubernetes-sigs/agent-sandbox v1.0.3, installed once per cluster. Reconciles each <code>agents.x-k8s.io/v1beta1</code> Sandbox CR into a Pod (+PVC) — the API version the 0.1.6 gateway speaks.</> },
  shifty:{ id: "shifty", label: "Shifty (OpenClaw)", sub: "sandbox default--shifty", color: PURPLE,
           detail: <>Your agent — an OpenClaw sandbox serving its control UI (device pairing, chat) on sandbox-internal port <code>30789</code>. The workshop pod&apos;s <code>openclaw-forward</code> sidecar bridges it with <code>openshell forward</code>, and the <code>openclaw-ui</code> Route exposes that. Its identity lives in workspace <code>.md</code> files.</> },
  sbx:   { id: "sbx", label: "Sandbox pods", sub: "default--<name> + os-supervisor-…", color: GREEN,
           detail: <>Gateway-created sandboxes (<code>openshell sandbox create</code>), in the gateway&apos;s own namespace. Each is a Pod <code>default--&lt;name&gt;</code> with an <code>agent</code> container on a PVC, plus a supervisor pod the gateway runs for it — under the <code>restricted-v2</code> SCC (no privileged grant) and, in a shared lab, NetworkPolicies that keep other attendees out.</> },
  console:{ id: "console", label: "OpenShift Console", sub: "Route · /console", color: AMBER,
           detail: <>The web console for the cluster (read the whole stack as native objects), reached via its OpenShift <code>Route</code>. Optional — hidden in a shared lab without per-attendee console logins.</> },
  inf:   { id: "inf", label: "Remote inference", sub: "OpenAI-compatible", color: CYAN,
           detail: <>No local GPU. The key is stored in the gateway as a <em>provider</em>; sandboxes it&apos;s attached to call the real endpoint with a placeholder key, and the supervisor injects the real one on egress — only toward that endpoint, only from <code>node</code>/<code>curl</code>.</> },
};

function B({ id, sel, onSelect }: { id: string; sel: string; onSelect: (id: string) => void }) {
  const b = BOXES[id];
  return (
    <button onClick={() => onSelect(id)}
      className="w-full rounded-lg border px-3 py-2 text-left transition"
      style={{ borderColor: b.color, background: sel === id ? `${b.color}26` : "transparent",
               boxShadow: sel === id ? `0 0 0 1px ${b.color}` : "none", opacity: sel === id ? 1 : 0.82 }}>
      <div className="text-[13px] font-semibold" style={{ color: b.color }}>{b.label}</div>
      {b.sub && <div className="text-[10px] text-[var(--color-fg-mut)]">{b.sub}</div>}
    </button>
  );
}

export function DeployTopology() {
  const [sel, setSel] = useState("gw");
  const active = BOXES[sel];

  return (
    <figure className="my-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      <figcaption className="mb-3 text-sm text-[var(--color-fg-mut)]">What actually runs on your cluster — click a box</figcaption>
      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
        <div className="rounded-xl border border-dashed p-3" style={{ borderColor: SLATE }}>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-fg-mut)]">OpenShift cluster (Helm-deployed)</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-[var(--color-line)] p-2">
              <div className="mb-1 text-[10px] text-[var(--color-fg-mut)]">ns: &lt;user&gt;-openshell (single: openshell)</div>
              <div className="space-y-2"><B sel={sel} onSelect={setSel} id="gw" /><B sel={sel} onSelect={setSel} id="sbx" /></div>
            </div>
            <div className="rounded-lg border border-[var(--color-line)] p-2">
              <div className="mb-1 text-[10px] text-[var(--color-fg-mut)]">control + agents</div>
              <div className="space-y-2"><B sel={sel} onSelect={setSel} id="ctrl" /><B sel={sel} onSelect={setSel} id="shifty" /><B sel={sel} onSelect={setSel} id="console" /></div>
            </div>
          </div>
        </div>
        <div className="flex flex-col justify-center gap-2 md:w-[190px]">
          <B sel={sel} onSelect={setSel} id="inf" />
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)] p-4 text-sm text-[var(--color-fg-dim)]">
        <div className="mb-1 text-xs font-semibold" style={{ color: active.color }}>{active.label}</div>
        <div>{active.detail}</div>
      </div>
    </figure>
  );
}
