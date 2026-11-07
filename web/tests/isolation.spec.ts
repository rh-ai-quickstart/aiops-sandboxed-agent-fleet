import { test, expect, request as pwRequest } from "@playwright/test";
import WebSocket from "ws";
import { getLab, runInLab, rawRequest, type LabInfo } from "./lab-helpers";

// Lab-mode isolation (multi-tenant design §9.3): attendee A — the instance at E2E_BASE_URL,
// authenticated with E2E_ACCESS_TOKEN — must not be able to reach attendee B's namespaces,
// services, tokens or workshop. Every probe runs as A's terminal identity through /api/check.
//
//   E2E_BASE_URL               A's workshop (https://workshop-<A>-openshell.<domain>)
//   E2E_ACCESS_TOKEN           A's access token
//   E2E_PEER_NAMESPACE_PREFIX  B's attendee id (e.g. user30 → user30-openshell / user30-demo)
//   E2E_PEER_BASE_URL          optional: B's workshop URL (default: derived from A's hostname)
//   E2E_PEER_SANDBOX_IP        optional: a B sandbox pod IP to probe on :2222
//   E2E_RUN_MUTATING=1         optional: also run the Grafana datasource-injection probe
//                              (creates and deletes a ConfigMap in A's demo namespace)

const BASE = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
const TOKEN = process.env.E2E_ACCESS_TOKEN || "";
const PEER = process.env.E2E_PEER_NAMESPACE_PREFIX || "";
const PEER_OS = `${PEER}-openshell`;
const PEER_DEMO = `${PEER}-demo`;
const SVC = (name: string, ns: string) => `${name}.${ns}.svc.cluster.local`;

test.skip(!BASE || !TOKEN || !PEER, "set E2E_BASE_URL, E2E_ACCESS_TOKEN and E2E_PEER_NAMESPACE_PREFIX");
test.describe.configure({ mode: "parallel" });
test.setTimeout(90_000);

let lab: LabInfo;
test.beforeAll(async () => {
  const ctx = await pwRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
  lab = await getLab(ctx);
  await ctx.dispose();
  expect(lab.labMode, "A must be a lab-mode instance").toBe(true);
  expect(lab.openshellNamespace, "A and B must differ").not.toBe(PEER_OS);
});

const forbidden = (s: string) => /forbidden/i.test(s);

test.describe("Kubernetes API (RBAC)", () => {
  test("cannot list B's pods", async ({ request }) => {
    const r = await runInLab(request, `oc -n ${PEER_OS} get pods`);
    expect(r.exitCode).not.toBe(0);
    expect(forbidden(r.stderr), r.stderr).toBe(true);
  });

  test("cannot scale B's demo app (server dry-run)", async ({ request }) => {
    const r = await runInLab(request, `oc -n ${PEER_DEMO} scale deploy/payments --replicas=0 --dry-run=server`);
    expect(r.exitCode).not.toBe(0);
    expect(forbidden(r.stderr), r.stderr).toBe(true);
  });

  test("cannot exec into pods of its own namespace (gateway, sandboxes)", async ({ request }) => {
    // openshell-0 always exists; RBAC denies pods/exec on every pod of the namespace in lab mode
    // (sandboxes are reached through `openshell sandbox exec`, which goes via the gateway).
    const r = await runInLab(request, `oc -n "$OPENSHELL_NS" exec openshell-0 -- true`);
    expect(r.exitCode).not.toBe(0);
    expect(forbidden(r.stderr), r.stderr).toBe(true);
  });

  test("no cluster-wide reads, but nodes are readable", async ({ request }) => {
    const routes = await runInLab(request, "oc get routes -A");
    expect(forbidden(routes.stderr), routes.stderr).toBe(true);
    const pods = await runInLab(request, "oc get pods -A");
    expect(forbidden(pods.stderr), pods.stderr).toBe(true);
    const nodes = await runInLab(request, "oc get nodes -o name");
    expect(nodes.exitCode, nodes.stderr).toBe(0);
  });

  test("cannot mint B's telemetry-reader token", async ({ request }) => {
    const r = await runInLab(request, `kubectl create token telemetry-reader -n ${PEER_OS} --duration=10m`);
    expect(r.exitCode).not.toBe(0);
    expect(forbidden(r.stderr), r.stderr).toBe(true);
  });
});

test.describe("Network (NetworkPolicies)", () => {
  const probes: [string, string][] = [
    ["B's OpenShell gateway", `http://${SVC("openshell", PEER_OS)}:8080/`],
    ["B's skill registry", `http://${SVC("registry", PEER_OS)}:4873/-/ping`],
    ["B's demo app", `http://${SVC("shop-app", PEER_DEMO)}:8080/`],
  ];
  if (process.env.E2E_PEER_SANDBOX_IP) probes.push(["B's sandbox SSH", `telnet://${process.env.E2E_PEER_SANDBOX_IP}:2222`]);

  for (const [what, url] of probes) {
    test(`${what} is unreachable`, async ({ request }) => {
      // 28 = timeout (dropped by NetworkPolicy), 7 = refused; 6 (DNS) means B does not exist
      const r = await runInLab(request, `curl -sS -m 5 -o /dev/null "${url}"; echo "exit=$?"`);
      const code = Number(/exit=(\d+)/.exec(r.stdout)?.[1] ?? -1);
      expect(code, `curl ${url}: ${r.stderr}`).not.toBe(6);
      expect([7, 28], `curl ${url} exit ${code}: ${r.stderr}`).toContain(code);
    });
  }

  test("openshell CLI cannot drive B's gateway", async ({ request }) => {
    const r = await runInLab(request,
      `timeout 25 openshell --gateway-endpoint http://${SVC("openshell", PEER_OS)}:8080 sandbox list`, 40_000);
    expect(r.exitCode, r.stdout).not.toBe(0);
  });
});

