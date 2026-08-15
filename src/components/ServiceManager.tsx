"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  CheckCircle2,
  Circle,
  Play,
  Square,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Server,
  Blocks,
  Zap,
  FolderCog,
} from "lucide-react";
import { markComfyConnected, wasRecentlyConnected } from "@/lib/comfyui-api";

interface ServiceStatus {
  id: string;
  name: string;
  description: string;
  port: number;
  status: "running" | "stopped";
  envAvailable: boolean;
  starting?: boolean; // server-side spawn lock active (autostart in progress)
  init?: { phase: string; pct: number }; // ComfyUI live boot phase (while starting)
}

const POLL_SLOW = 5000;
const POLL_FAST = 2000;

interface ServiceManagerProps {
  onComfyStatusChange?: (connected: boolean) => void;
}

export default function ServiceManager({ onComfyStatusChange }: ServiceManagerProps = {}) {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [starting, setStarting] = useState<Set<string>>(new Set());
  const startTimestampsRef = useRef<Record<string, number>>({});
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [startAllPending, setStartAllPending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [comfyNodeCount, setComfyNodeCount] = useState<number | null>(null);
  const nodeCountFetchedRef = useRef(false);
  // Whether the first status poll has resolved. Until it does, we report the
  // optimistic "recently connected" state to the parent so the ComfyUI dot
  // doesn't flash red right after a Classic/Modern UI switch.
  const [firstPollDone, setFirstPollDone] = useState(false);
  // Autostart preference: loaded from server settings, toggled via API.
  const [comfyAutostart, setComfyAutostart] = useState(false);

  // Load preferences from server + localStorage
  useEffect(() => {
    const saved = localStorage.getItem("veksnap-services-collapsed");
    if (saved === "true") setCollapsed(true);
    // Load autostart preference from server
    fetch("/api/settings").then((r) => r.json()).then((data) => {
      if (typeof data.comfyAutostart === "boolean") {
        setComfyAutostart(data.comfyAutostart);
      } else {
        // Migrate from localStorage to server (one-time)
        const legacy = localStorage.getItem("veksnap-comfy-autostart");
        if (legacy === "true") {
          setComfyAutostart(true);
          fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "set", key: "comfyAutostart", value: true }),
          }).catch(() => {});
          localStorage.removeItem("veksnap-comfy-autostart");
        }
      }
    }).catch(() => {});
  }, []);

  const toggleComfyAutostart = useCallback(() => {
    setComfyAutostart((prev) => {
      const next = !prev;
      // Persist to server: the server reads this on first GET /api/services
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "comfyAutostart", value: next }),
      }).catch(() => {});
      return next;
    });
  }, []);

  // Poll service status
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/services", { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json();
        const svcList = data.services as ServiceStatus[];
        setServices(svcList);
        if (svcList?.some((s) => s.id === "comfyui" && s.status === "running")) markComfyConnected();
        setFirstPollDone(true);

        // Clear starting/stopping flags when status matches expected result.
        // Also adopt server-side starting flags (e.g. autostart in progress).
        setStarting((prev) => {
          const next = new Set(prev);
          const now = Date.now();
          for (const svc of svcList) {
            if (svc.status === "running") {
              next.delete(svc.id);
              delete startTimestampsRef.current[svc.id];
            }
            // Server says it's spawning this service (autostart or spawn lock active)
            if (svc.starting && svc.status === "stopped" && !next.has(svc.id)) {
              next.add(svc.id);
              if (!startTimestampsRef.current[svc.id]) startTimestampsRef.current[svc.id] = now;
            }
            // Timeout: if starting for >30s but still stopped, start likely failed
            if (svc.status === "stopped" && next.has(svc.id) && !svc.starting) {
              const ts = startTimestampsRef.current[svc.id];
              if (ts && now - ts > 30_000) {
                next.delete(svc.id);
                delete startTimestampsRef.current[svc.id];
                console.warn(`[ServiceManager] ${svc.id} start timed out, clearing flag`);
              }
            }
          }
          return next;
        });
        setStopping((prev) => {
          const next = new Set(prev);
          for (const svc of svcList) {
            if (svc.status === "stopped") next.delete(svc.id);
          }
          return next;
        });
      }
    } catch { /* offline or timeout, keep last known state */ }
  }, []);

  // Fetch ComfyUI node count once when ComfyUI becomes running
  useEffect(() => {
    const comfySvc = services.find((s) => s.id === "comfyui");
    if (comfySvc?.status === "running" && !nodeCountFetchedRef.current) {
      nodeCountFetchedRef.current = true;
      fetch("/api/comfyui/object_info", { signal: AbortSignal.timeout(15000) })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => { if (data) setComfyNodeCount(Object.keys(data).length); })
        .catch(() => {});
    } else if (comfySvc?.status !== "running") {
      nodeCountFetchedRef.current = false;
      setComfyNodeCount(null);
    }
  }, [services]);

  // Autostart is handled server-side (GET /api/services first-call logic).
  // No client-side autostart: it raced with the server-side one and caused
  // multiple ComfyUI instances to spawn simultaneously.

  // Adaptive polling: fast when actions are pending, slow otherwise
  useEffect(() => {
    const hasPending = starting.size > 0 || stopping.size > 0;
    const interval = hasPending ? POLL_FAST : POLL_SLOW;

    // Initial poll
    pollStatus();

    const id = setInterval(pollStatus, interval);
    pollRef.current = id;
    return () => clearInterval(id);
  }, [pollStatus, starting.size, stopping.size]);

  // ── Actions ──

  const startService = async (svcId: string) => {
    startTimestampsRef.current[svcId] = Date.now();
    setStarting((prev) => new Set(prev).add(svcId));
    try {
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", services: [svcId] }),
      });
    } catch { /* poll will pick up status */ }
  };

  const stopService = async (svcId: string) => {
    setStopping((prev) => new Set(prev).add(svcId));
    try {
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", services: [svcId] }),
      });
    } catch { /* poll will pick up status */ }
  };

  const restartService = async (svcId: string) => {
    setStopping((prev) => new Set(prev).add(svcId));
    try {
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart", services: [svcId] }),
      });
      // After restart call returns, switch to "starting" state
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(svcId);
        return next;
      });
      startTimestampsRef.current[svcId] = Date.now();
      setStarting((prev) => new Set(prev).add(svcId));
    } catch { /* poll will pick up status */ }
  };

  const startAll = async () => {
    const stoppedIds = services
      .filter((s) => s.status !== "running" && s.envAvailable)
      .map((s) => s.id);
    if (stoppedIds.length === 0) return;

    setStartAllPending(true);
    const now = Date.now();
    for (const id of stoppedIds) {
      startTimestampsRef.current[id] = now;
      setStarting((prev) => new Set(prev).add(id));
    }
    try {
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", services: stoppedIds }),
      });
    } catch { /* poll will pick up status */ }
    setStartAllPending(false);
  };

  const stopAll = async () => {
    const runningIds = services.filter((s) => s.status === "running").map((s) => s.id);
    const startingIds = Array.from(starting);
    const allIds = [...new Set([...runningIds, ...startingIds])];
    if (allIds.length === 0) return;

    // Clear starting flags for anything we're force-stopping
    if (startingIds.length > 0) {
      setStarting(new Set());
    }
    for (const id of allIds) {
      setStopping((prev) => new Set(prev).add(id));
    }
    try {
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", services: allIds }),
      });
    } catch { /* poll will pick up status */ }
  };

  // ── Toggle collapse ──

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("veksnap-services-collapsed", String(next));
  };

  // ── Derived state ──

  const runningCount = services.filter((s) => s.status === "running").length;
  const allRunning = services.length > 0 && runningCount === services.length;
  const anyRunning = runningCount > 0;

  // ComfyUI status for banner color
  const comfySvc = services.find((s) => s.id === "comfyui");
  const comfyIsRunning = comfySvc?.status === "running" && !stopping.has("comfyui");
  const comfyIsBooting = starting.has("comfyui") || (comfyIsRunning && comfyNodeCount === null);
  const comfyReady = comfyIsRunning && comfyNodeCount !== null && comfyNodeCount > 0;

  // Notify parent of ComfyUI connection status changes. Before the first poll
  // resolves, stay optimistically green if we were connected moments ago (UI
  // switch) so the status dot doesn't flash red; the poll then reports reality.
  useEffect(() => {
    onComfyStatusChange?.(comfyIsRunning || (!firstPollDone && wasRecentlyConnected()));
  }, [comfyIsRunning, firstPollDone, onComfyStatusChange]);

  // Banner border color: green=ready, yellow=booting, red=was running but lost, transparent=stopped
  const bannerBorderColor = comfyReady
    ? "border-emerald-500/50"
    : comfyIsBooting
      ? "border-amber-500/40"
      : comfyIsRunning
        ? "border-amber-500/40"
        : anyRunning
          ? "border-red-500/30"
          : "border-border";

  if (services.length === 0) {
    // Still loading: show minimal placeholder
    return (
      <div className="border-b border-border bg-card/50 px-6 py-2 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span className="text-xs">Loading services...</span>
      </div>
    );
  }

  return (
    <div className={`border-b-2 ${bannerBorderColor} bg-card/50 transition-colors duration-700`}>
      {/* Subtle full-width status glow */}
      {comfyReady && (
        <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />
      )}
      {comfyIsBooting && (
        <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-amber-500/30 to-transparent animate-pulse" />
      )}
      {/* ── Collapsed header strip, always visible ── */}
      <button
        className="w-full flex items-center justify-between px-6 py-2 hover:bg-muted/30 transition-colors"
        onClick={toggleCollapsed}
      >
        <div className="flex items-center gap-3">
          <Server className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Services</span>
          <Badge
            variant={allRunning ? "default" : "secondary"}
            className="text-[10px] px-1.5 py-0"
          >
            {runningCount}/{services.length}
          </Badge>

          {/* ComfyUI Autostart toggle */}
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); toggleComfyAutostart(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); toggleComfyAutostart(); } }}
            title={comfyAutostart ? "ComfyUI auto-starts on page load: click to disable" : "Click to enable ComfyUI autostart on page load"}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium border transition-all cursor-pointer ${
              comfyAutostart
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                : "border-border/60 bg-muted/10 text-muted-foreground hover:bg-muted/20 hover:text-foreground"
            }`}
          >
            <Zap className="w-3 h-3" />
            Auto
          </div>

          {/* Mini status dots when collapsed */}
          {collapsed && (
            <div className="flex items-center gap-1.5 ml-1">
              {services.map((svc) => {
                const isStarting = starting.has(svc.id);
                const isStopping = stopping.has(svc.id);
                const isRunning = svc.status === "running" && !isStopping;

                return (
                  <div key={svc.id} className="flex items-center gap-1" title={`${svc.name}: ${isStarting ? "starting" : isStopping ? "stopping" : isRunning ? "running" : "stopped"}`}>
                    {isStarting || isStopping ? (
                      <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                    ) : isRunning ? (
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                    ) : (
                      <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
                    )}
                    <span className="text-[9px] text-muted-foreground">{svc.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {/* ── Expanded service panel ── */}
      {!collapsed && (
        <div className="px-6 pb-3 space-y-1.5">
          {services.map((svc) => {
            const isStarting = starting.has(svc.id);
            const isStopping = stopping.has(svc.id);
            const isRunning = svc.status === "running" && !isStopping;
            const isBusy = isStarting || isStopping;

            return (
              <div
                key={svc.id}
                className="rounded-md border border-border/50 bg-muted/20 overflow-hidden"
              >
                <div className="flex items-center gap-3 px-3 py-2">
                {/* Status indicator */}
                {isStarting ? (
                  <Loader2 className="w-4 h-4 animate-spin text-yellow-500 shrink-0" />
                ) : isStopping ? (
                  <Loader2 className="w-4 h-4 animate-spin text-red-400 shrink-0" />
                ) : isRunning ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                ) : (
                  <Circle className="w-4 h-4 text-muted-foreground/30 shrink-0" />
                )}

                {/* Name + description */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{svc.name}</span>
                    <span className="text-[10px] text-muted-foreground/50">:{svc.port}</span>
                    {svc.id === "comfyui" && isRunning && comfyNodeCount !== null && (
                      <span
                        className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded text-emerald-400 bg-emerald-500/10"
                        title={`${comfyNodeCount} node types loaded`}
                      >
                        <Blocks className="w-3 h-3" />
                        {comfyNodeCount}
                      </span>
                    )}
                    {svc.id === "comfyui" && (
                      <button
                        className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border border-border/60 bg-muted/10 text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors"
                        title="Edit model search paths (extra_model_paths.yaml): changes require ComfyUI restart"
                        onClick={(e) => {
                          e.stopPropagation();
                          fetch("/api/settings/open-model-paths", { method: "POST" });
                        }}
                      >
                        <FolderCog className="w-3 h-3" />
                        Model Paths
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {svc.description}
                  </p>
                </div>

                {/* Action buttons */}
                {!svc.envAvailable ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-muted-foreground shrink-0"
                  >
                    Not installed
                  </Badge>
                ) : isStarting ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge
                      variant="outline"
                      className="text-[10px] text-yellow-500 border-yellow-500/30 max-w-[180px] truncate"
                      title={svc.init?.phase || "Starting..."}
                    >
                      {svc.init?.phase || "Starting..."}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        stopService(svc.id);
                      }}
                      title="Cancel / force stop"
                    >
                      <Square className="w-3 h-3" />
                    </Button>
                  </div>
                ) : isStopping ? (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-red-400 border-red-400/30 shrink-0"
                  >
                    Stopping...
                  </Badge>
                ) : isRunning ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-yellow-500 hover:bg-yellow-500/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        restartService(svc.id);
                      }}
                      title="Restart service (useful for model rescanning)"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-red-400 hover:text-red-400 hover:bg-red-500/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        stopService(svc.id);
                      }}
                    >
                      <Square className="w-3 h-3 mr-1" />
                      Stop
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-green-500 hover:text-green-500 hover:bg-green-500/10 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      startService(svc.id);
                    }}
                  >
                    <Play className="w-3 h-3 mr-1" />
                    Start
                  </Button>
                )}
                </div>
                {svc.id === "comfyui" && isStarting && svc.init && (
                  <div className="h-1 w-full bg-muted/40" title={`${svc.init.phase} (${svc.init.pct}%)`}>
                    <div
                      className="h-full bg-gradient-to-r from-amber-500/60 to-emerald-500/60 transition-all duration-700"
                      style={{ width: `${svc.init.pct}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* Bottom action bar */}
          <div className="flex items-center justify-end gap-2 pt-1">
            {(anyRunning || starting.size > 0) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-red-400 hover:text-red-400 hover:bg-red-500/10 gap-1.5"
                onClick={stopAll}
                disabled={stopping.size > 0}
              >
                <Square className="w-3 h-3" />
                Stop All
              </Button>
            )}
            {!allRunning && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={startAll}
                disabled={startAllPending || starting.size > 0}
              >
                {startAllPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
                Start All
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
