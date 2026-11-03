// Custom Next.js server that also bridges a browser terminal to a real shell
// (node-pty) over WebSocket. The shell starts with the ServiceAccount token
// auto-detected by oc/kubectl (in-cluster) and the lab helpers from lab/labrc
// (`sbox-openclaw` runs the OpenClaw CLI inside the agent's sandbox) — so learners
// run `oc …`, `openshell …` and `sbox-openclaw devices list/approve` for real.
//
// Optional lab access gate (multi-tenant mode, docs/CONTRACT.md): when LAB_ACCESS_TOKEN is
// set, every HTTP request, /api/* (incl. /api/check) and the /ws/term upgrade require either
// the `lab_access` cookie (set by visiting /?token=<token>) or `Authorization: Bearer <token>`.
// /healthz stays open for the kubelet probes. Without LAB_ACCESS_TOKEN the gate is off and the
// server behaves exactly as in single-instance mode.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import next from "next";
import { WebSocketServer } from "ws";
import pty from "node-pty";

// --- environment hygiene (before Next or any child process reads it) -------------------------
// The openshell CLI treats OPENSHELL_GATEWAY_ENDPOINT as a full gateway URL that overrides the
// registered/selected gateway. The chart passes it as `host:port` for the gRPC client, so move
// it to OPENSHELL_GRPC_TARGET (read by src/lib/gateway-grpc.ts) and keep it out of the shells.
if (process.env.OPENSHELL_GATEWAY_ENDPOINT) {
  process.env.OPENSHELL_GRPC_TARGET ||= process.env.OPENSHELL_GATEWAY_ENDPOINT.replace(/^https?:\/\//, "");
  delete process.env.OPENSHELL_GATEWAY_ENDPOINT;
}
// Keep the access token in memory only: shells and API children never see it.
const ACCESS_TOKEN = (process.env.LAB_ACCESS_TOKEN || "").trim();
delete process.env.LAB_ACCESS_TOKEN;
const GATE = ACCESS_TOKEN.length > 0;
if (GATE) process.env.LAB_GATE_ENABLED = "1";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const LAB_CWD = process.env.LAB_CWD || (existsSync("/app/lab/labrc") ? "/app" : process.cwd());
const LAB_KUBECONFIG = process.env.KUBECONFIG || "";
const LAB_RC = process.env.LAB_RC || `${process.cwd()}/lab/labrc`;
const MAX_SESSIONS = parseInt(process.env.LAB_MAX_SESSIONS || "25", 10);
const CHECK_TIMEOUT_MS = parseInt(process.env.LAB_CHECK_TIMEOUT_MS || "25000", 10);
const CHECK_TIMEOUT_MAX_MS = 300_000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
let sessions = 0;
await app.prepare();

// --- access gate ------------------------------------------------------------------------------
const COOKIE = "lab_access";
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest();
const TOKEN_DIGEST = GATE ? sha256(ACCESS_TOKEN) : null;
const COOKIE_VALUE = GATE ? TOKEN_DIGEST.toString("hex") : "";

function digestMatches(candidateDigest) {
  return !!TOKEN_DIGEST && candidateDigest.length === TOKEN_DIGEST.length && timingSafeEqual(candidateDigest, TOKEN_DIGEST);
}
function tokenMatches(token) {
  return typeof token === "string" && token.length > 0 && digestMatches(sha256(token));
}
function cookieMatches(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return false;
  return digestMatches(Buffer.from(value, "hex"));
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}
function isAuthorized(req) {
  if (!GATE) return true;
  const auth = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(auth) && tokenMatches(auth.replace(/^Bearer\s+/i, "").trim())) return true;
  return cookieMatches(readCookie(req, COOKIE));
}
function isHttps(req) {
  return req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}
function deny(req, res) {
  const path = (req.url || "/").split("?")[0];
  if (path.startsWith("/api/")) {
    res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "workshop access token required" }));
    return;
  }
  res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Workshop access</title>
