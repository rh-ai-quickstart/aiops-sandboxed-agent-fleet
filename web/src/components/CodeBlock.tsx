"use client";
import { useState, useMemo, type ReactNode, isValidElement } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import json from "highlight.js/lib/languages/json";
import "highlight.js/styles/github-dark.css";
import { runInShell } from "@/lib/labBus";
import { useIsClient } from "@/lib/clientStore";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("json", json);

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return "";
}

// Find the fence language from the inner <code class="language-xxx">.
function getLang(node: ReactNode): string {
  if (Array.isArray(node)) {
    for (const c of node) { const l = getLang(c); if (l) return l; }
    return "";
  }
  if (isValidElement(node)) {
    const cn = String((node.props as { className?: string }).className || "");
    const m = /language-([\w-]+)/.exec(cn);
    if (m) return m[1];
    return getLang((node.props as { children?: ReactNode }).children);
  }
  return "";
}

const SHELL_LANGS = ["bash", "sh", "shell", "console", "zsh"];
// Reference fences: highlighted like bash but NEVER runnable (for commands we show but
// don't want run from this lesson — e.g. "inspect/change later", or commands set elsewhere).
const REF_LANGS = ["bash-ref", "sh-ref", "ref"];
// Map a fence language to a registered highlight.js grammar (or null = render plain).
function hljsLang(lang: string): string | null {
  if (lang === "" || SHELL_LANGS.includes(lang) || REF_LANGS.includes(lang)) return "bash";
  if (lang === "yaml" || lang === "yml") return "yaml";
  if (lang === "json") return "json";
  return null; // text, md, … → no highlighting
}

// Override for MDX <pre>: syntax-highlighted code with a Copy toolbar, plus a "Run in
// shell" button on shell blocks that contain at least one real command. Non-shell fences
// (text, yaml, md, json) and comment-only blocks are illustrative — Copy only, no Run.
export function CodeBlock({ children }: { children?: ReactNode }) {
  const code = extractText(children).replace(/\n$/, "");
  const lang = getLang(children);
  const [copied, setCopied] = useState(false);

  const isRef = REF_LANGS.includes(lang);
  const isShell = lang === "" || SHELL_LANGS.includes(lang);
  const hasCommand = code.split("\n").some((l) => l.trim() !== "" && !/^\s*#/.test(l));
  const runnable = isShell && hasCommand && !isRef; // reference fences are never runnable
  const label = isRef ? "reference" : (lang || "shell");

  const grammar = hljsLang(lang);
  // Highlight only once hydrated. The server (and the client's hydration render) emit plain
  // text, so hydration always matches; the colored HTML replaces it on the next client render.
  // Highlighting during SSR shipped dangerouslySetInnerHTML that the client could mismatch on —
  // which left some blocks rendering blank after hydration.
  const isClient = useIsClient();
  const html = useMemo(() => {
    if (!isClient || !grammar) return null;
    try { return hljs.highlight(code, { language: grammar }).value; } catch { return null; }
  }, [isClient, code, grammar]);

  return (
    <div className="group relative my-5 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-code-bg)]">
      <div className="flex items-center justify-between border-b border-[var(--color-line)] px-3 py-1.5">
        <span className="font-mono text-[11px] text-[var(--color-fg-mut)]">{label}</span>
        <div className="flex gap-2">
          {runnable && (
            <button
              onClick={() => runInShell(code)}
              className="rounded border border-[var(--color-nv-dim)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-nv-bright)] hover:bg-[var(--color-panel)]"
              title="Run this in the lab shell"
            >
              ▶ Run in shell
            </button>
          )}
          <button
            onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
            className="rounded border border-[var(--color-line-2)] px-2 py-0.5 text-[11px] text-[var(--color-fg-mut)] hover:text-[var(--color-fg)]"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-relaxed">
        {html
          ? <code className={`hljs language-${grammar}`} style={{ background: "transparent", padding: 0 }} dangerouslySetInnerHTML={{ __html: html }} />
          : <code className="text-[var(--color-code-fg)]">{code}</code>}
      </pre>
    </div>
  );
}
