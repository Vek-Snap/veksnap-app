import { QueueResponse, HistoryEntry, ComfyUIProgress } from "./types";
import { COMFYUI_HTTP } from "./comfyui-config";

const COMFYUI_BASE = "/api/comfyui";

export async function getCheckpoints(): Promise<string[]> {
  const res = await fetch(`${COMFYUI_BASE}/object_info/CheckpointLoaderSimple`);
  if (!res.ok) throw new Error(`ComfyUI returned ${res.status}`);
  const data = await res.json();
  const list = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  // Do NOT throw on an empty list. A reachable ComfyUI with zero mapped models
  // must stay distinguishable from an unreachable one, so the UI can prompt the
  // user to add model paths instead of the misleading "is it running?" error.
  return list;
}

export async function getDiffusionModels(): Promise<string[]> {
  const res = await fetch(`${COMFYUI_BASE}/object_info/UNETLoader`);
  if (!res.ok) return [];
  const data = await res.json();
  return data?.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
}

export async function getVAEs(): Promise<string[]> {
  const res = await fetch(`${COMFYUI_BASE}/object_info/VAELoader`);
  if (!res.ok) return [];
  const data = await res.json();
  return data?.VAELoader?.input?.required?.vae_name?.[0] ?? [];
}

// ── Live Preview (Tiny VAE) support probe ──────────────────────────────────
// The LTX-2 "Live Preview" toggle injects two things into the graph: a VAELoader
// for the Tiny VAE below, and the KJNodes LTX2SamplingPreviewOverride node. If
// either is missing, ComfyUI errors the whole render, so the UI probes for both
// and disables the toggle when unavailable. Names MUST match workflow-builder.ts.
export const LIVE_PREVIEW_VAE = "taeltx2_3.safetensors";
export const LIVE_PREVIEW_NODE = "LTX2SamplingPreviewOverride";

export interface LivePreviewSupport {
  supported: boolean;
  nodePresent: boolean;
  vaePresent: boolean;
}

export async function getLivePreviewSupport(): Promise<LivePreviewSupport> {
  let nodePresent = false;
  let vaePresent = false;
  try {
    const res = await fetch(`${COMFYUI_BASE}/object_info/${LIVE_PREVIEW_NODE}`);
    if (res.ok) {
      const data = await res.json();
      nodePresent = !!data?.[LIVE_PREVIEW_NODE];
    }
  } catch { /* ComfyUI unreachable → treat as absent */ }
  try {
    vaePresent = (await getVAEs()).includes(LIVE_PREVIEW_VAE);
  } catch { /* non-throwing → absent */ }
  return { supported: nodePresent && vaePresent, nodePresent, vaePresent };
}

export async function getTextEncoders(): Promise<string[]> {
  // Qwen3 text encoder for Z-Image lives under models/text_encoders (CLIPLoader).
  const res = await fetch(`${COMFYUI_BASE}/object_info/CLIPLoader`);
  if (!res.ok) return [];
  const data = await res.json();
  return data?.CLIPLoader?.input?.required?.clip_name?.[0] ?? [];
}

export async function getAnimateDiffModels(): Promise<string[]> {
  const res = await fetch(
    `${COMFYUI_BASE}/object_info/ADE_AnimateDiffLoaderWithContext`
  );
  if (!res.ok) throw new Error(`ComfyUI returned ${res.status}`);
  const data = await res.json();
  return (
    data?.ADE_AnimateDiffLoaderWithContext?.input?.required?.model_name?.[0] ?? []
  );
}

export async function getLoraModels(): Promise<string[]> {
  const res = await fetch(`${COMFYUI_BASE}/object_info/LoraLoader`);
  if (!res.ok) throw new Error(`ComfyUI returned ${res.status}`);
  const data = await res.json();
  return data?.LoraLoader?.input?.required?.lora_name?.[0] ?? [];
}

