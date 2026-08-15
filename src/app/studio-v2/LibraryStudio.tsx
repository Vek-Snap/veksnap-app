"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LibraryStudio: the Modern-UI "front page" / home surface.
//
// Surfaces the two things users reach for constantly and that were previously
// buried inside per-studio dropdowns:
//   - LoRA Library: the classifier catalog (/api/lora-scan), colour-coded by
//                     model type, with the rainbow scan action + the CivitAI
//                     trigger-word scanner.
//   - Model Library: installed checkpoints (getCheckpoints), with lightweight
//                     filename-based type badges + a rescan.
//
// v1 / iterate: this is a first cut so the layout can be judged in situ. It
// reuses existing APIs/components rather than introducing new backends.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScanLine, RefreshCw, Search, Repeat, Loader2, LibraryBig, LayoutGrid, Info, Palette, Trash2, Plus, HardDrive, Eye, EyeOff, ArrowUpDown, KeyRound, ImagePlus } from "lucide-react";
import type { ModelScanResult } from "@/lib/model-scan-types";
import LoRATriggerScanner from "@/components/LoRATriggerScanner";
import ModelMetaEditor from "@/components/ModelMetaEditor";
import CivitaiPreviewFetchButton from "@/components/CivitaiPreviewFetchButton";
import CivitaiKeyDialog from "@/components/CivitaiKeyDialog";
import ModelCard, { type CardEntry, type CardAction } from "@/components/ModelCard";
import { formatBytes, type GalleryMedia, type ModelDetails } from "@/lib/media-url";
import { type LibraryCategory, DEFAULT_CATEGORY_COLOR } from "@/lib/library-categories-types";
import { useVideoWallAutoplay } from "@/lib/use-video-wall-autoplay";
import { WorkflowControls } from "@/components/WorkflowControlsSlot";

/** The model the user has selected to view in the center gallery. */
export interface LibrarySelection {
  path: string;
  name: string;
}

// Colour palette shared with LoraSelector's classifier badges.
const TYPE_COLORS: Record<string, { text: string; bg: string; label: string }> = {
  ltx2:         { text: "text-violet-300", bg: "bg-violet-500/15", label: "LTX-2" },
  ltx2_distill: { text: "text-violet-200", bg: "bg-violet-500/10", label: "LTX-2 Distill" },
  ltx2_motion:  { text: "text-cyan-300",   bg: "bg-cyan-500/15",   label: "Motion" },
  wan:          { text: "text-amber-300",  bg: "bg-amber-500/15",  label: "WAN" },
  sdxl:         { text: "text-blue-300",   bg: "bg-blue-500/15",   label: "SDXL" },
  sd15:         { text: "text-sky-300",    bg: "bg-sky-500/15",    label: "SD 1.5" },
  flux:         { text: "text-orange-300", bg: "bg-orange-500/15", label: "Flux" },
  zimage:       { text: "text-teal-300",   bg: "bg-teal-500/15",   label: "Z-Image" },
  acestep:      { text: "text-pink-300",   bg: "bg-pink-500/15",   label: "AceStep" },
  unknown:      { text: "text-muted-foreground", bg: "bg-muted/40", label: "?" },
};

interface LoraCatalogEntry {
  name: string;
  path: string;
  modelType: string;
  compatibleModes: string[];
  title: string;
  description: string;
  baseModel: string;
  rank: number | null;
}

// Lightweight, filename-based checkpoint classifier (no multi-GB metadata read).
function classifyCheckpoint(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("flux")) return "flux";
  if (n.includes("z-image") || n.includes("zimage") || n.includes("turbo") || n.includes("zit")) return "zimage";
  if (n.includes("sdxl") || n.includes("xl") || n.includes("pony") || n.includes("illustrious") || n.includes("noob")) return "sdxl";
  if (n.includes("sd15") || n.includes("sd1.5") || n.includes("v1-5") || n.includes("1_5")) return "sd15";
  if (n.includes("ltx")) return "ltx2";
  if (n.includes("wan")) return "wan";
  return "unknown";
}

