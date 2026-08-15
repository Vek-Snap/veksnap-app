"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AI Processing Queue: a small global, observable store shared by the Timeline
// Editor (which enqueues jobs from a clip's "Vek-Snap AI" menu) and the shell's
// AI Processing Queue panel (which renders + runs them). Jobs are DEFERRED by
// default: they sit here until the user presses Start (or auto-run is on), so a
// batch of GPU work runs on the user's schedule, one at a time.
//
// The store holds DATA + STATUS only. Execution lives in useAIQueueRunner (the
// shell) so all ComfyUI / API access stays client-side and testable.
// ─────────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

// "render" is the program-wide, timeline-independent job: a page snapshots the
// exact ComfyUI graph its Render button would submit and enqueues it here to run
// later, in order, saving to the normal output folder (no timeline clip involved).
export type AIWorkflow = "sdxl" | "zimage" | "dramabox" | "render";
export type AIQueueStatus = "queued" | "running" | "done" | "error" | "cancelled";

/** Extra payload for a DramaBox audio-generation job (a "generate", not a "replace"). */
export interface AudioGenJob {
  /** The user's DramaBox script / stage directions. */
  script: string;
  /** Fixed output duration (s) if the user specified one (else generator decides). */
  targetDuration?: number;
}

export interface AIQueueItem {
  id: string;
  workflow: AIWorkflow;
  workflowLabel: string;   // e.g. "DramaBox"
  configName: string;      // saved configuration applied to the job ("" = none)
  clipId: string;          // timeline clip to replace/fill on success
  assetId: string;
  sourcePath: string;      // absolute filePath of the source media ("" for generate jobs)
  sourceSrc: string;       // browser-playable URL of the source (for img upload)
  sourceName: string;
  kind: "image" | "audio";
  /** Present for DramaBox audio-generation jobs (no source media; script → speech). */
  audioGen?: AudioGenJob;
  /**
   * Job routing:
   *   "timeline" (default/undefined): on success the output replaces/fills a
   *     timeline clip (clipId is set).
   *   "render": program-wide render: submit `graph` and let ComfyUI save to the
   *     output folder; nothing is sent to the timeline.
   */
  jobType?: "timeline" | "render";
  /** Prebuilt, self-contained ComfyUI graph for a "render" job. */
  graph?: Record<string, unknown>;
  /** Expected primary output of a "render" job (display/labelling only). */
  outputKind?: "image" | "video" | "audio";
  status: AIQueueStatus;
  progress: string;
  error: string | null;
  createdAt: number;
}

// Category color (level-of-effort cue). Image models = cool colors, audio = warm.
export const AI_WORKFLOW_COLOR: Record<AIWorkflow, string> = {
  sdxl: "#38bdf8",   // sky   - checkpoint image (heavier)
  zimage: "#a78bfa",  // violet - turbo image
  dramabox: "#fb7185", // rose  - expressive TTS (audio generation)
  render: "#f59e0b",  // amber - program-wide render-to-output job
};

type Snapshot = { items: AIQueueItem[]; running: boolean; autoRun: boolean; stopOnError: boolean };

class AIQueueStore {
  private items: AIQueueItem[] = [];
  private running = false;   // is the queue actively processing?
  private autoRun = false;   // enqueue → run immediately (opt-in "power user" mode)
  private stopOnError = false; // false = skip a failed job and keep going (default);
                               // true = halt the whole queue on the first failure.
  private listeners = new Set<() => void>();
  private snap: Snapshot = { items: [], running: false, autoRun: false, stopOnError: false };

  private emit() {
    this.snap = { items: [...this.items], running: this.running, autoRun: this.autoRun, stopOnError: this.stopOnError };
    this.listeners.forEach((l) => l());
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };
  getSnapshot = (): Snapshot => this.snap;

  add(item: Omit<AIQueueItem, "id" | "status" | "progress" | "error" | "createdAt">): string {
    const id = `aiq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.items.push({ ...item, id, status: "queued", progress: "", error: null, createdAt: Date.now() });
    if (this.autoRun) this.running = true;
    this.emit();
    return id;
  }

  /**
   * Enqueue a program-wide render job: a self-contained ComfyUI graph that runs
   * in order and saves to the output folder (no timeline clip). Used by the
   * "Send to Process Queue" button on generation pages.
   */
  addRenderJob(job: {
    workflowLabel: string;
    graph: Record<string, unknown>;
    outputKind?: "image" | "video" | "audio";
    sourceName?: string;
  }): string {
    return this.add({
      workflow: "render",
      workflowLabel: job.workflowLabel,
      configName: "",
      clipId: "",
      assetId: "",
      sourcePath: "",
      sourceSrc: "",
      sourceName: job.sourceName ?? "",
      kind: job.outputKind === "audio" ? "audio" : "image",
      jobType: "render",
      graph: job.graph,
      outputKind: job.outputKind ?? "image",
    });
  }

  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }
  /** Remove all items that are not currently running. */
  clearAll(): void {
    this.items = this.items.filter((i) => i.status === "running");
    this.emit();
  }
  /** Remove finished/errored/cancelled items, keep queued + running. */
  clearFinished(): void {
    this.items = this.items.filter((i) => i.status === "queued" || i.status === "running");
    this.emit();
  }

  /** Drag-and-drop reorder: move `fromId` to the position of `toId`. */
  reorder(fromId: string, toId: string): void {
    const from = this.items.findIndex((i) => i.id === fromId);
    const to = this.items.findIndex((i) => i.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = this.items.splice(from, 1);
    this.items.splice(to, 0, moved);
    this.emit();
  }
  /** Nudge a queued item up/down one slot (button fallback for reorder). */
  move(id: string, dir: -1 | 1): void {
    const idx = this.items.findIndex((i) => i.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= this.items.length) return;
    [this.items[idx], this.items[j]] = [this.items[j], this.items[idx]];
    this.emit();
  }

  setStatus(id: string, status: AIQueueStatus, patch?: Partial<AIQueueItem>): void {
    this.items = this.items.map((i) => (i.id === id ? { ...i, status, ...patch } : i));
    this.emit();
  }
  setProgress(id: string, progress: string): void {
    this.items = this.items.map((i) => (i.id === id ? { ...i, progress } : i));
    this.emit();
  }

  setRunning(v: boolean): void {
    this.running = v;
    // Stopping resets any "queued→queued" but leaves a running job to finish; the
    // runner checks running before starting the NEXT item.
    this.emit();
  }
  setAutoRun(v: boolean): void { this.autoRun = v; this.emit(); }
  setStopOnError(v: boolean): void { this.stopOnError = v; this.emit(); }

  isRunning(): boolean { return this.running; }
  isAutoRun(): boolean { return this.autoRun; }
  isStopOnError(): boolean { return this.stopOnError; }
  nextQueued(): AIQueueItem | undefined { return this.items.find((i) => i.status === "queued"); }
  hasRunning(): boolean { return this.items.some((i) => i.status === "running"); }
}

export const aiQueueStore = new AIQueueStore();

export function useAIQueue(): Snapshot {
  return useSyncExternalStore(aiQueueStore.subscribe, aiQueueStore.getSnapshot, aiQueueStore.getSnapshot);
}
