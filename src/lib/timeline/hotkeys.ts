// ─────────────────────────────────────────────────────────────────────────────
// Timeline keyboard shortcuts: a small, user-remappable registry.
//
// Bindings are canonical strings built from a KeyboardEvent: modifier order is
// fixed (Ctrl→Alt→Shift→Meta) then the key, e.g. "Ctrl+Shift+Z", "Delete",
// "Space", "[". User overrides persist to localStorage; any action the user
// hasn't remapped falls back to its default. The storage key is brand-neutral so
// this module stays byte-identical across app editions.
// ─────────────────────────────────────────────────────────────────────────────

export type HotkeyActionId =
  | "playPause"
  | "selectAll"
  | "delete"
  | "rippleDelete"
  | "undo"
  | "redo"
  | "copy"
  | "cut"
  | "paste"
  | "duplicate"
  | "bladeAll"
  | "toggleSnap"
  | "addMarker"
  | "prevMarker"
  | "nextMarker";

export type HotkeyCategory = "Playback" | "Edit" | "Selection" | "Markers" | "Tools";

export interface HotkeyDef {
  id: HotkeyActionId;
  label: string;
  category: HotkeyCategory;
  defaultBinding: string;
}

// The remappable actions. Navigation (arrow nudge/step) stays fixed and is not
// listed here: those are conventional and dual-purpose (clip nudge vs playhead).
export const HOTKEY_DEFS: readonly HotkeyDef[] = [
  { id: "playPause", label: "Play / Pause", category: "Playback", defaultBinding: "Space" },
  { id: "selectAll", label: "Select all clips", category: "Selection", defaultBinding: "Ctrl+A" },
  { id: "delete", label: "Delete selected", category: "Edit", defaultBinding: "Delete" },
  { id: "rippleDelete", label: "Ripple delete (close gap)", category: "Edit", defaultBinding: "Shift+Delete" },
  { id: "undo", label: "Undo", category: "Edit", defaultBinding: "Ctrl+Z" },
  { id: "redo", label: "Redo", category: "Edit", defaultBinding: "Ctrl+Shift+Z" },
  { id: "copy", label: "Copy", category: "Edit", defaultBinding: "Ctrl+C" },
  { id: "cut", label: "Cut", category: "Edit", defaultBinding: "Ctrl+X" },
  { id: "paste", label: "Paste", category: "Edit", defaultBinding: "Ctrl+V" },
  { id: "duplicate", label: "Duplicate", category: "Edit", defaultBinding: "Ctrl+D" },
  { id: "bladeAll", label: "Blade all at playhead", category: "Tools", defaultBinding: "Ctrl+B" },
  { id: "toggleSnap", label: "Toggle snapping", category: "Tools", defaultBinding: "N" },
  { id: "addMarker", label: "Add marker at playhead", category: "Markers", defaultBinding: "M" },
  { id: "prevMarker", label: "Jump to previous marker", category: "Markers", defaultBinding: "[" },
  { id: "nextMarker", label: "Jump to next marker", category: "Markers", defaultBinding: "]" },
] as const;

export type HotkeyMap = Record<HotkeyActionId, string>;

const STORAGE_KEY = "timeline.hotkeys.v1";

export function defaultBindings(): HotkeyMap {
  const m = {} as HotkeyMap;
  for (const d of HOTKEY_DEFS) m[d.id] = d.defaultBinding;
  return m;
}

export function loadBindings(): HotkeyMap {
  const base = defaultBindings();
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<HotkeyMap>;
      for (const d of HOTKEY_DEFS) {
        const v = saved[d.id];
        if (typeof v === "string" && v) base[d.id] = v;
      }
    }
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return base;
}

export function saveBindings(map: HotkeyMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore full / unavailable storage */
  }
}

/**
 * Canonical binding string for a keyboard event. Returns "" for a lone modifier
 * press (so recording a shortcut ignores the user first pressing Ctrl/Shift).
 */
export function bindingFromEvent(e: KeyboardEvent | React.KeyboardEvent): string {
  const k = e.key;
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return "";
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  let key = k;
  if (k === " ") key = "Space";
  else if (k.length === 1) key = k.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

/** The action (if any) a keyboard event triggers under the given bindings. */
export function matchAction(e: KeyboardEvent, bindings: HotkeyMap): HotkeyActionId | null {
  const b = bindingFromEvent(e);
  if (!b) return null;
  for (const d of HOTKEY_DEFS) {
    if (bindings[d.id] === b) return d.id;
  }
  return null;
}

/** The action currently bound to `binding`, excluding `id` (for conflict UX). */
export function findConflict(map: HotkeyMap, id: HotkeyActionId, binding: string): HotkeyActionId | null {
  for (const d of HOTKEY_DEFS) {
    if (d.id !== id && map[d.id] === binding) return d.id;
  }
  return null;
}