export async function getCheckpointSizes(): Promise<Record<string, number>> {
  try {
    const res = await fetch("/api/checkpoint-sizes");
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

export async function uploadImage(
  file: File,
  onProgress?: (pct: number) => void
): Promise<string> {
  const formData = new FormData();
  formData.append("image", file);
  formData.append("overwrite", "true");

  // Upload directly to ComfyUI (CORS enabled) using XHR for progress
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${COMFYUI_HTTP}/upload/image`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data.name);
        } catch {
          reject(new Error("Invalid response from ComfyUI upload"));
        }
      } else {
        reject(new Error(`ComfyUI upload failed: ${xhr.statusText || xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error("Upload network error: is ComfyUI running?"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.timeout = 300000; // 5 minutes for large files

    xhr.send(formData);
  });
}

export async function queuePrompt(
  workflow: Record<string, unknown>,
  clientId: string
): Promise<QueueResponse> {

  const res = await fetch(`${COMFYUI_BASE}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Always-on safety refusal: surface the message directly, not as a queue error.
    if (err?.safety_refusal) {
      const refusal = new Error(
        err?.error?.message || "This request was blocked for safety reasons."
      ) as Error & { code?: string };
      refusal.code = "VEKSNAP_SAFETY_REFUSAL";
      throw refusal;
    }
    // Build a concise error message instead of dumping raw JSON
    let message = `Queue failed: ${res.statusText}`;
    if (err?.error?.message) message += `: ${err.error.message}`;
    if (err?.node_errors) {
      const nodeIds = Object.keys(err.node_errors);
      const details = nodeIds.slice(0, 3).map((id) => {
        const ne = err.node_errors[id];
        const cls = ne.class_type || "Unknown";
        const msgs = (ne.errors || []).map((e: { message?: string; details?: string }) => e.details || e.message).join(", ");
        return `${cls}(${id}): ${msgs}`;
      });
      message += `\n${details.join("\n")}`;
      if (nodeIds.length > 3) message += `\n...and ${nodeIds.length - 3} more node(s)`;
    }
    throw new Error(message);
  }

  return res.json();
}

export async function getHistory(
  promptId: string
): Promise<HistoryEntry | null> {
  const res = await fetch(`${COMFYUI_BASE}/history/${promptId}`);
  const data = await res.json();
  return data?.[promptId] ?? null;
}

export async function interruptGeneration(): Promise<void> {
  await fetch(`${COMFYUI_BASE}/interrupt`, { method: "POST" });
}

export async function freeModels(): Promise<void> {
  await fetch(`${COMFYUI_BASE}/free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
}

/** Remove specific prompt IDs from ComfyUI's pending queue */
export async function clearQueue(promptIds?: string[]): Promise<void> {
  if (promptIds && promptIds.length > 0) {
    // Delete specific prompts from the queue
    await fetch(`${COMFYUI_BASE}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: promptIds }),
    });
  } else {
    // Clear entire queue
    await fetch(`${COMFYUI_BASE}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
  }
}

export interface FlushResult {
  message: string;
  /** GPU subprocesses reclaimed, by label (e.g. "SeedVR2 restore"). */
  reaped: string[];
  /** Live jobs still holding VRAM. Deliberately NOT killed, surfaced so the user can decide. */
  stillRunning: string[];
}

/**
 * Full-scope memory flush: ComfyUI's in-process models AND our own registered GPU subprocesses.
 *
 * `freeModels()` above is the ComfyUI-only primitive and is intentionally narrow. Prefer this for
 * anything user-facing, because a flush that silently ignores half the app's VRAM consumers is
 * worse than no flush at all, it reports success while nothing was freed.
 *
 * @param includeActive Also terminate subprocesses belonging to a RUNNING job. Only pass true from
 *                      an explicit, clearly-labelled user confirmation.
 */
async function requestFlush(scope: "vram" | "all", includeActive: boolean): Promise<FlushResult> {
  // 1. Unload all ComfyUI models (VRAM + RAM)
  await fetch(`${COMFYUI_BASE}/free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
  // 2. Server-side flush: reaps our registered GPU subprocesses, plus (scope "all") custom-node
  // caches, GC and working-set trimming.
  const res = await fetch("/api/flush-ram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ includeActive, scope }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    message: data?.message ?? "Flush requested",
    reaped: data?.reaped ?? [],
    stillRunning: data?.stillRunning ?? [],
  };
}

/** GPU memory only: ComfyUI's loaded models + our registered GPU subprocesses. */
export async function flushGpuMemory(includeActive = false): Promise<FlushResult> {
  return requestFlush("vram", includeActive);
}

/** Everything flushGpuMemory does, plus host-side caches, GC and working-set trimming. */
export async function flushSystemRAM(includeActive = false): Promise<FlushResult> {
  return requestFlush("all", includeActive);
}

export async function getSystemStats(): Promise<{
  devices: Array<{
    name: string;
    type: string;
    vram_total: number;
    vram_free: number;
  }>;
}> {
  const res = await fetch(`${COMFYUI_BASE}/system_stats`);
  return res.json();
}

export function getImageUrl(
  filename: string,
  subfolder: string = "",
  type: string = "output"
): string {
  const params = new URLSearchParams({ filename, subfolder, type });
  return `${COMFYUI_BASE}/view?${params.toString()}`;
}

/**
 * Connect to ComfyUI via SSE proxy (server-side WebSocket → SSE stream).
 * This avoids cross-origin WebSocket issues in Firefox and other browsers.
 * Returns an EventSource that can be closed with .close().
 */
export function connectComfyStream(
  clientId: string,
  onMessage: (msg: ComfyUIProgress) => void,
  onClose?: () => void,
  onError?: (err: Event) => void,
  onPreview?: (dataUrl: string) => void
): EventSource {
  const es = new EventSource(`/api/comfyui-ws?clientId=${clientId}`);

  es.addEventListener("connected", () => {
    console.log("[SSE] Connected to ComfyUI via proxy");
  });

  es.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "progress") {
        console.log(`[SSE] Progress: ${msg.data?.value}/${msg.data?.max}`);
      } else {
        console.log(`[SSE] Message type: ${msg.type}`);
      }
      onMessage(msg);
    } catch {
      console.log("[SSE] Unparseable message");
    }
  });

  es.addEventListener("preview", (event) => {
    try {
      const { dataUrl } = JSON.parse(event.data);
      if (dataUrl && onPreview) {
        console.log(`[SSE] Preview image received (${dataUrl.length} chars)`);
        onPreview(dataUrl);
      }
    } catch {
      console.log("[SSE] Unparseable preview");
    }
  });

  es.addEventListener("closed", () => {
    console.log("[SSE] ComfyUI WS closed");
    es.close();
    onClose?.();
  });

  es.addEventListener("error", (err) => {
    console.log("[SSE] Error:", err);
    onError?.(err);
  });

  es.onerror = (err) => {
    console.log("[SSE] Connection error:", err);
    // EventSource auto-reconnects; close if needed
  };

  return es;
}

export async function reloadNodes(): Promise<{
  success: boolean;
  new_nodes: string[];
  total_nodes: number;
  elapsed_seconds: number;
}> {
  const start = performance.now();

  // Fetch the full node catalog from ComfyUI (refreshes the object_info cache)
  const res = await fetch(`${COMFYUI_BASE}/object_info`);
  if (!res.ok) {
    throw new Error(`Failed to fetch node info: ${res.statusText}`);
  }
  const data = await res.json();
  const allNodes = Object.keys(data);

  const elapsed = (performance.now() - start) / 1000;
  return {
    success: true,
    new_nodes: [],
    total_nodes: allNodes.length,
    elapsed_seconds: Math.round(elapsed * 10) / 10,
  };
}

export async function uploadAudio(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("image", file); // ComfyUI uses "image" field for all uploads
  formData.append("overwrite", "true");
  formData.append("subfolder", "audio");
  formData.append("type", "input");

  const res = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Audio upload failed: ${res.statusText}`);
  }

  const data = await res.json();
  // Return path as subfolder/filename for LoadAudio node
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function uploadVideo(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("image", file); // ComfyUI uses "image" field for all uploads
  formData.append("overwrite", "true");
  formData.append("subfolder", "video");
  formData.append("type", "input");

  const res = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Video upload failed: ${res.statusText}`);
  }

  const data = await res.json();
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

/**
 * Resolve a ComfyUI-input-relative path (e.g. "video/foo.mp4") to its
 * absolute filesystem path. Required for nodes like `VHS_LoadVideoPath`
 * that validate inputs with `os.path.isfile()` instead of going through
 * ComfyUI's input-directory lookup. See `/api/comfyui/abs-input-path`.
 */
export async function resolveComfyInputAbsPath(relPath: string): Promise<string> {
  const res = await fetch("/api/comfyui/abs-input-path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ relPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Path resolution failed: ${res.statusText}`);
  }
  const data = (await res.json()) as { absPath: string; exists: boolean };
  return data.absPath;
}

// ── Connection "grace" across UI switches ──
// The Classic and Modern shells are separate full-page loads; each remounts its
// status poller from scratch, so the ComfyUI dot would flash red for the ~1-2s
// until the first poll resolves, even though ComfyUI never went down. We record
// a last-known-connected timestamp in localStorage; a freshly-mounted poller can
// then start optimistically green if we were connected moments ago. The real
// poll (which runs immediately on mount) corrects it within a second either way.
const COMFY_LAST_OK_KEY = "veksnap:comfy-last-ok";
const COMFY_GRACE_MS = 60000;

export function markComfyConnected(): void {
  try { localStorage.setItem(COMFY_LAST_OK_KEY, String(Date.now())); } catch { /* ignore */ }
}

export function wasRecentlyConnected(graceMs: number = COMFY_GRACE_MS): boolean {
  try {
    const t = parseInt(localStorage.getItem(COMFY_LAST_OK_KEY) || "0", 10);
    return t > 0 && Date.now() - t < graceMs;
  } catch {
    return false;
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    // Use the services API as source of truth, it already does a proper
    // server-side health check (port + HTTP readiness). Avoids proxy issues
    // where /api/comfyui/system_stats can fail while server-side checks pass.
    const res = await fetch("/api/services", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const comfy = data.services?.find((s: { id: string }) => s.id === "comfyui");
    const running = comfy?.status === "running";
    if (running) markComfyConnected();
    return running;
  } catch {
    return false;
  }
}

// ── Render Tracker: server-side safety net for OOM crashes ──
// Persists active prompt_ids so completed renders can be recovered
// even if the renderer dies mid-generation.

export async function registerRender(prompt_id: string, mode: string): Promise<void> {
  try {
    await fetch("/api/render-tracker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "register", prompt_id, mode, timestamp: Date.now() }),
    });
  } catch { /* best effort, don't block generation */ }
}

export async function completeRender(prompt_id: string): Promise<void> {
  try {
    await fetch("/api/render-tracker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", prompt_id }),
    });
  } catch { /* best effort */ }
}

