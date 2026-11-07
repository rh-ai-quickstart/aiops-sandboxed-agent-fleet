"use client";
import { useState } from "react";
import { ExternalLink, Link2 } from "lucide-react";
import { serviceUrl, SERVICES, type ServiceName } from "@/lib/routes";
import { useLabEnv } from "@/lib/useLabEnv";

const ORDER: ServiceName[] = ["openclaw", "grafana", "console"];

export function InstanceLinks() {
  const [open, setOpen] = useState(false);
  const lab = useLabEnv();

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-line-2)] px-2.5 py-1 transition hover:border-[var(--color-nv-dim)] hover:text-[var(--color-nv-bright)]"
        title="Open your cluster's services">
        <Link2 size={13} /> <span className="hidden sm:inline">Links</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-3 text-[var(--color-fg-dim)] shadow-[0_10px_40px_rgba(0,0,0,0.4)]">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-mut)]">Open a service</div>
            <ul className="space-y-1">
              {ORDER.map((svc) => {
                const url = serviceUrl(svc, lab);
                if (!url) return null;
                return (
                  <li key={svc}>
                    <a href={url} target="_blank" rel="noreferrer"
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]">
                      <span>{SERVICES[svc].label}</span>
                      <ExternalLink size={13} className="text-[var(--color-fg-mut)]" />
                    </a>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 border-t border-[var(--color-line)] pt-2 font-mono text-[10px] text-[var(--color-fg-mut)]">
              {lab.labUser ? `${lab.labUser} · ` : ""}ns {lab.openshellNamespace} · demo {lab.demoNamespace}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
