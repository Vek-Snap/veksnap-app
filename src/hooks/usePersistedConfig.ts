"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Persistence hooks for the studio-v2 shell.
//
// Two complementary tools:
//   • usePersistentState: SSR-safe localStorage-backed state for small UI prefs
//     (image sizes, collapse toggles, hide flags). Writes immediately; syncs
//     across tabs/windows and same-tab consumers.
//   • usePersistedConfig: hydrate-once + debounced-write persistence for large
//     work-in-progress configs (DirectorConfig, LTX2Config, …). Keeps configs
//     safe across full reloads/reopens so users never lose partial work.
//
// Privacy/correctness note: blob: object-URLs (image/audio previews) are session
// -scoped and invalid after reload, so callers should strip them on write (see
// stripBlobUrls) and reconstruct previews from persisted ComfyUI filenames on
// hydrate. We never persist ephemeral runtime URLs verbatim.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

// ── Same-tab change notification registry (native `storage` fires only in OTHER tabs) ──
const listeners = new Map<string, Set<() => void>>();
function emit(key: string) {
  listeners.get(key)?.forEach((cb) => cb());
}

/**
 * SSR-safe localStorage-backed state. The server snapshot returns `null` (→
 * fallback) so the first client render matches SSR (no hydration mismatch); the
 * stored value is adopted immediately after hydration. Values are JSON-encoded.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) cb();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.get(key)?.delete(cb);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);

  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const value = useMemo<T>(() => {
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }, [raw, fallback]);

  const setValue = useCallback(
    (v: T | ((prev: T) => T)) => {
      try {
        let prev: T = fallback;
        const cur = localStorage.getItem(key);
        if (cur != null) {
          try {
            prev = JSON.parse(cur) as T;
          } catch {
            /* keep fallback */
          }
        }
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        localStorage.setItem(key, JSON.stringify(next));
        emit(key);
      } catch {
        /* localStorage unavailable */
      }
    },
    [key, fallback],
  );

  return [value, setValue];
}

/** Deep-clone `obj`, replacing any `blob:` object-URL string with "" - those URLs
 *  are session-scoped and useless after a reload. */
export function stripBlobUrls<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === "string" && v.startsWith("blob:") ? "" : v)),
  ) as T;
}

interface PersistedConfigOptions<T> {
  /** Transform the value before writing (e.g. strip blob URLs). */
  sanitize?: (value: T) => T;
  /** Transform the parsed value on hydrate (e.g. reconstruct previews from filenames). */
  hydrate?: (parsed: T, current: T) => T;
  /** Debounce for the write, ms (default 500). */
  debounceMs?: number;
}

/**
 * Hydrate-once + debounced-write persistence for a large config held in the
 * parent's `useState`. On mount it restores from localStorage (through the
 * optional `hydrate` transform); thereafter it writes debounced snapshots
 * (through the optional `sanitize` transform). No-op until hydrated so the
 * initial defaults never clobber a saved config.
 */
export function usePersistedConfig<T>(
  key: string,
  value: T,
  setValue: (v: T) => void,
  opts?: PersistedConfigOptions<T>,
): void {
  const hydratedRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;

  // Hydrate once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        const merged = optsRef.current?.hydrate
          ? optsRef.current.hydrate(parsed, value)
          : parsed;
        setValueRef.current(merged);
      }
    } catch {
      /* corrupt/unavailable: keep defaults */
    }
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Debounced persist on change (after hydration).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const ms = optsRef.current?.debounceMs ?? 500;
    const t = setTimeout(() => {
      try {
        const out = optsRef.current?.sanitize ? optsRef.current.sanitize(value) : value;
        localStorage.setItem(key, JSON.stringify(out));
      } catch {
        /* localStorage full/unavailable */
      }
    }, ms);
    return () => clearTimeout(t);
  }, [key, value]);
}
