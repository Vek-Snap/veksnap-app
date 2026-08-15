/** Electron window control API exposed via preload.js contextBridge */
interface ElectronAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => void;
  setUnsavedChanges: (value: boolean) => void;
  confirmClose: () => void;
  onConfirmClose: (callback: (hasUnsaved: boolean) => void) => void;
  setMinimizeToTray: (value: boolean) => void;
  setSpellcheck: (enabled: boolean) => void;
  /**
   * Accessibility: set the program-wide display zoom. Rescales the layout
   * viewport (reflows, no clipping). Optional so the browser (dev) build
   * type-checks without it: the UI falls back to CSS zoom there.
   */
  setZoomFactor?: (factor: number) => void;
  /**
   * Show a native Save dialog and write `contents` to the chosen path. Resolves
   * ONLY after the file is written (or the user cancels). Implemented by the
   * main process (`save-file` IPC): lets callers gate app-exit on save
   * completion. Optional so the browser (dev) build type-checks without it.
   */
  saveFile?: (opts: { defaultName: string; contents: string }) => Promise<{ path?: string; canceled?: boolean }>;
  // ── Temp-file cleanup ──
  tempScan: () => Promise<{ categories: TempCategory[]; clearAllIds: string[] }>;
  tempClear: (ids: string[]) => Promise<{ cleared: { id: string; freedBytes: number }[] }>;
  getClearTempOnExit: () => Promise<boolean>;
  setClearTempOnExit: (value: boolean) => Promise<boolean>;
  // ── Native folder picker (Model Paths "Browse" button) ──
  pickFolder: () => Promise<string | null>;
}

declare global {
  /** A single clearable temp-file category reported by the main process. */
  interface TempCategory {
    id: string;
    label: string;
    description: string;
    protected: boolean;
    bytes: number;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
