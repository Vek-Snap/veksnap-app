"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Package,
  RefreshCw,
  Download,
  CheckCircle2,
  XCircle,
  Globe,
  ShieldOff,
  Loader2,
  HardDrive,
  GitBranch,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Search,
  Shield,
  Undo2,
  Trash2,
  Plus,
  Archive,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

// ── Full (file-level) backup helpers ──

interface FullBackup {
  id: string;
  label: string;
  createdAt: string;
  scopes: string[];
  sizeBytes: number;
  appVersion: string;
}

interface BackupEstimate {
  totalSourceBytes: number;
  estArchiveBytes: number;
  estSeconds: number;
  freeBytes: number;
  enoughSpace: boolean;
  scopes: { id: string; label: string; sourceBytes: number; files: number; estArchiveBytes: number }[];
}

function formatMB(b: number): string {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
  return (b / 1048576).toFixed(1) + " MB";
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function backupApi(body: Record<string, unknown>) {
  const res = await fetch("/api/component-backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Types (mirror server-side) ──

type ComponentType = "service" | "model" | "module" | "lora" | "vae" | "llm";

interface ComponentDef {
  id: string;
  name: string;
  description: string;
  type: ComponentType;
  installPath: string;
  source: { type: string; repo: string; file?: string };
  sizeEstimate?: string;
  critical?: boolean;
  tags?: string[];
  installed: boolean;
  installedVersion?: string;
  installedDate?: string;
  fileSizeBytes?: number;
}

type UpdateSafety = "safe" | "caution" | "unsafe";

interface UpdateInfo {
  componentId: string;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  latestDate?: string;
  downloadSizeBytes?: number;
  targetRef?: string;
  safety?: UpdateSafety;
  safetyReason?: string;
  requiresAck?: boolean;
}

const SAFETY_STYLES: Record<UpdateSafety, { label: string; cls: string }> = {
  safe: { label: "Safe", cls: "bg-emerald-500/15 text-emerald-400" },
  caution: { label: "Caution", cls: "bg-amber-500/15 text-amber-400" },
  unsafe: { label: "Unsafe", cls: "bg-red-500/15 text-red-400" },
};

interface RestorePointEntry {
  id: string;
  name: string;
  hash: string;
  path: string;
}

interface RestorePoint {
  id: string;
  label: string;
  createdAt: string;
  entries: RestorePointEntry[];
  trigger: "manual" | "auto-pre-update";
}

// ── Helpers ──

const TYPE_COLORS: Record<string, { border: string; bg: string; text: string; badge: string }> = {
  service: { border: "border-blue-500/30", bg: "bg-blue-500/5", text: "text-blue-400", badge: "bg-blue-500/15 text-blue-400" },
  model: { border: "border-violet-500/30", bg: "bg-violet-500/5", text: "text-violet-400", badge: "bg-violet-500/15 text-violet-400" },
  module: { border: "border-amber-500/30", bg: "bg-amber-500/5", text: "text-amber-400", badge: "bg-amber-500/15 text-amber-400" },
  lora: { border: "border-fuchsia-500/30", bg: "bg-fuchsia-500/5", text: "text-fuchsia-400", badge: "bg-fuchsia-500/15 text-fuchsia-400" },
  vae: { border: "border-emerald-500/30", bg: "bg-emerald-500/5", text: "text-emerald-400", badge: "bg-emerald-500/15 text-emerald-400" },
  llm: { border: "border-rose-500/30", bg: "bg-rose-500/5", text: "text-rose-400", badge: "bg-rose-500/15 text-rose-400" },
  "custom-node": { border: "border-cyan-500/30", bg: "bg-cyan-500/5", text: "text-cyan-400", badge: "bg-cyan-500/15 text-cyan-400" },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch { return dateStr; }
}

// ── Component ──

export default function ComponentManager() {
  const [components, setComponents] = useState<ComponentDef[]>([]);
  const [updates, setUpdates] = useState<Record<string, UpdateInfo>>({});
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [updateResults, setUpdateResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [allowOnline, setAllowOnline] = useState(false);
  const [filter, setFilter] = useState("");
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(["service", "model", "module", "lora", "vae", "llm", "custom-node"]));
  const [restorePoints, setRestorePoints] = useState<RestorePoint[]>([]);
  const [showRestorePoints, setShowRestorePoints] = useState(false);
  const [creatingRP, setCreatingRP] = useState(false);
  const [applyingRP, setApplyingRP] = useState<string | null>(null);
  const [rpResult, setRpResult] = useState<{ ok: boolean; message: string; details?: string[] } | null>(null);
  // Full (file-level) backup state
  const [showFullBackup, setShowFullBackup] = useState(false);
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [fullBackups, setFullBackups] = useState<FullBackup[]>([]);
  const [backupScopes, setBackupScopes] = useState<{ id: string; label: string; description: string }[]>([]);
  const [selScopes, setSelScopes] = useState<Set<string>>(new Set(["comfyui-core", "custom-nodes"]));
  const [backupEstimate, setBackupEstimate] = useState<BackupEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [backupLabel, setBackupLabel] = useState("");
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [backupProgress, setBackupProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);
  const [fbResult, setFbResult] = useState<{ ok: boolean; message: string; details?: string[] } | null>(null);

  // Load components + settings
  const loadComponents = useCallback(async () => {
    setLoading(true);
    try {
      const [compResp, settResp] = await Promise.all([
        fetch("/api/components"),
        fetch("/api/settings"),
      ]);
      if (compResp.ok) {
        const data = await compResp.json();
        setComponents(data.components || []);
      }
      if (settResp.ok) {
        const data = await settResp.json();
        setAllowOnline(!!data.allowOnline);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadComponents(); }, [loadComponents]);

  // Check for updates
  const checkUpdates = useCallback(async () => {
    setChecking(true);
    setUpdates({});
    try {
      const resp = await fetch("/api/components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-updates" }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const map: Record<string, UpdateInfo> = {};
        for (const u of (data.updates || [])) {
          map[u.componentId] = u;
        }
        setUpdates(map);
      } else {
        const data = await resp.json();
        alert(data.error || "Failed to check updates");
      }
    } catch (e) {
      alert(`Network error: ${(e as Error).message}`);
    }
    setChecking(false);
  }, []);

  // Update a component. Non-safe upgrades (caution/unsafe) require the user to
  // explicitly accept responsibility before we send acceptRisk to the server.
  const updateComponent = useCallback(async (id: string) => {
    const info = updates[id];
    let acceptRisk = false;
    if (info?.requiresAck) {
      const sev = (info.safety ?? "caution").toUpperCase();
      const ok = window.confirm(
        `${sev} UPDATE\n\n${info.safetyReason ?? ""}\n\n` +
        `Target: ${info.targetRef ?? "latest"}\n\n` +
        `This strays from the staff-validated version. If you proceed you assume ` +
        `responsibility if the program breaks. A restore point is created automatically.\n\nContinue?`
      );
      if (!ok) return;
      acceptRisk = true;
    }
    setUpdating((prev) => ({ ...prev, [id]: true }));
    try {
      const resp = await fetch("/api/components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", id, acceptRisk }),
      });
      const data = await resp.json();
      setUpdateResults((prev) => ({ ...prev, [id]: { ok: !!data.ok, message: data.message ?? (data.ok ? "Updated" : "Update failed") } }));
      // Refresh component list
      await loadComponents();
    } catch (e) {
      setUpdateResults((prev) => ({ ...prev, [id]: { ok: false, message: (e as Error).message } }));
    }
    setUpdating((prev) => ({ ...prev, [id]: false }));
  }, [loadComponents, updates]);

  const toggleType = (type: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  // Restore point operations
  const loadRestorePoints = useCallback(async () => {
    try {
      const resp = await fetch("/api/components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list-restore-points" }),
      });
      if (resp.ok) {
        const data = await resp.json();
        setRestorePoints(data.restorePoints || []);
      }
    } catch { /* ignore */ }
  }, []);

  const createRestorePoint = useCallback(async () => {
    setCreatingRP(true);
    try {
      const resp = await fetch("/api/components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-restore-point" }),
      });
      if (resp.ok) {
        await loadRestorePoints();
      }
    } catch { /* ignore */ }
    setCreatingRP(false);
  }, [loadRestorePoints]);

  const applyRestorePoint = useCallback(async (id: string) => {
    if (!confirm("This will roll back all components to the state captured in this restore point. Continue?")) return;
    setApplyingRP(id);
    setRpResult(null);
    try {
      const resp = await fetch("/api/components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply-restore-point", id }),
      });
      const data = await resp.json();
      setRpResult(data);
      await loadComponents();
    } catch (e) {
      setRpResult({ ok: false, message: (e as Error).message });
    }
    setApplyingRP(null);
  }, [loadComponents]);

  const deleteRestorePoint = useCallback(async (id: string) => {
    try {
      await fetch("/api/components", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-restore-point", id }),
      });
      await loadRestorePoints();
    } catch { /* ignore */ }
  }, [loadRestorePoints]);

  useEffect(() => { loadRestorePoints(); }, [loadRestorePoints]);

  // ── Full (file-level) backup operations ──
  const loadFullBackups = useCallback(async () => {
    try { const d = await backupApi({ action: "list" }); setFullBackups(d.backups || []); } catch { /* ignore */ }
  }, []);
  const loadBackupScopes = useCallback(async () => {
    try { const d = await backupApi({ action: "scopes" }); setBackupScopes(d.scopes || []); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadFullBackups(); loadBackupScopes(); }, [loadFullBackups, loadBackupScopes]);

  // Re-estimate whenever the selection changes while the create panel is open.
  useEffect(() => {
    if (!showCreatePanel) return;
    const ids = [...selScopes];
    if (ids.length === 0) { setBackupEstimate(null); return; }
    let cancelled = false;
    setEstimating(true);
    backupApi({ action: "estimate", scopes: ids })
      .then((d) => { if (!cancelled) setBackupEstimate(d); })
      .catch(() => { if (!cancelled) setBackupEstimate(null); })
      .finally(() => { if (!cancelled) setEstimating(false); });
    return () => { cancelled = true; };
  }, [selScopes, showCreatePanel]);

  const createFullBackup = useCallback(async () => {
    const ids = [...selScopes];
    if (ids.length === 0) return;
    setCreatingBackup(true); setFbResult(null); setBackupProgress({ phase: "starting", pct: 0 });
    try {
      const start = await backupApi({ action: "create", label: backupLabel, scopes: ids });
      const jobId = start.jobId;
      if (!jobId) throw new Error(start.error || "Failed to start backup");
      // Poll job progress.
      for (;;) {
        await new Promise((r) => setTimeout(r, 600));
        const j = await backupApi({ action: "job", jobId });
        const pct = j.progress?.totalBytes
          ? Math.min(100, Math.round((j.progress.processedBytes / j.progress.totalBytes) * 100))
          : 0;
        setBackupProgress({ phase: j.progress?.phase || "working", pct });
        if (j.status === "done") {
          setFbResult({ ok: true, message: `Created "${j.result.label}" (${formatMB(j.result.sizeBytes)})` });
          break;
        }
        if (j.status === "error") { setFbResult({ ok: false, message: j.error || "Backup failed" }); break; }
      }
      await loadFullBackups();
    } catch (e) {
      setFbResult({ ok: false, message: (e as Error).message });
    }
    setCreatingBackup(false); setBackupProgress(null); setShowCreatePanel(false); setBackupLabel("");
  }, [selScopes, backupLabel, loadFullBackups]);

  const restoreFullBackup = useCallback(async (id: string) => {
    if (!confirm("Restore this Verified Restore Point?\n\nThe current files for the captured scopes will be REPLACED with the backed-up copy. A safety copy is made during the swap and rolled back automatically if anything fails. This runs fully offline.")) return;
    setRestoringBackup(id); setFbResult(null);
    try { const r = await backupApi({ action: "restore", id }); setFbResult(r); }
    catch (e) { setFbResult({ ok: false, message: (e as Error).message }); }
    setRestoringBackup(null);
  }, []);

  const deleteFullBackup = useCallback(async (id: string) => {
    if (!confirm("Delete this backup archive permanently?")) return;
    try { await backupApi({ action: "delete", id }); await loadFullBackups(); } catch { /* ignore */ }
  }, [loadFullBackups]);

  // Group & filter
  const filtered = components.filter((c) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return c.name.toLowerCase().includes(q)
      || c.description.toLowerCase().includes(q)
      || c.type.toLowerCase().includes(q)
      || (c.tags || []).some((t) => t.includes(q));
  });

  const grouped: Record<string, ComponentDef[]> = {};
  for (const c of filtered) {
    const groupKey = (c.tags || []).includes("custom-node") ? "custom-node" : c.type;
    if (!grouped[groupKey]) grouped[groupKey] = [];
    grouped[groupKey].push(c);
  }

  const typeOrder: (ComponentType | "custom-node")[] = ["service", "module", "model", "lora", "vae", "llm", "custom-node"];
  const typeLabels: Record<string, string> = {
    service: "Services",
    module: "Modules",
    model: "Models & Checkpoints",
    lora: "LoRA Adapters",
    vae: "VAE Models",
    llm: "Language Models",
    "custom-node": "Custom Nodes",
  };

  const totalInstalled = components.filter((c) => c.installed).length;
  const totalAvailable = components.length;
  const updatesAvailable = Object.values(updates).filter((u) => u.updateAvailable).length;

  return (
    <div className="p-4 space-y-4 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/15 text-cyan-400">
            <Package className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Component Manager</h2>
            <p className="text-[10px] text-muted-foreground">
              {totalInstalled}/{totalAvailable} installed
              {updatesAvailable > 0 && (
                <span className="ml-1.5 text-amber-400">• {updatesAvailable} update{updatesAvailable !== 1 ? "s" : ""} available</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Online status indicator */}
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
            allowOnline
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-border/60 bg-muted/10 text-muted-foreground"
          }`}>
            {allowOnline ? <Globe className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
            {allowOnline ? "Online" : "Offline"}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] gap-1.5 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
            onClick={checkUpdates}
            disabled={checking || !allowOnline}
            title={!allowOnline ? "Enable online mode to check for updates" : "Check all components for available updates"}
          >
            {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {checking ? "Checking..." : "Check Updates"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] gap-1.5"
            onClick={loadComponents}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          placeholder="Filter components..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-8 h-8 text-xs bg-background/50"
        />
      </div>

      {/* Offline warning */}
      {!allowOnline && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>System is in offline mode. Enable online mode in the header to check for or download updates.</span>
        </div>
      )}

      {/* Restore Points */}
      <div className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 overflow-hidden">
        <button
          onClick={() => setShowRestorePoints(!showRestorePoints)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.02] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            {showRestorePoints ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Shield className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-xs font-medium text-indigo-400">Restore Points</span>
            <span className="text-[10px] text-muted-foreground">({restorePoints.length})</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] gap-1 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10"
            onClick={(e) => { e.stopPropagation(); createRestorePoint(); }}
            disabled={creatingRP}
          >
            {creatingRP ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
            Create Snapshot
          </Button>
        </button>

        {showRestorePoints && (
          <div className="border-t border-border/30 divide-y divide-border/20">
            {restorePoints.length === 0 ? (
              <div className="px-3 py-3 text-[10px] text-muted-foreground text-center">
                No restore points yet. Create one before updating components.
                <br />
                <span className="text-indigo-400/70">Restore points are also created automatically before each update.</span>
              </div>
            ) : (
              restorePoints.map((rp) => (
                <div key={rp.id} className="px-3 py-2 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-foreground truncate">{rp.label}</span>
                        <Badge variant="outline" className={`text-[9px] h-4 px-1 border-0 ${
                          rp.trigger === "auto-pre-update"
                            ? "bg-amber-500/15 text-amber-400"
                            : "bg-indigo-500/15 text-indigo-400"
                        }`}>
                          {rp.trigger === "auto-pre-update" ? "auto" : "manual"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(rp.createdAt).toLocaleString()}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60">
                          {rp.entries.length} components
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] gap-1 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10"
                        onClick={() => applyRestorePoint(rp.id)}
                        disabled={applyingRP === rp.id}
                      >
                        {applyingRP === rp.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                        Restore
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400"
                        onClick={() => deleteRestorePoint(rp.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}

            {/* Restore result */}
            {rpResult && (
              <div className={`px-3 py-2 ${rpResult.ok ? "bg-emerald-500/5" : "bg-red-500/5"}`}>
                <p className={`text-[11px] font-medium ${rpResult.ok ? "text-emerald-400" : "text-red-400"}`}>
                  {rpResult.message}
                </p>
                {rpResult.details && rpResult.details.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {rpResult.details.map((d, i) => (
                      <p key={i} className="text-[10px] text-muted-foreground font-mono">{d}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Verified Restore Points (full, file-level backups) */}
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 overflow-hidden">
        <button
          onClick={() => setShowFullBackup(!showFullBackup)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.02] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            {showFullBackup ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">Verified Restore Points</span>
            <span className="text-[10px] text-muted-foreground">({fullBackups.length})</span>
            <Badge variant="outline" className="text-[9px] h-4 px-1 border-0 bg-emerald-500/15 text-emerald-400">full backup</Badge>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] gap-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
            onClick={(e) => { e.stopPropagation(); setShowFullBackup(true); setShowCreatePanel((v) => !v); }}
            disabled={creatingBackup}
          >
            {creatingBackup ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
            Create Full Backup
          </Button>
        </button>

        {showFullBackup && (
          <div className="border-t border-border/30">
            <div className="px-3 py-2 text-[10px] text-muted-foreground">
              Captures the actual files into a single sealed, compressed archive, so you can roll back{" "}
              <span className="text-emerald-400/80">completely offline</span>, even to a version that&apos;s no longer downloadable.
            </div>

            {showCreatePanel && (
              <div className="px-3 py-2 border-t border-border/20 bg-black/20 space-y-2">
                <div className="text-[10px] font-medium text-foreground">Choose what to back up:</div>
                <div className="grid grid-cols-1 gap-1">
                  {backupScopes.map((s) => {
                    const on = selScopes.has(s.id);
                    const es = backupEstimate?.scopes.find((x) => x.id === s.id);
                    return (
                      <label key={s.id} className="flex items-start gap-2 text-[10px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => setSelScopes((prev) => { const n = new Set(prev); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <span className="flex-1">
                          <span className="text-foreground">{s.label}</span>
                          {on && es && <span className="text-emerald-400/70">: {formatMB(es.sourceBytes)} ({es.files} files)</span>}
                          <span className="block text-muted-foreground/60">{s.description}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <Input
                  value={backupLabel}
                  onChange={(e) => setBackupLabel(e.target.value)}
                  placeholder="Label (optional, e.g. 'before v0.30 upgrade')"
                  className="h-7 text-[11px]"
                />
                <div className="text-[10px] rounded border border-border/30 bg-black/20 px-2 py-1.5 space-y-0.5">
                  {estimating ? (
                    <span className="text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Estimating…</span>
                  ) : backupEstimate ? (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">Source size</span><span className="text-foreground">{formatMB(backupEstimate.totalSourceBytes)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Approx. archive size</span><span className="text-foreground">~{formatMB(backupEstimate.estArchiveBytes)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Approx. time</span><span className="text-foreground">~{formatDuration(backupEstimate.estSeconds)}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">Free space</span><span className={backupEstimate.enoughSpace ? "text-emerald-400" : "text-red-400"}>{formatMB(backupEstimate.freeBytes)}</span></div>
                      {!backupEstimate.enoughSpace && (
                        <div className="text-red-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Not enough free space for this backup.</div>
                      )}
                    </>
                  ) : <span className="text-muted-foreground">Select at least one scope.</span>}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    className="h-7 text-[10px] gap-1 bg-emerald-600 hover:bg-emerald-500 text-white"
                    onClick={createFullBackup}
                    disabled={creatingBackup || selScopes.size === 0 || (backupEstimate != null && !backupEstimate.enoughSpace)}
                  >
                    {creatingBackup ? <Loader2 className="w-3 h-3 animate-spin" /> : <Archive className="w-3 h-3" />}
                    Create sealed backup
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={() => setShowCreatePanel(false)} disabled={creatingBackup}>Cancel</Button>
                </div>
                {backupProgress && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-muted-foreground"><span>{backupProgress.phase}</span><span>{backupProgress.pct}%</span></div>
                    <div className="h-1.5 rounded bg-white/5 overflow-hidden"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${backupProgress.pct}%` }} /></div>
                  </div>
                )}
              </div>
            )}

            <div className="divide-y divide-border/20 border-t border-border/20">
              {fullBackups.length === 0 ? (
                <div className="px-3 py-3 text-[10px] text-muted-foreground text-center">No full backups yet.</div>
              ) : fullBackups.map((b) => (
                <div key={b.id} className="px-3 py-2 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span className="text-[11px] font-medium text-foreground truncate">{b.label}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground">{new Date(b.createdAt).toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground/60">{formatMB(b.sizeBytes)}</span>
                        <span className="text-[10px] text-muted-foreground/60">{b.scopes.join(", ")}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[10px] gap-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                        onClick={() => restoreFullBackup(b.id)}
                        disabled={restoringBackup === b.id}
                      >
                        {restoringBackup === b.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                        Restore
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400" onClick={() => deleteFullBackup(b.id)}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {fbResult && (
                <div className={`px-3 py-2 ${fbResult.ok ? "bg-emerald-500/5" : "bg-red-500/5"}`}>
                  <p className={`text-[11px] font-medium ${fbResult.ok ? "text-emerald-400" : "text-red-400"}`}>{fbResult.message}</p>
                  {fbResult.details && fbResult.details.length > 0 && (
                    <div className="mt-1 space-y-0.5">{fbResult.details.map((d, i) => <p key={i} className="text-[10px] text-muted-foreground font-mono">{d}</p>)}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Component groups */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-xs gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Scanning components...
        </div>
      ) : (
        <div className="space-y-3">
          {typeOrder.map((type) => {
            const items = grouped[type];
            if (!items || items.length === 0) return null;
            const expanded = expandedTypes.has(type);
            const colors = TYPE_COLORS[type];

            return (
              <div key={type} className={`rounded-lg border ${colors.border} ${colors.bg} overflow-hidden`}>
                {/* Group header */}
                <button
                  onClick={() => toggleType(type)}
                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.02] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    <span className={`text-xs font-medium ${colors.text}`}>{typeLabels[type] || type}</span>
                    <span className="text-[10px] text-muted-foreground">({items.length})</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {items.filter((c) => c.installed).length === items.length ? (
                      <span className="text-[10px] text-emerald-400">All installed</span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        {items.filter((c) => c.installed).length}/{items.length} installed
                      </span>
                    )}
                  </div>
                </button>

                {/* Items */}
                {expanded && (
                  <div className="border-t border-border/30 divide-y divide-border/20">
                    {items.map((comp) => {
                      const update = updates[comp.id];
                      const isUpdating = updating[comp.id];
                      const result = updateResults[comp.id];

                      return (
                        <div key={comp.id} className="px-3 py-2.5 hover:bg-white/[0.02] transition-colors">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-foreground">{comp.name}</span>
                                {comp.critical && (
                                  <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-500/40 text-amber-400">
                                    Core
                                  </Badge>
                                )}
                                <Badge variant="outline" className={`text-[9px] h-4 px-1 ${colors.badge} border-0`}>
                                  {(comp.tags || []).includes("custom-node") ? "node" : comp.type}
                                </Badge>
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{comp.description}</p>

                              <div className="flex items-center gap-3 mt-1">
                                {/* Install status */}
                                <span className={`flex items-center gap-1 text-[10px] ${comp.installed ? "text-emerald-400" : "text-muted-foreground"}`}>
                                  {comp.installed ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                                  {comp.installed ? "Installed" : "Not installed"}
                                </span>

                                {/* Version */}
                                {comp.installedVersion && (
                                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <GitBranch className="w-3 h-3" />
                                    {comp.installedVersion}
                                  </span>
                                )}

                                {/* Date */}
                                {comp.installedDate && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {formatDate(comp.installedDate)}
                                  </span>
                                )}

                                {/* Size */}
                                {comp.fileSizeBytes ? (
                                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <HardDrive className="w-3 h-3" />
                                    {formatBytes(comp.fileSizeBytes)}
                                  </span>
                                ) : comp.sizeEstimate && (
                                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                    <HardDrive className="w-3 h-3" />
                                    {comp.sizeEstimate}
                                  </span>
                                )}

                                {/* Source */}
                                <span className="text-[10px] text-muted-foreground/60 truncate">
                                  {comp.source.repo}
                                </span>
                              </div>

                              {/* Update info */}
                              {update && (
                                <div className="mt-1.5">
                                  {update.updateAvailable && !result?.ok ? (
                                    <div className="flex flex-col gap-0.5">
                                      <span className="text-[10px] text-amber-400 flex items-center gap-1.5">
                                        <AlertTriangle className="w-3 h-3" />
                                        Update available
                                        {update.latestVersion && ` (${update.latestVersion})`}
                                        {update.latestDate && `: ${formatDate(update.latestDate)}`}
                                        {update.safety && (
                                          <span className={`px-1 rounded text-[9px] font-medium ${SAFETY_STYLES[update.safety].cls}`}>
                                            {SAFETY_STYLES[update.safety].label}
                                          </span>
                                        )}
                                      </span>
                                      {update.safety && update.safety !== "safe" && update.safetyReason && (
                                        <span className="text-[9px] text-muted-foreground/80 pl-4">{update.safetyReason}</span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-[10px] text-emerald-400/70 flex items-center gap-1">
                                      <CheckCircle2 className="w-3 h-3" />
                                      Up to date
                                    </span>
                                  )}
                                </div>
                              )}

                              {/* Update result */}
                              {result && (
                                <div className={`mt-1 text-[10px] ${result.ok ? "text-emerald-400" : "text-red-400"}`}>
                                  {result.message}
                                </div>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="shrink-0">
                              {result?.ok ? (
                                <span className="flex items-center gap-1 h-6 text-[10px] font-medium text-emerald-400">
                                  <CheckCircle2 className="w-3 h-3" />
                                  Complete
                                </span>
                              ) : (update?.updateAvailable || !comp.installed) && allowOnline && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className={`h-6 text-[10px] gap-1 ${
                                    comp.installed
                                      ? "border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                                      : "border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                                  }`}
                                  onClick={() => updateComponent(comp.id)}
                                  disabled={isUpdating}
                                >
                                  {isUpdating ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <Download className="w-3 h-3" />
                                  )}
                                  {comp.installed ? "Update" : "Install"}
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
