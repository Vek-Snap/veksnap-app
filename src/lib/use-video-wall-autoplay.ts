"use client";

// ─────────────────────────────────────────────────────────────────────────────
// useVideoWallAutoplay: a smartphone-style "living gallery" cycler for the
// Library video wall. At any moment only a small number of video tiles play
// (default 2, max 3); every few seconds the active set advances to a different
// batch, spread across the grid so motion appears on different rows/columns.
//
// This is both a UX choice and a hard performance guardrail: decoding dozens of
// videos simultaneously would swamp the renderer, so we deliberately cap how
// many play at once. Preference is persisted and synced across mounts, mirroring
// use-autoplay.ts. Default: ON (this is the "wow" surface) but fully toggleable.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";

const KEY = "veksnap-videowall-autoplay";

export interface VideoWallConfig {
  /** Master switch. When off, no tile autoplays (hover/click still works). */
  enabled: boolean;
  /** How many tiles play at once (1–3). */
  concurrent: number;
  /** How long each batch holds before advancing (seconds). */
  seconds: number;
}

const DEFAULTS: VideoWallConfig = { enabled: true, concurrent: 2, seconds: 4 };

function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function loadConfig(): VideoWallConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return {
        enabled: o.enabled !== false,
        concurrent: clampInt(o.concurrent, 1, 3, DEFAULTS.concurrent),
        seconds: clampInt(o.seconds, 2, 15, DEFAULTS.seconds),
      };
    }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULTS };
}

/**
 * Drives the auto-cycling of playing video tiles.
 *
 * @param videoIndices Stable (memoized) list of tile indices that are videos.
 * @returns config + setter and an `isActive(index)` predicate for each tile.
 */
export function useVideoWallAutoplay(videoIndices: number[]) {
  const [config, setConfigRaw] = useState<VideoWallConfig>(DEFAULTS);
  const [active, setActive] = useState<Set<number>>(new Set());
  const cursorRef = useRef(0);

  // Load persisted preference on mount.
  useEffect(() => { setConfigRaw(loadConfig()); }, []);

  const setConfig = useCallback((patch: Partial<VideoWallConfig>) => {
    setConfigRaw((prev) => {
      const next: VideoWallConfig = {
        enabled: patch.enabled ?? prev.enabled,
        concurrent: clampInt(patch.concurrent ?? prev.concurrent, 1, 3, prev.concurrent),
        seconds: clampInt(patch.seconds ?? prev.seconds, 2, 15, prev.seconds),
      };
      try {
        const serialized = JSON.stringify(next);
        localStorage.setItem(KEY, serialized);
        window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: serialized }));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Cross-component / cross-window sync.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === KEY) setConfigRaw(loadConfig());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // The cycle itself. Re-arms whenever config or the video set changes.
  useEffect(() => {
    if (!config.enabled || videoIndices.length === 0) {
      setActive(new Set());
      return;
    }
    const n = Math.min(config.concurrent, videoIndices.length);
    // Stride jumps roughly a "screenful" apart so simultaneous plays land on
    // different rows rather than clustering in one corner.
    const stride = Math.max(1, Math.floor(videoIndices.length / n));

    const advance = () => {
      const chosen = new Set<number>();
      for (let k = 0; k < n; k++) {
        chosen.add(videoIndices[(cursorRef.current + k * stride) % videoIndices.length]);
      }
      cursorRef.current = (cursorRef.current + 1) % videoIndices.length;
      setActive(chosen);
    };

    advance();
    const id = window.setInterval(advance, Math.max(2, config.seconds) * 1000);
    return () => window.clearInterval(id);
  }, [config.enabled, config.concurrent, config.seconds, videoIndices]);

  const isActive = useCallback((index: number) => active.has(index), [active]);

  return { config, setConfig, isActive };
}
