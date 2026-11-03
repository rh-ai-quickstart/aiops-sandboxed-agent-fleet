import { NextResponse } from "next/server";
import { spawn } from "node:child_process";

// Part VI capstone — the fleet at a glance. For each agent: is it Ready, and exactly which
// egress its policy allows (proof that each agent's policy is specific to its tool).

const HOME = process.env.HOME ?? "/home/ubuntu";
const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:${HOME}/.local/bin:/usr/local/bin:/usr/bin` };
const FLEET = (process.env.FLEET || "logs,metrics,traces,events,analyst").split(",").map((s) => s.trim()).filter(Boolean);
const ROLES: Record<string, string> = { logs: "Scout 🔎 — logs (Loki)", metrics: "Gauge 📈 — metrics (Prometheus)", traces: "Trace 🧵 — traces (Tempo)", events: "Probe 🛎️ — k8s events (via Loki)", analyst: "Sage 🧠 — lead analyst (no egress)" };

function openshell(args: string[], timeoutMs = 12_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn("openshell", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill("SIGTERM"), timeoutMs);
    c.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    c.on("error", () => { clearTimeout(t); resolve({ code: 1, out: "" }); });
  });
}

async function agentInfo(name: string) {
  // egress: parse the sandbox's OWN policy (--base: without the provider-composed inference
  // endpoint every agent shares) → the one backend each specialist may reach.
  const p = await openshell(["policy", "get", name, "--base", "-o", "json"]);
  const egress: string[] = []; let ready = false;
  try {
    const clean = p.out.split("\n").filter((l) => !/UNDICI|trace-warn/.test(l)).join("\n");
    const j = JSON.parse(clean.slice(clean.indexOf("{")));
    type Ep = { host?: string; port?: number; ports?: number[] };
    const nps: Record<string, { endpoints?: Ep[] }> = j.policy?.network_policies ?? {};
    for (const k of Object.keys(nps)) for (const e of nps[k].endpoints ?? []) egress.push(`${e.host}:${e.ports?.length ? e.ports.join(",") : e.port}`);
    ready = true; // policy fetch succeeded → the sandbox exists and the gateway knows it
  } catch { /* not found / not ready */ }
  // liveness + persona: read the agent's SOUL.md (the role it was given). A successful read
  // also proves the sandbox is live, so this doubles as the liveness check.
  const soulPath = "/sandbox/.openclaw/workspace/SOUL.md";
  const sr = await openshell(["sandbox", "exec", "-n", name, "--", "cat", soulPath], 8000);
  const soul = sr.code === 0 ? sr.out.split("\n").filter((l) => !/UNDICI|trace-warn/.test(l)).join("\n").trim() : "";
  return { name, role: ROLES[name] ?? name, ready: ready && sr.code === 0, egress, soul, soulPath };
}

export async function GET() {
  const agents = await Promise.all(FLEET.map(agentInfo));
  return NextResponse.json({ ok: true, agents });
}
