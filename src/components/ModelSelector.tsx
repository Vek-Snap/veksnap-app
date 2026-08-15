"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Layers, Film, RefreshCw, FolderPlus, X, ChevronDown, ChevronRight, Search } from "lucide-react";
import { getCheckpoints, getAnimateDiffModels, getCheckpointSizes } from "@/lib/comfyui-api";
import { GenerationMode, ComposeOutputType, isCheckpointCompatible, getCheckpointArch } from "@/lib/types";

// Architecture tag color map
const ARCH_COLORS: Record<string, { text: string; bg: string; label: string }> = {
  sd15:  { text: "text-sky-400",     bg: "bg-sky-500/15",     label: "SD 1.5" },
  sdxl:  { text: "text-blue-400",    bg: "bg-blue-500/15",    label: "SDXL" },
  pony:  { text: "text-pink-400",    bg: "bg-pink-500/15",    label: "Pony" },
  unknown: { text: "text-muted-foreground",  bg: "bg-muted/15",    label: "?" },
};

function getArchColor(arch: string) {
  const key = arch.toLowerCase();
  if (key.includes("pony")) return ARCH_COLORS.pony;
  if (key.includes("xl") || key.includes("sdxl")) return ARCH_COLORS.sdxl;
  if (key.includes("sd15") || key.includes("1.5") || key === "sd15") return ARCH_COLORS.sd15;
  return ARCH_COLORS[key] || ARCH_COLORS.unknown;
}

interface Props {
  checkpoint: string;
  motionModule: string;
  mode: GenerationMode;
  composeOutputType?: ComposeOutputType;
  hideMotionModule?: boolean;
  onCheckpointChange: (v: string) => void;
  onMotionModuleChange: (v: string) => void;
}

