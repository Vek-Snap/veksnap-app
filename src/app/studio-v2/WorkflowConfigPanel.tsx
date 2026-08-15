"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Save, FolderOpen, Trash2, X, Loader2, Link2, FileUp, Clock } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Timeline Integration: per-workflow Save / Load Configuration (Phase 1).
//
// Pinned at the bottom of the Workflow Controls dock for the AI workflows that
// the Timeline Editor can call (SDXL/SD1.5/Pony, Z-Image Turbo, DramaBox). It
// reads/writes the SAME localStorage key each studio already persists to, so:
//   • Save  → POST the current params to /api/workflow-config (a named on-disk
//             folder, independent of the app-wide Quick Save), optionally copying
//             referenced resources (e.g. a DramaBox voice reference) beside it.
//   • Load  → GET a saved config's params, write them to the studio's localStorage
//             key, then remount the studio (onApplied) so it hydrates immediately.
//   • Load from main save file → extract just THIS workflow's slice out of a full
//             Quick Save .json.
// ─────────────────────────────────────────────────────────────────────────────

interface SavedConfig { name: string; savedAt: string; resourceCount: number }

// Where each workflow's slice lives inside a full Quick Save (.json) file.
const MAIN_SAVE_PATH: Record<string, string[]> = {
  sdxl: ["imageStudios", "sdxl"],
  zimage: ["imageStudios", "zimage"],
  dramabox: ["dramaBoxConfig"],
};

// Resources worth copying beside a saved config (ephemeral / easily-lost files).
// DramaBox's uploaded voice reference lives in ComfyUI/input and is the prime example.
function gatherResources(workflow: string, params: Record<string, unknown> | null): { label: string; comfyInput?: string }[] {
  if (!params) return [];
  if (workflow === "dramabox" && typeof params.voiceRefFile === "string" && params.voiceRefFile) {
    return [{ label: `Voice reference (${params.voiceRefFile})`, comfyInput: params.voiceRefFile }];
  }
  return [];
}

