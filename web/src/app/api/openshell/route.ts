import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OPENSHELL_NS, childEnv, sandboxDisplayName } from "@/lib/lab-env";

// Live OpenShell data for the learning UI. The web server runs next to the gateway (same
// namespace, same identity that drives the lab shell), so it reads the gateway's state from
// the cluster + the openshell CLI. READ-ONLY, fixed commands; the only variable is a sandbox
// name, validated against a strict pattern and passed as an argv element (execFile, no
// shell) → nothing injectable. (Egress access-request approvals live in /api/drafts.)

const run = promisify(execFile);
const env = childEnv();
const AGENT = process.env.OPENCLAW_AGENT_NAME || "shifty";
const validName = (n: string) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(n);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function oc(args: string[]) {
  const { stdout } = await run("oc", ["-n", OPENSHELL_NS, ...args], { env, timeout: 8000, maxBuffer: 4 << 20 });
  return JSON.parse(stdout);
}
async function openshell(args: string[]) {
  const { stdout } = await run("openshell", args, { env, timeout: 10000, maxBuffer: 4 << 20 });
  return stripAnsi(stdout);
}
async function openshellJson(args: string[]) {
  const out = await openshell(args);
  return JSON.parse(out.slice(Math.max(0, out.search(/[[{]/))));
}

// OpenShell 0.1.6 has no gateway-wide "inference route" any more: a provider (profile +
// credential) is ATTACHED to each sandbox, the sandbox only sees a placeholder and the
// supervisor swaps in the real key on egress to the profile's endpoint. So we surface the
// registered providers (key NAMES only — `provider list -o json` never returns values) and
// what the agent sandbox has attached. Model + endpoint host are non-secret workshop config.
type ProviderJson = { name: string; type: string; credential_keys?: string[]; config_keys?: string[] };
const providerList = (j: unknown): ProviderJson[] =>
  Array.isArray(j) ? (j as ProviderJson[]) : (((j as { providers?: ProviderJson[] })?.providers) ?? []);

function endpointHost(): string | null {
  try { return new URL(process.env.NEMOCLAW_INFERENCE_BASE_URL || "").host || null; } catch { return null; }
}

async function getInference(agentExists: boolean) {
  const wanted = process.env.NEMOCLAW_INFERENCE_PROVIDER || "default";
  const [all, attached] = await Promise.all([
    openshellJson(["provider", "list", "-o", "json"]).then(providerList).catch(() => [] as ProviderJson[]),
    agentExists
      ? openshellJson(["sandbox", "provider", "list", AGENT, "-o", "json"]).then(providerList).catch(() => [] as ProviderJson[])
      : Promise.resolve([] as ProviderJson[]),
  ]);
  const provider = all.find((p) => p.name === wanted) ?? null;
  return {
    configured: !!provider,
    provider: provider?.name ?? null,
    profile: provider?.type ?? null,
    model: process.env.NEMOCLAW_MODEL || null,
    endpointHost: endpointHost(),
    agent: AGENT,
    attached: attached.map((p) => p.name),
    providers: all.map((p) => ({
      name: p.name, type: p.type,
      credentialKeys: p.credential_keys ?? [], configKeys: p.config_keys ?? [],
    })),
  };
}

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const logsFor = url.searchParams.get("logs");
  const policyFor = url.searchParams.get("policy");

  try {
    // --- per-sandbox logs (the gateway/sandbox audit + egress feed) ---
    if (logsFor) {
      if (!validName(logsFor)) return NextResponse.json({ ok: false, error: "bad name" });
      const src = url.searchParams.get("source") ?? "all";
      const source = ["gateway", "sandbox", "all"].includes(src) ? src : "all";
      // Optional line count (the Policy-decisions view pulls a large tail, since egress
      // decisions are sparse and a single skill install can spew >120 lines after them).
      const n = Math.min(Math.max(parseInt(url.searchParams.get("n") || "120", 10) || 120, 1), 4000);
      const out = await openshell(["logs", logsFor, "-n", String(n), "--source", source]).catch((e) => `(${e instanceof Error ? e.message : e})`);
      return NextResponse.json({ ok: true, name: logsFor, source, text: out });
    }

    // --- per-sandbox effective policy (full YAML incl. provider-composed endpoints) ---
    if (policyFor) {
      if (!validName(policyFor)) return NextResponse.json({ ok: false, error: "bad name" });
      const out = await openshell(["policy", "get", policyFor, "--full"]).catch((e) => `(${e instanceof Error ? e.message : e})`);
      return NextResponse.json({ ok: true, name: policyFor, text: out });
    }

    // --- default: gateway health + the sandbox fleet + inference providers ---
    const [sb, pods] = await Promise.all([
      oc(["get", "sandboxes.agents.x-k8s.io", "-o", "json"]).catch(() => ({ items: [] })),
      oc(["get", "pods", "-o", "json"]).catch(() => ({ items: [] })),
    ]);
    type Pod = { metadata: { name: string }; status?: { phase?: string; containerStatuses?: { ready?: boolean; restartCount?: number }[] } };
    const podByName = new Map<string, Pod>();
    for (const p of (pods.items ?? []) as Pod[]) podByName.set(p.metadata.name, p);
    type SB = { metadata: { name: string; creationTimestamp?: string }; status?: { phase?: string; conditions?: { type?: string; status?: string }[] } };
    const sandboxes = ((sb.items ?? []) as SB[]).map((s) => {
      // 0.1.6: the Sandbox CR and its pod are `<workspace>--<name>` (e.g. `default--shifty`)
      const pod = podByName.get(s.metadata.name);
      const cs = pod?.status?.containerStatuses ?? [];
      const readyCond = (s.status?.conditions ?? []).find((c) => c.type === "Ready");
      return {
        name: sandboxDisplayName(s.metadata.name),
        object: s.metadata.name,
        phase: s.status?.phase || pod?.status?.phase || (readyCond?.status === "True" ? "Ready" : "—"),
        ready: cs.length ? cs.every((c) => c.ready) : readyCond?.status === "True",
        restarts: cs.reduce((n, c) => n + (c.restartCount ?? 0), 0),
        created: s.metadata.creationTimestamp ?? null,
      };
    });
    const inference = await getInference(sandboxes.some((s) => s.name === AGENT)).catch(() => null);
    const gateway = { ready: false, version: null as string | null };
    try {
      const ss = await oc(["get", "statefulset", "openshell", "-o", "json"]);
      gateway.ready = (ss.status?.readyReplicas ?? 0) >= 1;
      const img: string = ss.spec?.template?.spec?.containers?.[0]?.image ?? "";
      const m = /gateway[^:/]*:([^\s@]+)/.exec(img);
      gateway.version = m ? m[1] : null;
    } catch { /* gateway not readable */ }
    return NextResponse.json({ ok: true, namespace: OPENSHELL_NS, gateway, sandboxes, inference, at: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
