import { GenerationParams, DEFAULT_PARAMS, GenerationMode } from "./types";

/**
 * Parse a ComfyUI prompt JSON (the flat node dict) into Vek-Snap settings.
 * Returns partial GenerationParams + detected mode.
 *
 * This handles standard KSampler, KSamplerAdvanced, WanImageToVideo,
 * UnetLoaderGGUF, CLIPTextEncode, and various loader nodes.
 */
export function parseComfyPrompt(prompt: Record<string, unknown>): {
  params: Partial<GenerationParams>;
  mode: GenerationMode;
  extra: Record<string, unknown>;
} {
  const result: Partial<GenerationParams> = {};
  const extra: Record<string, unknown> = {};
  let mode: GenerationMode = "image";

  // Collect all nodes by class_type for easy lookup
  const nodesByType: Record<string, Array<{ id: string; inputs: Record<string, unknown> }>> = {};
  for (const [id, node] of Object.entries(prompt)) {
    const n = node as { class_type?: string; inputs?: Record<string, unknown> };
    if (n.class_type && n.inputs) {
      if (!nodesByType[n.class_type]) nodesByType[n.class_type] = [];
      nodesByType[n.class_type].push({ id, inputs: n.inputs });
    }
  }

  // ── Detect mode from node types ──
  const hasWanI2V = !!nodesByType["WanImageToVideo"];
  const hasUnetGGUF = !!nodesByType["UnetLoaderGGUF"];
  const hasKSamplerAdv = !!nodesByType["KSamplerAdvanced"];
  const hasModelSamplingSD3 = !!nodesByType["ModelSamplingSD3"];
  const hasAnimateDiff = !!nodesByType["ADE_AnimateDiffLoaderWithContext"] || !!nodesByType["ADE_AnimateDiffUniformContextOptions"];

  if (hasWanI2V && hasUnetGGUF && hasKSamplerAdv) {
    mode = "wan_remix";
  } else if (hasWanI2V) {
    mode = "wan";
  } else if (hasAnimateDiff) {
    mode = "video";
  } else {
    mode = "image";
  }

  // ── Extract prompts from CLIPTextEncode nodes ──
  const clipEncodes = nodesByType["CLIPTextEncode"] || [];
  if (clipEncodes.length >= 1) {
    // Heuristic: the longer negative prompt typically has quality tags
    // Sort by text length: positive is usually shorter or first
    const sorted = [...clipEncodes].sort(
      (a, b) => String(a.inputs.text || "").length - String(b.inputs.text || "").length
    );
    if (sorted.length >= 2) {
      result.positivePrompt = String(sorted[0].inputs.text || "");
      result.negativePrompt = String(sorted[1].inputs.text || "");
    } else {
      result.positivePrompt = String(sorted[0].inputs.text || "");
    }
  }

  // ── Extract KSampler settings ──
  const kSamplers = nodesByType["KSampler"] || [];
  if (kSamplers.length > 0) {
    const ks = kSamplers[0].inputs;
    if (ks.seed != null) result.seed = Number(ks.seed);
    if (ks.steps != null) result.steps = Number(ks.steps);
    if (ks.cfg != null) result.cfg = Number(ks.cfg);
    if (ks.sampler_name) result.sampler = String(ks.sampler_name);
    if (ks.scheduler) result.scheduler = String(ks.scheduler);
    if (ks.denoise != null) result.denoise = Number(ks.denoise);
    result.randomSeed = false;
  }

  // ── Extract KSamplerAdvanced settings (two-pass) ──
  const kSamplersAdv = nodesByType["KSamplerAdvanced"] || [];
  if (kSamplersAdv.length > 0) {
    // First pass (the one with add_noise: "enable") is the primary
    const pass1 = kSamplersAdv.find(n => n.inputs.add_noise === "enable") || kSamplersAdv[0];
    const pass2 = kSamplersAdv.find(n => n.inputs.add_noise === "disable");

    if (pass1.inputs.noise_seed != null) result.seed = Number(pass1.inputs.noise_seed);
    if (pass1.inputs.cfg != null) result.cfg = Number(pass1.inputs.cfg);
    if (pass1.inputs.sampler_name) result.sampler = String(pass1.inputs.sampler_name);
    if (pass1.inputs.scheduler) result.scheduler = String(pass1.inputs.scheduler);
    result.randomSeed = false;

    // Two-pass step configuration
    if (pass1.inputs.steps != null) {
      result.wanRemixTotalSteps = Number(pass1.inputs.steps);
    }
    if (pass1.inputs.end_at_step != null) {
      result.wanRemixPass1Steps = Number(pass1.inputs.end_at_step);
    }
    // If pass2 exists, verify total steps match
    if (pass2 && pass2.inputs.steps != null) {
      result.wanRemixTotalSteps = Number(pass2.inputs.steps);
    }
  }

  // ── Extract WanImageToVideo settings ──
  if (hasWanI2V) {
    const wan = nodesByType["WanImageToVideo"]![0].inputs;
    if (wan.width != null) result.width = Number(wan.width);
    if (wan.height != null) result.height = Number(wan.height);
    if (wan.length != null) result.frames = Number(wan.length);
  }

  // ── Extract UnetLoaderGGUF model names ──
  const ggufLoaders = nodesByType["UnetLoaderGGUF"] || [];
  if (ggufLoaders.length >= 2 && mode === "wan_remix") {
    // Identify high-Q vs low-Q by name or order
    const models = ggufLoaders.map(n => String(n.inputs.unet_name || ""));
    const highIdx = models.findIndex(m => m.toLowerCase().includes("high"));
    const lowIdx = models.findIndex(m => m.toLowerCase().includes("low"));
    if (highIdx !== -1) result.wanRemixHighModel = models[highIdx];
    if (lowIdx !== -1) result.wanRemixLowModel = models[lowIdx];
    // Fallback: first = high, second = low
    if (highIdx === -1 && models[0]) result.wanRemixHighModel = models[0];
    if (lowIdx === -1 && models[1]) result.wanRemixLowModel = models[1];
  }

  // ── Extract ModelSamplingSD3 shift ──
  if (hasModelSamplingSD3) {
    const sd3 = nodesByType["ModelSamplingSD3"]![0].inputs;
    if (sd3.shift != null) result.wanRemixShift = Number(sd3.shift);
  }

  // ── Extract checkpoint name ──
  const checkpoints = nodesByType["CheckpointLoaderSimple"] || [];
  if (checkpoints.length > 0) {
    result.checkpoint = String(checkpoints[0].inputs.ckpt_name || "");
  }

  // ── Extract CreateVideo FPS ──
  const createVideo = nodesByType["CreateVideo"] || [];
  if (createVideo.length > 0 && createVideo[0].inputs.fps != null) {
    result.fps = Number(createVideo[0].inputs.fps);
  }

  // ── Extract source image filename ──
  const loadImages = nodesByType["LoadImage"] || [];
  if (loadImages.length > 0) {
    const imgName = String(loadImages[0].inputs.image || "");
    if (imgName) extra.sourceImageName = imgName;
  }

  // ── Extract resolution from EmptyLatentImage if no WanI2V ──
  if (!hasWanI2V) {
    const emptyLatent = nodesByType["EmptyLatentImage"] || [];
    if (emptyLatent.length > 0) {
      const el = emptyLatent[0].inputs;
      if (el.width != null) result.width = Number(el.width);
      if (el.height != null) result.height = Number(el.height);
    }
  }

  return { params: result, mode, extra };
}

/**
 * Merge parsed params into a full GenerationParams object,
 * preserving defaults for any unset fields.
 */
export function mergeWithDefaults(
  parsed: Partial<GenerationParams>,
  base: GenerationParams = DEFAULT_PARAMS
): GenerationParams {
  return { ...base, ...parsed };
}
