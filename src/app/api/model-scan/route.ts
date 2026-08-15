import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getDirsForSubKey } from "@/lib/model-paths";
import type { ModelKind, ModelScanEntry, ModelScanResult } from "@/lib/model-scan-types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Broadened Model Library scan. Unlike the checkpoint-only listing, this walks
// every model sub-directory ComfyUI can load from and separates *generative*
// checkpoints from *functional / utility* models (VAEs, upscalers, encoders,
// controlnets, etc.: e.g. ema_vae.pth). Fully offline; reads the filesystem only.
// ─────────────────────────────────────────────────────────────────────────────

const GENERATIVE_SUBKEYS = ["checkpoints", "diffusion_models", "unet"];

const FUNCTIONAL_SUBKEYS = [
  "vae",
  "upscale_models",
  "latent_upscale_models",
  "clip",
  "clip_vision",
  "text_encoders",
  "controlnet",
  "ipadapter",
  "embeddings",
  "facerestore_models",
  "sams",
  "sam2",
  "audio_encoders",
  "model_patches",
  "style_models",
  "gligen",
  "photomaker",
];

const MODEL_EXTS = new Set([
  ".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx",
]);

const MAX_DEPTH = 6;

/** Recursively collect model files under `root`, returning entries with names relative to `root`. */
function walkModels(root: string, subKey: string, kind: ModelKind, seen: Set<string>): ModelScanEntry[] {
  const out: ModelScanEntry[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (!MODEL_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      const abs = path.resolve(full);
      if (seen.has(abs)) continue;
      seen.add(abs);
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(abs).size; } catch { /* ignore */ }
      out.push({
        name: path.relative(root, abs).split(path.sep).join("/"),
        path: abs,
        subKey,
        kind,
        sizeBytes,
      });
    }
  }
  return out;
}

function scanBucket(subKeys: string[], kind: ModelKind): ModelScanEntry[] {
  const seen = new Set<string>();
  const out: ModelScanEntry[] = [];
  for (const subKey of subKeys) {
    for (const dir of getDirsForSubKey(subKey)) {
      out.push(...walkModels(dir, subKey, kind, seen));
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function GET() {
  const result: ModelScanResult = {
    generative: scanBucket(GENERATIVE_SUBKEYS, "generative"),
    functional: scanBucket(FUNCTIONAL_SUBKEYS, "functional"),
  };
  return NextResponse.json(result);
}
