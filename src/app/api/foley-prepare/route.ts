import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

/**
 * POST /api/foley-prepare
 * Copies output frames from a completed generation into a staging directory
 * that VHS_LoadImagesPath can read for the Foley audio workflow.
 *
 * Body: { images: Array<{ filename: string; subfolder: string; type: string }> }
 * Returns: { directory: string; frameCount: number }
 */
export async function POST(req: NextRequest) {
  try {
    const { images } = await req.json();
    if (!images || !Array.isArray(images) || images.length === 0) {
      return NextResponse.json({ error: "No images provided" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const outputDir = path.join(comfyDir, "output");
    const stagingDir = path.join(comfyDir, "input", "foley_staging");

    // Clean/create staging directory (remove old frames)
    try {
      const oldFiles = await fs.readdir(stagingDir);
      await Promise.all(oldFiles.map((f) => fs.unlink(path.join(stagingDir, f))));
    } catch {
      await fs.mkdir(stagingDir, { recursive: true });
    }

    // Copy frames from output → staging, renaming to sequential order
    let copied = 0;
    const copyTasks: Promise<void>[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const srcDir = img.subfolder
        ? path.join(outputDir, img.subfolder)
        : outputDir;
      const src = path.join(srcDir, img.filename);
      const ext = path.extname(img.filename);
      const dst = path.join(stagingDir, `frame_${String(i + 1).padStart(5, "0")}${ext}`);

      // Queue async copy (skip missing files silently)
      copyTasks.push(
        fs.copyFile(src, dst).then(() => { copied++; }).catch(() => {})
      );
    }

    await Promise.all(copyTasks);

    if (copied === 0) {
      return NextResponse.json(
        { error: "No frames found in ComfyUI output directory" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      directory: stagingDir,
      frameCount: copied,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
