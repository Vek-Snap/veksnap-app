"use client";

import { useRef, useMemo, useCallback, useState, useEffect } from "react";

export interface WaveformSegment {
  id: string;
  startTime: number;
  endTime: number;
  label?: string;
  energy?: number; // 0–1 normalized energy for this segment
}

interface WaveformTimelineProps {
  /** Normalized peak amplitudes (0–1), one per visual bucket */
  peaks: number[];
  /** Total audio duration in seconds */
  duration: number;
  /** Segment boundaries to overlay */
  segments: WaveformSegment[];
  /** Beat markers (timestamps in seconds) */
  beats?: number[];
  /** Energy data points */
  energy?: Array<{ time: number; rms: number }>;
  /** Currently selected segment index */
  selectedSegment?: number;
  /** Called when user clicks a segment */
  onSegmentClick?: (index: number) => void;
  /** Called when segment boundaries are dragged (future) */
  onSegmentResize?: (index: number, newStart: number, newEnd: number) => void;
  /** Height of the waveform display */
  height?: number;
}

export default function WaveformTimeline({
  peaks,
  duration,
  segments,
  beats = [],
  energy = [],
  selectedSegment,
  onSegmentClick,
  height = 80,
}: WaveformTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // Observe container width for responsive canvas
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(Math.floor(entry.contentRect.width));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Compute segment colors based on energy
  const segmentColors = useMemo(() => {
    if (!energy.length || !segments.length) return segments.map(() => "rgba(217, 70, 239, 0.15)"); // fuchsia default
    
    return segments.map((seg) => {
      // Average energy in this segment's time range
      const windowsInRange = energy.filter((e) => e.time >= seg.startTime && e.time < seg.endTime);
      if (!windowsInRange.length) return "rgba(217, 70, 239, 0.15)";
      const avgRms = windowsInRange.reduce((s, e) => s + e.rms, 0) / windowsInRange.length;
      // Map energy to color: low = cool blue, mid = fuchsia, high = warm amber
      if (avgRms > 0.5) return `rgba(251, 191, 36, ${0.1 + avgRms * 0.2})`; // amber
      if (avgRms > 0.25) return `rgba(217, 70, 239, ${0.1 + avgRms * 0.2})`; // fuchsia
      return `rgba(96, 165, 250, ${0.1 + avgRms * 0.15})`; // blue
    });
  }, [segments, energy]);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks.length || duration <= 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = containerWidth;
    const h = height;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Draw segment backgrounds
    segments.forEach((seg, i) => {
      const x1 = (seg.startTime / duration) * w;
      const x2 = (seg.endTime / duration) * w;
      ctx.fillStyle = segmentColors[i];
      if (selectedSegment === i) {
        ctx.fillStyle = "rgba(217, 70, 239, 0.3)";
      }
      ctx.fillRect(x1, 0, x2 - x1, h);

      // Segment boundary line
      ctx.strokeStyle = "rgba(217, 70, 239, 0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x2, 0);
      ctx.lineTo(x2, h);
      ctx.stroke();

      // Segment number label
      const segW = x2 - x1;
      if (segW > 14) {
        ctx.fillStyle = "rgba(217, 70, 239, 0.5)";
        ctx.font = "8px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(`${i + 1}`, x1 + segW / 2, 9);
      }
    });

    // Draw waveform bars
    const barW = Math.max(1, w / peaks.length);
    const centerY = h / 2;
    const maxBarH = h * 0.45;

    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * w;
      const amp = peaks[i];
      const barH = amp * maxBarH;

      // Color based on amplitude
      const alpha = 0.4 + amp * 0.6;
      ctx.fillStyle = `rgba(217, 70, 239, ${alpha})`;
      ctx.fillRect(x, centerY - barH, Math.max(1, barW - 0.5), barH * 2);
    }

    // Draw beat markers
    ctx.strokeStyle = "rgba(251, 191, 36, 0.6)";
    ctx.lineWidth = 1;
    beats.forEach((beatTime) => {
      const x = (beatTime / duration) * w;
      ctx.beginPath();
      ctx.moveTo(x, h - 6);
      ctx.lineTo(x, h);
      ctx.stroke();
    });

    // Draw energy curve overlay
    if (energy.length > 1) {
      ctx.strokeStyle = "rgba(251, 191, 36, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      energy.forEach((e, i) => {
        const x = (e.time / duration) * w;
        const y = h - e.rms * h * 0.3 - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Draw hover cursor
    if (hoverTime !== null) {
      const x = (hoverTime / duration) * w;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Time label
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.font = "9px system-ui";
      ctx.textAlign = x > w / 2 ? "right" : "left";
      const offsetX = x > w / 2 ? -4 : 4;
      const mins = Math.floor(hoverTime / 60);
      const secs = (hoverTime % 60).toFixed(1);
      ctx.fillText(`${mins}:${secs.padStart(4, "0")}`, x + offsetX, h - 2);
    }
  }, [peaks, duration, segments, beats, energy, segmentColors, selectedSegment, hoverTime, containerWidth, height]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || duration <= 0) return;
      const x = e.clientX - rect.left;
      const time = (x / rect.width) * duration;
      setHoverTime(Math.max(0, Math.min(duration, time)));
    },
    [duration]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || duration <= 0 || !onSegmentClick) return;
      const x = e.clientX - rect.left;
      const time = (x / rect.width) * duration;
      // Find which segment was clicked
      const idx = segments.findIndex((s) => time >= s.startTime && time < s.endTime);
      if (idx >= 0) onSegmentClick(idx);
    },
    [duration, segments, onSegmentClick]
  );

  // Time axis labels
  const timeLabels = useMemo(() => {
    if (duration <= 0) return [];
    const labels: Array<{ time: number; label: string }> = [];
    // Show a label every 10–30 seconds depending on duration
    const interval = duration > 120 ? 30 : duration > 60 ? 15 : 10;
    for (let t = 0; t <= duration; t += interval) {
      const mins = Math.floor(t / 60);
      const secs = Math.floor(t % 60);
      labels.push({ time: t, label: `${mins}:${String(secs).padStart(2, "0")}` });
    }
    return labels;
  }, [duration]);

  return (
    <div ref={containerRef} className="w-full space-y-0.5">
      <canvas
        ref={canvasRef}
        className="w-full cursor-crosshair rounded border border-fuchsia-500/20 bg-black/30"
        style={{ height: `${height}px` }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverTime(null)}
        onClick={handleClick}
      />
      {/* Time axis */}
      <div className="relative w-full" style={{ height: "12px" }}>
        {timeLabels.map((tl) => (
          <span
            key={tl.time}
            className="absolute text-[7px] text-muted-foreground/40 -translate-x-1/2"
            style={{ left: `${(tl.time / duration) * 100}%` }}
          >
            {tl.label}
          </span>
        ))}
      </div>
    </div>
  );
}
