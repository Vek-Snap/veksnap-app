import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isInsideAllowedRoots } from "@/lib/model-paths";

export const dynamic = "force-dynamic";

// Streams a model preview image or short video from disk. Sandboxed to the
// configured model roots and restricted to known media extensions, so it can
// never serve arbitrary files. Supports HTTP Range requests so <video> elements
// can seek/scrub. Fully offline.

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams.get("path");
  if (!p) return NextResponse.json({ error: "path required" }, { status: 400 });
  const abs = path.resolve(p);
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return NextResponse.json({ error: "unsupported media type" }, { status: 400 });
  if (!isInsideAllowedRoots(abs)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  try {
    const total = fs.statSync(abs).size;
    const rangeHeader = req.headers.get("range");
    // Preview media are small (a few MB at most), so a simple read+slice is fine.
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= total) end = total - 1;
      if (start > end) { start = 0; end = total - 1; }
      const chunk = fs.readFileSync(abs).subarray(start, end + 1);
      return new NextResponse(new Uint8Array(chunk), {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunk.length),
          "Cache-Control": "no-cache",
        },
      });
    }
    const buf = fs.readFileSync(abs);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Content-Length": String(total),
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
