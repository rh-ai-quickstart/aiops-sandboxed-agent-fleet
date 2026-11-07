import { ArchExplorer } from "./ArchExplorer";

const NV = "#76b900", PURPLE = "#a78bfa", BLUE = "#6f8fd0", GREEN = "#34d399", AMBER = "#e0a800";

export function SandboxFlow() {
  return (
    <ArchExplorer
      flow
      title="How a new sandbox is born — click each step"
      nodes={[
        { id: "req", label: "1 · Request", sub: "Sandbox CR  or  gateway gRPC", color: BLUE, detail: <>You declare a desired sandbox. Two ways: apply a <code>Sandbox</code> CR with <code>oc</code>, or — what we do in this lab — call the <strong>OpenShell gateway</strong> (<code>openshell sandbox create</code>, gRPC :8080), which writes the CR for you (named <code>default--&lt;name&gt;</code>) and starts its supervisor. Either way the desired state lands as a <code>sandboxes.agents.x-k8s.io</code> object.</> },
        { id: "reconcile", label: "2 · Reconcile", sub: "agent-sandbox controller", color: NV, detail: <>The <strong>agent-sandbox controller</strong> (ns <code>agent-sandbox-system</code>) watches Sandbox CRs. OpenShell&apos;s <strong>compute driver</strong> watches too (&quot;Listing sandboxes from Kubernetes&quot;). When a new CR appears, the controller builds the Pod from the CR&apos;s <code>podTemplate</code>.</> },
        { id: "schedule", label: "3 · Schedule", sub: "RBAC · SCC · NetworkPolicy", color: AMBER, detail: <>OpenShift schedules the pod under the namespace&apos;s guardrails — RBAC, Security Context Constraints, and any NetworkPolicy (deny-by-default for the agent). The sandbox can only do what policy allows.</> },
        { id: "run", label: "4 · Run", sub: "the agent boots", color: PURPLE, detail: <>The pod starts; the OpenClaw gateway comes up inside the sandbox on its private port :30789 and reads its workspace (IDENTITY/SOUL) + config. The Sandbox CR&apos;s <code>Ready</code> condition turns True and the gateway reports the sandbox Ready.</> },
        { id: "use", label: "5 · Use", sub: "exec in · or the UI", color: GREEN, detail: <>Now you interact: <code>openshell sandbox exec</code> into the sandbox to run the agent CLI (the <code>sbox-openclaw</code> helper), or open its Control UI through <code>openshell forward</code>. Delete it with <code>openshell sandbox delete &lt;name&gt;</code>: the gateway removes the CR and the controller tears the pod down.</> },
      ]}
    />
  );
}
