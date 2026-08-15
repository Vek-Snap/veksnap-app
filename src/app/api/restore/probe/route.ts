import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("video") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No video file provided" }, { status: 400 });
    }

    // Save to install-local scratch for probing (never the shared OS temp dir).
    const tempDir = getScratchDir("restore");
    mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, file.name);
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(tempPath, buffer);

    // Probe with ffprobe
    const ffprobe = getFFprobePath();
    const probeCmd = `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -show_entries format=duration -of json "${tempPath}"`;

    const { stdout } = await execAsync(probeCmd);
    const probeData = JSON.parse(stdout);

    const stream = probeData.streams?.[0] || {};
    const format = probeData.format || {};

    // Parse frame rate fraction (e.g., "30000/1001" → 29.97)
    let fps = 24;
    if (stream.r_frame_rate) {
      const parts = stream.r_frame_rate.split("/");
      if (parts.length === 2 && parseInt(parts[1]) > 0) {
        fps = parseFloat((parseInt(parts[0]) / parseInt(parts[1])).toFixed(3));
      } else {
        fps = parseFloat(parts[0]) || 24;
      }
    }

    const duration = parseFloat(stream.duration || format.duration || "0");
    const width = parseInt(stream.width || "0");
    const height = parseInt(stream.height || "0");

    return NextResponse.json({
      path: tempPath,
      duration,
      fps,
      width,
      height,
      filename: file.name,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to probe video" },
      { status: 500 }
    );
  }
}
