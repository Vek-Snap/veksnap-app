"use client";

// ─────────────────────────────────────────────────────────────────────────────
// AI Processing Queue runner (Phase 4). Mounted once by the studio-v2 shell so it
// keeps processing even when the queue panel is collapsed. Runs ONE job at a time
// while the queue is "running":
//   • dramabox → ComfyUI expressive TTS (buildDramaBoxWorkflow) from the clip's
//     script (+ an optional saved config) → generated speech audio, which FILLS
//     the placeholder audio clip (or is parked in the Media Pool if it would
//     overlap an existing clip: see TimelineStore.resolveGeneratedAudio).
//   • zimage → ComfyUI img2img (buildZImageI2IWorkflow) using the clip image as
//     the source + the saved config.
//   • sdxl   → ComfyUI txt2img from the saved config (SDXL has no img2img builder
//     yet, so it generates from the config's prompt/checkpoint).
// On success the output file is round-tripped through buildAssetsFromFile (which
// uploads it + computes duration/peaks/thumb) and swapped into the clip in place.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { aiQueueStore, useAIQueue, type AIQueueItem } from "@/lib/ai-queue/store";
import { timelineStore } from "@/lib/timeline/store";
import { buildAssetsFromFile } from "@/lib/timeline/media";
import { buildWorkflow, buildDramaBoxWorkflow } from "@/lib/workflow-builder";
import { queuePrompt, getHistory, getImageUrl, uploadImage } from "@/lib/comfyui-api";
import { DEFAULT_PARAMS, DRAMABOX_DEFAULTS, type GenerationParams, type DramaBoxConfig } from "@/lib/types";

function resolveSeed(p: Record<string, unknown>): number {
  const seed = typeof p.seed === "number" ? p.seed : -1;
  const random = p.randomSeed === true || seed < 0;
  return random ? Math.floor(Math.random() * 2 ** 32) : seed;
}

/** Browser-playable ComfyUI /output view URL from a relative output path. */
function outputViewUrl(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  const filename = parts.pop() as string;
  const subfolder = parts.join("/");
  return `/api/comfyui/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
}

async function urlToFile(url: string, name: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch result (${res.status}).`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "application/octet-stream" });
}

/** Map a saved Z-Image config to GenerationParams for an img2img refine. */
function zimageParams(p: Record<string, unknown>, sourceImage: string): GenerationParams {
  return {
    ...DEFAULT_PARAMS,
    positivePrompt: String(p.positivePrompt ?? ""),
    negativePrompt: String(p.negativePrompt ?? ""),
    width: Number(p.width ?? 1024),
    height: Number(p.height ?? 1024),
    steps: Number(p.steps ?? 20),
    cfg: Number(p.cfg ?? 1.0),
    sampler: String(p.sampler ?? "euler"),
    scheduler: String(p.scheduler ?? "simple"),
    seed: resolveSeed(p),
    randomSeed: false,
    denoise: Number(p.denoise ?? 0.5),
    sourceImage,
    loras: Array.isArray(p.loras) ? (p.loras as GenerationParams["loras"]) : [],
    regionInfo: null,
  };
}

/** Map a saved SDXL config to GenerationParams (txt2img). */
function sdxlParams(p: Record<string, unknown>): GenerationParams {
  return {
    ...DEFAULT_PARAMS,
    checkpoint: String(p.checkpoint ?? ""),
    positivePrompt: String(p.positivePrompt ?? ""),
    negativePrompt: String(p.negativePrompt ?? ""),
    width: Number(p.width ?? 1024),
    height: Number(p.height ?? 1024),
    steps: Number(p.steps ?? 30),
    cfg: Number(p.cfg ?? 6.0),
    sampler: String(p.sampler ?? "dpmpp_2m"),
    scheduler: String(p.scheduler ?? "karras"),
    clipSkip: Number(p.clipSkip ?? 2),
    seed: resolveSeed(p),
    randomSeed: false,
    denoise: 1.0,
    sourceImage: null,
    loras: Array.isArray(p.loras) ? (p.loras as GenerationParams["loras"]) : [],
    regionInfo: null,
  };
}

