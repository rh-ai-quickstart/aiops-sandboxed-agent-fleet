"use client";
import { useState, useCallback, useEffect, useMemo } from "react";
import { Rocket, Bug, Stethoscope, Wrench, Loader2, RefreshCw, CheckCircle2, XCircle, Trash2, Terminal, ChevronRight, Activity } from "lucide-react";
import { streamOrchestrate } from "@/lib/orchestrateStream";
import { useLabEnv } from "@/lib/useLabEnv";
import { useStoredString, readStored, writeStored, removeStored } from "@/lib/clientStore";

type Health = { ns?: string; exists?: boolean; healthy?: boolean; fault?: string; successRps?: number; errorRps?: number; totalRps?: number; errorPct?: number; pods?: string };
type Invest = { ok?: boolean; results?: { agent: string; out: string }[]; answer?: string; error?: string; synthesizedBy?: string };
type TL = { agent: string; status: "queued" | "running" | "done"; ms?: number; out?: string; request?: string; started?: number; retried?: boolean };
const BACKEND: Record<string, string> = { logs: "Loki", metrics: "Prometheus", traces: "Tempo", events: "K8s events", analyst: "(no egress)" };
const LS_KEY = "incidentlab:v2";

// The last investigation survives reloads/navigation: it lives in the localStorage-backed store.
type Saved = { inv: Invest | null; timeline: TL[]; action: string };
const EMPTY: Saved = { inv: null, timeline: [], action: "" };
function parseSaved(raw: string): Saved {
  try {
    const s = JSON.parse(raw || "null");
    if (!s) return EMPTY;
    return { inv: s.inv ?? null, timeline: Array.isArray(s.timeline) ? s.timeline : [], action: typeof s.action === "string" ? s.action : "" };
  } catch { return EMPTY; }
}
const updateSaved = (f: (s: Saved) => Saved) => writeStored(LS_KEY, JSON.stringify(f(parseSaved(readStored(LS_KEY, "")))));
const setInv = (inv: Invest | null) => updateSaved((s) => ({ ...s, inv }));
const setAction = (action: string) => updateSaved((s) => ({ ...s, action }));
const setTimeline = (f: TL[] | ((tl: TL[]) => TL[])) => updateSaved((s) => ({ ...s, timeline: typeof f === "function" ? f(s.timeline) : f }));
const clearInvestigation = () => removeStored(LS_KEY, "");

