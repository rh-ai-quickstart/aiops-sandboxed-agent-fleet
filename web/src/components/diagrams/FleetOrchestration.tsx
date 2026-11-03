import { DIAGRAM as C } from "./palette";

// Part VI capstone: the in-page orchestrator runs a FIXED plan (no model call to plan) — it
// hands each sealed telemetry SPECIALIST (logs/metrics/traces/events — each with egress to ONE
// backend) a prescribed probe, then a no-egress ANALYST concludes the root cause + recommended
// fix. Theme-aware: structural colors come from site CSS vars; accent hues are translucent.
const W = 980, H = 470;
const VIOLET = "#a78bfa", GREEN = "#8fce46", AMBER = "#e0a23a", CYAN = "#34d4e0";
const Node = ({ x, y, w, h = 56, cls, stroke, title, sub, dash }: { x: number; y: number; w: number; h?: number; cls: string; stroke: string; title: string; sub?: string; dash?: boolean }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={11} className={cls} stroke={stroke} strokeWidth={1.6} strokeDasharray={dash ? "5 4" : undefined} />
    <text x={x + w / 2} y={y + (sub ? h / 2 - 1 : h / 2 + 4)} fontSize={12.5} className="fo-ink" textAnchor="middle" fontWeight={700}>{title}</text>
    {sub && <text x={x + w / 2} y={y + h / 2 + 14} fontSize={9.6} className="fo-sub" textAnchor="middle">{sub}</text>}
  </g>
);
const Arrow = ({ x1, y1, x2, y2, label, color, dash, lx, ly, marker }: { x1: number; y1: number; x2: number; y2: number; label?: string; color: string; dash?: boolean; lx?: number; ly?: number; marker: string }) => (
  <g>
    <path d={`M${x1},${y1} L${x2},${y2}`} stroke={color} strokeWidth={1.8} fill="none" markerEnd={`url(#${marker})`} strokeDasharray={dash ? "5 4" : undefined} opacity={dash ? 0.75 : 1} />
    {label && <text x={lx ?? (x1 + x2) / 2} y={ly ?? Math.min(y1, y2) - 6} fontSize={9.4} fill={color} textAnchor="middle" fontWeight={700}>{label}</text>}
  </g>
);

export function FleetOrchestration() {
  const ax = 470, aw = 220;                       // telemetry agent cards
  const agents = [
    { y: 48, role: "logs 🔎", egress: "Loki only" },
    { y: 138, role: "metrics 📈", egress: "Prometheus only" },
    { y: 228, role: "traces 🧵", egress: "Tempo only" },
    { y: 318, role: "events 🛎️", egress: "k8s events (Loki)" },
  ];
  const wx = 762, wy = 150, ww = 196, wh = 150;   // analyst agent

  return (
    <figure className="my-6 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" fontFamily={C.font} role="img" aria-label="SRE copilot fleet orchestration">
        <style>{`
          .fo-surface{fill:var(--color-panel);} .fo-card{fill:var(--color-bg-2);}
          .fo-ink{fill:var(--color-fg);} .fo-sub{fill:var(--color-fg-mut);}
          .fo-phase{fill:var(--color-fg-mut);letter-spacing:.08em;} .fo-lane{fill:var(--color-fg);opacity:.025;}
          .fo-violet{fill:${VIOLET};opacity:.14;} .fo-green{fill:${GREEN};opacity:.13;} .fo-amber{fill:${AMBER};opacity:.15;}
        `}</style>
        <defs>
          <marker id="fa_v" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill={CYAN} /></marker>
          <marker id="fa_g" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill={GREEN} /></marker>
          <marker id="fa_a" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill={AMBER} /></marker>
          <marker id="fa_s" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill={C.sub} /></marker>
        </defs>
        <rect x={0} y={0} width={W} height={H} className="fo-surface" />
        <rect x={12} y={36} width={150} height={398} rx={12} className="fo-lane" />
        <rect x={184} y={36} width={240} height={398} rx={12} className="fo-lane" />
        <rect x={446} y={36} width={278} height={398} rx={12} className="fo-lane" />
        <rect x={744} y={36} width={224} height={398} rx={12} className="fo-lane" />
        <text x={87} y={26} fontSize={10.5} className="fo-phase" textAnchor="middle" fontWeight={800}>① ASK</text>
        <text x={304} y={26} fontSize={10.5} className="fo-phase" textAnchor="middle" fontWeight={800}>② ORCHESTRATE</text>
        <text x={585} y={26} fontSize={10.5} className="fo-phase" textAnchor="middle" fontWeight={800}>③ INVESTIGATE (parallel)</text>
        <text x={856} y={26} fontSize={10.5} className="fo-phase" textAnchor="middle" fontWeight={800}>④ CONCLUDE</text>

        {/* ask */}
        <Node x={24} y={196} w={140} cls="fo-card" stroke={C.ctrl} title="You / an app 🧑‍💻" sub="one incident" />
        <Arrow x1={164} y1={224} x2={204} y2={224} label="task" color={CYAN} marker="fa_v" />

        {/* orchestrate — a FIXED plan (no model call to plan); each agent gets a prescribed probe */}
        <Node x={204} y={188} w={160} h={72} cls="fo-violet" stroke={VIOLET} title="Orchestrator" sub="fixed plan · one probe each" />
        <text x={284} y={300} fontSize={9} className="fo-sub" textAnchor="middle">no model call here —</text>
        <text x={284} y={313} fontSize={9} className="fo-sub" textAnchor="middle">agents do the inference</text>

        {/* investigate — 4 sealed telemetry agents, each its own backend */}
        {agents.map((a, i) => {
          const cy = a.y + 28;
          return (
            <g key={i}>
              <Node x={ax} y={a.y} w={aw} cls="fo-green" stroke={C.nvidia} title={a.role} sub={a.egress} />
              <Arrow x1={364} y1={224} x2={ax} y2={cy} label={i === 0 ? "probe" : undefined} color={GREEN} marker="fa_g" lx={ax - 50} ly={a.y + 6} />
              <Arrow x1={ax + aw} y1={cy} x2={wx} y2={wy + 34 + i * 9} label={i === 0 ? "findings" : undefined} color={C.sub} marker="fa_s" dash lx={wx - 28} ly={a.y + 6} />
            </g>
          );
        })}

        {/* conclude — the no-egress analyst */}
        <Node x={wx} y={wy} w={ww} h={wh} cls="fo-amber" stroke={AMBER} title="analyst 🧠" sub="no egress · concludes" />
        <text x={wx + ww / 2} y={wy + 92} fontSize={9.4} className="fo-sub" textAnchor="middle">→ root cause</text>
        <text x={wx + ww / 2} y={wy + 108} fontSize={9.4} className="fo-sub" textAnchor="middle">→ recommended image</text>
        {/* analyst's verdict back to the human */}
        <Arrow x1={wx + ww / 2} y1={wy + wh} x2={wx + ww / 2} y2={wy + wh + 34} color={AMBER} marker="fa_a" />
        <text x={wx + ww / 2} y={wy + wh + 50} fontSize={9.6} className="fo-ink" textAnchor="middle" fontWeight={700}>root cause + fix → you approve ✋</text>

        <text x={W / 2} y={H - 14} fontSize={10.3} className="fo-sub" textAnchor="middle">Four sealed specialists read one backend each; a no-egress analyst concludes the root cause — every step governed and audited.</text>
      </svg>
    </figure>
  );
}