/** Queue a ComfyUI graph and wait for the first output image (rel view URL + name). */
async function runComfyImage(
  graph: Record<string, unknown>,
  clientId: string,
  isCancelled: () => boolean,
): Promise<{ url: string; name: string }> {
  const res = await queuePrompt(graph, clientId);
  const promptId = res.prompt_id;
  for (let i = 0; i < 900; i++) {
    if (isCancelled()) throw new Error("Cancelled.");
    await new Promise((r) => setTimeout(r, 1000));
    const hist = await getHistory(promptId);
    if (hist?.status?.status_str === "error") throw new Error("ComfyUI reported an execution error: check its logs.");
    if (hist?.outputs) {
      for (const nodeOut of Object.values(hist.outputs)) {
        const node = nodeOut as { images?: Array<{ filename: string; subfolder?: string; type?: string }> };
        if (node.images?.length) {
          const im = node.images[0];
          return { url: getImageUrl(im.filename, im.subfolder ?? "", im.type ?? "output"), name: im.filename };
        }
      }
    }
  }
  throw new Error("Timed out waiting for ComfyUI output.");
}

/** Queue a ComfyUI graph and wait for the first output AUDIO (rel view URL + name). */
async function runComfyAudio(
  graph: Record<string, unknown>,
  clientId: string,
  isCancelled: () => boolean,
): Promise<{ url: string; name: string }> {
  const res = await queuePrompt(graph, clientId);
  const promptId = res.prompt_id;
  for (let i = 0; i < 900; i++) {
    if (isCancelled()) throw new Error("Cancelled.");
    await new Promise((r) => setTimeout(r, 1000));
    const hist = await getHistory(promptId);
    if (hist?.status?.status_str === "error") throw new Error("ComfyUI reported an execution error: check its logs.");
    if (hist?.outputs) {
      for (const nodeOut of Object.values(hist.outputs)) {
        const node = nodeOut as { audio?: Array<{ filename: string; subfolder?: string }> };
        if (node.audio?.length) {
          const a = node.audio[0];
          const rel = a.subfolder ? `${a.subfolder}/${a.filename}` : a.filename;
          return { url: outputViewUrl(rel), name: a.filename };
        }
      }
    }
  }
  throw new Error("Timed out waiting for DramaBox audio output.");
}

/**
 * Program-wide render job: submit a self-contained graph and wait for ComfyUI to
 * finish. The graph's own Save nodes write to the output folder, so there is
 * nothing to import or place, we only track completion. Renders can be long
 * (video), so we poll generously.
 */
async function runComfyRender(
  graph: Record<string, unknown>,
  clientId: string,
  isCancelled: () => boolean,
  onProgress: (p: string) => void,
): Promise<void> {
  const res = await queuePrompt(graph, clientId);
  const promptId = res.prompt_id;
  onProgress("Rendering…");
  for (let i = 0; i < 7200; i++) {
    if (isCancelled()) throw new Error("Cancelled.");
    await new Promise((r) => setTimeout(r, 1000));
    const hist = await getHistory(promptId);
    if (hist?.status?.status_str === "error") throw new Error("ComfyUI reported an execution error: check its logs.");
    if (hist?.outputs && Object.keys(hist.outputs).length > 0) return;
  }
  throw new Error("Timed out waiting for the render to finish.");
}

/** Map a saved DramaBox config (+ overrides) onto a full DramaBoxConfig for the builder. */
function dramaBoxConfigFrom(saved: Record<string, unknown>, script: string, targetDuration?: number): DramaBoxConfig {
  const merged = { ...DRAMABOX_DEFAULTS, ...(saved as Partial<DramaBoxConfig>) };
  return {
    ...merged,
    prompt: script,
    // A fixed duration (s) overrides the config's genDuration; 0 = auto (generator decides).
    genDuration: typeof targetDuration === "number" ? targetDuration : merged.genDuration,
    // Never re-use a fixed seed for a fresh queue run unless the config pinned one.
    randomSeed: merged.randomSeed,
  };
}

