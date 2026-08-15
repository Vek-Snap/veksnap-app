const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onMaximizedChange: (callback) => {
    ipcRenderer.on("window-maximized-changed", (_event, value) => callback(value));
  },
  setUnsavedChanges: (value) => ipcRenderer.send("unsaved-changes", !!value),
  confirmClose: () => ipcRenderer.send("close-confirmed"),
  onConfirmClose: (callback) => {
    ipcRenderer.on("confirm-close", (_event, hasUnsaved) => {
      // Run the app's dialog handler FIRST, then ack. The ack cancels main's
      // safety-net force-close timer, so it must only fire once the renderer
      // has actually taken ownership of showing the dialog. If callback throws
      // (or the renderer is dead/hung) the ack never sends and main force-closes
      // instead of leaving the window stuck open with no dialog.
      callback(hasUnsaved);
      try { ipcRenderer.send("confirm-close-ack"); } catch { /* ignore */ }
    });
  },
  setMinimizeToTray: (value) => ipcRenderer.send("set-minimize-to-tray", !!value),
  setSpellcheck: (enabled) => ipcRenderer.send("set-spellcheck", !!enabled),
  // ── Accessibility: program-wide display zoom ──
  // Rescales the layout viewport (unlike CSS zoom), so content reflows and never
  // gets clipped by the fixed-size app shell. Renderer-side webFrame is used
  // directly; no main-process round-trip needed.
  setZoomFactor: (factor) => { try { webFrame.setZoomFactor(Number(factor) || 1); } catch { /* ignore */ } },
  // ── Temp-file cleanup ──
  tempScan: () => ipcRenderer.invoke("temp:scan"),
  tempClear: (ids) => ipcRenderer.invoke("temp:clear", ids),
  getClearTempOnExit: () => ipcRenderer.invoke("temp:getClearOnExit"),
  setClearTempOnExit: (value) => ipcRenderer.invoke("temp:setClearOnExit", !!value),
  // ── VLAP: per-launch local-API credential (Vek-Snap Local Access Protocol) ──
  // The renderer's fetch wrapper uses this to sign state-changing /api calls so
  // the local server can distinguish trusted-UI traffic from a malicious web
  // page. Delivered over IPC only, never exposed on the HTTP surface.
  getApiCredential: () => ipcRenderer.invoke("vlap:getCredential"),
  // ── Native folder picker (Model Paths "Browse" button) ──
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder"),
  // ── Native Save dialog + file write (Save / Save & Quit; resolves after write) ──
  saveFile: (opts) => ipcRenderer.invoke("dialog:saveFile", opts),
});
