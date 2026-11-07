import { NextResponse } from "next/server";
import { spawn } from "node:child_process";

// Device-pairing approvals for the agent's OpenClaw gateway. A device (browser/CLI) that
// asks to pair lands in the gateway's pending table; an admin approves/denies. We read the
// table and act via `openclaw devices approve|reject` run through `openshell sandbox exec`.
//
// IMPORTANT: `openshell sandbox exec` opens an interactive session and does NOT exit until
// stdin reaches EOF. Under a piped child that leaves stdin open, it hangs forever — so we
// spawn with stdin "ignore" (immediate EOF) and capture stdout. The phase-45 admin
// bootstrap is what lets the operator approve at all. (Egress access-requests: /api/drafts.)
const KUBECONFIG = process.env.KUBECONFIG || "";
const env = { ...process.env, ...(KUBECONFIG ? { KUBECONFIG } : {}), PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/usr/bin` };
const AGENT = process.env.OPENCLAW_AGENT_NAME || "shifty";
const UI_PORT = process.env.OPENCLAW_UI_PORT || "30789";
const validName = (n: string) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(n);
const validReqId = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function gwPassword(): string {
  return process.env.OPENCLAW_GATEWAY_PASSWORD || "openclaw";
}

// Run `openshell …` with stdin closed (so `sandbox exec` gets EOF and exits) + capture stdout.
function openshell(args: string[], timeoutMs = 12000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn("openshell", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* noop */ } reject(new Error("openshell timed out")); }, timeoutMs);
    c.on("error", (e) => { clearTimeout(t); reject(e); });
    c.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

function parseObj(s: string): Record<string, Record<string, unknown>> {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) return {};
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return {}; }
}

export const dynamic = "force-dynamic";

export async function GET() {
  if (!validName(AGENT)) return NextResponse.json({ ok: false, error: "bad agent", pending: [] });
  try {
    const { out } = await openshell(["sandbox", "exec", "-n", AGENT, "--", "cat", "/sandbox/.openclaw/devices/pending.json"], 12000);
    const pending = Object.values(parseObj(out)).map((r) => ({
      requestId: String(r.requestId ?? ""), deviceId: String(r.deviceId ?? ""),
      roles: Array.isArray(r.roles) ? (r.roles as string[]) : [],
      scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
      isRepair: !!r.isRepair, ts: typeof r.ts === "number" ? r.ts : null,
    })).filter((r) => r.requestId);
    return NextResponse.json({ ok: true, agent: AGENT, pending });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), pending: [] });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body?.action;

  // One-time bootstrap: grant the operator device the admin scopes it needs to approve
  // pairings. A password-paired operator starts with only `operator.pairing` — it can ask
  // to pair but can't APPROVE anyone, so a fresh gateway hits a "who approves the approver"
  // deadlock (devices approve → "scope upgrade pending"). We break it the only way possible:
  // through `openshell sandbox exec` (HOST / OpenShell privilege, NOT an OpenClaw operator
  // scope, so it's not subject to that deadlock) we pair the local operator, grant the admin
  // scopes directly in the gateway's device table, and restart the in-sandbox gateway so it
  // reloads them. Idempotent + re-runnable. This is what the "Enable approvals" button calls.
  if (action === "bootstrap-admin") {
    if (!validName(AGENT)) return NextResponse.json({ ok: false, error: "bad agent" }, { status: 400 });
    const pw = gwPassword();
    const url = `ws://127.0.0.1:${UI_PORT}`;
    const grantJs =
      'const fs=require("fs");const dir="/sandbox/.openclaw/devices";const p=dir+"/paired.json";' +
      'if(!fs.existsSync(p)){console.log("no-paired");process.exit(0);}' +
      'const d=JSON.parse(fs.readFileSync(p,"utf8"));if(!Object.keys(d).length){console.log("no-paired");process.exit(0);}' +
      'const want=["operator.pairing","operator.admin","operator.approvals","operator.read","operator.write"];' +
      'for(const k in d){d[k].scopes=want;d[k].approvedScopes=want;if(d[k].tokens&&d[k].tokens.operator)d[k].tokens.operator.scopes=want;}' +
      'fs.writeFileSync(p,JSON.stringify(d));try{fs.writeFileSync(dir+"/pending.json","{}")}catch(e){}' +
      'console.log("admin-bootstrapped "+Object.keys(d).length);';
    const b64 = Buffer.from(grantJs, "utf8").toString("base64");
    try {
      // pair the local operator (async) + grant admin — retry until a device exists to grant
      let granted = false;
      for (let i = 0; i < 4 && !granted; i++) {
        await openshell(["sandbox", "exec", "-n", AGENT, "--", "sh", "-c",
          `openclaw devices list --url ${url} --password '${pw}' >/dev/null 2>&1 || true`], 12000).catch(() => {});
        const r = await openshell(["sandbox", "exec", "-n", AGENT, "--", "sh", "-c",
          `echo ${b64} | base64 -d | node`], 12000).catch(() => ({ code: 1, out: "", err: "" }));
        if (/admin-bootstrapped/.test(r.out)) granted = true;
      }
      if (!granted)
        return NextResponse.json({ ok: false, action, error: "No operator device paired yet — open the agent's Control UI once (so a device tries to pair), then click Enable approvals again." }, { status: 409 });
      // restart the in-sandbox gateway so it reloads the new scopes
      await openshell(["sandbox", "exec", "-n", AGENT, "--", "sh", "-c",
        `cd /sandbox && pkill -f "^openclaw-gateway"; sleep 2; pkill -9 -f "^openclaw-gateway"; ` +
        `setsid nohup openclaw gateway run --port ${UI_PORT} --bind lan --auth password --password '${pw}' --allow-unconfigured >/sandbox/gateway.log 2>&1 </dev/null & ` +
        `echo $! >/sandbox/gateway.pid; sleep 6; grep -E '\\[gateway\\] ready|listening on ws' /sandbox/gateway.log | tail -1`], 25000).catch(() => {});
      return NextResponse.json({ ok: true, action, output: "Operator granted admin — approvals enabled. Reload the Control UI to reconnect." });
    } catch (e) {
      return NextResponse.json({ ok: false, action, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  const requestId = body?.requestId;
  if (action !== "approve" && action !== "reject")
    return NextResponse.json({ ok: false, error: "action must be approve|reject|bootstrap-admin" }, { status: 400 });
  if (!validReqId(requestId))
    return NextResponse.json({ ok: false, error: "invalid requestId" }, { status: 400 });
  try {
    const { out, err } = await openshell(
      ["sandbox", "exec", "-n", AGENT, "--", "openclaw", "devices", action, requestId as string,
        "--url", `ws://127.0.0.1:${UI_PORT}`, "--password", gwPassword(), "--timeout", "8000"], 16000);
    const text = (out + err).replace(/\x1b\[[0-9;]*m/g, "").split("\n")
      .filter((l) => l.trim() && !/UNDICI|trace-warn|node --trace/.test(l)).slice(-4).join("\n");
    return NextResponse.json({ ok: true, action, output: text });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
