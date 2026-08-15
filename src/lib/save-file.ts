// Shared "save a JSON file to disk" helper.
//
// In the packaged Electron app it uses the `save-file` IPC (native Save dialog +
// synchronous fs write in the main process) and RESOLVES ONLY AFTER the file is
// actually written, so callers can safely gate app-exit on save completion
// (fixes the bug where Save & Quit terminated mid-dialog).
//
// In the browser (dev on F, no Electron bridge) it falls back to an anchor
// download, which resolves immediately (the browser owns the Save dialog and
// gives us no completion signal, acceptable for dev).

const stripEphemeralUrls = (_k: string, v: unknown): unknown =>
  typeof v === "string" && (v.startsWith("blob:") || v.startsWith("data:")) ? "" : v;

/**
 * Serialize `data` to pretty JSON (dropping ephemeral blob:/data: URLs) and save
 * it. Returns true if written, false if the user cancelled the native dialog.
 */
export async function saveJsonFile(defaultName: string, data: unknown): Promise<boolean> {
  const json = JSON.stringify(data, stripEphemeralUrls, 2);
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;

  if (api?.saveFile) {
    try {
      const res = await api.saveFile({ defaultName, contents: json });
      return !!res && !res.canceled;
    } catch {
      return false;
    }
  }

  // Browser fallback (dev): anchor download.
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
