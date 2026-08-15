"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Studio V2: "System Panels" settings dialog.
//
// Lets the user choose which monitoring / control panels appear in the Modern
// layout's right-side hardware dock. Each toggle writes to the reactive
// panel-settings store (localStorage-backed), so the dock updates live and the
// choice persists across launches. Grouped by concern; includes a Reset action.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from "react";
import { SlidersHorizontal, RotateCcw } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  PANEL_DEFS,
  usePanelSettings,
  setPanelVisible,
  resetPanels,
  type PanelDef,
} from "@/lib/panel-settings";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SystemPanelsDialog({ open, onOpenChange }: Props) {
  const panels = usePanelSettings();

  // Group the defs for display, preserving PANEL_DEFS order within each group.
  const groups = useMemo(() => {
    const map = new Map<PanelDef["group"], PanelDef[]>();
    for (const def of PANEL_DEFS) {
      const list = map.get(def.group) ?? [];
      list.push(def);
      map.set(def.group, list);
    }
    return Array.from(map.entries());
  }, []);

  const enabledCount = PANEL_DEFS.filter((d) => panels[d.id]).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-violet-400" />
            System Panels
          </DialogTitle>
          <DialogDescription>
            Choose which monitoring and control panels appear in the right-side
            system dock. Hidden panels stop updating, so turning off what you
            don&apos;t use keeps the app lean.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {groups.map(([group, defs]) => (
            <div key={group} className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
                {group}
              </p>
              <div className="rounded-lg border border-border/60 divide-y divide-border/40">
                {defs.map((def) => (
                  <label
                    key={def.id}
                    htmlFor={`panel-${def.id}`}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 cursor-pointer hover:bg-foreground/[0.03] transition-colors"
                  >
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium">{def.label}</span>
                      <span className="block text-[10px] text-muted-foreground leading-snug">
                        {def.description}
                      </span>
                    </span>
                    <Switch
                      id={`panel-${def.id}`}
                      checked={panels[def.id]}
                      onCheckedChange={(v) => setPanelVisible(def.id, v)}
                      className="shrink-0"
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-muted-foreground">
            {enabledCount} of {PANEL_DEFS.length} panels shown
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-[11px] h-7 gap-1 text-muted-foreground hover:text-foreground"
            onClick={resetPanels}
          >
            <RotateCcw className="w-3 h-3" />
            Show all
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
