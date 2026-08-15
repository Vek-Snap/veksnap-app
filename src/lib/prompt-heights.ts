"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Persistent prompt-textarea heights.
//
// Users drag-resize prompt <textarea>s all over the app (especially the 30+
// per-segment prompts in the Continuum/Director view). Native resize only sets
// an inline style.height that is lost on reload. This tiny store remembers each
// resizable field's height by a stable id, so:
//   • heights survive reloads (cached in localStorage), and
//   • heights ride *inside* the save-state snapshot (page.tsx folds
//     getAllPromptHeights() into the snapshot and calls applyPromptHeights() on
//     load), so saving/loading a state restores every prompt's size.
//
// Fields opt in via a `persistId` (see usePersistentTextareaHeight below). It is
// a no-op for any textarea that doesn't pass one.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef } from "react";

const STORAGE_KEY = "veksnap-prompt-heights";

export type PromptHeights = Record<string, number>;

let heights: PromptHeights = loadInitial();
const subscribers = new Map<string, Set<(h: number) => void>>();

function loadInitial(): PromptHeights {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function sanitize(map: unknown): PromptHeights {
  const out: PromptHeights = {};
  if (map && typeof map === "object") {
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "number" && Number.isFinite(v) && v > 0) {
        out[k] = Math.round(v);
      }
    }
  }
  return out;
}

function persist(): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(heights)); } catch { /* full/unavailable */ }
}

/** Current height for a field, or undefined if never resized. */
export function getPromptHeight(id: string): number | undefined {
  return heights[id];
}

/** A copy of the whole map, folded into the save-state snapshot. */
export function getAllPromptHeights(): PromptHeights {
  return { ...heights };
}

/** Record a field's height (from a user resize). Notifies subscribers. */
export function setPromptHeight(id: string, height: number): void {
  if (!id || !Number.isFinite(height) || height <= 0) return;
  const rounded = Math.round(height);
  if (heights[id] === rounded) return;
  heights[id] = rounded;
  persist();
  subscribers.get(id)?.forEach((fn) => fn(rounded));
}

/** Merge a saved map back in (on load-state) and push updates to mounted fields. */
export function applyPromptHeights(map: PromptHeights | undefined | null): void {
  const clean = sanitize(map);
  if (Object.keys(clean).length === 0) return;
  heights = { ...heights, ...clean };
  persist();
  for (const [id, h] of Object.entries(clean)) {
    subscribers.get(id)?.forEach((fn) => fn(h));
  }
}

function subscribe(id: string, fn: (h: number) => void): () => void {
  let set = subscribers.get(id);
  if (!set) { set = new Set(); subscribers.set(id, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) subscribers.delete(id);
  };
}

/**
 * Ref callback for a resizable <textarea> that persists its drag-resized height
 * under `persistId`. On attach it applies any stored height; a `mouseup` on the
 * element records the (possibly just-dragged) height; and it subscribes so a
 * load-state can push a new height in live. Passing no id makes it inert.
 */
export function usePersistentTextareaHeight(persistId?: string) {
  const elRef = useRef<HTMLTextAreaElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const applyStored = useCallback(() => {
    const el = elRef.current;
    if (!el || !persistId) return;
    const stored = getPromptHeight(persistId);
    if (stored) el.style.height = `${stored}px`;
  }, [persistId]);

  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    // Detach any previous element's listener.
    cleanupRef.current?.();
    cleanupRef.current = null;
    elRef.current = el;
    if (!el || !persistId) return;

    applyStored();
    const onMouseUp = () => setPromptHeight(persistId, el.offsetHeight);
    el.addEventListener("mouseup", onMouseUp);
    cleanupRef.current = () => el.removeEventListener("mouseup", onMouseUp);
  }, [persistId, applyStored]);

  // Live updates from a load-state while this field is mounted.
  useEffect(() => {
    if (!persistId) return;
    const unsub = subscribe(persistId, (h) => {
      if (elRef.current) elRef.current.style.height = `${h}px`;
    });
    return () => { unsub(); cleanupRef.current?.(); };
  }, [persistId]);

  return setRef;
}
