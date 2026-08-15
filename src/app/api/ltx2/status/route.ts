import { NextResponse } from "next/server";
import path from "path";
import { existsSync, readFileSync } from "fs";

export const dynamic = "force-dynamic";

const LTX2_DIR = path.resolve(process.cwd(), "..", "ltx2-studio");
const STATUS_FILE = path.join(LTX2_DIR, "status.json");
const MODEL_DIR = path.resolve(process.cwd(), "..", "LTX-2_CORE");

export async function GET() {
  try {
    // Check model readiness: verify key files exist
    const modelReady =
      existsSync(path.join(MODEL_DIR, "model_index.json")) &&
      existsSync(path.join(MODEL_DIR, "vae", "diffusion_pytorch_model.safetensors")) &&
      existsSync(path.join(MODEL_DIR, "vocoder", "diffusion_pytorch_model.safetensors")) &&
      existsSync(path.join(MODEL_DIR, "audio_vae", "diffusion_pytorch_model.safetensors")) &&
      existsSync(path.join(MODEL_DIR, "connectors", "diffusion_pytorch_model.safetensors")) &&
      // Check transformer has all 8 BF16 shards
      Array.from({ length: 8 }, (_, i) =>
        existsSync(
          path.join(
            MODEL_DIR,
            "transformer",
            `diffusion_pytorch_model-${String(i + 1).padStart(5, "0")}-of-00008.safetensors`
          )
        )
      ).every(Boolean) &&
      // Check text encoder has all 12 shards
      Array.from({ length: 12 }, (_, i) =>
        existsSync(
          path.join(
            MODEL_DIR,
            "text_encoder",
            `diffusion_pytorch_model-${String(i + 1).padStart(5, "0")}-of-00012.safetensors`
          )
        )
      ).every(Boolean);

    // Read status file if it exists
    if (existsSync(STATUS_FILE)) {
      const raw = readFileSync(STATUS_FILE, "utf-8");
      const status = JSON.parse(raw);
      return NextResponse.json({ ...status, modelReady });
    }

    return NextResponse.json({
      state: "idle",
      progress: 0,
      progressMax: 0,
      stage: "",
      modelReady,
    });
  } catch (err) {
    return NextResponse.json(
      { state: "error", progress: 0, progressMax: 0, stage: "", error: String(err), modelReady: false },
      { status: 500 }
    );
  }
}
