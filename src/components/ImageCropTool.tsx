"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Crop, Check, X, Move, Upload, ZoomIn } from "lucide-react";

interface Props {
  targetWidth: number;
  targetHeight: number;
  onCropComplete: (croppedBlob: Blob) => void;
  onCancel: () => void;
}

export default function ImageCropTool({
  targetWidth,
  targetHeight,
  onCropComplete,
  onCancel,
}: Props) {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imgNatW, setImgNatW] = useState(0);
  const [imgNatH, setImgNatH] = useState(0);
  const [imageScale, setImageScale] = useState(1.0);
  // Crop position in scaled image coordinates
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0, cropX: 0, cropY: 0 });

  // Scaled image dimensions (after user's scale slider)
  const scaledW = Math.round(imgNatW * imageScale);
  const scaledH = Math.round(imgNatH * imageScale);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Display scale: how the scaled image maps to screen pixels
  const getDisplayScale = useCallback(() => {
    if (!imgRef.current || !scaledW) return 1;
    return imgRef.current.clientWidth / scaledW;
  }, [scaledW]);

  // Check if scaled image needs cropping (larger than target in at least one dimension)
  const needsCrop = scaledW > targetWidth || scaledH > targetHeight;
  // If scaled image matches exactly
  const fitsExactly = scaledW === targetWidth && scaledH === targetHeight;

  // Clamp crop position to scaled dimensions
  const clampCrop = useCallback(
    (x: number, y: number) => ({
      x: Math.max(0, Math.min(x, Math.max(0, scaledW - targetWidth))),
      y: Math.max(0, Math.min(y, Math.max(0, scaledH - targetHeight))),
    }),
    [scaledW, scaledH, targetWidth, targetHeight]
  );

  // Center crop when dimensions change
  useEffect(() => {
    if (scaledW > 0 && scaledH > 0) {
      const centered = clampCrop(
        Math.floor((scaledW - targetWidth) / 2),
        Math.floor((scaledH - targetHeight) / 2)
      );
      setCropX(centered.x);
      setCropY(centered.y);
    }
  }, [scaledW, scaledH, targetWidth, targetHeight, clampCrop]);

  // Compute min/max scale: min = target fits in image, max = 3x original
  const minScale = Math.max(
    imgNatW > 0 ? targetWidth / imgNatW : 0.1,
    imgNatH > 0 ? targetHeight / imgNatH : 0.1,
    0.1
  );
  const maxScale = 3.0;

  // Initialize scale when image loads
  useEffect(() => {
    if (imgNatW > 0 && imgNatH > 0) {
      setImageScale(Math.max(1.0, minScale));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgNatW, imgNatH]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
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

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!needsCrop) return;
    e.preventDefault();
    setDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY, cropX, cropY });
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging) return;
      const dScale = getDisplayScale();
      const dx = (e.clientX - dragStart.x) / dScale;
      const dy = (e.clientY - dragStart.y) / dScale;
      const clamped = clampCrop(dragStart.cropX + dx, dragStart.cropY + dy);
      setCropX(clamped.x);
      setCropY(clamped.y);
    },
    [dragging, dragStart, getDisplayScale, clampCrop]
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  // Touch support
  const handleTouchStart = (e: React.TouchEvent) => {
    if (!needsCrop || e.touches.length !== 1) return;
    const touch = e.touches[0];
    setDragging(true);
    setDragStart({ x: touch.clientX, y: touch.clientY, cropX, cropY });
  };

  useEffect(() => {
    if (!dragging) return;
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const dScale = getDisplayScale();
      const dx = (touch.clientX - dragStart.x) / dScale;
      const dy = (touch.clientY - dragStart.y) / dScale;
      const clamped = clampCrop(dragStart.cropX + dx, dragStart.cropY + dy);
      setCropX(clamped.x);
      setCropY(clamped.y);
    };
    const handleTouchEnd = () => setDragging(false);
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd);
    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [dragging, dragStart, getDisplayScale, clampCrop]);

  const handleConfirm = () => {
    if (!imageSrc || !imageFile) return;

    // If scaled image matches target exactly, send as-is (only if scale is 1.0)
    if (!needsCrop && imageScale === 1.0) {
      onCropComplete(imageFile);
      return;
    }

    // Draw the image at the scaled size, then crop the target region
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      // Draw the full image scaled, offset by crop position
      ctx.drawImage(
        img,
        -cropX, -cropY, scaledW, scaledH
      );
      canvas.toBlob(
        (blob) => {
          if (blob) onCropComplete(blob);
        },
        "image/png"
      );
    };
    img.src = imageSrc;
  };

  const dScale = getDisplayScale();
  const overlayLeft = cropX * dScale;
  const overlayTop = cropY * dScale;
  const overlayW = targetWidth * dScale;
  const overlayH = targetHeight * dScale;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Crop className="w-4 h-4 text-cyan-400" />
            Source Image for I2V
          </span>
          <Badge variant="secondary" className="text-[9px] font-mono">
            {targetWidth}×{targetHeight}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!imageSrc ? (
          /* Drop zone */
          <label
            className="flex flex-col items-center justify-center h-48 border-2 border-dashed border-muted-foreground/30 rounded-lg cursor-pointer hover:border-primary/50 hover:bg-muted/20 transition-colors"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            <Upload className="w-8 h-8 text-muted-foreground mb-2" />
            <span className="text-sm text-muted-foreground">
              Drop image here or click to browse
            </span>
            <span className="text-[10px] text-muted-foreground/60 mt-1">
              Will be cropped to {targetWidth}×{targetHeight}
            </span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileSelect}
            />
          </label>
        ) : (
          <>
            {/* Crop viewport */}
            <div
              ref={containerRef}
              className="relative overflow-hidden rounded-lg bg-black/40 select-none"
              style={{ cursor: needsCrop ? (dragging ? "grabbing" : "grab") : "default" }}
              onMouseDown={handleMouseDown}
              onTouchStart={handleTouchStart}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={imageSrc}
                alt="Source"
                className="w-full h-auto block"
                draggable={false}
              />

              {/* Dark overlay outside crop area */}
              {needsCrop && (
                <>
                  {/* Top */}
                  <div
                    className="absolute left-0 right-0 top-0 bg-black/60 pointer-events-none"
                    style={{ height: overlayTop }}
                  />
                  {/* Bottom */}
                  <div
                    className="absolute left-0 right-0 bg-black/60 pointer-events-none"
                    style={{ top: overlayTop + overlayH, bottom: 0 }}
                  />
                  {/* Left */}
                  <div
                    className="absolute bg-black/60 pointer-events-none"
                    style={{ left: 0, top: overlayTop, width: overlayLeft, height: overlayH }}
                  />
                  {/* Right */}
                  <div
                    className="absolute bg-black/60 pointer-events-none"
                    style={{ left: overlayLeft + overlayW, top: overlayTop, right: 0, height: overlayH }}
                  />

                  {/* Crop border */}
                  <div
                    className="absolute border-2 border-cyan-400 rounded pointer-events-none"
                    style={{
                      left: overlayLeft,
                      top: overlayTop,
                      width: overlayW,
                      height: overlayH,
                    }}
                  >
                    {/* Corner indicators */}
                    <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-cyan-400 rounded-sm" />
                    <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-cyan-400 rounded-sm" />
                    <div className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-cyan-400 rounded-sm" />
                    <div className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-cyan-400 rounded-sm" />

                    {/* Center move icon */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="bg-black/50 rounded-full p-1.5">
                        <Move className="w-4 h-4 text-cyan-400" />
                      </div>
                    </div>
                  </div>

                  {/* Crop coordinates */}
                  <div className="absolute top-1 left-1">
                    <Badge className="text-[9px] font-mono bg-black/60 text-cyan-300 border-0">
                      {Math.round(cropX)},{Math.round(cropY)}
                    </Badge>
                  </div>
                </>
              )}

              {/* Image info */}
              {!needsCrop && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-[10px]">
                    {fitsExactly ? "Exact match!" : "Image will be scaled to fit"}
                  </Badge>
                </div>
              )}
            </div>

            {/* Scale slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <ZoomIn className="w-3 h-3" /> Image Scale
                </Label>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {(imageScale * 100).toFixed(0)}% ({scaledW}×{scaledH})
                </span>
              </div>
              <Slider
                value={[imageScale]}
                onValueChange={([v]) => setImageScale(v)}
                min={minScale}
                max={maxScale}
                step={0.01}
              />
            </div>

            {/* Info */}
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                Original: {imgNatW}×{imgNatH}
              </span>
              <span>
                Crop: {targetWidth}×{targetHeight}
              </span>
            </div>

            {needsCrop && (
              <p className="text-[10px] text-muted-foreground/70">
                Drag the highlighted area to select which region to animate
              </p>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 gap-1.5" onClick={handleConfirm}>
                <Check className="w-3.5 h-3.5" />
                Confirm Crop
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setImageSrc(null);
                  setImageFile(null);
                  setImgNatW(0);
                  setImgNatH(0);
                }}
              >
                Change Image
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
