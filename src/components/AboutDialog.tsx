"use client";

// ─────────────────────────────────────────────────────────────────────────────
// About dialog: product identity, version, and a concise description of the
// application. Shown from the Settings menu ("About Vek-Snap™").
// ─────────────────────────────────────────────────────────────────────────────

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
const COMPANY = "Squishy Code AI LLC";
const YEAR = new Date().getFullYear();

export default function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-fuchsia-500/30 to-sky-500/20 ring-1 ring-fuchsia-500/40">
              <Sparkles className="h-5 w-5 text-fuchsia-300" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base leading-tight">
                Vek-Snap<span className="align-super text-[0.6em]">™</span>
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                Version {APP_VERSION} · a product of {COMPANY}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Vek-Snap is an offline-first AI creative studio for generating and
            editing images, video, and audio on your own machine. It unifies
            text-to-image and image-to-video generation, voice conversion and
            expressive speech, LoRA training, restoration and upscaling, and a
            multi-track timeline editor. Everything lives in one polished
            workspace.
          </p>
          <p>
            Your models, prompts, and outputs stay local by default: generation
            runs against a bundled ComfyUI engine with no account and no cloud
            round-trip required.
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Vek-Snap™ is a trademark of {COMPANY}. © {YEAR} {COMPANY}. All
            rights reserved.
          </p>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
