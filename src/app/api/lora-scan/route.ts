import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COMFYUI_ROOT = path.join(process.cwd(), "..", "ComfyUI");

// ── Types ──

export interface LoraCatalogEntry {
  /** Relative path as ComfyUI sees it (backslash-separated on Windows) */
  name: string;
  /** Absolute path on disk (for metadata sidecars / rename). */
  path: string;
  /** Detected model architecture */
  modelType: LoraModelType;
  /** Compatible generation modes */
  compatibleModes: string[];
  /** Human-readable title (from metadata or filename) */
  title: string;
  /** Description from metadata or usage notes */
  description: string;
  /** Training base model name */
  baseModel: string;
  /** LoRA rank/dim */
  rank: number | null;
  /** Key metadata fields */
  meta: Record<string, string>;
}

type LoraModelType =
  | "ltx2"
  | "ltx2_5"
  | "ltx2_distill"
  | "ltx2_motion"
  | "wan"
  | "sdxl"
  | "sd15"
  | "zimage"
  | "acestep"
  | "unknown";

// ── Mode compatibility mapping ──

const MODE_MAP: Record<LoraModelType, string[]> = {
  // LTX-2.x LoRAs are cross-visible between the 2.3 ("ltx2") and 2.5 ("ltx25") studios.
  ltx2: ["ltx2", "ltx25", "director"],
  ltx2_5: ["ltx2", "ltx25", "director"],
  ltx2_distill: ["ltx2", "ltx25"],
  ltx2_motion: ["ltx2", "ltx25", "director"],
  wan: ["wan", "wan_s2v", "wan_remix", "video"],
  sdxl: ["image", "compose", "edit"],
  sd15: ["image", "compose", "edit"],
  zimage: ["zimage"],
  acestep: ["acestep"],
  unknown: [], // empty = compatible with everything (no restriction)
};

// ── Safetensors header reader ──

function readSafetensorsMetadata(
  filePath: string
): { meta: Record<string, string>; tensorKeys: string[] } | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const headerSizeBuf = Buffer.alloc(8);
    fs.readSync(fd, headerSizeBuf, 0, 8, 0);
    const headerSize = Number(headerSizeBuf.readBigUInt64LE());

    // Sanity check: header shouldn't be > 50MB
    if (headerSize > 50_000_000) {
      fs.closeSync(fd);
      return null;
    }

    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    fs.closeSync(fd);

    const header = JSON.parse(headerBuf.toString("utf-8"));
    const meta: Record<string, string> = {};
    const rawMeta = header.__metadata__ || {};
    for (const [k, v] of Object.entries(rawMeta)) {
      meta[k] = String(v);
    }

    // Get first 10 tensor keys (excluding __metadata__) for type inference
    const tensorKeys = Object.keys(header)
      .filter((k) => k !== "__metadata__")
      .slice(0, 10);

    return { meta, tensorKeys };
  } catch {
    return null;
  }
}

// ── Classification logic ──

