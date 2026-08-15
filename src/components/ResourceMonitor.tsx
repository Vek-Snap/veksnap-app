"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Cpu, MemoryStick, MonitorSpeaker, Thermometer, AlertTriangle, Trash2, RefreshCw, ShieldCheck, HardDrive, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { flushGpuMemory, flushSystemRAM, reloadNodes } from "@/lib/comfyui-api";
import { isAutoFlushEnabled, setAutoFlushEnabled } from "@/lib/auto-flush-prefs";
import {
  LTX_MEMORY_STRATEGIES,
  getLtxMemoryStrategy,
  setLtxMemoryStrategy,
  DEFAULT_LTX_MEMORY_STRATEGY,
  type LtxMemoryStrategy,
} from "@/lib/ltx-memory-strategy";
import { useToast } from "@/components/ToastProvider";

interface GpuStats {
  name: string;
  tempC: number;
  utilizationPct: number;
  memUsedMB: number;
  memTotalMB: number;
  memPct: number;
  powerW: number;
  powerLimitW: number;
  fanPct: number;
  computeCap?: string;
  cudaWarning?: string | null;
}

interface DiskStat { drive: string; totalMB: number; usedMB: number; freeMB: number; usagePct: number }

interface SystemStats {
  cpu: { model: string; cores: number; usagePct: number };
  ram: { totalMB: number; usedMB: number; usagePct: number };
  gpu: GpuStats | null;
  disks?: DiskStat[];
}

// Per-monitor visibility. Disabling GPU/Disk also tells the server to skip that
// (heavier) probe, so an unwanted monitor costs zero CPU. Persisted to localStorage.
interface MonitorToggles {
  cpu: boolean; ram: boolean; gpu: boolean; disk: boolean;
  drives: Record<string, boolean>; // per-drive visibility (default on)
}
const DEFAULT_TOGGLES: MonitorToggles = { cpu: true, ram: true, gpu: true, disk: true, drives: {} };
const MONITOR_STORE_KEY = "veksnap:hwmonitors";

const HISTORY_LENGTH = 60; // 60 data points
const POLL_INTERVAL = 2000; // 2 seconds

function MiniGraph({
  data,
  maxVal = 100,
  color,
  height = 48,
}: {
  data: number[];
  maxVal?: number;
  color: string;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const logicalW = canvas.clientWidth;
    const logicalH = canvas.clientHeight;

    // Set pixel buffer to match logical size * DPR (HiDPI)
    canvas.width = logicalW * dpr;
    canvas.height = logicalH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.clearRect(0, 0, logicalW, logicalH);

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (logicalH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(logicalW, y);
      ctx.stroke();
    }

    if (data.length < 2) return;

    const step = logicalW / (HISTORY_LENGTH - 1);

    // Fill area
    ctx.beginPath();
    ctx.moveTo(0, logicalH);
    for (let i = 0; i < data.length; i++) {
      const x = (HISTORY_LENGTH - data.length + i) * step;
      const y = logicalH - (data[i] / maxVal) * logicalH;
      ctx.lineTo(x, y);
    }
    ctx.lineTo((HISTORY_LENGTH - 1) * step, logicalH);
    ctx.closePath();
    ctx.fillStyle = color + "20";
    ctx.fill();

    // Line
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (HISTORY_LENGTH - data.length + i) * step;
      const y = logicalH - (data[i] / maxVal) * logicalH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [data, maxVal, color, height]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded border border-white/5 bg-black/30"
      style={{ height }}
    />
  );
}

