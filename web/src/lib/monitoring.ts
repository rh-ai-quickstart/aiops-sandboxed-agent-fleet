import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OPENSHELL_NS, childEnv } from "@/lib/lab-env";

// Bearer tokens for the OpenShift monitoring backends. The workshop no longer holds
// cluster-monitoring-view: queries are namespace-scoped (Thanos tenancy port 9092 with
// `?namespace=`, Loki filtered on kubernetes_namespace_name), so a token that can `get
// pods.metrics.k8s.io` / read application logs in the attendee's namespaces is enough.
//   1. the pod's own ServiceAccount token (the workshop SA has `view` on both namespaces);
//   2. fallback: a short-lived token for the per-instance `telemetry-reader` SA, minted via
//      the TokenRequest API (`serviceaccounts/token` create, granted to the workshop SA).

const TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const TELEMETRY_SA = process.env.TELEMETRY_READER_SA || "telemetry-reader";
const run = promisify(execFile);

let saToken = "";
let saTokenAt = 0;

/** The pod's projected ServiceAccount token (re-read every minute: kubelet rotates it). */
export function monitoringToken(): string {
  const now = Date.now();
  if (saToken && now - saTokenAt < 60_000) return saToken;
  try {
    saToken = readFileSync(TOKEN_PATH, "utf-8").trim();
    saTokenAt = now;
  } catch {
    saToken = "";
  }
  return saToken;
}

export function monitoringHeaders(): Record<string, string> {
  const token = monitoringToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let telemetryToken = "";
let telemetryTokenExp = 0;

/** A 1h token for the telemetry-reader SA in OPENSHELL_NS (cached ~50 min); "" if not allowed. */
export async function telemetryReaderToken(): Promise<string> {
  if (telemetryToken && Date.now() < telemetryTokenExp) return telemetryToken;
  try {
    const { stdout } = await run("kubectl", ["create", "token", TELEMETRY_SA, "-n", OPENSHELL_NS, "--duration=1h"],
      { env: childEnv(), timeout: 10_000 });
    telemetryToken = stdout.trim();
    telemetryTokenExp = Date.now() + 50 * 60_000;
  } catch {
    telemetryToken = "";
    telemetryTokenExp = Date.now() + 5 * 60_000; // don't hammer the API when RBAC says no
  }
  return telemetryToken;
}

/**
 * GET a monitoring backend URL with the pod's SA token; on 401/403 retry once with the
 * telemetry-reader token.
 */
export async function monitoringFetch(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; text: string }> {
  const attempt = async (headers: Record<string, string>) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };
  let r = await attempt(monitoringHeaders());
  if (r.status === 401 || r.status === 403) {
    const t = await telemetryReaderToken();
    if (t) r = await attempt({ Authorization: `Bearer ${t}` });
  }
  return r;
}