export default function WorkflowConfigPanel({ workflow, lsKey, label, onApplied }: {
  workflow: string;
  lsKey: string;
  label: string;
  onApplied: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "save" | "load">("idle");
  const [name, setName] = useState("");
  const [copyResources, setCopyResources] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [list, setList] = useState<SavedConfig[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const readParams = useCallback((): Record<string, unknown> | null => {
    try { const v = localStorage.getItem(lsKey); return v ? (JSON.parse(v) as Record<string, unknown>) : null; } catch { return null; }
  }, [lsKey]);

  const resources = gatherResources(workflow, readParams());
  const hasResources = resources.length > 0;

  const refreshList = useCallback(async () => {
    try {
      const r = await fetch(`/api/workflow-config?workflow=${encodeURIComponent(workflow)}`);
      const d = await r.json();
      if (d.ok) setList(d.configs as SavedConfig[]);
    } catch { /* offline / route missing */ }
  }, [workflow]);

  const doSave = useCallback(async (overwrite: boolean): Promise<void> => {
    const params = readParams();
    if (!params) { setError("Nothing to save yet: set some options first."); return; }
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = { action: "save", workflow, name: name.trim(), params, overwrite };
      if (copyResources && hasResources) body.resources = resources;
      const r = await fetch("/api/workflow-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.status === 409) {
        if (window.confirm(`A configuration named "${d.name}" already exists. Overwrite it?`)) { await doSave(true); return; }
        setBusy(false); return;
      }
      if (!d.ok) throw new Error(d.error || "Save failed.");
      setStatus(`Saved "${d.name}".`); setName(""); setMode("idle"); await refreshList();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [readParams, workflow, name, copyResources, hasResources, resources, refreshList]);

  const doLoad = useCallback(async (cfgName: string): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/workflow-config?workflow=${encodeURIComponent(workflow)}&name=${encodeURIComponent(cfgName)}`);
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Load failed.");
      localStorage.setItem(lsKey, JSON.stringify(d.config.params));
      onApplied();
      setStatus(`Loaded "${cfgName}".`); setMode("idle");
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [workflow, lsKey, onApplied]);

  const doDelete = useCallback(async (cfgName: string): Promise<void> => {
    if (!window.confirm(`Delete the configuration "${cfgName}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await fetch("/api/workflow-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", workflow, name: cfgName }) });
      await refreshList();
    } catch { /* ignore */ }
    setBusy(false);
  }, [workflow, refreshList]);

  const loadFromMain = useCallback((file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as Record<string, unknown>;
        let node: unknown = data;
        for (const k of MAIN_SAVE_PATH[workflow] ?? []) node = (node as Record<string, unknown> | undefined)?.[k];
        if (!node) { setError(`No ${label} settings were found in that file.`); return; }
        localStorage.setItem(lsKey, JSON.stringify(node));
        onApplied();
        setStatus(`Imported ${label} settings from ${file.name}.`); setMode("idle");
      } catch { setError("That does not look like a valid Vek-Snap settings file."); }
    };
    reader.readAsText(file);
  }, [workflow, lsKey, label, onApplied]);

  useEffect(() => { if (mode === "load") void refreshList(); }, [mode, refreshList]);
  // Reset transient UI whenever the active workflow changes.
  useEffect(() => { setMode("idle"); setError(null); setStatus(null); setName(""); }, [workflow]);

  const BTN = "inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium border transition-colors";

  return (
    <div className="shrink-0 border-t border-border/60 bg-[var(--sidebar)]/60 p-2.5 space-y-2">
      <div className="flex items-center gap-1.5">
        <Link2 className="w-3.5 h-3.5 text-violet-300" />
        <span className="text-[11px] font-semibold text-foreground">Timeline Integration</span>
        <span className="ml-auto text-[9px] text-muted-foreground/70 truncate">{label}</span>
      </div>

      {mode === "idle" && (
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => { setMode("save"); setError(null); setStatus(null); }}
            className={`${BTN} flex-1 border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20`}
            title="Save this workflow's current settings as a named configuration the Timeline Editor can call.">
            <Save className="w-3.5 h-3.5" /> Save Configuration
          </button>
          <button type="button" onClick={() => { setMode("load"); setError(null); setStatus(null); }}
            className={`${BTN} flex-1 border-border/60 bg-card/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5`}
            title="Load a previously saved configuration into this workflow.">
            <FolderOpen className="w-3.5 h-3.5" /> Load Configuration
          </button>
        </div>
      )}

      {mode === "save" && (
        <div className="space-y-2 rounded-md border border-violet-500/30 bg-violet-500/5 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-violet-200">Save Configuration</span>
            <button type="button" onClick={() => setMode("idle")} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
          </div>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Configuration name (blank = auto-numbered)"
            onKeyDown={(e) => { if (e.key === "Enter" && !busy) void doSave(false); }}
            className="w-full bg-card border border-border/60 rounded px-2 py-1.5 text-[11px]"
          />
          {hasResources && (
            <label className="flex items-start gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={copyResources} onChange={(e) => setCopyResources(e.target.checked)} className="mt-0.5" />
              <span>Save a copy of referenced resources ({resources.map((r) => r.label).join(", ")}) beside this configuration so it still works if the original is moved or cleaned.</span>
            </label>
          )}
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={busy} onClick={() => void doSave(false)}
              className={`${BTN} flex-1 border-violet-500/50 bg-violet-500/20 text-violet-100 hover:bg-violet-500/30 disabled:opacity-50`}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </button>
          </div>
        </div>
      )}

      {mode === "load" && (
        <div className="space-y-2 rounded-md border border-border/60 bg-card/40 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-foreground/80">Load Configuration</span>
            <button type="button" onClick={() => setMode("idle")} className="text-muted-foreground hover:text-foreground"><X className="w-3.5 h-3.5" /></button>
          </div>
          {list.length === 0 ? (
            <p className="text-[10px] text-muted-foreground/70 py-1">No saved configurations yet for {label}.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1">
              {list.map((c) => (
                <div key={c.name} className="flex items-center gap-1.5 rounded border border-border/50 bg-background/40 px-2 py-1">
                  <button type="button" disabled={busy} onClick={() => void doLoad(c.name)}
                    className="flex-1 min-w-0 text-left disabled:opacity-50" title="Load this configuration.">
                    <span className="block text-[11px] text-foreground truncate">{c.name}</span>
                    <span className="flex items-center gap-1 text-[8px] text-muted-foreground/60">
                      <Clock className="w-2.5 h-2.5" />
                      {c.savedAt ? new Date(c.savedAt).toLocaleString() : "-"}
                      {c.resourceCount > 0 && <span className="ml-1">· {c.resourceCount} resource{c.resourceCount > 1 ? "s" : ""}</span>}
                    </span>
                  </button>
                  <button type="button" disabled={busy} onClick={() => void doDelete(c.name)}
                    className="p-1 rounded text-muted-foreground/50 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-50" title="Delete this configuration.">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => fileRef.current?.click()}
            className={`${BTN} w-full border-border/60 bg-card/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5`}
            title="Extract just this workflow's settings out of a full Vek-Snap Quick Save file.">
            <FileUp className="w-3.5 h-3.5" /> Load from main save file…
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFromMain(f); e.target.value = ""; }} />
        </div>
      )}

      {error && <p className="text-[10px] text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded px-2 py-1">{error}</p>}
      {status && !error && <p className="text-[10px] text-emerald-300">{status}</p>}
    </div>
  );
}
