"use client";

import type { LabEnv } from "@/lib/useLabEnv";

// Links to this instance's services. The authoritative URLs come from GET /api/lab (built from
// WORKSHOP_HOST / OPENCLAW_HOST / GRAFANA_HOST, or derived per namespace); until it answers we
// derive them from the workshop's own hostname (`workshop-<ns>.<domain>`).
type Svc = { label: string };
export const SERVICES = {
  openclaw: { label: "OpenClaw UI" },
  grafana: { label: "Grafana" },
  console: { label: "OpenShift console" },
} satisfies Record<string, Svc>;
export type ServiceName = keyof typeof SERVICES;

function fallbackUrl(service: ServiceName): string | null {
  if (service === "grafana") return "/grafana/";
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  const dot = host.indexOf(".");
  if (dot <= 0) return null;
  const first = host.slice(0, dot), domain = host.slice(dot + 1);
  if (service === "openclaw") {
    // workshop-<ns>.<domain> → openclaw-ui-<ns>.<domain>
    return first.startsWith("workshop-") ? `https://openclaw-ui-${first.slice("workshop-".length)}.${domain}/` : null;
  }
  return `https://console-openshift-console.${domain}/`;
}

/** URL of a service, or null when it is unknown / disabled (e.g. console in lab mode). */
export function serviceUrl(service: ServiceName, lab?: LabEnv | null): string | null {
  if (lab) {
    if (service === "openclaw") return lab.openclawUrl ?? fallbackUrl(service);
    if (service === "grafana") return lab.grafanaUrl || "/grafana/";
    if (service === "console") return lab.consoleEnabled ? (lab.consoleUrl ?? fallbackUrl(service)) : null;
  }
  return fallbackUrl(service);
}
