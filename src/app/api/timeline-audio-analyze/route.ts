import { NextRequest, NextResponse } from "next/server";
import { getFFmpegPath, execFileAsync } from "@/lib/ffmpeg-path";

// Timeline Editor: audio loudness analysis for Normalize / Gain-match.
// Measures a clip's trimmed source region with ffmpeg `ebur128` (EBU R128):
// integrated loudness (LUFS) + true peak (dBTP). The client turns those into a
// gain so a clip hits a target loudness with a true-peak ceiling.

export const maxDuration = 120;

/** Last regex capture (ebur128 prints per-frame lines, then a final Summary). */
function lastMatch(text: string, re: RegExp): number | null {
  let m: RegExpExecArray | null;
  let last: number | null = null;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) last = v;
  }
  return last;
}

export async function POST(req: NextRequest) {
  let filePath = "";
  let trimIn = 0;
  let duration = 0;
  let speed = 1;
  try {
    const b = await req.json();
    filePath = typeof b.filePath === "string" ? b.filePath : "";
    trimIn = Number(b.trimIn) || 0;
    duration = Number(b.duration) || 0;
    speed = Number(b.speed) > 0 ? Number(b.speed) : 1;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!filePath) {
    return NextResponse.json({ error: "Missing filePath" }, { status: 400 });
  }

  // Retimed clips consume `duration * speed` seconds of the source.
  const span = duration > 0 ? duration * speed : 0;
  const ff = getFFmpegPath();
  const args = ["-hide_banner", "-nostats"];
  if (trimIn > 0) args.push("-ss", trimIn.toFixed(3));
  args.push("-i", filePath);
  if (span > 0) args.push("-t", span.toFixed(3));
  args.push("-filter_complex", "ebur128=peak=true", "-f", "null", "-");

  try {
    // ebur128's summary is written to stderr; execFileAsync captures both.
    const { stderr } = await execFileAsync(ff, args);
    const text = stderr || "";
    const integratedLufs = lastMatch(text, /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
    const truePeakDb = lastMatch(text, /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g);
    if (integratedLufs === null) {
      return NextResponse.json({ error: "Could not measure loudness" }, { status: 500 });
    }
    return NextResponse.json({ integratedLufs, truePeakDb });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return NextResponse.json(
      { error: (e.stderr || e.message || "Analysis failed").slice(-500) },
      { status: 500 },
    );
  }
}
