"use client";

// ─────────────────────────────────────────────────────────────────────────────
// "Vek-Snap AI ✦": the top entry of a timeline clip's right-click menu (Phase 2
// of the Timeline↔Workflow integration). Three tiers of hover flyouts:
//   1. Vek-Snap AI ✦   (branded, styled)
//   2. Workflow         (by media kind: image → Z-Image / SDXL·SD1.5·Pony)
//   3. Saved configuration (the user's pre-configured Save files for that workflow)
// Audio clips have no clip-level AI workflow in this build (the menu hides itself),
// so right-clicking an audio clip shows no Vek-Snap AI entry.
// Picking a configuration ENQUEUES an AI Processing Queue job (deferred by
// default: it runs when the user presses Start in the queue panel).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import { Sparkles, ChevronRight, Loader2 } from "lucide-react";
import { aiQueueStore, AI_WORKFLOW_COLOR, type AIWorkflow } from "@/lib/ai-queue/store";

interface SavedConfig { name: string; savedAt: string; resourceCount: number }

const WF_BY_KIND: Record<"image" | "audio", { workflow: AIWorkflow; label: string }[]> = {
  image: [
    { workflow: "zimage", label: "Z-Image Turbo" },
    { workflow: "sdxl", label: "SDXL · SD1.5 · Pony" },
  ],
  audio: [],
};

export default function AIToolsMenu({ kind, clipId, assetId, sourcePath, sourceSrc, sourceName, onPicked }: {
  kind: "image" | "audio";
  clipId: string;
  assetId: string;
  sourcePath: string | undefined;
  sourceSrc: string;
  sourceName: string;
  onPicked: () => void;
}) {
  const [rootOpen, setRootOpen] = useState(false);
  const [openWf, setOpenWf] = useState<AIWorkflow | null>(null);
  const [configs, setConfigs] = useState<Record<string, SavedConfig[]>>({});
  const [loading, setLoading] = useState<AIWorkflow | null>(null);
  const disabled = !sourcePath;

  const loadConfigs = useCallback(async (wf: AIWorkflow) => {
    setOpenWf(wf);
    if (configs[wf]) return;
    setLoading(wf);
    try {
      const r = await fetch(`/api/workflow-config?workflow=${encodeURIComponent(wf)}`);
      const d = await r.json();
      if (d.ok) setConfigs((p) => ({ ...p, [wf]: d.configs as SavedConfig[] }));
    } catch { /* offline */ }
    setLoading(null);
  }, [configs]);

  const enqueue = (wf: AIWorkflow, label: string, configName: string) => {
    if (!sourcePath) return;
    aiQueueStore.add({ workflow: wf, workflowLabel: label, configName, clipId, assetId, sourcePath, sourceSrc, sourceName, kind });
    onPicked();
  };

  const workflows = WF_BY_KIND[kind];
  // No clip-level AI workflow for this media kind → render nothing (no dead menu).
  if (workflows.length === 0) return null;

  return (
    <>
    <div className="relative" onMouseEnter={() => setRootOpen(true)} onMouseLeave={() => { setRootOpen(false); setOpenWf(null); }}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 cursor-default select-none">
        <Sparkles className="w-3.5 h-3.5 text-violet-300" />
        <span className="font-semibold bg-gradient-to-r from-violet-300 via-fuchsia-300 to-sky-300 bg-clip-text text-transparent">Vek-Snap AI</span>
        <span className="text-[10px] text-fuchsia-300">✦</span>
        <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-60" />
      </div>

      {rootOpen && (
        disabled ? (
          <div className="absolute left-full top-0 ml-0.5 w-[190px] rounded-md border border-border/60 bg-card shadow-xl p-2 text-[10px] text-muted-foreground/70">
            This clip has no saved source file yet, so AI tools can’t run on it.
          </div>
        ) : (
          <div className="absolute left-full top-0 ml-0.5 min-w-[190px] rounded-md border border-border/60 bg-card shadow-xl py-1 z-50">
            {workflows.map((w) => (
              <div key={w.workflow} className="relative" onMouseEnter={() => void loadConfigs(w.workflow)}>
                <div className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-foreground/5 cursor-default text-[12px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: AI_WORKFLOW_COLOR[w.workflow] }} />
                  <span className="flex-1">{w.label}</span>
                  <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                </div>
                {openWf === w.workflow && (
                  <div className="absolute left-full top-0 ml-0.5 min-w-[210px] max-h-64 overflow-y-auto rounded-md border border-border/60 bg-card shadow-xl py-1">
                    {loading === w.workflow ? (
                      <div className="px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>
                    ) : configs[w.workflow]?.length ? (
                      configs[w.workflow].map((c) => (
                        <button key={c.name} className="w-full text-left px-3 py-1.5 hover:bg-foreground/5 text-[12px]" onClick={() => enqueue(w.workflow, w.label, c.name)}>
                          {c.name}
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-[10px] text-muted-foreground/70 leading-snug">
                        No saved configurations yet.<br />Create one in the {w.label} studio (Timeline Integration → Save Configuration).
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
    <div className="my-1 h-px bg-border/60" />
    </>
  );
}
