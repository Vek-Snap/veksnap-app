"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Singleton media player ("one player to rule them all").
//
// Instead of mounting a <video> per list item (which accumulates decoders +
// control-bar DOM and tanks performance), the ENTIRE app shares ONE VekSnapVideo
// instance owned by <MediaPlayerProvider>. Each play-site renders a cheap poster
// <VideoSlot> (an <img>, e.g. the ffmpeg-extracted LTX frame). When the user hits
// play, the request is "routed" to the single player, which is portaled (Strategy
// A) into that slot's host container. Switching slots moves the one player; the
// previous slot reverts to its poster. Nothing decodes until you press play, and
// only ever one thing decodes at a time.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Play, X } from "lucide-react";
import VekSnapVideo from "@/components/VekSnapVideo";

export interface MediaRequest {
  id: string;                       // stable, unique per play-site
  src: string;
  poster?: string;
  fit?: "contain" | "cover";
  loop?: boolean;
  muted?: boolean;
  style?: CSSProperties;            // forwarded to the <video> (e.g. maxHeight)
}

interface MediaPlayerContextValue {
  activeId: string | null;
  play: (req: MediaRequest) => void;
  stop: () => void;
  /** internal: the active slot registers/clears its portal host here */
  _setHost: (el: HTMLElement | null) => void;
}

const MediaPlayerContext = createContext<MediaPlayerContextValue | null>(null);

export function useMediaPlayer(): MediaPlayerContextValue {
  const ctx = useContext(MediaPlayerContext);
  if (!ctx) throw new Error("useMediaPlayer must be used within <MediaPlayerProvider>");
  return ctx;
}

export function MediaPlayerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<MediaRequest | null>(null);
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null);

  const play = useCallback((req: MediaRequest) => {
    // Drop the old host first so we never portal into a stale container.
    setHostEl(null);
    setRequest(req);
  }, []);
  const stop = useCallback(() => {
    setRequest(null);
    setHostEl(null);
  }, []);
  const _setHost = useCallback((el: HTMLElement | null) => setHostEl(el), []);

  const value: MediaPlayerContextValue = {
    activeId: request?.id ?? null,
    play,
    stop,
    _setHost,
  };

  return (
    <MediaPlayerContext.Provider value={value}>
      {children}
      {request && hostEl
        ? createPortal(
            // key on id → a fresh player per video (clean playhead, no stale seek).
            <VekSnapVideo
              key={request.id}
              src={request.src}
              poster={request.poster}
              fit={request.fit ?? "contain"}
              loop={request.loop}
              muted={request.muted}
              autoPlay
              style={request.style}
            />,
            hostEl,
          )
        : null}
    </MediaPlayerContext.Provider>
  );
}

interface VideoSlotProps {
  id: string;
  src: string;
  poster?: string;
  fit?: "contain" | "cover";
  loop?: boolean;
  muted?: boolean;
  className?: string;               // outer wrapper (border / rounding)
  style?: CSSProperties;            // sizing (maxHeight/maxWidth) - applied to poster AND player
  autoOpen?: boolean;               // focused single-use spots (review/final) open on mount
}

/**
 * A lightweight play-site. Shows a poster + play affordance until clicked, then
 * hosts the shared singleton player (portaled in by the provider). Reverts to the
 * poster when another slot is played or the player is closed.
 */
export function VideoSlot({
  id,
  src,
  poster,
  fit = "contain",
  loop,
  muted,
  className,
  style,
  autoOpen,
}: VideoSlotProps) {
  const { activeId, play, stop, _setHost } = useMediaPlayer();
  const active = activeId === id;
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!active) return;
    _setHost(hostRef.current);
    return () => _setHost(null);
  }, [active, _setHost]);

  // Focused single-use spots (review / final output) open the shared player on
  // mount and re-open if their source changes. Only ever one player decodes.
  useEffect(() => {
    if (!autoOpen) return;
    play({ id, src, poster, fit, loop, muted, style });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, id, src]);

  return (
    <div className={`relative inline-block align-top overflow-hidden bg-black ${className ?? ""}`}>
      {active ? (
        <>
          {/* provider portals the shared VekSnapVideo into here */}
          <div ref={hostRef} />
          <button
            type="button"
            onClick={stop}
            title="Close player"
            className="absolute top-1 right-1 z-10 rounded bg-black/60 p-0.5 text-white/80 hover:text-white transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => play({ id, src, poster, fit, loop, muted, style })}
          className="group relative block cursor-pointer"
          title="Play"
        >
          {poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={poster}
              alt=""
              style={style}
              className={fit === "cover" ? "object-cover w-full h-full" : "object-contain max-w-full"}
            />
          ) : (
            // No pre-extracted poster: paint the video's OWN first frame as the
            // poster surface (paused, metadata only, nothing plays until clicked).
            // The `#t=0.1` fragment nudges the browser to decode + show frame 0
            // instead of a black box. Sizes to `style` like the img poster does,
            // so previews are always a decent size, never a tiny placeholder.
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={src.includes("#") ? src : `${src}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              style={style}
              className={`${fit === "cover" ? "object-cover w-full h-full" : "object-contain max-w-full"} min-w-[160px] min-h-[100px] bg-gradient-to-br from-slate-800 to-slate-900`}
            />
          )}
          <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="rounded-full bg-black/50 p-2.5 group-hover:bg-blue-600/70 transition-colors">
              <Play className="w-5 h-5 text-white fill-white" />
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
