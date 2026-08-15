"use client";

// Keyboard-shortcut editor for the timeline. Lists every remappable action
// grouped by category; click an action to "record" a new key combo (press Esc
// to cancel). Rebinding to a combo already in use swaps the two so nothing
// collides. "Reset all" restores the defaults. State is owned by the parent
// (TimelineEditorStudio), which persists it via the hotkeys module.

import { useEffect, useRef, useState } from "react";
import { RotateCcw, Keyboard } from "lucide-react";
import {
  HOTKEY_DEFS,
  defaultBindings,
  bindingFromEvent,
  findConflict,
  type HotkeyMap,
  type HotkeyActionId,
  type HotkeyCategory,
} from "@/lib/timeline/hotkeys";

const CATEGORY_ORDER: HotkeyCategory[] = ["Playback", "Selection", "Edit", "Tools", "Markers"];

function labelOf(id: HotkeyActionId): string {
  return HOTKEY_DEFS.find((d) => d.id === id)?.label ?? id;
}

export default function TimelineHotkeysEditor({
  bindings,
  onChange,
}: {
  bindings: HotkeyMap;
  onChange: (map: HotkeyMap) => void;
}) {
  const [recording, setRecording] = useState<HotkeyActionId | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const recRef = useRef<HotkeyActionId | null>(null);
  recRef.current = recording;

  // While recording, the next non-modifier keypress becomes the new binding.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setRecording(null); return; }
      const b = bindingFromEvent(e);
      if (!b) return; // lone modifier, keep waiting
      const id = recRef.current;
      if (!id) return;
      const conflict = findConflict(bindings, id, b);
      const next: HotkeyMap = { ...bindings, [id]: b };
      if (conflict) {
        // Swap so two actions never share one combo.
        next[conflict] = bindings[id];
        setWarn(`"${b}" was already "${labelOf(conflict)}": swapped their shortcuts.`);
      } else {
        setWarn(null);
      }
      onChange(next);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, bindings, onChange]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
          <Keyboard className="w-3.5 h-3.5 text-sky-300" /> Keyboard Shortcuts
        </span>
        <button
          type="button"
          onClick={() => { onChange(defaultBindings()); setWarn(null); setRecording(null); }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          title="Restore every shortcut to its default"
        >
          <RotateCcw className="w-3 h-3" /> Reset all
        </button>
      </div>

      {warn && <p className="text-[9px] text-amber-300/90">{warn}</p>}
      {recording && (
        <p className="text-[9px] text-sky-300/90">Press a key combination for &quot;{labelOf(recording)}&quot;… (Esc to cancel)</p>
      )}

      <div className="space-y-2">
        {CATEGORY_ORDER.map((cat) => {
          const defs = HOTKEY_DEFS.filter((d) => d.category === cat);
          if (defs.length === 0) return null;
          return (
            <div key={cat}>
              <div className="text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-0.5">{cat}</div>
              <div className="space-y-0.5">
                {defs.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 px-1 py-0.5 rounded hover:bg-foreground/5">
                    <span className="text-[10px] text-foreground/80 truncate">{d.label}</span>
                    <button
                      type="button"
                      onClick={() => { setRecording(d.id); setWarn(null); }}
                      className={`shrink-0 min-w-[72px] text-center px-2 py-0.5 rounded border text-[10px] font-mono ${
                        recording === d.id
                          ? "border-sky-400/70 bg-sky-500/20 text-sky-100 animate-pulse"
                          : "border-border/60 text-foreground/70 hover:bg-foreground/10"
                      }`}
                      title="Click, then press the new key combination"
                    >
                      {recording === d.id ? "Press…" : bindings[d.id]}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
