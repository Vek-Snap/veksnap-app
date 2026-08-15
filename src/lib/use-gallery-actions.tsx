"use client";

// ── Shared gallery item actions (Studio v2 image studios) ─────────────────────
// Encapsulates the right-click menu behaviours that were originally only in the
// Z-Image studio: Clear from Work Panel, Delete from Disk, Send to Timeline Bin
// - so every image studio (SDXL/SD1.5/Pony, Z-Image, Re-Imagine) shares identical
// functionality against the single shared gallery pool. Also drives a destructive
// confirmation dialog and drag-to-reorder.

import { useCallback, useRef, useState, type Dispatch, type SetStateAction, type MouseEvent as ReactMouseEvent } from "react";
import { useToast } from "@/components/ToastProvider";
import { timelineStore } from "@/lib/timeline/store";
import { timelineId } from "@/lib/timeline/types";
import {
  setGalleryResults,
  moveGalleryItem,
  revokeIfBlob,
  galleryKey,
  type GalleryImage,
} from "@/lib/image-gallery-store";

// Selections and context-menu targets are carried as stable identity KEYS
// (galleryKey), never array indices, so an action always hits the exact image
// the user picked even after a new generation is prepended or the pool reorders.
export interface GalleryMenuState { x: number; y: number; targets: string[] }
export interface GalleryConfirmState { title: string; description: string; confirmLabel: string; onConfirm: () => void }

export function useGalleryActions(opts: {
  results: GalleryImage[];
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setLightbox: Dispatch<SetStateAction<number | null>>;
  fromStudio: string;
}) {
  const { results, selected, setSelected, setLightbox, fromStudio } = opts;
  const { toast } = useToast();
  const [menu, setMenu] = useState<GalleryMenuState | null>(null);
  const [confirmState, setConfirmState] = useState<GalleryConfirmState | null>(null);
  const outputDirRef = useRef<string | null>(null);

  const removeKeys = useCallback((keys: string[]) => {
    const drop = new Set(keys);
    setGalleryResults((prev) => {
      prev.forEach((r) => { if (drop.has(galleryKey(r))) revokeIfBlob(r.url); });
      return prev.filter((r) => !drop.has(galleryKey(r)));
    });
    setSelected(new Set());
    setLightbox(null);
  }, [setSelected, setLightbox]);

  const clearFromPanel = useCallback((keys: string[]) => { removeKeys(keys); }, [removeKeys]);

  const deleteFromDisk = useCallback((keys: string[]) => {
    const drop = new Set(keys);
    const chosen = results.filter((r) => drop.has(galleryKey(r)));
    if (chosen.length === 0) return;
    // Imported images point at the user's own files, never touch those on disk;
    // only rendered ComfyUI outputs are eligible for deletion.
    const files = chosen.filter((r) => !r.imported).map((r) => ({ filename: r.filename, subfolder: r.subfolder, type: r.type }));
    const mixed = files.length < chosen.length && files.length > 0;
    setConfirmState({
      title: `Delete ${chosen.length} item${chosen.length > 1 ? "s" : ""}?`,
      description: files.length === 0
        ? "These are imported images: they'll be removed from the gallery only. Your original files on disk are not touched."
        : mixed
          ? `${files.length} rendered file(s) will be permanently deleted from the ComfyUI output folder; imported images are only removed from the gallery. This cannot be undone.`
          : "This permanently removes the selected file(s) from your ComfyUI output folder. This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        if (files.length > 0) {
          try {
            const res = await fetch("/api/output/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files }) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.ok) toast(`Deleted ${data.deleted} file${data.deleted !== 1 ? "s" : ""} from disk`, "success");
            else toast("Some files could not be deleted", "warning");
          } catch { toast("Delete failed", "error"); }
        }
        removeKeys(keys);
      },
    });
  }, [results, removeKeys, toast]);

  const sendToTimeline = useCallback(async (keys: string[]) => {
    const pick = new Set(keys);
    const items = results.filter((r) => pick.has(galleryKey(r)));
    if (items.length === 0) return;
    try {
      const needsBase = items.some((it) => !it.srcPath);
      if (needsBase && outputDirRef.current === null) {
        const r = await fetch("/api/comfyui/base-dir");
        const d = await r.json().catch(() => ({}));
        outputDirRef.current = d?.outputDir ?? "";
      }
      const outDir = outputDirRef.current || "";
      for (const it of items) {
        const filePath = it.srcPath || [outDir, it.subfolder, it.filename].filter(Boolean).join("/");
        timelineStore.addAsset({ id: timelineId("asset"), kind: "image", name: it.filename, src: it.url, filePath, duration: 5, thumb: it.url, fromStudio });
      }
      toast(`Added ${items.length} image${items.length > 1 ? "s" : ""} to the Timeline media bin`, "success");
    } catch { toast("Could not add to timeline", "error"); }
  }, [results, toast, fromStudio]);

  const openMenu = useCallback((e: ReactMouseEvent, key: string) => {
    e.preventDefault();
    const targets = selected.has(key) && selected.size > 0 ? Array.from(selected) : [key];
    setMenu({ x: e.clientX, y: e.clientY, targets });
  }, [selected]);
  const closeMenu = useCallback(() => setMenu(null), []);

  const reorder = useCallback((from: number, to: number) => {
    moveGalleryItem(from, to);
    setSelected(new Set());
  }, [setSelected]);

  // On-demand presence check: prune gallery previews whose rendered file was
  // deleted or moved outside the app. Imported images point at the user's own
  // files and are intentionally never touched here.
  const [refreshing, setRefreshing] = useState(false);
  const refreshPresence = useCallback(async () => {
    const rendered = results.filter((r) => !r.imported && r.filename);
    if (rendered.length === 0) { toast("No rendered previews to check", "warning"); return; }
    setRefreshing(true);
    try {
      const res = await fetch("/api/output/exists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: rendered.map((r) => ({ filename: r.filename, subfolder: r.subfolder, type: r.type })) }),
      });
      const data = await res.json().catch(() => ({}));
      const missing: Array<{ filename: string; subfolder: string; type: string }> = data?.missing ?? [];
      if (missing.length === 0) { toast("All previews are up to date", "success"); return; }
      const missKeys = missing.map((m) => galleryKey({ url: "", filename: m.filename, subfolder: m.subfolder, type: m.type } as GalleryImage));
      removeKeys(missKeys);
      toast(`Removed ${missing.length} preview${missing.length > 1 ? "s" : ""} whose file is gone`, "success");
    } catch {
      toast("Could not refresh previews", "error");
    } finally {
      setRefreshing(false);
    }
  }, [results, removeKeys, toast]);

  return {
    menu, closeMenu, openMenu,
    confirmState, setConfirmState,
    removeKeys, clearFromPanel, deleteFromDisk, sendToTimeline, reorder,
    refreshPresence, refreshing,
  };
}
