"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Search, X, Info } from "lucide-react";

/**
 * LoraSelect: drop-in replacement for native <select> with LoRA catalog
 * integration. Shows color-coded type badges, greys out incompatible LoRAs,
 * and provides an info popover for metadata / usage notes.
 *
 * Designed to replace every <select> in LTX2Studio, DirectorStudio,
 * AudioForVideo, WanS2VStudio, etc.
 */

// ── Catalog types ──

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
  ltx2_distill: { text: "text-violet-300",  label: "Distill" },
  ltx2_motion:  { text: "text-cyan-400",    label: "Motion" },
  wan:          { text: "text-amber-400",   label: "WAN" },
  sdxl:         { text: "text-blue-400",    label: "SDXL" },
  sd15:         { text: "text-sky-400",     label: "SD1.5" },
  zimage:       { text: "text-teal-400",    label: "ZImg" },
  acestep:      { text: "text-pink-400",    label: "AceStep" },
  unknown:      { text: "text-muted-foreground",    label: "?" },
};

// ── Shared catalog singleton (fetched once, shared across all instances) ──

let _catalogPromise: Promise<Map<string, LoraCatalogEntry>> | null = null;
let _catalogMap: Map<string, LoraCatalogEntry> = new Map();
let _catalogAge = 0;
const CACHE_TTL = 300_000; // 5 min

