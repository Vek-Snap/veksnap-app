/**
 * Resolves the Python interpreter that runs Vek-Snap's helper scripts.
 *
 * Resolution order:
 *   1. VEKSNAP_PYTHON env override (set by the launcher if desired)
 *   2. The bundled venv produced by the installer engine
 *      (<install>/runtime/venv/Scripts/python.exe: the app runs from
 *      <install>/veksnap-app, so this is "../runtime/venv/...")
 *   3. Legacy conda env (dev machines): ../miniconda/envs/comfyui/python.exe
 *   4. Bare "python" on PATH (last resort)
 *
 * Centralizes what used to be a copy-pasted findPython() in many API routes,
 * so the conda->venv migration only needs to change one place going forward.
 */
import path from "path";
import { existsSync } from "fs";

export function getPythonPath(): string {
  const root = path.resolve(process.cwd(), "..");
  const candidates = [
    process.env.VEKSNAP_PYTHON,
    path.join(root, "runtime", "venv", "Scripts", "python.exe"),
    path.join(root, "miniconda", "envs", "comfyui", "python.exe"),
    path.join(root, "miniconda", "python.exe"),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* skip unreadable candidate */
    }
  }
  return "python";
}
