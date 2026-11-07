import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DEMO_NS, EVENTS_NS, PROM_TENANCY_HOST, LOKI_HOST, TEMPO_HOST, childEnv } from "@/lib/lab-env";

// Part VI capstone, in the website: an orchestrator that gives each sealed specialist agent
// an investigation step (in parallel, via `openclaw agent --local`), then a writer agent
// synthesizes their findings. The website never calls a model directly — each agent's sandbox
// has the inference provider attached (it holds only a credential placeholder; the supervisor
// injects the real key on egress) — so no host-side inference config is needed. Streams a
// live timeline.

const env = childEnv();
const FLEET = (process.env.FLEET || "logs,metrics,traces,events,analyst").split(",").map((s) => s.trim()).filter(Boolean);

// Prescribed probe per specialist. Free-form ReAct overflows the model's context (the agent
// wanders — reads files, hunts for the skill, calls dir_list — and times out), so the
// orchestrator hands each sealed agent the EXACT query its cluster-telemetry skill should run.
// The agent runs it (real data from its real backend, via curl under its egress policy) and
// interprets the result; the writer synthesizes. Backends are env-overridable.
//
// Every probe is scoped to THIS instance's namespaces, so on a shared lab cluster an attendee's
// fleet never sees another attendee's incident:
//   metrics — Thanos tenancy port 9092 with `namespace=<demo ns>` (label enforced + RBAC-checked)
//   logs    — Loki `{kubernetes_namespace_name="<demo ns>"}`
//   events  — the per-instance event-exporter (in EVENTS_NS) that watches the demo namespace
//   traces  — TraceQL on the `k8s.namespace.name` resource attribute the demo app sets
const TQ = "node /sandbox/.agents/skills/cluster-telemetry/tq.js";
const q = encodeURIComponent;
// Built per-request: Loki query_range needs an explicit [start,end] window (ns), so we stamp
// the last hour here. metrics uses an instant query (no window). `events` reads the k8s events
// that kubernetes-event-exporter ships into Loki.
function buildProbes(): Record<string, { url: string; hint: string }> {
  const ms = Date.now();
  // Last 15 min, newest first: an attendee may break/fix the app several times, and older
  // scale-up/scale-down events from a previous round must not mislead the analyst.
  const range = `&start=${ms - 900000}000000&end=${ms}000000&limit=15`;
  const prom = (query: string) => `${PROM_TENANCY_HOST}/api/v1/query?namespace=${q(DEMO_NS)}&query=${q(query)}`;
  const loki = (query: string) => `${LOKI_HOST}/api/logs/v1/application/loki/api/v1/query_range?direction=backward&query=${q(query)}${range}`;
  return {
    // two URLs → tq.js runs both (the closing/opening quotes split them into two argv entries)
    metrics: { url: `${prom(`sum by (code) (rate(shop_requests_total{namespace="${DEMO_NS}"}[2m]))`)}' '${prom(`sum(rate(shop_request_duration_ms_sum{namespace="${DEMO_NS}"}[2m]))/sum(rate(shop_request_duration_ms_count{namespace="${DEMO_NS}"}[2m]))`)}`,
      hint: "first the request rate by HTTP code (a spike in 5xx is the error rate vs 200s), then the average request latency in ms" },
    logs: { url: loki(`{kubernetes_namespace_name="${DEMO_NS}"} |= "error"`),
      hint: "the app's recent ERROR log lines (e.g. 'checkout failed: payment provider returned 503') — what the app itself says is wrong" },
    events: { url: loki(`{kubernetes_namespace_name="${EVENTS_NS}",kubernetes_container_name="event-exporter"} |= "${DEMO_NS}" |= "reason"`),
      hint: "recent Kubernetes events for the namespace — ESPECIALLY any recent CHANGE: a Deployment scaled down or up (e.g. 'Scaled down replica set payments-… to 0', pods Killing/Created). Report the most recent such change and its time — a dependency scaled to 0 (or a deploy) that coincides with when the errors began is the prime suspect ('what changed?'). Name the specific workload that changed." },
    traces: { url: `${TEMPO_HOST}/api/traces/v1/dev/tempo/api/search?q=${q(`{ resource.service.name = "shop" && resource.k8s.namespace.name = "${DEMO_NS}" && status = error }`)}&limit=10`,
      hint: "recent ERROR traces for the shop service — the failing span (e.g. charge-payment) shows WHERE in the request path it breaks" },
  };
}

