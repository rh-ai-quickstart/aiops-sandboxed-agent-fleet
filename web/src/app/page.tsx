import Link from "next/link";
import { FIRST_SLUG, CURRICULUM } from "@/lib/curriculum";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-line-2)] px-3 py-1 text-xs text-[var(--color-fg-dim)]">
        Hands-on lab · Red Hat × NVIDIA
      </div>
      <h1 className="mt-5 text-4xl font-extrabold tracking-tight md:text-5xl">
        Deploy an AI agent on <span className="text-[var(--color-rh-bright)]">OpenShift</span>,
        <br />powered by <span className="text-[var(--color-nv-bright)]">NVIDIA OpenShell</span> and <span className="text-[var(--color-nv-bright)]">OpenClaw</span>.
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-[var(--color-fg-dim)]">
        Deploy a sandboxed AI agent — <strong>Shifty 🦞</strong> — to your OpenShift cluster with a single Helm chart,
        and drive it from a <strong>live shell right in this page</strong>. No GPU, no Kubernetes experience needed.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href={`/learn/${FIRST_SLUG}`} className="rounded-lg bg-[var(--color-nv)] px-5 py-2.5 font-semibold text-[#06080b] hover:bg-[var(--color-nv-bright)]">Start the workshop →</Link>
        <Link href="/learn/deploy" className="rounded-lg border border-[var(--color-line-2)] px-5 py-2.5 font-semibold hover:border-[var(--color-nv)]">Jump to deploy</Link>
      </div>

      <div className="mt-14 grid gap-4 sm:grid-cols-2">
        {CURRICULUM.map((p) => (
          <div key={p.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5">
            <div className="text-sm font-bold text-[var(--color-nv-bright)]">{p.title}</div>
            <div className="mt-1 text-sm text-[var(--color-fg-dim)]">{p.subtitle}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
