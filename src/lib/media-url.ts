// Client-safe helpers describing a preview media item and how to fetch it from
// the sandboxed model-preview route. No fs here, shared by the Library UI.

export interface GalleryMedia {
  path: string;
  kind: "image" | "video";
  label?: string;
}

/** Stream URL for a preview image or clip (served by /api/model-preview). */
export function mediaPreviewUrl(p: string): string {
  return `/api/model-preview?path=${encodeURIComponent(p)}`;
}

/** Key model traits surfaced on the card "Details" overlay. */
export interface ModelDetails {
  /** On-disk size of the model file itself, in bytes (0 = unknown). */
  sizeBytes: number;
  /** File modified time, epoch ms (0 = unknown), used for "Newest" sort. */
  mtimeMs: number;
  /** Persisted CivitAI link ids (0 = not linked). */
  civitaiVersionId: number;
  civitaiModelId: number;
  /** User category override from the sidecar ("" = fall back to auto-classification). */
  category: string;
  /** Privacy Control flag from the sidecar. */
  mosaic: boolean;
  /** Favorite flag from the sidecar. */
  favorite: boolean;
}

/** Human-readable byte size, e.g. 1536 → "1.5 KB", 2_000_000_000 → "1.86 GB". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
