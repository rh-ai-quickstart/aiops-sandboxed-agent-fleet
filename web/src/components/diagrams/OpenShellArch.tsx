import { ArchExplorer } from "./ArchExplorer";

const NV = "#76b900", PURPLE = "#a78bfa", BLUE = "#6f8fd0", GREEN = "#34d399", AMBER = "#e0a800", CYAN = "#22d3ee";

export function OpenShellArch() {
  return (
    <ArchExplorer
      title="OpenShell isn’t one thing — click each part"
      nodes={[
        { id: "gw", label: "Gateway", sub: "control plane · gRPC :8080", color: NV, detail: <>The OpenShell <strong>gateway</strong> — the brain. A Helm-installed workload (StatefulSet on SQLite, or HA Deployment on Postgres) that exposes a gRPC API and hosts the pieces below: the compute driver, the credential store (providers), supervisor bootstrap, policy, and mTLS/OIDC auth.</> },
        { id: "driver", label: "Compute driver", sub: "Kubernetes", color: BLUE, detail: <>Watches and creates sandboxes. On <code>openshell sandbox create</code> it writes an <code>agents.x-k8s.io Sandbox</code> CR and wires the sandbox up. Healthy = the log line <code>Listing sandboxes from Kubernetes</code>. Other drivers exist; we use the Kubernetes one.</> },
        { id: "l7", label: "Providers", sub: "profiles · credential placeholders", color: CYAN, detail: <>Secrets live in the gateway as <strong>providers</strong>, each typed by a <strong>provider profile</strong> (allowed host + port, auth style, the binaries that may use it). An attached sandbox only sees a <strong>placeholder</strong> (<code>openshell:resolve:env:…</code>); the supervisor swaps in the real key on egress, only toward the profile&apos;s endpoint. Rotate the key once at the gateway; attached sandboxes pick it up.</> },
        { id: "supervisor", label: "Supervisor", sub: "one per sandbox", color: PURPLE, detail: <>The <strong>supervisor</strong> the gateway delivers to every sandbox (on Kubernetes, an <code>os-supervisor-…</code> pod per sandbox). It bootstraps and oversees the agent process, builds its sealed network namespace, enforces the sandbox-side policy through its egress proxy, and swaps credential placeholders for real secrets on the way out.</> },
        { id: "policy", label: "Policy + mTLS", sub: "deny-by-default", color: AMBER, detail: <>Per-sandbox L7 policy (the per-binary/method/path schema in <code>policies/</code>) plus mTLS between components. Combined with OpenShift NetworkPolicy + SCCs, this is the defense-in-depth that bounds what an agent can do.</> },
        { id: "sig", label: "agent-sandbox", sub: "kubernetes-sigs · the CRD", color: GREEN, detail: <>Underneath it all is the open-source <strong>kubernetes-sigs/agent-sandbox</strong> project: the <code>Sandbox</code> CRD (<code>agents.x-k8s.io</code>) + a controller that reconciles a CR into a Pod + storage. OpenShell builds on this primitive; <code>oc get sandboxes</code> shows the fleet as plain Kubernetes objects.</> },
      ]}
    />
  );
}
