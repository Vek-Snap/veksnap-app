// ─────────────────────────────────────────────────────────────────────────────
// Server-only helpers for resolving ComfyUI model directories at RUNTIME.
//
// No hardcoded drive letters / paths, everything derives from the install root
// (the Next server's cwd is the app dir, so `..` is the install root holding
// ComfyUI) plus any user-configured directories in extra_model_paths.yaml. This
// is the single source of truth for model-dir resolution + path-safety checks so
// the scan / metadata / rename routes all agree on what's allowed.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

export const COMFYUI_ROOT = path.join(process.cwd(), "..", "ComfyUI");
export const BUNDLED_MODELS_ROOT = path.join(COMFYUI_ROOT, "models");

function readExtraPathsYaml(): string[] {
  const yamlPath = path.join(COMFYUI_ROOT, "extra_model_paths.yaml");
  const yamlBak = yamlPath + ".bak";
  const yamlFile = fs.existsSync(yamlPath) ? yamlPath : fs.existsSync(yamlBak) ? yamlBak : null;
  if (!yamlFile) return [];
  try {
    return fs.readFileSync(yamlFile, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/** All `base_path:` roots declared in extra_model_paths.yaml (existing dirs only). */
export function getExtraBasePaths(): string[] {
  const roots: string[] = [];
  for (const line of readExtraPathsYaml()) {
    const m = line.match(/^\s+base_path:\s*(.+)/);
    if (m) {
      const p = m[1].trim();
      if (p && fs.existsSync(p)) roots.push(path.resolve(p));
    }
  }
  return roots;
}

/**
 * Directories configured for a given model sub-key (e.g. "loras", "checkpoints",
 * "vae") in extra_model_paths.yaml, resolved against their base_path. Existing
 * dirs only.
 */
export function getExtraDirs(subKey: string): string[] {
  const dirs: string[] = [];
  const lines = readExtraPathsYaml();
  const keyRe = new RegExp(`^\\s+${subKey}:\\s*(.*)`);
  let currentBasePath = "";
  for (const line of lines) {
    const baseMatch = line.match(/^\s+base_path:\s*(.+)/);
    if (baseMatch) { currentBasePath = baseMatch[1].trim(); continue; }
    const subMatch = line.match(keyRe);
    if (subMatch && currentBasePath) {
      const value = subMatch[1].trim();
      if (value && value !== "|" && value !== ">") {
        const resolved = path.resolve(currentBasePath, value);
        if (fs.existsSync(resolved)) dirs.push(resolved);
      }
    }
  }
  return dirs;
}

/** Best default directory for a sub-key: first configured extra dir, else the bundled one. */
export function resolveDir(subKey: string): string {
  const extra = getExtraDirs(subKey);
  return extra.length > 0 ? extra[0] : path.join(BUNDLED_MODELS_ROOT, subKey);
}

/** All existing directories for a sub-key: the bundled ComfyUI folder plus any configured extras. */
export function getDirsForSubKey(subKey: string): string[] {
  const dirs = new Set<string>();
  const bundled = path.join(BUNDLED_MODELS_ROOT, subKey);
  if (fs.existsSync(bundled)) dirs.add(path.resolve(bundled));
  for (const d of getExtraDirs(subKey)) dirs.add(path.resolve(d));
  return Array.from(dirs);
}

/**
 * The set of directory roots under which model files may legitimately live. Used
 * to sandbox file operations (metadata sidecars, renames) so a crafted path can
 * never escape into arbitrary parts of the disk.
 */
export function getAllowedRoots(): string[] {
  const roots = new Set<string>();
  if (fs.existsSync(BUNDLED_MODELS_ROOT)) roots.add(path.resolve(BUNDLED_MODELS_ROOT));
  for (const b of getExtraBasePaths()) roots.add(b);
  return Array.from(roots);
}

/** True if `absPath` resolves to a location inside one of the allowed model roots. */
export function isInsideAllowedRoots(absPath: string): boolean {
  let resolved: string;
  try {
    resolved = path.resolve(absPath);
  } catch {
    return false;
  }
  return getAllowedRoots().some((root) => {
    const rel = path.relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}
