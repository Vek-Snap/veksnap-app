"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AI Processing Queue panel (Phase 3), pinned at the bottom of the Workflow
// Controls dock, collapsible. Lists deferred AI jobs enqueued from a timeline
// clip's "Vek-Snap AI ✦" menu. Drag to reorder priority; Start/Stop the runner;
// delete individual jobs or clear finished/all; opt-in auto-run.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { ChevronDown, ChevronUp, Play, Square, Trash2, X, GripVertical, Loader2, CheckCircle2, AlertCircle, Cpu } from "lucide-react";
import { aiQueueStore, useAIQueue, AI_WORKFLOW_COLOR, type AIQueueItem } from "@/lib/ai-queue/store";

function StatusBadge({ item }: { item: AIQueueItem }) {
  if (item.status === "running") return <span className="flex items-center gap-1 text-[9px] text-amber-300"><Loader2 className="w-3 h-3 animate-spin" />{item.progress || "Running…"}</span>;
  if (item.status === "done") return <span className="flex items-center gap-1 text-[9px] text-emerald-300"><CheckCircle2 className="w-3 h-3" />Done</span>;
  if (item.status === "error") return <span className="flex items-center gap-1 text-[9px] text-rose-300" title={item.error ?? ""}><AlertCircle className="w-3 h-3" />Error</span>;
  if (item.status === "cancelled") return <span className="text-[9px] text-muted-foreground/60">Cancelled</span>;
  return <span className="text-[9px] text-muted-foreground/60">Queued</span>;
}

export default function AIProcessingQueue() {
  const { items, running, autoRun, stopOnError } = useAIQueue();
  const [collapsed, setCollapsed] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const pending = items.filter((i) => i.status === "queued" || i.status === "running").length;

  return (
    <div className="shrink-0 border-t border-border/60 bg-[var(--sidebar)]/80">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Cpu className="w-3.5 h-3.5 text-fuchsia-300" />
        <span className="text-[11px] font-semibold text-foreground">AI Processing Queue</span>
        {pending > 0 && <span className="text-[9px] px-1.5 rounded-full bg-fuchsia-500/20 text-fuchsia-200">{pending}</span>}
        <button type="button" onClick={() => setCollapsed((c) => !c)}
          className="ml-auto p-0.5 rounded text-muted-foreground hover:text-foreground" title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {!collapsed && (
        <div className="px-2.5 pb-2.5 space-y-2">
          <div className="flex items-center gap-1.5">
            {running ? (
              <button type="button" onClick={() => aiQueueStore.setRunning(false)}
                className="inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium border border-rose-500/50 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25">
                <Square className="w-3 h-3" /> Stop
              </button>
            ) : (
              <button type="button" disabled={pending === 0} onClick={() => aiQueueStore.setRunning(true)}
                className="inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-medium border border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40">
                <Play className="w-3 h-3" /> Start
              </button>
            )}
            <button type="button" onClick={() => aiQueueStore.clearFinished()}
              className="px-2 py-1 rounded text-[10px] border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5">Clear finished</button>
            <button type="button" onClick={() => aiQueueStore.clearAll()}
              className="px-2 py-1 rounded text-[10px] border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5">Clear all</button>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1 text-[9px] text-muted-foreground cursor-pointer" title="On a job failure: keep this on to skip the failed job and carry on with the rest; turn it off to halt the whole queue on the first error.">
                <input type="checkbox" checked={!stopOnError} onChange={(e) => aiQueueStore.setStopOnError(!e.target.checked)} /> Skip errored
              </label>
              <label className="flex items-center gap-1 text-[9px] text-muted-foreground cursor-pointer" title="Run each job the instant it is queued (for powerful GPUs).">
                <input type="checkbox" checked={autoRun} onChange={(e) => aiQueueStore.setAutoRun(e.target.checked)} /> Auto-run
              </label>
            </div>
          </div>

          {items.length === 0 ? (
            <p className="text-[10px] text-muted-foreground/60 py-1">
              No jobs yet. Use <span className="text-amber-300">Send to Process Queue</span> on any generation page to stack renders, or right-click a timeline clip → <span className="text-fuchsia-300">Vek-Snap AI ✦</span>.
            </p>
          ) : (
            <div className="max-h-52 overflow-y-auto space-y-1">
              {items.map((item) => (
                <div
                  key={item.id}
                  draggable={item.status === "queued"}
                  onDragStart={() => setDragId(item.id)}
                  onDragOver={(e) => { if (dragId && dragId !== item.id) e.preventDefault(); }}
                  onDrop={() => { if (dragId && dragId !== item.id) aiQueueStore.reorder(dragId, item.id); setDragId(null); }}
                  className="flex items-center gap-1.5 rounded border border-border/50 bg-background/40 px-1.5 py-1"
                  style={{ borderLeft: `3px solid ${AI_WORKFLOW_COLOR[item.workflow]}` }}
                >
                  {item.status === "queued" && <GripVertical className="w-3 h-3 text-muted-foreground/40 cursor-grab shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 text-[11px] text-foreground truncate">
                      <span className="font-medium">{item.workflowLabel}</span>
                      {item.configName && <span className="text-muted-foreground/60">· {item.configName}</span>}
                      {item.jobType === "render" && <span className="text-muted-foreground/60">· → output</span>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[9px] text-muted-foreground/60 truncate">{item.jobType === "render" ? (item.outputKind ?? "render") : item.sourceName}</span>
                      <span className="ml-auto"><StatusBadge item={item} /></span>
                    </div>
                  </div>
                  {item.status === "queued" && (
                    <div className="flex flex-col shrink-0">
                      <button type="button" onClick={() => aiQueueStore.move(item.id, -1)} className="text-muted-foreground/40 hover:text-foreground leading-none" title="Move up"><ChevronUp className="w-3 h-3" /></button>
                      <button type="button" onClick={() => aiQueueStore.move(item.id, 1)} className="text-muted-foreground/40 hover:text-foreground leading-none" title="Move down"><ChevronDown className="w-3 h-3" /></button>
                    </div>
                  )}
                  <button type="button" onClick={() => aiQueueStore.remove(item.id)}
                    className="p-0.5 rounded text-muted-foreground/50 hover:text-rose-300 hover:bg-rose-500/10 shrink-0" title="Remove from queue">
                    {item.status === "running" ? <X className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
