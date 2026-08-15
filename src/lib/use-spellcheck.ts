"use client";

import { useState, useEffect, useCallback } from "react";

const SPELLCHECK_KEY = "veksnap-spellcheck";

// Shared hook for the global spellcheck preference. Default: OFF (privacy-first,
// the check runs via Electron's native, fully-offline Windows spellchecker, but
// we leave it disabled unless the user opts in). Enabling flips the webContents
// spellchecker on session-wide, so every editable field (all the large prompt
// textareas included) gets red-underline suggestions; nothing leaves the machine.
// Mirrors `use-autoplay` so classic + modern menus stay in sync on the same key.
export function useSpellcheck(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabledRaw] = useState(false);

  // Hydrate from storage and push the persisted value to the main process so the
  // session reflects the preference even when only the modern menu is mounted.
  useEffect(() => {
    let initial = false;
    try { initial = localStorage.getItem(SPELLCHECK_KEY) === "true"; } catch {}
    setEnabledRaw(initial);
    try { window.electronAPI?.setSpellcheck(initial); } catch {}
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledRaw(v);
    try { localStorage.setItem(SPELLCHECK_KEY, String(v)); } catch {}
    try { window.electronAPI?.setSpellcheck(v); } catch {}
    // Sync other mounted instances of the hook.
    window.dispatchEvent(new StorageEvent("storage", { key: SPELLCHECK_KEY, newValue: String(v) }));
  }, []);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === SPELLCHECK_KEY) setEnabledRaw(e.newValue === "true");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return [enabled, setEnabled];
}
