"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ModelCard: a CivitAI-style catalog card for one model / LoRA.
//
// Shows that model's preview media as an inline mini-carousel: prev/next arrows
// + dot indicators to cycle between its images/clips, a type badge, and a name
// footer. Videos play only when the card is "active" (the parent's living-wall
// cycler spotlights it) or on hover, the same performance guardrail used across
// the wall. An expand button opens the shared fullscreen MediaLightbox.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Film, Play, Star, Check, Copy, HardDrive, FolderOpen, Trash2, Tag, EyeOff, ImageDown, ImagePlus, ChevronRight as ChevRight } from "lucide-react";
import { mediaPreviewUrl, formatBytes, type GalleryMedia, type ModelDetails } from "@/lib/media-url";
import type { LibraryCategory } from "@/lib/library-categories-types";
import MediaLightbox from "@/components/MediaLightbox";

export interface CardEntry {
  path: string;
  /** Display name (already basename-ed). */
  name: string;
  /** Colour-coded type badge. `color` (hex) overrides the tailwind classes for custom categories. */
  badge: { text: string; bg: string; label: string; color?: string };
  media: GalleryMedia[];
  favorite?: boolean;
  /** Privacy Control flag (obscure this card while the master toggle is on). */
  mosaic?: boolean;
}

/** Right-click card actions, dispatched to the Library which owns the endpoints. */
export type CardAction =
  | { type: "fetchPreview" }
  | { type: "assignCustom" }
  | { type: "openExplorer" }
  | { type: "setCategory"; category: string }
  | { type: "clearCategory" }
  | { type: "toggleMosaic" }
  | { type: "favorite" }
  | { type: "removeFromList" }
  | { type: "deleteFromDisk" };

