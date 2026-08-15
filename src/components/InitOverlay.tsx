"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, CheckCircle2, X } from "lucide-react";

interface ServiceStatus {
  name: string;
  ready: boolean;
}

const POLL_INTERVAL = 4000;

export default function InitOverlay({ onReady }: { onReady: () => void }) {
  const [services, setServices] = useState<ServiceStatus[]>([
    { name: "ComfyUI", ready: false },
  ]);
  const [elapsed, setElapsed] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const checkServices = useCallback(async () => {
    const results: ServiceStatus[] = [];

    // Check ComfyUI
    let comfyReady = false;
    try {
      const res = await fetch("/api/comfyui/system_stats", {
        signal: AbortSignal.timeout(3000),
      });
      comfyReady = res.ok;
    } catch { /* not ready */ }
    results.push({ name: "ComfyUI", ready: comfyReady });

    setServices(results);
    return results.every((s) => s.ready);
  }, []);

  // Poll services
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!active) return;
      const ready = await checkServices();
      if (ready && active) {
        // Auto-dismiss after a short pause so user sees the "ready" state
        setTimeout(() => { if (active) onReady(); }, 2000);
      } else if (active) {
        setTimeout(poll, POLL_INTERVAL);
      }
    };
    // Delay first poll: gives dev server time to finish initial compilation
    setTimeout(poll, 10000);
    return () => { active = false; };
  }, [checkServices, onReady]);

  // Elapsed timer
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const allReady = services.every((s) => s.ready);
  const readyCount = services.filter((s) => s.ready).length;

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex justify-center pointer-events-none">
      <div className="mt-16 mx-4 pointer-events-auto rounded-lg border border-border bg-card/95 backdrop-blur-md shadow-lg px-5 py-3 flex items-center gap-4 max-w-lg w-full">
        {/* Spinner or check: deferred to avoid Dark Reader hydration mismatch */}
        {mounted && (allReady ? (
          <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
        ) : (
          <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
        ))}

        {/* Status text */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {allReady
              ? "All services ready!"
              : `Initializing... (${readyCount}/${services.length} services)`}
          </p>
          <div className="flex gap-3 mt-0.5">
            {services.map((svc) => (
              <span key={svc.name} className="text-[10px] flex items-center gap-1">
                {svc.ready ? (
                  <CheckCircle2 className="w-3 h-3 text-green-500" />
                ) : (
                  <Loader2 className="w-3 h-3 text-muted-foreground animate-spin" />
                )}
                <span className={svc.ready ? "text-green-500" : "text-muted-foreground"}>
                  {svc.name}
                </span>
              </span>
            ))}
            <span className="text-[10px] text-muted-foreground/60 ml-auto">
              {formatTime(elapsed)}
            </span>
          </div>
        </div>

        {/* Dismiss */}
        <button
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={onReady}
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
