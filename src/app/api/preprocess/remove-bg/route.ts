/**
 * POST /api/preprocess/remove-bg
 *
 * Subject extraction via the existing `ComfyUI-RMBG` custom node (already
 * installed in `ComfyUI/custom_nodes/ComfyUI-RMBG/`, registers `RMBG` node
 * with 41 sibling nodes). Returns the RGBA cutout as a data URL. The
 * client-side Reference Prep tool composites the cutout onto whatever
 * background color the user picked (default #808080).
 *
 * Architecture: this route is a thin orchestrator - it uploads the input
 * image to ComfyUI's `input/` dir, POSTs a tiny LoadImage → RMBG → SaveImage
 * workflow to `/prompt`, polls `/history/{id}` for completion, fetches the
 * result PNG via `/view`, and returns it base64-encoded. **No standalone
 * Python subprocess, no transformers version chase, no manual model staging.**
 * Mirrors the established Vek-Snap dispatch pattern (`/api/select-subject`,
 * `/api/vision-describe-batch`, every LTX-2 generation, etc.).
 *
 * Body (multipart/form-data):
 *   - image: File   required - the image to extract subject from
 *
 * Returns: {
 *   ok: true,
 *   rgbaDataUrl: string,   // data:image/png;base64,... (RGBA cutout)
 * } | { ok: false, error: string }
 *
 * The client decodes the PNG into a canvas and computes any sanity stats
 * (alphaMean, dimensions) locally: no server-side image decoding needed.
 */

import { NextRequest, NextResponse } from "next/server";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const COMFYUI = COMFYUI_HTTP;

/**
 * Upload an in-memory image file to ComfyUI's input/ directory using ComfyUI's
 * own multipart endpoint. Returns the canonical filename ComfyUI assigned
 * (may include a subfolder prefix if ComfyUI re-files it).
 */
