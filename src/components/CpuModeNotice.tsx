"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Cpu, AlertTriangle } from "lucide-react";

const DISMISS_KEY = "veksnap-cpu-notice-dismissed";
const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 15; // ~60s window while ComfyUI finishes booting

/**
 * One-time, non-nagging warning shown when the ComfyUI backend has started in
 * CPU mode (no compatible CUDA GPU). CPU generation is dramatically slower and
 * memory-hungry, which otherwise looks like a hang or an error. Purely
 * informational (it never blocks use) and can be permanently dismissed.
 */
export default function CpuModeNotice() {
  const [open, setOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch { /* localStorage unavailable, proceed */ }

    let cancelled = false;
    let polls = 0;

    const poll = async () => {
      if (cancelled) return;
      polls += 1;
      try {
        const res = await fetch("/api/gpu-status", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (data.ready) {
          // Backend answered: decide once and stop polling either way.
          if (data.cpuMode) setOpen(true);
          return;
        }
      } catch { /* not ready yet */ }
      if (polls < MAX_POLLS) {
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    // Small initial delay so we don't race the very first render.
    timerRef.current = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClose = useCallback(() => {
    if (dontShowAgain) {
      try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    }
    setOpen(false);
  }, [dontShowAgain]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-amber-400" />
            Running on CPU: no compatible GPU detected
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 text-sm">
              <p>
                Vek-Snap could not find a CUDA-capable NVIDIA GPU, so the AI engine
                started in <strong>CPU mode</strong>. Everything still works, but be
                aware:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  Image and video generation can take <strong>30 minutes to well over
                  an hour each</strong> (versus seconds to a few minutes on a GPU).
                </li>
                <li>
                  A single generation may use <strong>most or all of your system
                  RAM</strong>, so the app can feel unresponsive while it runs.
                </li>
                <li>
                  A slow-looking or seemingly stuck generation is usually just CPU
                  processing, let it finish, or cancel it if needed.
                </li>
              </ul>
              <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-amber-200">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  For a usable experience, a CUDA-capable NVIDIA GPU (with enough VRAM
                  for your chosen models) is strongly recommended.
                </span>
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="items-center gap-3 sm:justify-between">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-amber-500"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            Don&apos;t show this again
          </label>
          <Button onClick={handleClose}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