function fetchCatalog(force = false): Promise<Map<string, LoraCatalogEntry>> {
  if (!force && _catalogPromise && Date.now() - _catalogAge < CACHE_TTL) {
    return _catalogPromise;
  }
  _catalogAge = Date.now();
  _catalogPromise = fetch(`/api/lora-scan${force ? "?refresh=1" : ""}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.catalog) {
        const map = new Map<string, LoraCatalogEntry>();
        for (const entry of data.catalog) map.set(entry.name, entry);
        _catalogMap = map;
        return map;
      }
      return _catalogMap;
    })
    .catch(() => _catalogMap);
  return _catalogPromise;
}

// ── Props ──

interface LoraSelectProps {
  value: string;
  options: string[];
  onChange: (name: string) => void;
  disabled?: boolean;
  /** Current generation mode: used for compatibility filtering */
  compatMode?: string;
  className?: string;
  placeholder?: string;
}

export default function LoraSelect({
  value,
  options,
  onChange,
  disabled,
  compatMode,
  className,
  placeholder = "Select LoRA...",
}: LoraSelectProps) {
  const [catalog, setCatalog] = useState<Map<string, LoraCatalogEntry>>(_catalogMap);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [infoName, setInfoName] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load catalog once
  useEffect(() => {
    fetchCatalog().then(setCatalog);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setInfoName(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isCompat = useCallback(
    (name: string) => {
      if (!compatMode) return true;
      const entry = catalog.get(name);
      if (!entry) return true;
      if (entry.compatibleModes.length === 0) return true;
      return entry.compatibleModes.includes(compatMode);
    },
    [compatMode, catalog]
  );

  const getType = (name: string) => {
    const entry = catalog.get(name);
    return TYPE_COLORS[entry?.modelType || "unknown"] || TYPE_COLORS.unknown;
  };

  // Filter & sort
  const filtered = (() => {
    let list = options;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((n) => n.toLowerCase().includes(q));
    }
    if (compatMode && catalog.size > 0) {
      list = [...list].sort((a, b) => {
        const aOk = isCompat(a) ? 0 : 1;
        const bOk = isCompat(b) ? 0 : 1;
        return aOk - bOk;
      });
    }
    return list;
  })();

  // Current entry display
  const currentEntry = value ? catalog.get(value) : null;
  const currentType = value ? getType(value) : null;

  return (
    <div ref={wrapRef} className={`relative ${className || "flex-1"}`}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => {
          if (!disabled) {
            setOpen(!open);
            setSearch("");
            setTimeout(() => inputRef.current?.focus(), 50);
          }
        }}
        disabled={disabled}
        className={`w-full h-7 rounded border border-input bg-background px-2 text-[11px] text-left truncate flex items-center gap-1.5 disabled:opacity-50 ${
          open ? "ring-1 ring-ring" : ""
        }`}
      >
        {currentEntry && (
          <span className={`text-[8px] font-medium ${currentType?.text} flex-shrink-0`}>
            {currentType?.label}
          </span>
        )}
        <span className={`truncate ${value ? "" : "text-muted-foreground"}`}>
          {value || placeholder}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded border border-input bg-background shadow-lg">
          {/* Search input */}
          <div className="relative px-1.5 py-1 border-b border-input/50">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full h-6 rounded bg-muted/30 pl-6 pr-6 text-[10px] focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Legend */}
          {catalog.size > 0 && (
            <div className="px-2 py-0.5 text-[8px] text-muted-foreground/60 border-b border-input/30 flex items-center gap-1.5 flex-wrap">
              {Object.entries(TYPE_COLORS)
                .filter(([k]) => k !== "unknown")
                .map(([k, v]) => (
                  <span key={k} className={v.text}>{v.label}</span>
                ))}
            </div>
          )}

          {/* Options */}
          <div className="max-h-96 overflow-y-auto">
            {/* Empty option */}
            <button
              type="button"
              onClick={() => { onChange(""); setOpen(false); }}
              className="w-full text-left px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
            >
              {placeholder}
            </button>

            {filtered.length === 0 && (
              <div className="px-2 py-1.5 text-[10px] text-muted-foreground">No matches</div>
            )}

            {filtered.map((name) => {
              const compat = isCompat(name);
              const typeInfo = getType(name);
              const entry = catalog.get(name);
              const baseName = name.split(/[\\/]/).pop() || name;
              const hasInfo = entry && (entry.description || entry.title !== baseName);

              return (
                <div
                  key={name}
                  className={`flex items-center gap-1 px-1.5 py-1 hover:bg-accent group ${
                    name === value ? "bg-accent/50 font-medium" : ""
                  } ${!compat ? "opacity-35" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => { onChange(name); setOpen(false); setInfoName(null); }}
                    className="flex items-center gap-1.5 flex-1 min-w-0 text-left text-[11px]"
                  >
                    {entry && (
                      <span className={`text-[8px] font-medium ${typeInfo.text} flex-shrink-0 w-9 text-center`}>
                        {typeInfo.label}
                      </span>
                    )}
                    <span className="truncate">{name}</span>
                  </button>
                  {hasInfo && (
                    <button
                      type="button"
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground p-0.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        setInfoName(infoName === name ? null : name);
                      }}
                    >
                      <Info className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Info popover */}
      {infoName && catalog.has(infoName) && open && (() => {
        const entry = catalog.get(infoName)!;
        const typeInfo = getType(infoName);
        return (
          <div className="absolute z-[60] mt-1 right-0 w-72 max-h-60 overflow-y-auto rounded border border-input bg-background shadow-xl p-2.5 text-[10px] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className={`font-medium ${typeInfo.text}`}>
                {entry.title || entry.name}
              </span>
              <button type="button" onClick={() => setInfoName(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-3 h-3" />
              </button>
            </div>
            {entry.baseModel && <p className="text-muted-foreground">Base: {entry.baseModel}</p>}
            {entry.rank != null && <p className="text-muted-foreground">Rank: {entry.rank}</p>}
            {entry.compatibleModes.length > 0 && (
              <p className="text-muted-foreground">Modes: {entry.compatibleModes.join(", ")}</p>
            )}
            {entry.description && (
              <p className="text-muted-foreground whitespace-pre-wrap border-t border-input/50 pt-1.5 mt-1.5">
                {entry.description.slice(0, 800)}
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
  );
}

/** Hook to trigger a catalog rescan from anywhere (e.g. a "Scan LoRAs" button) */
export function refreshLoraCatalog() {
  return fetchCatalog(true);
}
