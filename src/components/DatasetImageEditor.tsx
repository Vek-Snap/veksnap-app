"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Crop,
  Paintbrush,
  Check,
  X,
  RotateCcw,
  Loader2,
  Move,
} from "lucide-react";
import MaskPainter from "@/components/MaskPainter";

type EditorMode = "crop" | "mask";

interface Props {
  imageUrl: string;
  filename: string;
  datasetName: string;
  onSave: (newFilename: string, width: number, height: number) => void;
  onClose: () => void;
}

export default function DatasetImageEditor({ imageUrl, filename, datasetName, onSave, onClose }: Props) {
  const [mode, setMode] = useState<EditorMode>("crop");
  const [saving, setSaving] = useState(false);

  // ── Crop state ──
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgW, setImgW] = useState(0);
  const [imgH, setImgH] = useState(0);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // Load image
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImgW(img.naturalWidth);
      setImgH(img.naturalHeight);
      setImgLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Draw crop preview
  useEffect(() => {
    if (mode !== "crop" || !imgLoaded || !canvasRef.current || !imgRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d")!;
    const img = imgRef.current;

    // Scale to fit canvas
    const maxW = 800;
    const maxH = 500;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    canvas.width = img.naturalWidth * scale;
    canvas.height = img.naturalHeight * scale;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Draw crop overlay
    if (cropRect) {
      const sx = scale;
      const rx = cropRect.x * sx;
      const ry = cropRect.y * sx;
      const rw = cropRect.w * sx;
      const rh = cropRect.h * sx;

      // Darken outside crop
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, canvas.width, ry); // top
      ctx.fillRect(0, ry + rh, canvas.width, canvas.height - ry - rh); // bottom
      ctx.fillRect(0, ry, rx, rh); // left
      ctx.fillRect(rx + rw, ry, canvas.width - rx - rw, rh); // right

      // Crop border
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);

      // Corner handles
      const hs = 6;
      ctx.fillStyle = "#f97316";
      for (const [cx, cy] of [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]]) {
        ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      }

      // Dimension label
      ctx.fillStyle = "#f97316";
      ctx.font = "11px monospace";
      ctx.fillText(`${Math.round(cropRect.w)}×${Math.round(cropRect.h)}`, rx + 4, ry - 6);
    }
  }, [mode, imgLoaded, cropRect]);

  // Get scale factor for the canvas
  const getScale = useCallback(() => {
    if (!canvasRef.current || !imgRef.current) return 1;
    return canvasRef.current.width / imgRef.current.naturalWidth;
  }, []);

  // Crop mouse handlers
  const handleCropMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scale = getScale();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    dragStart.current = { x, y };
    setDragging(true);
    setCropRect({ x, y, w: 0, h: 0 });
  }, [getScale]);

  const handleCropMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging || !dragStart.current || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = getScale();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const sx = Math.min(dragStart.current.x, x);
    const sy = Math.min(dragStart.current.y, y);
    const sw = Math.abs(x - dragStart.current.x);
    const sh = Math.abs(y - dragStart.current.y);
    setCropRect({
      x: Math.max(0, sx),
      y: Math.max(0, sy),
      w: Math.min(sw, imgW - Math.max(0, sx)),
      h: Math.min(sh, imgH - Math.max(0, sy)),
    });
  }, [dragging, getScale, imgW, imgH]);

  const handleCropMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Save crop
  const handleSaveCrop = useCallback(async () => {
    if (!cropRect || cropRect.w < 32 || cropRect.h < 32 || !imgRef.current) return;
    setSaving(true);
    try {
      // Draw cropped region to a new canvas
      const outCanvas = document.createElement("canvas");
      outCanvas.width = Math.round(cropRect.w);
      outCanvas.height = Math.round(cropRect.h);
      const ctx = outCanvas.getContext("2d")!;
      ctx.drawImage(
        imgRef.current,
        Math.round(cropRect.x), Math.round(cropRect.y),
        Math.round(cropRect.w), Math.round(cropRect.h),
        0, 0,
        outCanvas.width, outCanvas.height
      );

      const blob = await new Promise<Blob>((resolve) =>
        outCanvas.toBlob((b) => resolve(b!), "image/png")
      );

      const formData = new FormData();
      formData.append("datasetName", datasetName);
      formData.append("sourceFilename", filename);
      formData.append("cropType", "manual_crop");
      formData.append("image", new File([blob], "crop.png", { type: "image/png" }));

      const resp = await fetch("/api/lora-factory/save-crop", { method: "POST", body: formData });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Save failed");

      onSave(data.filename, outCanvas.width, outCanvas.height);
    } catch (err) {
      console.error("Crop save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [cropRect, datasetName, filename, onSave]);

  // Mask complete handler: extract subject onto white background
  const handleMaskComplete = useCallback(async (maskBlob: Blob, sourceBlob: Blob, srcW: number, srcH: number) => {
    setSaving(true);
    try {
      // Load both mask and source as images
      const [maskImg, srcImg] = await Promise.all([
        loadBlobAsImage(maskBlob),
        loadBlobAsImage(sourceBlob),
      ]);

      // Create output canvas: subject on white background
      const outCanvas = document.createElement("canvas");
      outCanvas.width = srcW;
      outCanvas.height = srcH;
      const ctx = outCanvas.getContext("2d")!;

      // White background
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, srcW, srcH);

      // Draw source image
      ctx.drawImage(srcImg, 0, 0);

      // Apply mask: where mask is black (unselected), replace with white
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = srcW;
      maskCanvas.height = srcH;
      const mCtx = maskCanvas.getContext("2d")!;
      mCtx.drawImage(maskImg, 0, 0, srcW, srcH);

      const srcData = ctx.getImageData(0, 0, srcW, srcH);
      const maskData = mCtx.getImageData(0, 0, srcW, srcH);
      const sd = srcData.data;
      const md = maskData.data;

      for (let i = 0; i < sd.length; i += 4) {
        const alpha = md[i]; // mask brightness = selection strength
        if (alpha < 255) {
          // Blend towards white based on inverse mask
          const blend = alpha / 255;
          sd[i] = Math.round(sd[i] * blend + 255 * (1 - blend));
          sd[i + 1] = Math.round(sd[i + 1] * blend + 255 * (1 - blend));
          sd[i + 2] = Math.round(sd[i + 2] * blend + 255 * (1 - blend));
        }
      }
      ctx.putImageData(srcData, 0, 0);

      // Auto-crop to the bounding box of the subject (non-white region)
      let minX = srcW, minY = srcH, maxX = 0, maxY = 0;
      for (let y = 0; y < srcH; y++) {
        for (let x = 0; x < srcW; x++) {
          const idx = (y * srcW + x) * 4;
          if (md[idx] > 32) { // mask is selected
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }

      // Add some padding (10%)
      const padX = Math.round((maxX - minX) * 0.1);
      const padY = Math.round((maxY - minY) * 0.1);
      minX = Math.max(0, minX - padX);
      minY = Math.max(0, minY - padY);
      maxX = Math.min(srcW - 1, maxX + padX);
      maxY = Math.min(srcH - 1, maxY + padY);

      const cropW = maxX - minX + 1;
      const cropH = maxY - minY + 1;

      // Create final cropped canvas
      const finalCanvas = document.createElement("canvas");
      finalCanvas.width = cropW;
      finalCanvas.height = cropH;
      const fCtx = finalCanvas.getContext("2d")!;
      fCtx.drawImage(outCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

      const blob = await new Promise<Blob>((resolve) =>
        finalCanvas.toBlob((b) => resolve(b!), "image/png")
      );

      const formData = new FormData();
      formData.append("datasetName", datasetName);
      formData.append("sourceFilename", filename);
      formData.append("cropType", "mask_extract");
      formData.append("image", new File([blob], "extracted.png", { type: "image/png" }));

      const resp = await fetch("/api/lora-factory/save-crop", { method: "POST", body: formData });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Save failed");

      onSave(data.filename, cropW, cropH);
    } catch (err) {
      console.error("Mask extract failed:", err);
    } finally {
      setSaving(false);
    }
  }, [datasetName, filename, onSave]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center">
      <div className="bg-background rounded-xl border border-border shadow-2xl w-[90vw] max-w-[900px] max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium">Edit: {filename}</h3>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={mode === "crop" ? "default" : "outline"}
                className={`h-7 text-[10px] ${mode === "crop" ? "bg-orange-600" : ""}`}
                onClick={() => setMode("crop")}
              >
                <Crop className="w-3 h-3 mr-1" /> Crop
              </Button>
              <Button
                size="sm"
                variant={mode === "mask" ? "default" : "outline"}
                className={`h-7 text-[10px] ${mode === "mask" ? "bg-orange-600" : ""}`}
                onClick={() => setMode("mask")}
              >
                <Paintbrush className="w-3 h-3 mr-1" /> Mask & Extract
              </Button>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {mode === "crop" && (
            <div className="flex flex-col items-center p-4 space-y-3">
              <p className="text-[10px] text-muted-foreground">
                Click and drag on the image to select a crop region. Useful for isolating your subject from group photos or removing unwanted background.
              </p>
              {imgLoaded ? (
                <div className="relative">
                  <canvas
                    ref={canvasRef}
                    className="rounded-lg cursor-crosshair border border-border"
                    onMouseDown={handleCropMouseDown}
                    onMouseMove={handleCropMouseMove}
                    onMouseUp={handleCropMouseUp}
                    onMouseLeave={handleCropMouseUp}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading image...
                </div>
              )}

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[10px]"
                  onClick={() => setCropRect(null)}
                >
                  <RotateCcw className="w-3 h-3 mr-1" /> Reset
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-[10px] bg-orange-600 hover:bg-orange-700"
                  onClick={handleSaveCrop}
                  disabled={!cropRect || cropRect.w < 32 || cropRect.h < 32 || saving}
                >
                  {saving ? (
                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Saving...</>
                  ) : (
                    <><Check className="w-3 h-3 mr-1" /> Save Crop to Dataset</>
                  )}
                </Button>
                {cropRect && (
                  <span className="text-[9px] text-muted-foreground font-mono">
                    {Math.round(cropRect.w)}×{Math.round(cropRect.h)}px
                  </span>
                )}
              </div>
            </div>
          )}

          {mode === "mask" && (
            <div className="h-[70vh]">
              <MaskPainter
                initialImageUrl={imageUrl}
                onMaskComplete={handleMaskComplete}
                onCancel={onClose}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function loadBlobAsImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}
