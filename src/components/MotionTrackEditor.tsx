"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Check, X, Undo2, GripVertical, MousePointer2, Spline, Eye, EyeOff, Paintbrush, Move, Eraser, RotateCw, ZoomIn, ZoomOut, Maximize, ChevronDown, ChevronRight, Unlink, Group } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import type { MotionTrack, MotionTrackPoint, MotionTrackEasing } from "@/lib/types";

// ── Catmull-Rom spline interpolation (matches Lightricks LTXVSparseTrackEditor) ──

function catmullRom(
  p0: MotionTrackPoint, p1: MotionTrackPoint, p2: MotionTrackPoint, p3: MotionTrackPoint, t: number
): MotionTrackPoint {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function interpolateSpline(controlPoints: MotionTrackPoint[], numSamples: number): MotionTrackPoint[] {
  if (controlPoints.length === 0) return [];
  if (controlPoints.length === 1) return Array(numSamples).fill(controlPoints[0]);
  if (controlPoints.length === 2) {
    const [a, b] = controlPoints;
    return Array.from({ length: numSamples }, (_, i) => ({
      x: a.x + (b.x - a.x) * i / (numSamples - 1),
      y: a.y + (b.y - a.y) * i / (numSamples - 1),
    }));
  }
  const pts = [controlPoints[0], ...controlPoints, controlPoints[controlPoints.length - 1]];
  const nSeg = pts.length - 3;
  const result: MotionTrackPoint[] = [];
  for (let i = 0; i < numSamples; i++) {
    const gT = (i / (numSamples - 1)) * nSeg;
    const seg = Math.min(Math.floor(gT), nSeg - 1);
    const lT = gT - seg;
    result.push(catmullRom(pts[seg], pts[seg + 1], pts[seg + 2], pts[seg + 3], lT));
  }
  return result;
}

// ── Track colors palette ──
const TRACK_COLORS = [
  "#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7",
  "#ec4899", "#06b6d4", "#f97316", "#8b5cf6", "#14b8a6",
];

function nextTrackId(): string {
  return `trk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── Region Mask → Constellation helpers ──

/**
 * Convert a binary mask (Uint8Array, 1=painted, 0=empty, at maskW×maskH) into
 * a grid of normalized (0-1) sample points inside the mask region.
 * `spacing` is in normalised units (e.g. 0.05 = 20×20 grid).
 */
function sampleMaskGrid(
  mask: Uint8Array, maskW: number, maskH: number, spacing: number
): MotionTrackPoint[] {
  const pts: MotionTrackPoint[] = [];
  const stepX = Math.max(1, Math.round(spacing * maskW));
  const stepY = Math.max(1, Math.round(spacing * maskH));
  for (let y = Math.floor(stepY / 2); y < maskH; y += stepY) {
    for (let x = Math.floor(stepX / 2); x < maskW; x += stepX) {
      if (mask[y * maskW + x]) {
        pts.push({ x: x / maskW, y: y / maskH });
      }
    }
  }
  return pts;
}

// ── Props ──

interface Props {
  tracks: MotionTrack[];
  onTracksChange: (tracks: MotionTrack[]) => void;
  onClose: () => void;
  imageUrl: string;     // source image URL to display as background
  imageWidth: number;   // natural width
  imageHeight: number;  // natural height
}

// ── Control point hit-testing ──
const HIT_RADIUS = 10; // px

export default function MotionTrackEditor({ tracks, onTracksChange, onClose, imageUrl, imageWidth, imageHeight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  // Track state
  const makeDefaultTrack = (colorIdx: number): MotionTrack => ({
    id: nextTrackId(), points: [], color: TRACK_COLORS[colorIdx % TRACK_COLORS.length],
    label: "", startTime: 0, endTime: 0, easing: "linear" as MotionTrackEasing,
    enabled: true, dotSize: 1.0,
  });
  const [localTracks, setLocalTracks] = useState<MotionTrack[]>(() =>
    tracks.length > 0 ? tracks.map((t) => ({
      ...makeDefaultTrack(0), ...t,
    })) : [makeDefaultTrack(0)]
  );
  const [activeTrackIdx, setActiveTrackIdx] = useState(0);
  const [dragInfo, setDragInfo] = useState<{ trackIdx: number; pointIdx: number } | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{ trackIdx: number; pointIdx: number } | null>(null);
  const [undoStack, setUndoStack] = useState<MotionTrack[][]>([]);

  // ── Region Mask state ──
  type EditorMode = "points" | "mask";
  const [editorMode, setEditorMode] = useState<EditorMode>("points");
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const [maskBrushSize, setMaskBrushSize] = useState(30); // px on display
  const [maskErasing, setMaskErasing] = useState(false);
  const [maskPainting, setMaskPainting] = useState(false);
  const [maskDirAngle, setMaskDirAngle] = useState(0);       // degrees: 0=right, 90=down
  const [maskMagnitude, setMaskMagnitude] = useState(0.05);   // normalised movement amount
  const [maskDensity, setMaskDensity] = useState(0.04);       // normalised spacing between dots
  const maskDataRef = useRef<Uint8Array | null>(null);
  const maskSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const [maskCursorPos, setMaskCursorPos] = useState<{ x: number; y: number } | null>(null);

  // ── Group state ──
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupWaypointAngle, setGroupWaypointAngle] = useState(0);
  const [groupWaypointMagnitude, setGroupWaypointMagnitude] = useState(0.05);

  // ── Zoom & Pan state ──
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0); // px offset
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Canvas display size (fit to container while preserving aspect ratio)
  const [displayW, setDisplayW] = useState(0);
  const [displayH, setDisplayH] = useState(0);

  // Load background image
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Fit canvas to container
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !imageWidth || !imageHeight) return;
    const observer = new ResizeObserver(() => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const scale = Math.min(cw / imageWidth, ch / imageHeight);
      setDisplayW(Math.round(imageWidth * scale));
      setDisplayH(Math.round(imageHeight * scale));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [imageWidth, imageHeight]);

  // ── Coordinate transforms ──
  const normToCanvas = useCallback((p: MotionTrackPoint) => ({
    x: p.x * displayW,
    y: p.y * displayH,
  }), [displayW, displayH]);

  const canvasToNorm = useCallback((cx: number, cy: number): MotionTrackPoint => ({
    x: Math.max(0, Math.min(1, cx / displayW)),
    y: Math.max(0, Math.min(1, cy / displayH)),
  }), [displayW, displayH]);

  // ── Mask canvas helpers ──
  const clearMask = useCallback(() => {
    const mc = maskCanvasRef.current;
    if (!mc) return;
    const mctx = mc.getContext("2d");
    if (mctx) mctx.clearRect(0, 0, mc.width, mc.height);
    if (maskDataRef.current) maskDataRef.current.fill(0);
  }, []);

  const initMaskCanvas = useCallback(() => {
    const mc = maskCanvasRef.current;
    if (!mc || !displayW || !displayH) return;
    mc.width = displayW;
    mc.height = displayH;
    maskSizeRef.current = { w: displayW, h: displayH };
    if (!maskDataRef.current || maskDataRef.current.length !== displayW * displayH) {
      maskDataRef.current = new Uint8Array(displayW * displayH);
    }
  }, [displayW, displayH]);

  useEffect(() => {
    if (editorMode === "mask") initMaskCanvas();
  }, [editorMode, initMaskCanvas]);

  const paintMaskAt = useCallback((cx: number, cy: number, erase: boolean) => {
    const mc = maskCanvasRef.current;
    const mctx = mc?.getContext("2d");
    if (!mc || !mctx || !maskDataRef.current) return;
    const r = maskBrushSize / 2;
    if (erase) {
      mctx.save();
      mctx.globalCompositeOperation = "destination-out";
      mctx.beginPath();
      mctx.arc(cx, cy, r, 0, Math.PI * 2);
      mctx.fill();
      mctx.restore();
    } else {
      mctx.fillStyle = "rgba(255, 140, 0, 0.45)";
      mctx.beginPath();
      mctx.arc(cx, cy, r, 0, Math.PI * 2);
      mctx.fill();
    }
    // Update binary mask data
    const { w, h } = maskSizeRef.current;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          maskDataRef.current[y * w + x] = erase ? 0 : 1;
        }
      }
    }
  }, [maskBrushSize]);

  const handleMaskPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const rect = maskCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = (e.clientX - rect.left) / zoom;
    const cy = (e.clientY - rect.top) / zoom;
    setMaskPainting(true);
    paintMaskAt(cx, cy, maskErasing);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [paintMaskAt, maskErasing, zoom]);

  const handleMaskPointerMove = useCallback((e: React.PointerEvent) => {
    const rect = maskCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = (e.clientX - rect.left) / zoom;
    const cy = (e.clientY - rect.top) / zoom;
    setMaskCursorPos({ x: cx, y: cy });
    if (maskPainting) {
      paintMaskAt(cx, cy, maskErasing);
    }
  }, [maskPainting, paintMaskAt, maskErasing, zoom]);

  const handleMaskPointerUp = useCallback(() => {
    setMaskPainting(false);
  }, []);

  // ── Canvas rendering ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !displayW || !displayH) return;

    canvas.width = displayW;
    canvas.height = displayH;
    ctx.clearRect(0, 0, displayW, displayH);

    // Background image
    if (imgRef.current && imgLoaded) {
      ctx.drawImage(imgRef.current, 0, 0, displayW, displayH);
      // Slight dim for better track visibility
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.fillRect(0, 0, displayW, displayH);
    }

    // Draw each track
    const activeGroupId = localTracks[activeTrackIdx]?.groupId;
    for (let ti = 0; ti < localTracks.length; ti++) {
      const track = localTracks[ti];
      const isActive = ti === activeTrackIdx;
      const isGroupSibling = !isActive && !!activeGroupId && track.groupId === activeGroupId;
      const color = track.color;
      const isDisabled = track.enabled === false;
      const alpha = isDisabled ? 0.2 : isActive ? 1.0 : isGroupSibling ? 0.8 : 0.5;

      if (track.points.length >= 2) {
        // Interpolated spline curve
        const interp = interpolateSpline(track.points, Math.max(track.points.length * 20, 60));
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha * 0.7;
        ctx.lineWidth = isActive ? 3 : 2;
        ctx.setLineDash(isDisabled ? [6, 4] : []);
        const first = normToCanvas(interp[0]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < interp.length; i++) {
          const p = normToCanvas(interp[i]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        // Direction arrow at end
        if (interp.length >= 2) {
          const end = normToCanvas(interp[interp.length - 1]);
          const prev = normToCanvas(interp[interp.length - 2]);
          const angle = Math.atan2(end.y - prev.y, end.x - prev.x);
          const arrowLen = 12;
          ctx.beginPath();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = color;
          ctx.moveTo(end.x, end.y);
          ctx.lineTo(end.x - arrowLen * Math.cos(angle - 0.4), end.y - arrowLen * Math.sin(angle - 0.4));
          ctx.lineTo(end.x - arrowLen * Math.cos(angle + 0.4), end.y - arrowLen * Math.sin(angle + 0.4));
          ctx.closePath();
          ctx.fill();
        }
      }

      // Control points
      ctx.globalAlpha = alpha;
      for (let pi = 0; pi < track.points.length; pi++) {
        const cp = normToCanvas(track.points[pi]);
        const isHovered = hoveredPoint?.trackIdx === ti && hoveredPoint?.pointIdx === pi;
        const isDragging = dragInfo?.trackIdx === ti && dragInfo?.pointIdx === pi;
        const radius = isHovered || isDragging ? 7 : 5;

        // Outer ring
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, radius + 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fill();

        // Inner dot
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = pi === 0 ? "#ffffff" : pi === track.points.length - 1 ? color : "#dddddd";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Index label
        if (isActive) {
          ctx.fillStyle = "#000";
          ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(pi + 1), cp.x, cp.y);
        }
      }

      // Track label + timing info near first control point
      if (track.points.length > 0) {
        const labelPt = normToCanvas(track.points[0]);
        ctx.globalAlpha = alpha;
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        // Build label: name + time range
        const namePart = track.label || `Track ${ti + 1}`;
        const hasCustomTime = (track.startTime && track.startTime > 0) || (track.endTime && track.endTime > 0);
        const timePart = hasCustomTime
          ? ` [${(track.startTime ?? 0).toFixed(1)}s–${(track.endTime && track.endTime > 0) ? track.endTime.toFixed(1) + "s" : "end"}]`
          : "";
        const disabledPart = isDisabled ? " (off)" : "";
        const labelText = namePart + timePart + disabledPart;
        const textW = ctx.measureText(labelText).width;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(labelPt.x + 10, labelPt.y - 18, textW + 6, 16);
        ctx.fillStyle = isDisabled ? "#888" : color;
        ctx.fillText(labelText, labelPt.x + 13, labelPt.y - 5);
      }
    }
    ctx.globalAlpha = 1;
  }, [localTracks, activeTrackIdx, displayW, displayH, imgLoaded, normToCanvas, hoveredPoint, dragInfo]);

  useEffect(() => { draw(); }, [draw]);

  // ── Push undo state ──
  const pushUndo = useCallback(() => {
    setUndoStack((prev) => [...prev.slice(-19), localTracks.map((t) => ({ ...t, points: [...t.points] }))]);
  }, [localTracks]);

  // ── Region Mask → Constellation generator ──
  const generateConstellationFromMask = useCallback(() => {
    if (!maskDataRef.current) return;
    const { w, h } = maskSizeRef.current;
    const samples = sampleMaskGrid(maskDataRef.current, w, h, maskDensity);
    if (samples.length === 0) return;

    // Convert angle (degrees) + magnitude to normalised dx/dy
    const rad = (maskDirAngle * Math.PI) / 180;
    const dx = Math.cos(rad) * maskMagnitude;
    const dy = Math.sin(rad) * maskMagnitude;

    pushUndo();
    // Create one 2-point track per sample point, all share a groupId
    const gid = `grp_${Date.now()}`;
    const newTracks: MotionTrack[] = samples.map((pt, i) => ({
      id: `rgn_${Date.now()}_${i}`,
      points: [
        { x: pt.x, y: pt.y },
        { x: Math.max(0, Math.min(1, pt.x + dx)), y: Math.max(0, Math.min(1, pt.y + dy)) },
      ],
      color: TRACK_COLORS[(localTracks.length + i) % TRACK_COLORS.length],
      label: "",
      startTime: 0,
      endTime: 0,
      easing: "linear" as MotionTrackEasing,
      enabled: true,
      dotSize: 1.0,
      groupId: gid,
    }));

    setLocalTracks((prev) => [...prev, ...newTracks]);
    setActiveTrackIdx(localTracks.length); // select first new track
    setCollapsedGroups((prev) => new Set([...prev, gid])); // auto-collapse the new group
    clearMask();
    setEditorMode("points"); // switch back so user can see/edit the generated tracks
  }, [maskDensity, maskDirAngle, maskMagnitude, localTracks, pushUndo, clearMask]);

  // ── Zoom helpers ──
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, []);

  // Register non-passive wheel handler so preventDefault works (React onWheel is passive)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;

      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((prev) => {
        const next = Math.max(0.5, Math.min(12, prev * zoomFactor));
        const scale = next / prev;
        setPanX((px) => cx - scale * (cx - px));
        setPanY((py) => cy - scale * (cy - py));
        return next;
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // ── Pan via middle-click or Ctrl+left-click on container ──
  const handleContainerPointerDown = useCallback((e: React.PointerEvent) => {
    // Middle button (1) or Ctrl+left (0)
    if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, [panX, panY]);

  const handleContainerPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning || !panStartRef.current) return;
    const dx = e.clientX - panStartRef.current.x;
    const dy = e.clientY - panStartRef.current.y;
    setPanX(panStartRef.current.px + dx);
    setPanY(panStartRef.current.py + dy);
  }, [isPanning]);

  const handleContainerPointerUp = useCallback((e: React.PointerEvent) => {
    if (isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  }, [isPanning]);

  // ── Mouse handlers ──
  const getCanvasPos = useCallback((e: React.MouseEvent): { cx: number; cy: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { cx: 0, cy: 0 };
    // Account for CSS transform (zoom/pan) by using getBoundingClientRect which reflects transforms
    return { cx: (e.clientX - rect.left) / zoom, cy: (e.clientY - rect.top) / zoom };
  }, [zoom]);

  const findHitPoint = useCallback((cx: number, cy: number): { trackIdx: number; pointIdx: number } | null => {
    // Prioritize active track
    for (const ti of [activeTrackIdx, ...localTracks.map((_, i) => i).filter((i) => i !== activeTrackIdx)]) {
      const track = localTracks[ti];
      if (!track) continue;
      for (let pi = 0; pi < track.points.length; pi++) {
        const cp = normToCanvas(track.points[pi]);
        const dx = cx - cp.x;
        const dy = cy - cp.y;
        if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
          return { trackIdx: ti, pointIdx: pi };
        }
      }
    }
    return null;
  }, [activeTrackIdx, localTracks, normToCanvas]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Skip if Ctrl+click or middle-click (used for panning)
    if (e.ctrlKey || e.button === 1) return;
    e.preventDefault();
    const { cx, cy } = getCanvasPos(e);
    const hit = findHitPoint(cx, cy);

    if (hit) {
      // Start dragging existing point
      setDragInfo(hit);
      if (hit.trackIdx !== activeTrackIdx) setActiveTrackIdx(hit.trackIdx);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    // Add new point to active track
    pushUndo();
    const norm = canvasToNorm(cx, cy);
    setLocalTracks((prev) => prev.map((t, i) =>
      i === activeTrackIdx ? { ...t, points: [...t.points, norm] } : t
    ));
  }, [getCanvasPos, findHitPoint, activeTrackIdx, canvasToNorm, pushUndo]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const { cx, cy } = getCanvasPos(e);

    if (dragInfo) {
      // Dragging a point: apply group drag if track belongs to a group
      const norm = canvasToNorm(cx, cy);
      const draggedTrack = localTracks[dragInfo.trackIdx];
      const gid = draggedTrack?.groupId;

      if (gid && !e.shiftKey) {
        // Group drag: move all same-index points in the group by same delta
        const oldPt = draggedTrack.points[dragInfo.pointIdx];
        const dx = norm.x - oldPt.x;
        const dy = norm.y - oldPt.y;
        setLocalTracks((prev) => prev.map((t) => {
          if (t.groupId !== gid) return t;
          const pi = dragInfo.pointIdx;
          if (pi >= t.points.length) return t;
          return {
            ...t,
            points: t.points.map((p, idx) =>
              idx === pi
                ? { x: Math.max(0, Math.min(1, p.x + dx)), y: Math.max(0, Math.min(1, p.y + dy)) }
                : p
            ),
          };
        }));
      } else {
        // Solo drag (ungrouped or Shift held)
        setLocalTracks((prev) => prev.map((t, ti) =>
          ti === dragInfo.trackIdx
            ? { ...t, points: t.points.map((p, pi) => pi === dragInfo.pointIdx ? norm : p) }
            : t
        ));
      }
      return;
    }

    // Hover detection
    const hit = findHitPoint(cx, cy);
    setHoveredPoint(hit);
  }, [getCanvasPos, dragInfo, canvasToNorm, findHitPoint, localTracks]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (dragInfo) {
      pushUndo();
      setDragInfo(null);
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  }, [dragInfo, pushUndo]);

  // ── Track management ──
  const addTrack = useCallback(() => {
    pushUndo();
    const colorIdx = localTracks.length % TRACK_COLORS.length;
    const newTrack: MotionTrack = makeDefaultTrack(colorIdx);
    setLocalTracks((prev) => [...prev, newTrack]);
    setActiveTrackIdx(localTracks.length);
  }, [localTracks, pushUndo]);

  const removeTrack = useCallback((idx: number) => {
    if (localTracks.length <= 1) return;
    pushUndo();
    setLocalTracks((prev) => prev.filter((_, i) => i !== idx));
    setActiveTrackIdx((prev) => Math.min(prev, localTracks.length - 2));
  }, [localTracks, pushUndo]);

  const removeLastPoint = useCallback(() => {
    const track = localTracks[activeTrackIdx];
    if (!track || track.points.length === 0) return;
    pushUndo();
    setLocalTracks((prev) => prev.map((t, i) =>
      i === activeTrackIdx ? { ...t, points: t.points.slice(0, -1) } : t
    ));
  }, [localTracks, activeTrackIdx, pushUndo]);

  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setLocalTracks(prev);
  }, [undoStack]);

  // ── Group helpers ──
  const ungroupTracks = useCallback((groupId: string) => {
    pushUndo();
    setLocalTracks((prev) => prev.map((t) =>
      t.groupId === groupId ? { ...t, groupId: undefined } : t
    ));
    setCollapsedGroups((prev) => { const next = new Set(prev); next.delete(groupId); return next; });
  }, [pushUndo]);

  const deleteGroup = useCallback((groupId: string) => {
    pushUndo();
    setLocalTracks((prev) => {
      const remaining = prev.filter((t) => t.groupId !== groupId);
      return remaining.length > 0 ? remaining : [makeDefaultTrack(0)];
    });
    setActiveTrackIdx(0);
    setCollapsedGroups((prev) => { const next = new Set(prev); next.delete(groupId); return next; });
  }, [pushUndo]);

  const toggleGroupVisibility = useCallback((groupId: string) => {
    const groupTracks = localTracks.filter((t) => t.groupId === groupId);
    const allEnabled = groupTracks.every((t) => t.enabled !== false);
    setLocalTracks((prev) => prev.map((t) =>
      t.groupId === groupId ? { ...t, enabled: !allEnabled } : t
    ));
  }, [localTracks]);

  const toggleGroupCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }, []);

  const addGroupWaypoint = useCallback((groupId: string, angle: number, magnitude: number) => {
    pushUndo();
    const rad = (angle * Math.PI) / 180;
    const dx = Math.cos(rad) * magnitude;
    const dy = Math.sin(rad) * magnitude;
    setLocalTracks((prev) => prev.map((t) => {
      if (t.groupId !== groupId) return t;
      const lastPt = t.points[t.points.length - 1];
      if (!lastPt) return t;
      const newPt: MotionTrackPoint = {
        x: Math.max(0, Math.min(1, lastPt.x + dx)),
        y: Math.max(0, Math.min(1, lastPt.y + dy)),
      };
      return { ...t, points: [...t.points, newPt] };
    }));
  }, [pushUndo]);

  const removeGroupLastWaypoint = useCallback((groupId: string) => {
    // Only allow if tracks have more than 2 points
    const groupTracks = localTracks.filter((t) => t.groupId === groupId);
    if (groupTracks.length === 0 || groupTracks[0].points.length <= 2) return;
    pushUndo();
    setLocalTracks((prev) => prev.map((t) => {
      if (t.groupId !== groupId) return t;
      if (t.points.length <= 2) return t;
      return { ...t, points: t.points.slice(0, -1) };
    }));
  }, [pushUndo, localTracks]);

  // ── Right-click removes nearest point ──
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { cx, cy } = getCanvasPos(e);
    const hit = findHitPoint(cx, cy);
    if (hit) {
      pushUndo();
      setLocalTracks((prev) => prev.map((t, ti) =>
        ti === hit.trackIdx
          ? { ...t, points: t.points.filter((_, pi) => pi !== hit.pointIdx) }
          : t
      ));
    }
  }, [getCanvasPos, findHitPoint, pushUndo]);

  // ── Save / Cancel ──
  const handleSave = useCallback(() => {
    // Filter out empty tracks
    const validTracks = localTracks.filter((t) => t.points.length >= 2);
    onTracksChange(validTracks);
    onClose();
  }, [localTracks, onTracksChange, onClose]);

  const totalPoints = localTracks.reduce((sum, t) => sum + t.points.length, 0);

  return (
    <Card className="w-full h-full flex flex-col overflow-hidden bg-background/95 backdrop-blur-sm border-cyan-500/30">
      <CardHeader className="py-2 px-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Spline className="w-4 h-4 text-cyan-400" />
            Motion Track Editor
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[9px] h-5">
              {localTracks.length} track{localTracks.length !== 1 ? "s" : ""} · {totalPoints} pts
            </Badge>
            <div className="flex items-center gap-0.5 border border-border/50 rounded px-1 h-6">
              <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}>
                <ZoomOut className="w-3 h-3" />
              </Button>
              <span className="text-[9px] text-muted-foreground w-8 text-center font-mono">{Math.round(zoom * 100)}%</span>
              <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={() => setZoom((z) => Math.min(12, z * 1.25))}>
                <ZoomIn className="w-3 h-3" />
              </Button>
              <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={resetZoom} disabled={zoom === 1 && panX === 0 && panY === 0} title="Reset zoom">
                <Maximize className="w-3 h-3" />
              </Button>
            </div>
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={undo} disabled={undoStack.length === 0}>
              <Undo2 className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-destructive" onClick={onClose}>
              <X className="w-3 h-3" />
            </Button>
            <Button size="sm" className="h-6 px-3 bg-cyan-600 hover:bg-cyan-700 text-white text-[10px]" onClick={handleSave}>
              <Check className="w-3 h-3 mr-1" /> Apply
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex gap-2 p-2 overflow-hidden min-h-0">
        {/* Track list sidebar */}
        <div className="w-52 flex-shrink-0 flex flex-col gap-1.5 overflow-y-auto">
          <Label className="text-[9px] text-muted-foreground uppercase tracking-wider px-1">Tracks</Label>
          {(() => {
            // Build ordered list of sidebar items: group headers + individual tracks
            const rendered: React.ReactNode[] = [];
            const seenGroups = new Set<string>();

            for (let idx = 0; idx < localTracks.length; idx++) {
              const track = localTracks[idx];
              const gid = track.groupId;

              // If this track belongs to a group, render group header first (once)
              if (gid && !seenGroups.has(gid)) {
                seenGroups.add(gid);
                const groupMembers = localTracks.filter((t) => t.groupId === gid);
                const groupIndices = localTracks.map((t, i) => t.groupId === gid ? i : -1).filter((i) => i >= 0);
                const isCollapsed = collapsedGroups.has(gid);
                const activeGroupId = localTracks[activeTrackIdx]?.groupId;
                const isGroupActive = activeGroupId === gid;
                const allEnabled = groupMembers.every((t) => t.enabled !== false);

                rendered.push(
                  <div key={`grp_${gid}`} className="space-y-0.5">
                    {/* Group header */}
                    <div
                      className={`flex items-center gap-1 p-1 rounded-md cursor-pointer text-[10px] transition-colors ${
                        isGroupActive
                          ? "bg-orange-500/15 border border-orange-500/40 text-orange-300"
                          : "bg-muted/40 border border-muted-foreground/20 hover:bg-muted/60 text-muted-foreground"
                      }`}
                      onClick={() => toggleGroupCollapse(gid)}
                    >
                      {isCollapsed ? <ChevronRight className="w-3 h-3 flex-shrink-0" /> : <ChevronDown className="w-3 h-3 flex-shrink-0" />}
                      <Group className="w-3 h-3 flex-shrink-0 text-orange-400/70" />
                      <span className="flex-1 truncate text-[9px] font-medium">
                        Constellation ({groupMembers.length} × {groupMembers[0]?.points.length ?? 0}pts)
                      </span>
                      <button
                        className="flex-shrink-0"
                        onClick={(e) => { e.stopPropagation(); toggleGroupVisibility(gid); }}
                        title={allEnabled ? "Hide group" : "Show group"}
                      >
                        {allEnabled
                          ? <Eye className="w-2.5 h-2.5 text-orange-400/70" />
                          : <EyeOff className="w-2.5 h-2.5 text-muted-foreground/40" />
                        }
                      </button>
                      <button
                        className="flex-shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
                        onClick={(e) => { e.stopPropagation(); ungroupTracks(gid); }}
                        title="Ungroup tracks"
                      >
                        <Unlink className="w-2.5 h-2.5" />
                      </button>
                      <button
                        className="flex-shrink-0 text-destructive/50 hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); deleteGroup(gid); }}
                        title="Delete entire group"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                    {/* Collapsed: skip individual tracks */}
                    {!isCollapsed && groupIndices.map((gi) => {
                      const gt = localTracks[gi];
                      return (
                        <div
                          key={gt.id}
                          className={`flex items-center gap-1.5 p-1 pl-5 rounded-md cursor-pointer text-[10px] transition-colors ${
                            gi === activeTrackIdx
                              ? "bg-cyan-500/15 border border-cyan-500/40 text-cyan-300"
                              : "bg-muted/20 border border-transparent hover:bg-muted/40 text-muted-foreground"
                          }`}
                          onClick={() => setActiveTrackIdx(gi)}
                        >
                          <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: gt.color, opacity: gt.enabled !== false ? 1 : 0.3 }} />
                          <span className="flex-1 truncate text-[9px]">{gt.label || `Track ${gi + 1}`}</span>
                          <Badge variant="outline" className="text-[7px] h-3.5 px-0.5">{gt.points.length}</Badge>
                        </div>
                      );
                    })}
                  </div>
                );
                continue; // skip individual rendering for first group member
              }

              // Skip remaining group members (already rendered under header)
              if (gid && seenGroups.has(gid)) continue;

              // Ungrouped track: render normally
              rendered.push(
                <div
                  key={track.id}
                  className={`flex items-center gap-1.5 p-1.5 rounded-md cursor-pointer text-[10px] transition-colors ${
                    idx === activeTrackIdx
                      ? "bg-cyan-500/15 border border-cyan-500/40 text-cyan-300"
                      : "bg-muted/30 border border-transparent hover:bg-muted/50 text-muted-foreground"
                  }`}
                  onClick={() => setActiveTrackIdx(idx)}
                >
                  <button
                    className="flex-shrink-0"
                    onClick={(e) => { e.stopPropagation(); setLocalTracks((prev) => prev.map((t, i) => i === idx ? { ...t, enabled: !t.enabled } : t)); }}
                    title={track.enabled !== false ? "Disable track" : "Enable track"}
                  >
                    {track.enabled !== false
                      ? <Eye className="w-3 h-3 text-cyan-400" />
                      : <EyeOff className="w-3 h-3 text-muted-foreground/40" />
                    }
                  </button>
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: track.color, opacity: track.enabled !== false ? 1 : 0.3 }} />
                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      className="w-full bg-transparent border-none outline-none text-[10px] placeholder:text-muted-foreground/50 p-0"
                      placeholder={`Track ${idx + 1}`}
                      value={track.label}
                      onChange={(e) => {
                        const val = e.target.value;
                        setLocalTracks((prev) => prev.map((t, i) => i === idx ? { ...t, label: val } : t));
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <Badge variant="outline" className="text-[8px] h-4 px-1">{track.points.length}</Badge>
                  {localTracks.length > 1 && (
                    <button
                      className="text-destructive/60 hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); removeTrack(idx); }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            }

            return rendered;
          })()}
          <Button size="sm" variant="ghost" className="h-6 text-[10px] w-full justify-start" onClick={addTrack}>
            <Plus className="w-3 h-3 mr-1" /> Add Track
          </Button>

          {/* Active track properties */}
          {localTracks[activeTrackIdx] && (
            <div className="mt-1 p-1.5 rounded-md bg-cyan-500/5 border border-cyan-500/20 space-y-1.5">
              <Label className="text-[8px] text-cyan-400 uppercase tracking-wider">Track Timing</Label>
              <div className="grid grid-cols-2 gap-1">
                <div>
                  <label className="text-[8px] text-muted-foreground">Start (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    className="w-full bg-background/50 border border-border/50 rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-cyan-500/50"
                    value={localTracks[activeTrackIdx].startTime ?? 0}
                    onChange={(e) => {
                      const v = Math.max(0, parseFloat(e.target.value) || 0);
                      setLocalTracks((prev) => prev.map((t, i) => i === activeTrackIdx ? { ...t, startTime: v } : t));
                    }}
                  />
                </div>
                <div>
                  <label className="text-[8px] text-muted-foreground">End (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    className="w-full bg-background/50 border border-border/50 rounded px-1.5 py-0.5 text-[10px] outline-none focus:border-cyan-500/50"
                    value={localTracks[activeTrackIdx].endTime ?? 0}
                    placeholder="0=full"
                    onChange={(e) => {
                      const v = Math.max(0, parseFloat(e.target.value) || 0);
                      setLocalTracks((prev) => prev.map((t, i) => i === activeTrackIdx ? { ...t, endTime: v } : t));
                    }}
                  />
                </div>
              </div>
              <div>
                <label className="text-[8px] text-muted-foreground">Easing</label>
                <select
                  className="w-full bg-background/50 border border-border/50 rounded px-1 py-0.5 text-[10px] outline-none focus:border-cyan-500/50"
                  value={localTracks[activeTrackIdx].easing ?? "linear"}
                  onChange={(e) => {
                    const v = e.target.value as MotionTrackEasing;
                    setLocalTracks((prev) => prev.map((t, i) => i === activeTrackIdx ? { ...t, easing: v } : t));
                  }}
                >
                  <option value="linear">Linear (constant speed)</option>
                  <option value="ease-in">Ease In (accelerate)</option>
                  <option value="ease-out">Ease Out (decelerate)</option>
                  <option value="ease-in-out">Ease In-Out (smooth)</option>
                </select>
              </div>
              <p className="text-[7px] text-muted-foreground/60 leading-tight">
                Start 0 = beginning of video. End 0 = end of video. Dot stays stationary outside the active window.
              </p>
            </div>
          )}

          {/* Group waypoint controls: show when active track is in a group */}
          {localTracks[activeTrackIdx]?.groupId && (
            <div className="mt-1 p-1.5 rounded-md bg-orange-500/5 border border-orange-500/20 space-y-1.5">
              <Label className="text-[8px] text-orange-400 uppercase tracking-wider">
                Group Waypoint ({localTracks[activeTrackIdx].points.length} pts)
              </Label>
              <p className="text-[7px] text-muted-foreground/60 leading-tight">
                Add a new waypoint to all tracks in this constellation. Each track extends from its current endpoint.
              </p>
              {/* Direction */}
              <div className="space-y-0.5">
                <label className="text-[8px] text-muted-foreground flex items-center gap-1">
                  <Move className="w-2.5 h-2.5" /> Direction: {groupWaypointAngle}°
                  <span className="text-[7px] text-muted-foreground/50">
                    ({groupWaypointAngle === 0 ? "→" : groupWaypointAngle === 90 ? "↓" : groupWaypointAngle === 180 ? "←" : groupWaypointAngle === 270 ? "↑" : `${groupWaypointAngle}°`})
                  </span>
                </label>
                <Slider
                  min={0} max={359} step={1}
                  value={[groupWaypointAngle]}
                  onValueChange={([v]) => setGroupWaypointAngle(v)}
                  className="w-full"
                />
              </div>
              {/* Magnitude */}
              <div className="space-y-0.5">
                <label className="text-[8px] text-muted-foreground">Magnitude: {(groupWaypointMagnitude * 100).toFixed(0)}%</label>
                <Slider
                  min={0.5} max={30} step={0.5}
                  value={[groupWaypointMagnitude * 100]}
                  onValueChange={([v]) => setGroupWaypointMagnitude(v / 100)}
                  className="w-full"
                />
              </div>
              {/* Add / Remove buttons */}
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="flex-1 h-6 text-[9px] bg-orange-600 hover:bg-orange-700 text-white"
                  onClick={() => addGroupWaypoint(localTracks[activeTrackIdx].groupId!, groupWaypointAngle, groupWaypointMagnitude)}
                >
                  <Plus className="w-3 h-3 mr-0.5" /> Add Waypoint
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[9px] px-2 border-orange-500/30 text-orange-400"
                  onClick={() => removeGroupLastWaypoint(localTracks[activeTrackIdx].groupId!)}
                  disabled={localTracks[activeTrackIdx].points.length <= 2}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
              <p className="text-[7px] text-muted-foreground/50 leading-tight">
                After adding, <strong>drag</strong> any new point to reposition the entire group&apos;s waypoint. Hold <strong>Shift</strong> to move one track only.
              </p>
            </div>
          )}

          {/* Mode toggle */}
          <div className="mt-2 pt-2 border-t border-border/50 space-y-1.5">
            <Label className="text-[8px] text-muted-foreground uppercase tracking-wider">Tool Mode</Label>
            <div className="flex gap-1">
              <button
                className={`flex-1 flex items-center justify-center gap-1 text-[9px] py-1 rounded border transition-colors ${
                  editorMode === "points"
                    ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                    : "border-border/60 bg-muted/10 text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setEditorMode("points")}
              >
                <MousePointer2 className="w-3 h-3" /> Points
              </button>
              <button
                className={`flex-1 flex items-center justify-center gap-1 text-[9px] py-1 rounded border transition-colors ${
                  editorMode === "mask"
                    ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                    : "border-border/60 bg-muted/10 text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setEditorMode("mask")}
              >
                <Paintbrush className="w-3 h-3" /> Region
              </button>
            </div>
          </div>

          {editorMode === "points" ? (
            <div className="mt-auto pt-2 space-y-1 border-t border-border/50">
              <p className="text-[8px] text-muted-foreground leading-tight px-1">
                <strong>Click</strong> canvas to add points.
                <br /><strong>Drag</strong> points to reposition.
                <br /><strong>Right-click</strong> point to remove.
                <br /><strong>Scroll</strong> to zoom, <strong>Ctrl+drag</strong> to pan.
                <br /><strong>Group drag</strong>: dragging a grouped point moves all matching points. Hold <strong>Shift</strong> to solo-drag.
              </p>
              <Button size="sm" variant="outline" className="h-5 text-[9px] w-full" onClick={removeLastPoint}>
                Remove Last Point
              </Button>
            </div>
          ) : (
            <div className="mt-2 pt-2 space-y-2 border-t border-orange-500/20">
              <Label className="text-[8px] text-orange-400 uppercase tracking-wider">Region Mask → Constellation</Label>
              <p className="text-[7px] text-muted-foreground/60 leading-tight">
                Paint a region on the image. The mask will be filled with a constellation of motion dots
                that all move in the same direction.
              </p>

              {/* Brush controls */}
              <div className="flex items-center gap-1.5">
                <button
                  className={`flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded border transition-colors ${
                    !maskErasing
                      ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                      : "border-border/60 text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setMaskErasing(false)}
                >
                  <Paintbrush className="w-2.5 h-2.5" /> Paint
                </button>
                <button
                  className={`flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded border transition-colors ${
                    maskErasing
                      ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                      : "border-border/60 text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setMaskErasing(true)}
                >
                  <Eraser className="w-2.5 h-2.5" /> Erase
                </button>
                <button
                  className="flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={clearMask}
                >
                  <X className="w-2.5 h-2.5" /> Clear
                </button>
              </div>

              {/* Brush size */}
              <div className="space-y-0.5">
                <label className="text-[8px] text-muted-foreground">Brush Size: {maskBrushSize}px</label>
                <Slider
                  min={5} max={120} step={1}
                  value={[maskBrushSize]}
                  onValueChange={([v]) => setMaskBrushSize(v)}
                  className="w-full"
                />
              </div>

              {/* Direction angle */}
              <div className="space-y-0.5">
                <label className="text-[8px] text-muted-foreground flex items-center gap-1">
                  <Move className="w-2.5 h-2.5" /> Direction: {maskDirAngle}°
                  <span className="text-[7px] text-muted-foreground/50">
                    ({maskDirAngle === 0 ? "→" : maskDirAngle === 90 ? "↓" : maskDirAngle === 180 ? "←" : maskDirAngle === 270 ? "↑" : `${maskDirAngle}°`})
                  </span>
                </label>
                <Slider
                  min={0} max={359} step={1}
                  value={[maskDirAngle]}
                  onValueChange={([v]) => setMaskDirAngle(v)}
                  className="w-full"
                />
              </div>

              {/* Magnitude */}
              <div className="space-y-0.5">
                <label className="text-[8px] text-muted-foreground">Magnitude: {(maskMagnitude * 100).toFixed(0)}%</label>
                <Slider
                  min={0.5} max={30} step={0.5}
                  value={[maskMagnitude * 100]}
                  onValueChange={([v]) => setMaskMagnitude(v / 100)}
                  className="w-full"
                />
              </div>

              {/* Dot density */}
              <div className="space-y-0.5">
                <label className="text-[8px] text-muted-foreground">Dot Spacing: {(maskDensity * 100).toFixed(0)}%</label>
                <Slider
                  min={1} max={15} step={0.5}
                  value={[maskDensity * 100]}
                  onValueChange={([v]) => setMaskDensity(v / 100)}
                  className="w-full"
                />
                <p className="text-[7px] text-muted-foreground/50">
                  Lower = denser grid (more tracks). ~3-5% recommended.
                </p>
              </div>

              {/* Generate button */}
              <Button
                size="sm"
                className="h-7 text-[10px] w-full bg-orange-600 hover:bg-orange-700 text-white"
                onClick={generateConstellationFromMask}
              >
                <RotateCw className="w-3 h-3 mr-1" /> Generate Constellation
              </Button>
            </div>
          )}
        </div>

        {/* Canvas area */}
        <div
          ref={containerRef}
          className="flex-1 flex items-center justify-center bg-black/20 rounded-md overflow-hidden min-w-0 min-h-0"
          onPointerDown={handleContainerPointerDown}
          onPointerMove={handleContainerPointerMove}
          onPointerUp={handleContainerPointerUp}
          style={{ cursor: isPanning ? "grabbing" : undefined }}
        >
          <div
            className="relative"
            style={{
              width: displayW, height: displayH,
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              transformOrigin: "center center",
            }}
          >
            {/* Main track canvas (always visible) */}
            <canvas
              ref={canvasRef}
              width={displayW}
              height={displayH}
              style={{ position: "absolute", top: 0, left: 0, width: displayW, height: displayH,
                cursor: editorMode === "mask" ? "none" : dragInfo ? "grabbing" : hoveredPoint ? "grab" : "crosshair",
                pointerEvents: editorMode === "mask" ? "none" : "auto",
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onContextMenu={handleContextMenu}
            />
            {/* Mask overlay canvas (only interactive in mask mode) */}
            {editorMode === "mask" && (
              <>
                <canvas
                  ref={maskCanvasRef}
                  width={displayW}
                  height={displayH}
                  style={{ position: "absolute", top: 0, left: 0, width: displayW, height: displayH,
                    cursor: "none", zIndex: 10,
                  }}
                  onPointerDown={handleMaskPointerDown}
                  onPointerMove={handleMaskPointerMove}
                  onPointerUp={handleMaskPointerUp}
                  onPointerLeave={() => setMaskCursorPos(null)}
                />
                {/* Brush cursor circle */}
                {maskCursorPos && (
                  <div
                    style={{
                      position: "absolute",
                      left: maskCursorPos.x - maskBrushSize / 2,
                      top: maskCursorPos.y - maskBrushSize / 2,
                      width: maskBrushSize,
                      height: maskBrushSize,
                      borderRadius: "50%",
                      border: `2px solid ${maskErasing ? "#ef4444" : "#f59e0b"}`,
                      pointerEvents: "none",
                      zIndex: 20,
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
