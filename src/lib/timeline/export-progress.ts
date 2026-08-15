// In-memory Timeline-Export progress store.
//
// The export POST (a long ffmpeg render) writes progress here; the companion SSE
// route (/api/timeline-export/progress) reads it and streams it to the editor.
// State lives in the single Next.js server process, keyed by a per-export jobId.
// Entries are pruned after a TTL so abandoned exports never leak.

export type ExportPhase = "preparing" | "rendering" | "done" | "error";

export interface ExportProgressState {
  phase: ExportPhase;
  percent: number;       // 0..100 (accurate during "rendering", from ffmpeg out_time / total)
  totalSec: number;      // total timeline duration being rendered
  outTimeSec: number;    // seconds rendered so far
  speed: number;         // ffmpeg encode speed (× realtime); 0 until known
  fps: number;           // current encode fps; 0 until known
  etaSec: number | null; // estimated seconds remaining; null until known
  encoder?: "gpu" | "cpu"; // which encoder the active attempt is using
  message?: string;
  updatedAt: number;
}

const store = new Map<string, ExportProgressState>();
const TTL_MS = 5 * 60 * 1000;

function prune(): void {
  const now = Date.now();
  for (const [id, s] of store) {
    if (now - s.updatedAt > TTL_MS) store.delete(id);
  }
}

export function initProgress(jobId: string, totalSec = 0): void {
  if (!jobId) return;
  prune();
  store.set(jobId, {
    phase: "preparing", percent: 0, totalSec, outTimeSec: 0,
    speed: 0, fps: 0, etaSec: null, updatedAt: Date.now(),
  });
}

export function updateProgress(jobId: string, patch: Partial<ExportProgressState>): void {
  if (!jobId) return;
  const cur = store.get(jobId);
  if (!cur) return;
  store.set(jobId, { ...cur, ...patch, updatedAt: Date.now() });
}

export function finishProgress(jobId: string, phase: "done" | "error", message?: string): void {
  if (!jobId) return;
  const cur = store.get(jobId);
  const base: ExportProgressState = cur ?? {
    phase, percent: 0, totalSec: 0, outTimeSec: 0,
    speed: 0, fps: 0, etaSec: null, updatedAt: Date.now(),
  };
  store.set(jobId, {
    ...base,
    phase,
    percent: phase === "done" ? 100 : base.percent,
    etaSec: phase === "done" ? 0 : base.etaSec,
    message,
    updatedAt: Date.now(),
  });
}

export function getProgress(jobId: string): ExportProgressState | undefined {
  return jobId ? store.get(jobId) : undefined;
}

export function clearProgress(jobId: string): void {
  if (jobId) store.delete(jobId);
}
