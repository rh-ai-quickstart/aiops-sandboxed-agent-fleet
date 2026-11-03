"use client";
import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Server, Box, ScrollText, Shield, Cpu, KeyRound, ShieldCheck } from "lucide-react";

type Sandbox = { name: string; object?: string; phase: string; ready: boolean; restarts: number; created: string | null };
type Provider = { name: string; type: string; credentialKeys: string[]; configKeys: string[] };
type Inference = {
  configured: boolean; provider: string | null; profile: string | null; model: string | null; endpointHost: string | null;
  agent: string; attached: string[]; providers: Provider[];
};
type Data = { ok: boolean; error?: string; namespace?: string; gateway?: { ready: boolean; version: string | null }; sandboxes?: Sandbox[]; inference?: Inference | null };

function age(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

type Tab = "logs" | "policy" | "decisions";

// Parse the sandbox OCSF feed into policy decisions (every egress attempt the supervisor
// allowed or denied): NET:OPEN (L4) + HTTP:* (L7), with the binary, target, rule, engine.
type Decision = { decision: "ALLOWED" | "DENIED"; kind: string; target: string; binary: string; policy: string; engine: string; reason: string };
function parseDecisions(text: string): Decision[] {
  const out: Decision[] = [];
  for (const line of text.split("\n")) {
    const m = /(NET:OPEN|HTTP:[A-Z]+)\s+\[[A-Z]+\]\s+(ALLOWED|DENIED)\s+(.*)/.exec(line);
    if (!m) continue;
    const rest = m[3];
    const http = /\b([A-Z]+)\s+(https?:\/\/[^\s[]+)/.exec(rest);
    const arrow = /->\s*([^\s[]+)/.exec(rest);
    // Fallback: some denials (e.g. the http-parser %2F rejection) put host:port right
    // after DENIED with no arrow/method — grab the first host:port token.
    const hostport = /(?:^|\s)([a-z0-9][a-z0-9.-]*:\d+)/i.exec(rest);
    out.push({
      decision: m[2] as "ALLOWED" | "DENIED",
      kind: m[1],
      target: http ? `${http[1]} ${http[2].replace(/^https?:\/\//, "")}` : (arrow ? arrow[1] : (hostport ? hostport[1] : "")),
      binary: (/(\/[^\s(]+)\(\d+\)/.exec(rest) || [])[1] || "",
      policy: (/\[policy:([^\s\]]+)/.exec(rest) || [])[1] || "",
      engine: (/engine:([^\s\]]+)/.exec(rest) || [])[1] || "",
      reason: (/\[reason:([^\]]+)\]/.exec(rest) || [])[1] || "",
    });
  }
  return out.reverse(); // newest first
}

export function LiveOpenShell() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("logs");
  const [source, setSource] = useState<"all" | "gateway" | "sandbox">("all");
  // detail = output of the last finished request, tagged with the request it answered;
  // it is "loading" while the current selection (or a reload) has no answer yet.
  const [detailRes, setDetailRes] = useState<{ key: string; text: string } | null>(null);
  const [reloadN, setReloadN] = useState(0);
  const detailKey = sel ? `${sel}|${tab}|${source}|${reloadN}` : "";
  const detailLoading = !!sel && detailRes?.key !== detailKey;
  const detail = detailLoading ? "" : (detailRes?.text ?? "");

  const fetchData = useCallback(async (): Promise<Data> => {
    try {
      const r = await fetch("/api/openshell", { cache: "no-store" });
      return await r.json();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, []);

  // manual refresh (spinner); the poller below updates silently
  const load = async () => {
    setLoading(true);
    setData(await fetchData());
    setLoading(false);
  };

  useEffect(() => {
    let alive = true;
    const tick = async () => { const d = await fetchData(); if (alive) setData(d); };
    tick();
    const t = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(t); };
  }, [fetchData]);

  // (re)load the detail whenever the selected sandbox / tab / source changes (or on reload)
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    const key = `${sel}|${tab}|${source}|${reloadN}`;
    (async () => {
      let text: string;
      try {
        const q = tab === "policy" ? `policy=${encodeURIComponent(sel)}`
          : tab === "decisions" ? `logs=${encodeURIComponent(sel)}&source=sandbox&n=3000`
          : `logs=${encodeURIComponent(sel)}&source=${source}`;
        const r = await fetch(`/api/openshell?${q}`, { cache: "no-store" });
        const j = await r.json();
        text = j.text ?? j.error ?? "(no output)";
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
      }
      if (alive) setDetailRes({ key, text });
    })();
    return () => { alive = false; };
  }, [sel, tab, source, reloadN]);

  const gw = data?.gateway;
  const sandboxes = data?.sandboxes ?? [];

  return (
    <figure className="my-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <figcaption className="text-sm text-[var(--color-fg-mut)]">Live from your gateway — auto-refreshes</figcaption>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line-2)] px-2.5 py-1 text-[11px] text-[var(--color-fg-mut)] transition hover:text-[var(--color-fg)]">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* gateway status */}
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)] px-3 py-2.5">
        <Server size={15} className="text-[var(--color-fg-mut)]" />
        <span className="text-[13px] font-semibold text-[var(--color-fg)]">OpenShell gateway</span>
        {data && data.ok ? (
          <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: gw?.ready ? "var(--color-nv-bright)" : "#ee5555" }}>
            <span style={{ width: 7, height: 7, borderRadius: 7, background: gw?.ready ? "#76b900" : "#ee5555", display: "inline-block" }} />
            {gw?.ready ? "Connected" : "Not ready"}{gw?.version ? ` · ${gw.version}` : ""}
          </span>
        ) : (
          <span className="text-[12px] text-[var(--color-fg-mut)]">{data ? "unreachable" : "loading…"}</span>
        )}
        <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-mut)]">ns: {data?.namespace ?? "…"}</span>
      </div>

      {/* inference providers (from openshell provider list / sandbox provider list) */}
      {data?.ok && data.inference && (
        <div className="mb-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)] px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Cpu size={15} className="text-[var(--color-fg-mut)]" />
            <span className="text-[13px] font-semibold text-[var(--color-fg)]">Inference provider</span>
            {data.inference.configured ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-nv-bright)]">
                <span style={{ width: 7, height: 7, borderRadius: 7, background: "#76b900", display: "inline-block" }} />
                {data.inference.provider}{data.inference.profile ? <> · profile <span className="font-mono">{data.inference.profile}</span></> : null}
                {data.inference.model ? <> · <span className="font-mono">{data.inference.model}</span></> : null}
              </span>
            ) : (
              <span className="text-[12px] text-[var(--color-fg-mut)]">not configured — create it in <em>Set Your Inference Endpoint</em></span>
            )}
            <span className="ml-auto font-mono text-[10px] text-[var(--color-fg-mut)]">
              {data.inference.agent}: {data.inference.attached.length ? `attached ${data.inference.attached.join(", ")}` : "no provider attached"}
            </span>
          </div>
          {data.inference.providers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.inference.providers.map((p) => (
                <span key={p.name} title={`credentials: ${p.credentialKeys.join(", ") || "—"}`}
                  className="inline-flex items-center gap-1 rounded border border-[var(--color-line-2)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-fg-dim)]">
                  {data.inference!.attached.includes(p.name) && <span style={{ width: 5, height: 5, borderRadius: 5, background: "#76b900", display: "inline-block" }} />}
                  {p.name} <span className="text-[var(--color-fg-mut)]">({p.type})</span>
                  {p.credentialKeys.length > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-fg-mut)]"><KeyRound size={9} />{p.credentialKeys.length}</span>}
                </span>
              ))}
            </div>
          )}
          <p className="mt-1.5 text-[10px] text-[var(--color-fg-mut)]">
            The provider holds the key (<strong>values never shown</strong> — only key names). A sandbox it is attached to sees only a placeholder;
            the supervisor swaps in the real key on egress{data.inference.endpointHost ? <>, and only to <code>{data.inference.endpointHost}</code></> : null}.
          </p>
        </div>
      )}

      {data && !data.ok ? (
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3 text-[12px] text-[var(--color-fg-mut)]">
          Couldn&apos;t reach the gateway: <code>{data.error}</code> — is the stack up? (<code>openshell status</code> in the shell)
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--color-line)]">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-[var(--color-bg-2)] text-[var(--color-fg-mut)]">
              <tr>
                <th className="px-3 py-2 font-medium"><span className="inline-flex items-center gap-1"><Box size={12} /> Sandbox</span></th>
                <th className="px-3 py-2 font-medium">Phase</th>
                <th className="px-3 py-2 font-medium">Ready</th>
                <th className="px-3 py-2 font-medium">Restarts</th>
                <th className="px-3 py-2 font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {sandboxes.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-4 text-center text-[var(--color-fg-mut)]">No sandboxes yet — create one in <em>Build Your Agent</em>.</td></tr>
              ) : sandboxes.map((s) => (
                <tr key={s.name} onClick={() => setSel(s.name === sel ? null : s.name)}
                  className={`cursor-pointer border-t border-[var(--color-line)] transition hover:bg-[var(--color-bg-2)] ${sel === s.name ? "bg-[var(--color-bg-2)]" : ""}`}>
                  <td className="px-3 py-2 font-mono text-[var(--color-fg)]">{s.name}</td>
                  <td className="px-3 py-2 text-[var(--color-fg-dim)]">{s.phase}</td>
                  <td className="px-3 py-2" style={{ color: s.ready ? "var(--color-nv-bright)" : "#e0a800" }}>{s.ready ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-[var(--color-fg-dim)]">{s.restarts}</td>
                  <td className="px-3 py-2 text-[var(--color-fg-mut)]">{age(s.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* per-sandbox detail: logs + policy */}
      {sel && (
        <div className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg-2)]">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
            <span className="font-mono text-[12px] text-[var(--color-fg)]">{sel}</span>
            <div className="ml-2 inline-flex overflow-hidden rounded-md border border-[var(--color-line-2)] text-[11px]">
              {(["logs", "decisions", "policy"] as Tab[]).map((t) => (
                <button key={t} onClick={() => setTab(t)} className="inline-flex items-center gap-1 px-2.5 py-1 font-medium transition"
                  style={{ background: tab === t ? "var(--color-nv)" : "transparent", color: tab === t ? "#06080b" : "var(--color-fg-dim)" }}>
                  {t === "logs" ? <ScrollText size={11} /> : t === "decisions" ? <ShieldCheck size={11} /> : <Shield size={11} />} {t === "logs" ? "Logs / audit" : t === "decisions" ? "Policy decisions" : "Policy"}
                </button>
              ))}
            </div>
            {tab === "logs" && (
              <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-line-2)] text-[10px]">
                {(["all", "gateway", "sandbox"] as const).map((s) => (
                  <button key={s} onClick={() => setSource(s)} className="px-2 py-1 transition"
                    style={{ background: source === s ? "var(--color-line-2)" : "transparent", color: source === s ? "var(--color-fg)" : "var(--color-fg-mut)" }}>{s}</button>
                ))}
              </div>
            )}
            <button onClick={() => setReloadN((n) => n + 1)} className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-mut)] hover:text-[var(--color-fg)]">
              <RefreshCw size={11} className={detailLoading ? "animate-spin" : ""} /> reload
            </button>
          </div>
          {tab === "decisions" ? (
            <div className="max-h-80 overflow-auto p-2">
              {detailLoading ? (
                <p className="p-2 font-mono text-[11px] text-[var(--color-fg-mut)]">loading…</p>
              ) : (() => {
                const decisions = parseDecisions(detail);
                if (decisions.length === 0) return <p className="p-2 font-mono text-[11px] text-[var(--color-fg-mut)]">No egress decisions in the recent feed. (The agent hasn&apos;t tried to reach anything lately.)</p>;
                return (
                  <div className="space-y-1">
                    {decisions.map((d, i) => {
                      const allow = d.decision === "ALLOWED";
                      const color = allow ? "var(--color-nv-bright)" : "#ee7777";
                      return (
                        <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-[var(--color-line-2)] bg-[var(--color-bg)] px-2 py-1">
                          <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ color, border: `1px solid ${color}55` }}>{allow ? "ALLOW" : "DENY"}</span>
                          <span className="font-mono text-[11px] text-[var(--color-fg)]">{d.target || "—"}</span>
                          {d.binary && <span className="font-mono text-[9px] text-[var(--color-fg-mut)]">{d.binary}</span>}
                          <span className="ml-auto font-mono text-[9px] text-[var(--color-fg-mut)]">{d.policy ? `${d.policy}` : ""}{d.engine ? ` · ${d.engine}` : ""}</span>
                          {!allow && d.reason && <p className="w-full font-mono text-[9px] text-[#ee7777]/80">{d.reason}</p>}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          ) : (
            <pre className="max-h-80 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-[var(--color-code-fg)]">{detailLoading ? "loading…" : (detail || "(no output)")}</pre>
          )}
        </div>
      )}

      <p className="mt-2 text-[10px] text-[var(--color-fg-mut)]">
        Click a sandbox for its <strong>logs/audit</strong> (<code>openshell logs &lt;name&gt; --source …</code>) and full <strong>policy</strong> (<code>openshell policy get &lt;name&gt; --full</code>). Served read-only via <code>/api/openshell</code>.
      </p>
    </figure>
  );
}
