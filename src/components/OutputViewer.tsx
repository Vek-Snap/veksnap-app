"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  ImageIcon,
  Download,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  LayoutGrid,
  Rows3,
  X,
} from "lucide-react";
import { GenerationResult, GenerationStatus, PreviewHistoryEntry } from "@/lib/types";
import { getImageUrl } from "@/lib/comfyui-api";

type OutputDisplayMode = "single" | "grid" | "playback";
const DISPLAY_MODE_KEY = "veksnap-output-display-mode";

function getSavedDisplayMode(): OutputDisplayMode | null {
  if (typeof window === "undefined") return null;
  const saved = localStorage.getItem(DISPLAY_MODE_KEY);
  if (saved === "single" || saved === "grid" || saved === "playback") return saved;
  return null;
}

function getDefaultDisplayMode(count: number): OutputDisplayMode {
  const saved = getSavedDisplayMode();
  if (saved) return saved;
  if (count <= 1) return "single";
  if (count <= 16) return "grid";
  return "playback";
}

function getGridCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

interface Props {
  result: GenerationResult | null;
  fps: number;
  previewUrl?: string | null;
  status: GenerationStatus;
  previewHistory?: PreviewHistoryEntry[];
}

export default function OutputViewer({ result, fps, previewUrl, status, previewHistory = [] }: Props) {
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [hidePreview, setHidePreview] = useState(false);
  const [displayMode, setDisplayModeRaw] = useState<OutputDisplayMode>("single");
  const [fullscreenIdx, setFullscreenIdx] = useState<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const images = result?.images ?? [];
  const totalFrames = images.length;
  const isGenerating = status === "generating" || status === "queued" || status === "uploading";

  // Persist display mode to localStorage
  const setDisplayMode = useCallback((mode: OutputDisplayMode) => {
    setDisplayModeRaw(mode);
    try { localStorage.setItem(DISPLAY_MODE_KEY, mode); } catch {}
  }, []);

  // Set display mode from saved preference or smart default when results change
  useEffect(() => {
    if (totalFrames > 0) {
      setDisplayModeRaw(getDefaultDisplayMode(totalFrames));
    }
  }, [totalFrames]);

  const stopPlayback = useCallback(() => {
    setPlaying(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startPlayback = useCallback(() => {
    if (totalFrames <= 1) return;
    setPlaying(true);
    intervalRef.current = setInterval(() => {
      setCurrentFrame((prev) => (prev + 1) % totalFrames);
    }, 1000 / fps);
  }, [totalFrames, fps]);

  const togglePlayback = useCallback(() => {
    if (playing) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }, [playing, stopPlayback, startPlayback]);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    setCurrentFrame(0);
    setFullscreenIdx(null);
    stopPlayback();
  }, [result, stopPlayback]);

  // Keyboard navigation for fullscreen overlay
  useEffect(() => {
    if (fullscreenIdx === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreenIdx(null);
      else if (e.key === "ArrowLeft") setFullscreenIdx((p) => p !== null ? (p > 0 ? p - 1 : totalFrames - 1) : 0);
      else if (e.key === "ArrowRight") setFullscreenIdx((p) => p !== null ? (p + 1) % totalFrames : 0);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullscreenIdx, totalFrames]);

  const handleDownloadAll = async () => {
    setDownloading(true);
    try {
      for (const img of images) {
        const url = getImageUrl(img.filename, img.subfolder, img.type);
        const res = await fetch(url);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = img.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadSingle = async (idx: number) => {
    const img = images[idx];
    if (!img) return;
    const url = getImageUrl(img.filename, img.subfolder, img.type);
    const res = await fetch(url);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = img.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  };

  // Show live preview during generation
  if (isGenerating && previewUrl) {
    return (
      <Card className="flex-1 flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2 justify-between">
            <span className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-yellow-500 animate-pulse" /> Live Preview
            </span>
            <button
              onClick={() => setHidePreview((h) => !h)}
              className="p-1 rounded hover:bg-muted transition-colors"
              title={hidePreview ? "Show preview" : "Hide preview (privacy)"}
            >
              {hidePreview ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground" /> : <Eye className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col">
          <div className="relative bg-black/20 rounded-lg overflow-hidden flex items-center justify-center" style={{ maxHeight: "55vh" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="Live preview"
              className={`max-w-full max-h-[55vh] object-contain transition-all duration-200 ${hidePreview ? "blur-xl scale-95 opacity-50" : ""}`}
            />
            {hidePreview && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <EyeOff className="w-8 h-8 text-muted-foreground/50 mx-auto mb-1" />
                  <p className="text-[10px] text-muted-foreground/50">Preview hidden</p>
                </div>
              </div>
            )}
            <div className="absolute top-2 left-2">
              <Badge variant="secondary" className="text-[10px] bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
                Rendering...
              </Badge>
            </div>
          </div>

          {/* Preview history strip */}
          {previewHistory.length > 1 && (
            <div className="space-y-1 mt-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">Preview History</span>
                <span className="text-[9px] text-muted-foreground/50 font-mono">{previewHistory.length} snapshots</span>
              </div>
              <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-thin">
                {previewHistory.map((entry, i) => (
                  <div key={i} className="flex-shrink-0 relative group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={entry.dataUrl}
                      alt={`Preview ${i + 1}`}
                      className="h-16 w-auto rounded border border-border/50 object-cover"
                    />
                    {entry.segment >= 0 && (
                      <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-[7px] text-center text-white/80 py-0.5 rounded-b">
                        Seg {entry.segment + 1}
                      </div>
                    )}
                    <div className="absolute top-0 left-0 bg-black/60 text-[7px] text-white/60 px-1 rounded-br">
                      {i + 1}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // Show placeholder when no results
  if (!result || images.length === 0) {
    return (
      <Card className="flex-1">
        <CardContent className="flex items-center justify-center h-full min-h-[200px]">
          <div className="text-center text-muted-foreground">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
              <ImageIcon className="w-8 h-8" />
            </div>
            <p className="text-sm font-medium">No output yet</p>
            <p className="text-xs mt-1">Configure settings and hit Generate</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const currentImage = images[currentFrame];
  const imageUrl = getImageUrl(
    currentImage.filename,
    currentImage.subfolder,
    currentImage.type
  );
  const gridCols = getGridCols(totalFrames);

  return (
    <Card className="flex-1 flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ImageIcon className="w-4 h-4" /> Output
            <Badge variant="secondary" className="text-[10px]">
              {totalFrames} {totalFrames === 1 ? "image" : "images"}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Display mode toggle */}
            {totalFrames > 1 && (
              <div className="flex border rounded-md overflow-hidden">
                <button
                  onClick={() => setDisplayMode("single")}
                  className={`p-1.5 transition-colors ${displayMode === "single" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                  title="Single image view"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setDisplayMode("grid")}
                  className={`p-1.5 transition-colors ${displayMode === "grid" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                  title="Grid view"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setDisplayMode("playback")}
                  className={`p-1.5 transition-colors ${displayMode === "playback" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                  title="Playback view"
                >
                  <Rows3 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {/* Download buttons */}
            {totalFrames > 1 && displayMode !== "grid" && (
              <Button variant="outline" size="sm" className="text-xs gap-1.5 h-7" onClick={() => handleDownloadSingle(currentFrame)}>
                <Download className="w-3 h-3" /> Frame
              </Button>
            )}
            <Button variant="outline" size="sm" className="text-xs gap-1.5 h-7" onClick={handleDownloadAll} disabled={downloading}>
              <Download className="w-3 h-3" /> {downloading ? "Saving..." : totalFrames > 1 ? "All" : "Save"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-3">

        {/* ── Fullscreen Preview Overlay ── */}
        {fullscreenIdx !== null && images[fullscreenIdx] && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center cursor-pointer"
            onClick={() => setFullscreenIdx(null)}
          >
            <button
              className="absolute top-16 left-1/2 -translate-x-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors z-10"
              onClick={(e) => { e.stopPropagation(); setFullscreenIdx(null); }}
            >
              <X className="w-5 h-5 text-white" />
            </button>
            <div className="absolute top-16 left-4 flex gap-2 z-10">
              <Button
                variant="ghost"
                size="sm"
                className="text-white/80 hover:text-white hover:bg-white/10 gap-1.5 text-xs"
                onClick={(e) => { e.stopPropagation(); handleDownloadSingle(fullscreenIdx); }}
              >
                <Download className="w-3.5 h-3.5" /> Save
              </Button>
              <Badge variant="secondary" className="text-[10px] font-mono bg-white/10 text-white/70 border-white/20">
                {fullscreenIdx + 1} / {totalFrames}
              </Badge>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={getImageUrl(images[fullscreenIdx].filename, images[fullscreenIdx].subfolder, images[fullscreenIdx].type)}
              alt={`Fullscreen ${fullscreenIdx + 1}`}
              className="max-w-[95vw] max-h-[95vh] object-contain"
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={() => setFullscreenIdx(null)}
            />
            {/* Prev/Next arrows in fullscreen */}
            {totalFrames > 1 && (
              <>
                <button
                  className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setFullscreenIdx((p) => p !== null ? (p > 0 ? p - 1 : totalFrames - 1) : 0); }}
                >
                  <ChevronLeft className="w-6 h-6 text-white" />
                </button>
                <button
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setFullscreenIdx((p) => p !== null ? (p + 1) % totalFrames : 0); }}
                >
                  <ChevronRight className="w-6 h-6 text-white" />
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Single Image View ── */}
        {displayMode === "single" && (
          <>
            <div className="relative bg-black/20 rounded-lg overflow-hidden flex items-center justify-center" style={{ maxHeight: "55vh" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={`Image ${currentFrame + 1}`}
                className="max-w-full max-h-[55vh] object-contain cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setFullscreenIdx(currentFrame)}
                title="Click to enlarge"
              />
              {totalFrames > 1 && (
                <div className="absolute bottom-2 right-2">
                  <Badge variant="secondary" className="text-[10px] font-mono">
                    {currentFrame + 1} / {totalFrames}
                  </Badge>
                </div>
              )}
            </div>
            {/* Prev/Next navigation for multi-image single view */}
            {totalFrames > 1 && (
              <div className="flex items-center justify-center gap-1">
                <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setCurrentFrame((p) => (p > 0 ? p - 1 : totalFrames - 1))}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-xs text-muted-foreground font-mono px-2">{currentFrame + 1} / {totalFrames}</span>
                <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setCurrentFrame((p) => (p + 1) % totalFrames)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </>
        )}

        {/* ── Grid View ── */}
        {displayMode === "grid" && (
          <div
            className="grid gap-2 overflow-auto rounded-lg"
            style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
          >
            {images.map((img, i) => {
              const url = getImageUrl(img.filename, img.subfolder, img.type);
              return (
                <div
                  key={i}
                  className="relative rounded-lg overflow-hidden bg-black/20 cursor-pointer group hover:ring-2 hover:ring-primary/50 transition-all"
                  onClick={() => setFullscreenIdx(i)}
                  title={`${img.filename}: click to enlarge`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`Image ${i + 1}`} className="w-full h-auto object-contain" />
                  <div className="absolute bottom-1 right-1 opacity-70 group-hover:opacity-100 transition-opacity">
                    <Badge variant="secondary" className="text-[9px] font-mono px-1.5 py-0">
                      {i + 1}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Playback View ── */}
        {displayMode === "playback" && (
          <>
            <div className="relative bg-black/20 rounded-lg overflow-hidden flex items-center justify-center" style={{ maxHeight: "55vh" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={`Frame ${currentFrame + 1}`}
                className="max-w-full max-h-[55vh] object-contain"
              />
              <div className="absolute bottom-2 right-2">
                <Badge variant="secondary" className="text-[10px] font-mono">
                  {currentFrame + 1} / {totalFrames}
                </Badge>
              </div>
            </div>
            <div className="space-y-2">
              <Slider
                value={[currentFrame]}
                onValueChange={([v]) => {
                  setCurrentFrame(v);
                  if (playing) stopPlayback();
                }}
                min={0}
                max={totalFrames - 1}
                step={1}
              />
              <div className="flex items-center justify-center gap-1">
                <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setCurrentFrame(0)}>
                  <SkipBack className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setCurrentFrame((p) => (p > 0 ? p - 1 : totalFrames - 1))}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="icon" className="w-9 h-9" onClick={togglePlayback}>
                  {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </Button>
                <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setCurrentFrame((p) => (p + 1) % totalFrames)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="w-8 h-8" onClick={() => setCurrentFrame(totalFrames - 1)}>
                  <SkipForward className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