async function uploadToComfy(image: File, filename: string): Promise<string> {
  const fd = new FormData();
  // ComfyUI's /upload/image expects the field name "image" regardless of MIME.
  fd.append("image", new Blob([await image.arrayBuffer()], { type: image.type || "image/png" }), filename);
  fd.append("overwrite", "true");
  const res = await fetch(`${COMFYUI}/upload/image`, { method: "POST", body: fd });
  if (!res.ok) {
    throw new Error(`ComfyUI /upload/image failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as { name: string; subfolder?: string };
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

/**
 * Build the minimal workflow: LoadImage → RMBG (RMBG-2.0 model, alpha output,
 * foreground refinement on) → SaveImage. The IMAGE output (index 0) of RMBG
 * with `background: "Alpha"` is the RGBA cutout we want - the Reference Prep
 * UI then composites onto whatever background color the user picks. The
 * client doesn't need the MASK_IMAGE or MASK outputs for this flow.
 */
function buildWorkflow(imageFilename: string): Record<string, unknown> {
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: imageFilename },
    },
    "2": {
      class_type: "RMBG",
      inputs: {
        image: ["1", 0],
        model: "RMBG-2.0",
        sensitivity: 1.0,
        process_res: 1024,
        mask_blur: 0,
        mask_offset: 0,
        invert_output: false,
        refine_foreground: true,
        background: "Alpha",
        background_color: "#000000",
      },
    },
    "3": {
      class_type: "SaveImage",
      inputs: {
        images: ["2", 0],            // RGBA IMAGE output - NOT MASK_IMAGE
        filename_prefix: "veksnap_refprep",
      },
    },
  };
}

/**
 * Poll ComfyUI's /history endpoint until the prompt completes or we time out.
 * Returns the first image output emitted by the SaveImage node.
 */
async function waitForResult(
  promptId: string,
  timeoutMs: number,
): Promise<{ filename: string; subfolder: string; type: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800));
    const histRes = await fetch(`${COMFYUI}/history/${promptId}`);
    if (!histRes.ok) continue;
    const histData = await histRes.json() as Record<string, unknown>;
    const entry = histData[promptId] as
      | { status?: { completed?: boolean; status_str?: string; messages?: unknown[] }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }
      | undefined;
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw new Error("ComfyUI reported execution error: check ComfyUI console for the node trace.");
    }
    if (entry.status?.completed) {
      for (const nodeOut of Object.values(entry.outputs || {})) {
        if (nodeOut.images?.length) {
          const img = nodeOut.images[0];
          return {
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
          };
        }
      }
      throw new Error("ComfyUI completed the prompt but produced no image output.");
    }
  }
  throw new Error(`Background removal timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

/** Fetch the result PNG bytes from ComfyUI's /view endpoint. */
async function fetchResultPng(filename: string, subfolder: string, type: string): Promise<Buffer> {
  const qs = new URLSearchParams({ filename, subfolder, type });
  const res = await fetch(`${COMFYUI}/view?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`ComfyUI /view failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function POST(req: NextRequest) {
  try {
    // ── 1. Validate input ────────────────────────────────────────────────────
    const form = await req.formData();
    const image = form.get("image");
    if (!(image instanceof File)) {
      return NextResponse.json({ ok: false, error: "image file is required" }, { status: 400 });
    }

    // ── 2. Verify ComfyUI is reachable BEFORE doing any work ────────────────
    // A user-friendly error here is much better than an opaque fetch failure
    // mid-workflow. We only need a HEAD-equivalent ping; /system_stats is the
    // cheapest reliable endpoint and is what comfyui-api.ts uses too.
    try {
      const ping = await fetch(`${COMFYUI}/system_stats`, { signal: AbortSignal.timeout(3000) });
      if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: `ComfyUI is not reachable at ${COMFYUI}. Start ComfyUI from the Services panel and try again. (${
            e instanceof Error ? e.message : String(e)
          })`,
        },
        { status: 503 },
      );
    }

    // ── 3. Upload input to ComfyUI input/ ───────────────────────────────────
    const ts = Date.now();
    const uploadName = `veksnap_refprep_in_${ts}.png`;
    const imageFilename = await uploadToComfy(image, uploadName);

    // ── 4. Queue the RMBG workflow ──────────────────────────────────────────
    const workflow = buildWorkflow(imageFilename);
    const queueRes = await fetch(`${COMFYUI}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });
    if (!queueRes.ok) {
      // 400 from /prompt usually means a missing node, e.g. ComfyUI-RMBG not
      // installed/loaded. Surface the body verbatim so the user knows.
      const body = await queueRes.text();
      return NextResponse.json(
        {
          ok: false,
          error:
            `ComfyUI rejected the RMBG workflow (HTTP ${queueRes.status}). ` +
            `This usually means the ComfyUI-RMBG custom node is missing or failed to load. ` +
            `Verify it appears in ComfyUI's console under "Loaded".\n\n${body}`,
        },
        { status: 502 },
      );
    }
    const { prompt_id } = (await queueRes.json()) as { prompt_id: string };

    // ── 5. Wait for completion ──────────────────────────────────────────────
    // 120s is comfortable headroom for cold model load + 1024-res inference on
    // CPU fallback. Warm GPU passes typically complete in <3s.
    const out = await waitForResult(prompt_id, 120_000);

    // ── 6. Pull the result PNG bytes ────────────────────────────────────────
    // We deliberately do NOT decode the PNG server-side to compute imageSize
    // or alphaMean. Adding an image-decode dep (sharp) just for an info-string
    // sanity readout is overkill, and the client already decodes the image
    // into an HTMLImageElement on receipt, it computes alphaMean there with
    // a single canvas readback and updates its own info string. Round-trip
    // is faster, and the route stays dep-free.
    const pngBytes = await fetchResultPng(out.filename, out.subfolder, out.type);
    const rgbaDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
    return NextResponse.json({ ok: true, rgbaDataUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[remove-bg] Error:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
