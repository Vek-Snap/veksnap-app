"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Controls slot: a context-driven portal target for the modern shell's
// right-hand dock.
//
// The modern shell (studio-v2/page.tsx) hosts ONE context-sensitive "Workflow
// Controls" tab beside "System". A studio rendered in the center (e.g. Continuum
// / DirectorStudio) can project its heavy control surface INTO that tab without
// lifting its state: it wraps the controls in <WorkflowControls>…</WorkflowControls>,
// which portals them into the shell-provided slot element and reports occupancy so
// the shell can show an empty state on pages that don't use it.
//
// The consumer effect depends ONLY on the (stable) `setHasControls` setter, never
// on the whole context value, so a changing slot element cannot cause a render loop.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface WorkflowControlsSlotValue {
  /** The DOM node in the right-dock "Workflow Controls" tab to portal into. */
  slot: HTMLElement | null;
  /** Report whether the active studio is currently providing controls. */
  setHasControls: (has: boolean) => void;
}

export const WorkflowControlsSlotContext = createContext<WorkflowControlsSlotValue | null>(null);

/**
 * Wrap a studio's control surface in this to render it inside the shell's
 * "Workflow Controls" tab. Renders nothing if used outside the modern shell or
 * before the slot mounts.
 */
export function WorkflowControls({ children }: { children: ReactNode }) {
  const ctx = useContext(WorkflowControlsSlotContext);
  const setHasControls = ctx?.setHasControls;

  useEffect(() => {
    if (!setHasControls) return;
    setHasControls(true);
    return () => setHasControls(false);
  }, [setHasControls]);

  // Fallback: outside the modern shell (e.g. the classic UI, which has no provider)
  // or while the right dock is collapsed (slot not mounted), render INLINE so the
  // controls are never lost. When the slot exists, project them into the dock.
  if (!ctx || !ctx.slot) return <>{children}</>;
  return createPortal(children, ctx.slot);
}
