"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Layers, Play, Pause, Download, SkipBack, SkipForward, RefreshCw } from "lucide-react";
import { RegionInfo, GenerationResult } from "@/lib/types";

interface Props {
  result: GenerationResult;
  regionInfo: RegionInfo;
  backgroundUrl: string; // blob URL of the full background image
  fps: number;
  onReReimagine?: (compositeBlob: Blob) => void;
}

const COMFYUI_BASE = "/comfyui";

export default function CompositePreview({ result, regionInfo, backgroundUrl, fps, onReReimagine }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const frameImagesRef = useRef<HTMLImageElement[]>([]);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const animRef = useRef<number>(0);
  const lastFrameTimeRef = useRef(0);

  const frameCount = result.images.length;

  // Load background image
  useEffect(() => {
    const bg = new Image();
    bg.onload = () => {
      bgImageRef.current = bg;
      checkAllLoaded();
    };
    bg.src = backgroundUrl;

    // Load all frame images
    const frames: HTMLImageElement[] = [];
    let loadedCount = 0;

    result.images.forEach((img, i) => {
      const frameImg = new Image();
      frameImg.crossOrigin = "anonymous";
      frameImg.onload = () => {
        loadedCount++;
        if (loadedCount === result.images.length) checkAllLoaded();
      };
      frameImg.src = `${COMFYUI_BASE}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type || "output"}`;
      frames[i] = frameImg;
    });
    frameImagesRef.current = frames;

    function checkAllLoaded() {
      if (bgImageRef.current && frameImagesRef.current.filter(Boolean).length === result.images.length) {
        setLoaded(true);
      }
    }

    return () => {
      bgImageRef.current = null;
      frameImagesRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, backgroundUrl]);

  // Draw composite frame
  const drawFrame = useCallback((frameIdx: number) => {
    const canvas = canvasRef.current;
    const bg = bgImageRef.current;
    const frameImg = frameImagesRef.current[frameIdx];
    if (!canvas || !bg || !frameImg) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set canvas to background dimensions
    canvas.width = regionInfo.sourceWidth;
    canvas.height = regionInfo.sourceHeight;

    // Draw background
    ctx.drawImage(bg, 0, 0);

    // Draw generated frame at the region position
    ctx.drawImage(frameImg, regionInfo.x, regionInfo.y, regionInfo.width, regionInfo.height);

    // Draw region border indicator
    ctx.strokeStyle = "rgba(0, 200, 255, 0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(regionInfo.x, regionInfo.y, regionInfo.width, regionInfo.height);
  }, [regionInfo]);

  // Draw when frame changes
  useEffect(() => {
    if (loaded) drawFrame(currentFrame);
  }, [loaded, currentFrame, drawFrame]);

  // Animation loop
  useEffect(() => {
    if (!playing || !loaded) return;

    const interval = 1000 / fps;
    let lastTime = performance.now();

    const animate = (time: number) => {
      if (time - lastTime >= interval) {
        lastTime = time;
        setCurrentFrame((prev) => (prev + 1) % frameCount);
      }
      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [playing, loaded, fps, frameCount]);

  // Download composite as video frames or current frame
  const handleDownloadFrame = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `composite_frame_${currentFrame.toString().padStart(4, "0")}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  if (!loaded) {
    return (
      <Card className="border-cyan-500/30">
        <CardContent className="py-8 text-center">
          <p className="text-xs text-muted-foreground animate-pulse">Loading composite preview...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-cyan-500/30 bg-cyan-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          Composite Preview
          <Badge variant="outline" className="ml-auto text-[10px] border-cyan-500/40 text-cyan-400">
            {regionInfo.sourceWidth}×{regionInfo.sourceHeight} · {frameCount} frames
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Canvas */}
        <div className="rounded-lg overflow-hidden border border-border bg-black" style={{ maxHeight: "50vh" }}>
          <canvas
            ref={canvasRef}
            className="w-full h-auto block"
            style={{ maxHeight: "50vh", objectFit: "contain" }}
          />
        </div>

        {/* Frame scrubber */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Frame {currentFrame + 1} / {frameCount}</span>
            <span>{fps} FPS</span>
          </div>
          <Slider
            value={[currentFrame]}
            onValueChange={([v]) => { setPlaying(false); setCurrentFrame(v); }}
            min={0}
            max={Math.max(0, frameCount - 1)}
            step={1}
          />
        </div>

        {/* Controls */}
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => { setPlaying(false); setCurrentFrame(0); }}
          >
            <SkipBack className="w-3 h-3" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => { setPlaying(false); setCurrentFrame(Math.max(0, currentFrame - 1)); }}
          >
            <SkipBack className="w-3 h-3" />
          </Button>
          <Button
            size="sm"
            className={`flex-1 h-7 text-[10px] gap-1 ${playing ? "bg-amber-600 hover:bg-amber-500" : "bg-cyan-600 hover:bg-cyan-500"}`}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? <><Pause className="w-3 h-3" /> Pause</> : <><Play className="w-3 h-3" /> Play Composite</>}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => { setPlaying(false); setCurrentFrame(Math.min(frameCount - 1, currentFrame + 1)); }}
          >
            <SkipForward className="w-3 h-3" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => { setPlaying(false); setCurrentFrame(frameCount - 1); }}
          >
            <SkipForward className="w-3 h-3" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-[10px]"
            onClick={handleDownloadFrame}
          >
            <Download className="w-3 h-3" /> Frame
          </Button>
        </div>

        {/* Re-Re-Imagine: pipe output back to input for iterative refinement */}
        {onReReimagine && (
          <Button
            size="sm"
            className="w-full h-8 text-xs gap-1.5 bg-amber-600 hover:bg-amber-500 text-white"
            onClick={() => {
              const canvas = canvasRef.current;
              if (!canvas) return;
              canvas.toBlob((blob) => {
                if (blob) onReReimagine(blob);
              }, "image/png");
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Re-Re-Imagine
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