// Run `openshell …` with stdin closed so `sandbox exec` gets EOF and exits. Killed on timeout
// or when `signal` aborts (the client went away), so a closed tab doesn't leave execs running.
function openshell(args: string[], signal: AbortSignal, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("(aborted)");
    const c = spawn("openshell", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const kill = () => c.kill("SIGTERM");
    const t = setTimeout(kill, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    const done = (r: string) => { clearTimeout(t); signal.removeEventListener("abort", kill); resolve(r); };
    c.on("close", () => done(out));
    c.on("error", (e) => done(`(dispatch error: ${e.message})`));
  });
}

const MAX_ATTEMPTS = 2;
// OpenClaw's first-run BOOTSTRAP.md makes a fresh session open with an identity interview
// ("who am I?", "I just came online…") instead of doing the task — detect it and retry.
const BOOTSTRAP_RE = /who am i|came online|let['’]s figure out|could you tell me/i;

async function runAgentOnce(agent: string, subtask: string, signal: AbortSignal, timeoutMs = 180_000): Promise<string> {
  // `openshell sandbox exec` rejects args containing newlines, and findings are multi-line —
  // so pass the message base64-encoded and decode it inside the sandbox via the shell.
  const b64 = Buffer.from(subtask, "utf8").toString("base64");
  const out = await openshell(["sandbox", "exec", "-n", agent, "--", "sh", "-c",
    `TMPDIR=/tmp NODE_NO_WARNINGS=1 openclaw agent --local --json --session-id ${randomUUID()} -m "$(printf %s ${b64} | base64 -d)"`], signal, timeoutMs);
  const raw = out.split("\n").filter((l) => !/UNDICI|trace-warn/.test(l)).join("\n");
  // openclaw --json prints a (multi-line) JSON object, e.g. {"payloads":[{"text":"…"}]},
  // amid log lines — pull the JSON blob and extract the agent's text.
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(raw.slice(a, b + 1));
      const txt = Array.isArray(o.payloads) ? o.payloads.map((p: { text?: string }) => p?.text).filter(Boolean).join("\n").trim() : (o.reply ?? o.text);
      if (txt && String(txt).trim()) return String(txt).trim();
    } catch { /* fall through */ }
  }
  const tm = /"text"\s*:\s*"([\s\S]*?)"\s*[},]/.exec(raw);
  if (tm) { try { return JSON.parse(`"${tm[1]}"`); } catch { return tm[1]; } }
  return raw.trim().slice(0, 4000);
}

// Investigator run: retry a bootstrap greeting. On final failure keep the last output (trimmed)
// after the marker so the timeline still shows what the agent actually said.
async function runAgent(agent: string, subtask: string, signal: AbortSignal, onRetry: () => void, timeoutMs = 180_000): Promise<string> {
  let out = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !signal.aborted; attempt++) {
    if (attempt) onRetry();
    out = await runAgentOnce(agent, subtask, signal, timeoutMs);
    if (out && !BOOTSTRAP_RE.test(out)) return out;
  }
  return `(agent did not produce findings)${out ? `\n\n${out.slice(0, 500)}` : ""}`;
}

// tq.js prints "status=success …" (metrics/logs/events) or "traces=N" (traces): if an agent's
// finding does not contain its probe's real output (small models sometimes skip or mangle the
// tool call), run the probe ourselves — still inside the agent's sealed sandbox, through its own
// egress policy — and attach the verified output so the analyst always reasons over real data.
const PROBE_OUTPUT = /status=success|traces=\d+/;
async function verifiedProbe(agent: string, cmd: string, signal: AbortSignal): Promise<string> {
  const raw = await openshell(["sandbox", "exec", "-n", agent, "--", "sh", "-c", cmd], signal, 30_000);
  return raw.split("\n").filter((l) => !/UNDICI|trace-warn/.test(l)).join("\n").trim().slice(0, 3000);
}

