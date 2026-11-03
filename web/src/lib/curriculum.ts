// Single source of truth for the workshop's parts/lessons nav.
// Each lesson maps to src/content/<slug>.mdx. hasLab → renders the live terminal.
export type Lesson = { slug: string; title: string; blurb: string; minutes: number; hasLab?: boolean };
export type Part = { id: string; title: string; subtitle: string; accent?: "rh" | "nv"; lessons: Lesson[] };

export const CURRICULUM: Part[] = [
  {
    id: "welcome",
    title: "Part I · Welcome",
    subtitle: "The event, the platform, what you need",
    lessons: [
      { slug: "welcome", title: "Welcome — Red Hat × NVIDIA", blurb: "WeAreDevelopers 2026: build a sandboxed AI agent on OpenShift, powered by NVIDIA.", minutes: 5 },
      { slug: "prerequisites", title: "Prerequisites", blurb: "A laptop, a browser, and access to an OpenShift cluster. No GPU needed on your side.", minutes: 4 },
    ],
  },
  {
    id: "platform",
    title: "Part II · What's Already Running",
    subtitle: "The platform we pre-built for you — how it was made, and how to read it",
    accent: "rh",
    lessons: [
      { slug: "big-picture", title: "The Big Picture", blurb: "OpenShift cluster → OpenShell gateway → your sealed agent → an OpenAI-compatible model endpoint.", minutes: 8 },
      { slug: "why-openshift", title: "Why OpenShift", blurb: "Red Hat's enterprise Kubernetes — and why it's the base.", minutes: 7 },
      { slug: "the-cluster", title: "Your Cluster, Already Up", blurb: "How the stack was deployed — and inspect it live with oc.", minutes: 8, hasLab: true },
      { slug: "openshell", title: "The OpenShell Gateway", blurb: "The agent control plane: agent-sandbox CRD + the Helm chart + the compute driver — and drive it with the CLI.", minutes: 9, hasLab: true },
    ],
  },
  {
    id: "understand-openshell",
    title: "Part III · How OpenShell Works",
    subtitle: "Understand and drive the control plane — before you build an agent on it",
    accent: "nv",
    lessons: [
      { slug: "openshell-ops", title: "Control Plane & Policies", blurb: "The gateway, the sandbox CRD, and the deny-by-default policy model that governs every agent.", minutes: 10, hasLab: true },
      { slug: "explore", title: "Explore It Hands-On", blurb: "Spin a throwaway sandbox and play with every part: status, logs/audit, policy, providers, forward.", minutes: 12, hasLab: true },
    ],
  },
  {
    id: "build-agent",
    title: "Part IV · Build Your Agent",
    subtitle: "Hands-on: create an OpenClaw agent on the gateway, step by step",
    accent: "nv",
    lessons: [
      { slug: "inference", title: "Set Your Inference Endpoint", blurb: "Verify your endpoint, model & key, then register them with the gateway as a provider — the agent never holds the key.", minutes: 6, hasLab: true },
      { slug: "create-agent", title: "Create Your Agent", blurb: "openshell sandbox create + an egress policy → your own sealed OpenClaw sandbox.", minutes: 10, hasLab: true },
      { slug: "configure", title: "Give It a Brain", blurb: "Stage openclaw.json (real endpoint + placeholder key + gateway auth) and start the OpenClaw gateway inside the sandbox.", minutes: 9, hasLab: true },
      { slug: "access", title: "Open the Agent UI", blurb: "Open the Control UI — bridged out of the seal by openshell forward, exposed via an OpenShift Route.", minutes: 6, hasLab: true },
      { slug: "pairing", title: "Pair Your Browser", blurb: "First open asks for device pairing — approve it: sbox-openclaw devices list / approve.", minutes: 7, hasLab: true },
      { slug: "chat", title: "Talk to Your Agent", blurb: "Your first conversation — and watch the policy + sandbox in action.", minutes: 7, hasLab: true },
    ],
  },
  {
    id: "operate",
    title: "Part V · Make It Yours & Operate",
    subtitle: "Give it identity and isolation, extend it with tools & skills, then run it as a real agent",
    accent: "nv",
    lessons: [
      { slug: "soul", title: "Identity & Soul", blurb: "The workspace .md files that ARE the agent's memory and personality.", minutes: 8, hasLab: true },
      { slug: "into-the-sandbox", title: "Into a Sandbox", blurb: "A sandbox IS a pod — but sealed. exec in two ways and see the isolation.", minutes: 8, hasLab: true },
      { slug: "web-search", title: "Give It Web Search", blurb: "Turn on free, key-free DuckDuckGo search — governed by the same egress policy.", minutes: 8, hasLab: true },
      { slug: "skills", title: "Skills & Governance", blurb: "Install a verified skill from ClawHub, author your own, and govern which skills run.", minutes: 12, hasLab: true },
      { slug: "heartbeat", title: "Heartbeat — Run It Autonomously", blurb: "A scheduled self-prompt turns the agent into an operator that watches on its own.", minutes: 8, hasLab: true },
      { slug: "openai-api", title: "OpenAI-Compatible API", blurb: "Expose /v1/chat/completions so any OpenAI client can call your governed agent.", minutes: 8, hasLab: true },
    ],
  },
  {
    id: "build",
    title: "Part VI · Build Something Useful",
    subtitle: "The capstone: an SRE copilot fleet that investigates a real incident",
    accent: "nv",
    lessons: [
      { slug: "what-youll-build", title: "The Challenge: An SRE Copilot Fleet", blurb: "Four sealed agents — logs, metrics, traces, events — each scoped to one backend, combined by a lead analyst to find root cause.", minutes: 8 },
      { slug: "fleet-spinup", title: "Spin Up & Give Each a Soul", blurb: "One command brings the fleet up; each agent gets its own IDENTITY/SOUL, a skill, and a policy scoped to just its tool.", minutes: 10, hasLab: true },
      { slug: "fleet-status", title: "The Fleet, at a Glance", blurb: "One page: every agent's status, the exact egress its policy allows, and its SOUL — proof each policy is specific to its tool.", minutes: 6, hasLab: true },
      { slug: "incident-lab", title: "Orchestrate & Resolve an Incident", blurb: "Deploy an app, break it, let the fleet investigate and recommend a fix — then you review, adjust, and approve the change.", minutes: 14, hasLab: true },
      { slug: "orchestration", title: "Under the Hood: How It's Orchestrated", blurb: "The real code and prompts behind the fleet — the fixed plan, each agent's prescribed probe, the cluster-telemetry skill, and the analyst's synthesis. Nothing hidden.", minutes: 10 },
      { slug: "build-your-own", title: "Build Your Own", blurb: "The fleet is a pattern, not a fixed thing — concrete new agents, faults, and skills to extend it with, on your own.", minutes: 8 },
    ],
  },
  {
    id: "reference",
    title: "Part VII · Reference",
    subtitle: "A live fleet view, the observability stack, and when something goes sideways",
    lessons: [
      { slug: "live", title: "Live OpenShell", blurb: "Your gateway, sandboxes, logs & policy — read live from the cluster, in this page.", minutes: 4 },
      { slug: "monitoring", title: "Observability", blurb: "Grafana + Prometheus + Loki + Tempo — pre-deployed; open the fleet dashboards.", minutes: 8, hasLab: true },
      { slug: "troubleshooting", title: "Troubleshooting & FAQ", blurb: "The gotchas we hit so you don't have to.", minutes: 8, hasLab: true },
      { slug: "resources", title: "Resources & Links", blurb: "Docs, repos, and where to go deeper.", minutes: 4 },
    ],
  },
];

export const ALL_LESSONS: (Lesson & { partId: string; partTitle: string })[] =
  CURRICULUM.flatMap((p) => p.lessons.map((l) => ({ ...l, partId: p.id, partTitle: p.title })));

export function lessonNeighbors(slug: string) {
  const i = ALL_LESSONS.findIndex((l) => l.slug === slug);
  return {
    prev: i > 0 ? ALL_LESSONS[i - 1] : null,
    next: i >= 0 && i < ALL_LESSONS.length - 1 ? ALL_LESSONS[i + 1] : null,
    current: i >= 0 ? ALL_LESSONS[i] : null,
  };
}

export const FIRST_SLUG = ALL_LESSONS[0]?.slug ?? "welcome";
