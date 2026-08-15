import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const COMFYUI_ROOT = path.join(process.cwd(), "..", "ComfyUI");
const LORAS_DIR = path.join(COMFYUI_ROOT, "models", "loras");

const LORA_EXTENSIONS = new Set([".safetensors", ".ckpt", ".pt", ".gguf"]);

/** Recursively scan a directory for LoRA files, returning relative paths */
function scanLoras(dir: string, base: string = ""): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...scanLoras(path.join(dir, entry.name), relPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (LORA_EXTENSIONS.has(ext)) {
          // Use backslash-separated paths to match ComfyUI's format on Windows
          results.push(relPath.replace(/\//g, "\\"));
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return results;
}

/**
 * Parse extra_model_paths.yaml to find all lora directories.
 * 
 * YAML structure:
 *   section_name:
 *       base_path: D:/Models/0_Models/
 *       loras: loras                          ← relative to base_path
 *       loras: |                              ← multi-line block (rare)
 *           loras
 *           another_loras_dir
 * 
 * Resolves each section's base_path + loras value into absolute paths.
 */
function getExtraLoraDirs(): string[] {
  const dirs: string[] = [];
  try {
    const yamlPath = path.join(COMFYUI_ROOT, "extra_model_paths.yaml");
    if (!fs.existsSync(yamlPath)) return dirs;

    const content = fs.readFileSync(yamlPath, "utf8");
    const lines = content.split(/\r?\n/);

    let currentBasePath = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect base_path (indented key)
      const baseMatch = line.match(/^\s+base_path:\s*(.+)/);
      if (baseMatch) {
        currentBasePath = baseMatch[1].trim();
        continue;
      }

      // Detect loras key (indented, same section as base_path)
      const loraMatch = line.match(/^\s+loras:\s*(.*)/);
      if (loraMatch && currentBasePath) {
        const value = loraMatch[1].trim();

        if (value === "|" || value === ">") {
          // Multi-line block scalar: read indented continuation lines
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j];
            if (!nextLine.match(/^\s{6,}/) && nextLine.trim() !== "") break;
            const subDir = nextLine.trim();
            if (subDir) {
              const resolved = path.resolve(currentBasePath, subDir);
              if (fs.existsSync(resolved)) dirs.push(resolved);
            }
          }
        } else if (value) {
          // Single-line value: resolve relative to base_path
          const resolved = path.resolve(currentBasePath, value);
          if (fs.existsSync(resolved)) dirs.push(resolved);
        }
      }

      // Reset base_path when we hit a new top-level section (non-indented, non-comment, non-empty)
      if (line.match(/^[a-zA-Z_]/) && line.includes(":")) {
        currentBasePath = "";
      }
    }
  } catch {
    // Ignore yaml parse errors
  }

  // Deduplicate resolved directories (multiple YAML sections may point to same path)
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

export async function GET() {
  // Scan extra directories FIRST (Z: drive) so they take priority in dedup
  const extraDirs = getExtraLoraDirs();
  const seen = new Set<string>();
  const allLoras: string[] = [];

  for (const extraDir of extraDirs) {
    for (const lora of scanLoras(extraDir)) {
      const key = lora.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        allLoras.push(lora);
      }
    }
  }

  // Then scan default ComfyUI loras directory (lower priority, dedup against Z: results)
  for (const lora of scanLoras(LORAS_DIR)) {
    const key = lora.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      allLoras.push(lora);
    }
  }

  // Sort alphabetically
  allLoras.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return NextResponse.json(allLoras);
}
