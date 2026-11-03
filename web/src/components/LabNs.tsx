"use client";
import { useLabEnv } from "@/lib/useLabEnv";

/**
 * Inline namespace name for lesson prose: `<Ns which="openshell" />` / `<Ns which="demo" />`.
 * Renders this instance's real namespace (`user07-demo` in lab mode), `openshell` / `demo`
 * until GET /api/lab answers.
 */
export function Ns({ which = "openshell" }: { which?: "openshell" | "demo" }) {
  const lab = useLabEnv();
  return <>{which === "demo" ? lab.demoNamespace : lab.openshellNamespace}</>;
}
