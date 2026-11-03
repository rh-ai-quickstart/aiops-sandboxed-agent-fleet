"use client";
import { useCallback, useSyncExternalStore } from "react";

// Tiny localStorage-backed external store for UI preferences (theme, panel state, the last
// Incident Lab investigation). Read through useSyncExternalStore: the server snapshot is the
// fallback and the client snapshot the stored value, so hydration never mismatches and no
// component needs a setState-in-effect to "load" its preference after mount. Values are mirrored
// in memory, so it also works when localStorage is unavailable (private mode, quota).

const mem = new Map<string, string>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => { if (e.key && mem.has(e.key)) { mem.delete(e.key); l(); } };
  window.addEventListener("storage", onStorage); // other tabs
  return () => { listeners.delete(l); window.removeEventListener("storage", onStorage); };
};

/** Current value of `key` (client only). */
export function readStored(key: string, fallback: string): string {
  if (!mem.has(key)) {
    let v: string | null = null;
    try { v = window.localStorage.getItem(key); } catch { /* unavailable */ }
    mem.set(key, v ?? fallback);
  }
  return mem.get(key)!;
}

export function writeStored(key: string, value: string) {
  mem.set(key, value);
  try { window.localStorage.setItem(key, value); } catch { /* unavailable */ }
  notify();
}

export function removeStored(key: string, fallback: string) {
  mem.set(key, fallback);
  try { window.localStorage.removeItem(key); } catch { /* unavailable */ }
  notify();
}

/** `[value, setValue]` for a string preference persisted under `key`. */
export function useStoredString(key: string, fallback: string): [string, (v: string) => void] {
  const value = useSyncExternalStore(subscribe, () => readStored(key, fallback), () => fallback);
  const set = useCallback((v: string) => writeStored(key, v), [key]);
  return [value, set];
}

const noopSubscribe = () => () => {};
/** true after hydration on the client, false during SSR and the hydration render. */
export function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}