function classifyLora(
  relativePath: string,
  meta: Record<string, string>,
  tensorKeys: string[]
): { modelType: LoraModelType; title: string; description: string; baseModel: string; rank: number | null } {
  const arch = meta["modelspec.architecture"]?.toLowerCase() || "";
  const baseVersion = meta["ss_base_model_version"]?.toLowerCase() || "";
  const networkModule = meta["ss_network_module"]?.toLowerCase() || "";
  const sdModelName = meta["ss_sd_model_name"]?.toLowerCase() || "";
  const mergeArch = meta["merge_architecture"]?.toLowerCase() || "";
  const ltxVersion = meta["ss_ltx_version"] || "";
  const description = meta["description"] || meta["ss_training_comment"] || "";
  const title =
    meta["modelspec.title"] ||
    meta["ss_output_name"] ||
    path.basename(relativePath, path.extname(relativePath));
  const baseModel = meta["ss_sd_model_name"] || "";
  const rank =
    meta["ss_network_dim"] ? parseInt(meta["ss_network_dim"]) || null : null;

  // Folder + filename hints
  const pathLower = relativePath.toLowerCase().replace(/\\/g, "/");

  let modelType: LoraModelType = "unknown";

  // 0. Early folder/filename pattern matches for specialized types
  if (pathLower.includes("ace-step") || pathLower.includes("acestep")) {
    modelType = "acestep";
  } else if (pathLower.includes("z-image") || pathLower.includes("zimage") || pathLower.includes("z-turbo") || pathLower.includes("zturbo") || pathLower.includes("zit")) {
    modelType = "zimage";
  } else if (pathLower.includes("motion-track") || pathLower.includes("motion_track")) {
    modelType = "ltx2_motion";
  }
  // 1. Check if this is a distill LoRA
  else if (pathLower.includes("distill")) {
    modelType = "ltx2_distill";
  }
  // 1b. LTX-2.5 specific (distinct from 2.3), metadata version or filename/folder hints.
  else if (
    ltxVersion.includes("2.5") ||
    baseVersion.includes("ltx-2.5") ||
    baseVersion.includes("ltx2.5") ||
    /(?:^|[^\d])2\.5(?:[^\d]|$)/.test(pathLower) &&
      (pathLower.includes("ltx") || arch.includes("ltx")) ||
    pathLower.includes("ltx-2.5") ||
    pathLower.includes("ltx2.5") ||
    pathLower.includes("ltx25")
  ) {
    modelType = "ltx2_5";
  }
  // 2. Architecture field (most reliable)
  else if (arch.includes("ltx2") || arch.includes("ltx-video")) {
    modelType = "ltx2";
  } else if (arch.includes("wan")) {
    modelType = "wan";
  } else if (arch.includes("stable-diffusion-xl") || arch.includes("sdxl")) {
    modelType = "sdxl";
  } else if (
    arch.includes("stable-diffusion-v1") ||
    arch.includes("sd1")
  ) {
    modelType = "sd15";
  }
  // 3. Base model version
  else if (baseVersion.includes("ltx")) {
    modelType = "ltx2";
  } else if (baseVersion.includes("wan")) {
    modelType = "wan";
  } else if (baseVersion.includes("sdxl")) {
    modelType = "sdxl";
  } else if (baseVersion.includes("sd1") || baseVersion === "sd15") {
    modelType = "sd15";
  }
  // 4. Network module
  else if (networkModule.includes("lora_ltx")) {
    modelType = "ltx2";
  } else if (networkModule.includes("lora_wan")) {
    modelType = "wan";
  }
  // 5. SD model name
  else if (sdModelName.includes("ltx")) {
    modelType = "ltx2";
  } else if (sdModelName.includes("wan")) {
    modelType = "wan";
  }
  // 6. Merge architecture
  else if (mergeArch.includes("ltx")) {
    modelType = "ltx2";
  } else if (mergeArch.includes("wan")) {
    modelType = "wan";
  }
  // 7. Folder/filename patterns
  else if (
    pathLower.includes("ltx-2") ||
    pathLower.includes("ltx2") ||
    pathLower.includes("m-ltx")
  ) {
    modelType = "ltx2";
  } else if (pathLower.includes("wan")) {
    modelType = "wan";
  } else if (pathLower.includes("sdxl") || pathLower.includes("xl")) {
    modelType = "sdxl";
  } else if (pathLower.includes("sd15") || pathLower.includes("sd1.5")) {
    modelType = "sd15";
  }
  // 8. Tensor key patterns (last resort)
  else if (tensorKeys.length > 0) {
    const firstKey = tensorKeys[0].toLowerCase();
    if (firstKey.includes("diffusion_model.transformer_blocks")) {
      // Could be LTX2: check for LTX-specific patterns
      if (firstKey.includes("to_gate_logits")) {
        modelType = "ltx2"; // gate_logits is LTX2-specific
      }
    } else if (firstKey.includes("lora_unet") || firstKey.includes("lora_te")) {
      modelType = "sdxl"; // SD/SDXL LoRA format
    }
  }

  // Refine LTX2 version from metadata
  if (modelType === "ltx2" && ltxVersion) {
    // Keep as ltx2: version info is in metadata
  }

  return { modelType, title, description, baseModel, rank };
}

