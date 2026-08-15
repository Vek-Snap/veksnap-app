"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  HardDrive,
  ChevronDown,
  ChevronRight,
  Plus,
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
} from "lucide-react";

// ── Types ──

interface PageFileInfo {
  drive: string;
  path: string;
  allocatedMB: number;
  usedMB: number;
  peakMB: number;
  isSystemManaged: boolean;
  initialSizeMB: number;
  maxSizeMB: number;
}

interface DriveInfo {
  letter: string;
  freeSpaceMB: number;
  totalSpaceMB: number;
  hasPageFile: boolean;
}

interface VirtualMemoryStats {
  physicalRAM_MB: number;
  commitTotalMB: number;
  commitLimitMB: number;
  commitPeakMB: number;
  pageFiles: PageFileInfo[];
  drives: DriveInfo[];
}

// ── Helpers ──

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function usagePct(used: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((used / total) * 1000) / 10;
}

function getBarColor(pct: number): string {
  if (pct < 50) return "#22c55e";
  if (pct < 75) return "#eab308";
  if (pct < 90) return "#f97316";
  return "#ef4444";
}

// ── Component ──

export default function VirtualMemoryPanel() {
  const [stats, setStats] = useState<VirtualMemoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced form state
  const [selectedDrive, setSelectedDrive] = useState<string>("");
  const [minSize, setMinSize] = useState(8192);
  const [maxSize, setMaxSize] = useState(16384);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Confirmation dialog
  const [confirmOpen, setConfirmOpen] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/virtual-memory", { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error("Failed to fetch");
      const data: VirtualMemoryStats = await res.json();
      setStats(data);
      setError(null);

      // Set sensible defaults for form if not yet set
      if (!selectedDrive && data.drives.length > 0) {
        // Prefer a drive WITHOUT an existing page file, otherwise first drive
        const noPf = data.drives.find((d) => !d.hasPageFile && d.freeSpaceMB > 8192);
        setSelectedDrive(noPf?.letter ?? data.drives[0].letter);
      }
    } catch {
      setError("Could not read virtual memory stats");
    }
  }, [selectedDrive]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const handleApply = async () => {
    setConfirmOpen(false);
    setApplying(true);
    setApplyResult(null);

    try {
      const res = await fetch("/api/virtual-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          driveLetter: selectedDrive,
          minSizeMB: minSize,
          maxSizeMB: maxSize,
        }),
      });
      const result = await res.json();
      if (result.success) {
        setApplyResult({ ok: true, msg: result.message });
        // Refresh stats
        setTimeout(fetchStats, 1000);
      } else {
        setApplyResult({ ok: false, msg: result.error || "Unknown error" });
      }
    } catch (err) {
      setApplyResult({ ok: false, msg: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setApplying(false);
    }
  };

  if (!stats) {
    return (
      <Card>
        <CardContent className="p-3 text-[10px] text-muted-foreground text-center">
          {error || "Loading virtual memory info..."}
        </CardContent>
      </Card>
    );
  }

  const totalPageFileMB = stats.pageFiles.reduce((sum, pf) => sum + pf.allocatedMB, 0);
  const totalPageFileUsedMB = stats.pageFiles.reduce((sum, pf) => sum + pf.usedMB, 0);
  const commitPct = usagePct(stats.commitTotalMB, stats.commitLimitMB);
  const pageFilePct = usagePct(totalPageFileUsedMB, totalPageFileMB);

  // Drive selected for new page file
  const selDrive = stats.drives.find((d) => d.letter === selectedDrive);
  const driveMaxMB = selDrive ? Math.floor(selDrive.freeSpaceMB * 0.75) : 0;
  const ramCeiling = stats.physicalRAM_MB * 3;
  const effectiveMax = Math.min(driveMaxMB, ramCeiling);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-1 pt-3 px-3">
        <CardTitle
          className="text-[11px] font-medium flex items-center justify-between cursor-pointer select-none"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-orange-400" />
            Virtual Memory
          </span>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[9px] font-mono">
              {formatSize(totalPageFileMB)}
            </Badge>
            {expanded ? (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            )}
          </div>
        </CardTitle>
      </CardHeader>

      {/* Commit Charge bar: always visible */}
      <CardContent className="px-3 pb-2 space-y-1.5">
        <div className="space-y-1">
          <div className="flex justify-between text-[10px]">
            <span className="text-muted-foreground">Commit Charge</span>
            <span className="font-mono">
              {formatSize(stats.commitTotalMB)} / {formatSize(stats.commitLimitMB)}
            </span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.min(commitPct, 100)}%`, backgroundColor: getBarColor(commitPct) }}
            />
          </div>
        </div>

        {/* Page file usage bar */}
        {totalPageFileMB > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px]">
              <span className="text-muted-foreground">Page File Usage</span>
              <span className="font-mono">
                {formatSize(totalPageFileUsedMB)} / {formatSize(totalPageFileMB)}
              </span>
            </div>
            <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(pageFilePct, 100)}%`,
                  backgroundColor: getBarColor(pageFilePct),
                }}
              />
            </div>
          </div>
        )}
      </CardContent>

      {/* Expanded details */}
      {expanded && (
        <CardContent className="px-3 pb-3 pt-0 space-y-3">
          {/* Physical RAM reference */}
          <div className="text-[10px] text-muted-foreground flex justify-between">
            <span>Physical RAM</span>
            <span className="font-mono">{formatSize(stats.physicalRAM_MB)}</span>
          </div>

          {/* Per-file table */}
          {stats.pageFiles.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-muted-foreground font-medium">Active Page Files</p>
              {stats.pageFiles.map((pf) => {
                const pfPct = usagePct(pf.usedMB, pf.allocatedMB);
                return (
                  <div
                    key={pf.path}
                    className="rounded border border-white/5 bg-black/20 p-2 space-y-1"
                  >
                    <div className="flex justify-between text-[10px]">
                      <span className="font-mono text-orange-300">{pf.drive}:</span>
                      <div className="flex gap-2">
                        <span className="text-muted-foreground">
                          {formatSize(pf.usedMB)} / {formatSize(pf.allocatedMB)}
                        </span>
                        {pf.isSystemManaged && (
                          <Badge variant="outline" className="text-[8px] h-4 px-1 border-blue-500/30 text-blue-400">
                            Auto
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(pfPct, 100)}%`, backgroundColor: getBarColor(pfPct) }}
                      />
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground">
                      <span>Peak: {formatSize(pf.peakMB)}</span>
                      <span>{pf.path}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {stats.pageFiles.length === 0 && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />
              <p className="text-[9px] text-red-400/90 leading-tight">
                No active page files detected. The system may crash under memory pressure.
              </p>
            </div>
          )}

          {/* Info note */}
          <div className="rounded border border-orange-500/20 bg-orange-500/5 p-2 flex items-start gap-1.5">
            <Info className="w-3 h-3 text-orange-400 shrink-0 mt-0.5" />
            <p className="text-[9px] text-orange-400/80 leading-tight">
              AI workloads with large models (22B+) benefit from generous page file sizes.
              Recommended: at least 1× physical RAM.
            </p>
          </div>

          {/* Advanced: Create / Extend */}
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-[10px] h-6 text-orange-400 hover:text-orange-300 hover:bg-orange-500/10"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? (
                <ChevronDown className="w-3 h-3 mr-1" />
              ) : (
                <Plus className="w-3 h-3 mr-1" />
              )}
              {showAdvanced ? "Hide Quick Boost" : "Quick Boost: Add / Extend Page File"}
            </Button>

            {showAdvanced && (
              <div className="mt-2 space-y-3 rounded border border-orange-500/20 bg-orange-500/5 p-3">
                {/* Drive selector */}
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground">Target Drive</label>
                  <Select value={selectedDrive} onValueChange={setSelectedDrive}>
                    <SelectTrigger className="h-7 text-[10px]">
                      <SelectValue placeholder="Select drive" />
                    </SelectTrigger>
                    <SelectContent>
                      {stats.drives.map((d) => (
                        <SelectItem key={d.letter} value={d.letter} className="text-[11px]">
                          {d.letter}: {formatSize(d.freeSpaceMB)} free / {formatSize(d.totalSpaceMB)}
                          {d.hasPageFile ? " (has pagefile)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Min size slider */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">Initial Size</span>
                    <span className="font-mono text-orange-300">{formatSize(minSize)}</span>
                  </div>
                  <Slider
                    min={1024}
                    max={Math.max(effectiveMax, 1024)}
                    step={1024}
                    value={[minSize]}
                    onValueChange={([v]) => {
                      setMinSize(v);
                      if (v > maxSize) setMaxSize(v);
                    }}
                    className="[&_[role=slider]]:bg-orange-400"
                  />
                </div>

                {/* Max size slider */}
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">Maximum Size</span>
                    <span className="font-mono text-orange-300">{formatSize(maxSize)}</span>
                  </div>
                  <Slider
                    min={minSize}
                    max={Math.max(effectiveMax, minSize)}
                    step={1024}
                    value={[maxSize]}
                    onValueChange={([v]) => setMaxSize(v)}
                    className="[&_[role=slider]]:bg-orange-400"
                  />
                </div>

                {/* Size reference */}
                <div className="text-[9px] text-muted-foreground space-y-0.5">
                  <div className="flex justify-between">
                    <span>Physical RAM</span>
                    <span>{formatSize(stats.physicalRAM_MB)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Safety ceiling (3× RAM)</span>
                    <span>{formatSize(ramCeiling)}</span>
                  </div>
                  {selDrive && (
                    <div className="flex justify-between">
                      <span>{selectedDrive}: free (75% cap)</span>
                      <span>{formatSize(driveMaxMB)}</span>
                    </div>
                  )}
                </div>

                {/* Warning for existing page file on this drive */}
                {selDrive?.hasPageFile && (
                  <div className="rounded border border-amber-500/20 bg-amber-500/5 p-2 flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-[9px] text-amber-400/80 leading-tight">
                      Drive {selectedDrive}: already has a page file. This will attempt to <strong>extend</strong> it.
                      The kernel only allows increasing, never shrinking.
                    </p>
                  </div>
                )}

                {/* Apply button */}
                <Button
                  size="sm"
                  className="w-full text-[10px] h-7 bg-orange-600 hover:bg-orange-500 text-white"
                  onClick={() => setConfirmOpen(true)}
                  disabled={applying || effectiveMax < 1024}
                >
                  {applying ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      Applying...
                    </>
                  ) : (
                    <>
                      <Plus className="w-3 h-3 mr-1" />
                      {selDrive?.hasPageFile ? "Extend Page File" : "Create Page File"}
                    </>
                  )}
                </Button>

                {/* Result feedback */}
                {applyResult && (
                  <div
                    className={`rounded border p-2 flex items-start gap-1.5 ${
                      applyResult.ok
                        ? "border-green-500/30 bg-green-500/10"
                        : "border-red-500/30 bg-red-500/10"
                    }`}
                  >
                    {applyResult.ok ? (
                      <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />
                    )}
                    <p
                      className={`text-[9px] leading-tight ${
                        applyResult.ok ? "text-green-400/90" : "text-red-400/90"
                      }`}
                    >
                      {applyResult.msg}
                    </p>
                  </div>
                )}

                <p className="text-[9px] text-muted-foreground leading-tight">
                  Takes effect immediately: no reboot required. Uses the NtCreatePagingFile kernel API.
                  Only increases are supported; to shrink, change settings via System Properties and reboot.
                </p>
              </div>
            )}
          </div>
        </CardContent>
      )}

      {/* Confirmation dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-orange-400">
              {selDrive?.hasPageFile ? "Extend Page File" : "Create Page File"}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-2">
                <p className="text-sm">
                  This will {selDrive?.hasPageFile ? "extend the existing" : "create a new"} page file on{" "}
                  <strong>{selectedDrive}:</strong> with:
                </p>
                <div className="rounded bg-muted/50 p-2 font-mono text-xs space-y-1">
                  <div className="flex justify-between">
                    <span>Initial size:</span>
                    <span>{formatSize(minSize)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Maximum size:</span>
                    <span>{formatSize(maxSize)}</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  This change takes effect immediately and does not require a reboot.
                  The page file can only be increased, never shrunk, at runtime.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-orange-600 hover:bg-orange-500 text-white"
              onClick={handleApply}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
