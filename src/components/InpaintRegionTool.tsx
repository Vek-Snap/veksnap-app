"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Crosshair, Check, X, Move, Upload, Layers } from "lucide-react";
import { REGION_SIZE_PRESETS, RegionInfo } from "@/lib/types";

interface Props {
  onRegionSelected: (croppedBlob: Blob, regionInfo: RegionInfo, backgroundBlob: Blob) => void;
  onCancel: () => void;
  initialImageUrl?: string; // Pre-load image from URL (e.g., extracted video frame)
}

export default function InpaintRegionTool({ onRegionSelected, onCancel, initialImageUrl }: Props) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imgNatW, setImgNatW] = useState(0);
  const [imgNatH, setImgNatH] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Region size from presets
  const [regionW, setRegionW] = useState(512);
  const [regionH, setRegionH] = useState(512);
  // Region position in source image coordinates
  const [regionX, setRegionX] = useState(0);
  const [regionY, setRegionY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, regX: 0, regY: 0 });

  // Display scale: how the source image maps to screen pixels
  const getDisplayScale = useCallback(() => {
    if (!imgRef.current || !imgNatW) return 1;
    return imgRef.current.clientWidth / imgNatW;
  }, [imgNatW]);

  // Check if source image is large enough for the region
  const regionFits = imgNatW >= regionW && imgNatH >= regionH;

  // Clamp region position
  const clampRegion = useCallback(
    (x: number, y: number) => ({
      x: Math.max(0, Math.min(x, Math.max(0, imgNatW - regionW))),
      y: Math.max(0, Math.min(y, Math.max(0, imgNatH - regionH))),
    }),
    [imgNatW, imgNatH, regionW, regionH]
  );

  // Auto-load initial image URL (e.g., from extracted video frame)
  useEffect(() => {
    if (initialImageUrl && !imageSrc) {
      setImageSrc(initialImageUrl);
      const img = new Image();
      img.onload = () => {
        setImgNatW(img.naturalWidth);
        setImgNatH(img.naturalHeight);
      };
      img.src = initialImageUrl;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImageUrl]);

  // Center region when dimensions change
  useEffect(() => {
    if (imgNatW > 0 && imgNatH > 0) {
      const centered = clampRegion(
        Math.floor((imgNatW - regionW) / 2),
        Math.floor((imgNatH - regionH) / 2)
      );
      setRegionX(centered.x);
      setRegionY(centered.y);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgNatW, imgNatH, regionW, regionH]);

  // Handle image upload
  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setImageFile(file);
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    const img = new Image();
    img.onload = () => {
      setImgNatW(img.naturalWidth);
      setImgNatH(img.naturalHeight);
    };
    img.src = url;
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // Region drag handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY, regX: regionX, regY: regionY });
    },
    [regionX, regionY]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dScale = getDisplayScale();
      const dx = (e.clientX - dragStart.x) / dScale;
      const dy = (e.clientY - dragStart.y) / dScale;
      const clamped = clampRegion(dragStart.regX + dx, dragStart.regY + dy);
      setRegionX(clamped.x);
      setRegionY(clamped.y);
    };

    const handleMouseUp = () => setDragging(false);

    if (dragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, dragStart, getDisplayScale, clampRegion]);

  // Touch handlers
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      setDragging(true);
      setDragStart({ x: touch.clientX, y: touch.clientY, regX: regionX, regY: regionY });
    },
    [regionX, regionY]
  );

  useEffect(() => {
    const handleTouchMove = (e: TouchEvent) => {
      if (!dragging) return;
      e.preventDefault();
      const touch = e.touches[0];
      const dScale = getDisplayScale();
      const dx = (touch.clientX - dragStart.x) / dScale;
      const dy = (touch.clientY - dragStart.y) / dScale;
      const clamped = clampRegion(dragStart.regX + dx, dragStart.regY + dy);
      setRegionX(clamped.x);
      setRegionY(clamped.y);
    };

    const handleTouchEnd = () => setDragging(false);

    if (dragging) {
      window.addEventListener("touchmove", handleTouchMove, { passive: false });
      window.addEventListener("touchend", handleTouchEnd);
    }
    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [dragging, dragStart, getDisplayScale, clampRegion]);

  // Confirm: crop the region and return
  const handleConfirm = () => {
    if (!imageSrc || !imageFile) return;

    const canvas = document.createElement("canvas");
    canvas.width = regionW;
    canvas.height = regionH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      // Draw the source image offset so the region is at (0,0)
      ctx.drawImage(img, -regionX, -regionY, imgNatW, imgNatH);
      canvas.toBlob(
        (croppedBlob) => {
          if (!croppedBlob) return;
          const info: RegionInfo = {
            x: Math.round(regionX),
            y: Math.round(regionY),
            width: regionW,
            height: regionH,
            sourceWidth: imgNatW,
            sourceHeight: imgNatH,
            sourceImageFile: "", // will be set after upload
          };
          // Also provide the full background image as a blob
          const bgCanvas = document.createElement("canvas");
          bgCanvas.width = imgNatW;
          bgCanvas.height = imgNatH;
          const bgCtx = bgCanvas.getContext("2d");
          if (bgCtx) {
            bgCtx.drawImage(img, 0, 0);
            bgCanvas.toBlob(
              (bgBlob) => {
                onRegionSelected(croppedBlob, info, bgBlob || croppedBlob);
              },
              "image/png"
            );
          } else {
            onRegionSelected(croppedBlob, info, croppedBlob);
          }
        },
        "image/png"
      );
    };
    img.src = imageSrc;
  };

  // Display overlay coordinates
  const dScale = getDisplayScale();
  const overlayLeft = regionX * dScale;
  const overlayTop = regionY * dScale;
  const overlayW = regionW * dScale;
  const overlayH = regionH * dScale;

  return (
    <Card className="border-cyan-500/30 bg-cyan-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          Region Selector: Compose Mode
          <Badge variant="outline" className="ml-auto text-[10px] border-cyan-500/40 text-cyan-400">
            {regionW}×{regionH}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Region size preset selector */}
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">Region Size (generation area)</Label>
          <Select
            value={`${regionW}x${regionH}`}
            onValueChange={(v) => {
              const [w, h] = v.split("x").map(Number);
              setRegionW(w);
              setRegionH(h);
            }}
          >
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REGION_SIZE_PRESETS.map((p) => (
                <SelectItem key={p.label} value={`${p.width}x${p.height}`} className="text-xs">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!imageSrc ? (
          // Upload zone
          <div
            className="border-2 border-dashed border-cyan-500/30 rounded-lg p-6 text-center cursor-pointer hover:border-cyan-400/50 transition-colors"
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) handleFile(file);
              };
              input.click();
            }}
          >
            <Upload className="w-8 h-8 mx-auto mb-2 text-cyan-400/50" />
            <p className="text-xs text-muted-foreground">
              Drop a video frame or image here
            </p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">
              The AI will only generate within the selected region
            </p>
          </div>
        ) : (
          <>
            {/* Image with region overlay */}
            <div
              ref={containerRef}
              className="relative rounded-lg overflow-hidden border border-border bg-black select-none"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={imageSrc}
                alt="Source"
                className="w-full h-auto block"
                draggable={false}
              />

              {/* Dark overlay outside the region */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `linear-gradient(to right, 
                    rgba(0,0,0,0.6) ${overlayLeft}px, 
                    transparent ${overlayLeft}px, 
                    transparent ${overlayLeft + overlayW}px, 
                    rgba(0,0,0,0.6) ${overlayLeft + overlayW}px)`,
                }}
              />
              {/* Top dark band */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: overlayLeft,
                  top: 0,
                  width: overlayW,
                  height: overlayTop,
                  background: "rgba(0,0,0,0.6)",
                }}
              />
              {/* Bottom dark band */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: overlayLeft,
                  top: overlayTop + overlayH,
                  width: overlayW,
                  height: `calc(100% - ${overlayTop + overlayH}px)`,
                  background: "rgba(0,0,0,0.6)",
                }}
              />

              {/* Region frame: draggable */}
              {regionFits && (
                <div
                  className="absolute border-2 border-cyan-400 cursor-move"
                  style={{
                    left: overlayLeft,
                    top: overlayTop,
                    width: overlayW,
                    height: overlayH,
                  }}
                  onMouseDown={handleMouseDown}
                  onTouchStart={handleTouchStart}
                >
                  {/* Crosshair center */}
                  <Crosshair className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 text-cyan-400/60" />
                  {/* Corner markers */}
                  <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-cyan-300" />
                  <div className="absolute top-0 right-0 w-3 h-3 border-t-2 border-r-2 border-cyan-300" />
                  <div className="absolute bottom-0 left-0 w-3 h-3 border-b-2 border-l-2 border-cyan-300" />
                  <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-cyan-300" />
                  {/* Label */}
                  <div className="absolute -top-5 left-0 text-[9px] font-mono text-cyan-400 bg-black/60 px-1 rounded">
                    {regionW}×{regionH} @ ({Math.round(regionX)}, {Math.round(regionY)})
                  </div>
                </div>
              )}
            </div>

            {/* Status + hints */}
            {!regionFits && (
              <p className="text-[10px] text-red-400">
                Source image ({imgNatW}×{imgNatH}) is smaller than the selected region ({regionW}×{regionH}). Choose a smaller region or use a larger image.
              </p>
            )}

            {regionFits && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <Move className="w-3 h-3" />
                Drag the region to position it. Only this area will be generated.
              </div>
            )}
          </>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5 text-xs"
            onClick={onCancel}
          >
            <X className="w-3.5 h-3.5" /> Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1 gap-1.5 text-xs bg-cyan-600 hover:bg-cyan-500"
            disabled={!imageSrc || !regionFits}
            onClick={handleConfirm}
          >
            <Check className="w-3.5 h-3.5" /> Set Region
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