/** A neon-blue, click-to-copy value chip (mirrors the Seed chip in the image UI). */
function CopyValue({ label, value, title }: { label: string; value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
      className="inline-flex items-center gap-1 rounded bg-sky-500/10 border border-sky-500/30 px-1.5 py-0.5 text-[9px] font-mono text-sky-300 hover:bg-sky-500/20 transition-colors"
    >
      <span className="text-sky-400/70">{label}</span>
      <span>{value}</span>
      {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5 opacity-60" />}
    </button>
  );
}

export default function ModelCard({
  entry,
  active,
  selected,
  onSelect,
  showDetails = false,
  details,
  categories = [],
  privacyOn = false,
  onAction,
}: {
  entry: CardEntry;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
  showDetails?: boolean;
  details?: ModelDetails;
  /** Available categories, for the "Set category" submenu. */
  categories?: LibraryCategory[];
  /** Master Privacy toggle, when on, mosaic-flagged cards are obscured. */
  privacyOn?: boolean;
  /** Dispatch a right-click action to the Library (which owns the endpoints). */
  onAction?: (action: CardAction) => void;
}) {
  const media = entry.media;
  const [idx, setIdx] = useState(0);
  const [hover, setHover] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [catSubOpen, setCatSubOpen] = useState(false);
  // Temporarily reveal an obscured card (click-to-peek); resets when Privacy re-applies.
  const [peek, setPeek] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const safeIdx = media.length ? Math.min(idx, media.length - 1) : 0;
  const cur = media.length ? media[safeIdx] : null;
  const obscured = privacyOn && !!entry.mosaic && !peek;
  const playVideo = cur?.kind === "video" && (active || hover) && !obscured;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playVideo) v.play().catch(() => {});
    else v.pause();
  }, [playVideo, safeIdx]);

  // Re-hide a peeked card whenever the master Privacy toggle turns back on.
  useEffect(() => { if (privacyOn) setPeek(false); }, [privacyOn]);

  // Close the context menu on any outside click / escape / scroll.
  useEffect(() => {
    if (!menu) return;
    const close = () => { setMenu(null); setCatSubOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const step = (delta: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setIdx((i) => (i + delta + media.length) % media.length);
  };

  const openMenu = (e: React.MouseEvent) => {
    if (!onAction) return;
    e.preventDefault();
    e.stopPropagation();
    // Clamp so the menu stays on-screen (menu is ~200px wide, ~260px tall).
    const x = Math.min(e.clientX, window.innerWidth - 210);
    const y = Math.min(e.clientY, window.innerHeight - 280);
    setMenu({ x, y });
    setCatSubOpen(false);
  };

  const act = (action: CardAction) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onAction?.(action);
    setMenu(null);
    setCatSubOpen(false);
  };

  return (
    <div
      onClick={obscured ? (e) => { e.stopPropagation(); setPeek(true); } : onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPeek(false); }}
      onContextMenu={openMenu}
      className={`group relative rounded-xl overflow-hidden border bg-card/40 cursor-pointer transition-all ${
        selected ? "border-sky-400/80 ring-2 ring-sky-400/40" : "border-border/50 hover:border-border"
      }`}
    >
      <div className={`relative aspect-[3/4] bg-muted/30 overflow-hidden ${obscured ? "[&>img]:blur-xl [&>video]:blur-xl" : ""}`}>
        {cur ? (
          cur.kind === "video" ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              ref={videoRef}
              src={mediaPreviewUrl(cur.path)}
              muted
              loop
              playsInline
              preload="metadata"
              className="w-full h-full object-cover"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaPreviewUrl(cur.path)} alt={entry.name} loading="lazy" className="w-full h-full object-cover" />
          )
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {/* No preview media yet, show a small, faint product mark instead of a
                stark grey placeholder icon. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/icon-light.png"
              alt="No preview available"
              className="w-14 h-14 object-contain opacity-20 select-none"
              draggable={false}
            />
          </div>
        )}

        {/* Type / category badge (top-left). Custom categories carry a hex colour. */}
        <span
          className={`absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[9px] font-semibold backdrop-blur-sm ${entry.badge.color ? "" : `${entry.badge.bg} ${entry.badge.text}`}`}
          style={entry.badge.color ? { backgroundColor: `${entry.badge.color}26`, color: entry.badge.color } : undefined}
        >
          {entry.badge.label}
        </span>

        {/* Privacy Control veil: obscured card shows a lock hint until clicked to peek. */}
        {obscured && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 bg-black/40 backdrop-blur-md text-white/80">
            <EyeOff className="w-6 h-6" />
            <span className="text-[9px]">Click to reveal</span>
          </div>
        )}

        {/* Favorite + clip markers (top-right cluster) */}
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          {entry.favorite && (
            <span className="rounded bg-black/50 p-0.5 text-amber-300"><Star className="w-3 h-3 fill-amber-300" /></span>
          )}
          {cur?.kind === "video" && (
            <span className="rounded bg-black/50 px-1 py-0.5 text-[9px] text-sky-200 inline-flex items-center gap-0.5"><Film className="w-2.5 h-2.5" /> clip</span>
          )}
          {media.length > 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLightbox(safeIdx); }}
              title="Enlarge"
              className="rounded bg-black/50 p-1 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Paused-video hint */}
        {cur?.kind === "video" && !playVideo && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Play className="w-8 h-8 text-white/70 drop-shadow" />
          </div>
        )}

        {/* Carousel arrows */}
        {media.length > 1 && (
          <>
            <button
              type="button"
              onClick={step(-1)}
              title="Previous"
              className="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/50 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={step(1)}
              title="Next"
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/50 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </>
        )}

        {/* Name footer */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pt-6 pb-1.5">
          <p className="text-[11px] font-medium text-white truncate" title={entry.name}>{entry.name}</p>
          {media.length > 1 && (
            <div className="flex items-center gap-1 mt-1">
              {media.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setIdx(i); }}
                  className={`h-1 rounded-full transition-all ${i === safeIdx ? "w-3 bg-white" : "w-1 bg-white/40 hover:bg-white/70"}`}
                  aria-label={`Go to media ${i + 1}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Details strip: file size + copyable neon CivitAI ids (opt-in) */}
      {showDetails && (
        <div className="flex flex-wrap items-center gap-1 border-t border-border/50 bg-card/60 px-2 py-1.5">
          <span className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground">
            <HardDrive className="w-2.5 h-2.5" />
            {formatBytes(details?.sizeBytes ?? 0)}
          </span>
          {details && details.civitaiVersionId > 0 && (
            <CopyValue label="v" value={`#${details.civitaiVersionId}`} title="CivitAI version id: click to copy" />
          )}
          {details && details.civitaiModelId > 0 && (
            <CopyValue label="m" value={`#${details.civitaiModelId}`} title="CivitAI model id: click to copy" />
          )}
        </div>
      )}

      {lightbox !== null && (
        <MediaLightbox
          media={media}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onNavigate={(i) => setLightbox(i)}
        />
      )}

      {/* Right-click context menu: fixed to the viewport at the cursor. */}
      {menu && onAction && (
        <div
          className="fixed z-50 w-52 rounded-lg border border-border/70 bg-popover/95 backdrop-blur-sm py-1 text-[11px] shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <MenuItem Icon={ImageDown} label={media.length ? "Refetch preview" : "Get preview"} onClick={act({ type: "fetchPreview" })} />
          <MenuItem Icon={ImagePlus} label="Assign custom media…" onClick={act({ type: "assignCustom" })} />
          <MenuItem Icon={Star} label={entry.favorite ? "Unfavorite" : "Favorite"} onClick={act({ type: "favorite" })} />
          <MenuItem Icon={FolderOpen} label="Open in Explorer" onClick={act({ type: "openExplorer" })} />
          <MenuItem Icon={EyeOff} label={entry.mosaic ? "Remove Privacy mask" : "Apply Privacy mask"} onClick={act({ type: "toggleMosaic" })} />

          {/* Set category ▸ submenu */}
          <div
            className="relative"
            onMouseEnter={() => setCatSubOpen(true)}
            onMouseLeave={() => setCatSubOpen(false)}
          >
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-foreground/10 text-left"
              onClick={(e) => { e.stopPropagation(); setCatSubOpen((v) => !v); }}
            >
              <Tag className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="flex-1">Set category</span>
              <ChevRight className="w-3 h-3 text-muted-foreground" />
            </button>
            {catSubOpen && (
              <div
                className="absolute left-full top-0 -ml-1 w-44 max-h-64 overflow-y-auto rounded-lg border border-border/70 bg-popover/95 backdrop-blur-sm py-1 shadow-xl"
              >
                <MenuItem label="Auto (clear override)" onClick={act({ type: "clearCategory" })} />
                {categories.length === 0 && (
                  <p className="px-2.5 py-1.5 text-[10px] text-muted-foreground/70">No custom categories yet.</p>
                )}
                {categories.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-foreground/10 text-left"
                    onClick={act({ type: "setCategory", category: c.name })}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="my-1 border-t border-border/50" />
          <MenuItem Icon={Trash2} label="Remove from list" onClick={act({ type: "removeFromList" })} />
          <MenuItem Icon={Trash2} label="Delete from disk…" danger onClick={act({ type: "deleteFromDisk" })} />
        </div>
      )}
    </div>
  );
}

/** One row in the card context menu. */
function MenuItem({ Icon, label, onClick, danger }: {
  Icon?: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-foreground/10 ${danger ? "text-red-400 hover:bg-red-500/10" : ""}`}
    >
      {Icon ? <Icon className={`w-3.5 h-3.5 ${danger ? "" : "text-muted-foreground"}`} /> : <span className="w-3.5" />}
      <span className="flex-1">{label}</span>
    </button>
  );
}
