import { NextResponse } from "next/server";
import path from "path";
import { existsSync } from "fs";

export async function GET() {
  try {
    const veksnapRoot = path.resolve(process.cwd(), "..");
    const comfyRoot = path.join(veksnapRoot, "ComfyUI");

    // Check SeedVR2 ComfyUI node
    const seedvr2Node = path.join(comfyRoot, "custom_nodes", "ComfyUI-SeedVR2_VideoUpscaler");
    const seedvr2Exists = existsSync(seedvr2Node);

    // Check Real-ESRGAN portable exe
    const esrganPortable = path.join(veksnapRoot, "..", "Real-ESRGAN-NCNN-Vulkan Project", "Real-ESRGAN-Portable-v3", "realesrgan-ncnn-vulkan.exe");
    const esrganInComfy = existsSync(path.join(comfyRoot, "models", "upscale_models"));
    const esrganExists = existsSync(esrganPortable) || esrganInComfy;

    // Check ffmpeg
    let ffmpegExists = false;
    const ffmpegPaths = [
      path.join(veksnapRoot, "runtime", "ffmpeg", "bin", "ffmpeg.exe"),
      path.join(veksnapRoot, "miniconda", "Library", "bin", "ffmpeg.exe"),
      path.join(veksnapRoot, "..", "Real-ESRGAN-NCNN-Vulkan Project", "Real-ESRGAN-Portable-v3", "ffmpeg.exe"),
    ];
    for (const p of ffmpegPaths) {
      if (existsSync(p)) { ffmpegExists = true; break; }
    }

    // Check SeedVR2 model weights
    const seedvr2Model = path.join(comfyRoot, "models", "checkpoints", "SeedVR2-3B");
    const seedvr2ModelAlt = path.join(comfyRoot, "models", "diffusion_models", "SeedVR2-3B");
    const seedvr2ModelExists = existsSync(seedvr2Model) || existsSync(seedvr2ModelAlt);

    return NextResponse.json({
      seedvr2: seedvr2Exists,
      seedvr2Model: seedvr2ModelExists,
      esrgan: esrganExists,
      ffmpeg: ffmpegExists,
      paths: {
        comfyRoot,
        seedvr2Node: seedvr2Exists ? seedvr2Node : null,
        esrganPortable: existsSync(esrganPortable) ? esrganPortable : null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Setup check failed" },
      { status: 500 }
    );
  }
}