<body style="font-family:system-ui,sans-serif;background:#0a0c10;color:#e6e6e6;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:32rem;padding:2rem"><h1 style="font-size:1.25rem">This workshop instance is private</h1>
<p>Open the personal link your facilitator gave you (it ends with <code>?token=…</code>). It signs this browser in for the rest of the workshop.</p></main></body>`);
}
/** `/anything?token=…`: on a valid token set the cookie and redirect to the same URL without it. */
function handleTokenLogin(req, res) {
  const url = new URL(req.url || "/", "http://local");
  const token = url.searchParams.get("token");
  if (token === null) return false;
  if (!tokenMatches(token)) { deny(req, res); return true; }
  url.searchParams.delete("token");
  const cookie = [`${COOKIE}=${COOKIE_VALUE}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${7 * 24 * 3600}`];
  if (isHttps(req)) cookie.push("Secure");
  res.writeHead(302, { "set-cookie": cookie.join("; "), location: `${url.pathname}${url.search}`, "cache-control": "no-store" });
  res.end();
  return true;
}
/** WebSocket upgrades must come from a page served by this host (no cross-site shell). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (it still needs the token)
  try {
    const o = new URL(origin).host;
    const hosts = [req.headers.host, ...String(req.headers["x-forwarded-host"] || "").split(",")].map((h) => (h || "").trim()).filter(Boolean);
    return hosts.includes(o);
  } catch { return false; }
}

// --- /api/check: run a lesson command and report pass/fail by exit code -----------------------
// The client already has a full interactive shell over /ws/term, so this adds no new exposure;
// in lab mode both are behind the access gate. BASH_ENV=labrc gives the command the same
// variables/helpers as the terminal ($OPENSHELL_NS, $DEMO_NS, sbox-openclaw, …).
function shellEnv(extra = {}) {
  return {
    ...process.env,
    ...(LAB_KUBECONFIG ? { KUBECONFIG: LAB_KUBECONFIG } : {}),
    HOME: process.env.HOME || "/tmp",
    LAB_CWD,
    LAB_RC,
    ...extra,
  };
}
function runCheck(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn("/bin/bash", ["-lc", cmd], { cwd: LAB_CWD, env: shellEnv({ BASH_ENV: LAB_RC }), timeout: timeoutMs, killSignal: "SIGKILL" });
    let out = "", errs = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { errs += d; });
    p.on("close", (code, signal) => resolve({
      exitCode: code ?? (signal ? 124 : 1),
      ...(signal ? { timedOut: true } : {}),
      stdout: out.slice(-8000),
      stderr: errs.slice(-8000),
    }));
    p.on("error", (e) => resolve({ exitCode: 1, stdout: "", stderr: String(e) }));
  });
}

const server = createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];

  // ungated liveness/readiness endpoint for the kubelet probes
  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (GATE) {
    if (handleTokenLogin(req, res)) return;
    if (!isAuthorized(req)) { deny(req, res); return; }
  }

  if (req.method === "POST" && path === "/api/check") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on("end", async () => {
      try {
        const { cmd, timeoutMs } = JSON.parse(body || "{}");
        if (!cmd || typeof cmd !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ exitCode: 1, stderr: "missing cmd" }));
          return;
        }
        const t = Number.isFinite(timeoutMs) ? Math.min(Math.max(1000, timeoutMs), CHECK_TIMEOUT_MAX_MS) : CHECK_TIMEOUT_MS;
        // Send the headers now and a space every 15 s: cloud load balancers in front of the router
        // drop connections idle for 60 s (AWS ELB), and a plugin install can run longer. Leading
        // whitespace is valid JSON, so clients still parse the body as usual.
        res.writeHead(200, { "content-type": "application/json" });
        const keepAlive = setInterval(() => res.write(" "), 15_000);
        const r = await runCheck(cmd, t).finally(() => clearInterval(keepAlive));
        res.end(JSON.stringify(r));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ exitCode: 1, stderr: String(e) }));
      }
    });
    return;
  }
  handle(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = (req.url || "").split("?")[0];
  if (pathname !== "/ws/term") { socket.destroy(); return; }
  if (GATE && (!isAuthorized(req) || !sameOrigin(req))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (sessions >= MAX_SESSIONS) {
      ws.send("\r\n\x1b[31mToo many active lab sessions. Try again shortly.\x1b[0m\r\n");
      ws.close();
      return;
    }
    sessions++;
    const shell = pty.spawn("/bin/bash", ["--rcfile", LAB_RC, "-i"], {
      name: "xterm-256color",
      cols: 100,
      rows: 28,
      cwd: LAB_CWD,
      env: shellEnv({ TERM: "xterm-256color", OCLAW_LAB: "1" }),
    });
    const onData = (d) => { if (ws.readyState === ws.OPEN) ws.send(d); };
    shell.onData(onData);
    shell.onExit(() => ws.readyState === ws.OPEN && ws.close());

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    const keepalive = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }, 20000);

    ws.on("message", (raw) => {
      const msg = raw.toString();
      if (msg.startsWith("\x00resize:")) {
        const [, cols, rows] = msg.split(":");
        try { shell.resize(parseInt(cols, 10) || 100, parseInt(rows, 10) || 28); } catch {}
      } else {
        shell.write(msg);
      }
    });
    ws.on("close", () => { clearInterval(keepalive); try { shell.kill(); } catch {} sessions = Math.max(0, sessions - 1); });
  });
});

server.listen(port, hostname, () => {
  console.log(`> OpenClaw workshop ready on http://${hostname}:${port}  (shell bridge: /ws/term${GATE ? ", access gate ON" : ""})`);
});
