"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ModelPathsPanel: reusable "where are my models?" editor.
//
// Manages the extra model ROOT directories that ComfyUI searches (written to
// extra_model_paths.yaml, one root fanned out across every model subfolder:
// checkpoints, loras, vae, text_encoders, …). Backed by the same /api/settings
// contract the classic ModelSelector uses:
//   GET  /api/settings                      -> { extraCheckpointDirs: string[] }
//   POST /api/settings { action, dir }       -> { extraCheckpointDirs } | { error }
//
// Shared so both the Modern "System Settings" panel and the Classic services
// area can drop it in. Purely self-contained (own fetch + state).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { FolderPlus, X, FolderCog, RefreshCw, HardDrive, FolderSearch } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ModelPathsPanel({ className = "" }: { className?: string }) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [newDir, setNewDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only show the native "Browse" button when running inside the Electron shell.
  const [hasPicker, setHasPicker] = useState(false);
  useEffect(() => {
    setHasPicker(typeof window !== "undefined" && typeof window.electronAPI?.pickFolder === "function");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setDirs(data.extraCheckpointDirs ?? []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const addPath = useCallback(async (raw: string) => {
    const dir = raw.trim();
    if (!dir || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", dir }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Could not add that path."); }
      else { setDirs(data.extraCheckpointDirs); setNewDir(""); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add path.");
    }
    setBusy(false);
  }, [busy]);

  const addDir = useCallback(() => addPath(newDir), [addPath, newDir]);

  // Open the native folder picker (Electron), then add the chosen folder directly.
  const browseDir = useCallback(async () => {
    if (busy || !window.electronAPI?.pickFolder) return;
    try {
      const picked = await window.electronAPI.pickFolder();
      if (picked) await addPath(picked);
    } catch { /* cancelled or unavailable */ }
  }, [busy, addPath]);

  const removeDir = useCallback(async (dir: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", dir }),
      });
      if (res.ok) { const data = await res.json(); setDirs(data.extraCheckpointDirs); }
    } catch { /* ignore */ }
    setBusy(false);
  }, []);

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex items-start gap-3">
        <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/40 shrink-0">
          <HardDrive className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">Model file locations</h3>
          <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
            Add the folders where your models live. Each root is searched for every
            model type (checkpoints, LoRAs, VAE, text encoders, and more). ComfyUI
            must be restarted after changes for them to take effect.
          </p>
        </div>
      </div>

      {/* Current roots */}
      <div className="space-y-1.5">
        {loading ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3 animate-spin" /> Loading paths…
          </p>
        ) : dirs.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No extra model folders yet. Add one below, or place files in ComfyUI/models/.
          </p>
        ) : (
          dirs.map((dir) => (
            <div key={dir} className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
              <FolderCog className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate font-mono text-[11px] text-foreground/90" title={dir}>{dir}</span>
              <button
                type="button"
                onClick={() => removeDir(dir)}
                disabled={busy}
                className="text-destructive/60 hover:text-destructive disabled:opacity-40 shrink-0"
                title="Remove this path"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Add new root */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newDir}
          onChange={(e) => setNewDir(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addDir()}
          placeholder="Paste a folder path (e.g. D:\Models) or click Browse"
          className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-[12px] font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {hasPicker && (
          <Button variant="outline" size="sm" className="h-9 px-3 gap-1.5" onClick={browseDir} disabled={busy} title="Browse for a folder">
            <FolderSearch className="w-3.5 h-3.5" /> Browse
          </Button>
        )}
        <Button variant="outline" size="sm" className="h-9 px-3 gap-1.5" onClick={addDir} disabled={busy || !newDir.trim()}>
          <FolderPlus className="w-3.5 h-3.5" /> Add
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        Paste the path straight from Explorer. Quotes and backslashes are handled for you.
      </p>
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="flex items-center justify-between pt-1 border-t border-border/60">
        <span className="text-[10px] text-muted-foreground/70">
          Advanced: edit the raw mapping file directly.
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px] gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => fetch("/api/settings/open-model-paths", { method: "POST" }).catch(() => {})}
          title="Open extra_model_paths.yaml in your editor"
        >
          <FolderCog className="w-3.5 h-3.5" /> Open extra_model_paths.yaml
        </Button>
      </div>
    </div>
  );
}
