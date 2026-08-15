"use client";

import { useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// PointerEventsGuard: safety net for a known Radix UI quirk where closing a
// Dialog / DropdownMenu / Popover (especially in quick succession) can leave
// `document.body { pointer-events: none }` behind. That makes the whole app
// unclickable: you can still paste via the right-click menu, but you cannot focus
// inputs by clicking (this is the "can't type a new category name" report).
//
// This clears a STALE body pointer-events:none, and ONLY when no Radix overlay
// is actually open, so it never interferes with a legitimately open dialog/menu.
// ─────────────────────────────────────────────────────────────────────────────

const OVERLAY_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  "[data-radix-menu-content][data-state=\"open\"]",
].join(",");

export default function PointerEventsGuard() {
  useEffect(() => {
    const clearIfStale = () => {
      if (document.body.style.pointerEvents !== "none") return;
      // A real overlay is open, Radix is legitimately blocking the background.
      if (document.querySelector(OVERLAY_SELECTOR)) return;
      document.body.style.pointerEvents = "";
    };

    // 1) When the user tries to interact (the reported symptom), fix it first so
    //    the very next click lands.
    const onPointerDown = () => clearIfStale();
    document.addEventListener("pointerdown", onPointerDown, true);

    // 2) React to body style changes; defer so Radix has finished mounting /
    //    unmounting its overlay before we decide whether the state is stale.
    const obs = new MutationObserver(() => window.setTimeout(clearIfStale, 0));
    obs.observe(document.body, { attributes: true, attributeFilter: ["style"] });

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      obs.disconnect();
    };
  }, []);

  return null;
}
