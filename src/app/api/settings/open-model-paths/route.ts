import { NextResponse } from "next/server";
import { exec } from "child_process";
import path from "path";
import fs from "fs";

const COMFYUI_EXTRA_PATHS = path.resolve(process.cwd(), "..", "ComfyUI", "extra_model_paths.yaml");

export async function POST() {
  try {
    // Create the file with a helpful template if it doesn't exist yet
    if (!fs.existsSync(COMFYUI_EXTRA_PATHS)) {
      const template = [
        "# Vek-Snap: ComfyUI Extra Model Paths",
        "# Add model directories here. ComfyUI searches them in order (top = highest priority).",
        "# Changes require a ComfyUI restart to take effect.",
        "#",
        "# Example:",
        "# my_models:",
        "#     base_path: E:/MyModels",
        "#     checkpoints: checkpoints",
        "#     loras: loras",
        "#     vae: vae",
        "",
      ].join("\n");
      fs.writeFileSync(COMFYUI_EXTRA_PATHS, template, "utf-8");
    }

    // Open in Notepad (available on all Windows systems)
    exec(`notepad.exe "${COMFYUI_EXTRA_PATHS}"`, { windowsHide: true });
    return NextResponse.json({ ok: true, path: COMFYUI_EXTRA_PATHS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to open model paths file" },
      { status: 500 }
    );
  }
}
