"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause, Scissors, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AudioTrimmerProps {
  /** URL or object URL of the uploaded audio file */
  audioUrl: string;
  /** Maximum allowed duration in seconds (based on video length) */
  maxDuration: number;
  /** Current trim start in seconds */
  trimStart: number;
  /** Current trim end in seconds */
  trimEnd: number;
  /** Callback when trim range changes */
  onTrimChange: (start: number, end: number) => void;
  /** Callback when user confirms the trim (locks video params) */
  onTrimConfirm?: () => void;
  /** Whether the trim is locked (audio has been confirmed) */
  locked?: boolean;
  disabled?: boolean;
  /** Label for the context column (default: "Video") */
  contextLabel?: string;
  /** Hide the lock/confirm button (useful for output trimming) */
  hideConfirm?: boolean;
}

export default function AudioTrimmer({
  audioUrl,
  maxDuration,
  trimStart,
  trimEnd,
  onTrimChange,
  onTrimConfirm,
  locked = false,
  disabled = false,
  contextLabel = "Video",
  hideConfirm = false,
}: AudioTrimmerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const [waveformData, setWaveformData] = useState<Float32Array | null>(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPos, setPlaybackPos] = useState(0);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  const animFrameRef = useRef<number>(0);

  // Decode audio and extract waveform data
  useEffect(() => {
    if (!audioUrl) return;

    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    fetch(audioUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        const channelData = decoded.getChannelData(0);
        setAudioDuration(decoded.duration);

        // Downsample to ~800 points for waveform display
        const samples = 800;
        const blockSize = Math.floor(channelData.length / samples);
        const peaks = new Float32Array(samples);
        for (let i = 0; i < samples; i++) {
          let max = 0;
          const start = i * blockSize;
          for (let j = start; j < start + blockSize && j < channelData.length; j++) {
            const abs = Math.abs(channelData[j]);
            if (abs > max) max = abs;
          }
          peaks[i] = max;
        }
        setWaveformData(peaks);

        // Auto-set trim end to min(audioDuration, maxDuration)
        if (trimEnd === 0) {
          onTrimChange(0, Math.min(decoded.duration, maxDuration));
        }
      })
      .catch((err) => console.error("Audio decode error:", err));

    // Create HTML audio element for playback
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.addEventListener("ended", () => setIsPlaying(false));

    return () => {
      audio.pause();
      audio.removeEventListener("ended", () => setIsPlaying(false));
      ctx.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // Draw waveform
  useEffect(() => {
    if (!waveformData || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const mid = h / 2;

    // Background
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, w, h);

    // Trim region highlight
    if (audioDuration > 0) {
      const startX = (trimStart / audioDuration) * w;
      const endX = (trimEnd / audioDuration) * w;
      ctx.fillStyle = "rgba(59, 130, 246, 0.08)";
      ctx.fillRect(startX, 0, endX - startX, h);
    }

    // Max duration limit line
    if (audioDuration > maxDuration) {
      const limitX = (maxDuration / audioDuration) * w;
      ctx.strokeStyle = "rgba(239, 68, 68, 0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(limitX, 0);
      ctx.lineTo(limitX, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Waveform bars
    const barWidth = w / waveformData.length;
    for (let i = 0; i < waveformData.length; i++) {
      const x = i * barWidth;
      const barH = waveformData[i] * mid * 0.9;
      const t = i / waveformData.length;
      const tSec = t * audioDuration;
      const inTrim = tSec >= trimStart && tSec <= trimEnd;

      ctx.fillStyle = inTrim
        ? "rgba(59, 130, 246, 0.7)"
        : "rgba(100, 100, 100, 0.3)";
      ctx.fillRect(x, mid - barH, Math.max(barWidth - 0.5, 0.5), barH * 2);
    }

    // Trim handles
    if (audioDuration > 0) {
      const startX = (trimStart / audioDuration) * w;
      const endX = (trimEnd / audioDuration) * w;

      // Start handle
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(startX - 1.5, 0, 3, h);
      ctx.beginPath();
      ctx.arc(startX, 8, 5, 0, Math.PI * 2);
      ctx.fill();

      // End handle
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(endX - 1.5, 0, 3, h);
      ctx.beginPath();
      ctx.arc(endX, 8, 5, 0, Math.PI * 2);
      ctx.fill();

      // Playback position
      if (isPlaying && playbackPos > 0) {
        const posX = (playbackPos / audioDuration) * w;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(posX, 0);
        ctx.lineTo(posX, h);
        ctx.stroke();
      }
    }
  }, [waveformData, trimStart, trimEnd, audioDuration, maxDuration, isPlaying, playbackPos]);

  // Playback animation loop
  useEffect(() => {
    if (!isPlaying || !audioRef.current) return;

    const tick = () => {
      if (audioRef.current) {
        setPlaybackPos(audioRef.current.currentTime);
        if (audioRef.current.currentTime >= trimEnd) {
          audioRef.current.pause();
          setIsPlaying(false);
          return;
        }
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, trimEnd]);

  const togglePlayback = useCallback(() => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.currentTime = trimStart;
      audioRef.current.play();
      setIsPlaying(true);
    }
  }, [isPlaying, trimStart]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (locked || disabled || !canvasRef.current || audioDuration === 0) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = (x / rect.width) * audioDuration;

      const startX = (trimStart / audioDuration) * rect.width;
      const endX = (trimEnd / audioDuration) * rect.width;

      if (Math.abs(x - startX) < 12) {
        setDragging("start");
      } else if (Math.abs(x - endX) < 12) {
        setDragging("end");
      } else {
        // Click to set nearest handle
        if (Math.abs(t - trimStart) < Math.abs(t - trimEnd)) {
          onTrimChange(Math.max(0, t), trimEnd);
        } else {
          onTrimChange(trimStart, Math.min(audioDuration, Math.min(t, trimStart + maxDuration)));
        }
      }
    },
    [locked, disabled, audioDuration, trimStart, trimEnd, maxDuration, onTrimChange]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging || !canvasRef.current || audioDuration === 0) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const t = Math.max(0, Math.min((x / rect.width) * audioDuration, audioDuration));

      if (dragging === "start") {
        const newStart = Math.min(t, trimEnd - 0.5);
        // Enforce max duration: end - newStart <= maxDuration
        const effectiveEnd = Math.min(trimEnd, newStart + maxDuration);
        onTrimChange(Math.max(0, newStart), effectiveEnd);
      } else {
        const newEnd = Math.max(t, trimStart + 0.5);
        // Enforce max duration
        onTrimChange(trimStart, Math.min(newEnd, trimStart + maxDuration, audioDuration));
      }
    },
    [dragging, audioDuration, trimStart, trimEnd, maxDuration, onTrimChange]
  );

  const handleMouseUp = useCallback(() => setDragging(null), []);

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

  const trimDuration = trimEnd - trimStart;
  const videoDuration = maxDuration;

  return (
    <div ref={containerRef} className="space-y-1.5">
      {/* Waveform canvas */}
      <div className="relative rounded border border-blue-500/20 overflow-hidden bg-[#0a0a0a]">
        <canvas
          ref={canvasRef}
          className="w-full h-16 cursor-col-resize"
          onMouseDown={handleMouseDown}
        />
        {locked && (
          <div className="absolute inset-0 bg-blue-900/10 flex items-center justify-center pointer-events-none">
            <span className="text-[9px] text-blue-400/60 bg-background/80 px-2 py-0.5 rounded">
              Trim Locked
            </span>
          </div>
        )}
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={togglePlayback}
          disabled={disabled || !audioUrl}
          title={isPlaying ? "Pause" : "Play trimmed section"}
        >
          {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
        </Button>

        <div className="flex-1 text-[9px] text-muted-foreground font-mono">
          <span className="text-blue-400">{trimStart.toFixed(1)}s</span>
          <span className="mx-1">→</span>
          <span className="text-blue-400">{trimEnd.toFixed(1)}s</span>
          <span className="mx-1.5 text-muted-foreground/50">|</span>
          <span>
            Trim: {trimDuration.toFixed(1)}s / {contextLabel}: {videoDuration.toFixed(1)}s
          </span>
          {audioDuration > maxDuration && (
            <span className="text-amber-400/70 ml-1.5">
              (audio {audioDuration.toFixed(1)}s exceeds video)
            </span>
          )}
        </div>

        {!hideConfirm && (
          !locked ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[9px] px-2 border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
              onClick={onTrimConfirm}
              disabled={disabled || trimDuration < 0.5}
              title="Confirm trim and lock video parameters"
            >
              <Scissors className="w-3 h-3 mr-1" />
              Lock Trim
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[9px] px-2 text-muted-foreground/50"
              disabled
              title="Audio trim is locked"
            >
              <Scissors className="w-3 h-3 mr-1" />
              Locked
            </Button>
          )
        )}
      </div>
    </div>
  );
}
