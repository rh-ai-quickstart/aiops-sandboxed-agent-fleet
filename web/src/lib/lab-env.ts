import { readFileSync } from "node:fs";

// Server-side view of the workshop's environment contract (docs/CONTRACT.md). Every namespace
// comes from the env the chart sets, so the same image serves single-instance mode
// (`openshell` + `demo`) and lab mode (`userNN-openshell` + `userNN-demo`).

const SA_NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

function saNamespace(): string {
  try { return readFileSync(SA_NAMESPACE_FILE, "utf-8").trim(); } catch { return ""; }
}

const env = (...names: string[]) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return "";
};

/** Namespace of the OpenShell gateway, its sandboxes, the registry and this workshop pod. */
export const OPENSHELL_NS = env("OPENSHELL_NAMESPACE", "OPENSHELL_NS") || saNamespace() || "openshell";
/** Namespace of the demo app used by the Incident Lab. */
export const DEMO_NS = env("DEMO_NAMESPACE", "DEMO_NS", "INCIDENT_NS") || "demo";
/** Attendee id in lab mode (empty in single-instance mode). */
export const LAB_USER = env("LAB_USER");
/**
 * Lab (multi-tenant) mode: an attendee id or an access gate is configured. server.mjs keeps
 * LAB_ACCESS_TOKEN in memory, removes it from the environment and sets LAB_GATE_ENABLED=1.
 */
export const LAB_MODE = !!LAB_USER || env("LAB_GATE_ENABLED") === "1" || !!env("LAB_ACCESS_TOKEN");
/** Namespace whose event-exporter ships the demo namespace's Kubernetes events to Loki. */
export const EVENTS_NS = env("EVENTS_NAMESPACE", "EVENTS_NS") || OPENSHELL_NS;
/** Demo app kustomization directory (namespace-agnostic, applied with -n DEMO_NS). */
export const DEMO_APP_MANIFESTS = env("DEMO_APP_MANIFESTS") || "/app/manifests/demo-app";

/** Thanos Querier tenancy port (9092): label-enforced to `?namespace=`, authorized per namespace. */
export const PROM_TENANCY_HOST = env("PROM_TENANCY_HOST")
  || (env("PROM_HOST") ? env("PROM_HOST").replace(/:9091(\/?)$/, ":9092$1") : "")
  || "https://thanos-querier.openshift-monitoring.svc.cluster.local:9092";
export const LOKI_HOST = env("LOKI_HOST") || "https://logging-loki-gateway-http.openshift-logging.svc.cluster.local:8080";
export const TEMPO_HOST = env("TEMPO_HOST") || "https://tempo-tempostack-gateway.observability-hub.svc.cluster.local:8080";

/** OpenShell workspace prefix of Sandbox CR / pod names (`default--shifty`). */
export const SANDBOX_WORKSPACE = "default";
/** Kubernetes object name (Sandbox CR and its pod) for an OpenShell sandbox name. */
export const sandboxObjectName = (name: string) => `${SANDBOX_WORKSPACE}--${name}`;
/** OpenShell sandbox name for a Sandbox CR / pod name (`default--shifty` → `shifty`). */
export const sandboxDisplayName = (objectName: string) => {
  const i = objectName.indexOf("--");
  return i > 0 ? objectName.slice(i + 2) : objectName;
};

/** Environment for child processes (oc / kubectl / openshell). */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const kubeconfig = process.env.KUBECONFIG || "";
  return {
    ...process.env,
    ...(kubeconfig ? { KUBECONFIG: kubeconfig } : {}),
    PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/usr/bin`,
    NODE_NO_WARNINGS: "1",
    ...extra,
  };
}
