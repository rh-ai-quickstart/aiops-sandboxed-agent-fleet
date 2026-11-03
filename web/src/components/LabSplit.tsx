"use client";
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { Terminal } from "./Terminal";
import { PanelRightClose, PanelRightOpen, RotateCcw, TerminalSquare } from "lucide-react";
import { useStoredString } from "@/lib/clientStore";

const DEFAULT_PCT = 44;
const clampPct = (n: number) => Math.min(68, Math.max(26, n));

// Hands-on lessons: content on the left, a live lab shell on the right.
// The shell column is draggable (resize width) and sticky (stays in view on scroll).
// On small screens it stacks below the content.
export function LabSplit({ children }: { children: ReactNode; slug?: string }) {
  // % width of the shell column (desktop), remembered across pages
  const [pctRaw, setPctRaw] = useStoredString("oclaw:shell-pct", String(DEFAULT_PCT));
  const savedPct = Number(pctRaw);
  const shellPct = Number.isFinite(savedPct) && savedPct >= 26 && savedPct <= 68 ? savedPct : DEFAULT_PCT;
  const setShellPct = (n: number) => setPctRaw(String(clampPct(n)));
  // Hidden by default — the shell appears only when the reader runs a command
  // (Run-in-shell) or explicitly opens it. An explicit open/close is remembered;
  // an auto-open from a command is transient (next page starts hidden again).
  const [savedShow, setSavedShow] = useStoredString("oclaw:shell-open", "false");
  const [autoOpen, setAutoOpen] = useState(false);
  const show = autoOpen || savedShow === "true";
  const containerRef = useRef<HTMLDivElement>(null);

  // Explicit user toggle — remembered across pages.
  function setShowManual(next: boolean) {
    setAutoOpen(false);
    setSavedShow(String(next));
  }

  // Running a command (runInShell → oclaw:start-shell) reveals the shell so the
  // reader can see the output. This open is transient — it isn't persisted.
  useEffect(() => {
    const onStart = () => setAutoOpen(true);
    window.addEventListener("oclaw:start-shell", onStart);
    return () => window.removeEventListener("oclaw:start-shell", onStart);
  }, []);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pct = ((r.right - ev.clientX) / r.width) * 100;
      setShellPct(pct);
    };
    const up = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  if (!show) {
    return (
      <div className="relative">
        <div className="prose max-w-none xl:max-w-6xl">
          {children}
        </div>
        <button onClick={() => setShowManual(true)} className="fixed bottom-4 right-4 z-30 rounded-lg border border-[var(--color-nv-dim)] bg-[var(--color-panel)] px-4 py-2 text-sm font-semibold text-[var(--color-nv-bright)] shadow-[0_8px_24px_rgba(0,0,0,0.22)] transition hover:bg-[var(--color-bg-2)]">
          <span className="inline-flex items-center gap-2"><PanelRightOpen size={15} /> Show shell</span>
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-4 lg:flex-row lg:gap-0" style={{ "--shell-w": `${shellPct}%` } as CSSProperties}>
      <div className="prose min-w-0 flex-1 lg:pr-5">{children}</div>

      <div
        onMouseDown={startDrag}
        className="group hidden w-3 shrink-0 cursor-col-resize items-stretch justify-center lg:flex"
        title="Drag to resize the shell"
      >
        <span className="my-2 w-px rounded-full bg-[var(--color-line)] transition-colors group-hover:bg-[var(--color-nv)]" />
      </div>

      <div className="w-full shrink-0 lg:w-auto lg:basis-[var(--shell-w)]">
        <div className="lg:sticky lg:top-16">
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 py-2">
            <span className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--color-fg-dim)]">
              <TerminalSquare size={15} className="text-[var(--color-nv-bright)]" />
              <span className="truncate">Live lab shell</span>
            </span>
            <span className="ml-auto hidden text-[10px] text-[var(--color-fg-mut)] sm:inline">{Math.round(shellPct)}%</span>
            <button
              onClick={() => setShellPct(DEFAULT_PCT)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-line-2)] text-[var(--color-fg-mut)] transition hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
              title="Reset shell width"
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={() => setShowManual(false)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-line-2)] text-[var(--color-fg-mut)] transition hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
              title="Hide shell"
            >
              <PanelRightClose size={15} />
            </button>
          </div>
          <Terminal title="lab shell — oc + openclaw" fill />
        </div>
      </div>
    </div>
  );
}
