"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Studio V2: top-bar ComfyUI mini service manager.
//
// The header's ComfyUI status indicator IS the service manager: it shows the
// live state (offline / starting-with-progress / connected) and, on click,
// exposes Start / Restart / Stop for the ComfyUI backend. Backed by the SAME
// /api/services contract the full ServiceManager uses:
//   GET  /api/services  -> { services: [{ id, status, starting, init:{phase,pct}, envAvailable }] }
//   POST /api/services  { action: "start"|"stop"|"restart", services: ["comfyui"] }
//
// Self-contained (own light poll + actions). Reports the running state up via
// onConnectedChange so the header's "Open in ComfyUI" button stays in sync.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Play, Square, RotateCw, Server } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { markComfyConnected } from "@/lib/comfyui-api";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

type ComfyState = "running" | "starting" | "stopped" | "unknown";

interface ServiceStatus {
  id: string;
  status: "running" | "stopped";
  starting?: boolean;
  envAvailable?: boolean;
  init?: { phase: string; pct: number };
}

const POLL_FAST = 2500;
const POLL_SLOW = 8000;

export default function ComfyServiceControl({
  onConnectedChange,
}: {
  onConnectedChange?: (connected: boolean) => void;
}) {
  const [state, setState] = useState<ComfyState>("unknown");
  const [init, setInit] = useState<{ phase: string; pct: number } | null>(null);
  const [envAvailable, setEnvAvailable] = useState(true);
  const [pending, setPending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastConnectedRef = useRef<boolean | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/services", { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        const svc = (data.services as ServiceStatus[])?.find((s) => s.id === "comfyui");
        if (svc) {
          const next: ComfyState = svc.status === "running" ? "running" : svc.starting ? "starting" : "stopped";
          setState(next);
          setInit(svc.status === "running" ? null : svc.init ?? null);
          setEnvAvailable(svc.envAvailable !== false);
          if (svc.status === "running") markComfyConnected();
          // Clear the local pending flag once the server reflects a settled state.
          if (svc.status === "running" || (!svc.starting && svc.status === "stopped")) setPending(false);
          const isConn = svc.status === "running";
          if (lastConnectedRef.current !== isConn) {
            lastConnectedRef.current = isConn;
            onConnectedChange?.(isConn);
          }
        }
      }
    } catch { /* offline / timeout, keep last known state */ }
  }, [onConnectedChange]);

  // Adaptive polling: fast while an action is pending or ComfyUI is booting.
  useEffect(() => {
    const busy = pending || state === "starting";
    const interval = busy ? POLL_FAST : POLL_SLOW;
    poll();
    const id = setInterval(poll, interval);
    pollRef.current = id;
    return () => clearInterval(id);
  }, [poll, pending, state]);

  const runAction = useCallback(async (action: "start" | "stop" | "restart") => {
    setPending(true);
    if (action !== "stop") setState("starting");
    try {
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, services: ["comfyui"] }),
      });
    } catch { /* poll picks up the resulting state */ }
    // Kick a fast poll shortly after.
    setTimeout(poll, 800);
  }, [poll]);

  // ── Visual state ──
  const starting = state === "starting" || (pending && state !== "running");
  const running = state === "running";
  const pct = init?.pct ?? 0;
  const label = running ? "ComfyUI" : starting ? (init?.phase ?? "Starting…") : "Offline";
  const dotClass = running
    ? "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/70"
    : starting
      ? "bg-amber-400"
      : "bg-rose-500";
  const title = running
    ? "ComfyUI is connected: click for controls"
    : starting
      ? "ComfyUI is starting…"
      : envAvailable
        ? "ComfyUI is offline: click to start"
        : "ComfyUI runtime not found";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          style={NO_DRAG}
          title={title}
          aria-label="ComfyUI service controls"
          className="relative inline-flex items-center gap-1.5 h-8 pl-2 pr-2.5 rounded-lg border border-border/60 text-[10px] text-muted-foreground hover:text-foreground hover:bg-foreground/10 data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground transition-colors overflow-hidden"
        >
          {starting ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-amber-300" />
          ) : (
            <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
          )}
          <span className="max-w-[120px] truncate font-medium">{label}</span>
          {starting && (
            <span className="ml-0.5 tabular-nums text-amber-300/80">{pct > 0 ? `${pct}%` : ""}</span>
          )}
          {/* Boot progress: a thin animated bar along the bottom edge of the pill,
              a compact echo of the Classic layout's loading animation. */}
          {starting && (
            <span className="pointer-events-none absolute left-0 bottom-0 h-[2px] w-full bg-amber-500/15">
              <span
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-amber-400 to-orange-400 transition-[width] duration-500"
                style={pct > 0 ? { width: `${pct}%` } : undefined}
              >
                {pct <= 0 && <span className="block h-full w-full animate-pulse" />}
              </span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[190px]" style={NO_DRAG}>
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <Server className="w-3.5 h-3.5 text-muted-foreground" />
          ComfyUI · {running ? "connected" : starting ? "starting" : "offline"}
        </DropdownMenuLabel>
        {starting && init && (
          <div className="px-2 pb-1 text-[10px] text-amber-300/80">{init.phase}{pct > 0 ? `: ${pct}%` : ""}</div>
        )}
        <DropdownMenuSeparator />
        {!running && !starting && (
          <DropdownMenuItem onClick={() => runAction("start")} disabled={!envAvailable || pending}>
            <Play className="w-3.5 h-3.5" /> Start ComfyUI
          </DropdownMenuItem>
        )}
        {(running || starting) && (
          <>
            <DropdownMenuItem onClick={() => runAction("restart")} disabled={pending}>
              <RotateCw className="w-3.5 h-3.5" /> Restart ComfyUI
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runAction("stop")} disabled={pending} variant="destructive">
              <Square className="w-3.5 h-3.5" /> Stop ComfyUI
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