export default function ModelSelector({
  checkpoint,
  motionModule,
  mode,
  composeOutputType,
  hideMotionModule,
  onCheckpointChange,
  onMotionModuleChange,
}: Props) {
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [motionModules, setMotionModules] = useState<string[]>([]);
  const [ckptSizes, setCkptSizes] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extraDirs, setExtraDirs] = useState<string[]>([]);
  const [newDir, setNewDir] = useState("");
  const [showDirs, setShowDirs] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // Search dropdown state
  const [searchText, setSearchText] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadModels = useCallback(async (retries = 3, delay = 2000) => {
    setLoading(true);
    setError(null);
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const [ckpts, mms, sizes] = await Promise.all([
          getCheckpoints(),
          getAnimateDiffModels(),
          getCheckpointSizes(),
        ]);
        console.log(`[Models] Loaded ${ckpts.length} checkpoints, ${mms.length} motion modules, ${Object.keys(sizes).length} sizes`);
        setCheckpoints(ckpts);
        setMotionModules(mms);
        setCkptSizes(sizes);
        if (ckpts.length > 0 && !checkpoint) onCheckpointChange(ckpts[0]);
        if (mms.length > 0 && !motionModule) onMotionModuleChange(mms[0]);
        setLoading(false);
        return;
      } catch (err) {
        console.warn(`[Models] Attempt ${attempt}/${retries} failed:`, err);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    setError("Could not reach ComfyUI: is it running?");
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setExtraDirs(data.extraCheckpointDirs ?? []);
      }
    } catch { /* ignore */ }
  }, []);

  const addDir = async () => {
    const dir = newDir.trim();
    if (!dir) return;
    setDirError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", dir }),
      });
      const data = await res.json();
      if (!res.ok) { setDirError(data.error); return; }
      setExtraDirs(data.extraCheckpointDirs);
      setNewDir("");
    } catch (err) {
      setDirError(err instanceof Error ? err.message : "Failed");
    }
  };

  const removeDir = async (dir: string) => {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", dir }),
      });
      if (res.ok) {
        const data = await res.json();
        setExtraDirs(data.extraCheckpointDirs);
      }
    } catch { /* ignore */ }
  };

  // Defer model loading: ComfyUI may take 3+ minutes to fully boot.
  // Wait a few seconds before first attempt to avoid early 502 spam.
  useEffect(() => {
    loadSettings();
    const timer = setTimeout(() => loadModels(5, 5000), 5000);
    return () => clearTimeout(timer);
  }, [loadModels, loadSettings]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // When ComfyUI is reachable but no models resolved, surface the path editor
  // so "apply model file locations below" is immediately actionable.
  useEffect(() => {
    if (!loading && !error && checkpoints.length === 0) setShowDirs(true);
  }, [loading, error, checkpoints.length]);

  // Filtered and sorted checkpoints
  const getFilteredCheckpoints = () => {
    const query = searchText.toLowerCase();
    let filtered = checkpoints;
    if (query) {
      filtered = filtered.filter((c) => c.toLowerCase().includes(query));
    }
    // Sort: compatible first, then incompatible
    return [...filtered].sort((a, b) => {
      const aOk = isCheckpointCompatible(ckptSizes[a], mode, composeOutputType) ? 0 : 1;
      const bOk = isCheckpointCompatible(ckptSizes[b], mode, composeOutputType) ? 0 : 1;
      return aOk - bOk;
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Layers className="w-4 h-4" /> Models
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground ml-auto gap-1"
            onClick={() => loadModels()}
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            {error ? "Retry" : "Refresh"}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-[10px] text-destructive">{error}</p>
        )}
        {!loading && !error && checkpoints.length === 0 && (
          <p className="text-[10px] text-muted-foreground">
            No models are currently within the known paths. Please apply model file locations below.
          </p>
        )}

        {/* Checkpoint: Searchable dropdown */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Checkpoint</Label>
          <div className="relative" ref={dropdownRef}>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={dropdownOpen ? searchText : (checkpoint || "")}
                placeholder={checkpoint || "Search checkpoints..."}
                onFocus={() => {
                  setDropdownOpen(true);
                  setSearchText("");
                }}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  if (!dropdownOpen) setDropdownOpen(true);
                }}
                disabled={loading || checkpoints.length === 0}
                className="w-full h-8 rounded-md border border-input bg-background pl-7 pr-7 text-[11px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 truncate"
              />
              {checkpoint && !dropdownOpen && (
                <button
                  type="button"
                  onClick={() => onCheckpointChange("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  title="Clear selection"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {dropdownOpen && (
              <div className="absolute z-50 mt-1 w-full max-h-80 overflow-y-auto rounded-md border border-input bg-background shadow-lg">
                {/* Architecture tag legend */}
                <div className="px-2 py-1 text-[9px] text-muted-foreground border-b border-input/50 flex items-center gap-1.5 flex-wrap">
                  {Object.entries(ARCH_COLORS).filter(([k]) => k !== "unknown").map(([k, v]) => (
                    <span key={k} className={`${v.text} px-1 rounded ${v.bg}`}>{v.label}</span>
                  ))}
                </div>
                {loading ? (
                  <div className="px-2 py-2 text-[10px] text-muted-foreground">Loading...</div>
                ) : getFilteredCheckpoints().length === 0 ? (
                  <div className="px-2 py-2 text-[10px] text-muted-foreground">No matches</div>
                ) : (
                  getFilteredCheckpoints().map((name) => {
                    const arch = getCheckpointArch(ckptSizes[name], name);
                    const compatible = isCheckpointCompatible(ckptSizes[name], mode, composeOutputType);
                    const archColor = getArchColor(arch);
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => {
                          onCheckpointChange(name);
                          setDropdownOpen(false);
                          setSearchText("");
                        }}
                        className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-accent hover:text-accent-foreground flex items-center gap-1.5 ${
                          name === checkpoint ? "bg-accent/50 font-medium" : ""
                        } ${!compatible ? "opacity-35" : ""}`}
                      >
                        <span className={`text-[8px] font-medium px-1 rounded flex-shrink-0 ${archColor.text} ${archColor.bg}`}>
                          {archColor.label}
                        </span>
                        <span className="truncate flex-1">{name}</span>
                        {!compatible && (
                          <span className="text-[8px] text-destructive/60 flex-shrink-0">incompatible</span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {!hideMotionModule && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Film className="w-3 h-3" /> Motion Module
            </Label>
            <select
              value={motionModule}
              onChange={(e) => onMotionModuleChange(e.target.value)}
              disabled={loading || motionModules.length === 0}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-xs ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading && <option value="">Loading...</option>}
              {!loading && motionModules.length === 0 && (
                <option value="">{error ? "Unavailable" : "No motion modules found"}</option>
              )}
              {motionModules.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        )}
        {/* Extra Checkpoint Directories */}
        <div className="border-t border-border pt-3">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground w-full"
            onClick={() => setShowDirs(!showDirs)}
          >
            {showDirs ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Extra Checkpoint Directories ({extraDirs.length})
          </button>
          {showDirs && (
            <div className="mt-2 space-y-2">
              {extraDirs.map((dir) => (
                <div key={dir} className="flex items-center gap-1 text-[10px] bg-muted/30 rounded px-2 py-1">
                  <span className="flex-1 truncate font-mono text-muted-foreground" title={dir}>{dir}</span>
                  <button
                    type="button"
                    className="text-destructive/60 hover:text-destructive flex-shrink-0"
                    onClick={() => removeDir(dir)}
                    title="Remove directory"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newDir}
                  onChange={(e) => setNewDir(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addDir()}
                  placeholder="D:\\path\\to\\checkpoints"
                  className="flex-1 h-7 rounded border border-input bg-background px-2 text-[10px] font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  onClick={addDir}
                  title="Add directory"
                >
                  <FolderPlus className="w-3 h-3" />
                </Button>
              </div>
              {dirError && <p className="text-[9px] text-destructive">{dirError}</p>}
              <p className="text-[9px] text-muted-foreground/60">
                ComfyUI restart required after adding/removing directories.
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