function baseName(p: string) {
  return p.split(/[\\/]/).pop() || p;
}

// ── Data hooks ───────────────────────────────────────────────────────────────

function useLoraCatalog() {
  const [catalog, setCatalog] = useState<LoraCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    refresh ? setScanning(true) : setLoading(true);
    try {
      const res = await fetch(`/api/lora-scan${refresh ? "?refresh=1" : ""}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.catalog) setCatalog(data.catalog as LoraCatalogEntry[]);
      }
    } catch { /* non-critical */ }
    refresh ? setScanning(false) : setLoading(false);
  }, []);

  useEffect(() => { load(false); }, [load]);
  return { catalog, loading, scanning, load };
}

// ── Model Library ────────────────────────────────────────────────────────────

const FUNCTIONAL_LABELS: Record<string, string> = {
  vae: "VAE",
  upscale_models: "Upscaler",
  latent_upscale_models: "Latent Upscaler",
  clip: "CLIP",
  clip_vision: "CLIP Vision",
  text_encoders: "Text Encoder",
  controlnet: "ControlNet",
  ipadapter: "IP-Adapter",
  embeddings: "Embedding",
  facerestore_models: "Face Restore",
  sams: "SAM",
  sam2: "SAM2",
  audio_encoders: "Audio Encoder",
  model_patches: "Model Patch",
  style_models: "Style Model",
  gligen: "GLIGEN",
  photomaker: "PhotoMaker",
};

function useModelScan() {
  const [result, setResult] = useState<ModelScanResult>({ generative: [], functional: [] });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/model-scan");
      if (res.ok) {
        const d = await res.json();
        setResult({ generative: d.generative ?? [], functional: d.functional ?? [] });
      }
    } catch { setResult({ generative: [], functional: [] }); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  return { result, loading, load };
}

// ── Card helpers ─────────────────────────────────────────────────────────────

type BadgeInfo = { text: string; bg: string; label: string };

function loraBadge(t: string): BadgeInfo { return TYPE_COLORS[t] ?? TYPE_COLORS.unknown; }
function checkpointBadge(name: string): BadgeInfo { return TYPE_COLORS[classifyCheckpoint(name)] ?? TYPE_COLORS.unknown; }
function functionalBadge(subKey: string): BadgeInfo {
  return { text: "text-slate-300", bg: "bg-slate-500/15", label: FUNCTIONAL_LABELS[subKey] ?? subKey };
}

/** A catalog card plus the group label it renders under + sort keys. */
interface CatCard extends CardEntry {
  group: string;
  sizeBytes: number;
  mtimeMs: number;
}

type SortMode = "type" | "name-asc" | "name-desc" | "newest" | "largest" | "media";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "type", label: "By type / category" },
  { value: "name-asc", label: "Name (A to Z)" },
  { value: "name-desc", label: "Name (Z to A)" },
  { value: "newest", label: "Newest (file date)" },
  { value: "largest", label: "Largest (file size)" },
  { value: "media", label: "Has previews first" },
];

// Pinned view controls: column count (card size) + details overlay, persisted.
const COLS_KEY = "veksnap-library-cols";
const DETAILS_KEY = "veksnap-library-details";
const PRIVACY_KEY = "veksnap-library-privacy";
const HIDDEN_KEY = "veksnap-library-hidden";
const COL_OPTIONS = [3, 4, 5, 6, 8];

function sortCards(cards: CatCard[], mode: SortMode): CatCard[] {
  const copy = [...cards];
  switch (mode) {
    case "name-asc": copy.sort((a, b) => a.name.localeCompare(b.name)); break;
    case "name-desc": copy.sort((a, b) => b.name.localeCompare(a.name)); break;
    case "newest": copy.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name)); break;
    case "largest": copy.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name)); break;
    case "media": copy.sort((a, b) => (b.media.length > 0 ? 1 : 0) - (a.media.length > 0 ? 1 : 0) || a.name.localeCompare(b.name)); break;
    default: copy.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  }
  return copy;
}

// ── Custom categories (app-global store) ─────────────────────────────────────

function useLibraryCategories() {
  const [categories, setCategories] = useState<LibraryCategory[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/library-categories");
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d?.categories)) setCategories(d.categories as LibraryCategory[]);
      }
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upsert = useCallback(async (name: string, color: string) => {
    const r = await fetch("/api/library-categories", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "upsert", name, color }),
    });
    const d = await r.json();
    if (d?.ok && Array.isArray(d.categories)) setCategories(d.categories);
    return d?.ok as boolean;
  }, []);

  const remove = useCallback(async (name: string) => {
    const r = await fetch("/api/library-categories", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name }),
    });
    const d = await r.json();
    if (d?.ok && Array.isArray(d.categories)) setCategories(d.categories);
    return d?.ok as boolean;
  }, []);

  return { categories, load, upsert, remove };
}

// ── Front page ───────────────────────────────────────────────────────────────
//
// Center = a CivitAI-style card grid of the whole catalog. Models are grouped by
// type, a divider separates them, then LoRAs follow. Each card is a self-contained
// mini-carousel (arrows + dots) that plays its clips under the living-wall cycler.
// Right = every control (search, sort, scan, CivitAI fetch, autoplay, and the
// selected item's metadata editor), projected into the shared Workflow Controls.

export default function LibraryStudio() {
  const lora = useLoraCatalog();
  const models = useModelScan();
  const [mediaMap, setMediaMap] = useState<Record<string, GalleryMedia[]>>({});
  const [detailsMap, setDetailsMap] = useState<Record<string, ModelDetails>>({});
  const [selected, setSelected] = useState<LibrarySelection | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("type");
  // CivitAI API key dialog: lives here (the Library is the only place it applies),
  // moved out of the global quick menu.
  const [civitaiKeyOpen, setCivitaiKeyOpen] = useState(false);
  // "Assign Custom": a user-picked image/clip applied as a model's preview media.
  const assignInputRef = useRef<HTMLInputElement>(null);
  const [assignTarget, setAssignTarget] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const cats = useLibraryCategories();

  // Master Privacy toggle, when on, cards flagged with a Privacy mask are blurred.
  const [privacyOn, setPrivacyOn] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem(PRIVACY_KEY) === "1");
  useEffect(() => { try { localStorage.setItem(PRIVACY_KEY, privacyOn ? "1" : "0"); } catch { /* ignore */ } }, [privacyOn]);

  // "Remove from list" hides paths locally without touching disk (persisted).
  const [hidden, setHidden] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]") as string[]); } catch { return new Set(); }
  });
  useEffect(() => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* ignore */ } }, [hidden]);

  // New-category form (color defaults to the palette's sky; picker allows any hex).
  const [newCatName, setNewCatName] = useState("");
  const [newCatColor, setNewCatColor] = useState<string>(DEFAULT_CATEGORY_COLOR);

  // Pinned view state: how many columns (-> card size) and whether the per-card
  // details strip is shown. Both persist across reloads.
  const [cols, setCols] = useState<number>(() => {
    if (typeof window === "undefined") return 5;
    const v = parseInt(localStorage.getItem(COLS_KEY) || "", 10);
    return v >= 2 && v <= 10 ? v : 5;
  });
  const [showDetails, setShowDetails] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem(DETAILS_KEY) === "1");
  useEffect(() => { try { localStorage.setItem(COLS_KEY, String(cols)); } catch { /* ignore */ } }, [cols]);
  useEffect(() => { try { localStorage.setItem(DETAILS_KEY, showDetails ? "1" : "0"); } catch { /* ignore */ } }, [showDetails]);

  // Every catalog path, so we can fetch all preview media in one batched call.
  const allPaths = useMemo(() => {
    const p: string[] = [];
    for (const e of models.result.generative) p.push(e.path);
    for (const e of models.result.functional) p.push(e.path);
    for (const e of lora.catalog) p.push(e.path);
    return p;
  }, [models.result, lora.catalog]);

  const loadMedia = useCallback(async (paths: string[]) => {
    if (paths.length === 0) { setMediaMap({}); setDetailsMap({}); return; }
    try {
      const r = await fetch("/api/model-media-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      const d = await r.json();
      if (d?.ok && d.media) setMediaMap(d.media as Record<string, GalleryMedia[]>);
      if (d?.ok && d.details) setDetailsMap(d.details as Record<string, ModelDetails>);
    } catch { /* leave existing media in place */ }
  }, []);

  useEffect(() => { void loadMedia(allPaths); }, [allPaths, loadMedia]);
  const refreshMedia = useCallback(() => { void loadMedia(allPaths); }, [loadMedia, allPaths]);

  const q = query.trim().toLowerCase();
  const matches = useCallback((name: string) => !q || name.toLowerCase().includes(q), [q]);

  // Custom-category colour lookup (case-insensitive).
  const catColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cats.categories) m.set(c.name.toLowerCase(), c.color);
    return m;
  }, [cats.categories]);

  // Build a card from its auto-detected badge, applying the sidecar category
  // override (which drives BOTH the badge label and the group) and the sidecar's
  // size / date / mosaic / favorite. A custom category name lends its colour.
  const buildCard = useCallback((path: string, name: string, autoBadge: BadgeInfo): CatCard => {
    const det = detailsMap[path];
    const override = (det?.category ?? "").trim();
    let badge: CardEntry["badge"] = autoBadge;
    let group = autoBadge.label;
    if (override) {
      badge = { text: autoBadge.text, bg: autoBadge.bg, label: override, color: catColor.get(override.toLowerCase()) };
      group = override;
    }
    return {
      path, name: baseName(name), badge, media: mediaMap[path] ?? [], group,
      sizeBytes: det?.sizeBytes ?? 0, mtimeMs: det?.mtimeMs ?? 0,
      mosaic: det?.mosaic ?? false, favorite: det?.favorite ?? false,
    };
  }, [detailsMap, mediaMap, catColor]);

  const visible = useCallback((path: string, name: string) => matches(name) && !hidden.has(path), [matches, hidden]);

  // Auto-detected type label for a path (the fallback when no category override is
  // set): used to prefill the editor's Category field placeholder.
  const autoCategoryFor = useCallback((path: string): string => {
    const gen = models.result.generative.find((e) => e.path === path);
    if (gen) return checkpointBadge(gen.name).label;
    const fn = models.result.functional.find((e) => e.path === path);
    if (fn) return functionalBadge(fn.subKey).label;
    const lo = lora.catalog.find((e) => e.path === path);
    if (lo) return loraBadge(lo.modelType).label;
    return "";
  }, [models.result, lora.catalog]);

  const genCards = useMemo<CatCard[]>(() => sortCards(
    models.result.generative.filter((e) => visible(e.path, e.name)).map((e) => buildCard(e.path, e.name, checkpointBadge(e.name))),
    sort), [models.result.generative, buildCard, visible, sort]);

  const funcCards = useMemo<CatCard[]>(() => sortCards(
    models.result.functional.filter((e) => visible(e.path, e.name)).map((e) => buildCard(e.path, e.name, functionalBadge(e.subKey))),
    sort), [models.result.functional, buildCard, visible, sort]);

  const loraCards = useMemo<CatCard[]>(() => sortCards(
    lora.catalog.filter((e) => visible(e.path, e.name)).map((e) => buildCard(e.path, e.name, loraBadge(e.modelType))),
    sort), [lora.catalog, buildCard, visible, sort]);

  // Flat order = the order cards are laid out, so autoplay indices line up.
  const allCards = useMemo(() => [...genCards, ...funcCards, ...loraCards], [genCards, funcCards, loraCards]);
  const videoIndices = useMemo(
    () => allCards.map((c, i) => (c.media.some((m) => m.kind === "video") ? i : -1)).filter((i) => i >= 0),
    [allCards],
  );
  const { config, setConfig, isActive } = useVideoWallAutoplay(videoIndices);

  const busy = models.loading || lora.loading;
  const totalModels = models.result.generative.length + models.result.functional.length;
  const hasVideos = videoIndices.length > 0;
  // Group headers only make sense when sorting by type/category.
  const grouped = sort === "type";

  // Per-category disk utilisation (bytes) across everything currently listed,
  // plus a grand total. Uses each card's effective group + its file size.
  const diskByGroup = useMemo(() => {
    const totals = new Map<string, number>();
    let grand = 0;
    for (const c of allCards) {
      totals.set(c.group, (totals.get(c.group) ?? 0) + c.sizeBytes);
      grand += c.sizeBytes;
    }
    const rows = [...totals.entries()].map(([group, bytes]) => ({ group, bytes })).sort((a, b) => b.bytes - a.bytes);
    return { rows, grand };
  }, [allCards]);

  // ── Right-click action handler: owns the endpoints for every card action. ──
  const handleCardAction = useCallback(async (path: string, name: string, action: CardAction) => {
    const patchMeta = async (patch: Record<string, unknown>) => {
      await fetch("/api/model-meta", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, patch }),
      }).catch(() => {});
      refreshMedia();
    };
    switch (action.type) {
      case "openExplorer":
        await fetch("/api/open-in-explorer", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        }).catch(() => {});
        break;
      case "setCategory": await patchMeta({ category: action.category }); break;
      case "clearCategory": await patchMeta({ category: "" }); break;
      case "toggleMosaic": await patchMeta({ mosaic: !(detailsMap[path]?.mosaic ?? false) }); break;
      case "favorite": await patchMeta({ favorite: !(detailsMap[path]?.favorite ?? false) }); break;
      case "fetchPreview":
        await fetch("/api/civitai-previews", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, overwrite: true }),
        }).catch(() => {});
        refreshMedia();
        break;
      case "assignCustom":
        setAssignTarget(path);
        requestAnimationFrame(() => assignInputRef.current?.click());
        break;
      case "removeFromList":
        setHidden((prev) => new Set(prev).add(path));
        if (selected?.path === path) setSelected(null);
        break;
      case "deleteFromDisk": {
        const ok = window.confirm(
          `Permanently DELETE FROM DISK:\n\n${name}\n\nThis removes the model file, its metadata sidecar, and all downloaded previews. This cannot be undone.\n\nClick OK to delete, or Cancel to keep the file.`,
        );
        if (!ok) break;
        const r = await fetch("/api/model-delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, mode: "disk" }),
        }).then((x) => x.json()).catch(() => null);
        if (r?.ok) {
          if (selected?.path === path) setSelected(null);
          void models.load();
          void lora.load(true);
          refreshMedia();
        } else {
          window.alert(`Delete failed: ${r?.error || "unknown error"}`);
        }
        break;
      }
    }
  }, [detailsMap, refreshMedia, selected, models, lora]);

  // Upload the chosen file and save it next to the target model as preview media.
  const onAssignFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    const target = assignTarget;
    if (!f || !target) return;
    setAssigning(true);
    try {
      const fd = new FormData();
      fd.append("path", target);
      fd.append("file", f);
      const r = await fetch("/api/assign-preview", { method: "POST", body: fd });
      const d = await r.json().catch(() => null);
      if (!r.ok || d?.ok === false) window.alert(`Assign failed: ${d?.error || "unknown error"}`);
    } catch (err) {
      window.alert(`Assign failed: ${(err as Error).message}`);
    }
    setAssigning(false);
    refreshMedia();
  }, [assignTarget, refreshMedia]);

  // Renders a run of cards with a full-width subheader whenever the group changes.
  const renderCards = (cards: CatCard[], baseIndex: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let lastGroup = "";
    cards.forEach((c, i) => {
      if (grouped && c.group !== lastGroup) {
        out.push(
          <div key={`h-${baseIndex}-${i}`} className="col-span-full mt-1 mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {c.group}
          </div>,
        );
        lastGroup = c.group;
      }
      const flat = baseIndex + i;
      out.push(
        <ModelCard
          key={c.path}
          entry={c}
          active={isActive(flat)}
          selected={selected?.path === c.path}
          onSelect={() => setSelected({ path: c.path, name: c.name })}
          showDetails={showDetails}
          details={detailsMap[c.path]}
          categories={cats.categories}
          privacyOn={privacyOn}
          onAction={(a) => void handleCardAction(c.path, c.name, a)}
        />,
      );
    });
    return out;
  };

  const gridStyle = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
  const nothingFound = !busy && allCards.length === 0;

  return (
    <>
      {/* Hidden picker for "Assign Custom" preview media (image or short clip). */}
      <input
        ref={assignInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={onAssignFile}
      />
      {/* CENTER: the CivitAI-style catalog wall */}
      <div className="h-full flex flex-col min-h-0">
        <header className="flex items-center gap-2 mb-3">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/40">
            <LibraryBig className="w-4 h-4" />
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold leading-tight">Library</h2>
            <p className="text-[10px] text-muted-foreground leading-tight">
              {totalModels} models · {lora.catalog.length} LoRAs
              {busy && <span className="ml-1 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> loading...</span>}
            </p>
          </div>
        </header>

        {/* Pinned view toolbar: column count (card size) + details toggle.
            Lives outside the scroll container so it is never lost on scroll. */}
        <div className="flex items-center gap-2 mb-2 shrink-0">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/40 p-0.5" title="Columns (card size)">
            <LayoutGrid className="w-3.5 h-3.5 text-muted-foreground mx-1" />
            {COL_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCols(n)}
                className={`h-6 w-6 rounded text-[11px] font-medium transition-colors ${
                  cols === n ? "bg-sky-500/20 text-sky-300" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            title="Show file size & CivitAI ids on each card"
            className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium border transition-colors ${
              showDetails ? "border-sky-500/50 bg-sky-500/10 text-sky-300" : "border-border/60 text-muted-foreground hover:text-foreground"
            }`}
          >
            <Info className="w-3.5 h-3.5" /> Details
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-1">
          {nothingFound ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground/70">
              <LibraryBig className="w-8 h-8 text-muted-foreground/40" />
              <p className="text-[12px]">No models or LoRAs found. Add folders in System Settings → Model Paths, then Scan on the right.</p>
            </div>
          ) : (
            <>
              {(genCards.length > 0 || funcCards.length > 0) && (
                <section className="mb-4">
                  <h3 className="text-[11px] font-semibold text-foreground/80 mb-1.5">Models</h3>
                  <div className="grid gap-3" style={gridStyle}>
                    {renderCards(genCards, 0)}
                    {renderCards(funcCards, genCards.length)}
                  </div>
                </section>
              )}

              {loraCards.length > 0 && (genCards.length > 0 || funcCards.length > 0) && (
                <div className="border-t border-border/60 my-4" />
              )}

              {loraCards.length > 0 && (
                <section>
                  <h3 className="text-[11px] font-semibold text-foreground/80 mb-1.5">LoRAs</h3>
                  <div className="grid gap-3" style={gridStyle}>
                    {renderCards(loraCards, genCards.length + funcCards.length)}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {/* RIGHT: all controls, portalled into the Workflow Controls dock */}
      <WorkflowControls>
        <div className="space-y-4">
          {/* Search + sort */}
          <section className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models & LoRAs..."
                className="w-full h-8 rounded-md border border-input bg-background pl-7 pr-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="flex items-center gap-2">
              <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <label className="text-[10px] text-muted-foreground">Sort by</label>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
                className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            {/* Privacy Control master toggle, blurs every card flagged with a mask. */}
            <button
              type="button"
              onClick={() => setPrivacyOn((v) => !v)}
              title="Blur all cards you've flagged with a Privacy mask (right-click a card → Apply Privacy mask)"
              className={`w-full inline-flex items-center justify-between gap-2 h-8 px-2.5 rounded-md border text-[11px] font-medium transition-colors ${
                privacyOn ? "border-sky-500/50 bg-sky-500/10 text-sky-300" : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="inline-flex items-center gap-1.5">
                {privacyOn ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                Privacy Control
              </span>
              <span className="text-[9px] opacity-80">{privacyOn ? "Masks ON" : "Masks OFF"}</span>
            </button>
          </section>

          {/* Categories: custom taxonomy + colour + per-category disk utilisation */}
          <section className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <Palette className="w-3.5 h-3.5 text-sky-300" />
              <h3 className="text-[12px] font-semibold">Categories &amp; disk usage</h3>
            </div>

            {/* Create a category (name + colour wheel) */}
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={newCatColor}
                onChange={(e) => setNewCatColor(e.target.value)}
                title="Pick a colour"
                className="h-8 w-8 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
              />
              <input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newCatName.trim()) { void cats.upsert(newCatName.trim(), newCatColor); setNewCatName(""); } }}
                placeholder="New category name…"
                className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="button"
                disabled={!newCatName.trim()}
                onClick={() => { void cats.upsert(newCatName.trim(), newCatColor); setNewCatName(""); }}
                className="inline-flex items-center gap-1 h-8 px-2 rounded-md border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 text-[11px] disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" /> Add
              </button>
            </div>

            {/* Existing categories with delete */}
            {cats.categories.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {cats.categories.map((c) => (
                  <span key={c.name} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 pl-1.5 pr-1 py-0.5 text-[10px]">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c.color }} />
                    <span className="truncate max-w-[110px]">{c.name}</span>
                    <button
                      type="button"
                      onClick={() => void cats.remove(c.name)}
                      title="Delete category (does not change any model files)"
                      className="text-muted-foreground/70 hover:text-red-400"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Disk utilisation per group + grand total */}
            <div className="space-y-0.5 pt-1 border-t border-border/50">
              {diskByGroup.rows.map((r) => (
                <div key={r.group} className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="truncate">{r.group}</span>
                  <span className="font-mono tabular-nums">{formatBytes(r.bytes)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between text-[10px] font-semibold text-foreground/90 pt-0.5">
                <span className="inline-flex items-center gap-1"><HardDrive className="w-3 h-3" /> Total</span>
                <span className="font-mono tabular-nums">{formatBytes(diskByGroup.grand)}</span>
              </div>
            </div>

            {hidden.size > 0 && (
              <button
                type="button"
                onClick={() => setHidden(new Set())}
                className="w-full h-7 rounded-md border border-border/60 text-[10px] text-muted-foreground hover:text-foreground"
              >
                Restore {hidden.size} hidden {hidden.size === 1 ? "item" : "items"}
              </button>
            )}
          </section>

          {/* Autoplay cycle */}
          {hasVideos && (
            <section className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Repeat className="w-3.5 h-3.5 text-sky-300" />
                  <h3 className="text-[12px] font-semibold">Auto-play clips</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setConfig({ enabled: !config.enabled })}
                  className={`h-6 px-2 rounded border text-[10px] transition-colors ${
                    config.enabled ? "border-sky-500/50 bg-sky-500/10 text-sky-300" : "border-border/50 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {config.enabled ? "On" : "Off"}
                </button>
              </div>
              {config.enabled && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/80">
                  <label className="inline-flex items-center gap-1">
                    Play
                    <select
                      value={config.concurrent}
                      onChange={(e) => setConfig({ concurrent: parseInt(e.target.value, 10) })}
                      className="h-6 rounded border border-border/50 bg-background px-1 text-[10px]"
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                    </select>
                    at once
                  </label>
                  <label className="inline-flex items-center gap-1">
                    every
                    <select
                      value={config.seconds}
                      onChange={(e) => setConfig({ seconds: parseInt(e.target.value, 10) })}
                      className="h-6 rounded border border-border/50 bg-background px-1 text-[10px]"
                    >
                      <option value={3}>3s</option>
                      <option value={4}>4s</option>
                      <option value={6}>6s</option>
                      <option value={8}>8s</option>
                      <option value={12}>12s</option>
                    </select>
                  </label>
                </div>
              )}
            </section>
          )}

          {/* Selected item editor */}
          {selected && (
            <section className="rounded-xl border border-border/60 bg-card/40 p-3">
              <h3 className="text-[12px] font-semibold mb-1 truncate" title={selected.name}>Selected: {baseName(selected.name)}</h3>
              <ModelMetaEditor
                path={selected.path}
                displayName={baseName(selected.name)}
                autoCategory={autoCategoryFor(selected.path)}
                categories={cats.categories}
                onRenamed={(newPath, newName) => { setSelected({ path: newPath, name: newName }); refreshMedia(); }}
                onMediaChanged={refreshMedia}
              />
            </section>
          )}

          {/* Scan + fetch controls */}
          <section className="rounded-xl border border-border/60 bg-card/40 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => models.load()}
                disabled={models.loading}
                title="Rescan model directories"
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-medium border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${models.loading ? "animate-spin" : ""}`} /> Rescan models
              </button>
              <button
                type="button"
                onClick={() => lora.load(true)}
                disabled={lora.scanning}
                title="Scan & classify LoRAs"
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-medium border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-60"
              >
                {lora.scanning ? <span className="veksnap-scan-rainbow w-3.5 h-3.5" aria-hidden /> : <ScanLine className="w-3.5 h-3.5" />} Scan LoRAs
              </button>
            </div>

            <div className="space-y-2">
              <CivitaiPreviewFetchButton kind="checkpoints" onDone={() => { void models.load(); refreshMedia(); }} />
              <CivitaiPreviewFetchButton kind="loras" onDone={() => { void lora.load(true); refreshMedia(); }} />
              {/* Assign Custom: apply your OWN image/clip to the selected model. */}
              <button
                type="button"
                onClick={() => {
                  if (!selected) { window.alert("Select a model card first, then click Assign Custom to apply your own image or clip."); return; }
                  setAssignTarget(selected.path);
                  requestAnimationFrame(() => assignInputRef.current?.click());
                }}
                disabled={assigning}
                title={selected ? `Apply your own image or clip to ${baseName(selected.name)}` : "Select a model first, then assign your own image or clip"}
                className="w-full inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium border border-fuchsia-500/40 text-fuchsia-300 hover:bg-fuchsia-500/10 transition-colors disabled:opacity-60"
              >
                {assigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
                {assigning ? "Assigning…" : "Assign Custom"}
              </button>
            </div>
          </section>

          {/* CivitAI trigger-word scanner */}
          <section className="rounded-xl border border-border/60 bg-card/40 p-3">
            <LoRATriggerScanner />
          </section>

          {/* CivitAI API key: bottom-most control. Applies only to the Library's
              online fetches, so it lives here rather than the global quick menu. */}
          <section className="rounded-xl border border-border/60 bg-card/40 p-3">
            <button
              type="button"
              onClick={() => setCivitaiKeyOpen(true)}
              title="Set your CivitAI API key for higher rate limits and access to gated content"
              className="w-full inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-medium border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5" /> CivitAI API Key…
            </button>
          </section>

          <CivitaiKeyDialog open={civitaiKeyOpen} onOpenChange={setCivitaiKeyOpen} />
        </div>
      </WorkflowControls>
    </>
  );
}