test.describe("Telemetry scoping", () => {
  const tenancy = "https://thanos-querier.openshift-monitoring.svc.cluster.local:9092";
  const loki = "https://logging-loki-gateway-http.openshift-logging.svc.cluster.local:8080";
  const sa = "$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)";
  const tr = '$(kubectl create token telemetry-reader -n "$OPENSHELL_NS" --duration=10m)';
  const status = (url: string, token: string) =>
    `curl -sk -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" "${url}"`;
  const promUrl = (ns: string) => `${tenancy}/api/v1/query?namespace=${ns}&query=up`;
  const lokiUrl = (ns: string) => `${loki}/api/logs/v1/application/loki/api/v1/labels?query=%7Bkubernetes_namespace_name%3D%22${ns}%22%7D`;

  for (const [who, token] of [["workshop SA", sa], ["telemetry-reader", tr]] as const) {
    test(`metrics (Thanos 9092) with the ${who} token: own demo ns yes, B's no`, async ({ request }) => {
      const own = await runInLab(request, status(promUrl('"$DEMO_NS"'), token));
      expect(own.stdout, own.stderr).toBe("200");
      const peer = await runInLab(request, status(promUrl(PEER_DEMO), token));
      expect(peer.stdout, peer.stderr).toBe("403");
    });

    test(`logs (Loki) with the ${who} token: B's namespace is denied`, async ({ request }) => {
      const peer = await runInLab(request, status(lokiUrl(PEER_DEMO), token));
      // design §5 spike S2: if Loki runs without namespaced authz this is advisory only
      expect.soft(peer.stdout, `Loki returned ${peer.stdout} for ${PEER_DEMO} (expected 403)`).toBe("403");
    });
  }
});

test.describe("B's workshop", () => {
  const peerBase = () => {
    if (process.env.E2E_PEER_BASE_URL) return process.env.E2E_PEER_BASE_URL.replace(/\/+$/, "");
    const u = new URL(BASE!);
    u.hostname = u.hostname.replace(lab.openshellNamespace, PEER_OS);
    return u.origin;
  };

  test("refuses no token and A's token", async () => {
    const base = peerBase();
    expect(base).not.toBe(new URL(BASE!).origin);
    const asA = { Authorization: `Bearer ${TOKEN}` };
    expect((await rawRequest(`${base}/`)).status).toBe(401);
    expect((await rawRequest(`${base}/api/lab`, { headers: asA })).status).toBe(401);
    expect((await rawRequest(`${base}/api/check`, { method: "POST", headers: asA, body: JSON.stringify({ cmd: "id" }) })).status).toBe(401);
    expect((await rawRequest(`${base}/?token=${encodeURIComponent(TOKEN)}`)).status).toBe(401);
    expect((await rawRequest(`${base}/healthz`)).status).toBe(200);
  });

  test("refuses the terminal WebSocket with A's token", async () => {
    const wsUrl = `${peerBase().replace(/^http/, "ws")}/ws/term`;
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` }, rejectUnauthorized: false });
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => resolve(-1));
    });
    expect(status).not.toBe(101);
  });
});

test.describe("Grafana (shared, anonymous Viewer)", () => {
  test("anonymous users cannot write dashboards", async () => {
    test.skip(!lab.grafanaUrl.startsWith("http"), "Grafana is only reachable through the workshop proxy");
    const r = await rawRequest(`${lab.grafanaUrl.replace(/\/+$/, "")}/api/dashboards/db`, {
      method: "POST",
      body: JSON.stringify({ dashboard: { title: `isolation-probe-${Date.now()}`, panels: [] }, overwrite: false }),
    });
    expect([401, 403]).toContain(r.status);
  });

  test("a grafana_datasource ConfigMap in A's demo namespace is not loaded", async ({ request }) => {
    test.skip(process.env.E2E_RUN_MUTATING !== "1", "mutating probe: set E2E_RUN_MUTATING=1");
    test.skip(!lab.grafanaUrl.startsWith("http"), "needs Grafana's own Route");
    const name = `isolation-probe-${Date.now()}`;
    const ds = `apiVersion: 1\ndatasources:\n  - name: ${name}\n    type: prometheus\n    url: http://127.0.0.1:1\n`;
    const create = await runInLab(request,
      `oc -n "$DEMO_NS" create configmap ${name} --from-literal=ds.yaml='${ds}' && oc -n "$DEMO_NS" label configmap ${name} grafana_datasource=1`);
    expect(create.exitCode, create.stderr).toBe(0);
    try {
      await new Promise((r) => setTimeout(r, 30_000)); // > sidecar resync
      const r = await rawRequest(`${lab.grafanaUrl.replace(/\/+$/, "")}/api/datasources/name/${name}`);
      expect(r.status).not.toBe(200);
    } finally {
      await runInLab(request, `oc -n "$DEMO_NS" delete configmap ${name} --ignore-not-found`);
    }
  });
});