const Btn = ({ on, icon, label, kind = "ghost", disabled, a, busy }: { on: () => void; icon: React.ReactNode; label: string; kind?: "ghost" | "go" | "warn" | "fix"; disabled?: boolean; a: string; busy: string | null }) => (
  <button onClick={on} disabled={!!busy || disabled}
    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40 ${
      kind === "go" ? "bg-[var(--color-nv)] text-[#06080b] hover:bg-[var(--color-nv-bright)]"
      : kind === "warn" ? "border border-[rgba(238,0,0,0.4)] text-[var(--color-rh-bright)]"
      : kind === "fix" ? "bg-[var(--color-nv)] text-[#06080b] hover:bg-[var(--color-nv-bright)]"
      : "border border-[var(--color-line-2)]"}`}>
    {busy === a ? <Loader2 size={14} className="animate-spin" /> : icon} {label}
  </button>
);

const Num = ({ label, val, unit, bad }: { label: string; val: number; unit: string; bad?: boolean }) => (
  <div className="rounded-lg border border-[var(--color-line)] px-3 py-2">
    <div className="text-[10px] uppercase tracking-wide text-[var(--color-fg-mut)]">{label}</div>
    <div className={`font-mono text-lg font-semibold tabular-nums ${bad ? "text-[var(--color-rh-bright)]" : "text-[var(--color-nv-bright)]"}`}>{val}<span className="ml-0.5 text-xs text-[var(--color-fg-mut)]">{unit}</span></div>
  </div>
);

// Part VI capstone — the full incident loop on one instrumented app: a continuous loadgen drives
// shop-app (real logs/metrics/traces), you inject an APPLICATION fault (payment path → 503s), the
// fleet investigates the live telemetry and the analyst recommends a remediation, then a human
// approves clearing the fault. The whole thing is visible: live traffic numbers + each agent's work.
export function IncidentLab() {
  const lab = useLabEnv();
  const [h, setH] = useState<Health | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [savedRaw] = useStoredString(LS_KEY, "");
  // inv = findings + answer; action = the analyst's recommended remediation (parsed)
  const { inv, timeline, action } = useMemo(() => parseSaved(savedRaw), [savedRaw]);
  const [now, setNow] = useState(0);
  const [logsOpen, setLogsOpen] = useState<Set<string>>(new Set());
  const [agentLogs, setAgentLogs] = useState<Record<string, string>>({});

  const fetchHealth = useCallback(async (): Promise<Health | null> => {
    try { return await (await fetch("/api/incident")).json(); } catch { return null; }
  }, []);
  const refresh = async () => { const v = await fetchHealth(); if (v) setH(v); };
  useEffect(() => { // live traffic numbers
    let alive = true;
    const tick = async () => { const v = await fetchHealth(); if (alive && v) setH(v); };
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [fetchHealth]);

  useEffect(() => { if (busy !== "investigate") return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [busy]);
  useEffect(() => {
    if (logsOpen.size === 0) return;
    let alive = true;
    const pull = () => logsOpen.forEach(async (a) => { try { const r = await (await fetch(`/api/agent-logs?name=${encodeURIComponent(a)}`)).json(); if (alive && typeof r.logs === "string") setAgentLogs((m) => ({ ...m, [a]: r.logs })); } catch { /* */ } });
    pull(); const t = setInterval(pull, 3000); return () => { alive = false; clearInterval(t); };
  }, [logsOpen, busy]);

  const act = async (a: string, extra: object = {}) => {
    setBusy(a);
    try {
      const r = await (await fetch("/api/incident", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: a, ...extra }) })).json();
      setH(r);
      if (a === "break") clearInvestigation();
    } finally { setBusy(null); }
  };

  const investigate = async () => {
    setBusy("investigate"); clearInvestigation();
    const results: { agent: string; out: string }[] = [];
    const task = `The 'shop' service in namespace ${h?.ns || lab.demoNamespace} is failing a high rate of requests. Investigate from metrics, logs, traces and events, and find the root cause.`;
    try {
      await streamOrchestrate(task, (e) => {
        if (e.type === "plan") setTimeline((e.steps || []).map((s) => ({ agent: s.agent, status: "queued", request: s.request })));
        else if (e.type === "step" && e.status === "start") setTimeline((tl) => tl.map((x) => x.agent === e.agent ? { ...x, status: "running", started: Date.now(), request: e.request ?? x.request } : x));
        else if (e.type === "step" && e.status === "done") { results.push({ agent: e.agent!, out: e.out || "" }); setTimeline((tl) => tl.map((x) => x.agent === e.agent ? { ...x, status: "done", ms: e.ms, out: e.out } : x)); }
        else if (e.type === "step" && e.status === "retry") setTimeline((tl) => tl.map((x) => x.agent === e.agent ? { ...x, retried: true } : x));
        else if (e.type === "writer" && e.status === "start") setTimeline((tl) => [...tl, { agent: "analyst", status: "running", started: Date.now() }]);
        else if (e.type === "writer" && e.status === "retry") setTimeline((tl) => tl.map((x) => x.agent === "analyst" ? { ...x, retried: true } : x));
        else if (e.type === "answer") {
          setTimeline((tl) => tl.map((x) => x.agent === "analyst" ? { ...x, status: "done", ms: e.ms } : x));
          setInv({ ok: true, results: [...results], answer: e.answer, synthesizedBy: e.synthesizedBy });
          const m = /RECOMMENDED_ACTION:\s*(.+)/i.exec(e.answer || "");
          setAction(m ? m[1].trim() : "");
        } else if (e.type === "error") setInv({ ok: false, error: e.error });
      });
    } catch (e) { setInv({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  };

  const applyFix = async () => {
    if (!confirm("Apply the human-approved remediation?\n  → kubectl scale deploy/payments --replicas=1\n  (restore the real payments dependency the fleet found was down)")) return;
    await act("fix");
    clearInvestigation();
  };

  const toggleLogs = (a: string) => setLogsOpen((s) => { const x = new Set(s); if (x.has(a)) x.delete(a); else x.add(a); return x; });


  // live `kubectl get pods` of the demo namespace: "name=Phase,WaitingReason" per line
  const pods = (h?.pods || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, rest = ""] = l.split("="); const [phase = "", reason = ""] = rest.split(",");
    return { name, phase, reason };
  });
  const elapsed = (x: TL) => x.status === "done" ? `${((x.ms || 0) / 1000).toFixed(1)}s` : x.started ? `${Math.max(0, (now - x.started) / 1000).toFixed(0)}s` : "";

  return (
    <div className="my-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-nv-bright)]"><Stethoscope size={15} /> Incident Lab — investigate &amp; resolve</div>
        <button onClick={refresh} className="text-[var(--color-fg-mut)] hover:text-[var(--color-fg)]"><RefreshCw size={14} /></button>
      </div>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-[var(--color-fg-mut)]">{h?.ns || lab.demoNamespace}/shop:</span>
        {h?.exists ? (h.healthy
          ? <span className="inline-flex items-center gap-1 text-[var(--color-nv-bright)]"><CheckCircle2 size={14} /> healthy</span>
          : <span className="inline-flex items-center gap-1 text-[var(--color-rh-bright)]"><XCircle size={14} /> unhealthy · {h.errorPct}% errors{h.fault && h.fault !== "none" ? ` · fault: ${h.fault}` : ""}</span>)
          : <span className="text-[var(--color-fg-mut)]">not deployed</span>}
      </div>

      {/* live traffic numbers from the loadgen → shop-app (auto-refreshes) */}
      {h?.exists && (
        <div className="mt-2">
          <div className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-fg-mut)]"><Activity size={12} /> LIVE TRAFFIC (loadgen → shop-app)</div>
          <div className="grid grid-cols-3 gap-2">
            <Num label="success" val={h.successRps ?? 0} unit="req/s" />
            <Num label="errors" val={h.errorRps ?? 0} unit="req/s" bad={(h.errorRps ?? 0) > 0} />
            <Num label="error rate" val={h.errorPct ?? 0} unit="%" bad={(h.errorPct ?? 0) > 0} />
          </div>
        </div>
      )}

      {/* live `kubectl get pods` of demo/* (shop-app + loadgen), auto-refreshes */}
      {pods.length > 0 && (
        <div className="mt-2 rounded-lg border border-[var(--color-line)] p-2">
          <div className="text-xs font-semibold text-[var(--color-fg-mut)]">PODS (live · namespace {h?.ns || lab.demoNamespace})</div>
          <div className="mt-1 space-y-0.5 font-mono text-xs">
            {pods.map((p) => (
              <div key={p.name} className="flex items-center justify-between gap-3">
                <span className="text-[var(--color-fg-dim)]">{p.name}</span>
                <span className={p.reason ? "text-[var(--color-rh-bright)]" : p.phase === "Running" ? "text-[var(--color-nv-bright)]" : "text-[var(--color-fg-mut)]"}>{p.reason || p.phase || "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* deploy/undeploy, inject fault, investigate */}
      <div className="mt-3 flex flex-wrap gap-2">
        {h?.exists
          ? <Btn busy={busy} a="teardown" on={() => { if (confirm("Undeploy shop-app + loadgen?")) act("teardown").then(() => { clearInvestigation(); refresh(); }); }} icon={<Trash2 size={14} />} label="Undeploy" />
          : <Btn busy={busy} a="deploy" on={() => act("deploy")} icon={<Rocket size={14} />} label="1 · Deploy" kind="go" />}
        <Btn busy={busy} a="break" on={() => act("break")} icon={<Bug size={14} />} label="2 · Inject fault" kind="warn" disabled={!h?.exists || h?.healthy === false} />
        <Btn busy={busy} a="investigate" on={investigate} icon={<Stethoscope size={14} />} label="3 · Investigate (fleet)" disabled={h?.healthy !== false} />
      </div>

      {/* animated investigation — each agent's request, live timer, live logs, then findings */}
      {timeline.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-semibold text-[var(--color-fg-mut)]">INVESTIGATION — agents invoked in parallel{busy === "investigate" ? " (live)" : ""}</div>
          {timeline.map((x) => (
            <div key={x.agent} className={`rounded-lg border p-2 transition-colors ${x.status === "running" ? "border-[var(--color-nv-dim)] animate-pulse" : "border-[var(--color-line)]"}`}>
              <div className="flex items-center gap-2 text-xs">
                {x.status === "done" ? <CheckCircle2 size={13} className="text-[var(--color-nv-bright)]" /> : x.status === "running" ? <Loader2 size={13} className="animate-spin text-[var(--color-nv-bright)]" /> : <ChevronRight size={13} className="text-[var(--color-fg-mut)]" />}
                <span className="font-semibold">{x.agent === "analyst" ? "🧠 analyst" : `🦞 ${x.agent}`}</span>
                <span className="text-[var(--color-fg-mut)]">· {BACKEND[x.agent] || ""}</span>
                <span className="ml-auto tabular-nums text-[var(--color-fg-mut)]">{x.status === "running" ? `${x.retried ? "retrying" : x.agent === "analyst" ? "concluding" : "querying"} · ${elapsed(x)}` : `${elapsed(x)}${x.retried ? " · retried" : ""}`}</span>
              </div>
              {x.request && <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-fg-mut)]" title={x.request}>↳ {x.request}</div>}
              {x.agent !== "analyst" && (
                <button onClick={() => toggleLogs(x.agent)} className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-fg-mut)] hover:text-[var(--color-fg)]">
                  <Terminal size={11} /> {logsOpen.has(x.agent) ? "hide" : "live"} logs
                </button>
              )}
              {logsOpen.has(x.agent) && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 text-[10px] leading-snug text-[var(--color-fg-mut)]">{agentLogs[x.agent] || "…fetching sandbox logs…"}</pre>}
              {x.status === "done" && x.out && x.agent !== "analyst" && <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-[var(--color-fg-dim)]">{x.out}</pre>}
            </div>
          ))}
        </div>
      )}

      {inv && !inv.ok && <p className="mt-3 text-sm text-[var(--color-rh-bright)]">⚠ {inv.error || "investigation failed — is the fleet up? (./scripts/fleet.sh up fleet.txt)"}</p>}

      {inv?.ok && (
        <div className="mt-4 space-y-2 text-sm">
          {inv.answer && (
            <div className="rounded-lg border border-[var(--color-nv-dim)] bg-[var(--color-bg)] p-3">
              <div className="text-xs font-semibold text-[var(--color-fg-mut)]">{inv.synthesizedBy === "analyst" ? "🧠 ANALYST — concluded root cause & recommended remediation" : "ROOT CAUSE & RECOMMENDED REMEDIATION"}</div>
              <pre className="mt-1 whitespace-pre-wrap break-words text-sm">{inv.answer}</pre>
            </div>
          )}

          {/* human-approved remediation — clears the fault (the one step a human owns) */}
          <div className="rounded-lg border border-[var(--color-line-2)] p-3">
            <div className="text-xs font-semibold text-[var(--color-fg-mut)]">✋ YOUR FIX (human-in-the-loop)</div>
            <p className="mt-1 text-xs text-[var(--color-fg-dim)]">
              {action
                ? <>The <strong>fleet recommends</strong>: <span className="text-[var(--color-fg)]">{action}</span>. Approving applies the real remediation — <code>kubectl scale deploy/payments --replicas=1</code>, restoring the dependency. You own the change that touches the running system.</>
                : <>The fleet did not return a one-line action (see its findings above). Approving restores the payments dependency (<code>scale --replicas=1</code>) — the human-owned remediation.</>}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Btn busy={busy} a="fix" on={applyFix} icon={<Wrench size={14} />} label="Apply remediation ✋" kind="fix" />
              <span className="text-xs text-[var(--color-fg-mut)]">clears the fault → watch the error rate fall to 0 above</span>
            </div>
          </div>
          <button onClick={clearInvestigation} className="text-xs text-[var(--color-fg-mut)] hover:text-[var(--color-fg)]">clear this investigation</button>
        </div>
      )}
    </div>
  );
}
