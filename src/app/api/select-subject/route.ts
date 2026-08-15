import { NextRequest, NextResponse } from "next/server";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";

const COMFYUI = COMFYUI_HTTP;

/**
 * POST /api/select-subject
 * Body: { imageFile: string }  - ComfyUI input filename
 * Queues an RMBG workflow, polls for the mask result, and returns the output mask filename.
 */
export async function POST(req: NextRequest) {
  try {
    const { imageFile } = await req.json();
    if (!imageFile) {
      return NextResponse.json({ error: "imageFile is required" }, { status: 400 });
    }

    // Build a minimal RMBG workflow: LoadImage → RMBG → SaveImage (mask)
    const workflow: Record<string, unknown> = {
      "1": {
        class_type: "LoadImage",
        inputs: { image: imageFile },
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
          refine_foreground: false,
          background: "Alpha",
        },
      },
      // Save the MASK_IMAGE output (index 2) as a viewable PNG
      "3": {
        class_type: "SaveImage",
        inputs: {
          images: ["2", 2], // MASK_IMAGE output
          filename_prefix: "subject_mask",
        },
      },
    };

    // Queue the prompt
    const queueRes = await fetch(`${COMFYUI}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow }),
    });
    if (!queueRes.ok) {
      const err = await queueRes.text();
      return NextResponse.json({ error: `ComfyUI queue failed: ${err}` }, { status: 502 });
    }
    const { prompt_id } = await queueRes.json();

    // Poll for completion (max 60s)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const histRes = await fetch(`${COMFYUI}/history/${prompt_id}`);
      const histData = await histRes.json();
      const entry = histData?.[prompt_id];
      if (!entry) continue;

      if (entry.status?.completed) {
        // Find SaveImage output
        const outputs = entry.outputs;
        for (const nodeId of Object.keys(outputs || {})) {
          const nodeOut = outputs[nodeId];
          if (nodeOut.images && nodeOut.images.length > 0) {
            const img = nodeOut.images[0];
            return NextResponse.json({
              filename: img.filename,
              subfolder: img.subfolder || "",
              type: img.type || "output",
            });
          }
        }
        return NextResponse.json({ error: "No mask output found" }, { status: 500 });
      }

      if (entry.status?.status_str === "error") {
        return NextResponse.json({ error: "RMBG processing failed" }, { status: 500 });
      }
    }

    return NextResponse.json({ error: "Select Subject timed out (60s)" }, { status: 504 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
