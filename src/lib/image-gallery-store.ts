"use client";

// ── Shared Image Gallery store (Studio v2) ────────────────────────────────────
// A single module-level pool of gallery images shared by every image sub-studio
// (SDXL/SD1.5/Pony, Z-Image Turbo, Re-Imagine). Because it lives at module scope
// and is exposed via useSyncExternalStore, the gallery, and its view settings
// (columns / details): stay identical and persistent when the user switches
// between the three image studios (which remount on tab change). A full page
// reload starts fresh.

import { useSyncExternalStore } from "react";

export interface GalleryImage {
  url: string;
  filename: string;
  subfolder: string;
  type: string;
  /** Provenance metadata for the Details view. loras is optional, Re-Imagine
   *  outputs don't carry a LoRA list, plain SDXL/Z-Image outputs do. */
  meta?: { seed: number; model: string; loras?: { name: string; strength: number }[] };
  /** True for user-loaded images (via Import / folder) rather than generated. */
  imported?: boolean;
  /** Absolute on-disk path of an imported file (Electron exposes File.path). */
  srcPath?: string;
}

// Max thumbnails kept in the gallery (generated + upscaled + imported).
export const GALLERY_MAX = 200;
// Recognised still-image extensions for folder/file import (Electron/browser).
export const IMAGE_IMPORT_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;

type Dispatch<T> = T | ((prev: T) => T);
function resolve<T>(action: Dispatch<T>, prev: T): T {
  return typeof action === "function" ? (action as (p: T) => T)(prev) : action;
}

// Stable identity for a gallery image, independent of its position in the pool.
// Selection is keyed by this (not by array index) so a selection stays locked to
// the exact image the user picked even when a new generation is prepended, an
// item is imported, or the list is reordered. Imported files key off their
// absolute on-disk path; rendered outputs key off type/subfolder/filename; the
// blob URL is the last-resort fallback for anything without a filename.
export function galleryKey(img: GalleryImage): string {
  if (img.srcPath) return `path:${img.srcPath}`;
  if (img.filename) return `out:${img.type}|${img.subfolder}|${img.filename}`;
  return `url:${img.url}`;
}

interface GalleryState {
  results: GalleryImage[];
  cols: number;
  details: boolean;
}

let state: GalleryState = { results: [], cols: 3, details: false };
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

export function setGalleryResults(action: Dispatch<GalleryImage[]>) {
  const next = resolve(action, state.results);
  if (next === state.results) return;
  state = { ...state, results: next };
  emit();
}

/** Move a gallery item from one index to another (drag-to-reorder). */
export function moveGalleryItem(from: number, to: number) {
  const arr = state.results;
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  state = { ...state, results: next };
  emit();
}

// ── Drag-and-drop payload contract ────────────────────────────────────────────
// Two custom MIME types travel on a gallery-item drag: one carries the item index
// for intra-gallery reordering, the other carries the image descriptor so it can
// be dropped onto a workflow input field (e.g. Re-Imagine source) in any studio.
export const GALLERY_DND_REORDER = "application/x-veksnap-gallery-index";
export const GALLERY_DND_IMAGE = "application/x-veksnap-gallery-image";

/** Read a dropped gallery image descriptor from a DataTransfer, if present. */
export function parseGalleryDragImage(dt: DataTransfer | null): GalleryImage | null {
  if (!dt) return null;
  const raw = dt.getData(GALLERY_DND_IMAGE);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<GalleryImage>;
    if (!obj || typeof obj.url !== "string") return null;
    return {
      url: obj.url,
      filename: obj.filename ?? "image.png",
      subfolder: obj.subfolder ?? "",
      type: obj.type ?? "output",
      imported: obj.imported,
      srcPath: obj.srcPath,
      meta: obj.meta,
    };
  } catch { return null; }
}

/** Fetch a gallery image (http or blob URL) into a File for re-upload. */
export async function galleryImageToFile(img: GalleryImage): Promise<File> {
  const res = await fetch(img.url);
  const blob = await res.blob();
  const name = img.filename || "image.png";
  return new File([blob], name, { type: blob.type || "image/png" });
}
export function setGalleryCols(action: Dispatch<number>) {
  const next = resolve(action, state.cols);
  if (next === state.cols) return;
  state = { ...state, cols: next };
  emit();
}
export function setGalleryDetails(action: Dispatch<boolean>) {
  const next = resolve(action, state.details);
  if (next === state.details) return;
  state = { ...state, details: next };
  emit();
}

/** Shared results pool. Setter matches React's dispatch signature so existing
 *  `setResults(prev => ...)` call-sites work unchanged. */
export function useGalleryResults(): [GalleryImage[], (action: Dispatch<GalleryImage[]>) => void] {
  const results = useSyncExternalStore(subscribe, () => state.results, () => state.results);
  return [results, setGalleryResults];
}

/** Shared gallery view settings (columns + details toggle). */
export function useGalleryView() {
  const cols = useSyncExternalStore(subscribe, () => state.cols, () => state.cols);
  const details = useSyncExternalStore(subscribe, () => state.details, () => state.details);
  return { cols, setCols: setGalleryCols, details, setDetails: setGalleryDetails };
}

/** Free a blob: object-URL created for an imported image (no-op for http URLs). */
export function revokeIfBlob(url: string) {
  if (url.startsWith("blob:")) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
}

/** Turn a picked FileList (files or a folder) into importable gallery entries. */
export function makeImportedImages(fileList: FileList | null): GalleryImage[] {
  const files = Array.from(fileList ?? []).filter((f) => f.type.startsWith("image/") || IMAGE_IMPORT_RE.test(f.name));
  return files.map((f) => ({
    url: URL.createObjectURL(f),
    filename: f.name,
    subfolder: "",
    type: "imported",
    imported: true,
    srcPath: (f as unknown as { path?: string }).path || undefined,
  }));
}
