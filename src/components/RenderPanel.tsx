"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Play, Square, Pause, Loader2, Timer, SkipForward, ListPlus, ListVideo, Trash2, X, CheckCircle2, AlertCircle, Circle } from "lucide-react";
import { GenerationStatus, SegmentProgress } from "@/lib/types";

export interface QueueItemView {
  id: string;
  label: string;
  mode: string;
  status: "pending" | "running" | "done" | "error";
}

interface Props {
  status: GenerationStatus;
  progress: number;
  progressMax: number;
  currentNode: string;
  onGenerate: () => void;
  onInterrupt: () => void;
  onSkip?: () => void;
  onPauseBatch?: () => void;
  onResumeBatch?: () => void;
  batchPaused?: boolean;
  isBatch?: boolean;
  disabled: boolean;
  disabledReason?: string;
  wsPreviewCount?: number;
  stepTimestamps?: number[];
  segmentProgress?: SegmentProgress | null;
  passLabel?: string;
  // ── Sequential render queue ──
  queue?: QueueItemView[];
  queueRunning?: boolean;
  onAddToQueue?: () => void;
  onRunQueue?: () => void;
  onStopQueue?: () => void;
  onRemoveQueueItem?: (id: string) => void;
  onClearQueue?: () => void;
}

function QueueStatusIcon({ status }: { status: QueueItemView["status"] }) {
  if (status === "running") return <Loader2 className="w-3 h-3 animate-spin text-cyan-400 shrink-0" />;
  if (status === "done") return <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />;
  if (status === "error") return <AlertCircle className="w-3 h-3 text-destructive shrink-0" />;
  return <Circle className="w-3 h-3 text-muted-foreground/40 shrink-0" />;
}

