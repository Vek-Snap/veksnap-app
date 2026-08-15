"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ImageLightbox: a reusable fullscreen image viewer with group cycling.
//
// Mirrors the Z-Image / Z-Turbo (OutputViewer) enlarge behavior: click a
// thumbnail to open; navigate the group with ← / → arrow keys or the on-screen
// chevrons; Esc or backdrop-click closes. Portals to <body> so it overlays the
// whole app regardless of where it's mounted. Purely presentational, the
// parent owns the images array and current index.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

export interface LightboxImage {
  url: string;
  label?: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
  onNavigate: (newIndex: number) => void;
}

export default function ImageLightbox({ images, index, onClose, onNavigate }: ImageLightboxProps) {
  const count = images.length;
  const current = images[index];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onNavigate(index > 0 ? index - 1 : count - 1);
      else if (e.key === "ArrowRight") onNavigate((index + 1) % count);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [index, count, onClose, onNavigate]);

  if (!current) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-black/90 flex items-center justify-center cursor-pointer"
      onClick={onClose}
    >
      {/* Close X sits top-CENTER (below the frameless shell's window controls),
          matching the Z-Image / OutputViewer enlarge viewer. */}
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

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current.url}
        alt={current.label ?? `Image ${index + 1}`}
        className="max-w-[95vw] max-h-[95vh] object-contain"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onClose}
      />

      {count > 1 && (
        <>
          <button
            type="button"
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            onClick={(e) => { e.stopPropagation(); onNavigate(index > 0 ? index - 1 : count - 1); }}
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
