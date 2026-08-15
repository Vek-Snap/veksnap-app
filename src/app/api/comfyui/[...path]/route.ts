import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import nodePath from "path";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";
import { evaluateWorkflow, SAFETY_REFUSAL_MESSAGE } from "@/lib/safety-filter";

const COMFYUI = COMFYUI_HTTP;
const COMFYUI_ROOT = nodePath.resolve(process.cwd(), "..", "ComfyUI");

// Map ComfyUI type parameter to local directory for direct-disk fallback
const TYPE_DIR_MAP: Record<string, string> = {
  output: "output",
  temp: "temp",
  input: "input",
};

// MIME types for common file extensions
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

/**
 * Serve a /view request directly from disk when ComfyUI HTTP proxy fails.
 * This makes output files resilient to loopback firewall blocks (e.g. TinyWall).
 */
function serveFromDisk(req: NextRequest): NextResponse | null {
  const filename = req.nextUrl.searchParams.get("filename");
  const subfolder = req.nextUrl.searchParams.get("subfolder") || "";
  const type = req.nextUrl.searchParams.get("type") || "output";

  if (!filename) return null;

  const dir = TYPE_DIR_MAP[type];
  if (!dir) return null;

  // Sanitize: prevent path traversal
  const safe = nodePath.normalize(nodePath.join(dir, subfolder, filename));
  if (safe.includes("..")) return null;

  const filePath = nodePath.join(COMFYUI_ROOT, safe);
  if (!fs.existsSync(filePath)) return null;

  try {
    const buffer = fs.readFileSync(filePath);
    const ext = nodePath.extname(filename).toLowerCase();
    const contentType = EXT_MIME[ext] || "application/octet-stream";

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.length),
      },
    });
  } catch {
    return null;
  }
}

async function proxy(req: NextRequest, params: { path: string[] }) {
  const path = params.path.join("/");
  // Preserve query parameters (filename, subfolder, type, etc.)
  const search = req.nextUrl.search;
  const url = `${COMFYUI}/${path}${search}`;

  // Read the request body once, needed both for the safety gate and to forward.
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const bodyBuffer = hasBody ? await req.arrayBuffer() : undefined;

  // --- Always-on child-safety gate (not user-configurable) -------------------
  // Every generation submit funnels through POST /prompt. Refuse BEFORE
  // forwarding to ComfyUI if the workflow contains prohibited content
  // (minor indicator/age cue co-occurring with a sexual indicator).
  if (hasBody && req.method === "POST" && path === "prompt" && bodyBuffer) {
    try {
      const text = new TextDecoder("utf-8").decode(bodyBuffer);
      const parsed = JSON.parse(text);
      const workflow = parsed?.prompt ?? parsed;
      const verdict = evaluateWorkflow(workflow);
      if (verdict.action === "refuse") {
        return NextResponse.json(
          { error: { message: verdict.message ?? SAFETY_REFUSAL_MESSAGE }, safety_refusal: true },
          { status: 403 }
        );
      }
    } catch {
      // Unparseable body: fall through and let ComfyUI handle/reject it.
    }
  }

  try {
    const headers: Record<string, string> = {};
    const contentType = req.headers.get("content-type");
    if (contentType) headers["Content-Type"] = contentType;

    const res = await fetch(url, {
      method: req.method,
      headers,
      body: bodyBuffer,
    });

    const data = await res.arrayBuffer();
    const responseHeaders: Record<string, string> = {};

    // Forward content type and cache headers
    const ct = res.headers.get("Content-Type");
    if (ct) responseHeaders["Content-Type"] = ct;
    const cd = res.headers.get("Content-Disposition");
    if (cd) responseHeaders["Content-Disposition"] = cd;
    const cl = res.headers.get("Content-Length");
    if (cl) responseHeaders["Content-Length"] = cl;

    return new NextResponse(data, {
      status: res.status,
      headers: responseHeaders,
    });
  } catch (err) {
    // Fallback: serve /view requests directly from disk when proxy fails
    // (handles loopback firewall blocks like TinyWall)
    if (path === "view" && req.method === "GET") {
      const diskResponse = serveFromDisk(req);
      if (diskResponse) return diskResponse;
    }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Proxy error" },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await context.params);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxy(req, await context.params);
}