function formatTime(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ETACountdown({ stepTimestamps, progress, progressMax }: {
  stepTimestamps: number[];
  progress: number;
  progressMax: number;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (stepTimestamps.length < 2 || progressMax <= 0) return null;

  // Average ms per step from recent timestamps (use last 10 for smoothing)
  const recent = stepTimestamps.slice(-11);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    intervals.push(recent[i] - recent[i - 1]);
  }
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const lastStepMs = intervals[intervals.length - 1];

  const stepsRemaining = progressMax - progress;
  const etaSeconds = (stepsRemaining * avgMs) / 1000;
  // Add time since last step for live countdown
  const sinceLastStep = (now - stepTimestamps[stepTimestamps.length - 1]) / 1000;
  const liveEta = Math.max(0, etaSeconds - sinceLastStep);

  const elapsed = (now - stepTimestamps[0]) / 1000;

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-gradient-to-r from-cyan-500/5 to-blue-500/5 p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-cyan-400/70 flex items-center gap-1">
          <Timer className="w-3 h-3" /> ETA
        </span>
        <span className="text-[10px] text-muted-foreground font-mono">
          {(avgMs / 1000).toFixed(1)}s/step · last {(lastStepMs / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-2xl font-mono font-bold text-cyan-400 tabular-nums tracking-tight">
          {formatTime(liveEta)}
        </span>
        <span className="text-[10px] text-cyan-400/50">remaining</span>
      </div>
      <div className="flex justify-between mt-1.5 text-[9px] text-muted-foreground font-mono">
        <span>Elapsed: {formatTime(elapsed)}</span>
        <span>{stepsRemaining} steps left</span>
      </div>
    </div>
  );
}

export default function RenderPanel({
  status,
  progress,
  progressMax,
  currentNode,
  onGenerate,
  onInterrupt,
  onSkip,
  onPauseBatch,
  onResumeBatch,
  batchPaused = false,
  isBatch = false,
  disabled,
  disabledReason,
  wsPreviewCount = 0,
  stepTimestamps = [],
  segmentProgress,
  passLabel,
  queue,
  queueRunning = false,
  onAddToQueue,
  onRunQueue,
  onStopQueue,
  onRemoveQueueItem,
  onClearQueue,
}: Props) {
  const isRunning = status === "generating" || status === "uploading" || status === "queued";
  const pct = progressMax > 0 ? (progress / progressMax) * 100 : 0;

  const statusLabels: Record<GenerationStatus, string> = {
    idle: "Ready",
    uploading: "Uploading character image...",
    queued: "Queued, waiting...",
    generating: `Generating... (${progress}/${progressMax})`,
    complete: "Complete!",
    error: "Error occurred",
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {isRunning ? (
          <>
            {isBatch && onSkip ? (
              batchPaused ? (
                <>
                  <Button
                    className="flex-1 gap-2"
                    onClick={onResumeBatch}
                    title="Resume the batch with the next item"
                  >
                    <Play className="w-4 h-4" /> Resume
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1 gap-2"
                    onClick={onInterrupt}
                    title="Cancel the rest of the batch"
                  >
                    <Square className="w-4 h-4" /> Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    className="flex-1 gap-2"
                    onClick={onSkip}
                    title="Skip the current item and start the next"
                  >
                    <SkipForward className="w-4 h-4" /> Skip
                  </Button>
                  {onPauseBatch && (
                    <Button
                      variant="secondary"
                      className="flex-1 gap-2"
                      onClick={onPauseBatch}
                      title="Finish the current item, then pause before the next"
                    >
                      <Pause className="w-4 h-4" /> Pause
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    className="flex-1 gap-2"
                    onClick={onInterrupt}
                    title="Cancel the entire batch and stop all remaining"
                  >
                    <Square className="w-4 h-4" /> Cancel All
                  </Button>
                </>
              )
            ) : (
              <Button
                variant="secondary"
                className="flex-1 gap-2"
                onClick={onInterrupt}
                title="Stop generation and keep any frames already rendered"
              >
                <Square className="w-4 h-4" /> Stop
              </Button>
            )}
          </>
        ) : (
          <>
            <Button
              className="flex-1 gap-2"
              onClick={onGenerate}
              disabled={disabled || queueRunning}
              title={queueRunning ? "Render queue is running" : disabledReason}
            >
              {queueRunning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Queue running…
                </>
              ) : status === "complete" ? (
                <>
                  <Play className="w-4 h-4" /> Generate Again
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" /> Generate
                </>
              )}
            </Button>
            {onAddToQueue && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={onAddToQueue}
                disabled={disabled}
                title={disabled ? disabledReason : "Add current settings to the render queue"}
              >
                <ListPlus className="w-4 h-4" /> Queue
              </Button>
            )}
          </>
        )}
      </div>

      {queue && queue.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground flex items-center gap-1">
              <ListVideo className="w-3 h-3" /> Render Queue
              <span className="text-muted-foreground/60">
                ({queue.filter((q) => q.status === "pending").length} pending
                {queue.some((q) => q.status === "running") ? ", 1 running" : ""})
              </span>
            </span>
            <div className="flex items-center gap-1">
              {queueRunning ? (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1 text-amber-400" onClick={onStopQueue} title="Stop after the current render finishes">
                  <Square className="w-3 h-3" /> Stop
                </Button>
              ) : (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1 text-emerald-400 disabled:opacity-40" onClick={onRunQueue} disabled={!queue.some((q) => q.status === "pending")} title="Run all pending jobs back-to-back">
                  <Play className="w-3 h-3" /> Run
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-destructive" onClick={onClearQueue} title="Clear queued jobs">
                <Trash2 className="w-3 h-3" /> Clear
              </Button>
            </div>
          </div>
          <ul className="space-y-1 max-h-40 overflow-auto">
            {queue.map((job) => (
              <li key={job.id} className="flex items-center gap-2 text-[10px] rounded px-1.5 py-1 bg-background/50">
                <QueueStatusIcon status={job.status} />
                <span className="font-mono text-[9px] uppercase text-muted-foreground/60 w-14 shrink-0 truncate">{job.mode}</span>
                <span className={`flex-1 truncate ${job.status === "done" ? "text-muted-foreground/50 line-through" : ""}`} title={job.label}>{job.label}</span>
                {onRemoveQueueItem && job.status !== "running" && (
                  <button onClick={() => onRemoveQueueItem(job.id)} className="text-muted-foreground/50 hover:text-destructive shrink-0" title="Remove from queue">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isRunning && (
        <div className="space-y-2">
          <Progress value={pct} className="h-2" />

          {/* Multi-segment progress indicator */}
          {segmentProgress && segmentProgress.totalSegments > 1 && (
            <div className="rounded-lg border border-violet-500/20 bg-gradient-to-r from-violet-500/5 to-purple-500/5 p-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-violet-400/70 font-medium">
                  Segment {segmentProgress.currentSegment + 1} of {segmentProgress.totalSegments}
                </span>
                <span className="text-[10px] text-violet-300/60 font-mono">
                  {segmentProgress.passLabel}
                </span>
              </div>
              <div className="flex gap-1">
                {segmentProgress.segmentStatuses.map((s, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-2 rounded-full transition-all duration-300 ${
                      s === "complete"
                        ? "bg-green-500"
                        : s === "active"
                        ? "bg-violet-500 animate-pulse"
                        : "bg-muted-foreground/20"
                    }`}
                    title={`Segment ${i + 1}: ${s}`}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{statusLabels[status]}</span>
            </div>
            {passLabel ? (
              <span className="font-mono text-[10px] text-violet-400/80">{passLabel}</span>
            ) : currentNode ? (
              <span className="font-mono text-[10px]">{currentNode}</span>
            ) : null}
            <span className={`font-mono text-[10px] ${wsPreviewCount > 0 ? "text-green-400" : "text-muted-foreground/50"}`}>
              {wsPreviewCount > 0 ? `${wsPreviewCount} previews` : "0 previews"}
            </span>
          </div>
          {status === "generating" && stepTimestamps.length >= 2 && (
            <ETACountdown
              stepTimestamps={stepTimestamps}
              progress={progress}
              progressMax={progressMax}
            />
          )}
        </div>
      )}

      {status === "error" && (
        <p className="text-xs text-destructive">{statusLabels.error}</p>
      )}

      {disabled && !isRunning && disabledReason && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <p className="text-[10px] font-medium text-amber-400 mb-1">Cannot generate yet:</p>
          <ul className="space-y-0.5">
            {disabledReason.split(" · ").map((reason, i) => (
              <li key={i} className="text-[10px] text-amber-400/70 flex items-start gap-1.5">
                <span className="mt-0.5 w-1 h-1 rounded-full bg-amber-400/50 flex-shrink-0" />
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
