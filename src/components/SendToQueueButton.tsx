"use client";

// ─────────────────────────────────────────────────────────────────────────────
// "Send to Process Queue": a small button placed beside a page's Render button.
// It snapshots the EXACT ComfyUI graph the page would render right now and adds
// it to the shared AI Processing Queue as a program-wide render job (runs in
// order, saves to the output folder, no timeline involvement). This lets a user
// stack a big multi-workflow batch and let it render unattended.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { ListPlus, Check } from "lucide-react";
import { aiQueueStore } from "@/lib/ai-queue/store";

export interface QueueRenderJob {
  /** Self-contained ComfyUI graph to submit. */
  workflow: Record<string, unknown>;
  /** Human label shown in the queue (e.g. "LTX-2", "SDXL"). */
  name: string;
  /** Primary output kind (labelling only). */
  outputKind?: "image" | "video" | "audio";
}

interface SendToQueueButtonProps {
  /**
   * Builds a single job at click time. Return null (or throw) if the page isn't
   * ready to render (missing prompt/inputs); the button will simply not enqueue.
   */
  getJob?: () => QueueRenderJob | null;
  /**
   * Builds MULTIPLE jobs at click time, used by pages whose Render button runs a
   * client-side batch loop (e.g. SDXL/Z-Image "batch size"). Each returned job is
   * enqueued as its own render, so a batch of N with per-item seeds is captured
   * faithfully. Takes precedence over `getJob` when provided.
   */
  getJobs?: () => QueueRenderJob[];
  label?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
}

export default function SendToQueueButton({
  getJob,
  getJobs,
  label = "Send to Process Queue",
  disabled = false,
  className = "",
  title = "Add this render to the AI Processing Queue to run later, in order",
}: SendToQueueButtonProps) {
  const [added, setAdded] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const onClick = useCallback(() => {
    let jobs: QueueRenderJob[] = [];
    try {
      jobs = getJobs ? getJobs() : (getJob ? [getJob()].filter((j): j is QueueRenderJob => !!j) : []);
    } catch {
      jobs = [];
    }
    const valid = jobs.filter((j) => j && j.workflow);
    if (valid.length === 0) return;
    for (const job of valid) {
      aiQueueStore.addRenderJob({
        workflowLabel: job.name || "Render",
        graph: job.workflow,
        outputKind: job.outputKind,
      });
    }
    setAdded(valid.length);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setAdded(0), 1600);
  }, [getJob, getJobs]);

  const flash = added > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[12px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        flash
          ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
      } ${className}`}
    >
      {flash ? <Check className="w-4 h-4" /> : <ListPlus className="w-4 h-4" />}
      {flash ? (added > 1 ? `Added ${added} to Queue` : "Added to Queue") : label}
    </button>
  );
}
