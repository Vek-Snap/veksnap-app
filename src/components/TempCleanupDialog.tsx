"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Trash2, RefreshCw, Database, FolderInput, FileStack,
  ScrollText, Film, Loader2, HardDrive,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import ConfirmDialog from "@/components/ConfirmDialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Human-readable byte sizes ──
function formatBytes(n: number): string {
  if (!n || n < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

// ── Per-category icon ──
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  appCache: Database,
  comfyInput: FolderInput,
  comfyTemp: FileStack,
  osScratch: ScrollText,
  appScratch: HardDrive,
  output: Film,
};

export default function TempCleanupDialog({ open, onOpenChange }: Props) {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;

  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<TempCategory[]>([]);
  const [clearAllIds, setClearAllIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // category id, or "__all__"
  const [clearOnExit, setClearOnExit] = useState(false);
  const [lastFreed, setLastFreed] = useState<number | null>(null);

  // Confirmation dialogs for destructive actions
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [confirmOutputOpen, setConfirmOutputOpen] = useState(false);

  // ── Scan sizes ──
  const rescan = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const res = await api.tempScan();
      setCategories(res.categories);
      setClearAllIds(res.clearAllIds);
    } catch { /* ignore */ }
    setLoading(false);
  }, [api]);

  // Initial scan + load the on-exit preference whenever the dialog opens
  useEffect(() => {
    if (!open || !api) return;
    setLastFreed(null);
    rescan();
    api.getClearTempOnExit().then(setClearOnExit).catch(() => {});
  }, [open, api, rescan]);

  // ── Clear a set of categories ──
  const clear = useCallback(async (ids: string[], busyKey: string) => {
    if (!api || ids.length === 0) return;
    setBusy(busyKey);
    setLastFreed(null);
    try {
      const res = await api.tempClear(ids);
      const freed = res.cleared.reduce((sum, c) => sum + c.freedBytes, 0);
      setLastFreed(freed);
    } catch { /* ignore */ }
    setBusy(null);
    await rescan();
  }, [api, rescan]);

  const toggleClearOnExit = useCallback(async (v: boolean) => {
    if (!api) return;
    setClearOnExit(v);
    try { await api.setClearTempOnExit(v); } catch { setClearOnExit(!v); }
  }, [api]);

  const visible = categories.filter((c) => !c.protected);
  const output = categories.find((c) => c.protected);
  const reclaimable = visible.reduce((sum, c) => sum + c.bytes, 0);
  const anyBusy = busy !== null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-cyan-400" />
              Clear Temporary Files
            </DialogTitle>
            <DialogDescription>
              Free up disk space by clearing Vek-Snap&apos;s working files and caches. Your saved
              settings and finished renders are never touched unless you explicitly choose to.
            </DialogDescription>
          </DialogHeader>

          {!api ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Temporary-file cleanup is only available in the Vek-Snap desktop app.
            </div>
          ) : (
            <>
              {/* ── Category rows ── */}
              <div className="space-y-2 max-h-[42vh] overflow-y-auto pr-1">
                {visible.map((cat) => {
                  const Icon = ICONS[cat.id] ?? FileStack;
                  const rowBusy = busy === cat.id;
                  return (
                    <div
                      key={cat.id}
                      className="flex items-center gap-3 rounded-lg border border-border bg-card/40 px-3 py-2.5"
                    >
                      <Icon className="w-5 h-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{cat.label}</div>
                        <div className="text-[11px] text-muted-foreground/80 leading-snug">{cat.description}</div>
                      </div>
                      <div className="w-20 text-right text-xs tabular-nums font-semibold text-foreground/80">
                        {loading ? <span className="text-muted-foreground/50">…</span> : formatBytes(cat.bytes)}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={anyBusy || loading || cat.bytes === 0}
                        onClick={() => clear([cat.id], cat.id)}
                      >
                        {rowBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        Clear
                      </Button>
                    </div>
                  );
                })}
              </div>

              {/* ── Protected: rendered output ── */}
              {output && (
                <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                  <Film className="w-5 h-5 shrink-0 text-amber-400" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium flex items-center gap-1.5">
                      {output.label}
                      <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
                        Protected
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground/80 leading-snug">{output.description}</div>
                  </div>
                  <div className="w-20 text-right text-xs tabular-nums font-semibold text-foreground/80">
                    {loading ? <span className="text-muted-foreground/50">…</span> : formatBytes(output.bytes)}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 border-amber-500/40 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                    disabled={anyBusy || loading || output.bytes === 0}
                    onClick={() => setConfirmOutputOpen(true)}
                  >
                    {busy === "output" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Clear
                  </Button>
                </div>
              )}

              {/* ── Result line ── */}
              {lastFreed !== null && (
                <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                  <Trash2 className="w-3.5 h-3.5" />
                  Freed {formatBytes(lastFreed)}.
                </div>
              )}

              {/* ── Footer actions ── */}
              <div className="flex items-center justify-between gap-3 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  disabled={anyBusy || loading}
                  onClick={rescan}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                  Rescan
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-8"
                  disabled={anyBusy || loading || reclaimable === 0}
                  onClick={() => setConfirmAllOpen(true)}
                >
                  {busy === "__all__" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Clear All ({formatBytes(reclaimable)})
                </Button>
              </div>

              {/* ── Persistent on-exit toggle ── */}
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5 mt-1">
                <Switch
                  checked={clearOnExit}
                  onCheckedChange={toggleClearOnExit}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">Clear caches &amp; working files on exit</div>
                  <div className="text-[11px] text-muted-foreground/80 leading-snug">
                    When Vek-Snap closes, automatically wipe app caches, ComfyUI source/staging and
                    intermediates. Your finished renders in <span className="font-medium">output</span> are
                    never removed. Off by default.
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Clear All confirmation ── */}
      <ConfirmDialog
        open={confirmAllOpen}
        onOpenChange={setConfirmAllOpen}
        title="Clear all temporary files?"
        description={`This permanently deletes app caches, ComfyUI source/staging files, intermediates and logs (about ${formatBytes(reclaimable)}). Your finished renders are NOT affected. Continue?`}
        confirmLabel="Clear All"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => clear(clearAllIds, "__all__")}
      />

      {/* ── Output (renders) confirmation ── */}
      <ConfirmDialog
        open={confirmOutputOpen}
        onOpenChange={setConfirmOutputOpen}
        title="Delete your rendered output?"
        description={`This permanently deletes EVERYTHING in ComfyUI/output${output ? ` (about ${formatBytes(output.bytes)})` : ""}: these are your finished renders. This cannot be undone. Are you absolutely sure?`}
        confirmLabel="Delete Renders"
        cancelLabel="Keep My Renders"
        variant="destructive"
        onConfirm={() => clear(["output"], "output")}
      />
    </>
  );
}
