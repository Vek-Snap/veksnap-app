import { NextRequest, NextResponse } from "next/server";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";

const COMFYUI = COMFYUI_HTTP;

export async function POST(req: NextRequest) {
  try {
    // Stream body directly to ComfyUI without parsing, avoids Next.js body size limit
    const contentType = req.headers.get("content-type") || "";
    const res = await fetch(`${COMFYUI}/upload/image`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: req.body,
      // @ts-expect-error - duplex required for streaming request bodies
      duplex: "half",
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `ComfyUI upload failed: ${text}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload proxy error" },
      { status: 502 }
    );
  }
}
