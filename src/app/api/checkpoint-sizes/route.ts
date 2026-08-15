import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const SETTINGS_PATH = path.resolve(process.cwd(), "veksnap-settings.json");
const EXTRA_PATHS_YAML = path.resolve(process.cwd(), "..", "ComfyUI", "extra_model_paths.yaml");

function getExtraDirs(): string[] {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw).extraCheckpointDirs ?? [];
  } catch {
    return [];
  }
}

/** Parse extra_model_paths.yaml to find all configured model directories.
 *  Returns absolute paths for both checkpoints and diffusion_models entries. */
function getYamlModelDirs(): { checkpoints: string[]; diffusionModels: string[] } {
  const result = { checkpoints: [] as string[], diffusionModels: [] as string[] };
  try {
    const raw = fs.readFileSync(EXTRA_PATHS_YAML, "utf-8");
    // Simple YAML parser: structure is flat key-value under named sections
    let basePath = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const kv = trimmed.match(/^(\w[\w_-]*):\s*(.+)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      if (key === "base_path") {
        basePath = val.replace(/\//g, path.sep).replace(/["']/g, "");
      } else if (key === "checkpoints" && basePath) {
        result.checkpoints.push(path.join(basePath, val.trim()));
      } else if ((key === "diffusion_models" || key === "unet") && basePath) {
        result.diffusionModels.push(path.join(basePath, val.trim()));
      }
    }
  } catch { /* yaml missing or unreadable */ }
  return result;
}

function scanDir(dir: string, sizes: Record<string, number>, prefix: string = "") {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}\\${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        scanDir(path.join(dir, entry.name), sizes, relPath);
      } else if (entry.isFile() && (entry.name.endsWith(".safetensors") || entry.name.endsWith(".ckpt"))) {
        // Store under both the flat filename and the full relative path
        // (ComfyUI may return either depending on config)
        if (!(entry.name in sizes)) {
          const stat = fs.statSync(path.join(dir, entry.name));
          sizes[entry.name] = stat.size;
          if (prefix) sizes[relPath] = stat.size;
        }
      }
    }
  } catch {
    // directory doesn't exist or can't be read, skip
  }
}

export async function GET() {
  try {
    const sizes: Record<string, number> = {};
    const comfyModels = path.resolve(process.cwd(), "..", "ComfyUI", "models");
    // Scan ComfyUI default checkpoint + diffusion_models directories
    scanDir(path.join(comfyModels, "checkpoints"), sizes);
    scanDir(path.join(comfyModels, "diffusion_models"), sizes);
    // Scan directories from extra_model_paths.yaml (Z: SSD drive mappings)
    const yamlDirs = getYamlModelDirs();
    for (const dir of yamlDirs.checkpoints) scanDir(dir, sizes);
    for (const dir of yamlDirs.diffusionModels) scanDir(dir, sizes);
    // Scan user-configured extra directories
    for (const dir of getExtraDirs()) scanDir(dir, sizes);
    return NextResponse.json(sizes);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read checkpoint sizes" },
      { status: 500 }
    );
  }
}
