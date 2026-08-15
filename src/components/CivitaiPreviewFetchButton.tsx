"use client";

// ─────────────────────────────────────────────────────────────────────────────
// "Fetch preview images from CivitAI" batch action for the Library.
//
// Online-gated: disabled (with a lock + tip) unless Allow Online is enabled.
// Kicks off /api/civitai-previews for a given scope (LoRAs or checkpoints),
// shows live-ish progress feedback, and reports a summary. Since the route skips
// files that already have a preview, pressing it again safely resumes where it
// left off (useful for very large folders that hit the per-run cap).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useState } from "react";
import { ImageDown, Loader2, Lock, CheckCircle2 } from "lucide-react";
import { useAllowOnline } from "@/hooks/useAllowOnline";

const KIND_LABEL: Record<"loras" | "checkpoints", string> = {
  checkpoints: "checkpoint",
  loras: "LoRA",
};

interface Summary {
  fetched: number;
  skipped: number;
  notFound: number;
  processed: number;
  remaining: number;
  usedApiKey: boolean;
}

export default function CivitaiPreviewFetchButton({
  kind,
  onDone,
}: {
  kind: "loras" | "checkpoints";
  onDone?: () => void;
}) {
  const { allowOnline, loading } = useAllowOnline();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When on, re-hash files that already have a preview and replace their media
  // (useful when a model's CivitAI gallery has changed). Off = skip known files
  // for efficiency, which is the default resume-friendly behaviour.
  const [overwrite, setOverwrite] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/civitai-previews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, overwrite }),
      });
      const d = await r.json();
      if (!r.ok || d?.ok === false) {
        setError(d?.error || "Fetch failed");
      } else {
        setSummary(d as Summary);
        if (d.fetched > 0) onDone?.();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [kind, overwrite, onDone]);

  const disabled = loading || busy || !allowOnline;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={run}
        disabled={disabled}
        title={allowOnline ? "Download preview images from CivitAI (by file hash)" : "Enable Network Access (Online) in Settings to use this"}
        className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium border transition-colors ${
          !allowOnline
            ? "border-border/40 text-muted-foreground/60 cursor-not-allowed"
            : "border-sky-500/40 text-sky-300 hover:bg-sky-500/10"
        }`}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : !allowOnline ? <Lock className="w-3.5 h-3.5" /> : <ImageDown className="w-3.5 h-3.5" />}
        {busy ? `Fetching ${KIND_LABEL[kind]} previews…` : `Fetch all ${KIND_LABEL[kind]} previews (CivitAI)`}
      </button>

      {allowOnline && (
        <label className="inline-flex items-center gap-1.5 text-[9px] text-muted-foreground/80 select-none cursor-pointer pl-0.5">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            disabled={busy}
            className="h-3 w-3 accent-sky-400"
          />
          Check &amp; override existing (re-fetch files that already have previews)
        </label>
      )}

      {!allowOnline && !loading && (
        <p className="text-[9px] text-amber-400/80">Requires Network Access (Online): enable it in the Settings menu.</p>
      )}

      {error && <p className="text-[9px] text-red-400">{error}</p>}

      {summary && !busy && (
        <p className="text-[9px] text-muted-foreground inline-flex flex-wrap items-center gap-x-2">
          <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 className="w-3 h-3" /> {summary.fetched} fetched</span>
          <span>{summary.skipped} already had one</span>
          <span>{summary.notFound} not on CivitAI</span>
          {summary.remaining > 0 && <span className="text-sky-300">· {summary.remaining} left, run again to continue</span>}
          {!summary.usedApiKey && <span className="text-muted-foreground/60">· keyless</span>}
        </p>
      )}
    </div>
  );
}
