"use client";

// ─────────────────────────────────────────────────────────────────────────────
// VekSnapVideo: an original Vek-Snap video player with a custom hover control
// bar. Replaces Chromium's native <video controls> chrome (skip ±5s, play/pause,
// scrubber, time, volume, pop-out, fullscreen). Deliberately NO captions control.
//
// Pop-out is an IN-APP floating, draggable window (NOT the browser's native
// Picture-in-Picture: that renders an un-styleable "Back to tab" overlay we
// can't remove). Popping out keeps the same React subtree, so we restore the
// playhead + play state across the remount. Controls fade after ~1s of idle.
// The pop-out toggle uses a custom shattered-glass glyph (public/veksnap-popout.png)
// with a lucide fallback.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  RotateCcw,
  RotateCw,
  PictureInPicture2,
  PictureInPicture,
  X,
  GripHorizontal,
} from "lucide-react";

interface VekSnapVideoProps {
  src: string;
  className?: string;      // applied to the wrapper (border / rounding)
  style?: CSSProperties;   // applied to the <video> (e.g. maxHeight / maxWidth)
  fit?: "contain" | "cover";
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
  poster?: string;
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function VekSnapVideo({
  src,
  className,
  style,
  fit = "contain",
  autoPlay = false,
  loop = false,
  muted = false,
  poster,
}: VekSnapVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const lastTimeRef = useRef(0);
  const wasPlayingRef = useRef(autoPlay);
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(muted ? 0 : 1);
  const [isMuted, setIsMuted] = useState(muted);
  const [showControls, setShowControls] = useState(true);
  const [glyphOk, setGlyphOk] = useState(true);
  const [poppedOut, setPoppedOut] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 440, h: 300 });

  // Keep UI state in sync with the media element. Re-runs on pop-out/redock (the
  // <video> node remounts across containers), restoring playhead + play state.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => { setPlaying(true); wasPlayingRef.current = true; };
    const onPause = () => { setPlaying(false); wasPlayingRef.current = false; };
    const onTime = () => { setCurrent(v.currentTime); lastTimeRef.current = v.currentTime; };
    const restore = () => {
      setDuration(v.duration || 0);
      if (lastTimeRef.current > 0 && Math.abs(v.currentTime - lastTimeRef.current) > 0.3) {
        try { v.currentTime = lastTimeRef.current; } catch { /* not seekable yet */ }
      }
      if (wasPlayingRef.current) v.play().catch(() => {});
    };
    const onVol = () => { setVolume(v.muted ? 0 : v.volume); setIsMuted(v.muted); };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", restore);
    v.addEventListener("volumechange", onVol);
    // If metadata is already available (fast remount), restore immediately.
    if (v.readyState >= 1) restore();
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", restore);
      v.removeEventListener("volumechange", onVol);
    };
  }, [poppedOut]);

  // Track native fullscreen so we can fill the screen (fixes maxHeight letterbox).
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Default the audio ON. React's `muted` JSX attribute is unreliable and the
  // autoplay path can leave the element muted, so set it imperatively on mount /
  // src change from the prop (default `muted=false` → sound on).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    if (!muted && v.volume === 0) v.volume = 1;
  }, [src, muted]);

  const revealControls = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowControls(false);
    }, 1000);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const skip = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration || 0);
  }, []);

  const onSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = parseFloat(e.target.value);
  }, []);

  const onVolume = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const val = parseFloat(e.target.value);
    v.volume = val;
    v.muted = val === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 1;
  }, []);

  const openPopout = useCallback(() => {
    setPos({ x: Math.max(12, window.innerWidth - size.w - 16), y: Math.max(12, window.innerHeight - size.h - 24) });
    setPoppedOut(true);
  }, [size]);
  const redock = useCallback(() => setPoppedOut(false), []);
  const closePopout = useCallback(() => { videoRef.current?.pause(); setPoppedOut(false); }, []);

  // Drag the floating pop-out by its grip bar (pointer events, clamped to viewport).
  const onDragStart = useCallback((e: React.PointerEvent) => {
    const base = pos ?? { x: window.innerWidth - 436, y: window.innerHeight - 320 };
    dragOffset.current = { dx: e.clientX - base.x, dy: e.clientY - base.y };
    const move = (ev: PointerEvent) => {
      if (!dragOffset.current) return;
      const w = size.w, h = size.h;
      const nx = Math.min(Math.max(0, ev.clientX - dragOffset.current.dx), window.innerWidth - w);
      const ny = Math.min(Math.max(0, ev.clientY - dragOffset.current.dy), window.innerHeight - h);
      setPos({ x: nx, y: ny });
    };
    const up = () => {
      dragOffset.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [pos, size]);

  // Resize the floating pop-out by dragging its bottom-right corner.
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = size.w, startH = size.h;
    const move = (ev: PointerEvent) => {
      setSize({
        w: Math.min(window.innerWidth * 0.96, Math.max(240, startW + (ev.clientX - startX))),
        h: Math.min(window.innerHeight * 0.92, Math.max(150, startH + (ev.clientY - startY))),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [size]);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  }, []);

  const btn = "text-white/80 hover:text-white transition-colors disabled:opacity-40";

  const videoStyle: CSSProperties = isFs
    ? { maxHeight: "100vh", maxWidth: "100vw", width: "100%", height: "100%" }
    : poppedOut
    ? { maxHeight: "100%", maxWidth: "100%", width: "100%", height: "100%" }
    : (style ?? {});

  const media = (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        autoPlay={autoPlay}
        loop={loop}
        muted={muted}
        preload={autoPlay ? "auto" : "metadata"}
        playsInline
        onClick={togglePlay}
        style={videoStyle}
        className={`block max-w-full cursor-pointer ${
          isFs || poppedOut ? "w-full h-full object-contain" : fit === "cover" ? "object-cover w-full" : "object-contain"
        }`}
      />

      {/* Custom control bar: reveals on hover / when paused, hides after ~1s idle */}
      <div
        className={`absolute inset-x-0 bottom-0 flex flex-col gap-1 px-2 pb-1.5 pt-6 bg-gradient-to-t from-black/80 via-black/40 to-transparent transition-opacity duration-200 ${
          showControls || !playing ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={current}
          onChange={onSeek}
          aria-label="Seek"
          className="w-full h-1 cursor-pointer accent-blue-400"
        />
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => skip(-5)} title="Back 5s" className={btn}>
            <RotateCcw className="w-4 h-4" />
          </button>
          <button type="button" onClick={togglePlay} title={playing ? "Pause" : "Play"} className={btn}>
            {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button type="button" onClick={() => skip(5)} title="Forward 5s" className={btn}>
            <RotateCw className="w-4 h-4" />
          </button>

          <div className="flex items-center gap-1.5">
            <button type="button" onClick={toggleMute} title={isMuted ? "Unmute" : "Mute"} className={btn}>
              {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={onVolume}
              aria-label="Volume"
              className="w-14 h-1 cursor-pointer accent-blue-400"
            />
          </div>

          <span className="text-[10px] font-mono text-white/70 tabular-nums ml-1">
            {fmt(current)} / {fmt(duration)}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={poppedOut ? redock : openPopout}
              title={poppedOut ? "Redock player" : "Pop out player"}
              className={btn}
            >
              {poppedOut ? (
                <PictureInPicture className="w-4 h-4" />
              ) : glyphOk ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src="/veksnap-popout.png"
                  alt="Pop out"
                  className="w-[18px] h-[18px] object-contain drop-shadow"
                  onError={() => setGlyphOk(false)}
                />
              ) : (
                <PictureInPicture2 className="w-4 h-4" />
              )}
            </button>
            <button type="button" onClick={toggleFullscreen} title="Fullscreen" className={btn}>
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </>
  );

  const playerBody = (
    <div
      ref={wrapRef}
      className={`group relative overflow-hidden bg-black ${
        isFs ? "w-screen h-screen flex items-center justify-center" : poppedOut ? "w-full h-full flex items-center justify-center" : "inline-block"
      } ${className ?? ""}`}
      onMouseMove={revealControls}
      onMouseLeave={() => { if (playing) setShowControls(false); }}
    >
      {media}
    </div>
  );

  if (!poppedOut) return playerBody;

  // Popped out: keep an inline placeholder in flow, float the real player.
  return (
    <>
      <div
        className={`flex flex-col items-center justify-center gap-1 rounded border border-blue-500/30 bg-blue-500/5 text-blue-300/80 text-[11px] px-3 py-8 ${className ?? ""}`}
      >
        <PictureInPicture className="w-5 h-5 text-blue-400/70" />
        <span>Playing in pop-out player</span>
        <button type="button" onClick={redock} className="underline hover:text-blue-200">
          Redock
        </button>
      </div>
      {createPortal(
        <div
          className="fixed z-[9999] max-w-[96vw] max-h-[92vh] rounded-lg overflow-hidden border border-blue-500/40 bg-black shadow-2xl shadow-black/60 flex flex-col"
          style={{
            left: pos?.x,
            top: pos?.y,
            right: pos ? undefined : 16,
            bottom: pos ? undefined : 16,
            width: size.w,
            height: size.h,
          }}
        >
          <div
            onPointerDown={onDragStart}
            className="flex-none flex items-center gap-2 px-2 py-1 bg-blue-950/70 cursor-move select-none touch-none"
          >
            <GripHorizontal className="w-3.5 h-3.5 text-blue-300/70" />
            <span className="text-[10px] text-blue-200/80 font-medium">Pop-out Player</span>
            <div className="ml-auto flex items-center gap-1">
              <button type="button" onClick={closePopout} title="Close" className="text-blue-200/80 hover:text-white p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="relative flex-1 min-h-0">{playerBody}</div>
          {/* Drag the corner to resize the pop-out */}
          <div
            onPointerDown={onResizeStart}
            title="Drag to resize"
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize z-20"
            style={{ touchAction: "none" }}
          >
            <svg viewBox="0 0 10 10" className="w-full h-full text-blue-200/60">
              <path d="M9 2 L2 9 M9 5.5 L5.5 9" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
