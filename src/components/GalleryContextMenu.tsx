"use client";

// ── Shared gallery right-click menu (Studio v2 image studios) ─────────────────
// Pure presentational menu used by every image studio so the context actions are
// identical everywhere. Acts on the whole selection if the right-clicked image is
// part of it, otherwise on just that image (the caller decides `targets`).

import { Eraser, Trash2, Clapperboard, Dices } from "lucide-react";
import type { GalleryMenuState } from "@/lib/use-gallery-actions";

export default function GalleryContextMenu({
  menu,
  onClose,
  onClearFromPanel,
  onDeleteFromDisk,
  onSendToTimeline,
  onUseSeed,
  seedValue,
}: {
  menu: GalleryMenuState | null;
  onClose: () => void;
  onClearFromPanel: (targets: string[]) => void;
  onDeleteFromDisk: (targets: string[]) => void;
  onSendToTimeline: (targets: string[]) => void;
  // Optional "Use Same Seed" action, only shown for a single right-clicked
  // image that carries a numeric seed. Copies that seed into the studio's
  // Workflow Controls and turns random off (the studio owns the actual apply).
  onUseSeed?: () => void;
  seedValue?: number | null;
}) {
  if (!menu) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        className="fixed z-[61] min-w-[196px] rounded-md border border-border bg-popover text-popover-foreground shadow-xl py-1 text-sm"
        style={{ left: menu.x, top: menu.y }}
      >
        <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {menu.targets.length > 1 ? `${menu.targets.length} images` : "1 image"}
        </div>
        {onUseSeed && seedValue != null && (
          <button
            type="button"
            onClick={() => { onUseSeed(); onClose(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-foreground/10 text-left"
          >
            <Dices className="w-4 h-4 text-sky-400" /> Use Same Seed
            <span className="ml-auto font-mono text-[11px] text-sky-400/80">{seedValue}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => { onClearFromPanel(menu.targets); onClose(); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-foreground/10 text-left"
        >
          <Eraser className="w-4 h-4 text-muted-foreground" /> Clear from Work Panel
        </button>
        <button
          type="button"
          onClick={() => { const t = menu.targets; onClose(); onDeleteFromDisk(t); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-500/10 text-left text-rose-400"
        >
          <Trash2 className="w-4 h-4" /> Delete from Disk
        </button>
        <button
          type="button"
          onClick={() => { const t = menu.targets; onClose(); void onSendToTimeline(t); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-foreground/10 text-left"
        >
          <Clapperboard className="w-4 h-4 text-violet-400" /> Send to Timeline Bin
        </button>
      </div>
    </>
  );
}
