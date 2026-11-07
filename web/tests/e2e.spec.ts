import { test, expect } from "@playwright/test";
import { CURRICULUM, ALL_LESSONS } from "../src/lib/curriculum";
import {
  getLab, runInLab, extractRunnableBlocks, classify, referencedSandboxes, label,
  STDERR_ERRORS, isExecBlock, isForbidden, rawRequest, type CheckResult,
} from "./lab-helpers";

// E2E against a live workshop instance. Requires E2E_BASE_URL (no default: never a real cluster
// URL in the repo). Lab instances also need E2E_ACCESS_TOKEN (sent as a Bearer header by
// playwright.config.ts) and E2E_LAB_MODE=1.
//
// "Run in shell" verification is split in two:
//   * read-only checks (default): every lesson block that only READS state, run through
//     /api/check. Blocks that read a sandbox that does not exist yet are skipped (reason given).
//   * the lesson flow (E2E_RUN_MUTATING=1, dedicated test instance only): every runnable block of
//     every lab lesson, in curriculum order, serially — a failure stops the flow and the later
//     lessons are reported as skipped instead of cascading into misleading failures.

const BASE = process.env.E2E_BASE_URL?.replace(/\/+$/, "");
const LAB_MODE = process.env.E2E_LAB_MODE === "1";
const RUN_MUTATING = process.env.E2E_RUN_MUTATING === "1";
const TOKEN = process.env.E2E_ACCESS_TOKEN || "";
const AGENT = process.env.E2E_AGENT_NAME || "shifty";

test.skip(!BASE, "set E2E_BASE_URL=https://workshop-<namespace>.<apps-domain> to run the e2e project");

test.describe("Homepage", () => {
  test("renders hero, title, and curriculum overview", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/OpenClaw/i);
    await expect(page.locator("h1")).toContainText("OpenShift");
    await expect(page.locator("h1")).toContainText("OpenShell");
    for (const part of CURRICULUM) {
      await expect(page.getByText(part.title).first()).toBeVisible();
    }
  });

  test('"Start the workshop" navigates to the first lesson', async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /start the workshop/i }).click();
    await expect(page).toHaveURL(/\/learn\/welcome/);
  });

  test("theme toggle switches between light and dark", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    const initialTheme = await html.getAttribute("data-theme");
    await page.getByLabel("Toggle theme").click();
    expect(await html.getAttribute("data-theme")).not.toBe(initialTheme);
  });
});

test.describe("Header navigation", () => {
  test("logo links to homepage", async ({ page }) => {
    await page.goto("/learn/welcome");
    await page.locator("header a").first().click();
    await expect(page).toHaveURL(new RegExp(`^${BASE?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`));
  });

  test("Live link navigates to /learn/live", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /live/i }).first().click();
    await expect(page).toHaveURL(/\/learn\/live/);
  });

  test("Approvals link navigates to /approvals", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /approvals/i }).click();
    await expect(page).toHaveURL(/\/approvals/);
  });

  test("Links dropdown lists this instance's services", async ({ page }) => {
    await page.goto("/");
    await page.getByTitle(/services/i).click();
    await expect(page.getByRole("link", { name: /OpenClaw UI/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Grafana/ })).toBeVisible();
    if (LAB_MODE) await expect(page.getByRole("link", { name: /OpenShift console/ })).toHaveCount(0);
  });
});

test.describe("Curriculum navigation", () => {
  test("sidebar renders all parts and lessons", async ({ page }) => {
    await page.goto(`/learn/${ALL_LESSONS[0].slug}`);
    const nav = page.getByLabel("Lessons");
    for (const part of CURRICULUM) await expect(nav.getByText(part.title)).toBeVisible();
  });

  test("clicking a lesson in the sidebar navigates to it", async ({ page }) => {
    await page.goto(`/learn/${ALL_LESSONS[0].slug}`);
    const target = ALL_LESSONS[5];
    await page.getByLabel("Lessons").getByText(target.title).click();
    await expect(page).toHaveURL(new RegExp(target.slug));
    await expect(page.locator("article h1, article h2").first()).toBeVisible();
  });

  test("next/prev navigation works across lessons", async ({ page }) => {
    await page.goto(`/learn/${ALL_LESSONS[0].slug}`);
    await page.getByRole("link", { name: /next/i }).click();
    await expect(page).toHaveURL(new RegExp(ALL_LESSONS[1].slug));
    await page.getByRole("link", { name: /prev/i }).click();
    await expect(page).toHaveURL(new RegExp(ALL_LESSONS[0].slug));
  });
});

