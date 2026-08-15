import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const SETTINGS_PATH = path.resolve(process.cwd(), "veksnap-settings.json");
const COMFYUI_EXTRA_PATHS = path.resolve(process.cwd(), "..", "ComfyUI", "extra_model_paths.yaml");

interface VekSnapSettings {
  extraCheckpointDirs: string[];
  allowOnline: boolean;
  comfyAutostart: boolean;
  comfyPreviewMethod: string;
  verboseLogs: boolean;
  ramReserveMB: number;
  // Primary models directory (empty = portable default <install>/ComfyUI/models).
  modelsRoot: string;
  // Optional fast-SSD / RAM-disk scratch override (empty = OS temp).
  fastTempRoot: string;
  // ── Output metadata embedding (all default OFF for privacy) ──
  // Basic authorship tags (Software/Author/Comment: "made by / made with").
  outputEmbedBasic: boolean;
  // Full ComfyUI workflow + prompt JSON (portable, re-openable in ComfyUI).
  outputEmbedWorkflow: boolean;
  // Compact generation summary: model + LoRA(s)+strengths + seed only.
  outputEmbedSummary: boolean;
  // Optional CivitAI API key (used only when Allow Online is on) for preview /
  // trigger-word lookups. Empty = keyless (public content only). Never logged.
  civitaiApiKey: string;
}

const DEFAULTS: VekSnapSettings = {
  extraCheckpointDirs: [],
  allowOnline: false,
  comfyAutostart: false,
  comfyPreviewMethod: "none",
  verboseLogs: false,
  ramReserveMB: 4096,
  modelsRoot: "",
  fastTempRoot: "",
  outputEmbedBasic: false,
  outputEmbedWorkflow: false,
  outputEmbedSummary: false,
  civitaiApiKey: "",
};

function readSettings(): VekSnapSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(settings: VekSnapSettings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/** Normalize a user-entered directory path so pasting a normal Windows path
 *  "just works": no need to double backslashes. Strips surrounding quotes,
 *  collapses repeated separators (preserving a UNC \\server prefix), unifies to
 *  backslashes, and trims trailing separators (keeping drive roots like C:\). */
function normalizeDir(input: string): string {
  let d = input.trim();
  if (d.length >= 2 && ((d[0] === '"' && d[d.length - 1] === '"') || (d[0] === "'" && d[d.length - 1] === "'"))) {
    d = d.slice(1, -1).trim();
  }
  const isUNC = /^[\\/]{2}/.test(d);
  d = d.replace(/\//g, "\\");     // forward → back
  d = d.replace(/\\{2,}/g, "\\"); // collapse doubles/multiples
  if (isUNC) d = "\\" + d;        // restore single leading backslash for \\server\share
  d = d.replace(/\\+$/, "");      // strip trailing separators
  if (/^[A-Za-z]:$/.test(d)) d += "\\"; // keep drive root (E: → E:\)
  return d;
}

// All model subdirectories that ComfyUI can load from via extra_model_paths.yaml
const MODEL_SUBDIRS = [
  "checkpoints", "text_encoders", "clip", "clip_vision", "diffusion_models",
  "unet", "vae", "loras", "audio_encoders", "model_patches",
  "latent_upscale_models", "sams", "sam2", "facerestore_models",
];

/** Sync extra_model_paths.yaml so ComfyUI can load models from user-defined directories */
function syncComfyExtraPaths(dirs: string[]) {
  if (dirs.length === 0) {
    // Remove the file if no extra dirs
    try { fs.unlinkSync(COMFYUI_EXTRA_PATHS); } catch { /* ignore */ }
    return;
  }
  // Build YAML: one entry per directory with all model subdirectory mappings.
  // ComfyUI searches these in order, so the first entry is highest priority.
  const entries = dirs.map((dir, i) => {
    const normalized = dir.replace(/\\/g, "/");
    const lines = [`veksnap_${i}:`, `    base_path: ${normalized}`];
    for (const sub of MODEL_SUBDIRS) {
      lines.push(`    ${sub}: ${sub}`);
    }
    // grounding-dino maps to sams/
    lines.push("    grounding-dino: sams");
    return lines.join("\n");
  });
  const yaml = entries.join("\n\n") + "\n";
  fs.writeFileSync(COMFYUI_EXTRA_PATHS, yaml, "utf-8");
}

export async function GET() {
  // Redact the CivitAI key: never expose the raw secret to the client. Surface
  // only whether one is configured so the UI can show its status.
  const s = readSettings();
  return NextResponse.json({ ...s, civitaiApiKey: "", civitaiApiKeySet: !!s.civitaiApiKey });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const settings = readSettings();

    if (body.action === "set" && typeof body.key === "string") {
      // Generic key-value setter for simple settings
      if (body.key === "allowOnline" && typeof body.value === "boolean") {
        settings.allowOnline = body.value;
      } else if (body.key === "comfyAutostart" && typeof body.value === "boolean") {
        settings.comfyAutostart = body.value;
      } else if (body.key === "comfyPreviewMethod" && typeof body.value === "string") {
        const valid = ["none", "latent2rgb", "taesd", "auto"];
        if (!valid.includes(body.value)) return NextResponse.json({ error: `Invalid preview method: ${body.value}` }, { status: 400 });
        settings.comfyPreviewMethod = body.value;
      } else if (body.key === "verboseLogs" && typeof body.value === "boolean") {
        settings.verboseLogs = body.value;
      } else if (body.key === "ramReserveMB" && typeof body.value === "number") {
        settings.ramReserveMB = Math.max(1024, Math.min(32768, Math.round(body.value)));
      } else if (body.key === "modelsRoot" && typeof body.value === "string") {
        const dir = body.value.trim();
        if (dir && !fs.existsSync(dir)) return NextResponse.json({ error: `Directory does not exist: ${dir}` }, { status: 400 });
        settings.modelsRoot = dir;
      } else if (body.key === "fastTempRoot" && typeof body.value === "string") {
        const dir = body.value.trim();
        if (dir && !fs.existsSync(dir)) return NextResponse.json({ error: `Directory does not exist: ${dir}` }, { status: 400 });
        settings.fastTempRoot = dir;
      } else if (body.key === "outputEmbedBasic" && typeof body.value === "boolean") {
        settings.outputEmbedBasic = body.value;
      } else if (body.key === "outputEmbedWorkflow" && typeof body.value === "boolean") {
        settings.outputEmbedWorkflow = body.value;
      } else if (body.key === "outputEmbedSummary" && typeof body.value === "boolean") {
        settings.outputEmbedSummary = body.value;
      } else if (body.key === "civitaiApiKey" && typeof body.value === "string") {
        settings.civitaiApiKey = body.value.trim();
      } else {
        return NextResponse.json({ error: `Unknown setting: ${body.key}` }, { status: 400 });
      }
    } else if (body.action === "add" && typeof body.dir === "string") {
      const dir = normalizeDir(body.dir);
      if (!dir) return NextResponse.json({ error: "Empty directory path" }, { status: 400 });
      if (!fs.existsSync(dir)) return NextResponse.json({ error: `Directory does not exist: ${dir}` }, { status: 400 });
      if (!settings.extraCheckpointDirs.includes(dir)) {
        settings.extraCheckpointDirs.push(dir);
      }
    } else if (body.action === "remove" && typeof body.dir === "string") {
      settings.extraCheckpointDirs = settings.extraCheckpointDirs.filter((d) => d !== body.dir);
    } else {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    writeSettings(settings);
    syncComfyExtraPaths(settings.extraCheckpointDirs);
    return NextResponse.json(settings);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update settings" },
      { status: 500 }
    );
  }
}
