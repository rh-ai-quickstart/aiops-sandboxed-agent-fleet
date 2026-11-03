"use strict";
// shop-app — a tiny, ZERO-DEPENDENCY instrumented demo service for the SRE fleet.
//
// Edit this file directly; it's mounted into a stock node:alpine pod via a ConfigMap that
// kustomize generates from it (so a change → new hash → automatic rollout). On every /checkout
// it makes a REAL HTTP call to its `payments` dependency, and emits:
//   • TRACES  — OTLP/HTTP JSON → Tempo (a /checkout span + a real charge-payment child span)
//   • METRICS — Prometheus text at /metrics (shop_requests_total, durations)
//   • LOGS    — structured JSON to stdout (→ Loki via the log shipper)
// There is NO fault flag: checkout fails only when the real payment call fails (e.g. the
// payments deployment is scaled to 0 → connection refused). That's a genuine dependency outage.
const http = require("http");
const crypto = require("crypto");

const OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector-collector.observability-hub.svc.cluster.local:4318";
const SERVICE = process.env.OTEL_SERVICE_NAME || "shop";
const PAYMENT_URL = process.env.PAYMENT_URL || "http://payments:8080/charge"; // same namespace

// OTEL resource attributes: service.name + anything in OTEL_RESOURCE_ATTRIBUTES
// ("k=v,k2=v2", e.g. k8s.namespace.name from the downward API) so the shared Tempo can be
// filtered per namespace: { resource.k8s.namespace.name = "<ns>" }.
const RESOURCE_ATTRS = [{ key: "service.name", value: { stringValue: SERVICE } }];
for (const kv of (process.env.OTEL_RESOURCE_ATTRIBUTES || "").split(",")) {
  const i = kv.indexOf("=");
  if (i <= 0) continue;
  const k = kv.slice(0, i).trim(), v = decodeURIComponent(kv.slice(i + 1).trim());
  if (k && v && k !== "service.name") RESOURCE_ATTRS.push({ key: k, value: { stringValue: v } });
}
if (process.env.K8S_NAMESPACE && !RESOURCE_ATTRS.some((a) => a.key === "k8s.namespace.name"))
  RESOURCE_ATTRS.push({ key: "k8s.namespace.name", value: { stringValue: process.env.K8S_NAMESPACE } });

const hrNs = () => BigInt(Date.now()) * 1000000n; // ms→ns
const id = (n) => crypto.randomBytes(n).toString("hex");

// ---- metrics (hand-rolled Prometheus exposition) ----
const reqs = {};                  // `route|code` -> count
const durSum = {}, durCount = {}; // route -> ms
function bump(route, code, ms) {
  const k = route + "|" + code; reqs[k] = (reqs[k] || 0) + 1;
  durSum[route] = (durSum[route] || 0) + ms; durCount[route] = (durCount[route] || 0) + 1;
}
function metrics() {
  let o = "# HELP shop_requests_total Total HTTP requests.\n# TYPE shop_requests_total counter\n";
  for (const k in reqs) { const [r, c] = k.split("|"); o += `shop_requests_total{route="${r}",code="${c}"} ${reqs[k]}\n`; }
  o += "# HELP shop_request_duration_ms_sum Sum of request durations (ms).\n# TYPE shop_request_duration_ms_sum counter\n";
  for (const r in durSum) o += `shop_request_duration_ms_sum{route="${r}"} ${durSum[r]}\n`;
  o += "# TYPE shop_request_duration_ms_count counter\n";
  for (const r in durCount) o += `shop_request_duration_ms_count{route="${r}"} ${durCount[r]}\n`;
  return o;
}

// ---- trace export (OTLP/HTTP JSON, fire-and-forget) ----
const sv = (s) => ({ stringValue: String(s) });
function emitTrace(spans) {
  const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: RESOURCE_ATTRS },
    scopeSpans: [{ scope: { name: "shop-app" }, spans }] }] });
  fetch(`${OTLP}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body })
    .catch((e) => console.log(JSON.stringify({ level: "warn", msg: "trace export failed", err: String(e).slice(0, 80) })));
}

// ---- the business endpoint: a REAL call to the payments dependency ----
async function handleCheckout(req, res) {
  const t0 = Date.now(), traceId = id(16), root = id(8), pay = id(8);
  const customer = new URL(req.url, "http://x").searchParams.get("customer") || "anon";
  const payT0 = hrNs().toString();
  let ok = false, payErr = "", payCode = 0;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(PAYMENT_URL, { method: "POST", signal: ctrl.signal });
    clearTimeout(to);
    payCode = r.status; ok = r.ok;
    if (!r.ok) payErr = `payment provider returned ${r.status}`;
  } catch (e) {
    payErr = `payment call failed: ${(e && (e.cause?.code || e.name)) || String(e).slice(0, 60)}`;
  }
  const payT1 = hrNs().toString(), durMs = Date.now() - t0;
  const start = (hrNs() - BigInt(durMs) * 1000000n).toString();
  emitTrace([
    { traceId, spanId: root, name: "GET /checkout", kind: 2, startTimeUnixNano: start, endTimeUnixNano: payT1,
      attributes: [{ key: "customer", value: sv(customer) }, { key: "http.route", value: sv("/checkout") }],
      status: { code: ok ? 1 : 2, message: ok ? "" : payErr } },
    { traceId, spanId: pay, parentSpanId: root, name: "charge-payment", kind: 3, startTimeUnixNano: payT0, endTimeUnixNano: payT1,
      attributes: [{ key: "peer.service", value: sv("payments") }, { key: "http.status_code", value: sv(payCode || "n/a") }],
      status: { code: ok ? 1 : 2, message: payErr } },
  ]);
  const code = ok ? 200 : 503;
  bump("/checkout", code, durMs);
  console.log(JSON.stringify({ level: ok ? "info" : "error",
    msg: ok ? "checkout ok" : `checkout failed: ${payErr}`,
    customer, status: code, payment_status: payCode || 0, duration_ms: durMs, trace_id: traceId }));
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok, customer, durationMs: durMs }));
}

http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/healthz") { res.writeHead(200); return res.end("ok"); } // healthy even when payments is down — it's a dependency failure, not a crash
  if (path === "/metrics") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(metrics()); }
  if (path === "/checkout" || path === "/") return handleCheckout(req, res);
  res.writeHead(404); res.end("not found");
}).listen(8080, () => console.log(JSON.stringify({ level: "info", msg: "shop-app listening", port: 8080, service: SERVICE, payment_url: PAYMENT_URL, namespace: process.env.K8S_NAMESPACE || "" })));
