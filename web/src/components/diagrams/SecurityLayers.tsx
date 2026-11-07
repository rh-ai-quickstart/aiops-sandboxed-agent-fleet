import { ArchExplorer } from "./ArchExplorer";

const RH = "#ff4d4d", NV = "#76b900", BLUE = "#6f8fd0", PURPLE = "#a78bfa", CYAN = "#22d3ee";

export function SecurityLayers() {
  return (
    <ArchExplorer
      title="Defense in depth — what bounds the agent (click each layer)"
      nodes={[
        { id: "ns", label: "Namespace + RBAC", sub: "OpenShift", color: RH, detail: <>The agent lives in its own namespace with a scoped ServiceAccount. RBAC decides what Kubernetes verbs that identity may use — by default, almost nothing outside its sandbox. In a shared lab each attendee gets their own namespaces, and even the workshop shell may not <code>oc exec</code> into sandbox pods.</> },
        { id: "scc", label: "Security Context Constraints", sub: "non-root · drop caps", color: RH, detail: <>OpenShift SCCs force the agent to run <strong>non-root</strong> under the namespace&apos;s arbitrary UID (<code>restricted-v2</code>), with <code>allowPrivilegeEscalation: false</code> and <strong>all Linux capabilities dropped</strong>. No host mounts, no privileged mode — OpenShell 0.1.6 sandboxes need no extra SCC.</> },
        { id: "netpol", label: "NetworkPolicy", sub: "deny-by-default egress", color: BLUE, detail: <>Kubernetes <code>NetworkPolicy</code> adds a cluster-level fence: in a shared lab, deny-by-default ingress keeps every attendee&apos;s gateway, registry, sandboxes and demo app unreachable from other attendees&apos; namespaces. The sandbox&apos;s own egress is fenced by the OpenShell proxy (next layer).</> },
        { id: "l7", label: "OpenShell L7 policy", sub: "per-binary/method/path", color: NV, detail: <>When running under OpenShell&apos;s supervisor, a deny-by-default <strong>L7 policy</strong> (the schema in <code>policies/</code>) controls which binaries/methods/paths the agent may use — far finer-grained than L4.</> },
        { id: "mtls", label: "Credential placeholders", sub: "OpenShell providers", color: CYAN, detail: <>Secrets live in the gateway as <strong>providers</strong>; the agent only ever holds a <strong>placeholder</strong>, and the supervisor injects the real model key on egress — only toward the endpoint the provider profile allows. Compromise the agent, you still don&apos;t get the key.</> },
        { id: "runtime", label: "Runtime isolation", sub: "pod · (gVisor optional)", color: PURPLE, detail: <>Standard pod/container isolation here. The full OpenShell product can add a <strong>gVisor (runsc) RuntimeClass</strong> for kernel-level syscall sandboxing — stronger isolation optionally enabled on the OpenShift cluster, the same posture used in production fleets.</> },
      ]}
    />
  );
}
