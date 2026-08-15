"use client";

import { useState, useCallback, useRef } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
import {
  FileVideo,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Combine,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Download,
  GripVertical,
  Upload,
} from "lucide-react";
import { VideoSlot } from "@/components/media/MediaPlayer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface CombineItem {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
  /** Resolved ComfyUI path after upload */
  comfyPath?: string;
  meta?: { width: number; height: number; fps: number; duration: number };
  uploading?: boolean;
  error?: string;
}

async function uploadToComfyUI(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("image", file, file.name);
  formData.append("subfolder", "director_combine");
  formData.append("type", "input");
  const resp = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });
  if (!resp.ok) throw new Error("Upload failed");
  const data = await resp.json();
  return data.name || data.filename || file.name;
}

export default function SegmentCombiner() {
  const [autoplay] = useAutoplay();
  const [items, setItems] = useState<CombineItem[]>([]);
  const [combining, setCombining] = useState(false);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputMeta, setOutputMeta] = useState<{
    width: number; height: number; fps: number; duration: number; segmentCount: number; fileSize: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragIdRef = useRef<string | null>(null);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(f => f.type.startsWith("video/"));
    if (files.length === 0) return;

    const newItems: CombineItem[] = files.map(f => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      file: f,
      name: f.name,
      previewUrl: URL.createObjectURL(f),
      uploading: true,
    }));

    setItems(prev => [...prev, ...newItems]);

    // Upload each in parallel
    for (const item of newItems) {
      try {
        const comfyName = await uploadToComfyUI(item.file);
        // Probe metadata via a quick HEAD-style call, we'll validate on combine
        setItems(prev => prev.map(it =>
          it.id === item.id ? { ...it, uploading: false, comfyPath: comfyName } : it
        ));
      } catch (err) {
        setItems(prev => prev.map(it =>
          it.id === item.id ? { ...it, uploading: false, error: err instanceof Error ? err.message : "Upload failed" } : it
        ));
      }
    }
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems(prev => {
      const item = prev.find(it => it.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter(it => it.id !== id);
    });
  }, []);

  const moveItem = useCallback((id: string, direction: -1 | 1) => {
    setItems(prev => {
      const idx = prev.findIndex(it => it.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    });
  }, []);

  const handleDragStart = useCallback((id: string) => {
    dragIdRef.current = id;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragIdRef.current || dragIdRef.current === targetId) return;
    setItems(prev => {
      const fromIdx = prev.findIndex(it => it.id === dragIdRef.current);
      const toIdx = prev.findIndex(it => it.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const arr = [...prev];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
    // Update ref so subsequent dragover events use new position
    // (no need: findIndex uses current dragIdRef which stays the same)
  }, []);

  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null;
  }, []);

  const handleCombine = useCallback(async () => {
    const validItems = items.filter(it => it.comfyPath && !it.error);
    if (validItems.length < 2) return;

    setCombining(true);
    setError(null);
    setOutputUrl(null);
    setOutputMeta(null);

    try {
      // Build ComfyUI-style URLs from uploaded filenames
      const videoUrls = validItems.map(it =>
        `/api/comfyui/view?filename=${encodeURIComponent(it.comfyPath!)}&subfolder=director_combine&type=input`
      );

      const resp = await fetch("/api/director/combine-segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrls }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || "Combine failed");
        return;
      }

      setOutputUrl(data.outputUrl);
      setOutputMeta(data.meta || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Combine failed");
    } finally {
      setCombining(false);
    }
  }, [items]);

  const readyCount = items.filter(it => it.comfyPath && !it.error).length;
  const anyUploading = items.some(it => it.uploading);

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4">
      {/* Header */}
      <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3 space-y-3">
        <div className="flex items-center gap-2">
          <Combine className="w-4 h-4 text-teal-400" />
          <Label className="text-[11px] text-teal-400 font-medium">Segment Combiner</Label>
        </div>
        <p className="text-[9px] text-muted-foreground leading-relaxed">
          Drop pre-rendered video segments here to combine them into a single video.
          Drag to reorder. All segments must share the same resolution and frame rate.
          Audio tracks are preserved and concatenated.
        </p>

        {/* Drop zone / file picker */}
        <div
          className="relative rounded-lg border-2 border-dashed border-teal-500/30 bg-teal-500/5 hover:bg-teal-500/10 hover:border-teal-500/50 transition-colors p-6 text-center cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
        >
          <Upload className="w-6 h-6 text-teal-400/50 mx-auto mb-2" />
          <p className="text-[10px] text-teal-400/70 font-medium">
            Drop video files here or click to browse
          </p>
          <p className="text-[8px] text-muted-foreground/50 mt-1">
            MP4, WebM, MKV: any format FFmpeg supports
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* Segment list */}
      {items.length > 0 && (
        <div className="space-y-2">
          <Label className="text-[10px] text-muted-foreground font-medium">
            {items.length} segment{items.length !== 1 ? "s" : ""}, drag to reorder
          </Label>
          {items.map((item, idx) => (
            <div
              key={item.id}
              draggable
              onDragStart={() => handleDragStart(item.id)}
              onDragOver={(e) => handleDragOver(e, item.id)}
              onDragEnd={handleDragEnd}
              className={`rounded-lg border p-2 flex items-center gap-2 transition-colors min-w-0 ${
                item.error
                  ? "border-red-500/30 bg-red-500/5"
                  : item.uploading
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-teal-500/20 bg-teal-500/5 hover:bg-teal-500/10"
              }`}
            >
              {/* Drag handle */}
              <div className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground">
                <GripVertical className="w-3.5 h-3.5" />
              </div>

              {/* Index badge */}
              <span className="text-[10px] font-mono font-bold text-teal-400 w-5 text-center shrink-0">
                {idx + 1}
              </span>

              {/* Video thumbnail */}
              <video
                src={item.previewUrl}
                className="rounded border border-border/30 object-cover flex-none"
                style={{ width: 64, height: 40 }}
                muted
                preload="metadata"
              />

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-foreground truncate">{item.name}</p>
                {item.uploading && (
                  <p className="text-[8px] text-amber-400 flex items-center gap-1">
                    <Loader2 className="w-2.5 h-2.5 animate-spin" /> Uploading...
                  </p>
                )}
                {item.error && (
                  <p className="text-[8px] text-red-400 flex items-center gap-1">
                    <AlertTriangle className="w-2.5 h-2.5" /> {item.error}
                  </p>
                )}
                {item.comfyPath && !item.error && !item.uploading && (
                  <p className="text-[8px] text-teal-400/60 flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" /> Ready
                  </p>
                )}
              </div>

              {/* Move buttons */}
              <div className="flex flex-col gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => moveItem(item.id, -1)}
                  disabled={idx === 0}
                  className="p-0.5 text-muted-foreground/40 hover:text-muted-foreground disabled:opacity-30"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveItem(item.id, 1)}
                  disabled={idx === items.length - 1}
                  className="p-0.5 text-muted-foreground/40 hover:text-muted-foreground disabled:opacity-30"
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
              </div>

              {/* Remove */}
              <button
                type="button"
                onClick={() => removeItem(item.id)}
                className="p-1 text-red-400/40 hover:text-red-400 transition-colors shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          {/* Add more button */}
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-[10px] border-teal-500/30 text-teal-400 hover:bg-teal-500/10"
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus className="w-3 h-3 mr-1" /> Add More Segments
          </Button>
        </div>
      )}

      {/* Combine button */}
      {items.length >= 2 && (
        <Button
          size="sm"
          className="w-full bg-teal-600 hover:bg-teal-700 text-white"
          onClick={handleCombine}
          disabled={readyCount < 2 || anyUploading || combining}
        >
          {combining ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              Combining {readyCount} segments...
            </>
          ) : (
            <>
              <Combine className="w-3.5 h-3.5 mr-1.5" />
              Combine {readyCount} Segments
            </>
          )}
        </Button>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <p className="text-[10px] text-red-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </p>
        </div>
      )}

      {/* Output */}
      {outputUrl && (
        <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3 space-y-2">
          <p className="text-[11px] text-teal-400 font-medium flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> Combined Output
          </p>
          {outputMeta && (
            <p className="text-[9px] text-muted-foreground font-mono">
              {outputMeta.width}×{outputMeta.height} · {outputMeta.fps}fps · {outputMeta.duration.toFixed(1)}s · {outputMeta.segmentCount} segments · {(outputMeta.fileSize / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
          <VideoSlot
            id="combiner-output"
            src={outputUrl}
            className="w-full rounded border border-teal-500/20"
            style={{ width: "100%" }}
            autoOpen={autoplay}
            loop
          />
          <button
            type="button"
            onClick={async () => {
              try {
                const resp = await fetch(outputUrl);
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `VekSnap_Combined_${Date.now()}.mp4`;
                a.click();
                URL.revokeObjectURL(url);
              } catch { /* ignore */ }
            }}
            className="flex items-center justify-center gap-1.5 w-full h-7 rounded border border-teal-500/30 text-[10px] text-teal-400 hover:bg-teal-500/10 transition-colors"
          >
            <Download className="w-3 h-3" /> Download Combined Video
          </button>
        </div>
      )}

      {/* Info */}
      <div className="rounded-lg border border-border/30 bg-muted/20 p-3 space-y-1">
        <p className="text-[10px] text-muted-foreground font-medium flex items-center gap-1.5">
          <FileVideo className="w-3 h-3" /> How Segment Combiner Works
        </p>
        <p className="text-[9px] text-muted-foreground leading-relaxed">
          Videos are joined with hard cuts (no crossfade) to preserve exact frame timing
          and audio synchronization. All segments must match in resolution and frame rate.
          Audio tracks are concatenated seamlessly. This is ideal for combining Director
          pipeline outputs, re-ordering segments from different sessions, or assembling a
          final cut from individually approved segments.
        </p>
      </div>
    </div>
  );
}