// ── Usage notes reader ──

function readUsageNotes(loraDirs: string[]): Map<string, string> {
  const notes = new Map<string, string>();

  for (const dir of loraDirs) {
    const notesDir = path.join(dir, "Usage Notes");
    if (!fs.existsSync(notesDir)) continue;

    try {
      for (const file of fs.readdirSync(notesDir)) {
        const filePath = path.join(notesDir, file);
        let text = "";

        try {
          const raw = fs.readFileSync(filePath, "utf-8");

          if (file.endsWith(".txt")) {
            text = raw.trim();
          } else if (file.endsWith(".html")) {
            // Strip HTML tags to get text content
            text = raw
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
          }

          if (text) {
            // Use filename (without extension and date suffix) as loose key for matching
            const key = file
              .replace(/\s*\(\d{1,2}_\d{1,2}_\d{4}.*?\)/, "")
              .replace(/\.[^.]+$/, "")
              .trim()
              .toLowerCase();
            notes.set(key, text.slice(0, 2000)); // Cap at 2000 chars
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return notes;
}

/** Try to match a LoRA filename to a usage note */
function findUsageNote(
  loraName: string,
  notes: Map<string, string>
): string {
  const loraLower = path
    .basename(loraName, path.extname(loraName))
    .toLowerCase()
    .replace(/[_\-\.]/g, " ");

  for (const [noteKey, noteText] of notes) {
    const keyNorm = noteKey.replace(/[_\-\.]/g, " ");
    // Check if lora name appears in note key or vice versa
    if (keyNorm.includes(loraLower) || loraLower.includes(keyNorm)) {
      return noteText;
    }
    // Fuzzy: check if significant words overlap
    const loraWords = loraLower.split(/\s+/).filter((w) => w.length > 3);
    const noteWords = keyNorm.split(/\s+/).filter((w) => w.length > 3);
    const overlap = loraWords.filter((w) => noteWords.includes(w));
    if (overlap.length >= 2) {
      return noteText;
    }
  }

  return "";
}

// ── Directory scanning (shared with lora-files) ──

const LORA_EXTENSIONS = new Set([".safetensors", ".ckpt", ".pt", ".gguf"]);

function scanLoraFiles(
  dir: string,
  base: string = ""
): { relPath: string; absPath: string }[] {
  const results: { relPath: string; absPath: string }[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "Usage Notes") continue; // Skip notes directory
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanLoraFiles(absPath, relPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (LORA_EXTENSIONS.has(ext)) {
          results.push({ relPath: relPath.replace(/\//g, "\\"), absPath });
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return results;
}

function getExtraLoraDirs(): string[] {
  const dirs: string[] = [];
  try {
    const yamlPath = path.join(COMFYUI_ROOT, "extra_model_paths.yaml");
    const yamlBak = yamlPath + ".bak";
    const yamlFile = fs.existsSync(yamlPath) ? yamlPath : fs.existsSync(yamlBak) ? yamlBak : null;
    if (!yamlFile) return dirs;

    const content = fs.readFileSync(yamlFile, "utf8");
    const lines = content.split(/\r?\n/);
    let currentBasePath = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const baseMatch = line.match(/^\s+base_path:\s*(.+)/);
      if (baseMatch) {
        currentBasePath = baseMatch[1].trim();
        continue;
      }
      const loraMatch = line.match(/^\s+loras:\s*(.*)/);
      if (loraMatch && currentBasePath) {
        const value = loraMatch[1].trim();
        if (value && value !== "|" && value !== ">") {
          const resolved = path.resolve(currentBasePath, value);
          if (fs.existsSync(resolved)) dirs.push(resolved);
        }
      }
      if (line.match(/^[a-zA-Z_]/) && line.includes(":")) {
        currentBasePath = "";
      }
    }
  } catch {
    // Ignore yaml parse errors
  }
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

// ── Cache ──

let cachedCatalog: { entries: LoraCatalogEntry[]; timestamp: number } | null =
  null;
const CACHE_TTL = 300_000; // 5 minutes

// ── ComfyUI cache invalidation ──

/** Touch a directory and all subdirectories to update mtime.
 *  ComfyUI's folder_paths module checks directory mtime to decide
 *  whether to rescan: touching forces it to pick up new/removed files. */
function touchDirTree(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return;
    const now = new Date();
    fs.utimesSync(dir, now, now);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "Usage Notes") {
        try {
          fs.utimesSync(path.join(dir, entry.name), now, now);
        } catch { /* skip inaccessible subdirs */ }
      }
    }
  } catch { /* skip inaccessible dirs */ }
}

// ── API ──

export async function GET(req: Request) {
  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";

  // Return cached if fresh
  if (
    !forceRefresh &&
    cachedCatalog &&
    Date.now() - cachedCatalog.timestamp < CACHE_TTL
  ) {
    return NextResponse.json({
      catalog: cachedCatalog.entries,
      cached: true,
      scannedAt: cachedCatalog.timestamp,
    });
  }

  // Scan all LoRA directories
  const extraDirs = getExtraLoraDirs();
  const defaultDir = path.join(COMFYUI_ROOT, "models", "loras");
  const allDirs = [...extraDirs, defaultDir];

  // Touch all LoRA directories so ComfyUI's folder_paths cache invalidates
  if (forceRefresh) {
    for (const dir of allDirs) {
      touchDirTree(dir);
    }
  }

  // Read usage notes from all directories
  const usageNotes = readUsageNotes(allDirs);

  // Scan and classify
  const seen = new Set<string>();
  const catalog: LoraCatalogEntry[] = [];

  for (const dir of allDirs) {
    for (const { relPath, absPath } of scanLoraFiles(dir)) {
      const key = relPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let meta: Record<string, string> = {};
      let tensorKeys: string[] = [];

      if (absPath.endsWith(".safetensors")) {
        const result = readSafetensorsMetadata(absPath);
        if (result) {
          meta = result.meta;
          tensorKeys = result.tensorKeys;
        }
      }

      const { modelType, title, description, baseModel, rank } =
        classifyLora(relPath, meta, tensorKeys);

      // Try to find usage notes
      const usageNote = findUsageNote(relPath, usageNotes);
      const fullDescription = [description, usageNote]
        .filter(Boolean)
        .join("\n\n---\n\n");

      const compatibleModes = MODE_MAP[modelType];

      // Select key metadata fields for display
      const displayMeta: Record<string, string> = {};
      const interestingKeys = [
        "modelspec.architecture",
        "ss_base_model_version",
        "ss_ltx_version",
        "ss_network_dim",
        "ss_network_alpha",
        "ss_learning_rate",
        "ss_steps",
        "ss_epoch",
        "modelspec.resolution",
        "modelspec.title",
        "modelspec.author",
        "ss_sd_model_name",
        "merge_architecture",
        "source_loras",
        "prompt",
      ];
      for (const k of interestingKeys) {
        if (meta[k]) displayMeta[k] = meta[k].slice(0, 300);
      }

      catalog.push({
        name: relPath,
        path: absPath,
        modelType,
        compatibleModes,
        title,
        description: fullDescription.slice(0, 3000),
        baseModel,
        rank,
        meta: displayMeta,
      });
    }
  }

  // Sort: by modelType then name
  const typeOrder: Record<string, number> = {
    ltx2_5: 0,
    ltx2: 0,
    ltx2_distill: 1,
    wan: 2,
    ltx2_motion: 2,
    zimage: 5,
    acestep: 5,
    sdxl: 6,
    sd15: 7,
    unknown: 8,
  };
  catalog.sort(
    (a, b) =>
      (typeOrder[a.modelType] ?? 99) - (typeOrder[b.modelType] ?? 99) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );

  cachedCatalog = { entries: catalog, timestamp: Date.now() };

  return NextResponse.json({
    catalog,
    cached: false,
    scannedAt: cachedCatalog.timestamp,
    usageNotesFound: usageNotes.size,
  });
}
