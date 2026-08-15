"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Output Metadata controls: shared between the Quick Settings dropdown and the
// main Settings page. Three privacy-sensitive toggles (all default OFF):
//   • Basic authorship tags   • Full ComfyUI workflow   • Compact summary
//
// Enabling any option while the privacy warning hasn't been dismissed opens a
// warning dialog with "Proceed" and a persistent "Don't show this again" opt-out.
// State lives server-side (/api/settings) so the embedding backend can read it.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FileText, Braces, ListChecks, ShieldAlert, type LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  type OutputMetaFlags,
  type OutputMetaKey,
  OUTPUT_META_DEFAULTS,
  loadOutputFlags,
  setOutputFlag,
  isPrivacyWarningAcked,
  setPrivacyWarningAcked,
} from "@/lib/output-metadata";

export const OUTPUT_META_ITEMS: {
  key: OutputMetaKey;
  label: string;
  short: string;
  desc: string;
  Icon: LucideIcon;
}[] = [
  {
    key: "outputEmbedBasic",
    label: "Basic metadata",
    short: "Made-by / made-with tags",
    desc: "Adds standard authorship tags (Software: Vek-Snap, Author, Comment) to every image, video and audio file: the kind of tag most creative apps write.",
    Icon: FileText,
  },
  {
    key: "outputEmbedWorkflow",
    label: "Full ComfyUI workflow",
    short: "Embed the whole graph + prompt",
    desc: "Embeds the complete ComfyUI workflow and prompt JSON inside each output so it can be re-opened and reproduced in ComfyUI. This reveals your full prompt and settings to anyone you share the file with.",
    Icon: Braces,
  },
  {
    key: "outputEmbedSummary",
    label: "Generation summary",
    short: "Model, LoRAs & seed only",
    desc: "Embeds only a compact note: the model, any LoRA(s) with their strengths, and the seed. Minimal, but enough to reproduce the result.",
    Icon: ListChecks,
  },
];

// ── Privacy warning dialog ───────────────────────────────────────────────────
function PrivacyDialog({
  open,
  onOpenChange,
  neverAgain,
  setNeverAgain,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  neverAgain: boolean;
  setNeverAgain: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); onOpenChange(v); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-amber-400" /> Privacy exposure risk
          </DialogTitle>
          <DialogDescription>
            Embedding data in your files can expose private details (your prompts, model choices,
            LoRAs and seeds) to anyone you share or publish them with. Vek-Snap keeps this OFF by
            default. Enable only if you understand the risk (or actually want the data).
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={neverAgain}
            onChange={(e) => setNeverAgain(e.target.checked)}
            className="accent-sky-500 w-3.5 h-3.5"
          />
          Don&apos;t show this warning again (I understand the risk)
        </label>
        <DialogFooter className="gap-3 sm:gap-3">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm}>Proceed</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared state + privacy gating for the three output-metadata toggles. Returns
 * the current values, a `toggle(key)` action, and a `dialog` node the consumer
 * renders once (portalled, so placement doesn't matter).
 */
export function useOutputMetadata() {
  const [values, setValues] = useState<OutputMetaFlags>(OUTPUT_META_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<OutputMetaKey | null>(null);
  const [neverAgain, setNeverAgain] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOutputFlags().then((v) => { if (!cancelled) { setValues(v); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const apply = useCallback(async (key: OutputMetaKey, next: boolean) => {
    setValues((prev) => ({ ...prev, [key]: next }));
    const ok = await setOutputFlag(key, next);
    if (!ok) setValues((prev) => ({ ...prev, [key]: !next })); // revert on write failure
  }, []);

  const toggle = useCallback((key: OutputMetaKey) => {
    const next = !values[key];
    // Turning ON is the sensitive direction; warn unless already acknowledged.
    if (next && !isPrivacyWarningAcked()) { setNeverAgain(false); setPending(key); return; }
    void apply(key, next);
  }, [values, apply]);

  const confirmPending = useCallback(() => {
    if (neverAgain) setPrivacyWarningAcked(true);
    if (pending) void apply(pending, true);
    setPending(null);
  }, [pending, neverAgain, apply]);

  const dialog: ReactNode = (
    <PrivacyDialog
      open={pending !== null}
      onOpenChange={(v) => { if (!v) setPending(null); }}
      neverAgain={neverAgain}
      setNeverAgain={setNeverAgain}
      onConfirm={confirmPending}
      onCancel={() => setPending(null)}
    />
  );

  return { values, loading, toggle, dialog };
}

/**
 * Panel variant (main Settings page): full descriptions + Switch per option.
 */
export function OutputMetadataPanel({ className = "" }: { className?: string }) {
  const { values, toggle, dialog } = useOutputMetadata();
  return (
    <div className={className}>
      <div className="space-y-2">
        {OUTPUT_META_ITEMS.map(({ key, label, desc, Icon }) => (
          <div
            key={key}
            className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5"
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <Icon className="w-4 h-4 mt-0.5 shrink-0 text-sky-400" />
              <div className="min-w-0">
                <div className="text-sm font-medium leading-tight">{label}</div>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{desc}</p>
              </div>
            </div>
            <Switch checked={values[key]} onCheckedChange={() => toggle(key)} className="mt-0.5 shrink-0" />
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground/70 mt-2 flex items-center gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5 text-amber-400/80" />
        All three are OFF by default. Nothing is written to your files unless you enable it.
      </p>
      {dialog}
    </div>
  );
}

/**
 * Menu variant (Quick Settings dropdown): compact rows that DON'T close the
 * dropdown on toggle (plain elements, not DropdownMenuItem).
 */
export function OutputMetadataMenuSection() {
  const { values, toggle, dialog } = useOutputMetadata();
  return (
    <>
      {OUTPUT_META_ITEMS.map(({ key, label, short, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(key); }}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm hover:bg-foreground/10 transition-colors text-left"
        >
          <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="flex flex-col min-w-0">
            <span className="truncate">{label}</span>
            <span className="text-[10px] text-muted-foreground/70 truncate">{short}</span>
          </span>
          <Switch checked={values[key]} onCheckedChange={() => toggle(key)} className="ml-auto shrink-0 scale-90" />
        </button>
      ))}
      {dialog}
    </>
  );
}
