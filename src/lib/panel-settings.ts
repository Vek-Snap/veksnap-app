"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Panel visibility settings: the single source of truth for which system
// monitoring / control panels appear in the Modern-layout (studio-v2) right dock.
//
// A tiny reactive store (useSyncExternalStore + localStorage) so the settings
// dialog and the HardwareDock stay in sync live, and the choice persists across
// launches. SSR-safe: the server snapshot always returns the defaults (all on),
// and the client hydrates from localStorage on mount.
//
// This ONLY governs the Modern dock. The classic UI renders the same components
// with their defaults (every panel shown), because those components treat the
// `show` prop as optional and default each panel to visible.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

export type PanelId =
  | "monitors" // CPU / RAM / GPU / Disk usage graphs
  | "virtualMemory" // Windows commit charge + page file usage
  | "memoryReserve" // System Memory Reserve (OS RAM guard)
  | "flushActions" // Flush VRAM / Flush RAM / Refresh Node List
  | "gpuPowerLimit" // GPU power-limit slider
  | "safetyWatchdog" // GPU thermal safety watchdog
  | "systemLogs"; // Live ComfyUI / Vek-Snap log stream

export interface PanelDef {
  id: PanelId;
  label: string;
  group: "Monitors" | "Controls" | "Diagnostics";
  description: string;
}

// Order here is the order shown in the settings dialog.
export const PANEL_DEFS: PanelDef[] = [
  { id: "monitors", label: "Hardware Monitors", group: "Monitors", description: "Live CPU, RAM, GPU and disk usage graphs." },
  { id: "virtualMemory", label: "Virtual Memory", group: "Monitors", description: "Windows commit charge + page file usage, with per-drive detail." },
  { id: "memoryReserve", label: "System Memory Reserve", group: "Controls", description: "Hard OS-level RAM guard that keeps the system responsive during generation." },
  { id: "flushActions", label: "Flush & Refresh", group: "Controls", description: "Flush VRAM / Flush RAM buttons and the Refresh Node List action." },
  { id: "gpuPowerLimit", label: "GPU Power Limit", group: "Controls", description: "Slider to cap GPU wattage (reduces heat; requires Administrator)." },
  { id: "safetyWatchdog", label: "Safety Watchdog", group: "Controls", description: "Auto-interrupts renders when the GPU stays above a temperature threshold." },
  { id: "systemLogs", label: "System Logs", group: "Diagnostics", description: "Live ComfyUI and Vek-Snap log stream." },
];

export type PanelVisibility = Record<PanelId, boolean>;

const STORE_KEY = "veksnap:panels";

function makeDefaults(): PanelVisibility {
  return PANEL_DEFS.reduce((acc, def) => {
    acc[def.id] = true;
    return acc;
  }, {} as PanelVisibility);
}

const DEFAULTS: PanelVisibility = makeDefaults();

// ── Internal reactive state ──
let state: PanelVisibility = DEFAULTS;
let hydrated = false;
const listeners = new Set<() => void>();

function read(): PanelVisibility {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return makeDefaults();
    const parsed = JSON.parse(raw) as Partial<PanelVisibility>;
    // Merge over defaults so newly-added panels default to visible.
    return { ...makeDefaults(), ...parsed };
  } catch {
    return makeDefaults();
  }
}

function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  state = read();
  hydrated = true;
  // Keep multiple windows / the same window in sync across tabs.
  window.addEventListener("storage", (e) => {
    if (e.key === STORE_KEY) {
      state = read();
      emit();
    }
  });
}

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  ensureHydrated();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): PanelVisibility {
  ensureHydrated();
  return state;
}

function getServerSnapshot(): PanelVisibility {
  return DEFAULTS;
}

// ── Public mutators ──

export function setPanelVisible(id: PanelId, visible: boolean): void {
  ensureHydrated();
  const next = { ...state, [id]: visible };
  state = next;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  emit();
}

export function resetPanels(): void {
  ensureHydrated();
  state = makeDefaults();
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  emit();
}

// ── React hook ──

/** Subscribe to the live panel-visibility map. Re-renders on any change. */
export function usePanelSettings(): PanelVisibility {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
