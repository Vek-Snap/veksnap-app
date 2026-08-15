"use client";

import { useState, useEffect, useCallback } from "react";

const UI_SCALE_KEY = "veksnap-ui-scale";

/** Accessibility: program-wide display scale. 1 = 100%. */
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.1;
export const UI_SCALE_DEFAULT = 1;

function clamp(v: number): number {
  if (!Number.isFinite(v)) return UI_SCALE_DEFAULT;
  const rounded = Math.round(v * 100) / 100;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, rounded));
}

/**
 * Applies the scale to the whole app. This is the accessibility "make everything
 * bigger" control, because the UI uses fixed-px type, a root font-size change
 * would not scale it, but zoom scales text, icons, and spacing together.
 *
 * In Electron we use `webFrame.setZoomFactor` (via preload): it rescales the
 * layout viewport so the fixed-size app shell reflows and nothing gets clipped.
 * In a plain browser (dev) build that API is absent, so we fall back to CSS
 * `zoom` on the document root, which still scales the whole tree (including
 * portals/dialogs mounted on <body>).
 */
function applyScale(scale: number): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const native = window.electronAPI?.setZoomFactor;
  if (native) {
    native(scale);
    // Ensure the two mechanisms never stack if a prior build applied CSS zoom.
    document.documentElement.style.removeProperty("zoom");
    return;
  }
  const root = document.documentElement;
  if (scale === 1) root.style.removeProperty("zoom");
  else root.style.zoom = String(scale);
}

/**
 * Shared hook for the global UI scale preference. Default: 100%.
 * Reading/writing is mirrored to localStorage and synced across every mounted
 * instance via a storage event, matching the autoplay/spellcheck hooks.
 */
export function useUiScale(): [number, (v: number) => void] {
  const [scale, setScaleRaw] = useState(UI_SCALE_DEFAULT);

  // Load persisted value and apply it on mount.
  useEffect(() => {
    try {
      const saved = parseFloat(localStorage.getItem(UI_SCALE_KEY) || "");
      const next = clamp(saved);
      setScaleRaw(next);
      applyScale(next);
    } catch {
      applyScale(UI_SCALE_DEFAULT);
    }
  }, []);

  const setScale = useCallback((v: number) => {
    const next = clamp(v);
    setScaleRaw(next);
    applyScale(next);
    try {
      localStorage.setItem(UI_SCALE_KEY, String(next));
    } catch {}
    // Keep other mounted instances (e.g. Settings menu vs. timeline toolbar) in sync.
    window.dispatchEvent(new StorageEvent("storage", { key: UI_SCALE_KEY, newValue: String(next) }));
  }, []);

  // Cross-component sync.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === UI_SCALE_KEY) {
        const next = clamp(parseFloat(e.newValue || ""));
        setScaleRaw(next);
        applyScale(next);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return [scale, setScale];
}
