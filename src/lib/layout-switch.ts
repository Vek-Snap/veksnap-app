"use client";

// ── Intentional classic <-> modern layout switch ────────────────────────────
//
// The classic UI installs a `beforeunload` guard (see src/app/page.tsx) that
// cancels navigation while there are unsaved changes. In the Electron shell a
// cancelled `beforeunload` SILENTLY blocks programmatic `window.location`
// changes (no prompt is shown), so the "Modern Layout" toggle appeared dead
// until the user ran "Fresh Start" to clear the dirty state, the exact symptom
// reported on deployed machines.
//
// Auto-save (src/hooks/useAutoSave.ts) already persists the current work,
// including uploaded-resource references, on every `beforeunload`. A layout
// switch is therefore SAFE even while "dirty": the hard reload tears the shell
// down cleanly and the other shell restores state from the saved snapshot.
//
// So an explicit layout switch must BYPASS the blocking guard. We flip a module
// flag the guard checks, then hard-navigate. The module unloads on navigation,
// so the flag never needs resetting.
let switchingLayout = false;

/** True while an intentional layout switch is navigating away. The classic
 *  page's `beforeunload` guard checks this so it never cancels the switch. */
export function isSwitchingLayout(): boolean {
  return switchingLayout;
}

/** Hard-navigate between the classic ("/") and modern ("/studio-v2") shells,
 *  bypassing the unsaved-changes navigation guard (auto-save preserves work). */
export function switchLayout(href: string): void {
  switchingLayout = true;
  window.location.href = href;
}
