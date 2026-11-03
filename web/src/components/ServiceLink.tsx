"use client";
import { type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { serviceUrl, SERVICES, type ServiceName } from "@/lib/routes";
import { useLabEnv } from "@/lib/useLabEnv";

export function ServiceLink({ service, children }: { service: ServiceName; children?: ReactNode }) {
  const lab = useLabEnv();
  const href = serviceUrl(service, lab);
  const label = children ?? `Open ${SERVICES[service].label}`;

  if (!href) {
    // e.g. the OpenShift console in lab mode (attendees have no console account)
    return <span className="font-medium text-[var(--color-fg-mut)]" title="Not available on this workshop instance">{label}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium text-[var(--color-nv-bright)] underline decoration-[var(--color-nv-dim)] underline-offset-2 hover:decoration-[var(--color-nv-bright)]">
      {label} <ExternalLink size={13} />
    </a>
  );
}
