import { NextRequest } from "next/server";
import WebSocket from "ws";
import { COMFYUI_WS as COMFYUI_WS_URL } from "@/lib/comfyui-config";

const COMFYUI_WS = COMFYUI_WS_URL;

export const dynamic = "force-dynamic";

/**
 * SSE proxy: connects to ComfyUI's WebSocket server-side,
 * then streams events to the browser via Server-Sent Events.
 * Binary preview images are base64-encoded as data URLs.
 */
export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get("clientId") || "veksnap-default";

  const encoder = new TextEncoder();
  let wsClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      const ws = new WebSocket(`${COMFYUI_WS}?clientId=${clientId}`);
      ws.binaryType = "arraybuffer";

      const send = (event: string, data: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // Stream already closed
        }
      };

      ws.on("open", () => {
        send("connected", JSON.stringify({ status: "connected" }));
      });

      ws.on("message", (raw: Buffer | ArrayBuffer | string, isBinary: boolean) => {
        if (!isBinary) {
          // Text frame: JSON progress / executing / status messages
          const text = typeof raw === "string" ? raw : raw.toString("utf-8");
          send("message", text);
        } else {
          // Binary frame: latent preview image from ComfyUI.
          // First 8 bytes: type(4) + format(4), rest is JPEG/PNG data.
          // Only sent when --preview-method is not "none".
          const buf = Buffer.from(raw as ArrayBuffer);
          if (buf.length > 8) {
            const imgData = buf.slice(8);
            const b64 = imgData.toString("base64");
            send("preview", JSON.stringify({ dataUrl: `data:image/jpeg;base64,${b64}` }));
          }
        }
      });

      ws.on("close", () => {
        wsClosed = true;
        send("closed", JSON.stringify({ status: "closed" }));
        try { controller.close(); } catch { /* already closed */ }
      });

      ws.on("error", (err: Error) => {
        send("error", JSON.stringify({ error: String(err) }));
        try { controller.close(); } catch { /* already closed */ }
      });

      // Clean up when client disconnects
      req.signal.addEventListener("abort", () => {
        if (!wsClosed) {
          ws.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