test.describe("Lesson pages", () => {
  for (const lesson of ALL_LESSONS) {
    test(`/learn/${lesson.slug} loads correctly`, async ({ page }) => {
      const resp = await page.goto(`/learn/${lesson.slug}`);
      expect(resp?.status()).toBe(200);
      await expect(page.locator("article").first()).toBeVisible();
    });
  }

  test("lesson with lab shows the terminal panel", async ({ page }) => {
    const labLesson = ALL_LESSONS.find((l) => l.hasLab)!;
    await page.goto(`/learn/${labLesson.slug}`);
    await expect(page.getByRole("button", { name: /show shell/i })).toBeVisible({ timeout: 10_000 });
  });

  test("lesson without lab does not show terminal panel", async ({ page }) => {
    const noLabLesson = ALL_LESSONS.find((l) => !l.hasLab)!;
    await page.goto(`/learn/${noLabLesson.slug}`);
    await expect(page.locator(".xterm")).toHaveCount(0);
  });
});

test.describe("Instance environment", () => {
  test("GET /api/lab describes this instance", async ({ request }) => {
    const lab = await getLab(request);
    expect(lab.ok).toBe(true);
    expect(lab.openshellNamespace).toMatch(/^[a-z0-9-]+$/);
    expect(lab.demoNamespace).toMatch(/^[a-z0-9-]+$/);
    expect(lab.grafanaUrl).toMatch(/\/grafana\/$/);
    expect(typeof lab.consoleEnabled).toBe("boolean");
    if (LAB_MODE) {
      expect(lab.labMode).toBe(true);
      expect(lab.labUser).not.toBe("");
      expect(lab.openshellNamespace).toBe(`${lab.labUser}-openshell`);
      expect(lab.demoNamespace).toBe(`${lab.labUser}-demo`);
      expect(lab.consoleEnabled).toBe(false);
    }
  });

  test("lab shell (BASH_ENV=labrc) exports the namespaces of /api/lab", async ({ request }) => {
    const lab = await getLab(request);
    const r = await runInLab(request, 'printf "%s %s %s" "$OPENSHELL_NS" "$DEMO_NS" "$(cd ~/nemoclaw-openshift-launchable && pwd -P)"');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${lab.openshellNamespace} ${lab.demoNamespace} /app`);
  });

  test("openshell CLI talks to this instance's gateway", async ({ request }) => {
    const r = await runInLab(request, "openshell status && openshell sandbox list");
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test("/healthz is reachable without credentials", async () => {
    expect((await rawRequest(`${BASE}/healthz`)).status).toBe(200);
  });

  test("access gate: no token → 401, wrong token → 401, token link → cookie", async () => {
    test.skip(!TOKEN, "instance without access gate (E2E_ACCESS_TOKEN unset)");
    expect((await rawRequest(`${BASE}/`)).status).toBe(401);
    expect((await rawRequest(`${BASE}/api/lab`)).status).toBe(401);
    expect((await rawRequest(`${BASE}/api/check`, { method: "POST", body: JSON.stringify({ cmd: "true" }) })).status).toBe(401);
    expect((await rawRequest(`${BASE}/api/lab`, { headers: { Authorization: "Bearer not-the-token" } })).status).toBe(401);
    expect((await rawRequest(`${BASE}/?token=not-the-token`)).status).toBe(401);
    const login = await rawRequest(`${BASE}/?token=${encodeURIComponent(TOKEN)}`);
    expect(login.status).toBe(302);
    expect(String(login.headers["set-cookie"] ?? "")).toMatch(/lab_access=[0-9a-f]{64};.*HttpOnly.*Secure/i);
  });
});

test.describe("API routes", () => {
  test("GET /api/devices returns agent info", async ({ request }) => {
    const resp = await request.get("/api/devices");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty("ok");
    expect(body.agent ?? AGENT).toBe(AGENT);
    expect(Array.isArray(body.pending)).toBe(true);
  });

  test("GET /api/fleet returns agent list", async ({ request }) => {
    const resp = await request.get("/api/fleet");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.agents.length).toBeGreaterThan(0);
    for (const agent of body.agents) {
      expect(agent).toHaveProperty("name");
      expect(agent).toHaveProperty("role");
      expect(agent).toHaveProperty("ready");
      expect(Array.isArray(agent.egress)).toBe(true);
    }
  });

  test("GET /api/incident returns health status for this demo namespace", async ({ request }) => {
    const lab = await getLab(request);
    const body = await (await request.get("/api/incident")).json();
    expect(body.ok).toBe(true);
    expect(body.ns).toBe(lab.demoNamespace);
    expect(body).toHaveProperty("exists");
    expect(body).toHaveProperty("pods");
    expect(body).toHaveProperty("healthy");
  });

  test("GET /api/openshell returns gateway status and providers", async ({ request }) => {
    const lab = await getLab(request);
    const body = await (await request.get("/api/openshell")).json();
    expect(body.ok).toBe(true);
    expect(body.namespace).toBe(lab.openshellNamespace);
    expect(body.gateway.ready).toBe(true);
    expect(body.gateway).toHaveProperty("version");
    expect(Array.isArray(body.sandboxes)).toBe(true);
    for (const s of body.sandboxes) expect(s.name).not.toMatch(/^default--/);
    if (body.inference) expect(Array.isArray(body.inference.providers)).toBe(true);
  });

  test("GET /api/drafts answers with the 0.1.6 draft shape", async ({ request }) => {
    const body = await (await request.get("/api/drafts")).json();
    expect(body).toHaveProperty("ok");
    expect(Array.isArray(body.chunks)).toBe(true);
    if (body.ok && body.draftVersion !== null) expect(typeof body.draftVersion).toBe("string");
  });

  test("GET /api/orchestrate returns the fleet", async ({ request }) => {
    const lab = await getLab(request);
    const body = await (await request.get("/api/orchestrate")).json();
    expect(body.ok).toBe(true);
    expect(body.demoNamespace).toBe(lab.demoNamespace);
  });

  for (const route of ["devices", "incident", "drafts"]) {
    test(`POST /api/${route} with invalid action returns 400`, async ({ request }) => {
      expect((await request.post(`/api/${route}`, { data: { action: "invalid" } })).status()).toBe(400);
    });
  }
});

test.describe("Grafana", () => {
  test("/grafana proxy reaches Grafana", async ({ request }) => {
    const resp = await request.get("/grafana", { maxRedirects: 0 });
    // single mode: redirect to the login page; lab mode (anonymous Viewer): a page or a redirect
    expect([200, 301, 302]).toContain(resp.status());
    if (resp.status() !== 200) expect(resp.headers()["location"]).toContain("/grafana");
  });
});

test.describe("Approvals page", () => {
  test("renders the approvals UI", async ({ page }) => {
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: /Access requests/ })).toBeVisible();
  });
});

test.describe("Error handling", () => {
  test("invalid lesson slug returns 404", async ({ page }) => {
    expect((await page.goto("/learn/nonexistent-slug"))?.status()).toBe(404);
  });
  test("invalid top-level route returns 404", async ({ page }) => {
    expect((await page.goto("/this-does-not-exist"))?.status()).toBe(404);
  });
});

// --- Run in shell ------------------------------------------------------------------------------

/** `… | grep pattern` as the last command: exit 1 + empty stderr just means "no match yet". */
// Quoted text is blanked first: a grep alternation like 'a|b' is not a pipe.
const endsWithGrep = (block: string) =>
  /\|\s*grep\b[^|\n]*$/.test((block.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l)).pop() ?? "").replace(/'[^']*'|"[^"]*"/g, "''"));

// A lesson block that demonstrates a refusal carries `# … expect-fail: <regex>`: the command must
// fail AND its output must match (e.g. the policy's `policy_denied`), so the denial itself is tested.
const EXPECT_FAIL = /expect-fail:\s*([^)\n]+)/;

function assertBlock(block: string, r: CheckResult, opts: { tolerateNoMatch?: boolean } = {}) {
  const ef = EXPECT_FAIL.exec(block);
  if (ef) {
    const out = `exit ${r.exitCode}\n--- stdout\n${r.stdout.slice(-600)}\n--- stderr\n${r.stderr.slice(-600)}`;
    expect(r.exitCode, `"${label(block)}" should fail\n${out}`).not.toBe(0);
    expect(new RegExp(ef[1].trim(), "i").test(`${r.stdout}\n${r.stderr}`), `"${label(block)}" should print ${ef[1].trim()}\n${out}`).toBe(true);
    return;
  }
  if (opts.tolerateNoMatch && r.exitCode === 1 && !r.stderr.trim() && endsWithGrep(block)) {
    test.info().annotations.push({ type: "no-match", description: `${label(block)} — grep found nothing (state from a mutating lesson not present)` });
    return;
  }
  const out = `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n--- stdout\n${r.stdout.slice(-600)}\n--- stderr\n${r.stderr.slice(-600)}`;
  if (LAB_MODE && isExecBlock(block)) {
    // RBAC doing its job: the attendee's SA may not exec into (privileged) sandbox pods
    expect(isForbidden(r), `"${label(block)}" should be Forbidden in lab mode\n${out}`).toBe(true);
    return;
  }
  expect(r.exitCode, `"${label(block)}"\n${out}`).toBe(0);
  const err = STDERR_ERRORS.find((p) => p.test(r.stderr));
  expect(err, `"${label(block)}" stderr matches ${err}\n${out}`).toBeUndefined();
}

const LAB_LESSONS = ALL_LESSONS.filter((l) => l.hasLab);

test.describe("Run in shell — read-only checks", () => {
  test.setTimeout(180_000);
  for (const lesson of LAB_LESSONS) {
    test(`/learn/${lesson.slug}`, async ({ page, request }) => {
      await page.goto(`/learn/${lesson.slug}`);
      await page.waitForLoadState("networkidle");
      const blocks = await extractRunnableBlocks(page);
      const sandboxes: string[] = ((await (await request.get("/api/openshell")).json())?.sandboxes ?? []).map((s: { name: string }) => s.name);
      let ran = 0;
      for (const block of blocks) {
        const c = classify(block);
        if (c.kind !== "read-only") {
          test.info().annotations.push({ type: "skipped-block", description: `${label(block)} — ${c.kind === "manual" ? c.reason : "mutating (E2E_RUN_MUTATING=1 flow)"}` });
          continue;
        }
        const missing = referencedSandboxes(block).filter((n) => !sandboxes.includes(n));
        if (missing.length) {
          test.info().annotations.push({ type: "skipped-block", description: `${label(block)} — sandbox ${missing.join(", ")} not created yet` });
          continue;
        }
        await test.step(`exec: ${label(block)}`, async () => assertBlock(block, await runInLab(request, block, 60_000), { tolerateNoMatch: true }));
        ran++;
      }
      test.info().annotations.push({ type: "blocks", description: `${ran}/${blocks.length} read-only blocks executed` });
    });
  }
});

test.describe("Run in shell — lesson flow (mutating)", () => {
  test.skip(!RUN_MUTATING, "set E2E_RUN_MUTATING=1 (dedicated test instance only) to run the full lesson flow");
  test.describe.configure({ mode: "serial" });
  for (const lesson of LAB_LESSONS) {
    test(`/learn/${lesson.slug}`, async ({ page, request }) => {
      test.setTimeout(45 * 60_000);
      await page.goto(`/learn/${lesson.slug}`);
      await page.waitForLoadState("networkidle");
      const blocks = await extractRunnableBlocks(page);
      for (const block of blocks) {
        const c = classify(block);
        if (c.kind === "manual") {
          test.info().annotations.push({ type: "skipped-block", description: `${label(block)} — ${c.reason}` });
          continue;
        }
        await test.step(`exec: ${label(block)}`, async () => assertBlock(block, await runInLab(request, block, 300_000)));
      }
    });
  }
});
