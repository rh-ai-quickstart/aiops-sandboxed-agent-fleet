import { NextResponse } from "next/server";
import { callGateway, WORKSPACE_SCOPE } from "@/lib/gateway-grpc";

// Draft-policy review for the agent's gateway: the egress destinations the agent was
// DENIED become proposed allow-rules ("draft chunks") the admin approves/rejects. This is
// the OpenShell 0.1.6 gateway's gRPC DraftPolicy surface (same RPCs the OpenShell console
// and `openshell rule …` use). 0.1.6 shapes: the sandbox is `sandbox` (not `name`), every
// request carries `workspaceScope`, approvals must echo the chunk's `reviewToken` (the gateway
// rejects a stale review with FAILED_PRECONDITION), timestamps are google.protobuf.Timestamp
// and `draftVersion` is a uint64 (a decimal string on the wire to JS).
const AGENT = process.env.OPENCLAW_AGENT_NAME || "shifty";
const validId = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

type Timestamp = { seconds?: string | number; nanos?: number } | null | undefined;
type RawChunk = {
  id: string; status?: string; ruleName?: string; rationale?: string; securityNotes?: string;
  rejectionReason?: string; applicationError?: string; validationResult?: string; reviewToken?: string;
  binary?: string; hitCount?: number; stage?: string;
  proposedRule?: { name?: string; endpoints?: unknown[] };
  createdTime?: Timestamp; decidedTime?: Timestamp; lastSeenTime?: Timestamp;
};
type DraftPolicy = { chunks?: RawChunk[]; rollingSummary?: string; draftVersion?: string | number; lastAnalyzedTime?: Timestamp };

const tsMs = (t: Timestamp): number | null => {
  if (!t || t.seconds == null) return null;
  const s = Number(t.seconds);
  return Number.isFinite(s) && s > 0 ? s * 1000 + Math.floor((t.nanos ?? 0) / 1e6) : null;
};

const req = (extra: Record<string, unknown> = {}) => ({ sandbox: AGENT, workspaceScope: WORKSPACE_SCOPE, ...extra });

async function getDraft(statusFilter = ""): Promise<DraftPolicy> {
  return callGateway<DraftPolicy>("getDraftPolicy", req({ statusFilter }));
}

export const dynamic = "force-dynamic";

// GET → pending/decided draft chunks for the agent.
export async function GET() {
  try {
    const d = await getDraft();
    const chunks = (d.chunks ?? []).map((c) => ({
      id: c.id,
      status: c.status || "pending",
      ruleName: c.ruleName ?? "",
      rationale: c.rationale ?? "",
      securityNotes: c.securityNotes ?? "",
      securityFlagged: !!(c.securityNotes && c.securityNotes.trim()),
      rejectionReason: c.rejectionReason ?? "",
      applicationError: c.applicationError ?? "",
      validationResult: c.validationResult ?? "",
      binary: c.binary ?? "",
      hitCount: c.hitCount ?? 0,
      stage: c.stage ?? "",
      proposedRule: c.proposedRule ?? null,
      createdMs: tsMs(c.createdTime),
      decidedMs: tsMs(c.decidedTime),
      lastSeenMs: tsMs(c.lastSeenTime),
    }));
    const dv = d.draftVersion;
    return NextResponse.json({
      ok: true, agent: AGENT, chunks,
      draftVersion: dv === undefined || dv === null || dv === "" ? null : String(dv),
      rollingSummary: d.rollingSummary ?? "",
      lastAnalyzedMs: tsMs(d.lastAnalyzedTime),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, agent: AGENT, chunks: [], error: e instanceof Error ? e.message : String(e) });
  }
}

// POST { action, chunkId?, reason?, includeSecurityFlagged? } → approve | reject | approve-all | undo | clear.
// Approving merges the proposed allow-rule into the live policy (agent may then reach it).
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const action = body?.action;
  const chunkId = body?.chunkId;
  if (!["approve", "reject", "approve-all", "undo", "clear"].includes(action as string))
    return NextResponse.json({ ok: false, error: "action must be approve|reject|approve-all|undo|clear" }, { status: 400 });
  if (["approve", "reject", "undo"].includes(action as string) && !validId(chunkId))
    return NextResponse.json({ ok: false, error: "invalid chunkId" }, { status: 400 });
  try {
    let resp: unknown;
    switch (action) {
      case "approve": {
        // The review token binds the approval to the exact candidate the gateway evaluated.
        const pending = (await getDraft("pending")).chunks ?? [];
        const chunk = pending.find((c) => c.id === chunkId);
        if (!chunk) return NextResponse.json({ ok: false, error: "chunk is no longer pending" }, { status: 409 });
        resp = await callGateway("approveDraftChunk", req({ chunkId, reviewToken: chunk.reviewToken ?? "" }));
        break;
      }
      case "reject":
        resp = await callGateway("rejectDraftChunk", req({ chunkId, reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : "" }));
        break;
      case "approve-all": {
        const include = !!body.includeSecurityFlagged;
        const pending = (await getDraft("pending")).chunks ?? [];
        const approvals = pending
          .filter((c) => include || !(c.securityNotes && c.securityNotes.trim()))
          .map((c) => ({ chunkId: c.id, reviewToken: c.reviewToken ?? "" }));
        if (approvals.length === 0) return NextResponse.json({ ok: true, chunksApproved: 0, chunksSkipped: pending.length });
        resp = await callGateway("approveAllDraftChunks", req({ includeSecurityFlagged: include, approvals }));
        break;
      }
      case "undo":
        resp = await callGateway("undoDraftChunk", req({ chunkId }));
        break;
      case "clear":
        resp = await callGateway("clearDraftChunks", req());
        break;
    }
    return NextResponse.json({ ok: true, ...(resp as object) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
