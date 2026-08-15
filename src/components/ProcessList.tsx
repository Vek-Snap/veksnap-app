"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Cpu,
  Loader2,
  Skull,
} from "lucide-react";

interface ProcessInfo {
  pid: number;
  name: string;
  memoryMB: number;
  commandLine: string;
  category: "python" | "node" | "ffmpeg" | "other";
}

const CATEGORY_COLORS: Record<string, string> = {
  python: "text-yellow-400 border-yellow-500/30",
  node: "text-green-400 border-green-500/30",
  ffmpeg: "text-blue-400 border-blue-500/30",
  other: "text-muted-foreground border-border/30",
};

const CATEGORY_LABELS: Record<string, string> = {
  python: "Python",
  node: "Node.js",
  ffmpeg: "FFmpeg",
  other: "Other",
};

const POLL_INTERVAL = 8000;

export default function ProcessList() {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const killOrphans = useCallback(async () => {
    setCleaning(true);
    setCleanupResult(null);
    try {
      const res = await fetch("/api/cleanup-processes", { method: "POST" });
      const data = await res.json();
      setCleanupResult(data.message || "Done");
      // Refresh process list after cleanup
      setTimeout(() => fetchProcesses(true), 1000);
      // Clear message after 5s
      setTimeout(() => setCleanupResult(null), 5000);
    } catch (e) {
      setCleanupResult(`Error: ${(e as Error).message}`);
    }
    setCleaning(false);
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const fetchProcesses = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch("/api/processes");
      if (res.ok) {
        const data = await res.json();
        setProcesses(data.processes || []);
        setLastFetch(new Date());
      }
    } catch {
      // Silently ignore: panel is informational
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll only when expanded
  useEffect(() => {
    if (collapsed) {
      if (pollRef.current) clearTimeout(pollRef.current);
      return;
    }

    fetchProcesses(true);

    const tick = () => {
      fetchProcesses();
      pollRef.current = setTimeout(tick, POLL_INTERVAL);
    };
    pollRef.current = setTimeout(tick, POLL_INTERVAL);

    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [collapsed, fetchProcesses]);

  const totalMemory = processes.reduce((sum, p) => sum + p.memoryMB, 0);

  return (
    <div className="border border-border/30 rounded-lg bg-card/50 text-sm">
      {/* Header: always visible */}
      <button
        className="flex items-center justify-between w-full px-4 py-2 hover:bg-muted/20 transition-colors rounded-lg"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium">Vek-Snap Processes</span>
          {!collapsed && processes.length > 0 && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 font-mono"
            >
              {processes.length} active · {totalMemory >= 1024
                ? `${(totalMemory / 1024).toFixed(1)} GB`
                : `${totalMemory} MB`}
            </Badge>
          )}
          {collapsed && lastFetch && processes.length > 0 && (
            <span className="text-[10px] text-muted-foreground/50">
              {processes.length} process{processes.length !== 1 ? "es" : ""}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {!collapsed && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-red-400/60 hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  killOrphans();
                }}
                disabled={cleaning}
                title="Kill orphaned Vek-Snap processes (Python/Node.js left over from crashes)"
              >
                {cleaning ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Skull className="w-3 h-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  fetchProcesses(true);
                }}
                disabled={loading}
                title="Refresh"
              >
                {loading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
              </Button>
            </>
          )}
          {collapsed ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Process table */}
      {!collapsed && (
        <div className="px-4 pb-3 space-y-1">
          {loading && processes.length === 0 ? (
            <div className="flex items-center justify-center py-3 text-[10px] text-muted-foreground/50">
              <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> Scanning processes...
            </div>
          ) : processes.length === 0 ? (
            <div className="text-center py-3 text-[10px] text-muted-foreground/50">
              No related processes found
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* Column headers */}
              <div className="grid grid-cols-[60px_80px_70px_1fr] gap-2 px-2 py-1 text-[9px] text-muted-foreground/40 font-medium uppercase tracking-wider">
                <span>PID</span>
                <span>Type</span>
                <span>Memory</span>
                <span>Command</span>
              </div>
              {processes.map((proc) => (
                <div
                  key={proc.pid}
                  className="grid grid-cols-[60px_80px_70px_1fr] gap-2 px-2 py-1 rounded hover:bg-muted/20 transition-colors group"
                >
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {proc.pid}
                  </span>
                  <Badge
                    variant="outline"
                    className={`text-[9px] px-1.5 py-0 h-4 w-fit ${CATEGORY_COLORS[proc.category]}`}
                  >
                    {CATEGORY_LABELS[proc.category]}
                  </Badge>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {proc.memoryMB >= 1024
                      ? `${(proc.memoryMB / 1024).toFixed(1)} GB`
                      : `${proc.memoryMB} MB`}
                  </span>
                  <span className="text-[9px] text-muted-foreground/60 truncate font-mono" title={proc.commandLine}>
                    {proc.commandLine}
                  </span>
                </div>
              ))}
            </div>
          )}
          {cleanupResult && (
            <div className="text-[10px] text-amber-400/80 px-2 py-1 rounded bg-amber-500/10">
              {cleanupResult}
            </div>
          )}
          {lastFetch && (
            <div className="text-right text-[8px] text-muted-foreground/30 pt-1">
              Last updated: {lastFetch.toLocaleTimeString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
