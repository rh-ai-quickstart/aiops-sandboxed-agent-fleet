import { DIAGRAM as C } from "./palette";

// The governed skill supply chain: skills enter ONLY through your private
// in-cluster registry — either authored fresh or vetted-and-mirrored from
// ClawHub — and the agent's sole egress for installs is that registry.
// Direct ClawHub / public-npm access from the sandbox is denied by policy.
const W = 900, H = 412;
const Node = ({ x, y, w, h = 64, fill, stroke, title, sub, dash }: { x: number; y: number; w: number; h?: number; fill: string; stroke: string; title: string; sub: string; dash?: boolean }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={12} fill={fill} stroke={stroke} strokeWidth={1.6} strokeDasharray={dash ? "5 4" : undefined} />
    <text x={x + w / 2} y={y + (sub ? h / 2 - 2 : h / 2 + 4)} fontSize={13.5} fill={C.ink} textAnchor="middle" fontWeight={700}>{title}</text>
    {sub && <text x={x + w / 2} y={y + h / 2 + 16} fontSize={10.6} fill={C.sub} textAnchor="middle">{sub}</text>}
  </g>
);
const Arrow = ({ x1, y1, x2, y2, label, color = C.ctrl, dash, lx, ly }: { x1: number; y1: number; x2: number; y2: number; label?: string; color?: string; dash?: boolean; lx?: number; ly?: number }) => (
  <g>
    <path d={`M${x1},${y1} L${x2},${y2}`} stroke={color} strokeWidth={2} fill="none" markerEnd="url(#ssc_ar)" strokeDasharray={dash ? "6 5" : undefined} />
    {label && <text x={lx ?? (x1 + x2) / 2} y={ly ?? Math.min(y1, y2) - 8} fontSize={10.3} fill={color} textAnchor="middle" fontWeight={600}>{label}</text>}
  </g>
);

export function SkillSupplyChain() {
  return (
    <figure className="my-6 overflow-hidden rounded-xl border border-[var(--color-line)]">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" fontFamily={C.font} role="img" aria-label="Governed skill supply chain">
        <defs>
          <marker id="ssc_ar" markerWidth="10" markerHeight="10" refX="7" refY="3.2" orient="auto"><path d="M0,0 L8,3.2 L0,6.4 Z" fill={C.ctrl} /></marker>
          <marker id="ssc_grn" markerWidth="10" markerHeight="10" refX="7" refY="3.2" orient="auto"><path d="M0,0 L8,3.2 L0,6.4 Z" fill={C.green} /></marker>
          <marker id="ssc_red" markerWidth="10" markerHeight="10" refX="7" refY="3.2" orient="auto"><path d="M0,0 L8,3.2 L0,6.4 Z" fill={C.red} /></marker>
        </defs>
        <rect x={0} y={0} width={W} height={H} fill={C.bg} />

        {/* column labels */}
        <text x={120} y={28} fontSize={11.5} fill={C.sub} textAnchor="middle" fontWeight={700}>① CURATE</text>
        <text x={450} y={28} fontSize={11.5} fill={C.sub} textAnchor="middle" fontWeight={700}>② ONE GOVERNED REGISTRY</text>
        <text x={790} y={28} fontSize={11.5} fill={C.sub} textAnchor="middle" fontWeight={700}>③ INSTALL &amp; RUN</text>

        {/* curate sources */}
        <Node x={40} y={88} w={170} fill={C.greenTint} stroke={C.nvidia} title="Author your own 🛠️" sub="init · build · test" />
        <Node x={40} y={250} w={170} fill={C.lav} stroke={C.auth} title="Mirror a ClawHub skill" sub="review the source · vet ✓" />
        <Node x={40} y={332} w={170} h={48} fill={C.gray} stroke={C.border} title="ClawHub 🪝" sub="public skill hub" />
        <Arrow x1={125} y1={332} x2={125} y2={314} color={C.auth} />

        {/* registry (chokepoint) */}
        <Node x={350} y={150} w={200} h={120} fill={C.white} stroke={C.nvidia} title="Private registry 📦" sub="Verdaccio · in-cluster" />
        <text x={450} y={232} fontSize={10.2} fill={C.use} textAnchor="middle" fontWeight={600}>registry.&lt;ns&gt;.svc.cluster.local:4873</text>
        <text x={450} y={250} fontSize={9.8} fill={C.sub} textAnchor="middle">uplinks npm deps · single egress</text>

        {/* publish arrows into registry */}
        <Arrow x1={210} y1={118} x2={350} y2={178} label="npm publish" color={C.green} lx={280} ly={134} />
        <Arrow x1={210} y1={280} x2={350} y2={236} label="npm publish" color={C.green} lx={280} ly={284} />

        {/* install arrow to agent */}
        <Node x={690} y={150} w={180} h={76} fill={C.greenTint} stroke={C.nvidia} title="Agent sandbox 🦞" sub="shifty — Landlock-sealed" />
        <Arrow x1={550} y1={196} x2={690} y2={188} label="openclaw plugins install ✓" color={C.green} lx={620} ly={176} />
        <text x={780} y={244} fontSize={9.8} fill={C.sub} textAnchor="middle">runs the new tool, governed like any other</text>

        {/* blocked direct internet path */}
        <Node x={690} y={300} w={180} h={48} fill={C.redTint} stroke={C.red} title="ClawHub / public npm 🌐" sub="" dash />
        <Arrow x1={780} y1={300} x2={780} y2={228} color={C.red} dash />
        <text x={780} y={372} fontSize={10.2} fill={C.red} textAnchor="middle" fontWeight={700}>✗ DENIED by policy — agent has no direct egress</text>

        <text x={W / 2} y={400} fontSize={11} fill={C.sub} textAnchor="middle">Skills enter only through the registry — authored, or vetted-and-mirrored. Every install crosses one endpoint and lands in the audit log.</text>
      </svg>
    </figure>
  );
}
