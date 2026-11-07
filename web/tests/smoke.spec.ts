import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { CURRICULUM, ALL_LESSONS } from "../src/lib/curriculum";
import { classify, extractRunnableBlocks, rawRequest } from "./lab-helpers";

// Smoke tests against the local dev server (started by playwright.config.ts). No cluster needed.
// Run with SMOKE_ACCESS_TOKEN=<anything> to start the dev server with the lab access gate ON
// (the config then sends the token as a Bearer header) and exercise the gate tests too.
const SMOKE_TOKEN = process.env.SMOKE_ACCESS_TOKEN || "";
const BASE = "http://localhost:3000";

test.skip(!!process.env.E2E_BASE_URL, "smoke runs against the local dev server only");

test("homepage loads and shows workshop title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/OpenClaw/i);
  await expect(page.locator("h1").first()).toBeVisible();
});

test("homepage links to the first lesson", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /start|begin|get started/i })).toBeVisible();
});

test("curriculum nav renders all parts", async ({ page }) => {
  await page.goto(`/learn/${ALL_LESSONS[0].slug}`);
  const nav = page.getByLabel("Lessons");
  for (const part of CURRICULUM) await expect(nav.getByText(part.title)).toBeVisible();
});

test("each lesson page loads without error", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  for (const lesson of ALL_LESSONS) {
    const resp = await page.goto(`/learn/${lesson.slug}`);
    expect(resp?.status(), lesson.slug).toBe(200);
    await expect(page.locator("h1, h2").first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("lesson code blocks are classified (runnable blocks parse)", async ({ page }) => {
  test.setTimeout(240_000);
  let total = 0;
  for (const lesson of ALL_LESSONS.filter((l) => l.hasLab)) {
    await page.goto(`/learn/${lesson.slug}`);
    const blocks = await extractRunnableBlocks(page);
    for (const b of blocks) {
      expect(b.length).toBeGreaterThan(0);
      expect(["manual", "mutating", "read-only"]).toContain(classify(b).kind);
      // a lesson block must never reference the removed 0.0.x inference router
      expect(b, `${lesson.slug}: stale CLI`).not.toMatch(/inference\.local|openshell\s+inference\s|policy\s+prove|--\s+true\s*$/m);
    }
    total += blocks.length;
  }
  expect(total).toBeGreaterThan(20);
});

test("navigating between lessons works", async ({ page }) => {
  await page.goto(`/learn/${ALL_LESSONS[0].slug}`);
  await page.getByRole("link", { name: /next/i }).click();
  await expect(page).toHaveURL(new RegExp(ALL_LESSONS[1].slug));
});

test("404 page for invalid lesson slug", async ({ page }) => {
  expect((await page.goto("/learn/nonexistent-lesson-slug"))?.status()).toBe(404);
});

test("/healthz answers without credentials", async () => {
  const r = await rawRequest(`${BASE}/healthz`);
  expect(r.status).toBe(200);
  expect(JSON.parse(r.text)).toEqual({ ok: true });
});

test("GET /api/lab returns the instance environment", async ({ request }) => {
  const r = await request.get("/api/lab");
  expect(r.status()).toBe(200);
  const lab = await r.json();
  expect(lab.ok).toBe(true);
  for (const k of ["labUser", "openshellNamespace", "demoNamespace", "consoleEnabled", "grafanaUrl"]) expect(lab).toHaveProperty(k);
  expect(lab.openshellNamespace).toMatch(/^[a-z0-9-]+$/);
  expect(lab.demoNamespace).toMatch(/^[a-z0-9-]+$/);
  expect(lab.labMode).toBe(!!SMOKE_TOKEN);
});

test("POST /api/check runs one script with the lab environment", async ({ request }) => {
  const multi = 'X=$(printf "%s" \\\n  "$OPENSHELL_NS")\nif [ -n "$X" ]; then\n  echo "ns=$X demo=$DEMO_NS"\nfi';
  const r = await request.post("/api/check", { data: { cmd: multi } });
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.exitCode, j.stderr).toBe(0);
  expect(j.stdout).toMatch(/^ns=[a-z0-9-]+ demo=[a-z0-9-]+/);
  expect((await request.post("/api/check", { data: {} })).status()).toBe(400);
});

test("POST /api/drafts rejects unknown actions", async ({ request }) => {
  expect((await request.post("/api/drafts", { data: { action: "nope" } })).status()).toBe(400);
  expect((await request.post("/api/drafts", { data: { action: "approve", chunkId: "x" } })).status()).toBe(400);
});

test.describe("lab access gate", () => {
  test.skip(!SMOKE_TOKEN, "start the smoke server with SMOKE_ACCESS_TOKEN=… to test the gate");

  test("unauthenticated requests are refused", async () => {
    const get = (path: string, headers: Record<string, string> = {}) => rawRequest(`${BASE}${path}`, { headers });
    expect((await get("/")).status).toBe(401);
    expect((await get("/learn/welcome")).status).toBe(401);
    const api = await get("/api/lab");
    expect(api.status).toBe(401);
    expect(JSON.parse(api.text)).toMatchObject({ ok: false });
    expect((await rawRequest(`${BASE}/api/check`, { method: "POST", body: JSON.stringify({ cmd: "true" }) })).status).toBe(401);
    expect((await get("/?token=wrong")).status).toBe(401);
    expect((await get("/api/lab", { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get("/api/lab", { Cookie: "lab_access=" + "0".repeat(64) })).status).toBe(401);
    expect((await get("/healthz")).status).toBe(200);
  });

  test("?token= sets an HttpOnly cookie, strips the token and grants access", async () => {
    const login = await rawRequest(`${BASE}/learn/welcome?x=1&token=${encodeURIComponent(SMOKE_TOKEN)}`);
    expect(login.status).toBe(302);
    expect(login.headers["location"]).toBe("/learn/welcome?x=1");
    const setCookie = String(login.headers["set-cookie"] ?? "");
    expect(setCookie).toMatch(/^lab_access=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax/);
    expect(setCookie).not.toContain(SMOKE_TOKEN);
    const cookie = setCookie.split(";")[0];
    expect((await rawRequest(`${BASE}/api/lab`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await rawRequest(`${BASE}/api/lab`, { headers: { Authorization: `Bearer ${SMOKE_TOKEN}` } })).status).toBe(200);
  });

  test("browser flow: token link → cookie → pages and API work", async ({ browser }) => {
    // a fresh context: no Bearer header, only what the token link sets
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?token=${encodeURIComponent(SMOKE_TOKEN)}`);
    await expect(page).toHaveURL(`${BASE}/`);
    await expect(page.locator("h1").first()).toBeVisible();
    const st = await page.evaluate(async () => (await fetch("/api/lab")).status);
    expect(st).toBe(200);
    const cookies = await ctx.cookies();
    expect(cookies.find((c) => c.name === "lab_access")?.httpOnly).toBe(true);
    await ctx.close();
  });

  test("terminal WebSocket requires the token and a same-origin Origin", async () => {
    const tryWs = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const ws = new WebSocket("ws://localhost:3000/ws/term", { headers });
      ws.on("open", () => { ws.close(); resolve(101); });
      ws.on("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); });
      ws.on("error", () => resolve(-1));
    });
    expect(await tryWs({})).toBe(401);
    expect(await tryWs({ Authorization: `Bearer ${SMOKE_TOKEN}`, Origin: "https://evil.example.com" })).toBe(401);
    expect(await tryWs({ Authorization: `Bearer ${SMOKE_TOKEN}`, Origin: "http://localhost:3000" })).toBe(101);
  });
});