function UsageBar({ pct, color, label }: { pct: number; color: string; label: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function getUsageColor(pct: number): string {
  if (pct < 50) return "#22c55e"; // green
  if (pct < 75) return "#eab308"; // yellow
  if (pct < 90) return "#f97316"; // orange
  return "#ef4444"; // red
}

function getTempColor(temp: number): string {
  if (temp < 60) return "#22c55e";
  if (temp < 75) return "#eab308";
  if (temp < 85) return "#f97316";
  return "#ef4444";
}

// ── Compact view ─────────────────────────────────────────────────────────────
// An alternative to the histogram cards: each metric is shown as just a colored
// percentage in a 2-column grid, to surface the same values while consuming far
// less vertical space. Same poll cadence as the graphs (shared `stats`).
type MonitorView = "graph" | "compact";
type CompactSize = "S" | "M" | "L";
const VIEW_STORE_KEY = "veksnap:hwmonitors:view";
const COMPACT_SIZES: Record<CompactSize, { pad: string; label: string; value: string; sub: string }> = {
  S: { pad: "px-2 py-1", label: "text-[9px]", value: "text-xs", sub: "text-[8px]" },
  M: { pad: "px-2 py-1.5", label: "text-[10px]", value: "text-sm", sub: "text-[9px]" },
  L: { pad: "px-2.5 py-2", label: "text-[11px]", value: "text-lg", sub: "text-[10px]" },
};

function CompactStat({ label, pct, sub, size, valueAlign = "left" }: { label: string; pct: number; sub?: string; size: CompactSize; valueAlign?: "left" | "right" }) {
  const color = getUsageColor(pct);
  const sz = COMPACT_SIZES[size];
  const alignCls = valueAlign === "right" ? "text-right" : "text-left";
  return (
    <div className={`rounded border border-white/5 bg-black/20 ${sz.pad} flex flex-col justify-center min-w-0`}>
      <span className={`${sz.label} text-muted-foreground truncate`}>{label}</span>
      <span className={`${sz.value} font-mono tabular-nums font-semibold leading-tight ${alignCls}`} style={{ color }}>
        {pct.toFixed(0)}%
      </span>
      {sub && <span className={`${sz.sub} text-muted-foreground/60 truncate ${alignCls}`}>{sub}</span>}
    </div>
  );
}

// Compact single-row disk tile. Drives are numerous (one per volume), so the
// stacked 3-line CompactStat wastes vertical space; this collapses drive/usage/
// free onto one baseline-aligned row, roughly halving each tile's footprint
// while showing the same data.
function CompactDiskStat({ label, pct, sub, size }: { label: string; pct: number; sub?: string; size: CompactSize }) {
  const color = getUsageColor(pct);
  const sz = COMPACT_SIZES[size];
  return (
    <div className={`rounded border border-white/5 bg-black/20 px-2 py-1 flex items-baseline gap-1.5 min-w-0`}>
      <span className={`${sz.label} text-muted-foreground shrink-0`}>{label}</span>
      <span className={`${sz.value} font-mono tabular-nums font-semibold leading-none`} style={{ color }}>
        {pct.toFixed(0)}%
      </span>
      {sub && <span className={`${sz.sub} text-muted-foreground/60 truncate ml-auto`}>{sub}</span>}
    </div>
  );
}

// GPU compact tile. Unlike the single-value CompactStat, the GPU surfaces TWO
// percentages side by side: processing (core utilization) and memory (VRAM).
// A single "GPU %" is ambiguous, so both are shown, each colored independently.
function CompactGpuStat({ procPct, memPct, powerW, powerLimitW, sub, size }: { procPct: number; memPct: number; powerW?: number; powerLimitW?: number; sub?: string; size: CompactSize }) {
  const sz = COMPACT_SIZES[size];
  // Power draw is a vital feedback signal; color it by fraction of the board limit.
  const hasPower = typeof powerW === "number" && powerW > 0;
  const powerColor = hasPower && powerLimitW ? getUsageColor((powerW! / powerLimitW) * 100) : undefined;
  return (
    // Spans both grid columns: the GPU tile carries more fields than the
    // single-value tiles, so a full-width row keeps the text from spilling.
    <div className={`col-span-2 rounded border border-white/5 bg-black/20 ${sz.pad} flex flex-col justify-center min-w-0`}>
      <span className={`${sz.label} text-muted-foreground truncate`}>GPU</span>
      {/* Equal-width columns with tabular figures so the values stay put as digit
          counts change (e.g. 3% → 16% → 100%, 44W → 444W). The outer columns are
          edge-aligned (proc LEFT, pwr RIGHT) so they line up with the CPU (left)
          and RAM (right) tiles above; mem stays centered. */}
      <div className="flex gap-1">
        <span className="flex flex-1 basis-0 flex-col items-start text-left leading-none">
          <span className={`${sz.value} font-mono tabular-nums font-semibold leading-tight`} style={{ color: getUsageColor(procPct) }}>
            {procPct.toFixed(0)}%
          </span>
          <span className={`${sz.sub} text-muted-foreground/60`}>proc</span>
        </span>
        <span className="flex flex-1 basis-0 flex-col items-center text-center leading-none">
          <span className={`${sz.value} font-mono tabular-nums font-semibold leading-tight`} style={{ color: getUsageColor(memPct) }}>
            {memPct.toFixed(0)}%
          </span>
          <span className={`${sz.sub} text-muted-foreground/60`}>mem</span>
        </span>
        {hasPower && (
          <span className="flex flex-1 basis-0 flex-col items-end text-right leading-none">
            <span className={`${sz.value} font-mono tabular-nums font-semibold leading-tight`} style={{ color: powerColor }}>
              {powerW!.toFixed(0)}W
            </span>
            <span className={`${sz.sub} text-muted-foreground/60`}>pwr</span>
          </span>
        )}
      </div>
      {sub && <span className={`${sz.sub} text-muted-foreground/60 truncate`}>{sub}</span>}
    </div>
  );
}

// Optional per-panel visibility. Omitted (classic UI) => every panel is shown.
// The Modern dock passes this from the panel-settings store.
interface ResourceMonitorProps {
  show?: { monitors?: boolean; memoryReserve?: boolean; flushActions?: boolean };
}

export default function ResourceMonitor({ show }: ResourceMonitorProps = {}) {
  const showMonitors = show?.monitors !== false;
  const showReserve = show?.memoryReserve !== false;
  const showFlush = show?.flushActions !== false;
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [gpuHistory, setGpuHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);
  const [vramHistory, setVramHistory] = useState<number[]>([]);
  const [error, setError] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [flushingRAM, setFlushingRAM] = useState(false);
  // Mirrors the persisted master AutoFlush pref. Read in an effect rather than at init because
  // localStorage is unavailable during server rendering.
  const [autoFlush, setAutoFlushState] = useState(false);
  // LTX chained-handoff policy (A/B/C). Same server-rendering caveat as autoFlush above.
  const [ltxStrategy, setLtxStrategyState] = useState<LtxMemoryStrategy>(DEFAULT_LTX_MEMORY_STRATEGY);
  const [reloading, setReloading] = useState(false);
  const [reloadResult, setReloadResult] = useState<string | null>(null);
  const [ramReserveMB, setRamReserveMB] = useState(4096);
  const [reserveLoaded, setReserveLoaded] = useState(false);
  const [reserveChanged, setReserveChanged] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  const [disks, setDisks] = useState<DiskStat[]>([]);
  const [toggles, setToggles] = useState<MonitorToggles>(DEFAULT_TOGGLES);
  // View mode (histogram default vs compact colored-%) + compact tile size. Persisted.
  const [view, setView] = useState<MonitorView>("graph");
  const [compactSize, setCompactSize] = useState<CompactSize>("M");
  useEffect(() => {
    try { const s = localStorage.getItem(MONITOR_STORE_KEY); if (s) setToggles((t) => ({ ...t, ...JSON.parse(s) })); } catch { /* ignore */ }
    try {
      const v = localStorage.getItem(VIEW_STORE_KEY);
      if (v) {
        const parsed = JSON.parse(v) as { view?: MonitorView; size?: CompactSize };
        if (parsed.view === "graph" || parsed.view === "compact") setView(parsed.view);
        if (parsed.size === "S" || parsed.size === "M" || parsed.size === "L") setCompactSize(parsed.size);
      }
    } catch { /* ignore */ }
  }, []);
  const persistView = useCallback((nextView: MonitorView, nextSize: CompactSize) => {
    setView(nextView);
    setCompactSize(nextSize);
    try { localStorage.setItem(VIEW_STORE_KEY, JSON.stringify({ view: nextView, size: nextSize })); } catch { /* ignore */ }
  }, []);
  const updateToggles = useCallback((fn: (t: MonitorToggles) => MonitorToggles) => {
    setToggles((prev) => {
      const next = fn(prev);
      try { localStorage.setItem(MONITOR_STORE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const driveOn = useCallback((d: string) => toggles.drives[d] !== false, [toggles.drives]);

  const fetchStats = useCallback(async () => {
    try {
      // Only request the (heavier) GPU/Disk probes when those monitors are enabled.
      const url = `/api/system-stats?gpu=${toggles.gpu ? 1 : 0}&disks=${toggles.disk ? 1 : 0}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error();
      const data: SystemStats = await res.json();
      setStats(data);
      setDisks(data.disks ?? []);
      setError(false);

      setCpuHistory((prev) => [...prev.slice(-(HISTORY_LENGTH - 1)), data.cpu.usagePct]);
      setRamHistory((prev) => [...prev.slice(-(HISTORY_LENGTH - 1)), data.ram.usagePct]);
      if (data.gpu) {
        setGpuHistory((prev) => [...prev.slice(-(HISTORY_LENGTH - 1)), data.gpu!.utilizationPct]);
        setVramHistory((prev) => [...prev.slice(-(HISTORY_LENGTH - 1)), data.gpu!.memPct]);
      }
    } catch {
      setError(true);
    }
  }, [toggles.gpu, toggles.disk]);

  // Hydrate the persisted master AutoFlush pref + LTX strategy once mounted (localStorage is client-only).
  useEffect(() => {
    setAutoFlushState(isAutoFlushEnabled());
    setLtxStrategyState(getLtxMemoryStrategy());
  }, []);

  // Both handlers now report what actually happened. Previously these called ComfyUI's /free and
  // reported nothing, so when VRAM was held by one of our own model subprocesses the button
  // appeared to do nothing with no explanation. Silence was the real bug.
  const reportFlush = useCallback(
    (result: { message: string; reaped: string[]; stillRunning: string[] }) => {
      if (result.stillRunning.length > 0) {
        toast(
          `Freed what was idle. Still held by running work: ${result.stillRunning.join(", ")}. Stop the job to release it.`,
          "info"
        );
      } else if (result.reaped.length > 0) {
        toast(`Reclaimed: ${result.reaped.join(", ")}`, "success");
      } else {
        toast("Memory freed", "success");
      }
    },
    [toast]
  );

  const handleFlush = useCallback(async () => {
    setFlushing(true);
    try {
      reportFlush(await flushGpuMemory());
      await new Promise((r) => setTimeout(r, 1500));
      await fetchStats();
    } catch {
      toast("Flush failed", "error");
    } finally {
      setFlushing(false);
    }
  }, [fetchStats, reportFlush, toast]);

  const handleFlushRAM = useCallback(async () => {
    setFlushingRAM(true);
    try {
      reportFlush(await flushSystemRAM());
      await new Promise((r) => setTimeout(r, 2000));
      await fetchStats();
    } catch {
      toast("Flush failed", "error");
    } finally {
      setFlushingRAM(false);
    }
  }, [fetchStats, reportFlush, toast]);

  const handleReloadNodes = useCallback(async () => {
    setReloading(true);
    setReloadResult(null);
    try {
      const result = await reloadNodes();
      if (result.new_nodes.length > 0) {
        setReloadResult(`+${result.new_nodes.length} nodes (${result.elapsed_seconds}s)`);
      } else {
        setReloadResult(`No new nodes (${result.total_nodes} total)`);
      }
      setTimeout(() => setReloadResult(null), 5000);
    } catch (e) {
      setReloadResult("Reload failed");
      setTimeout(() => setReloadResult(null), 5000);
    } finally {
      setReloading(false);
    }
  }, []);

  // Load RAM reserve setting on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        if (typeof s.ramReserveMB === "number") setRamReserveMB(s.ramReserveMB);
        setReserveLoaded(true);
      })
      .catch(() => setReserveLoaded(true));
  }, []);

  // Save RAM reserve (debounced)
  const saveRamReserve = useCallback((value: number) => {
    setRamReserveMB(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "ramReserveMB", value }),
      }).then(() => {
        setReserveChanged(true);
        toast("RAM reserve updated: restart Vek-Snap to apply", "info");
      }).catch(() => {});
    }, 500);
  }, [toast]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchStats]);

  if (!stats) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground text-center">
          Loading system stats...
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Per-monitor visibility toggles: disabling GPU/Disk also skips their server-side probe. */}
      {showMonitors && (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground/50 mr-0.5">Monitors</span>
        {([["cpu", "CPU"], ["ram", "RAM"], ["gpu", "GPU"], ["disk", "Disk"]] as const).map(([k, lbl]) => (
          <button
            key={k}
            type="button"
            onClick={() => updateToggles((t) => ({ ...t, [k]: !t[k] }))}
            className={`px-2 py-0.5 rounded text-[9px] font-medium border transition-colors ${toggles[k] ? "border-violet-500/40 bg-violet-500/15 text-violet-200" : "border-border/50 text-muted-foreground/40 hover:text-muted-foreground"}`}
          >
            {lbl}
          </button>
        ))}
        <span className="mx-0.5 w-px h-3.5 bg-border/60" aria-hidden />
        {/* View mode: histogram (default) vs compact colored-% */}
        {(["graph", "compact"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => persistView(v, compactSize)}
            className={`px-2 py-0.5 rounded text-[9px] font-medium border transition-colors ${view === v ? "border-violet-500/40 bg-violet-500/15 text-violet-200" : "border-border/50 text-muted-foreground/40 hover:text-muted-foreground"}`}
            title={v === "graph" ? "Histogram view" : "Compact percentage view (less vertical space)"}
          >
            {v === "graph" ? "Graph" : "Compact"}
          </button>
        ))}
        {/* Compact tile size */}
        {view === "compact" && (["S", "M", "L"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => persistView("compact", s)}
            className={`w-6 py-0.5 rounded text-[9px] font-medium border transition-colors ${compactSize === s ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-200" : "border-border/50 text-muted-foreground/40 hover:text-muted-foreground"}`}
            title={`Compact tile size: ${s}`}
          >
            {s}
          </button>
        ))}
      </div>
      )}

      {/* Compact colored-% grid: replaces the histogram cards; same poll cadence. */}
      {showMonitors && view === "compact" && (
        <div className="grid grid-cols-2 gap-1.5">
          {toggles.cpu && (
            <CompactStat label="CPU" pct={stats.cpu.usagePct} sub={`${stats.cpu.cores} cores`} size={compactSize} />
          )}
          {toggles.ram && (
            <CompactStat label="RAM" pct={stats.ram.usagePct} sub={`${(stats.ram.usedMB / 1024).toFixed(1)}/${(stats.ram.totalMB / 1024).toFixed(0)} GB`} size={compactSize} valueAlign="right" />
          )}
          {toggles.gpu && stats.gpu && (
            <CompactGpuStat
              procPct={stats.gpu.utilizationPct}
              memPct={stats.gpu.memPct}
              powerW={stats.gpu.powerW}
              powerLimitW={stats.gpu.powerLimitW}
              sub={`${(stats.gpu.memUsedMB / 1024).toFixed(1)}/${(stats.gpu.memTotalMB / 1024).toFixed(0)} GB · ${stats.gpu.tempC}°C`}
              size={compactSize}
            />
          )}
          {toggles.disk && disks.filter((d) => driveOn(d.drive)).map((d) => (
            <CompactDiskStat key={d.drive} label={d.drive} pct={d.usagePct} sub={`${(d.freeMB / 1024).toFixed(0)} GB free`} size={compactSize} />
          ))}
        </div>
      )}

      {/* CPU */}
      {showMonitors && view === "graph" && toggles.cpu && (
      <Card className="overflow-hidden">
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] font-medium flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-blue-400" />
              CPU
            </span>
            <Badge variant="secondary" className="text-[9px] font-mono">
              {stats.cpu.usagePct.toFixed(0)}%
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 space-y-2">
          <MiniGraph data={cpuHistory} color="#3b82f6" height={40} />
          <UsageBar
            pct={stats.cpu.usagePct}
            color={getUsageColor(stats.cpu.usagePct)}
            label={`${stats.cpu.cores} cores`}
          />
        </CardContent>
      </Card>
      )}

      {/* RAM */}
      {showMonitors && view === "graph" && toggles.ram && (
      <Card className="overflow-hidden">
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] font-medium flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <MemoryStick className="w-3.5 h-3.5 text-purple-400" />
              RAM
            </span>
            <Badge variant="secondary" className="text-[9px] font-mono">
              {(stats.ram.usedMB / 1024).toFixed(1)} / {(stats.ram.totalMB / 1024).toFixed(0)} GB
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 space-y-2">
          <MiniGraph data={ramHistory} color="#a855f7" height={40} />
          <UsageBar
            pct={stats.ram.usagePct}
            color={getUsageColor(stats.ram.usagePct)}
            label="System Memory"
          />
        </CardContent>
      </Card>
      )}

      {/* GPU */}
      {showMonitors && view === "graph" && toggles.gpu && stats.gpu && (
        <Card className="overflow-hidden">
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="text-[11px] font-medium flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <MonitorSpeaker className="w-3.5 h-3.5 text-green-400" />
                GPU
              </span>
              <Badge variant="secondary" className="text-[9px] font-mono">
                {stats.gpu.utilizationPct.toFixed(0)}%
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 space-y-2">
            <MiniGraph data={gpuHistory} color="#22c55e" height={40} />
            <UsageBar
              pct={stats.gpu.utilizationPct}
              color={getUsageColor(stats.gpu.utilizationPct)}
              label={stats.gpu.name}
            />
            {/* VRAM */}
            <UsageBar
              pct={stats.gpu.memPct}
              color={getUsageColor(stats.gpu.memPct)}
              label={`VRAM ${(stats.gpu.memUsedMB / 1024).toFixed(1)} / ${(stats.gpu.memTotalMB / 1024).toFixed(0)} GB`}
            />
            <MiniGraph data={vramHistory} color="#06b6d4" height={32} />
            {/* Temperature & Power */}
            <div className="flex gap-3 text-[10px]">
              <span className="flex items-center gap-1" style={{ color: getTempColor(stats.gpu.tempC) }}>
                <Thermometer className="w-3 h-3" />
                {stats.gpu.tempC}°C
              </span>
              <span className="text-muted-foreground">
                {stats.gpu.powerW.toFixed(0)}W / {stats.gpu.powerLimitW.toFixed(0)}W
              </span>
              <span className="text-muted-foreground">
                Fan {stats.gpu.fanPct.toFixed(0)}%
              </span>
            </div>
            {/* CUDA compatibility warning for Blackwell+ GPUs */}
            {stats.gpu.cudaWarning && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-[9px] text-amber-400/90 leading-tight">
                  {stats.gpu.cudaWarning}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Disk */}
      {showMonitors && view === "graph" && toggles.disk && (
        <Card className="overflow-hidden">
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="text-[11px] font-medium flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-cyan-400" />
              Disk
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 space-y-2">
            {disks.length === 0 ? (
              <p className="text-[10px] text-muted-foreground/60">No fixed drives detected.</p>
            ) : (
              disks.map((d) => {
                const on = driveOn(d.drive);
                return (
                  <div key={d.drive} className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                      <button
                        type="button"
                        onClick={() => updateToggles((t) => ({ ...t, drives: { ...t.drives, [d.drive]: !on } }))}
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        title={on ? `Hide ${d.drive}` : `Show ${d.drive}`}
                      >
                        {on ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3 opacity-50" />}
                        <span className="font-mono">{d.drive}</span>
                      </button>
                      {on && (
                        <span className="font-mono text-muted-foreground/70">
                          {(d.freeMB / 1024).toFixed(0)} GB free / {(d.totalMB / 1024).toFixed(0)} GB
                        </span>
                      )}
                    </div>
                    {on && (
                      <UsageBar pct={d.usagePct} color={getUsageColor(d.usagePct)} label={`${(d.usedMB / 1024).toFixed(0)} GB used`} />
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      )}

      {/* RAM Reserve for System */}
      {showReserve && (
      <Card className="overflow-hidden">
        <CardHeader className="pb-1 pt-3 px-3">
          <CardTitle className="text-[11px] font-medium flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
              System Memory Reserve
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 space-y-2">
          <p className="text-[9px] text-muted-foreground/70 leading-tight">
            Hard OS-level memory limit for AI processes. This RAM is physically unavailable to ComfyUI,
            keeping your system responsive during generation.
          </p>
          {/* Effective limits display */}
          {stats && (
            <div className="grid grid-cols-2 gap-1.5 text-[9px]">
              <div className="rounded bg-muted/30 px-2 py-1">
                <span className="text-muted-foreground/60">Reserved</span>
                <span className="float-right font-mono text-amber-400">{(ramReserveMB / 1024).toFixed(1)} GB</span>
              </div>
              <div className="rounded bg-muted/30 px-2 py-1">
                <span className="text-muted-foreground/60">ComfyUI limit</span>
                <span className="float-right font-mono text-emerald-400">{((stats.ram.totalMB - ramReserveMB) / 1024).toFixed(1)} GB</span>
              </div>
            </div>
          )}
          {reserveChanged && (
            <div className="rounded border border-sky-500/30 bg-sky-500/10 p-1.5 flex items-start gap-1.5">
              <RefreshCw className="w-3 h-3 text-sky-400 shrink-0 mt-0.5" />
              <p className="text-[9px] text-sky-400/90 leading-tight">
                Restart Vek-Snap for the new memory limit to take effect.
              </p>
            </div>
          )}
          {/* Numeric input + slider */}
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={ramReserveMB}
              onChange={(e) => {
                const v = Math.max(1024, Math.min(stats ? Math.round(stats.ram.totalMB * 0.75) : 32768, Math.round(Number(e.target.value))));
                if (!isNaN(v)) saveRamReserve(v);
              }}
              min={1024}
              max={stats ? Math.round(stats.ram.totalMB * 0.75) : 32768}
              step={256}
              className="w-[72px] h-6 text-[10px] font-mono text-center rounded border border-border bg-background px-1 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
            />
            <span className="text-[9px] text-muted-foreground/60 shrink-0">MB</span>
            {reserveLoaded && (
              <Slider
                value={[ramReserveMB]}
                onValueChange={([v]) => saveRamReserve(v)}
                min={1024}
                max={stats ? Math.round(stats.ram.totalMB * 0.75) : 32768}
                step={256}
                className="flex-1"
              />
            )}
          </div>
          <div className="flex justify-between text-[8px] text-muted-foreground/50">
            <span>1024 MB (min)</span>
            <span>{stats ? `${Math.round(stats.ram.totalMB * 0.75)} MB (75% of total)` : "24576 MB"}</span>
          </div>
          {stats && stats.ram.totalMB - stats.ram.usedMB < ramReserveMB && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 p-1.5 flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-[9px] text-amber-400/90 leading-tight">
                Current free RAM ({Math.round((stats.ram.totalMB - stats.ram.usedMB) / 1024 * 10) / 10} GB) is below the reserve. Heavy tasks will be blocked.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Action buttons */}
      {showFlush && (
      <>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-[10px] h-7 border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
          onClick={handleFlush}
          disabled={flushing || flushingRAM}
        >
          <Trash2 className="w-3 h-3 mr-1" />
          {flushing ? "Flushing..." : "Flush VRAM"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1 text-[10px] h-7 border-purple-500/30 text-purple-400 hover:bg-purple-500/10 hover:text-purple-300"
          onClick={handleFlushRAM}
          disabled={flushing || flushingRAM}
        >
          <MemoryStick className="w-3 h-3 mr-1" />
          {flushingRAM ? "Flushing..." : "Flush RAM"}
        </Button>
      </div>

      {/* Master AutoFlush: SINGLE-MODEL workflows only. Multi-model pipelines are handled
          programmatically by lib/vram-guard.ts and are deliberately NOT user-toggleable, because
          "will the next model fit" is a measurable capacity question, not a preference. */}
      <div className="rounded-lg border border-border/60 bg-foreground/5 p-2 space-y-1.5">
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-[10px] font-medium text-foreground/80">
            AutoFlush
            <span className="ml-1 text-[8px] font-normal text-muted-foreground">
              (single-model pipelines only)
            </span>
          </span>
          <input
            type="checkbox"
            checked={autoFlush}
            onChange={(e) => {
              setAutoFlushEnabled(e.target.checked);
              setAutoFlushState(e.target.checked);
            }}
            className="accent-amber-500 w-3.5 h-3.5 flex-shrink-0"
          />
        </label>
        <p className="text-[8px] text-muted-foreground/70 leading-tight">
          {autoFlush
            ? "ON: single-model workflows release their model when finished."
            : "OFF: nothing is freed automatically; models stay warm until you press a Flush button."}
        </p>
        {/* LTX chained-handoff policy. Deliberately NOT a simple on/off: under DynamicVRAM the
            LTX model streams from RAM instead of OOMing, so "free VRAM is low" is not evidence of
            a problem and there is no single correct policy. See lib/ltx-memory-strategy.ts. */}
        <div className="border-t border-border/40 pt-1.5 space-y-1">
          <label className="block text-[10px] font-medium text-foreground/80">
            LTX chain memory
            <span className="ml-1 text-[8px] font-normal text-muted-foreground">
              (multi-model handoffs)
            </span>
          </label>
          <select
            value={ltxStrategy}
            onChange={(e) => {
              const next = e.target.value as LtxMemoryStrategy;
              setLtxMemoryStrategy(next);
              setLtxStrategyState(next);
            }}
            className="w-full text-[9px] rounded border border-border/60 bg-background px-1.5 py-1 text-foreground/90"
          >
            {LTX_MEMORY_STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <p className="text-[8px] text-muted-foreground/70 leading-tight">
            {LTX_MEMORY_STRATEGIES.find((s) => s.value === ltxStrategy)?.summary}
          </p>
          <p className="text-[8px] text-muted-foreground/60 leading-tight">
            {LTX_MEMORY_STRATEGIES.find((s) => s.value === ltxStrategy)?.tradeoff}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-full text-[10px] h-7 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300"
        onClick={handleReloadNodes}
        disabled={reloading}
      >
        <RefreshCw className={`w-3 h-3 mr-1 ${reloading ? "animate-spin" : ""}`} />
        {reloading ? "Refreshing..." : "Refresh Node List"}
      </Button>
      {reloadResult && (
        <p className="text-[10px] text-cyan-400 text-center">{reloadResult}</p>
      )}
      </>
      )}

      {error && (
        <p className="text-[10px] text-destructive text-center">Stats unavailable</p>
      )}
    </div>
  );
}
