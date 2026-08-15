import path from "path";
import fs from "fs";

// ─────────────────────────────────────────────────────────────────────────────
// Scratch directory: single source of truth for ALL ephemeral, user-content
// working files produced by the Next.js API routes (rendered frame previews,
// timeline export staging, segmentation input/mask images, audio-analysis JSON,
// video-restore probe staging, …).
//
// PRIVACY RULE: never write user content to the shared OS temp dir
// (`os.tmpdir()`), which is world-readable and shared by every app on the
// machine. Everything lands under the Vek-Snap install directory instead:
//
//     <install>/Temp/<sub>
//
// where `<install>` is `INSTALL_ROOT`: the parent of `veksnap-app/`
// (`path.resolve(process.cwd(), "..")`, the same convention every director/*
// route uses). This keeps private content self-contained and lets the in-app
// "Clear Temporary Files" cleaner wipe it (see the `appScratch` category in
// shell/main.js, which maps to <install>/Temp).
//
// OS temp is still used ONLY for inter-process coordination flags and logs
// (veksnap-logs, veksnap-*.flag): never user content.
// ─────────────────────────────────────────────────────────────────────────────

const INSTALL_ROOT = path.resolve(process.cwd(), "..");

/** Absolute path to the install-local scratch root (`<install>/Temp`), optionally
 *  a named subfolder. Auto-creates the directory. Safe to call repeatedly. */
export function getScratchDir(sub?: string): string {
  const dir = sub
    ? path.join(INSTALL_ROOT, "Temp", sub)
    : path.join(INSTALL_ROOT, "Temp");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort: caller will surface any real write failure */
  }
  return dir;
}
