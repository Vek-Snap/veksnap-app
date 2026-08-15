import { NextRequest } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

// Serves a local media file by absolute path for the Timeline Editor. When a
// saved project is re-loaded, browser blob: URLs are dead - the editor rebuilds
// each asset's `src` as `/api/timeline-media?path=<abs>` so preview/scrub work
// again. Supports HTTP Range so <video>/<audio> can seek.

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
};

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) return new Response("Missing path", { status: 400 });

  // This endpoint intentionally serves user-selected local media by absolute path
  // (a timeline project references files anywhere on the user's disk). It is only
  // reachable by the trusted renderer (middleware enforces loopback Host/Origin),
  // but as defense-in-depth we serve ONLY known audio/video/image extensions, so
  // it can never be coerced into reading secrets (.env, keys, configs, etc.).
  const mime = MIME[path.extname(filePath).toLowerCase()];
  if (!mime) return new Response("Unsupported media type", { status: 415 });

  let size: number;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return new Response("Not a file", { status: 404 });
    size = s.size;
  } catch {
    return new Response("File not found", { status: 404 });
  }
  const range = req.headers.get("range");

  const toWeb = (start: number, end: number): ReadableStream<Uint8Array> => {
    const node = createReadStream(filePath, { start, end });
    return new ReadableStream({
      start(controller) {
        node.on("data", (c) => controller.enqueue(c as Uint8Array));
        node.on("end", () => controller.close());
        node.on("error", (e) => controller.error(e));
      },
      cancel() { node.destroy(); },
    });
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size || end >= size || start > end) {
        return new Response("Range Not Satisfiable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      return new Response(toWeb(start, end), {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Cache-Control": "no-store",
        },
      });
    }
  }

  return new Response(toWeb(0, size - 1), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Length": String(size),
      "Cache-Control": "no-store",
    },
  });
}
