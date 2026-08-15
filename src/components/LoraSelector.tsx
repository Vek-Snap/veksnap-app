"use client";

import { useEffect, useState, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Wand2, Plus, Trash2, ChevronDown, ChevronRight, Link, Unlink, RefreshCw, Search, X, ScanLine, Info } from "lucide-react";
import { LoraEntry, GenerationMode } from "@/lib/types";
import DecimalInput from "@/components/DecimalInput";

// ── LoRA catalog types (mirrors /api/lora-scan response) ──

interface LoraCatalogEntry {
  name: string;
  modelType: string;
  compatibleModes: string[];
  title: string;
  description: string;
  baseModel: string;
  rank: number | null;
  meta: Record<string, string>;
}

const TYPE_COLORS: Record<string, { text: string; label: string }> = {
  ltx2:         { text: "text-violet-400",  label: "LTX-2" },
  ltx2_5:       { text: "text-fuchsia-400", label: "LTX-2.5" },
  ltx2_distill: { text: "text-violet-300",  label: "LTX-2 Distill" },
  ltx2_motion:  { text: "text-cyan-400",    label: "Motion" },
  wan:          { text: "text-amber-400",   label: "WAN" },
  sdxl:         { text: "text-blue-400",    label: "SDXL" },
  sd15:         { text: "text-sky-400",     label: "SD 1.5" },
  zimage:       { text: "text-teal-400",    label: "Z-Image" },
  acestep:      { text: "text-pink-400",    label: "AceStep" },
  unknown:      { text: "text-muted-foreground",    label: "?" },
};

interface Props {
  loras: LoraEntry[];
  onChange: (loras: LoraEntry[]) => void;
  mode?: GenerationMode;
}

const MAX_LORAS = 5;

function createEmptyLora(): LoraEntry {
  return { enabled: true, name: "", strengthModel: 1.0, strengthClip: 1.0 };
}

