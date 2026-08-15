"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal, Download, RefreshCw, Trash2, GripHorizontal, Bug } from "lucide-react";

interface LogEntry {
  name: string;
  file: string;
}

// ── Log severity classification ──
type LogLevel = "error" | "warning" | "info" | "success" | "debug" | "trace" | "default";

const LEVEL_CLASSES: Record<LogLevel, string> = {
  error:   "text-red-400",
  warning: "text-amber-400",
  info:    "text-sky-400",
  success: "text-emerald-400",
  debug:   "text-muted-foreground",
  trace:   "text-muted-foreground/50",
  default: "text-green-400/80",
};

// Strip ANSI escape codes for clean matching
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ── Harmless startup "noise" ──
// Lines that carry scary keywords (Error / Traceback / WARNING / FAILED / "No
// module named") but are completely normal on a healthy install. On a fresh
// install a customer should see NO red/amber unless something is genuinely wrong,
// so these are HIDDEN unless the diagnostic (bug) toggle is on, and even when
// revealed they render as dim INFO, never red/amber. Patterns are kept specific
// so real failures are never masked.
const NOISE_PATTERNS: RegExp[] = [
  // ComfyUI custom-node scanner probing the non-node ".githooks" dir (skipped).
  /\.githooks\b/i,
  // Harmless import-order / capability-probe notes.
  /Torch already imported/i,
  /Found comfy[_-]?kitchen backend/i,
  /No module named ['"]?triton/i,
  /No OpenGL_accelerate module loaded/i,
  /No module named ['"]?OpenGL_accelerate/i,
  // Bundled build ships cu128 torch; "use cu130 for optimized ops" is constant
  // and non-actionable for customers (kernels still run, just un-fused).
  /pytorch with cu\d+ or higher to use optimized/i,
  // RAM limiter: Layer-1 Job Object needs a privilege many systems lack; Layer-2
  // (process working-set + watchdog) always succeeds, so this is an expected fallback.
  /SetInformationJobObject .*failed/i,
  /Job Object working set limit FAILED/i,
  /Layer 1: Job Object working set limit/i,
  // ComfyUI informational notices.
  /User settings have been changed to be stored on the server/i,
  /For multi-user setups add the --multi-user/i,
  // Third-party deprecation chatter (timm, etc.).
  /\bFutureWarning\b/i,
  /\bDeprecationWarning\b/i,
  /is deprecated, please import/i,
];

function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

function classifyLine(raw: string): LogLevel {
  const line = raw.replace(ANSI_RE, "");
  const lower = line.toLowerCase();

  // ── Errors (red) ──
  if (
    /\[ERR]/.test(line) ||
    /\berror\b/i.test(line) ||
    /\bTraceback\b/.test(line) ||
    /\bException\b/.test(line) ||
    /\bFATAL\b/i.test(line) ||
    /\bCRITICAL\b/i.test(line) ||
    /\bfailed\b/i.test(line) && !/\bif\b.*failed/i.test(line) ||
    /\bOOM\b/.test(line) ||
    /\bNo module named\b/.test(line) ||
    /\bModuleNotFoundError\b/.test(line) ||
    /\bRuntimeError\b/.test(line) ||
    /\bValueError\b/.test(line) ||
    /\bTypeError\b/.test(line) ||
    /\bKeyError\b/.test(line) ||
    /\bAttributeError\b/.test(line) ||
    /\bFileNotFoundError\b/.test(line) ||
    /\bPermissionError\b/.test(line) ||
    /\bexited with code [^0]/.test(line) ||
    / 5\d\d /.test(line) // HTTP 5xx
  ) return "error";

  // ── Warnings (amber) ──
  if (
    /\[WARN]/.test(line) ||
    /\bWarning\b/i.test(line) ||
    /\bWARN\b/.test(line) ||
    /\bDeprecated\b/i.test(line) ||
    /\bDeprecation\b/i.test(line) ||
    /\bUserWarning\b/.test(line) ||
    /\bFutureWarning\b/.test(line) ||
    /\bnot (found|available|supported)\b/i.test(line) ||
    /\bfallback\b/i.test(line) ||
    /\bNOTE:\b/.test(line) ||
    / 4\d\d /.test(line) // HTTP 4xx
  ) return "warning";

  // ── Success (emerald) ──
  if (
    /\bLoaded\b/.test(line) ||
    /\bStarting server\b/i.test(line) ||
    /\bstarted\b/i.test(line) && /PID/i.test(line) ||
    /To see the GUI go to:/i.test(line) ||
    /\bReady\b/i.test(line) && /\bon\b/i.test(line) ||
    /\bcomplete[d]?\b/i.test(line) ||
    /\bsuccessfully\b/i.test(line) ||
    /\bDone\b/i.test(line) && line.length < 80
  ) return "success";

  // ── Info (sky/cyan) ──
  if (
    /\[INFO]/.test(line) ||
    /\bINFO\b/.test(line) ||
    /\bImport times\b/i.test(line) ||
    /\bUsing\b/.test(line) ||
    /\bLoading\b/i.test(line) ||
    /\bInit\b/.test(line) ||
    /seconds?:/.test(line) ||
    /\bVersion\b/i.test(line) || /\bv\d+\.\d+/i.test(line)
  ) return "info";

  // ── Trace / noise (dim), HTTP request log lines, compile stats ──
  if (
    /^\s*GET\s+\//.test(line) ||
    /^\[?\d{2}:\d{2}:\d{2}/.test(line) && /GET|POST|PUT|DELETE/.test(line) ||
    /\bcompile:/.test(lower) ||
    /\brender:/.test(lower)
  ) return "trace";

  return "default";
}

// Per-line severity + a "noise" flag. Multi-line Python tracebacks are handled as
// a unit: only the final "…Error: …" line names the cause, so when that cause is
// noise (e.g. the ".githooks" probe) the whole block is marked noise/INFO, a
// harmless probe never renders as an alarming red multi-line traceback.
type LineMeta = { level: LogLevel; noise: boolean };

function analyzeLines(lines: string[]): LineMeta[] {
  const meta: LineMeta[] = lines.map((raw) => {
    const clean = raw.replace(ANSI_RE, "");
    return isNoise(clean)
      ? { level: "info" as LogLevel, noise: true }
      : { level: classifyLine(raw), noise: false };
  });
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(ANSI_RE, "");
    if (!/Traceback \(most recent call last\):/.test(clean)) continue;
    let end = i;
    let noise = false;
    for (let j = i + 1; j < lines.length; j++) {
      const c = lines[j].replace(ANSI_RE, "").trim();
      if (isNoise(c)) noise = true;
      end = j;
      // A blank line, or a non-indented "…Error/…Exception: …" line, ends the block.
      if (c === "" || /^[A-Za-z_.]*(Error|Exception)\b/.test(c)) break;
    }
    if (noise) for (let k = i; k <= end; k++) meta[k] = { level: "info", noise: true };
  }
  return meta;
}

const MIN_HEIGHT = 150;
const DEFAULT_HEIGHT = 300;
const MAX_HEIGHT = 800;

export default function SystemLogs() {
  const [services, setServices] = useState<LogEntry[]>([]);
  const [activeService, setActiveService] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [totalLines, setTotalLines] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [verboseLogs, setVerboseLogs] = useState(false);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);
  const scrollRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isAtBottomRef = useRef(true);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Per-line severity + noise flag (traceback-block aware, see analyzeLines).
  const meta = useMemo(() => analyzeLines(lines), [lines]);
  // Rows actually rendered: harmless "noise" is hidden unless the diagnostic (bug)
  // toggle is on, so a healthy fresh install shows no red/amber lines at all.
  const visibleRows = useMemo(
    () =>
      lines
        .map((line, i) => ({ line, level: meta[i]?.level ?? "default", noise: meta[i]?.noise ?? false }))
        .filter((r) => verboseLogs || !r.noise),
    [lines, meta, verboseLogs],
  );
  const hiddenCount = useMemo(() => meta.reduce((n, m) => n + (m.noise ? 1 : 0), 0), [meta]);

  // Top-edge drag to resize
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: panelHeight };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      // Dragging up = negative delta = increase height
      const delta = dragRef.current.startY - ev.clientY;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startH + delta));
      setPanelHeight(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelHeight]);

  // Load verboseLogs setting from server on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => { if (typeof s.verboseLogs === "boolean") setVerboseLogs(s.verboseLogs); })
      .catch(() => {});
  }, []);

  const toggleVerboseLogs = async () => {
    const next = !verboseLogs;
    setVerboseLogs(next);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "verboseLogs", value: next }),
      });
    } catch { /* best-effort */ }
  };

  // Load list of available log files
  const loadServiceList = useCallback(async () => {
    try {
      const res = await fetch("/api/system-logs?list=true");
      const data = await res.json();
      setServices(data.logs || []);
      if (data.logs?.length > 0 && !activeService) {
        setActiveService(data.logs[0].file.replace(".log", ""));
      }
    } catch {
      // Launcher may not be running, that's OK
    }
  }, [activeService]);

  // Load logs for the active service
  const loadLogs = useCallback(async () => {
    if (!activeService) return;
    try {
      const res = await fetch(`/api/system-logs?service=${activeService}&tail=500`);
      const data = await res.json();
      setLines(data.lines || []);
      setTotalLines(data.totalLines || 0);
    } catch {
      setLines(["Failed to load logs: is the launcher running?"]);
    }
  }, [activeService]);

  useEffect(() => {
    loadServiceList();
  }, [loadServiceList]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // Auto-refresh every 4 seconds: re-poll both log content and service list
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        loadServiceList();
        if (activeService) loadLogs();
      }, 4000);
      return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }
  }, [autoRefresh, activeService, loadLogs, loadServiceList]);

  // Track whether user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // "Near bottom" = within 40px of the end
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  // Auto-scroll to bottom only when user is already at the bottom
  useEffect(() => {
    if (scrollRef.current && isAtBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleExportAll = async () => {
    try {
      const res = await fetch("/api/system-logs", { method: "POST" });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `veksnap_logs_${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Failed to export logs");
    }
  };

  const handleExportService = async () => {
    if (!activeService) return;
    window.open(`/api/system-logs?service=${activeService}&export=true`, "_blank");
  };

  const handleClearLogs = async () => {
    if (!activeService) return;
    try {
      await fetch(`/api/system-logs?service=${activeService}`, { method: "DELETE" });
      setLines([]);
      setTotalLines(0);
    } catch {
      alert("Failed to clear logs");
    }
  };

  return (
    <div style={{ height: panelHeight }} className="flex flex-col overflow-hidden">
      {/* Top-edge drag handle */}
      <div
        onMouseDown={onDragStart}
        className="flex items-center justify-center h-3 cursor-ns-resize shrink-0 group hover:bg-muted/50 rounded-t transition-colors"
        title="Drag to resize"
      >
        <GripHorizontal className="w-5 h-3 text-muted-foreground/40 group-hover:text-muted-foreground" />
      </div>
      <Card className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Terminal className="w-4 h-4" /> System Logs
          <div className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={`h-6 px-2 text-[10px] ${verboseLogs ? "text-amber-400" : "text-muted-foreground"}`}
              onClick={toggleVerboseLogs}
              title={verboseLogs ? "Diagnostic mode ON: showing all output, including harmless startup notices" : "Diagnostic mode OFF: harmless startup notices hidden (only real problems shown). Click for full diagnostics."}
            >
              <Bug className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`h-6 px-2 text-[10px] ${autoRefresh ? "text-green-400" : "text-muted-foreground"}`}
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={autoRefresh ? "Auto-refresh ON" : "Auto-refresh OFF"}
            >
              <RefreshCw className={`w-3 h-3 ${autoRefresh ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={handleExportService}
              title="Export this service log"
            >
              <Download className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-red-400/70 hover:text-red-400"
              onClick={handleClearLogs}
              title="Clear this service log"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={handleExportAll}
              title="Export all logs"
            >
              <Download className="w-3 h-3 mr-1" /> All
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-2 overflow-hidden p-3 pt-0">
        {/* Service tabs */}
        <div className="flex gap-1 flex-wrap">
          {services.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              No logs available: start services via the launcher
            </p>
          )}
          {services.map((svc) => {
            const key = svc.file.replace(".log", "");
            return (
              <Button
                key={key}
                variant={activeService === key ? "default" : "outline"}
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setActiveService(key)}
              >
                {svc.name}
              </Button>
            );
          })}
        </div>

        {/* Log viewer: vertically resizable */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-auto rounded border border-border bg-black/50 p-2 font-mono text-[10px] leading-4 min-h-0"
        >
          {lines.length === 0 ? (
            <p className="text-muted-foreground">No log output yet...</p>
          ) : (
            visibleRows.map((r, i) => {
              // Strip ANSI escapes for display
              const clean = r.line.replace(ANSI_RE, "");
              return (
                <div
                  key={i}
                  className={`whitespace-pre-wrap break-all ${LEVEL_CLASSES[r.level]}`}
                >
                  {clean}
                </div>
              );
            })
          )}
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>{totalLines > 0 ? `${totalLines} total lines` : ""}</span>
          <span className="flex items-center gap-2">
            {!verboseLogs && hiddenCount > 0 && (
              <button
                type="button"
                onClick={toggleVerboseLogs}
                className="text-muted-foreground/70 hover:text-foreground transition-colors"
                title="Show hidden harmless startup notices"
              >
                {hiddenCount} harmless {hiddenCount === 1 ? "notice" : "notices"} hidden
              </button>
            )}
            {verboseLogs && <span className="text-amber-400/70">Diagnostic</span>}
            <span>{autoRefresh ? "Live" : "Paused"}</span>
          </span>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}
