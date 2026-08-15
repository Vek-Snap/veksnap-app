"use client";

import { useEffect, useRef, useCallback } from "react";

const AUTOSAVE_KEY = "veksnap-autosave";
const AUTOSAVE_TIMESTAMP_KEY = "veksnap-autosave-ts";
const CLEAN_EXIT_KEY = "veksnap-clean-exit";
const AUTOSAVE_INTERVAL = 60_000; // 60 seconds

/**
 * Auto-saves a snapshot of app state to localStorage every 60s.
 * On mount, checks if a recovery snapshot exists and returns it.
 */
export function useAutoSave(getSnapshot: () => Record<string, unknown>) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const snapshotRef = useRef(getSnapshot);
  snapshotRef.current = getSnapshot;

  const save = useCallback(() => {
    try {
      const snapshot = snapshotRef.current();
      const json = JSON.stringify(snapshot);
      localStorage.setItem(AUTOSAVE_KEY, json);
      localStorage.setItem(AUTOSAVE_TIMESTAMP_KEY, new Date().toISOString());
    } catch { /* localStorage full or unavailable */ }
  }, []);

  useEffect(() => {
    intervalRef.current = setInterval(save, AUTOSAVE_INTERVAL);
    // Save snapshot AND mark clean exit on beforeunload (normal close)
    const handleUnload = () => {
      save();
      try { localStorage.setItem(CLEAN_EXIT_KEY, "true"); } catch {}
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [save]);

  return { save };
}

/** Check if an auto-save recovery snapshot exists AND the previous session
 *  crashed (clean-exit flag is missing). Returns null on normal restarts.
 *  Idempotent: caches result so multiple calls in the same session are safe. */
let _recoveryResult: { snapshot: Record<string, unknown>; timestamp: string } | null | undefined;
export function getAutoSaveRecovery(): { snapshot: Record<string, unknown>; timestamp: string } | null {
  // Return cached result if already evaluated this session
  if (_recoveryResult !== undefined) return _recoveryResult;

  try {
    const exitFlag = localStorage.getItem(CLEAN_EXIT_KEY);
    // Clear the flag now, if we crash before the next beforeunload sets it,
    // the next launch will correctly detect a crash.
    localStorage.removeItem(CLEAN_EXIT_KEY);

    // "true" = clean exit → no recovery.
    // null = either first launch, or crash (flag removed on mount, then crash before beforeunload).
    // We distinguish by checking if autosave data exists (no data = first launch).
    // Also treat null as clean if the autosave timestamp is very old (>2 min before now)
    // to handle the code-upgrade transition where the flag was never set.
    if (exitFlag === "true") {
      _recoveryResult = null;
      return null;
    }

    const json = localStorage.getItem(AUTOSAVE_KEY);
    const ts = localStorage.getItem(AUTOSAVE_TIMESTAMP_KEY);
    if (json && ts) {
      // If the autosave is from this current session (within last 2 min), it's likely
      // a real crash. If it's older, it's probably stale data from before the clean-exit
      // flag was introduced: treat as clean.
      const ageMs = Date.now() - new Date(ts).getTime();
      if (exitFlag === null && ageMs > 120_000) {
        _recoveryResult = null;
        return null;
      }
      _recoveryResult = { snapshot: JSON.parse(json), timestamp: ts };
      return _recoveryResult;
    }
  } catch { /* corrupt */ }
  _recoveryResult = null;
  return null;
}

/** Clear the auto-save recovery snapshot (called after successful load or dismiss). */
export function clearAutoSaveRecovery() {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
    localStorage.removeItem(AUTOSAVE_TIMESTAMP_KEY);
  } catch {}
}

/** Mark the current session as cleanly exited (no recovery prompt on next launch). */
export function markCleanExit() {
  try { localStorage.setItem(CLEAN_EXIT_KEY, "true"); } catch {}
}
