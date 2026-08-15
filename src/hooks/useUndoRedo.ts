"use client";

import { useRef, useCallback, useEffect } from "react";

const MAX_HISTORY = 50;
const DEBOUNCE_MS = 800;

/**
 * Tracks a serializable state and provides undo/redo via Ctrl+Z / Ctrl+Shift+Z.
 * Uses JSON serialization to snapshot and compare states.
 */
export function useUndoRedo<T>(
  state: T,
  setState: (s: T) => void,
  /** Optional filter: only keys to track (reduces noise) */
  enabled = true,
) {
  const historyRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
  const lastSavedRef = useRef<string>("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUndoRedoRef = useRef(false);

  // Push state to history (debounced to avoid flooding on slider drags)
  useEffect(() => {
    if (!enabled) return;
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false;
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const json = JSON.stringify(state);
      if (json === lastSavedRef.current) return;

      // Push current state to history
      if (lastSavedRef.current) {
        historyRef.current = [...historyRef.current, lastSavedRef.current].slice(-MAX_HISTORY);
      }
      lastSavedRef.current = json;
      futureRef.current = []; // Clear redo stack on new change
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [state, enabled]);

  const undo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const current = JSON.stringify(state);
    futureRef.current = [current, ...futureRef.current];
    const prev = historyRef.current.pop()!;
    lastSavedRef.current = prev;
    isUndoRedoRef.current = true;
    setState(JSON.parse(prev));
  }, [state, setState]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const current = JSON.stringify(state);
    historyRef.current.push(current);
    const next = futureRef.current.shift()!;
    lastSavedRef.current = next;
    isUndoRedoRef.current = true;
    setState(JSON.parse(next));
  }, [state, setState]);

  // Global keyboard handler
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      // Don't intercept undo/redo in text inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;

      if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if (e.ctrlKey && ((e.key === "z" && e.shiftKey) || e.key === "y")) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo, enabled]);

  return { undo, redo, canUndo: historyRef.current.length > 0, canRedo: futureRef.current.length > 0 };
}
