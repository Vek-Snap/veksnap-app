"use client";

// Small client hook to read the app's "Allow Online" setting so UI can gate any
// feature that reaches the internet (e.g. live CivitAI trigger-word lookups).
// Vek-Snap is offline-first: this defaults to false and only flips true once the
// user explicitly enables online mode in Settings.

import { useEffect, useState } from "react";

// Custom event any Network-Access toggle dispatches after persisting the new
// value, so already-mounted gated features update WITHOUT an app restart.
export const ALLOW_ONLINE_EVENT = "veksnap:allowOnline-changed";

export function useAllowOnline(): { allowOnline: boolean; loading: boolean } {
  const [allowOnline, setAllowOnline] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/settings")
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => { if (alive && s) setAllowOnline(!!s.allowOnline); })
        .catch(() => { /* offline / no settings → stay gated */ })
        .finally(() => { if (alive) setLoading(false); });
    };
    load();
    // Re-read when the setting is toggled elsewhere (custom event) or when the
    // window regains focus, so enabling Online mode unlocks features live.
    window.addEventListener(ALLOW_ONLINE_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener(ALLOW_ONLINE_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, []);

  return { allowOnline, loading };
}
