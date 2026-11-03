import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { DEMO_NS, DEMO_APP_MANIFESTS, PROM_TENANCY_HOST, childEnv } from "@/lib/lab-env";
import { monitoringFetch } from "@/lib/monitoring";

// Part VI capstone — the Incident Lab. The demo is an instrumented app (shop-app) driven by a
// continuous loadgen, so logs/metrics/traces are always live. The incident is an APPLICATION
// fault you inject at runtime (the payment path starts returning 503s) — visible in the app's
// own telemetry. The agents only DIAGNOSE (read-only); the human approves the remediation
// (clearing the fault), which this route applies. In production that's a git revert ArgoCD syncs.
//
// Everything is scoped to this instance's demo namespace (DEMO_NAMESPACE): the kustomization
// is namespace-agnostic and applied with `-n`, and metrics come from the Thanos tenancy port
// (9092), which enforces `namespace=` on every query.

const env = childEnv();
const APP = "shop-app";

function kubectl(args: string[], timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn("kubectl", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill("SIGTERM"), timeoutMs);
    c.on("close", (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
    c.on("error", (e) => { clearTimeout(t); resolve({ code: 1, out: String(e) }); });
  });
}
const k = (args: string[], timeoutMs?: number) => kubectl(["-n", DEMO_NS, ...args], timeoutMs);

async function promQuery(query: string): Promise<{ code: number; out: string }> {
  const url = `${PROM_TENANCY_HOST}/api/v1/query?namespace=${encodeURIComponent(DEMO_NS)}&query=${encodeURIComponent(query)}`;
  try {
    const r = await monitoringFetch(url);
    return { code: r.ok ? 0 : 1, out: r.text };
  } catch (e) {
    return { code: 1, out: String(e) };
  }
}

async function promRps(): Promise<Record<string, number>> {
  const r = await promQuery(`sum by (code) (rate(shop_requests_total{namespace="${DEMO_NS}"}[30s]))`);
  const rps: Record<string, number> = {};
  try { for (const s of JSON.parse(r.out)?.data?.result ?? []) rps[s.metric.code] = parseFloat(s.value[1]) || 0; } catch { /* */ }
  return rps;
}

async function health() {
  const dep = await k(["get", "deploy", APP, "-o", "jsonpath={.status.readyReplicas}/{.spec.replicas}"]);
  const exists = dep.code === 0;
  // live pods in the demo namespace (shop-app + payments + loadgen): "name=Phase,WaitingReason"
  const pods = await k(["get", "pods", "-o",
    "jsonpath={range .items[*]}{.metadata.name}{'='}{.status.phase}{','}{range .status.containerStatuses[*]}{.state.waiting.reason}{end}{'\\n'}{end}"]);
  if (!exists) return { ns: DEMO_NS, exists: false, healthy: false, pods: pods.out };
  // the fault state is REAL: is the payments dependency up? (scaled to 0 = the injected outage)
  const pay = await k(["get", "deploy", "payments", "-o", "jsonpath={.status.readyReplicas}"]);
  const paymentsUp = (parseInt(pay.out, 10) || 0) > 0;
  const rps = await promRps();
  const success = rps["200"] || 0;
  const errors = Object.entries(rps).filter(([c]) => c.startsWith("5")).reduce((a, [, v]) => a + v, 0);
  const total = success + errors;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ns: DEMO_NS, exists: true, pods: pods.out, paymentsUp, fault: paymentsUp ? "none" : "payments-down",
    healthy: paymentsUp && errors < 0.05,
    successRps: r2(success), errorRps: r2(errors), totalRps: r2(total),
    errorPct: total > 0 ? Math.round((100 * errors) / total) : 0,
  };
}

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, ...(await health()) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { action } = body as { action?: string };
  try {
    if (action === "deploy") {
      const a = await k(["apply", "-k", DEMO_APP_MANIFESTS]);
      await k(["rollout", "status", `deploy/${APP}`, "--timeout=90s"], 100_000);
      return NextResponse.json({ ok: a.code === 0, action, out: a.out, ...(await health()) });
    }
    if (action === "break") {
      // a REAL dependency outage: scale the payments deployment to 0. shop-app's checkout makes a
      // real HTTP call to payments → now connection-refused → genuine 503s. Nothing artificial:
      // the failure emerges from a real downstream being gone (a common, real production incident).
      const a = await k(["scale", "deploy/payments", "--replicas=0"]);
      await k(["wait", "--for=delete", "pod", "-l", "app=payments", "--timeout=30s"], 40_000);
      return NextResponse.json({ ok: a.code === 0, action, note: "scaled the payments dependency to 0 — checkout's real calls to it now fail", out: a.out, ...(await health()) });
    }
    if (action === "fix") {
      // the human-approved remediation: a REAL fix — bring the payments dependency back up.
      const a = await k(["scale", "deploy/payments", "--replicas=1"]);
      await k(["rollout", "status", "deploy/payments", "--timeout=90s"], 100_000);
      return NextResponse.json({ ok: a.code === 0, action, applied: "scaled payments back to 1 (restored the dependency)", out: a.out, ...(await health()) });
    }
    if (action === "teardown") {
      // never touches the Namespace object (pre-created by deploy.sh / lab.sh)
      const a = await k(["delete", "-k", DEMO_APP_MANIFESTS, "--ignore-not-found"]);
      return NextResponse.json({ ok: a.code === 0, action, out: a.out });
    }
    return NextResponse.json({ ok: false, error: "action must be deploy|break|fix|teardown" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
