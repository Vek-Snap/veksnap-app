/**
 * PII scrubbing for log EXPORTS (server-only).
 *
 * Vek-Snap logs run fully offline and are only ever shared when a user chooses
 * to send us a support export ("Export All" / "Export Diagnostics"). Before any
 * log content leaves the machine we strip the identifiers that most commonly
 * leak a real person's identity:
 *   1. The install / workspace root, collapsed to `<install>` so the user's
 *      drive letter and chosen folder names (their "drive data") never ship,
 *      while the relative tail stays intact for debugging
 *      (e.g. `<drive>:\…\Vek-Snap\ComfyUI\…` -> `<install>\ComfyUI\…`).
 *   2. The Windows/OS account name embedded in any remaining file paths
 *      (e.g. `C:\Users\Jane Doe\...`  ->  `C:\Users\<user>\...`). This covers
 *      both the full name and the 8.3 short form (`JANE~1`).
 *   3. The current OS username wherever else it appears verbatim.
 *
 * We deliberately do NOT redact `127.0.0.1`/localhost (not PII) and we keep the
 * license section intact (masked key + device instance id) so a support export
 * can still confirm a genuine customer. User PROMPTS are never written to the
 * logs in the first place (the app logs only prompt lengths/markers), so there
 * is nothing to strip there.
 *
 * The user is additionally shown a disclaimer at the error-submission step
 * describing what an export can contain; this pass is defense-in-depth.
 */
import os from "os";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build once at module load.
const REDACTORS: { re: RegExp; to: string }[] = (() => {
  const list: { re: RegExp; to: string }[] = [];

  // 1) The path segment immediately after Users\ or home/, the account folder.
  //    Handles any user, long or short form, on both path separators.
  list.push({ re: /(\\Users\\|\/home\/)[^\\/\r\n"'<>|]+/gi, to: "$1<user>" });

  // 2) The current OS username, verbatim, anywhere else (hostnames, env dumps).
  //    Only when it is a meaningful token (>= 3 chars) to avoid over-redaction.
  try {
    const uname = os.userInfo().username;
    if (uname && uname.length >= 3) {
      list.push({ re: new RegExp(escapeRegExp(uname), "gi"), to: "<user>" });
    }
  } catch {
    /* userInfo can throw on some sandboxes, path rule above still applies */
  }

  return list;
})();

// Collapse the install / workspace root to <install>, preserving the relative
// tail (e.g. "<drive>:\…\Vek-Snap\ComfyUI\…" -> "<install>\ComfyUI\…").
// This hides the user's drive + chosen folder names (their "drive data") while
// keeping paths fully useful for debugging. The root is discovered from the env
// the shell exports (VEKSNAP_INSTALL_ROOT), with a fallback derived from
// VEKSNAP_PYTHON (<root>\runtime\...). Matches either path separator.
const INSTALL_ROOT_REDACTORS: { re: RegExp; to: string }[] = (() => {
  const roots = new Set<string>();
  const add = (p?: string | null) => {
    if (!p) return;
    const t = p.trim().replace(/[\\/]+$/, "");
    // Require at least drive + one folder segment so we never redact a bare "C:\".
    if (t.split(/[\\/]+/).filter(Boolean).length >= 2) roots.add(t);
  };
  add(process.env.VEKSNAP_INSTALL_ROOT);
  const py = process.env.VEKSNAP_PYTHON;
  if (py) {
    const m = py.match(/^(.*?)[\\/]runtime[\\/]/i);
    if (m) add(m[1]);
  }
  const list: { re: RegExp; to: string }[] = [];
  for (const root of roots) {
    const pattern = root.split(/[\\/]+/).filter(Boolean).map(escapeRegExp).join("[\\\\/]+");
    list.push({ re: new RegExp(pattern, "gi"), to: "<install>" });
  }
  return list;
})();

/**
 * Redacts PII from a block of log text destined for export:
 *   - collapses the install/workspace root to <install> (drive + folder names)
 *   - strips the OS account folder + username from any remaining paths
 * Everything else (versions, errors, timings, relative paths) is preserved so a
 * support export is still fully actionable.
 */
export function scrubPii(text: string): string {
  let out = text;
  for (const { re, to } of INSTALL_ROOT_REDACTORS) out = out.replace(re, to);
  for (const { re, to } of REDACTORS) out = out.replace(re, to);
  return out;
}

/** Convenience for Buffer-backed files (returns a UTF-8 Buffer). */
export function scrubPiiBuffer(data: Buffer): Buffer {
  return Buffer.from(scrubPii(data.toString("utf-8")), "utf-8");
}
