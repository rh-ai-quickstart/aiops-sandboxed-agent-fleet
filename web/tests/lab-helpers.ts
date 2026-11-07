import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Shared helpers for the e2e / isolation specs: lesson code-block extraction, classification
// (read-only vs mutating vs manual) and command execution through POST /api/check, which runs
// each block as ONE bash script (`bash -lc`, BASH_ENV=lab/labrc) inside the workshop pod.

export type CheckResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

export type LabInfo = {
  ok: boolean; labUser: string; labMode: boolean; openshellNamespace: string; demoNamespace: string;
  appsDomain: string; workshopUrl: string | null; openclawUrl: string | null; grafanaUrl: string;
  consoleEnabled: boolean; consoleUrl: string | null;
};

export async function getLab(request: APIRequestContext): Promise<LabInfo> {
  const r = await request.get("/api/lab");
  expect(r.status(), "GET /api/lab").toBe(200);
  return r.json();
}

/** Run one script in the lab shell (as one `bash -lc`, never split per line). */
export async function runInLab(request: APIRequestContext, cmd: string, timeoutMs = 25_000): Promise<CheckResult> {
  const r = await request.post("/api/check", { data: { cmd, timeoutMs }, timeout: timeoutMs + 15_000 });
  expect(r.status(), `/api/check for: ${label(cmd)}`).toBe(200);
  return r.json();
}

/** All runnable ("▶ Run in shell") blocks of the current lesson page, whole, in page order. */
export async function extractRunnableBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      if (!/run in shell/i.test(btn.textContent || "")) continue;
      const pre = btn.closest("div.group")?.querySelector("pre");
      const text = (pre?.textContent || "").replace(/\s+$/, "");
      if (text) out.push(text);
    }
    return out;
  });
}

export function label(block: string): string {
  const lines = block.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l));
  const first = (lines[0] ?? block.split("\n")[0]).trim();
  const short = first.length > 90 ? `${first.slice(0, 87)}...` : first;
  return lines.length > 1 ? `${short} (+${lines.length - 1} lines)` : short;
}

// --- classification ----------------------------------------------------------------------------

/** Blocks a script cannot run unattended: placeholders, interactive/streaming commands. */
const MANUAL: [RegExp, string][] = [
  [/<[A-Z][A-Z0-9_-]*>|<your[-_ ][^>]*>/, "contains a placeholder to fill in"],
  [/\bopenshell\s+(term|sandbox\s+connect)\b/, "interactive TUI / shell"],
  [/\bopenshell\s+logs\b[^\n]*--tail\b|\btail\s+-f\b|\bwatch\s+-?/, "streams forever"],
  [/\bopenshell\s+forward\s+start\b(?![^\n]*(--background|\s-d\b))/, "foreground port-forward"],
  [/\bopenclaw\s+tui\b|\bread\s+-[a-z]*p\b/, "interactive"],
  [/(^|[\s;&|])(nano|vi|vim|less|more)\s/m, "opens an interactive editor/pager"],
];

/** Anything that changes cluster / gateway / sandbox state, or needs an agent sandbox running. */
const MUTATING: RegExp[] = [
  /\bopenshell\s+sandbox\s+(create|delete|exec|upload|download|stop|start|suspend|resume|provider\s+(attach|detach))\b/,
  /\bopenshell\s+(provider\s+(create|update|delete|refresh|profile\s+(import|update|delete))|profile\s+(import|update|delete)|policy\s+(set|update|delete)|forward\s+(start|stop)|gateway\s+(add|remove|select)|rule\s+\w+|service\s+(expose|delete)|settings\s+(set|delete))\b/,
  /\b(oc|kubectl)\b[^\n|;&]*?\s(apply|create|delete|patch|scale|exec|edit|label|annotate|cp|run|expose|replace|rollout\s+(restart|undo))\b/,
  /\bsbox-openclaw\b|\bexpose-agent\b/,
  /\bfleet\.sh\s+(up|down)\b/,
  /\bcurl\b[^\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--data|\s-d\s|\s-T\s)/,
  /\bnpm\s+(publish|install|i|adduser|login)\b/,
  /\bsed\s+-i\b|\btee\b|(^|[^0-9&])>\s*(?!\/dev\/null)[~/$.\w]/m,
  /(^|[\s;&|])(rm|mv|cp|ln|mkdir|touch|chmod)\s/m,
  /127\.0\.0\.1:30789/, // the agent's forwarded Control UI port (needs shifty + forward)
];

export type BlockKind = { kind: "manual"; reason: string } | { kind: "mutating" } | { kind: "read-only" };

export function classify(block: string): BlockKind {
  const code = block.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const [re, reason] of MANUAL) if (re.test(code)) return { kind: "manual", reason };
  if (MUTATING.some((re) => re.test(code))) return { kind: "mutating" };
  return { kind: "read-only" };
}

/** Sandbox names a read-only block reads from the gateway (`openshell logs shifty`, `default--shifty`, …). */
export function referencedSandboxes(block: string): string[] {
  const names = new Set<string>();
  const re = /\bopenshell\s+(?:logs|policy\s+(?:get|list)|sandbox\s+(?:get|provider\s+list))\s+(?:-[^\s]+\s+)*([a-z0-9][a-z0-9-]*)/g;
  for (const m of block.matchAll(re)) names.add(m[1]);
  for (const m of block.matchAll(/\bdefault--([a-z0-9][a-z0-9-]*)/g)) names.add(m[1]);
  return [...names];
}

/** Error signatures in stderr (stdout is not scanned: log lines legitimately contain them). */
export const STDERR_ERRORS = [
  /Error from server/i,
  /\bForbidden\b/,
  /PERMISSION_DENIED/,
  /command not found/,
  /No such file or directory/,
  /connection refused/i,
  /unable to connect/i,
];

/** In lab mode the workshop SA may not `oc exec` into pods: those blocks must be Forbidden. */
export const isExecBlock = (block: string) => /\b(oc|kubectl)\b[^\n|;&]*?\sexec\b/.test(block);
export const isForbidden = (r: CheckResult) => r.exitCode !== 0 && /forbidden|cannot create resource "pods\/exec"/i.test(`${r.stderr}\n${r.stdout}`);

// --- raw HTTP (no Playwright context) --------------------------------------------------------
// Playwright API contexts created inside tests inherit the config's `use` options — including
// the Bearer header from E2E_ACCESS_TOKEN — so "unauthenticated" probes use plain node:http(s).

export type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

export function rawRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: opts.method ?? "GET",
      headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...opts.headers },
      rejectUnauthorized: false,
      timeout: 20_000,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout: ${url}`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
