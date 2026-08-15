"use client";

import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "veksnap-recent-files";
const ENABLED_KEY = "veksnap-recent-files-enabled";
const MAX_RECENT = 8;

export interface RecentFile {
  name: string;
  path: string;
  timestamp: number;
}

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [enabled, setEnabledRaw] = useState(true);

  // Load on mount
  useEffect(() => {
    try {
      const enabledRaw = localStorage.getItem(ENABLED_KEY);
      if (enabledRaw === "false") { setEnabledRaw(false); return; }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setRecentFiles(JSON.parse(raw));
    } catch {}
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledRaw(v);
    try { localStorage.setItem(ENABLED_KEY, String(v)); } catch {}
    if (!v) {
      setRecentFiles([]);
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }
  }, []);

  const addRecentFile = useCallback((name: string, path: string) => {
    setRecentFiles((prev) => {
      const filtered = prev.filter((f) => f.name !== name);
      const updated = [{ name, path, timestamp: Date.now() }, ...filtered].slice(0, MAX_RECENT);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  }, []);

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }, []);

  return { recentFiles: enabled ? recentFiles : [], addRecentFile: enabled ? addRecentFile : () => {}, clearRecentFiles, enabled, setEnabled };
}
