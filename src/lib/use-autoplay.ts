"use client";

import { useState, useEffect, useCallback } from "react";

const AUTOPLAY_KEY = "veksnap-autoplay";

/** Shared hook for the global autoplay preference. Default: OFF. */
export function useAutoplay(): [boolean, (v: boolean) => void] {
  const [autoplay, setAutoplayRaw] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOPLAY_KEY);
      if (saved === "true") setAutoplayRaw(true);
    } catch {}
  }, []);

  const setAutoplay = useCallback((v: boolean) => {
    setAutoplayRaw(v);
    try {
      localStorage.setItem(AUTOPLAY_KEY, String(v));
    } catch {}
    // Dispatch a storage event so other mounted instances of the hook sync
    window.dispatchEvent(new StorageEvent("storage", { key: AUTOPLAY_KEY, newValue: String(v) }));
  }, []);

  // Listen for cross-component sync
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === AUTOPLAY_KEY) {
        setAutoplayRaw(e.newValue === "true");
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return [autoplay, setAutoplay];
}
