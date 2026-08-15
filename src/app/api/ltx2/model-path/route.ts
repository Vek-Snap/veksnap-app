import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// LTX-2 model files and their expected subdirectories (version-aware)
interface ModelEntry { subfolder: string; filename: string; critical: boolean; version: "2.0" | "2.3" | "both" }
const LTX2_MODEL_MAP: ModelEntry[] = [
  // 2.0 models
  { subfolder: "diffusion_models", filename: "ltx-2-19b-dev-fp4.safetensors", critical: true, version: "2.0" },
  { subfolder: "text_encoders", filename: "gemma_3_12B_it_fp8_scaled.safetensors", critical: true, version: "2.0" },
  { subfolder: "text_encoders", filename: "ltx-2-19b-embeddings_connector_distill_bf16.safetensors", critical: true, version: "2.0" },
  { subfolder: "vae", filename: "LTX2_video_vae_bf16.safetensors", critical: true, version: "2.0" },
  { subfolder: "checkpoints", filename: "LTX2_audio_vae_bf16.safetensors", critical: false, version: "2.0" },
  { subfolder: "loras", filename: "ltx-2-19b-distilled-lora-384.safetensors", critical: true, version: "2.0" },
  // 2.3 models
  { subfolder: "diffusion_models", filename: "ltx-2.3-22b-dev-fp8.safetensors", critical: true, version: "2.3" },
  { subfolder: "text_encoders", filename: "gemma_3_12B_it_fp4_mixed.safetensors", critical: true, version: "2.3" },
  { subfolder: "text_encoders", filename: "ltx-2.3_text_projection_bf16.safetensors", critical: true, version: "2.3" },
  { subfolder: "vae", filename: "LTX23_video_vae_bf16.safetensors", critical: true, version: "2.3" },
  { subfolder: "checkpoints", filename: "LTX23_audio_vae_bf16.safetensors", critical: false, version: "2.3" },
  { subfolder: "loras/LTX-2.3", filename: "ltx-2.3-22b-distilled-lora-384.safetensors", critical: true, version: "2.3" },
  { subfolder: "latent_upscale_models", filename: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors", critical: false, version: "2.3" },
  // 2.3 GGUF models (ComfyUI-GGUF quantized, massive VRAM savings for 1080p+)
  { subfolder: "unet", filename: "ltx-2.3-22b-distilled-Q6_K.gguf", critical: false, version: "2.3" },
  { subfolder: "text_encoders", filename: "gemma-3-12b-it-qat-Q4_0.gguf", critical: false, version: "2.3" },
  { subfolder: "text_encoders", filename: "ltx-2.3-22b-distilled_embeddings_connectors.safetensors", critical: false, version: "2.3" },
  // Shared
  { subfolder: "audio_encoders", filename: "wav2vec2_large_english_fp16.safetensors", critical: false, version: "both" },
];

function getComfyUIPath(): string {
  return path.resolve(process.cwd(), "..", "ComfyUI");
}

function getExtraModelPathsFile(): string {
  return path.join(getComfyUIPath(), "extra_model_paths.yaml");
}

// POST: Validate a model base path and update extra_model_paths.yaml
export async function POST(req: NextRequest) {
  try {
    const { basePath } = await req.json();

    if (!basePath || typeof basePath !== "string") {
      return NextResponse.json({ error: "basePath is required" }, { status: 400 });
    }

    const normalizedPath = path.normalize(basePath.trim());

    // Check if the base directory exists
    if (!fs.existsSync(normalizedPath)) {
      return NextResponse.json({
        error: `Directory does not exist: ${normalizedPath}`,
        valid: false,
        files: [],
      }, { status: 400 });
    }

    // Check each model file (all versions)
    const files = LTX2_MODEL_MAP.map((m) => {
      const fullPath = path.join(normalizedPath, m.subfolder, m.filename);
      const exists = fs.existsSync(fullPath);
      let sizeMB = 0;
      if (exists) {
        try {
          const stat = fs.statSync(fullPath);
          sizeMB = Math.round(stat.size / (1024 * 1024));
        } catch { /* ignore */ }
      }
      return {
        subfolder: m.subfolder,
        filename: m.filename,
        exists,
        critical: m.critical,
        sizeMB,
        version: m.version,
      };
    });

    const missingCritical = files.filter((f) => f.critical && !f.exists);
    const allPresent = files.every((f) => f.exists);

    // Update extra_model_paths.yaml to include this path
    updateExtraModelPaths(normalizedPath);

    return NextResponse.json({
      valid: true,
      allPresent,
      missingCritical: missingCritical.length,
      files,
      message: missingCritical.length > 0
        ? `Warning: ${missingCritical.length} critical model file(s) missing. Generation may fail.`
        : allPresent
          ? "All model files found. Path configured successfully."
          : "Core files found. Some optional files missing.",
      yamlUpdated: true,
      note: "ComfyUI must be restarted for the new model path to take effect.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// GET: Return current extra_model_paths.yaml content and validate current config
export async function GET() {
  try {
    const yamlPath = getExtraModelPathsFile();
    let content = "";
    if (fs.existsSync(yamlPath)) {
      content = fs.readFileSync(yamlPath, "utf-8");
    }

    // Parse out the veksnap_ltx2_fast base_path if it exists
    const match = content.match(/veksnap_ltx2_fast:\s*\n\s*base_path:\s*(.+)/);
    const currentFastPath = match ? match[1].trim() : "";

    return NextResponse.json({
      yamlContent: content,
      currentFastPath,
      yamlPath,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// DELETE: Remove the fast path from extra_model_paths.yaml (revert to defaults)
export async function DELETE() {
  try {
    const yamlPath = getExtraModelPathsFile();
    if (!fs.existsSync(yamlPath)) {
      return NextResponse.json({ success: true, message: "No yaml file to update" });
    }

    let content = fs.readFileSync(yamlPath, "utf-8");

    // Remove the veksnap_ltx2_fast block
    content = content.replace(
      /\n?# LTX-2 fast model path \(managed by Vek-Snap\)\nveksnap_ltx2_fast:\n(?:\s+.+\n)*/g,
      ""
    ).trim();

    fs.writeFileSync(yamlPath, content + "\n", "utf-8");

    return NextResponse.json({
      success: true,
      message: "Fast model path removed. Restart ComfyUI to apply.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

function updateExtraModelPaths(fastBasePath: string) {
  const yamlPath = getExtraModelPathsFile();
  let content = "";
  if (fs.existsSync(yamlPath)) {
    content = fs.readFileSync(yamlPath, "utf-8");
  }

  // Remove legacy veksnap_ltx2_fast block (replaced by unified veksnap_ssd)
  content = content.replace(
    /\n?# LTX-2 fast model path \(managed by Vek-Snap\)\nveksnap_ltx2_fast:\n(?:\s+.+\n)*/g,
    ""
  );
  // Remove existing veksnap_ssd block (will be re-written below)
  content = content.replace(
    /\n?# SSD fast model path[^\n]*\nveksnap_ssd:\n(?:\s+.+\n)*/g,
    ""
  ).trim();

  // Normalize path for YAML (use forward slashes)
  const yamlBasePath = fastBasePath.replace(/\\/g, "/");

  // Single unified model path block with is_default: true so ComfyUI
  // PREPENDS these paths (searched before the built-in models/ dirs)
  const ssdBlock = `
# SSD fast model path - all external models (managed by Vek-Snap)
veksnap_ssd:
    base_path: ${yamlBasePath}/
    is_default: true
    diffusion_models: diffusion_models
    text_encoders: text_encoders
    vae: vae
    checkpoints: checkpoints
    loras: loras
    unet: unet
    audio_encoders: audio_encoders
    latent_upscale_models: latent_upscale_models
`;

  content = content + "\n" + ssdBlock.trim() + "\n";
  fs.writeFileSync(yamlPath, content, "utf-8");
}
