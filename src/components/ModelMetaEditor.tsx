"use client";

// Inline editor for a single model's user-curated metadata + file rename.
// Reads/writes the sidecar via /api/model-meta and renames via /api/model-rename.
// Used by the Library for both LoRAs and checkpoints/functional models.

import { useCallback, useEffect, useState } from "react";
import { Star, X, Plus, Save, Pencil, Loader2, ImageOff, ImageDown, Lock, Link2, Info, Trash2 } from "lucide-react";
import type { ModelMeta } from "@/lib/model-meta-types";
import { EMPTY_MODEL_META } from "@/lib/model-meta-types";
import type { LibraryCategory } from "@/lib/library-categories-types";
import { mediaPreviewUrl, type GalleryMedia } from "@/lib/media-url";
import { useAllowOnline } from "@/hooks/useAllowOnline";

export default function ModelMetaEditor({
  path,
  displayName,
  autoCategory = "",
  categories = [],
  onRenamed,
  onMediaChanged,
}: {
  path: string;
  displayName: string;
  /** Auto-detected type label shown as the Category placeholder (the fallback). */
  autoCategory?: string;
  /** Custom categories, offered as a datalist for quick assignment. */
  categories?: LibraryCategory[];
  onRenamed?: (newPath: string, newName: string) => void;
  /** Called after previews are (re)fetched / removed so the parent can reload its media. */
  onMediaChanged?: () => void;
}) {
  const [meta, setMeta] = useState<ModelMeta>({ ...EMPTY_MODEL_META });
  const [previewPath, setPreviewPath] = useState("");
  const [media, setMedia] = useState<GalleryMedia[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [triggerInput, setTriggerInput] = useState("");
  const { allowOnline } = useAllowOnline();
  const [fetchingPreview, setFetchingPreview] = useState(false);
  const [versionUrl, setVersionUrl] = useState("");
  const [fetchingUrl, setFetchingUrl] = useState(false);

  const currentBase = displayName.replace(/\.[^.]+$/, "");
  const [renameValue, setRenameValue] = useState(currentBase);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/model-meta?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d?.ok) return;
        setMeta(d.meta);
        setPreviewPath(d.previewPath || "");
        setMedia(Array.isArray(d.media) ? d.media : []);
      })
      .catch(() => { /* leave defaults */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path]);

  /** Re-read the sidecar to refresh the preview thumbnail + media strip. */
  const reloadPreview = useCallback(async () => {
    try {
      const m = await fetch(`/api/model-meta?path=${encodeURIComponent(path)}`).then((x) => x.json());
      if (m?.ok) {
        setPreviewPath(m.previewPath || "");
        setMedia(Array.isArray(m.media) ? m.media : []);
      }
    } catch { /* keep current */ }
  }, [path]);

  /** Delete a single downloaded preview image/clip, then refresh. */
  const deletePreview = useCallback(async (mediaPath: string) => {
    try {
      const r = await fetch("/api/model-preview-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: mediaPath }),
      });
      const d = await r.json();
      if (d?.ok) {
        await reloadPreview();
        setStatus({ kind: "ok", text: "Preview removed" });
        onMediaChanged?.();
      } else {
        setStatus({ kind: "err", text: d?.error || "Remove failed" });
      }
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    }
  }, [reloadPreview, onMediaChanged]);

  const save = useCallback(async (patch: Partial<ModelMeta>, quiet = false) => {
    setSaving(true);
    setStatus(null);
    try {
      const r = await fetch("/api/model-meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, patch }),
      });
      const d = await r.json();
      if (d?.ok) {
        setMeta(d.meta);
        if (!quiet) setStatus({ kind: "ok", text: "Saved" });
      } else {
        setStatus({ kind: "err", text: d?.error || "Save failed" });
      }
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [path]);

  const toggleFavorite = () => save({ favorite: !meta.favorite }, true);

  // Fetch a preview image for JUST this model from CivitAI (hash lookup). Lets
  // the user scope individually instead of hashing an entire folder, important
  // for very large checkpoints.
  const fetchPreview = useCallback(async () => {
    setFetchingPreview(true);
    setStatus(null);
    try {
      const r = await fetch("/api/civitai-previews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const d = await r.json();
      if (r.ok && d?.ok && d.fetched > 0) {
        await reloadPreview(); // pick up the freshly written preview(s)
        setStatus({ kind: "ok", text: `Downloaded ${d.fetched} preview${d.fetched === 1 ? "" : "s"}` });
        onMediaChanged?.();
      } else if (r.ok && d?.ok) {
        setStatus({ kind: "ok", text: d.message || "No preview available" });
      } else {
        setStatus({ kind: "err", text: d?.error || "Fetch failed" });
      }
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    } finally {
      setFetchingPreview(false);
    }
  }, [path, reloadPreview, onMediaChanged]);

  // Fetch previews from a pasted CivitAI URL / model-version id. Skips hashing
  // entirely: the fast path for very large checkpoints.
  const fetchByUrl = useCallback(async (refOverride?: string) => {
    const url = (refOverride ?? versionUrl).trim();
    if (!url) return;
    setFetchingUrl(true);
    setStatus(null);
    try {
      const r = await fetch("/api/civitai-previews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, versionUrl: url, overwrite: true }),
      });
      const d = await r.json();
      if (r.ok && d?.ok && d.fetched > 0) {
        await reloadPreview(); // pick up the freshly written preview(s)
        setStatus({ kind: "ok", text: `Downloaded ${d.fetched} preview${d.fetched === 1 ? "" : "s"}` });
        setVersionUrl("");
        onMediaChanged?.();
      } else if (r.ok && d?.ok) {
        setStatus({ kind: "ok", text: d.message || "No preview available" });
      } else {
        setStatus({ kind: "err", text: d?.error || "Fetch failed" });
      }
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    } finally {
      setFetchingUrl(false);
    }
  }, [path, versionUrl, reloadPreview, onMediaChanged]);

  const addTrigger = () => {
    const t = triggerInput.trim();
    if (!t || meta.triggerWords.includes(t)) { setTriggerInput(""); return; }
    const next = [...meta.triggerWords, t];
    setMeta((m) => ({ ...m, triggerWords: next }));
    setTriggerInput("");
    save({ triggerWords: next }, true);
  };

  const removeTrigger = (t: string) => {
    const next = meta.triggerWords.filter((w) => w !== t);
    setMeta((m) => ({ ...m, triggerWords: next }));
    save({ triggerWords: next }, true);
  };

  const doRename = async () => {
    const base = renameValue.trim();
    if (!base || base === currentBase) return;
    setRenaming(true);
    setStatus(null);
    try {
      const r = await fetch("/api/model-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, newName: base }),
      });
      const d = await r.json();
      if (d?.ok) {
        setStatus({
          kind: "ok",
          text: `Renamed → ${d.newName}${d.refsUpdated ? ` · updated ${d.refsUpdated} reference${d.refsUpdated === 1 ? "" : "s"} in ${d.filesUpdated} config${d.filesUpdated === 1 ? "" : "s"}` : ""}`,
        });
        onRenamed?.(d.newPath, d.newName);
      } else {
        setStatus({ kind: "err", text: d?.error || "Rename failed" });
      }
    } catch (e) {
      setStatus({ kind: "err", text: (e as Error).message });
    } finally {
      setRenaming(false);
    }
  };

  if (loading) {
    return (
      <div className="mt-1.5 border-t border-border/50 pt-2 text-[10px] text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading details…
      </div>
    );
  }

  return (
    <div className="mt-1.5 border-t border-border/50 pt-2 space-y-2 text-[10px]">
      <div className="flex gap-2">
        {/* Preview thumbnail */}
        <div className="w-16 h-16 shrink-0 rounded border border-border/50 bg-muted/30 overflow-hidden flex items-center justify-center">
          {previewPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/model-preview?path=${encodeURIComponent(previewPath)}`} alt="preview" className="w-full h-full object-cover" />
          ) : (
            <ImageOff className="w-4 h-4 text-muted-foreground/50" />
          )}
        </div>

        {/* Individual CivitAI preview fetch (online-gated) */}
        <button
          type="button"
          onClick={fetchPreview}
          disabled={fetchingPreview || !allowOnline}
          title={allowOnline ? "Fetch this model's preview from CivitAI (hashes just this file)" : "Enable Network Access (Online) in Settings to use this"}
          className={`self-start inline-flex items-center gap-1 h-6 px-1.5 rounded border transition-colors ${
            !allowOnline
              ? "border-border/40 text-muted-foreground/60 cursor-not-allowed"
              : "border-sky-500/40 text-sky-300 hover:bg-sky-500/10"
          }`}
        >
          {fetchingPreview ? <Loader2 className="w-3 h-3 animate-spin" /> : !allowOnline ? <Lock className="w-3 h-3" /> : <ImageDown className="w-3 h-3" />}
          {previewPath ? "Refetch" : "Get preview"}
        </button>

        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Favorite + category */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleFavorite}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 border transition-colors ${meta.favorite ? "border-amber-400/50 bg-amber-400/10 text-amber-300" : "border-border/50 text-muted-foreground hover:text-foreground"}`}
              title="Favorite"
            >
              <Star className={`w-3 h-3 ${meta.favorite ? "fill-amber-300" : ""}`} /> {meta.favorite ? "Favorited" : "Favorite"}
            </button>
            <input
              value={meta.category}
              onChange={(e) => setMeta((m) => ({ ...m, category: e.target.value }))}
              onBlur={() => save({ category: meta.category }, true)}
              list="veksnap-category-options"
              placeholder={autoCategory ? `Category (auto: ${autoCategory})` : "Category override…"}
              title="Overrides the auto-detected type on the card badge & grouping. Leave blank to use the auto type."
              className="flex-1 h-6 rounded border border-input bg-background px-1.5 text-[10px]"
            />
            <datalist id="veksnap-category-options">
              {categories.map((c) => <option key={c.name} value={c.name} />)}
            </datalist>
          </div>

          {/* Trigger words */}
          <div>
            <div className="flex flex-wrap gap-1 mb-1">
              {meta.triggerWords.length === 0 && <span className="text-muted-foreground/60">No trigger words yet.</span>}
              {meta.triggerWords.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded bg-purple-500/15 text-purple-300 px-1.5 py-0.5">
                  {t}
                  <button type="button" onClick={() => removeTrigger(t)} className="hover:text-white" title="Remove">
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <input
                value={triggerInput}
                onChange={(e) => setTriggerInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTrigger(); } }}
                placeholder="Add trigger word…"
                className="flex-1 h-6 rounded border border-input bg-background px-1.5 text-[10px]"
              />
              <button type="button" onClick={addTrigger} className="inline-flex items-center gap-0.5 h-6 px-1.5 rounded border border-border/50 text-muted-foreground hover:text-foreground">
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Downloaded preview media: hover to remove any individual image/clip. */}
      {media.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-muted-foreground/70">Previews ({media.length})</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {media.map((m) => (
              <div key={m.path} className="relative group w-12 h-12 rounded border border-border/50 overflow-hidden bg-muted/30">
                {m.kind === "video" ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video src={mediaPreviewUrl(m.path)} muted className="w-full h-full object-cover" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaPreviewUrl(m.path)} alt="preview" className="w-full h-full object-cover" />
                )}
                <button
                  type="button"
                  onClick={() => deletePreview(m.path)}
                  title="Remove this preview from disk"
                  className="absolute top-0.5 right-0.5 rounded bg-black/60 p-0.5 text-white/80 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Preview fetch progress + how-it-works disclaimer */}
      {(fetchingPreview || fetchingUrl) && (
        <div className="h-1 w-full overflow-hidden rounded bg-muted/40">
          <div className="h-full w-1/3 rounded bg-sky-400/70 animate-[veksnap-indeterminate_1.1s_ease-in-out_infinite]" />
        </div>
      )}
      <div className="flex items-start gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 text-[9px] leading-relaxed text-muted-foreground/80 break-words">
        <Info className="w-3 h-3 shrink-0 mt-px text-sky-400/70" />
        <p className="min-w-0">
          <strong className="text-foreground/80">Get preview</strong> hashes this file, then downloads matching
          images/clips from CivitAI. Hashing multi-GB checkpoints can take a minute; to skip it, paste the
          model&rsquo;s CivitAI URL or version&nbsp;ID below.
        </p>
      </div>

      {/* Fetch by CivitAI URL / version-id (no hashing) */}
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Link2 className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          <input
            value={versionUrl}
            onChange={(e) => setVersionUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fetchByUrl(); } }}
            placeholder="CivitAI model URL or version ID…"
            disabled={!allowOnline}
            className="w-full h-6 rounded border border-input bg-background pl-7 pr-2 text-[10px] disabled:opacity-60"
          />
        </div>
        <button
          type="button"
          onClick={() => fetchByUrl()}
          disabled={fetchingUrl || !allowOnline || !versionUrl.trim()}
          title={allowOnline ? "Fetch previews from this CivitAI URL / version ID (no hashing)" : "Enable Network Access (Online) in Settings to use this"}
          className={`inline-flex items-center gap-1 h-6 px-1.5 rounded border transition-colors disabled:opacity-50 ${
            !allowOnline ? "border-border/40 text-muted-foreground/60 cursor-not-allowed" : "border-sky-500/40 text-sky-300 hover:bg-sky-500/10"
          }`}
        >
          {fetchingUrl ? <Loader2 className="w-3 h-3 animate-spin" /> : !allowOnline ? <Lock className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
          Fetch
        </button>
      </div>

      {/* Persisted CivitAI link: survives restarts; re-fetch needs no hashing/URL. */}
      {meta.civitaiVersionId > 0 && (
        <div className="flex items-center gap-1.5 text-[9px] text-emerald-300/80">
          <Link2 className="w-3 h-3 shrink-0" />
          <span className="truncate">
            Linked to CivitAI version&nbsp;#{meta.civitaiVersionId}
            {meta.civitaiModelId > 0 && <> · model&nbsp;#{meta.civitaiModelId}</>}
          </span>
          <button
            type="button"
            onClick={() => fetchByUrl(String(meta.civitaiVersionId))}
            disabled={fetchingUrl || !allowOnline}
            title="Re-fetch previews using the saved link (no hashing)"
            className="ml-auto shrink-0 rounded border border-emerald-500/40 px-1.5 py-0.5 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
          >
            Re-fetch
          </button>
        </div>
      )}

      {/* Notes */}
      <textarea
        value={meta.notes}
        onChange={(e) => setMeta((m) => ({ ...m, notes: e.target.value }))}
        onBlur={() => save({ notes: meta.notes }, true)}
        placeholder="Notes…"
        rows={2}
        className="w-full rounded border border-input bg-background px-1.5 py-1 text-[10px] resize-y"
      />

      {/* Rename */}
      <div className="flex items-center gap-1">
        <Pencil className="w-3 h-3 text-muted-foreground shrink-0" />
        <input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          className="flex-1 h-6 rounded border border-input bg-background px-1.5 text-[10px] font-mono"
        />
        <button
          type="button"
          onClick={doRename}
          disabled={renaming || !renameValue.trim() || renameValue.trim() === currentBase}
          className="inline-flex items-center gap-1 h-6 px-2 rounded border border-border/50 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {renaming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Rename
        </button>
      </div>

      {status && (
        <p className={`text-[9px] ${status.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
          {saving ? "Saving…" : status.text}
        </p>
      )}
    </div>
  );
}
