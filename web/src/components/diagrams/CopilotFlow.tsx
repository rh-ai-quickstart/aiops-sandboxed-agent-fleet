import { DIAGRAM as C } from "./palette";

// The Cluster Copilot loop: ask → inspect → propose → approve → act.
const W = 880, H = 300;
const Node = ({ x, y, w, fill, stroke, title, sub }: { x: number; y: number; w: number; fill: string; stroke: string; title: string; sub: string }) => (
  <g>
    <rect x={x} y={y} width={w} height={64} rx={12} fill={fill} stroke={stroke} strokeWidth={1.6} />
    <text x={x + w / 2} y={y + 27} fontSize={13.5} fill={C.ink} textAnchor="middle" fontWeight={700}>{title}</text>
    <text x={x + w / 2} y={y + 46} fontSize={10.8} fill={C.sub} textAnchor="middle">{sub}</text>
  </g>
);
const Arrow = ({ x1, y1, x2, y2, label }: { x1: number; y1: number; x2: number; y2: number; label?: string }) => (
  <g>
    <path d={`M${x1},${y1} L${x2},${y2}`} stroke={C.ctrl} strokeWidth={2} fill="none" markerEnd="url(#cf_ar)" />
    {label && <text x={(x1 + x2) / 2} y={Math.min(y1, y2) - 8} fontSize={10.5} fill={C.use} textAnchor="middle" fontWeight={600}>{label}</text>}
  </g>
);

export function CopilotFlow() {
  return (
    <figure className="my-6 overflow-hidden rounded-xl border border-[var(--color-line)]">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" fontFamily={C.font} role="img" aria-label="Cluster Copilot loop">
        <defs><marker id="cf_ar" markerWidth="10" markerHeight="10" refX="7" refY="3.2" orient="auto"><path d="M0,0 L8,3.2 L0,6.4 Z" fill={C.ctrl} /></marker></defs>
        <rect x={0} y={0} width={W} height={H} fill={C.bg} />
        <Node x={40} y={120} w={150} fill={C.gray} stroke={C.ctrl} title="You 🧑‍💻" sub="ask in plain English" />
        <Node x={250} y={120} w={170} fill={C.greenTint} stroke={C.nvidia} title="Shifty 🦞" sub="the OpenClaw agent" />
        <Node x={480} y={40} w={170} fill={C.redTint} stroke={C.redhat} title="OpenShift API" sub="oc / kube API (read)" />
        <Node x={480} y={196} w={170} fill={C.lav} stroke={C.auth} title="Proposed action" sub="scale / restart / patch" />
        <Node x={700} y={120} w={150} fill={C.blue} stroke="#6f8fd0" title="You approve ✓" sub="then it acts" />
        <Arrow x1={190} y1={152} x2={250} y2={152} label="prompt" />
        <Arrow x1={420} y1={140} x2={480} y2={92} label="inspect" />
        <Arrow x1={480} y1={104} x2={420} y2={150} />
        <Arrow x1={420} y1={166} x2={480} y2={216} label="plan" />
        <Arrow x1={650} y1={216} x2={700} y2={160} label="confirm?" />
        <Arrow x1={700} y1={140} x2={650} y2={92} />
        <text x={W / 2} y={285} fontSize={11} fill={C.sub} textAnchor="middle">Read freely · propose changes · act only after you approve — guardrails from OpenShift RBAC + OpenShell policy.</text>
      </svg>
    </figure>
  );
}
