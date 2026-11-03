import { DIAGRAM as C } from "./palette";

// The demo workload + its telemetry pipeline: a loadgen drives the instrumented shop-app, which
// emits the three signals into the observability backends (traces→Tempo, metrics→Prometheus via a
// ServiceMonitor, logs→Loki via the cluster log forwarder); an event-exporter feeds k8s events into Loki too. The
// sealed fleet then reads those backends. Theme-aware (CSS vars + translucent accent fills).
const W = 980, H = 470;
const GREEN = "#8fce46", BLUE = "#7aa2e3", AMBER = "#e0a23a", CYAN = "#34d4e0", VIOLET = "#a78bfa";
const Node = ({ x, y, w, h = 54, cls, stroke, title, sub, badge }: { x: number; y: number; w: number; h?: number; cls: string; stroke: string; title: string; sub?: string; badge?: string }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx={11} className={cls} stroke={stroke} strokeWidth={1.6} />
    <text x={x + w / 2} y={y + (sub ? h / 2 - 1 : h / 2 + 4)} fontSize={12.5} className="da-ink" textAnchor="middle" fontWeight={700}>{title}</text>
    {sub && <text x={x + w / 2} y={y + h / 2 + 14} fontSize={9.4} className="da-sub" textAnchor="middle">{sub}</text>}
    {badge && <text x={x + w / 2} y={y + h - 6} fontSize={9} fill={AMBER} textAnchor="middle" fontWeight={700}>{badge}</text>}
  </g>
);
const Arrow = ({ x1, y1, x2, y2, label, color, lx, ly }: { x1: number; y1: number; x2: number; y2: number; label?: string; color: string; lx?: number; ly?: number }) => (
  <g>
    <path d={`M${x1},${y1} L${x2},${y2}`} stroke={color} strokeWidth={1.7} fill="none" markerEnd="url(#da_a)" />
    {label && <text x={lx ?? (x1 + x2) / 2} y={ly ?? (y1 + y2) / 2 - 5} fontSize={9} fill={color} textAnchor="middle" fontWeight={600}>{label}</text>}
  </g>
);

export function DemoArchitecture() {
  const bx = 540, bw = 176;                   // backend column
  const beds = [
    { y: 70, t: "Tempo 🧵", s: "traces" },
    { y: 196, t: "Prometheus 📈", s: "metrics" },
    { y: 322, t: "Loki 🔎🛎️", s: "logs + k8s events" },
  ];
  return (
    <figure className="my-6 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" fontFamily={C.font} role="img" aria-label="Demo app and telemetry pipeline">
        <style>{`
          .da-surface{fill:var(--color-panel);} .da-ink{fill:var(--color-fg);} .da-sub{fill:var(--color-fg-mut);}
          .da-phase{fill:var(--color-fg-mut);letter-spacing:.08em;} .da-lane{fill:var(--color-fg);opacity:.025;}
          .da-green{fill:${GREEN};opacity:.2;} .da-blue{fill:${BLUE};opacity:.2;} .da-amber{fill:${AMBER};opacity:.22;} .da-violet{fill:${VIOLET};opacity:.22;}
        `}</style>
        <defs>
          <marker id="da_a" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill={C.sub} /></marker>
        </defs>
        <rect x={0} y={0} width={W} height={H} className="da-surface" />
        <rect x={12} y={36} width={196} height={398} rx={12} className="da-lane" />
        <rect x={232} y={36} width={290} height={398} rx={12} className="da-lane" />
        <rect x={530} y={36} width={232} height={398} rx={12} className="da-lane" />
        <rect x={772} y={36} width={196} height={398} rx={12} className="da-lane" />
        <text x={110} y={26} fontSize={10.5} className="da-phase" textAnchor="middle" fontWeight={800}>① WORKLOAD</text>
        <text x={377} y={26} fontSize={10.5} className="da-phase" textAnchor="middle" fontWeight={800}>② INSTRUMENTATION</text>
        <text x={646} y={26} fontSize={10.5} className="da-phase" textAnchor="middle" fontWeight={800}>③ BACKENDS</text>
        <text x={870} y={26} fontSize={10.5} className="da-phase" textAnchor="middle" fontWeight={800}>④ THE FLEET</text>

        {/* workload */}
        <Node x={28} y={92} w={164} cls="da-blue" stroke={BLUE} title="loadgen" sub="continuous traffic" />
        <Arrow x1={110} y1={146} x2={110} y2={214} label="GET /checkout" color={CYAN} lx={150} ly={184} />
        <Node x={28} y={214} w={164} h={84} cls="da-green" stroke={C.nvidia} title="shop-app" sub="instrumented service" badge="⚡ runtime fault toggle" />
        <Node x={28} y={356} w={164} cls="da-amber" stroke={AMBER} title="event-exporter" sub="watches your demo ns" />

        {/* instrumentation arrows → backends */}
        <Arrow x1={192} y1={234} x2={bx} y2={92}  label="OTLP traces" color={C.sub} lx={372} ly={150} />
        <Arrow x1={192} y1={256} x2={bx} y2={218} label="/metrics · ServiceMonitor" color={C.sub} lx={372} ly={236} />
        <Arrow x1={192} y1={278} x2={bx} y2={344} label="stdout · log forwarder" color={C.sub} lx={360} ly={300} />
        <Arrow x1={192} y1={382} x2={bx} y2={356} label="events" color={C.sub} lx={372} ly={392} />

        {/* backends */}
        {beds.map((b, i) => (
          <g key={i}>
            <Node x={bx} y={b.y} w={bw} cls="da-violet" stroke={VIOLET} title={b.t} sub={b.s} />
            <Arrow x1={bx + bw} y1={b.y + 27} x2={792} y2={150 + i * 60} color={C.sub} label={i === 0 ? "agents read" : undefined} lx={779} ly={b.y + 18} />
          </g>
        ))}

        {/* the fleet (custom block — cleanly spaced text inside a tall box) */}
        <rect x={792} y={120} width={164} height={160} rx={11} className="da-green" stroke={C.nvidia} strokeWidth={1.6} />
        <text x={874} y={156} fontSize={12.5} className="da-ink" textAnchor="middle" fontWeight={700}>sealed fleet</text>
        <text x={874} y={180} fontSize={9.2} className="da-sub" textAnchor="middle">logs · metrics ·</text>
        <text x={874} y={194} fontSize={9.2} className="da-sub" textAnchor="middle">traces · events</text>
        <text x={874} y={214} fontSize={9} className="da-sub" textAnchor="middle">each reads one backend</text>
        <text x={874} y={242} fontSize={10.5} className="da-ink" textAnchor="middle" fontWeight={700}>→ analyst 🧠</text>
        <text x={874} y={258} fontSize={9} className="da-sub" textAnchor="middle">concludes + recommends</text>

        <text x={W / 2} y={H - 12} fontSize={10.3} className="da-sub" textAnchor="middle">One loadgen-driven instrumented app produces all three signals; the sealed fleet reads them per-backend — inject a fault and it shows up everywhere at once.</text>
      </svg>
    </figure>
  );
}
