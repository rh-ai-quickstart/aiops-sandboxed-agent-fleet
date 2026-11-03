"use client";
import { useState } from "react";
import { Play, Loader2, ListOrdered, CheckCircle2 } from "lucide-react";
import { streamOrchestrate } from "@/lib/orchestrateStream";
import { useLabEnv } from "@/lib/useLabEnv";

const taskFor = (ns: string) => `The 'shop' deployment in namespace ${ns} is unhealthy — investigate with logs and metrics, and report the root cause.`;

type Step = { agent: string; subtask: string; out?: string };
type TL = { agent: string; status: "queued" | "running" | "done"; ms?: number; retried?: boolean };

// Part VI capstone widget: type a task, the website orchestrates the fleet — plan (completions)
// → dispatch each step to a sealed specialist agent (in parallel) → the writer synthesizes.
// Streams a LIVE TIMELINE of each agent so you watch it happen (and long runs never time out).
export function Orchestrator() {
  const lab = useLabEnv();
  // null = untouched → the default task follows this instance's demo namespace (from /api/lab)
  const [edited, setEdited] = useState<string | null>(null);
  const task = edited ?? taskFor(lab.demoNamespace);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [fleet, setFleet] = useState<string[]>([]);
  const [plan, setPlan] = useState<Step[]>([]);
  const [timeline, setTimeline] = useState<TL[]>([]);
  const [results, setResults] = useState<Step[]>([]);
  const [answer, setAnswer] = useState<{ text: string; by?: string } | null>(null);

  const run = async () => {
    setBusy(true); setErr(""); setPlan([]); setTimeline([]); setResults([]); setAnswer(null);
    const acc: Step[] = [];
    try {
      await streamOrchestrate(task, (e) => {
        if (e.type === "plan-start") setFleet(e.fleet || []);
        else if (e.type === "plan") { setPlan(e.steps || []); setTimeline((e.steps || []).map((s) => ({ agent: s.agent, status: "queued" }))); }
        else if (e.type === "step" && e.status === "start") setTimeline((tl) => tl.map((x) => x.agent === e.agent ? { ...x, status: "running" } : x));
        else if (e.type === "step" && e.status === "done") { acc.push({ agent: e.agent!, subtask: "", out: e.out }); setResults([...acc]); setTimeline((tl) => tl.map((x) => x.agent === e.agent ? { ...x, status: "done", ms: e.ms } : x)); }
        else if (e.type === "step" && e.status === "retry") setTimeline((tl) => tl.map((x) => x.agent === e.agent ? { ...x, retried: true } : x));
        else if (e.type === "writer" && e.status === "start") setTimeline((tl) => [...tl, { agent: "writer", status: "running" }]);
        else if (e.type === "writer" && e.status === "retry") setTimeline((tl) => tl.map((x) => x.agent === "writer" ? { ...x, retried: true } : x));
        else if (e.type === "answer") { setTimeline((tl) => tl.map((x) => x.agent === "writer" ? { ...x, status: "done", ms: e.ms } : x)); setAnswer({ text: e.answer || "", by: e.synthesizedBy }); }
        else if (e.type === "error") setErr(e.error || "failed");
      });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <div className="my-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-nv-bright)]"><ListOrdered size={15} /> Orchestrate the fleet</div>
      <textarea value={task} onChange={(e) => setEdited(e.target.value)} rows={2}
        className="mt-3 w-full rounded-lg border border-[var(--color-line-2)] bg-[var(--color-bg)] p-2.5 text-sm" />
      <div className="mt-2 flex items-center gap-3">
        <button onClick={run} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-nv)] px-4 py-2 text-sm font-semibold text-[#06080b] hover:bg-[var(--color-nv-bright)] disabled:opacity-50">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {busy ? "Running…" : "Run"}
        </button>
        {fleet.length > 0 && <span className="text-xs text-[var(--color-fg-mut)]">fleet: {fleet.join(", ")}</span>}
      </div>

      {err && <p className="mt-3 text-sm text-[var(--color-rh-bright)]">⚠ {err}</p>}

      {timeline.length > 0 && (
        <div className="mt-3 rounded-lg border border-[var(--color-line)] p-2">
          <div className="text-xs font-semibold text-[var(--color-fg-mut)]">TIMELINE</div>
          <div className="mt-1 space-y-0.5 text-xs">
            {timeline.map((x) => (
              <div key={x.agent} className="flex items-center gap-2">
                {x.status === "done" ? <CheckCircle2 size={12} className="text-[var(--color-nv-bright)]" /> : <Loader2 size={12} className="animate-spin text-[var(--color-fg-mut)]" />}
                <span className="font-semibold">{x.agent === "writer" ? "✍️ writer (synthesize)" : `🦞 ${x.agent}`}</span>
                <span className="text-[var(--color-fg-mut)]">{x.status === "done" ? `${((x.ms || 0) / 1000).toFixed(1)}s` : x.status}{x.retried ? " · retried" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.length > 0 && (
        <div className="mt-3 text-sm">
          <div className="text-xs font-semibold text-[var(--color-fg-mut)]">PLAN</div>
          <ol className="mt-1 list-decimal pl-5 text-[var(--color-fg-dim)]">
            {plan.map((s, i) => <li key={i}><span className="text-[var(--color-nv-bright)]">{s.agent}</span> — {s.subtask}</li>)}
          </ol>
        </div>
      )}
      {results.map((s, i) => (
        <div key={i} className="mt-2 rounded-lg border border-[var(--color-line)] p-2.5 text-sm">
          <div className="text-xs font-semibold text-[var(--color-nv-bright)]">🦞 {s.agent}</div>
          <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-[var(--color-fg-dim)]">{s.out}</pre>
        </div>
      ))}
      {answer && (
        <div className="mt-2 rounded-lg border border-[var(--color-nv-dim)] bg-[var(--color-bg)] p-3 text-sm">
          <div className="text-xs font-semibold text-[var(--color-fg-mut)]">{answer.by === "writer" ? "🦞 WRITER AGENT — combined root cause & fix" : "SYNTHESIZED ANSWER"}</div>
          <pre className="mt-1 whitespace-pre-wrap break-words text-sm">{answer.text}</pre>
        </div>
      )}
    </div>
  );
}
