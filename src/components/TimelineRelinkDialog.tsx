"use client";

// Industry-standard media relink. Detects offline clips (source moved on disk), lets
// the user point at a folder, scans it, proposes a new path per offline clip
// (matched by exact filename, then by stem), and re-points the chosen ones via
// the store. Brand-neutral: identical across app editions.

import { useCallback, useEffect, useMemo, useState } from "react";
import { X, Link2, FolderSearch, Loader2, CheckCircle2, AlertTriangle, RotateCw } from "lucide-react";
import { timelineStore } from "@/lib/timeline/store";
import type { TimelineAsset } from "@/lib/timeline/types";

type MatchKind = "exact" | "stem" | "none";
interface Match { id: string; name: string; path: string | null; match: MatchKind }

export default function TimelineRelinkDialog({ open, onClose, assets }: {
  open: boolean;
  onClose: () => void;
  assets: TimelineAsset[];
}) {
  const [offline, setOffline] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [folder, setFolder] = useState("");
  const [scanning, setScanning] = useState(false);
  const [matches, setMatches] = useState<Match[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const linkable = useMemo(() => assets.filter((a) => a.filePath), [assets]);
  const checkStatus = useCallback(async () => {
    setChecking(true); setError(null);
    try {
      const res = await fetch("/api/timeline-relink", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "status", targets: linkable.map((a) => ({ id: a.id, filePath: a.filePath })) }),
      });
      const j = await res.json();
      setOffline(Array.isArray(j.offline) ? j.offline : []);
    } catch { setError("Could not check media status."); } finally { setChecking(false); }
  }, [linkable]);

  useEffect(() => {
    if (!open) return;
    setMatches([]); setChosen(new Set()); setError(null);
    void checkStatus();
  }, [open, checkStatus]);

  const offlineAssets = useMemo(() => linkable.filter((a) => offline.includes(a.id)), [linkable, offline]);
  const matchById = useMemo(() => new Map(matches.map((m) => [m.id, m])), [matches]);

  const pickFolder = useCallback(async () => {
    try {
      const p = await window.electronAPI?.pickFolder?.();
      if (p) setFolder(p);
    } catch { /* picker unavailable in browser build */ }
  }, []);

  const scan = useCallback(async () => {
    if (!folder || offlineAssets.length === 0) return;
    setScanning(true); setError(null);
    try {
      const res = await fetch("/api/timeline-relink", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "scan", folder, targets: offlineAssets.map((a) => ({ id: a.id, name: a.name })) }),
      });
      const j = await res.json();
      if (j.error) { setError(j.error); setMatches([]); return; }
      const found: Match[] = Array.isArray(j.matches) ? j.matches : [];
      setMatches(found);
      setChosen(new Set(found.filter((m) => m.path).map((m) => m.id)));
    } catch { setError("Scan failed."); } finally { setScanning(false); }
  }, [folder, offlineAssets]);

  const apply = useCallback(() => {
    const entries = matches
      .filter((m) => m.path && chosen.has(m.id))
      .map((m) => ({ assetId: m.id, filePath: m.path as string }));
    if (entries.length) timelineStore.relinkAssets(entries);
    setMatches([]); setChosen(new Set());
    void checkStatus();
  }, [matches, chosen, checkStatus]);

  if (!open) return null;
  const chosenCount = matches.filter((m) => m.path && chosen.has(m.id)).length;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[560px] max-h-[80vh] flex flex-col rounded-lg border border-border/70 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
          <span className="flex items-center gap-2 text-[13px] font-semibold"><Link2 className="w-4 h-4 text-sky-300" /> Relink Media</span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto text-[12px]">
          {error && <div className="flex items-center gap-1.5 text-rose-300"><AlertTriangle className="w-3.5 h-3.5" /> {error}</div>}

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {checking ? "Checking media…"
                : offlineAssets.length === 0 ? "All media is online."
                : `${offlineAssets.length} offline clip${offlineAssets.length === 1 ? "" : "s"} need relinking.`}
            </span>
            <button type="button" onClick={() => void checkStatus()} title="Re-check" className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <RotateCw className="w-3 h-3" /> Recheck
            </button>
          </div>

          {offlineAssets.length > 0 && (
            <>
              <div className="flex items-center gap-2">
                <input
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="Folder to search for the moved files…"
                  className="flex-1 bg-background border border-border/60 rounded px-2 py-1 text-[11px] outline-none focus:border-sky-400/60"
                />
                <button type="button" onClick={pickFolder} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border/60 text-[11px] hover:bg-foreground/10">
                  <FolderSearch className="w-3.5 h-3.5" /> Browse
                </button>
                <button type="button" onClick={scan} disabled={!folder || scanning}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-sky-500/50 bg-sky-500/15 text-sky-200 text-[11px] hover:bg-sky-500/25 disabled:opacity-40">
                  {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderSearch className="w-3.5 h-3.5" />} Scan
                </button>
              </div>

              <div className="space-y-1 max-h-[36vh] overflow-y-auto">
                {offlineAssets.map((a) => {
                  const m = matchById.get(a.id);
                  const hasMatch = !!m?.path;
                  return (
                    <div key={a.id} className="flex items-center gap-2 px-2 py-1 rounded border border-border/50 bg-background/40">
                      <input type="checkbox" disabled={!hasMatch}
                        checked={hasMatch && chosen.has(a.id)}
                        onChange={(e) => setChosen((prev) => { const n = new Set(prev); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })}
                        className="accent-sky-500 w-3.5 h-3.5 disabled:opacity-30" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-foreground/90">{a.name}</div>
                        {m ? (
                          hasMatch
                            ? <div className="truncate text-[10px] text-emerald-300/90 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> {m.match === "exact" ? "Found" : "Found (renamed ext)"}: {m.path}</div>
                            : <div className="text-[10px] text-amber-300/80">No match in this folder</div>
                        ) : (
                          <div className="truncate text-[10px] text-muted-foreground/60">{a.filePath}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border/60">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-[12px] border border-border/60 hover:bg-foreground/5">Close</button>
          <button type="button" onClick={apply} disabled={chosenCount === 0}
            className="px-3 py-1.5 rounded text-[12px] font-medium border border-sky-500/50 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 disabled:opacity-40 inline-flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5" /> Relink {chosenCount > 0 ? `(${chosenCount})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
