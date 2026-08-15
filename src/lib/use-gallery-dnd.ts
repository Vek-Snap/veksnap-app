"use client";

// ── Shared gallery drag-and-drop (Studio v2 image studios) ────────────────────
// Provides three capabilities against the shared gallery, identical in every
// image studio:
//   1. OS drop: drag image files/folders from the desktop onto the gallery to
//      import them (delegates to the studio's importFiles).
//   2. Reorder: drag a gallery thumbnail onto another to reorder the pool.
//   3. Export: drag a gallery thumbnail onto a workflow input field (its
//      dragStart stamps the image descriptor so drop targets can consume it via
//      parseGalleryDragImage).

import { useCallback, useState, type DragEvent } from "react";
import {
  GALLERY_DND_IMAGE,
  GALLERY_DND_REORDER,
  parseGalleryDragImage,
  galleryImageToFile,
  type GalleryImage,
} from "@/lib/image-gallery-store";

export function useGalleryDnd(opts: {
  importFiles: (files: FileList | null) => void;
  reorder: (from: number, to: number) => void;
}) {
  const { importFiles, reorder } = opts;
  const [dragActive, setDragActive] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Whether a drag carries OS files (import) vs an internal gallery item.
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const hasReorder = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(GALLERY_DND_REORDER);

  const containerProps = {
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDragActive(true); }
    },
    onDragLeave: (e: DragEvent) => {
      // Only clear when leaving the container itself, not a child element.
      if (e.currentTarget === e.target) setDragActive(false);
    },
    onDrop: (e: DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault();
        importFiles(e.dataTransfer.files);
      }
      setDragActive(false);
      setDragOverIndex(null);
    },
  };

  const getItemProps = useCallback((index: number, image: GalleryImage) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData(GALLERY_DND_REORDER, String(index));
      e.dataTransfer.setData(GALLERY_DND_IMAGE, JSON.stringify(image));
    },
    onDragOver: (e: DragEvent) => {
      if (hasReorder(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverIndex(index); }
      else if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
    },
    onDragLeave: () => setDragOverIndex((cur) => (cur === index ? null : cur)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (hasFiles(e)) { importFiles(e.dataTransfer.files); }
      else {
        const raw = e.dataTransfer.getData(GALLERY_DND_REORDER);
        const from = raw === "" ? NaN : Number(raw);
        if (!Number.isNaN(from) && from !== index) reorder(from, index);
      }
      setDragActive(false);
      setDragOverIndex(null);
    },
  }), [importFiles, reorder]);

  return { dragActive, dragOverIndex, containerProps, getItemProps };
}

// ── Drop target for workflow input fields (single image) ──────────────────────
// Accepts either OS image files or a gallery thumbnail dragged from any studio,
// resolving both to a File handed to `onFile`. Returns hover state + drop props.
export function useImageDropTarget(onFile: (file: File) => void) {
  const [isOver, setIsOver] = useState(false);

  const accepts = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    return types.includes("Files") || types.includes(GALLERY_DND_IMAGE);
  };

  const dropProps = {
    onDragOver: (e: DragEvent) => { if (accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setIsOver(true); } },
    onDragLeave: (e: DragEvent) => { if (e.currentTarget === e.target) setIsOver(false); },
    onDrop: async (e: DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsOver(false);
      const osFile = e.dataTransfer.files?.[0];
      if (osFile) { onFile(osFile); return; }
      const img: GalleryImage | null = parseGalleryDragImage(e.dataTransfer);
      if (img) {
        try { onFile(await galleryImageToFile(img)); } catch { /* ignore fetch failure */ }
      }
    },
  };

  return { isOver, dropProps };
}
