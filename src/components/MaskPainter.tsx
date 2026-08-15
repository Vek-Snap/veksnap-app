"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Paintbrush, Eraser, Check, X, Upload, Download, RotateCcw, Undo2, Redo2, Wand2, Loader2, UserRound, Feather, Grid3x3, RectangleHorizontal, Circle } from "lucide-react";

const GRID_COLS = 4;
const GRID_ROWS = 3;

const MAX_HISTORY = 20;

type ToolMode = "paint" | "erase" | "quickselect" | "rect" | "ellipse";

interface Props {
  onMaskComplete: (
    maskBlob: Blob,
    sourceBlob: Blob,
    sourceWidth: number,
    sourceHeight: number
  ) => void;
  onCancel: () => void;
  initialImageUrl?: string;
  initialMaskUrl?: string;
  initialFeather?: number;
  onFeatherChange?: (feather: number) => void;
}

// ── Color-distance helper for Quick Selection ──
function colorDist(d: Uint8ClampedArray, i: number, r: number, g: number, b: number): number {
  const dr = d[i] - r;
  const dg = d[i + 1] - g;
  const db = d[i + 2] - b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export default function MaskPainter({ onMaskComplete, onCancel, initialImageUrl, initialMaskUrl, initialFeather, onFeatherChange }: Props) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imgNatW, setImgNatW] = useState(0);
  const [imgNatH, setImgNatH] = useState(0);
  const [brushSize, setBrushSize] = useState(30);
  const [tool, setTool] = useState<ToolMode>("paint");
  const [isPainting, setIsPainting] = useState(false);
  const [selTolerance, setSelTolerance] = useState(32);
  const [selectingSubject, setSelectingSubject] = useState(false);
  const [feather, setFeatherLocal] = useState(initialFeather ?? 0); // px of Gaussian blur on mask edges
  const setFeather = (v: number) => { setFeatherLocal(v); onFeatherChange?.(v); };

  // Effective mode ref: set on pointer-down based on tool + Ctrl/Alt modifiers
  // For paint/erase: "paint" or "erase" (Ctrl forces paint, Alt forces erase)
  // For quickselect: stored as subtract boolean in qsSubtractRef
  const effectiveModeRef = useRef<"paint" | "erase">("paint");
  const qsSubtractRef = useRef(false);
  const lastQsPos = useRef<{ x: number; y: number } | null>(null);

  // Brush cursor state
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [showCursor, setShowCursor] = useState(false);

  // Quick Region Grid state: 4×3 clickable cells for instant region masking
  const [gridCells, setGridCells] = useState<Set<number>>(new Set());

  // Shape tool drag state (rect / ellipse)
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [shapePreview, setShapePreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Undo / redo
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const undoStack = useRef<ImageData[]>([]);
  const redoStack = useRef<ImageData[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Keep the original file blob for lossless re-export
  const originalFileRef = useRef<Blob | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  // Zoom / pan state  (Ctrl+Wheel = zoom, Space+Drag / Middle-drag = pan, Home = reset)
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const [isPanningUI, setIsPanningUI] = useState(false);
  const panStartRef = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const spaceHeldRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // ── Snapshot helpers ──
  const saveMaskSnapshot = useCallback(() => {
    const mc = maskCanvasRef.current;
    if (!mc) return;
    const ctx = mc.getContext("2d")!;
    const snap = ctx.getImageData(0, 0, mc.width, mc.height);
    undoStack.current.push(snap);
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setUndoCount(undoStack.current.length);
    setRedoCount(0);
  }, []);

  const refreshDisplay = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    const displayCanvas = canvasRef.current;
    if (!maskCanvas || !displayCanvas || !imgRef.current) return;
    const w = displayCanvas.width;
    const h = displayCanvas.height;
    const dCtx = displayCanvas.getContext("2d")!;
    dCtx.clearRect(0, 0, w, h);
    dCtx.drawImage(imgRef.current, 0, 0);
    dCtx.save();
    dCtx.globalAlpha = 0.4;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tCtx = tmp.getContext("2d")!;
    tCtx.fillStyle = "rgba(0, 200, 255, 1)";
    tCtx.fillRect(0, 0, w, h);
    tCtx.globalCompositeOperation = "destination-in";
    // Apply feather blur visually so user sees the soft edges
    if (feather > 0) tCtx.filter = `blur(${feather}px)`;
    tCtx.drawImage(maskCanvas, 0, 0);
    tCtx.filter = "none";
    dCtx.drawImage(tmp, 0, 0);
    dCtx.restore();
  }, [feather]);

  const handleUndo = useCallback(() => {
    const mc = maskCanvasRef.current;
    if (!mc || undoStack.current.length === 0) return;
    const ctx = mc.getContext("2d")!;
    // Save current state to redo
    redoStack.current.push(ctx.getImageData(0, 0, mc.width, mc.height));
    const snap = undoStack.current.pop()!;
    ctx.putImageData(snap, 0, 0);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    refreshDisplay();
  }, [refreshDisplay]);

  const handleRedo = useCallback(() => {
    const mc = maskCanvasRef.current;
    if (!mc || redoStack.current.length === 0) return;
    const ctx = mc.getContext("2d")!;
    // Save current state to undo
    undoStack.current.push(ctx.getImageData(0, 0, mc.width, mc.height));
    const snap = redoStack.current.pop()!;
    ctx.putImageData(snap, 0, 0);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
    refreshDisplay();
  }, [refreshDisplay]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      }
      // Space = pan mode (hold)
      if (e.code === "Space" && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
      }
      // Home = reset zoom/pan to fit
      if (e.key === "Home") {
        resetView();
      }
    };
    const upHandler = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeldRef.current = false;
        setSpaceHeld(false);
      }
    };
    window.addEventListener("keydown", handler);
    window.addEventListener("keyup", upHandler);
    return () => {
      window.removeEventListener("keydown", handler);
      window.removeEventListener("keyup", upHandler);
    };
  }, [handleUndo, handleRedo, resetView]);

  // Ctrl+Wheel zoom centered on cursor
  const handleWheel = useCallback((e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((prev) => {
      const next = Math.max(0.25, Math.min(10, prev * factor));
      const ratio = next / prev;
      setPanOffset((p) => ({
        x: mx - (mx - p.x) * ratio,
        y: my - (my - p.y) * ratio,
      }));
      return next;
    });
  }, []);

  // Attach wheel listener as non-passive so we can preventDefault (block browser zoom)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel, imageSrc]);

  // Refresh display when feather changes so user sees the soft edges live
  useEffect(() => {
    if (imgNatW && imgNatH) refreshDisplay();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feather]);

  // Load initial image
  useEffect(() => {
    if (initialImageUrl && !imageSrc) {
      setImageSrc(initialImageUrl);
      const img = new Image();
      img.onload = () => {
        setImgNatW(img.naturalWidth);
        setImgNatH(img.naturalHeight);
        imgRef.current = img;
      };
      img.src = initialImageUrl;
      // Try to fetch as blob for lossless re-export
      fetch(initialImageUrl).then((r) => r.blob()).then((b) => { originalFileRef.current = b; }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImageUrl]);

  // Init canvases when image loads
  useEffect(() => {
    if (!imgNatW || !imgNatH) return;
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!canvas || !maskCanvas) return;

    canvas.width = imgNatW;
    canvas.height = imgNatH;
    maskCanvas.width = imgNatW;
    maskCanvas.height = imgNatH;

    const ctx = canvas.getContext("2d")!;
    if (imgRef.current) ctx.drawImage(imgRef.current, 0, 0);

    const mCtx = maskCanvas.getContext("2d")!;
    mCtx.clearRect(0, 0, imgNatW, imgNatH);

    // Reset history and zoom/pan
    undoStack.current = [];
    redoStack.current = [];
    setUndoCount(0);
    resetView();
    setRedoCount(0);

    // Load initial mask if provided (for re-editing)
    if (initialMaskUrl) {
      const maskImg = new Image();
      maskImg.onload = () => {
        mCtx.drawImage(maskImg, 0, 0, imgNatW, imgNatH);
        // Convert to alpha mask: any non-black pixel → white with full alpha
        const data = mCtx.getImageData(0, 0, imgNatW, imgNatH);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const brightness = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          const on = brightness > 32 ? 255 : 0;
          d[i] = on; d[i + 1] = on; d[i + 2] = on; d[i + 3] = on;
        }
        mCtx.putImageData(data, 0, 0);
        refreshDisplay();
      };
      maskImg.crossOrigin = "anonymous";
      maskImg.src = initialMaskUrl;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgNatW, imgNatH]);

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    originalFileRef.current = file;
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    const img = new Image();
    img.onload = () => {
      setImgNatW(img.naturalWidth);
      setImgNatH(img.naturalHeight);
      imgRef.current = img;
    };
    img.src = url;
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // ── Canvas coordinate helpers (zoom/pan aware) ──
  const getCanvasPos = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return { x: 0, y: 0 };
    const cRect = container.getBoundingClientRect();
    const baseScale = cRect.width / canvas.width;
    return {
      x: (clientX - cRect.left - panOffset.x) / (baseScale * zoom),
      y: (clientY - cRect.top - panOffset.y) / (baseScale * zoom),
    };
  }, [zoom, panOffset]);

  const getDisplayScale = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return 1;
    const cRect = container.getBoundingClientRect();
    return (cRect.width / canvas.width) * zoom;
  }, [zoom]);

  // ── Draw a brush stroke on the mask ──
  const drawStroke = useCallback((x: number, y: number, fromX?: number, fromY?: number) => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas || !imgRef.current) return;

    const mCtx = maskCanvas.getContext("2d")!;
    mCtx.globalCompositeOperation = effectiveModeRef.current === "erase" ? "destination-out" : "source-over";
    mCtx.strokeStyle = "#ffffff";
    mCtx.fillStyle = "#ffffff";
    mCtx.lineWidth = brushSize;
    mCtx.lineCap = "round";
    mCtx.lineJoin = "round";

    if (fromX !== undefined && fromY !== undefined) {
      mCtx.beginPath();
      mCtx.moveTo(fromX, fromY);
      mCtx.lineTo(x, y);
      mCtx.stroke();
    } else {
      mCtx.beginPath();
      mCtx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      mCtx.fill();
    }

    refreshDisplay();
  }, [brushSize, refreshDisplay]);

  // ── Quick Selection: edge-aware flood fill ──
  const quickSelect = useCallback((cx: number, cy: number, subtract: boolean) => {
    const mc = maskCanvasRef.current;
    if (!mc || !imgRef.current) return;

    // Read source image pixel data
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = imgNatW;
    srcCanvas.height = imgNatH;
    const sCtx = srcCanvas.getContext("2d")!;
    sCtx.drawImage(imgRef.current, 0, 0);
    const srcData = sCtx.getImageData(0, 0, imgNatW, imgNatH);
    const sd = srcData.data;

    const px = Math.round(cx);
    const py = Math.round(cy);
    if (px < 0 || py < 0 || px >= imgNatW || py >= imgNatH) return;

    // Sample seed color
    const si = (py * imgNatW + px) * 4;
    const seedR = sd[si], seedG = sd[si + 1], seedB = sd[si + 2];

    // BFS flood fill within tolerance
    const visited = new Uint8Array(imgNatW * imgNatH);
    const selected = new Uint8Array(imgNatW * imgNatH);
    const queue: number[] = [px, py];
    const tol = selTolerance;

    while (queue.length > 0) {
      const qy = queue.pop()!;
      const qx = queue.pop()!;
      const idx = qy * imgNatW + qx;
      if (visited[idx]) continue;
      visited[idx] = 1;

      const pi = idx * 4;
      if (colorDist(sd, pi, seedR, seedG, seedB) > tol) continue;
      selected[idx] = 1;

      if (qx > 0) { queue.push(qx - 1, qy); }
      if (qx < imgNatW - 1) { queue.push(qx + 1, qy); }
      if (qy > 0) { queue.push(qx, qy - 1); }
      if (qy < imgNatH - 1) { queue.push(qx, qy + 1); }
    }

    // Apply selection to mask
    const mCtx = mc.getContext("2d")!;
    const maskImgData = mCtx.getImageData(0, 0, imgNatW, imgNatH);
    const md = maskImgData.data;

    for (let i = 0; i < selected.length; i++) {
      if (selected[i]) {
        const mi = i * 4;
        if (subtract) {
          md[mi] = 0; md[mi + 1] = 0; md[mi + 2] = 0; md[mi + 3] = 0;
        } else {
          md[mi] = 255; md[mi + 1] = 255; md[mi + 2] = 255; md[mi + 3] = 255;
        }
      }
    }
    mCtx.putImageData(maskImgData, 0, 0);
    refreshDisplay();
  }, [imgNatW, imgNatH, selTolerance, refreshDisplay]);

  // ── Quick Region Grid: toggle mask for a grid cell ──
  const toggleGridCell = useCallback((cellIdx: number) => {
    const mc = maskCanvasRef.current;
    if (!mc || !imgRef.current) return;
    saveMaskSnapshot();
    const mCtx = mc.getContext("2d")!;
    const col = cellIdx % GRID_COLS;
    const row = Math.floor(cellIdx / GRID_COLS);
    const cellW = Math.ceil(imgNatW / GRID_COLS);
    const cellH = Math.ceil(imgNatH / GRID_ROWS);
    const x = col * cellW;
    const y = row * cellH;
    setGridCells(prev => {
      const next = new Set(prev);
      if (next.has(cellIdx)) {
        mCtx.globalCompositeOperation = "destination-out";
        mCtx.fillStyle = "#ffffff";
        mCtx.fillRect(x, y, cellW, cellH);
        next.delete(cellIdx);
      } else {
        mCtx.globalCompositeOperation = "source-over";
        mCtx.fillStyle = "#ffffff";
        mCtx.fillRect(x, y, cellW, cellH);
        next.add(cellIdx);
      }
      return next;
    });
    refreshDisplay();
  }, [imgNatW, imgNatH, saveMaskSnapshot, refreshDisplay]);

  // ── Shape tool: draw rectangle or ellipse on mask ──
  const drawShapeOnMask = useCallback((x: number, y: number, w: number, h: number, shape: "rect" | "ellipse", erase: boolean) => {
    const mc = maskCanvasRef.current;
    if (!mc) return;
    const mCtx = mc.getContext("2d")!;
    mCtx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    mCtx.fillStyle = "#ffffff";
    if (shape === "rect") {
      mCtx.fillRect(x, y, w, h);
    } else {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = Math.abs(w) / 2;
      const ry = Math.abs(h) / 2;
      mCtx.beginPath();
      mCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      mCtx.fill();
    }
    refreshDisplay();
  }, [refreshDisplay]);

  // ── Pointer handlers ──
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    // Pan mode: Space held or middle mouse button
    if (spaceHeldRef.current || e.button === 1) {
      isPanningRef.current = true;
      setIsPanningUI(true);
      panStartRef.current = { mx: e.clientX, my: e.clientY, px: panOffset.x, py: panOffset.y };
      return;
    }

    const pos = getCanvasPos(e.clientX, e.clientY);

    // Determine effective mode from Ctrl/Alt modifiers
    // Ctrl = add (paint / select), Alt = subtract (erase / deselect)
    if (e.altKey) {
      effectiveModeRef.current = "erase";
      qsSubtractRef.current = true;
    } else if (e.ctrlKey) {
      effectiveModeRef.current = "paint";
      qsSubtractRef.current = false;
    } else {
      effectiveModeRef.current = tool === "erase" ? "erase" : "paint";
      qsSubtractRef.current = false;
    }

    saveMaskSnapshot();

    if (tool === "quickselect") {
      setIsPainting(true);
      lastQsPos.current = pos;
      quickSelect(pos.x, pos.y, qsSubtractRef.current);
      return;
    }

    // Shape tools: record start position, drawing happens on release
    if (tool === "rect" || tool === "ellipse") {
      setIsPainting(true);
      shapeStartRef.current = pos;
      setShapePreview(null);
      return;
    }

    setIsPainting(true);
    lastPos.current = pos;
    drawStroke(pos.x, pos.y);
  }, [getCanvasPos, drawStroke, saveMaskSnapshot, tool, quickSelect, panOffset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // Update cursor position relative to container (for orb overlay)
    const container = containerRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    }

    // Pan mode: update offset
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.mx;
      const dy = e.clientY - panStartRef.current.my;
      setPanOffset({ x: panStartRef.current.px + dx, y: panStartRef.current.py + dy });
      return;
    }

    if (!isPainting) return;

    const pos = getCanvasPos(e.clientX, e.clientY);

    // Quick select drag: flood fill at new position (throttled by distance)
    if (tool === "quickselect") {
      const last = lastQsPos.current;
      if (last) {
        const dx = pos.x - last.x;
        const dy = pos.y - last.y;
        if (dx * dx + dy * dy < 100) return; // min 10px movement
      }
      lastQsPos.current = pos;
      quickSelect(pos.x, pos.y, qsSubtractRef.current);
      return;
    }

    // Shape drag preview
    if ((tool === "rect" || tool === "ellipse") && shapeStartRef.current) {
      const s = shapeStartRef.current;
      setShapePreview({
        x: Math.min(s.x, pos.x),
        y: Math.min(s.y, pos.y),
        w: Math.abs(pos.x - s.x),
        h: Math.abs(pos.y - s.y),
      });
      return;
    }

    if (lastPos.current) {
      drawStroke(pos.x, pos.y, lastPos.current.x, lastPos.current.y);
    }
    lastPos.current = pos;
  }, [isPainting, getCanvasPos, drawStroke, tool, quickSelect]);

  const handlePointerUp = useCallback(() => {
    // Commit shape if dragging rect/ellipse
    if ((tool === "rect" || tool === "ellipse") && shapeStartRef.current && shapePreview) {
      const erase = effectiveModeRef.current === "erase";
      drawShapeOnMask(shapePreview.x, shapePreview.y, shapePreview.w, shapePreview.h, tool, erase);
      shapeStartRef.current = null;
      setShapePreview(null);
    }
    isPanningRef.current = false;
    setIsPanningUI(false);
    setIsPainting(false);
    lastPos.current = null;
    lastQsPos.current = null;
  }, [tool, shapePreview, drawShapeOnMask]);

  // ── Clear mask ──
  const handleInvert = () => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    saveMaskSnapshot();
    const mCtx = maskCanvas.getContext("2d")!;
    const data = mCtx.getImageData(0, 0, imgNatW, imgNatH);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      // If pixel has any opacity → clear it; if transparent → make it white
      const on = d[i + 3] > 0;
      d[i] = on ? 0 : 255;
      d[i + 1] = on ? 0 : 255;
      d[i + 2] = on ? 0 : 255;
      d[i + 3] = on ? 0 : 255;
    }
    mCtx.putImageData(data, 0, 0);
    refreshDisplay();
  };

  const handleClear = () => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas || !imgRef.current) return;
    saveMaskSnapshot();
    const mCtx = maskCanvas.getContext("2d")!;
    mCtx.clearRect(0, 0, imgNatW, imgNatH);
    refreshDisplay();
  };

  // ── Export mask as PNG download ──
  const handleExportMask = () => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = imgNatW;
    exportCanvas.height = imgNatH;
    const ctx = exportCanvas.getContext("2d")!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, imgNatW, imgNatH);
    ctx.drawImage(maskCanvas, 0, 0);

    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `veksnap_mask_${imgNatW}x${imgNatH}_${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  // ── Import mask from file ──
  const handleImportMask = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (ev) => {
      const file = (ev.target as HTMLInputElement).files?.[0];
      if (!file || !maskCanvasRef.current) return;
      const mc = maskCanvasRef.current;
      const mCtx = mc.getContext("2d")!;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        saveMaskSnapshot();
        // Draw imported mask onto mask canvas (white regions become selected)
        mCtx.clearRect(0, 0, imgNatW, imgNatH);
        mCtx.drawImage(img, 0, 0, imgNatW, imgNatH);
        // Convert to alpha mask: any non-black pixel → white with full alpha
        const data = mCtx.getImageData(0, 0, imgNatW, imgNatH);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const brightness = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          const on = brightness > 32 ? 255 : 0;
          d[i] = on; d[i + 1] = on; d[i + 2] = on; d[i + 3] = on;
        }
        mCtx.putImageData(data, 0, 0);
        refreshDisplay();
        URL.revokeObjectURL(url);
      };
      img.src = url;
    };
    input.click();
  };

  // ── Select Subject via RMBG (background removal model) ──
  const handleSelectSubject = useCallback(async () => {
    if (!imgRef.current || !maskCanvasRef.current || !originalFileRef.current) return;
    setSelectingSubject(true);
    try {
      // Upload the source image to ComfyUI input so RMBG can process it
      const srcFile = new File([originalFileRef.current], "subject_src.png", { type: "image/png" });
      const formData = new FormData();
      formData.append("image", srcFile);
      formData.append("overwrite", "true");
      const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
      if (!uploadRes.ok) throw new Error("Failed to upload image for subject detection");
      const { name: imageFile } = await uploadRes.json();

      // Call the select-subject API (queues RMBG workflow + polls)
      const res = await fetch("/api/select-subject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageFile }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Subject selection failed");
      }
      const { filename, subfolder, type } = await res.json();

      // Fetch the mask image from ComfyUI output via proxy
      const maskUrl = `/api/comfyui/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || "")}&type=${encodeURIComponent(type || "output")}`;
      const maskRes = await fetch(maskUrl);
      const maskBlob = await maskRes.blob();
      const maskImg = new Image();
      maskImg.onload = () => {
        const mc = maskCanvasRef.current!;
        const mCtx = mc.getContext("2d")!;
        saveMaskSnapshot();
        mCtx.clearRect(0, 0, imgNatW, imgNatH);
        mCtx.drawImage(maskImg, 0, 0, imgNatW, imgNatH);
        // Threshold to clean binary mask
        const data = mCtx.getImageData(0, 0, imgNatW, imgNatH);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const brightness = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          const on = brightness > 32 ? 255 : 0;
          d[i] = on; d[i + 1] = on; d[i + 2] = on; d[i + 3] = on;
        }
        mCtx.putImageData(data, 0, 0);
        refreshDisplay();
        URL.revokeObjectURL(maskImg.src);
      };
      maskImg.src = URL.createObjectURL(maskBlob);
    } catch (err) {
      console.error("Select Subject failed:", err);
      alert(err instanceof Error ? err.message : "Select Subject failed");
    } finally {
      setSelectingSubject(false);
    }
  }, [imgNatW, imgNatH, saveMaskSnapshot, refreshDisplay]);

  // ── Confirm: generate mask blob and source blob (lossless) ──
  const handleConfirm = () => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas || !imgRef.current) return;

    // Create black/white mask (with feathering applied if set)
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = imgNatW;
    exportCanvas.height = imgNatH;
    const ctx = exportCanvas.getContext("2d")!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, imgNatW, imgNatH);
    if (feather > 0) ctx.filter = `blur(${feather}px)`;
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.filter = "none";

    exportCanvas.toBlob((maskBlob) => {
      if (!maskBlob) return;

      // Use original file blob if available (lossless, avoids canvas re-encoding)
      if (originalFileRef.current) {
        onMaskComplete(maskBlob, originalFileRef.current, imgNatW, imgNatH);
      } else {
        // Fallback: re-encode from canvas at full resolution
        const srcCanvas = document.createElement("canvas");
        srcCanvas.width = imgNatW;
        srcCanvas.height = imgNatH;
        const sCtx = srcCanvas.getContext("2d")!;
        sCtx.drawImage(imgRef.current!, 0, 0);
        srcCanvas.toBlob((sourceBlob) => {
          if (!sourceBlob) return;
          onMaskComplete(maskBlob, sourceBlob, imgNatW, imgNatH);
        }, "image/png");
      }
    }, "image/png");
  };

  // Brush cursor size in display pixels
  const cursorDisplaySize = brushSize * getDisplayScale();

  return (
    <Card className="border-cyan-500/30 bg-cyan-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Paintbrush className="w-4 h-4 text-cyan-400" />
          Mask Painter: Draw Inpaint Area
          <Badge variant="outline" className="ml-auto text-[10px] border-cyan-500/40 text-cyan-400">
            {imgNatW}×{imgNatH}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!imageSrc ? (
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
            <p className="text-xs text-muted-foreground">Drop an image here</p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">
              Paint over the areas you want the AI to regenerate
            </p>
          </div>
        ) : (
          <>
            {/* Tool bar */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button
                size="sm"
                variant={tool === "paint" ? "default" : "outline"}
                className={`h-7 text-[10px] gap-1 ${tool === "paint" ? "bg-cyan-600 hover:bg-cyan-500" : ""}`}
                onClick={() => setTool("paint")}
              >
                <Paintbrush className="w-3 h-3" /> Paint
              </Button>
              <Button
                size="sm"
                variant={tool === "erase" ? "default" : "outline"}
                className={`h-7 text-[10px] gap-1 ${tool === "erase" ? "bg-orange-600 hover:bg-orange-500" : ""}`}
                onClick={() => setTool("erase")}
              >
                <Eraser className="w-3 h-3" /> Erase
              </Button>
              <Button
                size="sm"
                variant={tool === "quickselect" ? "default" : "outline"}
                className={`h-7 text-[10px] gap-1 ${tool === "quickselect" ? "bg-violet-600 hover:bg-violet-500" : ""}`}
                onClick={() => setTool("quickselect")}
              >
                <Wand2 className="w-3 h-3" /> Quick Select
              </Button>
              <Button
                size="sm"
                variant={tool === "rect" ? "default" : "outline"}
                className={`h-7 text-[10px] gap-1 ${tool === "rect" ? "bg-teal-600 hover:bg-teal-500" : ""}`}
                onClick={() => setTool("rect")}
                title="Draw rectangle mask: click and drag"
              >
                <RectangleHorizontal className="w-3 h-3" /> Rect
              </Button>
              <Button
                size="sm"
                variant={tool === "ellipse" ? "default" : "outline"}
                className={`h-7 text-[10px] gap-1 ${tool === "ellipse" ? "bg-teal-600 hover:bg-teal-500" : ""}`}
                onClick={() => setTool("ellipse")}
                title="Draw ellipse mask: click and drag"
              >
                <Circle className="w-3 h-3" /> Ellipse
              </Button>
              <div className="h-5 w-px bg-border mx-0.5" />
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] gap-1"
                onClick={handleSelectSubject}
                disabled={selectingSubject || !imageSrc}
                title="Auto-select subject using RMBG AI model"
              >
                {selectingSubject ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserRound className="w-3 h-3" />}
                {selectingSubject ? "Detecting..." : "Select Subject"}
              </Button>

              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] gap-1"
                onClick={handleInvert}
                title="Invert mask: swap selected and unselected areas"
              >
                <RotateCcw className="w-3 h-3" /> Invert
              </Button>
              <div className="h-5 w-px bg-border mx-0.5" />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={handleUndo}
                disabled={undoCount === 0}
                title="Undo (Ctrl+Z)"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={handleRedo}
                disabled={redoCount === 0}
                title="Redo (Ctrl+Y)"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </Button>
              {(undoCount > 0 || redoCount > 0) && (
                <span className="text-[9px] text-muted-foreground/50">{undoCount}/{MAX_HISTORY}</span>
              )}
            </div>

            {/* Brush size slider (paint/erase only) */}
            {(tool === "paint" || tool === "erase") && (
              <div className="flex items-center gap-2">
                <Label className="text-[9px] text-muted-foreground whitespace-nowrap">Brush: {brushSize}px</Label>
                <Slider
                  value={[brushSize]}
                  onValueChange={([v]) => setBrushSize(v)}
                  min={5}
                  max={200}
                  step={1}
                  className="flex-1"
                />
              </div>
            )}

            {/* Tolerance slider (quick select) */}
            {tool === "quickselect" && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Label className="text-[9px] text-muted-foreground whitespace-nowrap">Tolerance: {selTolerance}</Label>
                  <Slider
                    value={[selTolerance]}
                    onValueChange={([v]) => setSelTolerance(v)}
                    min={5}
                    max={120}
                    step={1}
                    className="flex-1"
                  />
                </div>
                <p className="text-[9px] text-violet-400/70">
                  Click or drag to select similar colors · <strong>Ctrl</strong> = add · <strong>Alt</strong> = subtract
                </p>
              </div>
            )}

            {/* Feather slider: softens mask edges visually */}
            <div className="flex items-center gap-2">
              <Label className="text-[9px] text-muted-foreground whitespace-nowrap flex items-center gap-1">
                <Feather className="w-3 h-3" /> Feather: {feather}px
              </Label>
              <Slider
                value={[feather]}
                onValueChange={([v]) => { setFeather(v); }}
                min={0}
                max={40}
                step={1}
                className="flex-1"
              />
            </div>

            {/* Quick Region Grid: click cells to instantly mask frame regions */}
            <div className="flex items-center gap-3">
              <div className="space-y-0.5">
                <Label className="text-[9px] text-muted-foreground flex items-center gap-1">
                  <Grid3x3 className="w-3 h-3" /> Quick Region Grid
                </Label>
                <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)` }}>
                  {Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => (
                    <button
                      key={i}
                      className={`w-8 h-6 rounded-sm border transition-colors ${
                        gridCells.has(i)
                          ? "bg-cyan-500/60 border-cyan-400"
                          : "bg-muted/30 border-border/50 hover:bg-cyan-500/20"
                      }`}
                      onClick={() => toggleGridCell(i)}
                      title={`Row ${Math.floor(i / GRID_COLS) + 1}, Col ${(i % GRID_COLS) + 1}`}
                    />
                  ))}
                </div>
              </div>
              <p className="text-[8px] text-muted-foreground/50 leading-snug max-w-[140px]">
                Click cells to instantly mask or unmask frame regions. Combine with brush for fine-tuning.
              </p>
            </div>

            {/* Canvas + cursor overlay */}
            <div
              ref={containerRef}
              className="relative rounded-lg overflow-hidden border border-border bg-black select-none"
              style={{ cursor: isPanningUI ? "grabbing" : spaceHeld ? "grab" : "none" }}
              onMouseEnter={() => setShowCursor(true)}
              onMouseLeave={() => { setShowCursor(false); handlePointerUp(); }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            >
              {/* Transform wrapper for zoom/pan */}
              <div
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                <canvas
                  ref={canvasRef}
                  className="w-full h-auto block"
                  style={{ pointerEvents: "none" }}
                />
              </div>
              {/* Hidden mask canvas */}
              <canvas ref={maskCanvasRef} className="hidden" />

              {/* Shape preview overlay (rect/ellipse drag) */}
              {shapePreview && (tool === "rect" || tool === "ellipse") && (
                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: panOffset.x + shapePreview.x * getDisplayScale(),
                    top: panOffset.y + shapePreview.y * getDisplayScale(),
                    width: shapePreview.w * getDisplayScale(),
                    height: shapePreview.h * getDisplayScale(),
                    border: "2px dashed rgba(0, 200, 255, 0.8)",
                    backgroundColor: "rgba(0, 200, 255, 0.15)",
                    borderRadius: tool === "ellipse" ? "50%" : "0",
                  }}
                />
              )}

              {/* Brush cursor orb (hidden during pan and shape tools) */}
              {showCursor && cursorPos && (tool === "paint" || tool === "erase") && !isPanningUI && !spaceHeld && (
                <div
                  className="pointer-events-none absolute rounded-full border"
                  style={{
                    width: cursorDisplaySize,
                    height: cursorDisplaySize,
                    left: cursorPos.x - cursorDisplaySize / 2,
                    top: cursorPos.y - cursorDisplaySize / 2,
                    backgroundColor: tool === "erase"
                      ? "rgba(249, 115, 22, 0.2)"
                      : "rgba(0, 200, 255, 0.2)",
                    borderColor: tool === "erase"
                      ? "rgba(249, 115, 22, 0.6)"
                      : "rgba(0, 200, 255, 0.6)",
                    transition: "width 0.05s, height 0.05s",
                  }}
                />
              )}
              {/* Quick select crosshair cursor (hidden during pan) */}
              {showCursor && cursorPos && tool === "quickselect" && !isPanningUI && !spaceHeld && (
                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: cursorPos.x - 8,
                    top: cursorPos.y - 8,
                    width: 16,
                    height: 16,
                  }}
                >
                  <Wand2 className="w-4 h-4 text-violet-400 drop-shadow-lg" />
                </div>
              )}

              {/* Zoom indicator: click to reset */}
              {zoom !== 1 && (
                <button
                  className="absolute bottom-1.5 right-1.5 bg-black/70 text-white text-[9px] px-1.5 py-0.5 rounded cursor-pointer hover:bg-black/90 transition-colors border border-white/20"
                  onClick={(e) => { e.stopPropagation(); resetView(); }}
                  title="Reset zoom (Home)"
                >
                  {Math.round(zoom * 100)}%
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <Paintbrush className="w-3 h-3" />
              <span>
                {tool === "quickselect"
                  ? "Click or drag to select similar colors. Ctrl = add, Alt = subtract."
                  : "Paint the areas you want regenerated. Ctrl = paint, Alt = erase."
                }
                {" · "}<strong>Ctrl+Wheel</strong> zoom · <strong>Space+Drag</strong> pan · <strong>Home</strong> reset
              </span>
            </div>

            {/* Tool buttons */}
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="flex-1 text-[10px] h-7 gap-1" onClick={handleClear}>
                <RotateCcw className="w-3 h-3" /> Clear
              </Button>
              <Button size="sm" variant="outline" className="flex-1 text-[10px] h-7 gap-1" onClick={handleImportMask} disabled={!imageSrc}>
                <Upload className="w-3 h-3" /> Import Mask
              </Button>
              <Button size="sm" variant="outline" className="flex-1 text-[10px] h-7 gap-1" onClick={handleExportMask}>
                <Download className="w-3 h-3" /> Export Mask
              </Button>
            </div>
          </>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1 gap-1.5 text-xs" onClick={onCancel}>
            <X className="w-3.5 h-3.5" /> Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1 gap-1.5 text-xs bg-cyan-600 hover:bg-cyan-500"
            disabled={!imageSrc}
            onClick={handleConfirm}
          >
            <Check className="w-3.5 h-3.5" /> Apply Mask
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
