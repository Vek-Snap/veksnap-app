// Vek-Snap "Open in ComfyUI" helper.
//
// Stages the user's CURRENT studio workflow (ComfyUI API/prompt format) in the
// Vek-Snap APP's own one-shot relay (/api/veksnap-bridge/open-workflow), NOT in
// ComfyUI, then opens ComfyUI with the `?veksnap_open=1` flag plus the app
// origin. The bridge web extension fetches the workflow back from the app and
// loads it into the canvas via `app.loadApiJson()`. Keeping the relay in the
// app (instead of a ComfyUI custom-node route) avoids importing/linking GPL
// ComfyUI from our code.
//
// The ComfyUI window is opened with a fixed target name so repeated clicks
// reuse the same tab (navigating it re-runs the extension and reloads the new
// workflow) instead of spawning a new tab each time.

import { COMFYUI_ORIGIN } from "@/lib/comfyui-config";

const COMFYUI_TARGET = "veksnap_comfyui";

/** A builder result: the workflow graph (API/prompt format) + a display name. */
export interface ComfyWorkflowPayload {
  workflow: Record<string, unknown>;
  name: string;
}

/**
 * Stage `workflow` on the ComfyUI server and open ComfyUI so it loads directly.
 * Throws with a user-readable message if staging fails (e.g. ComfyUI offline or
 * the bridge node missing).
 */
export async function openWorkflowInComfyUI(
  workflow: Record<string, unknown>,
  name: string
): Promise<void> {
  if (!workflow || Object.keys(workflow).length === 0) {
    throw new Error("No workflow to open: build or configure the workflow first.");
  }

  let res: Response;
  try {
    res = await fetch("/api/veksnap-bridge/open-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow, name }),
    });
  } catch (err) {
    throw new Error(
      `Could not stage the workflow for ComfyUI (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to stage workflow for ComfyUI (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`
    );
  }

  // Open (or reuse) the ComfyUI tab; the bridge extension fetches the staged
  // workflow from the app origin and auto-loads it. Cache-bust the flag so
  // navigating an already-open tab still fires, and pass the app origin so the
  // extension knows where to fetch from (cross-origin).
  const src = encodeURIComponent(window.location.origin);
  const url = `${COMFYUI_ORIGIN}/?veksnap_open=${Date.now()}&veksnap_src=${src}`;
  window.open(url, COMFYUI_TARGET);
}
