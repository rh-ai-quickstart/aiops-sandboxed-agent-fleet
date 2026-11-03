import { NextResponse } from "next/server";
import { OPENSHELL_NS, DEMO_NS, LAB_USER, LAB_MODE } from "@/lib/lab-env";

// GET /api/lab — who/where this workshop instance is, for the UI (namespace labels, service
// links) and the tests. Read-only; contains no secrets. Route hostnames come from the env the
// chart sets (WORKSHOP_HOST / OPENCLAW_HOST / GRAFANA_HOST); otherwise they are derived as
// `<route>-<namespace>.<apps domain>`, with the apps domain taken from the env or, failing
// that, from the Host the browser used to reach this workshop (`workshop-<ns>.<domain>`).

export const dynamic = "force-dynamic";

const hostOnly = (h: string) => h.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

function appsDomain(req: Request): string {
  const env = process.env.CLUSTER_APPS_DOMAIN || process.env.NEXT_PUBLIC_CLUSTER_APPS_DOMAIN || "";
  if (env) return env.trim();
  const fwd = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const host = fwd.split(",")[0].trim().replace(/:\d+$/, "");
  if (!host || host === "localhost" || /^[\d.]+$/.test(host)) return "";
  const dot = host.indexOf(".");
  return dot > 0 ? host.slice(dot + 1) : "";
}

export async function GET(req: Request) {
  const domain = appsDomain(req);
  const derive = (route: string, ns: string) => (domain ? `${route}-${ns}.${domain}` : "");
  const workshopHost = process.env.WORKSHOP_HOST ? hostOnly(process.env.WORKSHOP_HOST) : derive("workshop", OPENSHELL_NS);
  const openclawHost = process.env.OPENCLAW_HOST ? hostOnly(process.env.OPENCLAW_HOST) : derive("openclaw-ui", OPENSHELL_NS);
  const grafanaHost = process.env.GRAFANA_HOST ? hostOnly(process.env.GRAFANA_HOST) : "";
  const consoleEnabled = (process.env.CONSOLE_ENABLED ?? (LAB_MODE ? "false" : "true")).toLowerCase() !== "false";

  return NextResponse.json({
    ok: true,
    labUser: LAB_USER,
    labMode: LAB_MODE,
    openshellNamespace: OPENSHELL_NS,
    demoNamespace: DEMO_NS,
    appsDomain: domain,
    workshopUrl: workshopHost ? `https://${workshopHost}/` : null,
    openclawUrl: openclawHost ? `https://${openclawHost}/` : null,
    // Grafana is served under /grafana: either its own Route or the workshop's /grafana proxy.
    grafanaUrl: grafanaHost ? `https://${grafanaHost}/grafana/` : "/grafana/",
    consoleEnabled,
    consoleUrl: consoleEnabled && domain ? `https://console-openshift-console.${domain}/` : null,
  }, { headers: { "cache-control": "no-store" } });
}
