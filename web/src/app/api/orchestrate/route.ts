import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Part VI capstone, in the website: an orchestrator that gives each sealed specialist agent
// an investigation step (in parallel, via `openclaw agent --local`), then a writer agent
// synthesizes their findings. The website never calls a model directly — the agents reach it
// through inference.local — so no host-side inference config is needed. Streams a live timeline.

const KUBECONFIG = process.env.KUBECONFIG || "";
const env = { ...process.env, NODE_NO_WARNINGS: "1", ...(KUBECONFIG ? { KUBECONFIG } : {}), PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/usr/bin` };
const FLEET = (process.env.FLEET || "logs,metrics,traces,events,analyst").split(",").map((s) => s.trim()).filter(Boolean);

// Prescribed probe per specialist. Free-form ReAct overflows the model's context (the agent
// wanders — reads files, hunts for the skill, calls dir_list — and times out), so the
// orchestrator hands each sealed agent the EXACT query its cluster-telemetry skill should run.
// The agent runs it (real data from its real backend, via curl under its egress policy) and
// interprets the result; the writer synthesizes. Backends are env-overridable.
const NS = process.env.INCIDENT_NS || "demo";
const PROM = process.env.PROM_HOST || "https://thanos-querier.openshift-monitoring.svc.cluster.local:9091";
const LOKI = process.env.LOKI_HOST || "https://logging-loki-gateway-http.openshift-logging.svc.cluster.local:8080";
const TEMPO = process.env.TEMPO_HOST || "https://tempo-tempostack-gateway.observability-hub.svc.cluster.local:8080";
const TQ = "node /sandbox/.agents/skills/cluster-telemetry/tq.js";
// Built per-request: Loki query_range needs an explicit [start,end] window (ns), so we stamp
// the last hour here. metrics uses an instant query (no window). `events` reads the k8s events
// that kubernetes-event-exporter ships into Loki.
function buildProbes(): Record<string, { url: string; hint: string }> {
  const ms = Date.now();
  const range = `&start=${ms - 3600000}000000&end=${ms}000000&limit=15`;
  return {
    metrics: { url: `${PROM}/api/v1/query?query=sum%20by%20(code)%20(rate(shop_requests_total%5B2m%5D))' '${PROM}/api/v1/query?query=sum(rate(shop_request_duration_ms_sum%5B2m%5D))%2Fsum(rate(shop_request_duration_ms_count%5B2m%5D))`,
      hint: "first the request rate by HTTP code (a spike in 5xx is the error rate vs 200s), then the average request latency in ms" },
    logs: { url: `${LOKI}/api/logs/v1/application/loki/api/v1/query_range?direction=backward&query=%7Bkubernetes_namespace_name%3D%22${NS}%22%7D%20%7C%3D%20%22error%22${range}`,
      hint: "the app's recent ERROR log lines (e.g. 'checkout failed: payment provider returned 503') — what the app itself says is wrong" },
    events: { url: `${LOKI}/api/logs/v1/application/loki/api/v1/query_range?direction=backward&query=%7Bkubernetes_namespace_name%3D%22monitoring%22%2Ckubernetes_container_name%3D%22event-exporter%22%7D%20%7C%3D%20%22${NS}%22%20%7C%3D%20%22reason%22${range}`,
      hint: "recent Kubernetes events for the namespace — ESPECIALLY any recent CHANGE: a Deployment scaled down or up (e.g. 'Scaled down replica set payments-… to 0', pods Killing/Created). Report the most recent such change and its time — a dependency scaled to 0 (or a deploy) that coincides with when the errors began is the prime suspect ('what changed?'). Name the specific workload that changed." },
    traces: { url: `${TEMPO}/api/traces/v1/dev/tempo/api/search?q=${encodeURIComponent('{ resource.service.name = "shop" && status = error }')}&limit=10`,
      hint: "recent ERROR traces for the shop service — the failing span (e.g. charge-payment) shows WHERE in the request path it breaks" },
  };
}

// Run `openshell …` with stdin closed so `sandbox exec` gets EOF and exits.
function openshell(args: string[], timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn("openshell", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill("SIGTERM"), timeoutMs);
    c.on("close", () => { clearTimeout(t); resolve(out); });
    c.on("error", (e) => { clearTimeout(t); resolve(`(dispatch error: ${e.message})`); });
  });
}

async function runAgent(agent: string, subtask: string): Promise<string> {
  // `openshell sandbox exec` rejects args containing newlines, and findings are multi-line —
  // so pass the message base64-encoded and decode it inside the sandbox via the shell.
  const b64 = Buffer.from(subtask, "utf8").toString("base64");
  const out = await openshell(["sandbox", "exec", "-n", agent, "--", "sh", "-c",
    `NODE_NO_WARNINGS=1 openclaw agent --local --json --session-id ${randomUUID()} -m "$(printf %s ${b64} | base64 -d)"`]);
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

// Streams the run as newline-delimited JSON events so the UI shows a LIVE TIMELINE of each
// agent (start/done + duration) — and the long run never idles the connection out. The
// investigators run in PARALLEL; the writer agent synthesizes once they're all in.
export async function POST(req: Request) {
  const { task } = await req.json().catch(() => ({}));
  if (!task || typeof task !== "string") return NextResponse.json({ ok: false, error: "task required" }, { status: 400 });
  const SYNTH = "analyst";
  const investigators = FLEET.filter((a) => a !== SYNTH);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const t0 = Date.now();
      const emit = (o: object) => controller.enqueue(enc.encode(JSON.stringify({ t: Date.now() - t0, ...o }) + "\n"));
      try {
        emit({ type: "plan-start", fleet: FLEET, investigators });
        // Fixed plan: one investigation step per specialist. No host-side model call to plan —
        // the intelligence is in each agent's investigation + the writer's synthesis (both reach
        // the model via inference.local, so the website never needs direct model access).
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
          const out = await runAgent(s.agent, s.subtask);
          emit({ type: "step", agent: s.agent, status: "done", out, ms: Date.now() - st });
          return { ...s, out };
        }));

        // writer agent synthesizes
        const findings = results.map((r) => `## ${r.agent}\n${r.out}`).join("\n\n");
        emit({ type: "writer", status: "start" });
        const ws = Date.now();
        let answer = ""; let synthesizedBy = "analyst";
        if (FLEET.includes(SYNTH)) {
          const analystPrompt = `You are the incident analyst synthesizing an SRE fleet's findings. Reason ONLY over the findings below — do NOT use any tool, read any file, or generate any image, and do NOT greet, ask questions, or describe yourself. Begin your reply directly with "ROOT CAUSE:". In 2-4 sentences give the ROOT CAUSE citing the evidence (error rate, error logs naming the failing dependency, the failing span). CRITICAL: ask "what changed?" — the events findings name a recent change (a dependency scaled to 0, or a recent deploy) that coincides with when the errors began; THAT change is the root cause, and the fix is to REVERSE it specifically. If logs show calls to a dependency failing AND events show that dependency was scaled to 0, the cause is the dependency being down — recommend scaling it back up. Then, on a FINAL separate line, output exactly:\nRECOMMENDED_ACTION: <the specific reversal, e.g. "scale the payments deployment back up to restore the dependency" or "roll back the recent deploy">\n\nIncident: ${task}\n\nFindings:\n${findings}`;
          // the model occasionally emits a non-answer (a greeting / "who am I?"); accept only a
          // real synthesis (must carry the RECOMMENDED_ACTION line) and retry once otherwise.
          for (let attempt = 0; attempt < 2 && !answer; attempt++) {
            const w = (await runAgent(SYNTH, analystPrompt)).trim();
            if (w && !/^\(.*(failed|error)/i.test(w) && /RECOMMENDED_ACTION:/i.test(w)) answer = w;
          }
        }
        if (!answer) { answer = `_(writer agent unavailable — raw findings below)_\n\n${findings}`; synthesizedBy = "raw"; }
        emit({ type: "answer", answer, synthesizedBy, ms: Date.now() - ws });
        emit({ type: "done" });
      } catch (e) {
        emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
}

export async function GET() {
  return NextResponse.json({ ok: true, fleet: FLEET, hint: "POST { task } → streams plan → parallel agents → writer (NDJSON timeline)" });
}
