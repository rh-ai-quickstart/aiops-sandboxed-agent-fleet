"use client";
import { useEffect, useState } from "react";

// Client view of GET /api/lab (namespaces + service URLs of THIS workshop instance).
export type LabEnv = {
  labUser: string;
  labMode: boolean;
  openshellNamespace: string;
  demoNamespace: string;
  appsDomain: string;
  workshopUrl: string | null;
  openclawUrl: string | null;
  grafanaUrl: string;
  consoleEnabled: boolean;
  consoleUrl: string | null;
};

export const DEFAULT_LAB_ENV: LabEnv = {
  labUser: "",
  labMode: false,
  openshellNamespace: "openshell",
  demoNamespace: "demo",
  appsDomain: "",
  workshopUrl: null,
  openclawUrl: null,
  grafanaUrl: "/grafana/",
  consoleEnabled: true,
  consoleUrl: null,
};

let cached: LabEnv | null = null;
let inflight: Promise<LabEnv> | null = null;

export function loadLabEnv(): Promise<LabEnv> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = fetch("/api/lab", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j): LabEnv => {
        const env: LabEnv = { ...DEFAULT_LAB_ENV, ...j };
        cached = env;
        return env;
      })
      .catch((): LabEnv => { inflight = null; return DEFAULT_LAB_ENV; });
  }
  return inflight;
}

/** The lab env (defaults to single-instance values until /api/lab answers). */
export function useLabEnv(): LabEnv {
  const [env, setEnv] = useState<LabEnv>(cached ?? DEFAULT_LAB_ENV);
  useEffect(() => {
    let alive = true;
    loadLabEnv().then((e) => { if (alive) setEnv(e); });
    return () => { alive = false; };
  }, []);
  return env;
}
