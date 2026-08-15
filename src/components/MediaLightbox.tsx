"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MediaLightbox: a reusable fullscreen viewer for a group of preview media
// (images + clips). Click a thumbnail to open; ← / → or the on-screen chevrons
// navigate the group; Esc or backdrop-click closes. Videos use VekSnapVideo so
// the user gets full transport + sound + pop-out. Portals to <body>.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import VekSnapVideo from "@/components/VekSnapVideo";
import { mediaPreviewUrl, type GalleryMedia } from "@/lib/media-url";

export default function MediaLightbox({
  media,
  index,
  onClose,
  onNavigate,
}: {
  media: GalleryMedia[];
  index: number;
  onClose: () => void;
  onNavigate: (newIndex: number) => void;
}) {
  const count = media.length;
  const current = media[index];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onNavigate((index - 1 + count) % count);
      else if (e.key === "ArrowRight") onNavigate((index + 1) % count);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [index, count, onClose, onNavigate]);

  if (!current) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-black/90 flex items-center justify-center" onClick={onClose}>
      <button
        type="button"
        className="absolute top-16 left-1/2 -translate-x-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close (Esc)"
      >
        <X className="w-5 h-5 text-white" />
      </button>

      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <span className="text-[11px] font-mono px-2 py-1 rounded bg-white/10 text-white/70 border border-white/20">
          {index + 1} / {count}
        </span>
        {current.label && (
          <span className="text-[11px] px-2 py-1 rounded bg-white/10 text-white/80 border border-white/20 max-w-[40vw] truncate">
            {current.label}
          </span>
        )}
      </div>

      <div onClick={(e) => e.stopPropagation()} className="max-w-[95vw] max-h-[92vh] flex items-center justify-center">
        {current.kind === "video" ? (
          <VekSnapVideo
            src={mediaPreviewUrl(current.path)}
            autoPlay
            loop
            className="rounded-lg border border-white/10"
            style={{ maxWidth: "95vw", maxHeight: "92vh" }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaPreviewUrl(current.path)}
            alt={current.label ?? `preview ${index + 1}`}
            className="max-w-[95vw] max-h-[92vh] object-contain"
          />
        )}
      </div>

      {count > 1 && (
        <>
          <button
            type="button"
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            onClick={(e) => { e.stopPropagation(); onNavigate((index - 1 + count) % count); }}
            title="Previous (←)"
          >
            <ChevronLeft className="w-6 h-6 text-white" />
          </button>
          <button
            type="button"
            className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            onClick={(e) => { e.stopPropagation(); onNavigate((index + 1) % count); }}
            title="Next (→)"
          >
            <ChevronRight className="w-6 h-6 text-white" />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