export function useAIQueueRunner(): void {
  const snap = useAIQueue();
  const processingRef = useRef(false);
  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) {
    clientIdRef.current = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `aiq-${Date.now()}`;
  }

  useEffect(() => {
    if (!snap.running || processingRef.current) return;
    const item = aiQueueStore.nextQueued();
    if (!item) { if (!aiQueueStore.hasRunning()) aiQueueStore.setRunning(false); return; }

    processingRef.current = true;
    const isCancelled = () => !aiQueueStore.isRunning();

    (async () => {
      aiQueueStore.setStatus(item.id, "running", { progress: item.configName ? "Loading configuration…" : "Preparing…" });
      try {
        // Program-wide render job: self-contained graph → output folder. No config
        // load, no timeline clip. Runs in order like any other queued job.
        if (item.jobType === "render") {
          if (!item.graph) throw new Error("This queued render has no workflow graph.");
          await runComfyRender(item.graph, clientIdRef.current, isCancelled, (p) => aiQueueStore.setProgress(item.id, p));
          aiQueueStore.setStatus(item.id, "done", { progress: "Done: saved to output." });
          return;
        }

        // A saved config is optional for DramaBox (a script alone is enough); the
        // image workflows always carry one. Only fetch when a name is present.
        let params: Record<string, unknown> = {};
        if (item.configName) {
          const cfgRes = await fetch(`/api/workflow-config?workflow=${encodeURIComponent(item.workflow)}&name=${encodeURIComponent(item.configName)}`);
          const cfgData = await cfgRes.json();
          if (!cfgData.ok) throw new Error(cfgData.error || "Could not load the saved configuration.");
          params = (cfgData.config.params ?? {}) as Record<string, unknown>;
        }

        if (item.workflow === "dramabox") {
          const script = item.audioGen?.script?.trim();
          if (!script) throw new Error("This audio-generation clip has no script.");
          aiQueueStore.setProgress(item.id, "Generating speech…");
          const graph = buildDramaBoxWorkflow(dramaBoxConfigFrom(params, script, item.audioGen?.targetDuration)) as Record<string, unknown>;
          const out = await runComfyAudio(graph, clientIdRef.current, isCancelled);
          const resultFile = await urlToFile(out.url, `audiogen_${Date.now()}.flac`);
          aiQueueStore.setProgress(item.id, "Importing result…");
          const assets = await buildAssetsFromFile(resultFile);
          const primary = assets.find((a) => !a.fromVideoAssetId) ?? assets[0];
          if (!primary) throw new Error("Could not import the generated audio.");
          const placement = timelineStore.resolveGeneratedAudio(item.clipId, primary);
          aiQueueStore.setStatus(item.id, "done", {
            progress: placement === "placed"
              ? "Done: placed on the timeline."
              : "Done: sent to the Media Pool (would have overlapped existing audio).",
          });
          return;
        }

        // Image workflows via ComfyUI (replace the clip's media in place).
        let graph: Record<string, unknown>;
        if (item.workflow === "zimage") {
          aiQueueStore.setProgress(item.id, "Uploading source image…");
          const srcFile = await urlToFile(item.sourceSrc, item.sourceName || "source.png");
          const uploaded = await uploadImage(srcFile);
          graph = buildWorkflow(zimageParams(params, uploaded), "zimage");
        } else {
          graph = buildWorkflow(sdxlParams(params), "image");
        }
        aiQueueStore.setProgress(item.id, "Generating…");
        const out = await runComfyImage(graph, clientIdRef.current, isCancelled);
        const resultFile = await urlToFile(out.url, `${item.sourceName.replace(/\.[^.]+$/, "")}_${item.workflow}.png`);

        aiQueueStore.setProgress(item.id, "Importing result…");
        const assets = await buildAssetsFromFile(resultFile);
        const primary = assets.find((a) => !a.fromVideoAssetId) ?? assets[0];
        if (!primary) throw new Error("Could not import the result into the timeline.");
        timelineStore.replaceClipAsset(item.clipId, primary);
        aiQueueStore.setStatus(item.id, "done", { progress: "Done: clip replaced." });
      } catch (e) {
        const cancelled = !aiQueueStore.isRunning();
        aiQueueStore.setStatus(item.id, cancelled ? "cancelled" : "error", { error: cancelled ? null : (e as Error).message, progress: "" });
        // On a genuine failure (not a manual Stop), halt the whole queue if the
        // user opted to stop-on-error; otherwise the finally-block picks up the
        // next job and the failed one is simply skipped (the default).
        if (!cancelled && aiQueueStore.isStopOnError()) aiQueueStore.setRunning(false);
      } finally {
        processingRef.current = false;
        // Kick the effect again to pick up the next job (or stop if none/idle).
        if (!aiQueueStore.nextQueued()) aiQueueStore.setRunning(false);
        else aiQueueStore.setRunning(aiQueueStore.isRunning());
      }
    })();
  }, [snap]);
}