// Counts read from the tq.js output of each finding (undefined when a probe's output is missing).
// `clean` = every probe answered and none shows a failure.
function evidence(results: { agent: string; out: string }[]) {
  const outOf = (a: string) => results.find((r) => r.agent === a)?.out ?? "";
  const count = (a: string, re: RegExp) => { const m = re.exec(outOf(a)); return m ? Number(m[1]) : undefined; };
  const rates = [...outOf("metrics").matchAll(/\{"code":"(\d{3})"\} => ([\d.eE+-]+)/g)];
  const e = {
    errorLogs: count("logs", /status=success entries=(\d+)/),
    errorTraces: count("traces", /traces=(\d+)/),
    events: count("events", /status=success entries=(\d+)/),
    rate5xx: rates.length ? rates.filter((m) => m[1].startsWith("5")).reduce((sum, m) => sum + Number(m[2]), 0) : undefined,
  };
  return { ...e, clean: Object.values(e).every((v) => v === 0) };
}

// Streams the run as newline-delimited JSON events so the UI shows a LIVE TIMELINE of each
// agent (start/retry/done + duration) — and the long run never idles the connection out (each
// attempt is bounded by openshell's 180s timeout, under the Route's 300s, and a retry emits an
// event first). The investigators run in PARALLEL; the writer agent synthesizes once they're all in.
export async function POST(req: Request) {
  const { task } = await req.json().catch(() => ({}));
  if (!task || typeof task !== "string") return NextResponse.json({ ok: false, error: "task required" }, { status: 400 });
  const SYNTH = "analyst";
  const investigators = FLEET.filter((a) => a !== SYNTH);
  // aborted when the client disconnects — kills in-flight sandbox execs and skips retries
  const ac = new AbortController();
  req.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const signal = ac.signal;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const t0 = Date.now();
      const emit = (o: object) => { if (!signal.aborted) controller.enqueue(enc.encode(JSON.stringify({ t: Date.now() - t0, ...o }) + "\n")); };
      // Heartbeat: cloud load balancers in front of the OpenShift router drop connections that stay
      // idle (AWS ELB: 60 s) — and one agent turn can take longer than that. The UI ignores it.
      const hb = setInterval(() => { try { emit({ type: "heartbeat" }); } catch { /* closed */ } }, 15_000);
      try {
        emit({ type: "plan-start", fleet: FLEET, investigators });
        // Fixed plan: one investigation step per specialist. No host-side model call to plan —
        // the intelligence is in each agent's investigation + the writer's synthesis (both reach
        // the model through their sandbox's attached provider, so the website never needs direct
        // model access).
        const PROBES = buildProbes();
        const steps: { agent: string; subtask: string; request: string }[] = investigators.map((a) => {
          const p = PROBES[a];
          // `request` is the exact command the agent will run — surfaced to the UI so you can
          // SEE what each agent is doing (the real backend call), not just a spinner.
          const request = p ? `${TQ} '${p.url}'` : "(no backend probe)";
          // Directive subtask: inline the EXACT command. This keeps the tool loop to ~2 calls
          // (run probe → answer), so it finishes in ~30s instead of overflowing context.
          const subtask = p
            ? `You are the ${a} specialist of an SRE fleet — read-only, sealed to your one backend. Use ONLY the exec tool. Run this EXACT command and report its output verbatim as your finding (it returns ${p.hint}), then briefly state what it means for the incident and STOP. Do not read files, do not use web_fetch or dir_list, and do NOT generate any image.\n\nCommand:\n${TQ} '${p.url}'\n\nIncident: ${task}`
            : `You are the ${a} specialist of an SRE fleet. You have no configured backend probe for this incident — report that plainly in one line. Do not use any tool and do NOT generate any image.\n\nIncident: ${task}`;
          return { agent: a, subtask, request };
        });
        emit({ type: "plan", steps });

        // dispatch investigators in PARALLEL; emit start now, done as each resolves
        steps.forEach((s) => emit({ type: "step", agent: s.agent, subtask: s.subtask, request: s.request, status: "start" }));
        const results = await Promise.all(steps.map(async (s) => {
          const st = Date.now();
          let out = await runAgent(s.agent, s.subtask, signal, () => emit({ type: "step", agent: s.agent, status: "retry" }), 120_000);
          let verified = false;
          if (s.request.startsWith(TQ) && !PROBE_OUTPUT.test(out) && !signal.aborted) {
            const probe = await verifiedProbe(s.agent, s.request, signal);
            // Keep only the verified output: a reply without the tool's real output may be invented
            // (a small model can "report" the example from its instructions as a finding).
            if (PROBE_OUTPUT.test(probe)) { out = `_(the agent did not return the tool's output — verified probe output, run in the ${s.agent} sandbox)_\n${probe}`; verified = true; }
          }
          emit({ type: "step", agent: s.agent, status: "done", out, verified, ms: Date.now() - st });
          return { ...s, out };
        }));

        // writer agent synthesizes
        const findings = results.map((r) => `## ${r.agent}\n${r.out}`).join("\n\n");
        emit({ type: "writer", status: "start" });
        const ws = Date.now();
        let answer = ""; let synthesizedBy = "analyst";
        const ev = evidence(results);
        const evLine = `Evidence check (computed from the probe outputs): error log lines=${ev.errorLogs ?? "unknown"}, error traces=${ev.errorTraces ?? "unknown"}, recent events=${ev.events ?? "unknown"}, 5xx request rate=${ev.rate5xx ?? "unknown"}.`;
        if (ev.clean) {
          // Every probe answered and none shows a failure: say so without asking the model, which
          // would otherwise take the incident text at its word and name the textbook cause.
          answer = `ROOT CAUSE: none found — the telemetry shows the app healthy. ${evLine}\nRECOMMENDED_ACTION: none — no fault found in the telemetry`;
          synthesizedBy = "evidence-check";
        } else if (FLEET.includes(SYNTH)) {
          const analystPrompt = `You are the incident analyst synthesizing an SRE fleet's findings. Reason ONLY over the findings below — do NOT use any tool, read any file, or generate any image, and do NOT greet, ask questions, or describe yourself. Begin your reply directly with "ROOT CAUSE:". In 2-4 sentences give the ROOT CAUSE citing the evidence (error rate, error logs naming the failing dependency, the failing span). CRITICAL: ask "what changed?" — if the events findings name a recent change (a dependency scaled to 0, or a recent deploy) that coincides with when the errors began, THAT change is the root cause, and the fix is to REVERSE it specifically. If logs show calls to a dependency failing AND events show that dependency was scaled to 0, the cause is the dependency being down — recommend scaling it back up. Never state a change or an error that the findings do not show; if they show no failure, say the app looks healthy. Then, on a FINAL separate line, output exactly:\nRECOMMENDED_ACTION: <the specific reversal, e.g. "scale the payments deployment back up to restore the dependency" or "roll back the recent deploy", or "none — no fault found in the telemetry">\n\nIncident: ${task}\n\n${evLine}\n\nFindings:\n${findings}`;
          // the model occasionally emits a non-answer (a greeting / "who am I?"); accept only a
          // real synthesis (must carry the RECOMMENDED_ACTION line) and retry once otherwise.
          // The marker check subsumes BOOTSTRAP_RE here, so this calls runAgentOnce directly.
          for (let attempt = 0; attempt < MAX_ATTEMPTS && !answer && !signal.aborted; attempt++) {
            if (attempt) emit({ type: "writer", status: "retry" });
            const w = (await runAgentOnce(SYNTH, analystPrompt, signal)).trim();
            if (w && !/^\(.*(failed|error)/i.test(w) && /RECOMMENDED_ACTION:/i.test(w)) answer = w;
          }
        }
        if (!answer) { answer = `_(analyst agent unavailable — raw findings below)_\n\n${findings}`; synthesizedBy = "raw"; }
        emit({ type: "answer", answer, synthesizedBy, ms: Date.now() - ws });
        emit({ type: "done" });
      } catch (e) {
        emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(hb);
      }
      try { controller.close(); } catch { /* already cancelled by the client */ }
    },
    cancel() { ac.abort(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
}

export async function GET() {
  return NextResponse.json({ ok: true, fleet: FLEET, demoNamespace: DEMO_NS, hint: "POST { task } → streams plan → parallel agents → writer (NDJSON timeline)" });
}
