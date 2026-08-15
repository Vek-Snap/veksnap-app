"use client";

// ─────────────────────────────────────────────────────────────────────────────
// CivitAI API Key dialog.
//
// Lets the user store an optional CivitAI API key used ONLY for preview-image and
// trigger-word lookups, and ONLY when Allow Online is enabled. The key is written
// to the local settings store and is never returned to the client afterwards
// (the settings GET redacts it and only reports whether one is set).
//
// A prominent warning makes the privacy trade-off clear: this feature reaches
// out to civitai.com, so the offline privacy shield must be opened to use it.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeyRound, ShieldAlert, Loader2, CheckCircle2, Trash2 } from "lucide-react";

interface CivitaiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function CivitaiKeyDialog({ open, onOpenChange }: CivitaiKeyDialogProps) {
  const [keySet, setKeySet] = useState(false);
  const [allowOnline, setAllowOnline] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue("");
    setSaved(false);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => { setKeySet(!!s.civitaiApiKeySet); setAllowOnline(!!s.allowOnline); })
      .catch(() => {});
  }, [open]);

  const save = async (newValue: string) => {
    setBusy(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "civitaiApiKey", value: newValue }),
      });
      setKeySet(newValue.length > 0);
      setValue("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* ignore */ }
    setBusy(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500/30 to-indigo-500/20 ring-1 ring-sky-500/40">
              <KeyRound className="h-5 w-5 text-sky-300" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base leading-tight">CivitAI API Key</DialogTitle>
              <p className="text-xs text-muted-foreground">
                Optional · powers preview-image &amp; trigger-word lookups
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* Privacy warning banner */}
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-200/90">
          <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
          <p>
            This feature contacts <span className="font-medium">civitai.com</span>. Vek-Snap is
            offline-first: to use it you must fully <span className="font-medium">open the
            privacy shield</span> by enabling <span className="font-medium">Network Access
            (Online)</span> in this menu. The key is stored locally and never leaves your machine
            except in requests you initiate to CivitAI.
            {!allowOnline && (
              <span className="mt-1 block font-semibold text-amber-300">
                Network Access is currently OFF: enable it for lookups to work.
              </span>
            )}
          </p>
        </div>

        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Status:{" "}
            {keySet
              ? <span className="text-emerald-400 font-medium">A key is configured.</span>
              : <span className="text-muted-foreground">No key set (keyless, public content only).</span>}
          </p>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={keySet ? "Enter a new key to replace…" : "Paste your CivitAI API key…"}
            autoComplete="off"
            spellCheck={false}
            className="w-full h-9 rounded-md border border-input bg-background px-2.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <p className="text-[10px] text-muted-foreground/70">
            Get a key at civitai.com → Account Settings → API Keys. Keyless still works for most
            public models; a key raises rate limits and reaches gated content.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {keySet && (
              <Button
                variant="ghost"
                onClick={() => save("")}
                disabled={busy}
                className="text-red-400 hover:text-red-300"
              >
                <Trash2 className="w-4 h-4" /> Clear key
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saved && <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Saved</span>}
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            <Button onClick={() => save(value.trim())} disabled={busy || !value.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />} Save key
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