export interface TrackedRender {
  prompt_id: string;
  mode: string;
  timestamp: number;
  recovered?: boolean;
}

export async function getTrackedRenders(): Promise<TrackedRender[]> {
  try {
    const res = await fetch("/api/render-tracker");
    if (!res.ok) return [];
    const data = await res.json();
    return data.renders || [];
  } catch {
    return [];
  }
}

/**
 * Recover orphaned renders: checks ComfyUI history for any tracked prompt_ids
 * that completed while the UI was dead. Returns the output images/videos.
 */
export async function recoverOrphanedRenders(): Promise<
  Array<{ prompt_id: string; mode: string; images: Array<{ filename: string; subfolder: string; type: string }> }>
> {
  const tracked = await getTrackedRenders();
  if (tracked.length === 0) return [];

  const recovered: Array<{
    prompt_id: string;
    mode: string;
    images: Array<{ filename: string; subfolder: string; type: string }>;
  }> = [];

  for (const render of tracked) {
    try {
      const history = await getHistory(render.prompt_id);
      if (history?.outputs) {
        const images: Array<{ filename: string; subfolder: string; type: string }> = [];
        for (const nodeOutput of Object.values(history.outputs)) {
          const no = nodeOutput as Record<string, unknown>;
          if (no.images && Array.isArray(no.images)) {
            images.push(...(no.images as Array<{ filename: string; subfolder: string; type: string }>));
          }
          if (no.gifs && Array.isArray(no.gifs)) {
            images.push(...(no.gifs as Array<{ filename: string; subfolder: string; type: string }>));
          }
        }
        if (images.length > 0) {
          recovered.push({ prompt_id: render.prompt_id, mode: render.mode, images });
          // Mark as recovered (clear from tracker)
          await completeRender(render.prompt_id);
        }
      }
    } catch { /* ComfyUI might not have this in history anymore */ }
  }

  return recovered;
}
