/**
 * Application Preferences (System / Performance / Safety)
 * ────────────────────────────────────────────────────────
 * These are MACHINE-SPECIFIC preferences, modelled after how professional NLEs
 * separate "System Preferences" from per-project settings:
 *
 *   • They are NOT part of a saved render/settings file (`veksnap_settings_*.json`)
 *     or the per-session auto-save snapshot, those carry the user's creative
 *     RENDER configuration, which is portable between machines.
 *   • They persist independently in their own localStorage key and have their own
 *     "Restore Defaults" action, so resetting hardware/safety prefs never touches
 *     the user's rendering setup (and vice-versa).
 *
 * Keep ONLY hardware/performance/safety knobs here (GPU safety watchdog, power,
 * memory, concurrency, …). Anything that affects the actual generated output
 * belongs in the render settings, not here.
 */

import { WatchdogConfig, DEFAULT_WATCHDOG_CONFIG } from "@/lib/gpu-watchdog";

const APP_PREFS_KEY = "saba-app-preferences";
const APP_PREFS_VERSION = 1;

export interface AppPreferences {
  /** GPU safety watchdog (temperature / power auto-interrupt). */
  watchdogConfig: WatchdogConfig;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  watchdogConfig: { ...DEFAULT_WATCHDOG_CONFIG },
};

/** Deep-ish merge of a partial saved blob onto the defaults so that newly-added
 *  preference fields always fall back to their default (forward compatible). */
function mergeWithDefaults(saved: Partial<AppPreferences> | null | undefined): AppPreferences {
  return {
    watchdogConfig: { ...DEFAULT_APP_PREFERENCES.watchdogConfig, ...(saved?.watchdogConfig ?? {}) },
  };
}

/** Load the system/performance/safety preferences from localStorage.
 *  Always returns a fully-populated object (defaults for anything missing). */
export function loadAppPreferences(): AppPreferences {
  if (typeof window === "undefined") return mergeWithDefaults(null);
  try {
    const raw = localStorage.getItem(APP_PREFS_KEY);
    if (!raw) return mergeWithDefaults(null);
    const parsed = JSON.parse(raw) as { version?: number; prefs?: Partial<AppPreferences> };
    return mergeWithDefaults(parsed?.prefs);
  } catch {
    return mergeWithDefaults(null);
  }
}

/** Persist the system/performance/safety preferences to localStorage. */
export function saveAppPreferences(prefs: AppPreferences): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(APP_PREFS_KEY, JSON.stringify({ version: APP_PREFS_VERSION, prefs }));
  } catch { /* localStorage full or unavailable */ }
}

/** Restore system/performance/safety preferences to their defaults and persist. */
export function resetAppPreferences(): AppPreferences {
  const defaults = mergeWithDefaults(null);
  saveAppPreferences(defaults);
  return defaults;
}
