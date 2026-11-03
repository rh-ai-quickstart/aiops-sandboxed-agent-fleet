import { ArchExplorer } from "./ArchExplorer";

const NV = "#76b900", PURPLE = "#a78bfa", BLUE = "#6f8fd0", GREEN = "#34d399", AMBER = "#e0a800";

export function OpenClawArch() {
  return (
    <ArchExplorer
      title="OpenClaw agent — click a piece to see what it does"
      nodes={[
        { id: "ui", label: "Control UI / Gateway", sub: "sandbox-internal :30789", color: NV, detail: <>The web UI you open in a browser to chat with and steer the agent. It’s a WebSocket gateway; it also enforces <strong>auth</strong> (a password) and <strong>device pairing</strong> for each browser. Listens on port 30789 inside the sandbox’s private network namespace, bridged out by <code>openshell forward</code> and exposed via an OpenShift <code>Route</code>.</> },
        { id: "runtime", label: "Agent runtime", sub: "plans · calls tools", color: PURPLE, detail: <>The agent loop: it reasons, calls tools, and edits its workspace. It has no model of its own — it sends prompts to the configured inference provider.</> },
        { id: "config", label: "Config", sub: "~/.openclaw/openclaw.json", color: BLUE, detail: <>Declares the model <em>provider</em> (baseUrl + apiKey + model id, OpenAI-compatible) and defaults. Writable, so the Control UI’s onboarding can save it. You’ll edit this in the <strong>Add a Model</strong> lesson.</> },
        { id: "workspace", label: "Workspace", sub: "PVC · the agent’s memory", color: GREEN, detail: <>A persistent volume holding the agent’s files — including <code>IDENTITY.md</code>, <code>SOUL.md</code>, <code>AGENTS.md</code>, <code>TOOLS.md</code>. These <em>are</em> the agent’s memory and personality (see the <strong>Meet Shifty</strong> lesson).</> },
        { id: "auth", label: "Auth & pairing", sub: "password + device approve", color: AMBER, detail: <>The gateway runs <code>--auth password</code>. A first-time browser also needs one-time <strong>device pairing</strong> — approved from the lab shell with <code>sbox-openclaw devices approve</code> (the <strong>Device Pairing</strong> lesson).</> },
      ]}
    />
  );
}