export default function LoraSelector({ loras, onChange, mode }: Props) {
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [linkedWeights, setLinkedWeights] = useState<Record<number, boolean>>({});
  const [catalog, setCatalog] = useState<Map<string, LoraCatalogEntry>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [infoName, setInfoName] = useState<string | null>(null);

  const loadLoras = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/lora-files?t=${Date.now()}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const list: string[] = await res.json();
      setAvailableLoras(list);
    } catch {
      // LoRA loading is non-critical: just show empty list
    }
    setLoading(false);
  }, []);

  // Load cached catalog on mount (non-blocking)
  useEffect(() => {
    fetch("/api/lora-scan")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.catalog) {
          const map = new Map<string, LoraCatalogEntry>();
          for (const entry of data.catalog) map.set(entry.name, entry);
          setCatalog(map);
        }
      })
      .catch(() => {});
  }, []);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/lora-scan?refresh=1");
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (data?.catalog) {
        const map = new Map<string, LoraCatalogEntry>();
        for (const entry of data.catalog) map.set(entry.name, entry);
        setCatalog(map);
      }
    } catch { /* non-critical */ }
    setScanning(false);
  }, []);

  const isCompatible = useCallback(
    (loraName: string): boolean => {
      if (!mode) return true;
      const entry = catalog.get(loraName);
      if (!entry) return true;
      if (entry.compatibleModes.length === 0) return true;
      return entry.compatibleModes.includes(mode);
    },
    [mode, catalog]
  );

  const getTypeInfo = (loraName: string) => {
    const entry = catalog.get(loraName);
    return TYPE_COLORS[entry?.modelType || "unknown"] || TYPE_COLORS.unknown;
  };

  useEffect(() => {
    loadLoras();
  }, [loadLoras]);

  const addLora = () => {
    if (loras.length >= MAX_LORAS) return;
    const entry = createEmptyLora();
    // Auto-select first available lora not already in use
    const usedNames = new Set(loras.map((l) => l.name));
    const firstUnused = availableLoras.find((n) => !usedNames.has(n));
    if (firstUnused) entry.name = firstUnused;
    onChange([...loras, entry]);
  };

  const removeLora = (index: number) => {
    const next = loras.filter((_, i) => i !== index);
    onChange(next);
    // Clean up linked state
    const newLinked = { ...linkedWeights };
    delete newLinked[index];
    setLinkedWeights(newLinked);
  };

  const updateLora = (index: number, patch: Partial<LoraEntry>) => {
    const next = loras.map((l, i) => {
      if (i !== index) return l;
      const updated = { ...l, ...patch };
      // If weights are linked and model strength changed, sync clip strength
      if (linkedWeights[index] !== false && patch.strengthModel !== undefined) {
        updated.strengthClip = patch.strengthModel;
      }
      if (linkedWeights[index] !== false && patch.strengthClip !== undefined) {
        updated.strengthModel = patch.strengthClip;
      }
      return updated;
    });
    onChange(next);
  };

  const toggleLink = (index: number) => {
    const isLinked = linkedWeights[index] !== false;
    setLinkedWeights({ ...linkedWeights, [index]: !isLinked });
    // If linking, sync clip to model
    if (!isLinked) {
      updateLora(index, { strengthClip: loras[index].strengthModel });
    }
  };

  // Search/filter state: per-slot search text and open dropdown index
  const [searchText, setSearchText] = useState<Record<number, string>>({});
  const [openDropdown, setOpenDropdown] = useState<number | null>(null);
  const dropdownRefs = useState<Record<number, HTMLDivElement | null>>({})[0];

  // Close dropdown on outside click
  useEffect(() => {
    if (openDropdown === null) return;
    const handler = (e: MouseEvent) => {
      const el = dropdownRefs[openDropdown];
      if (el && !el.contains(e.target as Node)) setOpenDropdown(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openDropdown, dropdownRefs]);

  const getFilteredLoras = (index: number) => {
    const query = (searchText[index] || "").toLowerCase();
    let filtered = availableLoras;
    if (query) {
      filtered = filtered.filter((n) => n.toLowerCase().includes(query));
    }
    // Sort: compatible first, then incompatible (greyed out)
    if (mode && catalog.size > 0) {
      filtered = [...filtered].sort((a, b) => {
        const aOk = isCompatible(a) ? 0 : 1;
        const bOk = isCompatible(b) ? 0 : 1;
        return aOk - bOk;
      });
    }
    return filtered;
  };

  const enabledCount = loras.filter((l) => l.enabled && l.name).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-2 flex-1 text-left"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Wand2 className="w-4 h-4" />
            LoRAs
            {enabledCount > 0 && (
              <span className="text-[10px] text-cyan-400 font-normal">
                ({enabledCount} active)
              </span>
            )}
          </button>
          {expanded && (
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                onClick={runScan}
                disabled={scanning}
                title="Scan LoRAs: classify by model type and read usage notes"
              >
                {scanning ? (
                  // Spinning rainbow pinwheel masked to the ScanLine outline
                  // (with bloom): signals an epic scan is underway. See globals.css.
                  <span className="veksnap-scan-rainbow w-3 h-3" aria-hidden />
                ) : (
                  <ScanLine className="w-3 h-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                onClick={loadLoras}
                disabled={loading}
                title="Refresh LoRA list"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
              </Button>
              {loras.length < MAX_LORAS && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground gap-1"
                  onClick={addLora}
                  disabled={loading || availableLoras.length === 0}
                >
                  <Plus className="w-3 h-3" /> Add
                </Button>
              )}
            </div>
          )}
        </CardTitle>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-3">
          {loading && availableLoras.length === 0 && (
            <p className="text-[10px] text-muted-foreground">Loading LoRAs...</p>
          )}
          {!loading && availableLoras.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              No LoRAs found within the known paths. Add your LoRA folder locations in Settings, or place files in ComfyUI/models/loras/.
            </p>
          )}

          {loras.length === 0 && availableLoras.length > 0 && (
            <button
              type="button"
              onClick={addLora}
              className="w-full rounded-md border border-dashed border-muted-foreground/30 py-3 text-[11px] text-muted-foreground hover:text-foreground hover:border-muted-foreground/50 transition-colors"
            >
              + Add a LoRA
            </button>
          )}

          {loras.map((lora, index) => {
            const isLinked = linkedWeights[index] !== false;
            return (
              <div
                key={index}
                className={`rounded-lg border p-2.5 space-y-2 transition-colors ${
                  lora.enabled ? "border-border bg-background" : "border-border/50 bg-muted/20 opacity-60"
                }`}
              >
                {/* Header row: toggle + dropdown + delete */}
                <div className="flex items-center gap-2">
                  <Switch
                    checked={lora.enabled}
                    onCheckedChange={(v) => updateLora(index, { enabled: v })}
                    className="scale-75"
                  />
                  <div
                    className="flex-1 relative"
                    ref={(el) => { dropdownRefs[index] = el; }}
                  >
                    <div className="relative">
                      <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                      <input
                        type="text"
                        value={openDropdown === index ? (searchText[index] ?? "") : (lora.name || "")}
                        placeholder={lora.name || "Search LoRAs..."}
                        onFocus={() => {
                          setOpenDropdown(index);
                          setSearchText((s) => ({ ...s, [index]: "" }));
                        }}
                        onChange={(e) => {
                          setSearchText((s) => ({ ...s, [index]: e.target.value }));
                          if (openDropdown !== index) setOpenDropdown(index);
                        }}
                        className="w-full h-7 rounded border border-input bg-background pl-6 pr-6 text-[11px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring truncate"
                      />
                      {lora.name && openDropdown !== index && (
                        <button
                          type="button"
                          onClick={() => updateLora(index, { name: "" })}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          title="Clear selection"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    {openDropdown === index && (
                      <div className="absolute z-50 mt-1 w-full max-h-96 overflow-y-auto rounded border border-input bg-background shadow-lg">
                        {catalog.size > 0 && (
                          <div className="px-2 py-1 text-[9px] text-muted-foreground border-b border-input/50 flex items-center gap-1.5 flex-wrap">
                            {Object.entries(TYPE_COLORS).filter(([k]) => k !== "unknown").map(([k, v]) => (
                              <span key={k} className={`${v.text}`}>{v.label}</span>
                            ))}
                          </div>
                        )}
                        {getFilteredLoras(index).length === 0 ? (
                          <div className="px-2 py-1.5 text-[10px] text-muted-foreground">No matches</div>
                        ) : (
                          getFilteredLoras(index).map((name) => {
                            const compat = isCompatible(name);
                            const typeInfo = getTypeInfo(name);
                            const entry = catalog.get(name);
                            const baseName = name.split(/[\\/]/).pop() || name;
                            const hasInfo = entry && (entry.description || entry.title !== baseName);
                            return (
                              <button
                                key={name}
                                type="button"
                                onClick={() => {
                                  updateLora(index, { name });
                                  setOpenDropdown(null);
                                  setSearchText((s) => ({ ...s, [index]: "" }));
                                }}
                                className={`w-full text-left px-2 py-1 text-[11px] hover:bg-accent hover:text-accent-foreground flex items-center gap-1.5 ${
                                  name === lora.name ? "bg-accent/50 text-accent-foreground font-medium" : ""
                                } ${!compat ? "opacity-35" : ""}`}
                              >
                                {entry && (
                                  <span className={`text-[8px] font-medium ${typeInfo.text} flex-shrink-0 w-10 text-center`}>
                                    {typeInfo.label}
                                  </span>
                                )}
                                <span className="truncate flex-1">{name}</span>
                                {entry && hasInfo && (
                                  <span
                                    className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setInfoName(infoName === name ? null : name);
                                    }}
                                  >
                                    <Info className="w-3 h-3" />
                                  </span>
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                    {/* Info popover for selected LoRA */}
                    {infoName && catalog.has(infoName) && openDropdown === index && (() => {
                      const entry = catalog.get(infoName)!;
                      return (
                        <div className="absolute z-[60] mt-1 right-0 w-72 max-h-64 overflow-y-auto rounded border border-input bg-background shadow-xl p-2.5 text-[10px] space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className={`font-medium ${getTypeInfo(infoName).text}`}>
                              {entry.title || entry.name}
                            </span>
                            <button type="button" onClick={() => setInfoName(null)} className="text-muted-foreground hover:text-foreground">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                          {entry.baseModel && <p className="text-muted-foreground">Base: {entry.baseModel}</p>}
                          {entry.rank && <p className="text-muted-foreground">Rank: {entry.rank}</p>}
                          {entry.compatibleModes.length > 0 && (
                            <p className="text-muted-foreground">Modes: {entry.compatibleModes.join(", ")}</p>
                          )}
                          {entry.description && (
                            <p className="text-muted-foreground whitespace-pre-wrap border-t border-input/50 pt-1.5 mt-1.5">
                              {entry.description.slice(0, 1000)}
                            </p>
                          )}
                          {Object.keys(entry.meta).length > 0 && (
                            <div className="border-t border-input/50 pt-1.5 mt-1.5 space-y-0.5">
                              {Object.entries(entry.meta).map(([k, v]) => (
                                <p key={k} className="text-muted-foreground/70 truncate">
                                  <span className="font-medium">{k}:</span> {v}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLora(index)}
                    className="text-destructive/50 hover:text-destructive flex-shrink-0 p-0.5"
                    title="Remove LoRA"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Weight sliders */}
                {lora.enabled && lora.name && (
                  <div className="space-y-1.5 pl-1">
                    {/* Model strength */}
                    <div className="flex items-center gap-2">
                      <Label className="text-[10px] text-muted-foreground w-12 flex-shrink-0">Model</Label>
                      <Slider
                        min={-5}
                        max={5}
                        step={0.05}
                        value={[lora.strengthModel]}
                        onValueChange={([v]) => updateLora(index, { strengthModel: v })}
                        className="flex-1"
                      />
                      <DecimalInput
                        value={lora.strengthModel}
                        onChange={(v) => updateLora(index, { strengthModel: v })}
                        min={-5}
                        max={5}
                        decimals={2}
                        className="w-14 h-6 rounded border border-input bg-background px-1 text-center text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>

                    {/* Link button between sliders */}
                    <div className="flex items-center gap-2">
                      <div className="w-12" />
                      <button
                        type="button"
                        onClick={() => toggleLink(index)}
                        className={`text-[9px] flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                          isLinked
                            ? "text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        title={isLinked ? "Unlink model & clip weights" : "Link model & clip weights"}
                      >
                        {isLinked ? <Link className="w-3 h-3" /> : <Unlink className="w-3 h-3" />}
                        {isLinked ? "Linked" : "Unlinked"}
                      </button>
                    </div>

                    {/* Clip strength */}
                    <div className="flex items-center gap-2">
                      <Label className="text-[10px] text-muted-foreground w-12 flex-shrink-0">CLIP</Label>
                      <Slider
                        min={-5}
                        max={5}
                        step={0.05}
                        value={[lora.strengthClip]}
                        onValueChange={([v]) => updateLora(index, { strengthClip: v })}
                        className="flex-1"
                        disabled={isLinked}
                      />
                      <DecimalInput
                        value={lora.strengthClip}
                        onChange={(v) => updateLora(index, { strengthClip: v })}
                        min={-5}
                        max={5}
                        decimals={2}
                        disabled={isLinked}
                        className="w-14 h-6 rounded border border-input bg-background px-1 text-center text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {loras.length > 0 && loras.length < MAX_LORAS && (
            <button
              type="button"
              onClick={addLora}
              className="w-full rounded border border-dashed border-muted-foreground/20 py-1.5 text-[10px] text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition-colors"
            >
              + Add another LoRA ({loras.length}/{MAX_LORAS})
            </button>
          )}
        </CardContent>
      )}
    </Card>
  );
}
