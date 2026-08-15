import { GenerationParams, GenerationMode, WAN_MODELS, WAN_REMIX_MODELS, WAN_SVI_MODELS, WAN_SVI_LIGHTNING_COMBOS, WAN_S2V_MODELS, ZIMAGE_MODELS, ZIMAGE_ENHANCE, ZIMAGE_ENHANCE_PROMPT, ZIMAGE_ENHANCE_NEGATIVE, ZIMAGE_FACE, ZIMAGE_FACE_PROMPT, ZIMAGE_FACE_NEGATIVE, FACE_DETECT, BRUSHNET_MODELS, POWERPAINT_MODELS, getCheckpointArch, LoraEntry, EmbeddingEntry, WanPairedLoraEntry, WanS2VConfig, LTX2Config, LTX2_DISTILLED_SIGMAS, LTX2_TEST_SIGMAS, LTX2_OFFICIAL_NEGATIVE, LTX2_OFFICIAL_GUIDER_PARAMS, LTX2_OFFICIAL_SCHEDULER, LTX2_OFFICIAL_LORA_STRENGTH, LTX2_NAG_DEFAULT_PROMPT, TURBO_UPSCALE_DEFAULTS, LTX23_GGUF_DEFAULTS, getTurboHalfResolution, AceStepConfig, HeartMuLaConfig, DramaBoxConfig, MotionTrack, MotionTrackPoint, TimelineSegment } from "./types";
import { applyStylePrefix, buildNegativePrompt } from "./prompt-architect";
import { buildLTX25Workflow } from "./workflow-ltx25";
export { buildLTX25Workflow };

export function getSeed(params: GenerationParams): number {
  return params.randomSeed || params.seed < 0
    ? Math.floor(Math.random() * 2 ** 32)
    : params.seed;
}

/**
 * Resolve prompts with active embedding tokens injected.
 * Enabled embeddings targeting "positive" are appended to the positive prompt,
 * and those targeting "negative" are appended to the negative prompt.
 * ComfyUI resolves `embedding:name` tokens automatically in CLIPTextEncode.
 */
function resolveEmbeddings(
  positive: string,
  negative: string,
  embeddings: EmbeddingEntry[]
): { positive: string; negative: string } {
  const active = embeddings.filter((e) => e.enabled && e.name);
  if (active.length === 0) return { positive, negative };

  const posTokens = active
    .filter((e) => e.target === "positive")
    .map((e) => `embedding:${e.name}`);
  const negTokens = active
    .filter((e) => e.target === "negative")
    .map((e) => `embedding:${e.name}`);

  return {
    positive: posTokens.length > 0 ? `${positive}, ${posTokens.join(", ")}` : positive,
    negative: negTokens.length > 0 ? `${negative}, ${negTokens.join(", ")}` : negative,
  };
}

/**
 * Inject LoraLoader nodes into a workflow, chaining them after the checkpoint.
 * Returns the final model and clip references to use downstream.
 */
function injectLoras(
  nodes: Record<string, unknown>,
  loras: LoraEntry[],
  modelRef: [string, number],
  clipRef: [string, number],
  startId = 100
): { modelRef: [string, number]; clipRef: [string, number] } {
  const active = loras.filter((l) => l.enabled && l.name);
  let mRef = modelRef;
  let cRef = clipRef;
  for (let i = 0; i < active.length; i++) {
    const id = String(startId + i);
    nodes[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: active[i].name,
        strength_model: active[i].strengthModel,
        strength_clip: active[i].strengthClip,
        model: mRef,
        clip: cRef,
      },
    };
    mRef = [id, 0];
    cRef = [id, 1];
  }
  return { modelRef: mRef, clipRef: cRef };
}

/**
 * Inject CLIPSetLastLayer when clipSkip > 1 (SD1.5/SDXL checkpoints only).
 * Returns the clip reference to use downstream.
 */
function injectClipSkip(
  nodes: Record<string, unknown>,
  clipRef: [string, number],
  clipSkip: number,
  nodeId = "199"
): [string, number] {
  if (clipSkip <= 1) return clipRef;
  nodes[nodeId] = {
    class_type: "CLIPSetLastLayer",
    inputs: { clip: clipRef, stop_at_clip_layer: -clipSkip },
  };
  return [nodeId, 0];
}

/**
 * Append HiRes Fix pass: LatentUpscaleBy → second KSampler at lower denoise.
 * Returns the final samples ref (either the hires output or the original if disabled).
 */
function addHiresFix(
  nodes: Record<string, unknown>,
  params: GenerationParams,
  samplesRef: [string, number],
  modelRef: [string, number],
  positiveRef: [string, number],
  negativeRef: [string, number],
  seed: number,
  upscaleId = "190",
  ksamplerHiresId = "191"
): [string, number] {
  if (!params.hiresEnabled) return samplesRef;
  nodes[upscaleId] = {
    class_type: "LatentUpscaleBy",
    inputs: {
      samples: samplesRef,
      upscale_method: params.hiresUpscaleMethod,
      scale_by: params.hiresScale,
    },
  };
  nodes[ksamplerHiresId] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef,
      positive: positiveRef,
      negative: negativeRef,
      latent_image: [upscaleId, 0],
      seed: seed + 1,
      steps: params.hiresSteps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: params.hiresDenoise,
    },
  };
  return [ksamplerHiresId, 0];
}

/**
 * Vek-Snap Enhance Details: real upscaler model (ESRGAN) + img2img refinement.
 * Flow: pixel image → UpscaleModelLoader → ImageUpscaleWithModel (4x) → ImageScale (to target) →
 *       VAEEncode → KSampler (low denoise) → VAEDecode → pixel image.
 * Uses hiresScale for the target scale factor. Produces much better results than latent-space
 * interpolation (HiRes Fix) because the upscaler model preserves and enhances real details.
 * Requires an upscaler model in ComfyUI/models/upscale_models/ (e.g., RealESRGAN_x4plus.pth).
 */
function addEnhanceDetails(
  nodes: Record<string, unknown>,
  params: GenerationParams,
  imageRef: [string, number],
  modelRef: [string, number],
  positiveRef: [string, number],
  negativeRef: [string, number],
  vaeRef: [string, number],
  seed: number,
  baseId = 170
): [string, number] {
  if (!params.enhanceEnabled) return imageRef;
  const scale = params.hiresScale;
  const targetW = Math.round(params.width * scale);
  const targetH = Math.round(params.height * scale);
  // 1. Load upscaler model (ESRGAN / RealESRGAN)
  nodes[String(baseId)] = {
    class_type: "UpscaleModelLoader",
    inputs: { model_name: params.enhanceUpscalerModel },
  };
  // 2. Upscale image with the model (typically 4x)
  nodes[String(baseId + 1)] = {
    class_type: "ImageUpscaleWithModel",
    inputs: { upscale_model: [String(baseId), 0], image: imageRef },
  };
  // 3. Scale to exact target dimensions (model outputs 4x, we want hiresScale)
  nodes[String(baseId + 2)] = {
    class_type: "ImageScale",
    inputs: {
      image: [String(baseId + 1), 0],
      upscale_method: "lanczos",
      width: targetW,
      height: targetH,
      crop: "disabled",
    },
  };
  // 4. VAE encode the upscaled pixels back to latent
  nodes[String(baseId + 3)] = {
    class_type: "VAEEncode",
    inputs: { pixels: [String(baseId + 2), 0], vae: vaeRef },
  };
  // 5. Refine with KSampler at low denoise (default 0.382)
  nodes[String(baseId + 4)] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef,
      positive: positiveRef,
      negative: negativeRef,
      latent_image: [String(baseId + 3), 0],
      seed: seed + 3,
      steps: params.enhanceSteps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: params.enhanceDenoise,
    },
  };
  // 6. Decode refined latent back to pixels
  nodes[String(baseId + 5)] = {
    class_type: "VAEDecode",
    inputs: { samples: [String(baseId + 4), 0], vae: vaeRef },
  };
  return [String(baseId + 5), 0];
}

/**
 * Append a permissive face-repair pass (ADetailer replacement).
 *
 * Detects faces with Florence-2 (MIT, via ComfyUI-RMBG's `AILab_Florence2`,
 * "Phrase Grounding" on the prompt "face"), grows + feathers the returned region
 * mask, then redraws ONLY that region with a low-denoise img2img pass
 * (DifferentialDiffusion for smooth masked gradients) and composites it back.
 *
 * Replaces the former Ultralytics YOLOv8 (`UltralyticsDetectorProvider`) + Impact
 * `FaceDetailer` graph, which is AGPL-3.0 and was never bundled. Every node here is
 * permissive (Florence-2 = MIT, ComfyUI core = GPL, no AGPL). Node ids are
 * allocated collision-free, so the helper is safe to call many times per graph.
 * NOTE: unlike FaceDetailer this does not crop-upscale each face before redraw;
 * for tiny faces detail gain is lower. Returns the final image ref.
 */
function addFaceDetailer(
  nodes: Record<string, unknown>,
  params: GenerationParams,
  imageRef: [string, number],
  modelRef: [string, number],
  clipRef: [string, number],
  vaeRef: [string, number],
  positiveRef: [string, number],
  negativeRef: [string, number],
  seed: number,
  detectorId = "195",
  detailerId = "196"
): [string, number] {
  if (!params.adetailerEnabled) return imageRef;
  void clipRef; // legacy: the permissive redraw uses conditioning refs, not clip.

  // Collision-free 9-node block, seeded near the legacy ids so graphs stay readable.
  let base = Number(detectorId) || Number(detailerId) || 900;
  while (Array.from({ length: 9 }, (_, i) => nodes[String(base + i)]).some(Boolean)) base += 10;
  const nId = (o: number) => String(base + o);

  // 1) Florence-2 face detection -> filled region MASK (output index 1).
  nodes[nId(0)] = {
    class_type: "AILab_Florence2",
    inputs: {
      image: imageRef,
      model_name: FACE_DETECT.FLORENCE_MODEL,
      task: "Phrase Grounding (text boxes)",
      precision: "fp16",
      attention: "sdpa",
      fill_mask: true,
      text_prompt: FACE_DETECT.PROMPT,
    },
  };
  // 2) Grow + feather the mask (jaw/hairline coverage + seamless edge).
  nodes[nId(1)] = { class_type: "GrowMask", inputs: { mask: [nId(0), 1], expand: FACE_DETECT.BBOX_DILATION, tapered_corners: true } };
  nodes[nId(2)] = { class_type: "FeatherMask", inputs: { mask: [nId(1), 0], left: FACE_DETECT.FEATHER, top: FACE_DETECT.FEATHER, right: FACE_DETECT.FEATHER, bottom: FACE_DETECT.FEATHER } };
  // 3) Low-denoise masked redraw (DifferentialDiffusion smooths the boundary).
  nodes[nId(3)] = { class_type: "DifferentialDiffusion", inputs: { model: modelRef } };
  nodes[nId(4)] = { class_type: "VAEEncode", inputs: { pixels: imageRef, vae: vaeRef } };
  nodes[nId(5)] = { class_type: "SetLatentNoiseMask", inputs: { samples: [nId(4), 0], mask: [nId(2), 0] } };
  nodes[nId(6)] = {
    class_type: "KSampler",
    inputs: {
      model: [nId(3), 0],
      positive: positiveRef,
      negative: negativeRef,
      latent_image: [nId(5), 0],
      seed: seed + 2,
      steps: params.adetailerSteps,
      cfg: params.adetailerCfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: params.adetailerDenoise,
    },
  };
  nodes[nId(7)] = { class_type: "VAEDecode", inputs: { samples: [nId(6), 0], vae: vaeRef } };
  // 4) Composite the redrawn faces back over the original via the feathered mask.
  nodes[nId(8)] = {
    class_type: "ImageCompositeMasked",
    inputs: { destination: imageRef, source: [nId(7), 0], mask: [nId(2), 0], x: 0, y: 0, resize_source: false },
  };
  return [nId(8), 0];
}

// Video generation WITHOUT face: prompt-only AnimateDiff
function buildVideoPlainWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  nodes["6"] = { class_type: "EmptyLatentImage", inputs: { width: params.width, height: params.height, batch_size: params.frames } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.denoise } };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap" } };
  return nodes;
}

// Image-to-Video WITHOUT face: prompt + source image AnimateDiff
function buildI2VPlainWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  // Load source image and encode to latent
  nodes["20"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["21"] = { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["1", 2] } };
  // Repeat the single-frame latent across all frames
  nodes["22"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["21", 0], amount: params.frames } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["22", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.denoise } };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_I2V" } };
  return nodes;
}

// Still image WITHOUT face: prompt-only txt2img
function buildImagePlainWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["3"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  nodes["4"] = { class_type: "EmptyLatentImage", inputs: { width: params.width, height: params.height, batch_size: 1 } };
  nodes["5"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.denoise } };
  // HiRes Fix: upscale latent + second KSampler pass
  const hiresRef = addHiresFix(nodes, params, ["5", 0], modelRef, ["2", 0], ["3", 0], seed);
  nodes["6"] = { class_type: "VAEDecode", inputs: { samples: hiresRef, vae: ["1", 2] } };
  // Enhance Details: real upscaler + img2img refinement (Vek-Snap)
  const enhancedImg = addEnhanceDetails(nodes, params, ["6", 0], modelRef, ["2", 0], ["3", 0], ["1", 2], seed);
  // ADetailer: auto face refinement
  const finalImg = addFaceDetailer(nodes, params, enhancedImg, modelRef, clipRef, ["1", 2], ["2", 0], ["3", 0], seed);
  nodes["7"] = { class_type: "SaveImage", inputs: { images: finalImg, filename_prefix: "VekSnap" } };
  return nodes;
}

// ── Wan 2.1 Text-to-Video ──
function buildWanT2VWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: params.wanModel || WAN_MODELS.T2V_1_3B, weight_dtype: "fp8_e4m3fn" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: WAN_MODELS.TEXT_ENCODER, type: "wan" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: WAN_MODELS.VAE } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: ["2", 0] } },
    "6": { class_type: "WanImageToVideo", inputs: { positive: ["4", 0], negative: ["5", 0], vae: ["3", 0], width: params.width, height: params.height, length: params.frames, batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["6", 0], negative: ["6", 1], latent_image: ["6", 2], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.denoise } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_Wan" } },
  };
}

// ── Wan 2.1 Image-to-Video ──
function buildWanI2VWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: WAN_MODELS.I2V_480P_14B, weight_dtype: "fp8_e4m3fn" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: WAN_MODELS.TEXT_ENCODER, type: "wan" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: WAN_MODELS.VAE } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: ["2", 0] } },
    // Load and encode source image for CLIP vision
    "10": { class_type: "LoadImage", inputs: { image: params.sourceImage } },
    "11": { class_type: "CLIPVisionLoader", inputs: { clip_name: WAN_MODELS.CLIP_VISION } },
    "12": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["11", 0], image: ["10", 0], crop: "center" } },
    "6": { class_type: "WanImageToVideo", inputs: { positive: ["4", 0], negative: ["5", 0], vae: ["3", 0], width: params.width, height: params.height, length: params.frames, batch_size: 1, clip_vision_output: ["12", 0], start_image: ["10", 0] } },
    "7": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["6", 0], negative: ["6", 1], latent_image: ["6", 2], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.denoise } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_Wan_I2V" } },
  };
}

// ── WAN 2.2 S2V (Sound-to-Video with Lipsync) ──
// Pipeline: audio → AudioEncoder → WanSoundImageToVideo conditioning
//           ref image → WanSoundImageToVideo
//           Two-pass GGUF: High-Q model (partial steps) → Low-Q model (finish steps)
//           → VAE Decode → CreateVideo → SaveVideo
// Uses TrimAudioDuration to trim audio server-side based on user's trim selection.
export function buildWanS2VWorkflow(config: WanS2VConfig): Record<string, unknown> {
  const seed = config.randomSeed || config.seed < 0
    ? Math.floor(Math.random() * 2 ** 32)
    : config.seed;

  const nodes: Record<string, unknown> = {};
  const singleModel = config.highModel === config.lowModel;

  // ── Load GGUF UNET(s) ──
  nodes["20"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: config.highModel } };
  if (!singleModel) {
    nodes["21"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: config.lowModel } };
  }

  // ── CLIP + VAE (shared Wan models) ──
  nodes["2"] = { class_type: "CLIPLoader", inputs: { clip_name: WAN_MODELS.TEXT_ENCODER, type: "wan" } };
  nodes["3"] = { class_type: "VAELoader", inputs: { vae_name: WAN_MODELS.VAE } };

  // Track model/clip references through the LoRA chain
  let modelRef: [string, number] = ["20", 0];
  let lowRef: [string, number] = singleModel ? ["20", 0] : ["21", 0];
  let clipRef: [string, number] = ["2", 0];

  // ── Standard LoRAs ──
  const activeLoras = (config.loras || []).filter((l) => l.enabled && l.name);
  if (activeLoras.length > 0) {
    let nextId = 100;
    for (const lora of activeLoras) {
      const id = String(nextId++);
      nodes[id] = {
        class_type: "LoraLoader",
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strengthModel,
          strength_clip: lora.strengthClip,
          model: modelRef,
          clip: clipRef,
        },
      };
      modelRef = [id, 0];
      clipRef = [id, 1];
    }
    if (!singleModel) {
      for (const lora of activeLoras) {
        const id = String(nextId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: {
            lora_name: lora.name,
            strength_model: lora.strengthModel,
            strength_clip: 0,
            model: lowRef,
            clip: clipRef,
          },
        };
        lowRef = [id, 0];
      }
    }
  }

  // ── Paired WAN LoRAs (only relevant for two-pass with different H/L models) ──
  if (!singleModel) {
    const activePaired = (config.pairedLoras || []).filter((p) => p.enabled && (p.highName || p.lowName));
    if (activePaired.length > 0) {
      let nextId = 150;
      for (const pair of activePaired) {
        if (pair.highName) {
          const id = String(nextId++);
          nodes[id] = {
            class_type: "LoraLoader",
            inputs: { lora_name: pair.highName, strength_model: pair.strength, strength_clip: 0, model: modelRef, clip: clipRef },
          };
          modelRef = [id, 0];
        }
        if (pair.lowName) {
          const id = String(nextId++);
          nodes[id] = {
            class_type: "LoraLoader",
            inputs: { lora_name: pair.lowName, strength_model: pair.strength, strength_clip: 0, model: lowRef, clip: clipRef },
          };
          lowRef = [id, 0];
        }
      }
    }
  }

  // ── ModelSamplingSD3 shift (after LoRAs) ──
  nodes["22"] = { class_type: "ModelSamplingSD3", inputs: { model: modelRef, shift: config.shift } };
  modelRef = ["22", 0];
  if (!singleModel) {
    nodes["23"] = { class_type: "ModelSamplingSD3", inputs: { model: lowRef, shift: config.shift } };
    lowRef = ["23", 0];
  }

  // ── Text encoding ──
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: config.prompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: config.negativePrompt, clip: clipRef } };

  // ── Reference image ──
  nodes["10"] = { class_type: "LoadImage", inputs: { image: config.refImage } };

  // ── Audio pipeline (load → trim → encode) ──
  nodes["60"] = { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: WAN_S2V_MODELS.AUDIO_ENCODER } };
  nodes["61"] = { class_type: "LoadAudio", inputs: { audio: config.audioFile } };

  // TrimAudioDuration trims using the user's trim selection (start + duration in seconds)
  let audioRef: [string, number] = ["61", 0];
  if (config.audioTrimEnd > config.audioTrimStart) {
    const trimDuration = config.audioTrimEnd - config.audioTrimStart;
    nodes["62"] = {
      class_type: "TrimAudioDuration",
      inputs: {
        audio: ["61", 0],
        start_index: config.audioTrimStart,
        duration: trimDuration,
      },
    };
    audioRef = ["62", 0];
  }

  nodes["63"] = { class_type: "AudioEncoderEncode", inputs: { audio_encoder: ["60", 0], audio: audioRef } };

  // ── WanSoundImageToVideo conditioning ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s2vInputs: Record<string, any> = {
    positive: ["4", 0],
    negative: ["5", 0],
    vae: ["3", 0],
    width: config.width,
    height: config.height,
    length: config.frames,
    batch_size: 1,
    audio_encoder_output: ["63", 0],
    ref_image: ["10", 0],
  };
  nodes["6"] = { class_type: "WanSoundImageToVideo", inputs: s2vInputs };

  let samplerOut: [string, number];

  if (singleModel) {
    // ── Single-pass: one KSampler with the single model ──
    nodes["30"] = { class_type: "KSampler", inputs: {
      model: modelRef,
      positive: ["6", 0], negative: ["6", 1], latent_image: ["6", 2],
      seed,
      steps: config.totalSteps,
      cfg: config.cfg,
      sampler_name: config.sampler,
      scheduler: config.scheduler,
      denoise: 1.0,
    }};
    samplerOut = ["30", 0];
  } else {
    // ── Two-pass: KSamplerAdvanced with separate H/L models ──
    nodes["30"] = { class_type: "KSamplerAdvanced", inputs: {
      model: modelRef,
      positive: ["6", 0], negative: ["6", 1], latent_image: ["6", 2],
      add_noise: "enable",
      noise_seed: seed,
      steps: config.totalSteps,
      cfg: config.cfg,
      sampler_name: config.sampler,
      scheduler: config.scheduler,
      start_at_step: 0,
      end_at_step: config.pass1Steps,
      return_with_leftover_noise: "enable",
    }};
    nodes["31"] = { class_type: "KSamplerAdvanced", inputs: {
      model: lowRef,
      positive: ["6", 0], negative: ["6", 1], latent_image: ["30", 0],
      add_noise: "disable",
      noise_seed: seed + 1,
      steps: config.totalSteps,
      cfg: config.cfg,
      sampler_name: config.sampler,
      scheduler: config.scheduler,
      start_at_step: config.pass1Steps,
      end_at_step: 10000,
      return_with_leftover_noise: "disable",
    }};
    samplerOut = ["31", 0];
  }

  // ── Decode + save as video ──
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: samplerOut, vae: ["3", 0] } };
  nodes["40"] = { class_type: "CreateVideo", inputs: { fps: config.fps, images: ["8", 0] } };
  nodes["41"] = { class_type: "SaveVideo", inputs: { video: ["40", 0], filename_prefix: "video/VekSnap_WanS2V", format: "auto", codec: "auto" } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_WanS2V" } };

  return nodes;
}

// ── Wan Remix Two-Pass I2V (GGUF quantized, KSamplerAdvanced) ──
// Pipeline: source image → WanImageToVideo → Pass1 (high-Q model, add noise, partial steps)
//                                          → Pass2 (low-Q model, no noise, finish steps)
//                                          → VAE Decode → CreateVideo → SaveVideo
// Supports: standard LoRAs (applied to both models + CLIP), paired WAN LoRAs
//           (HIGH→pass1, LOW→pass2), and FaceID/IPAdapter conditioning.
function buildWanRemixI2VWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const isSvi = params.wanSviMode;
  const highModel = isSvi
    ? WAN_SVI_MODELS.HIGH_GGUF
    : (params.wanRemixHighModel || WAN_REMIX_MODELS.HIGH_Q);
  const lowModel = isSvi
    ? WAN_SVI_MODELS.LOW_GGUF
    : (params.wanRemixLowModel || WAN_REMIX_MODELS.LOW_Q);
  const shift = params.wanRemixShift ?? (isSvi ? WAN_SVI_MODELS.DEFAULT_SHIFT : 5.0);
  const pass1End = params.wanRemixPass1Steps ?? (isSvi ? WAN_SVI_MODELS.DEFAULT_STEPS_PASS1 : 3);
  const totalSteps = params.wanRemixTotalSteps ?? (isSvi ? WAN_SVI_MODELS.DEFAULT_STEPS_TOTAL : 4);
  const cfg = isSvi ? WAN_SVI_MODELS.DEFAULT_CFG : params.cfg;

  const nodes: Record<string, unknown> = {};

  // Load GGUF UNETs (high-Q for pass 1, low-Q for pass 2)
  nodes["20"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: highModel } };
  nodes["21"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: lowModel } };

  // CLIP + VAE (shared Wan models)
  nodes["2"] = { class_type: "CLIPLoader", inputs: { clip_name: WAN_MODELS.TEXT_ENCODER, type: "wan" } };
  nodes["3"] = { class_type: "VAELoader", inputs: { vae_name: WAN_MODELS.VAE } };

  // Track model/clip references through the LoRA chain
  let highRef: [string, number] = ["20", 0];
  let lowRef: [string, number] = ["21", 0];
  let clipRef: [string, number] = ["2", 0];
  // Keep a "clean" high reference before Lightning for 3-KSampler mode
  let highRefClean: [string, number] | null = null;

  // ── SVI LoRAs: applied first as base infrastructure layer ──
  if (isSvi) {
    const sviStr = params.wanSviLoraStrength ?? 1.0;
    // SVI PRO HIGH → high model
    nodes["60"] = {
      class_type: "LoraLoader",
      inputs: { lora_name: WAN_SVI_MODELS.SVI_LORA_HIGH, strength_model: sviStr, strength_clip: 0, model: highRef, clip: clipRef },
    };
    highRef = ["60", 0];
    // SVI PRO LOW → low model
    nodes["61"] = {
      class_type: "LoraLoader",
      inputs: { lora_name: WAN_SVI_MODELS.SVI_LORA_LOW, strength_model: sviStr, strength_clip: 0, model: lowRef, clip: clipRef },
    };
    lowRef = ["61", 0];

    // Snapshot clean high ref before Lightning (for 3-KSampler first pass)
    highRefClean = [...highRef] as [string, number];

    // Lightning LoRAs (optional speed boost)
    if (params.wanSviLightningEnabled) {
      const combo = WAN_SVI_LIGHTNING_COMBOS[params.wanSviLightningCombo ?? 1];
      const lightHighLora = combo.highRank === "r128" ? WAN_SVI_MODELS.LIGHTNING_HIGH_R128 : WAN_SVI_MODELS.LIGHTNING_HIGH_R64;
      nodes["62"] = {
        class_type: "LoraLoader",
        inputs: { lora_name: lightHighLora, strength_model: combo.highWeight, strength_clip: 0, model: highRef, clip: clipRef },
      };
      highRef = ["62", 0];
      nodes["63"] = {
        class_type: "LoraLoader",
        inputs: { lora_name: WAN_SVI_MODELS.LIGHTNING_LOW, strength_model: combo.lowWeight, strength_clip: 0, model: lowRef, clip: clipRef },
      };
      lowRef = ["63", 0];
    }
  }

  // ── Standard LoRAs: apply to high model + clip, then low model + clip ──
  const activeLoras = (params.loras || []).filter((l) => l.enabled && l.name);
  if (activeLoras.length > 0) {
    // Chain through high model (also updates clip)
    let nextId = 100;
    for (const lora of activeLoras) {
      const id = String(nextId++);
      nodes[id] = {
        class_type: "LoraLoader",
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strengthModel,
          strength_clip: lora.strengthClip,
          model: highRef,
          clip: clipRef,
        },
      };
      highRef = [id, 0];
      clipRef = [id, 1];
    }
    // Chain through low model (clip is already modified, just pass through)
    for (const lora of activeLoras) {
      const id = String(nextId++);
      nodes[id] = {
        class_type: "LoraLoader",
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strengthModel,
          strength_clip: 0, // clip already modified above; 0 = no double-apply
          model: lowRef,
          clip: clipRef,
        },
      };
      lowRef = [id, 0];
    }
  }

  // ── Paired WAN LoRAs: HIGH variant → pass-1 model, LOW variant → pass-2 model ──
  const activePaired = (params.wanPairedLoras || []).filter((p) => p.enabled && (p.highName || p.lowName));
  if (activePaired.length > 0) {
    let nextId = 150;
    for (const pair of activePaired) {
      if (pair.highName) {
        const id = String(nextId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: {
            lora_name: pair.highName,
            strength_model: pair.strength,
            strength_clip: 0, // model-only for paired loras
            model: highRef,
            clip: clipRef,
          },
        };
        highRef = [id, 0];
      }
      if (pair.lowName) {
        const id = String(nextId++);
        nodes[id] = {
          class_type: "LoraLoader",
          inputs: {
            lora_name: pair.lowName,
            strength_model: pair.strength,
            strength_clip: 0,
            model: lowRef,
            clip: clipRef,
          },
        };
        lowRef = [id, 0];
      }
    }
  }

  // ── ModelSamplingSD3 shift (after LoRAs, before FaceID) ──
  nodes["22"] = { class_type: "ModelSamplingSD3", inputs: { model: highRef, shift } };
  nodes["23"] = { class_type: "ModelSamplingSD3", inputs: { model: lowRef, shift } };
  highRef = ["22", 0];
  lowRef = ["23", 0];

  // Text encoding
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };

  // Source image
  nodes["10"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };

  // WanFirstLastFrameToVideo conditioning: correct mask format for Wan 2.2 models.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const witInputs: Record<string, any> = {
    positive: ["4", 0], negative: ["5", 0], vae: ["3", 0],
    width: params.width, height: params.height, length: params.frames, batch_size: 1,
    start_image: ["10", 0],
  };
  // Optional end_image → model generates toward that target frame
  if (params.wanRemixEndImage) {
    nodes["11"] = { class_type: "LoadImage", inputs: { image: params.wanRemixEndImage } };
    witInputs.end_image = ["11", 0];
  }
  nodes["6"] = { class_type: "WanFirstLastFrameToVideo", inputs: witInputs };

  // ── Sampling passes ──
  // 3-KSampler mode (SVI): first step uses HIGH model WITHOUT Lightning for structure
  let latentForPass1: [string, number] = ["6", 2];
  const actualPass1Start = (isSvi && params.wanSviTripleKSampler && params.wanSviLightningEnabled && highRefClean) ? 1 : 0;

  if (isSvi && params.wanSviTripleKSampler && params.wanSviLightningEnabled && highRefClean) {
    // Pass 0: one clean step with HIGH model (no Lightning) - establishes image structure
    // Apply shift to the clean high model too
    nodes["29a"] = { class_type: "ModelSamplingSD3", inputs: { model: highRefClean, shift } };
    nodes["29"] = { class_type: "KSamplerAdvanced", inputs: {
      model: ["29a", 0],
      positive: ["6", 0], negative: ["6", 1], latent_image: ["6", 2],
      add_noise: "enable",
      noise_seed: seed,
      steps: totalSteps,
      cfg: params.wanSviCleanStepCfg ?? WAN_SVI_MODELS.DEFAULT_CLEAN_CFG,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      start_at_step: 0,
      end_at_step: 1,
      return_with_leftover_noise: "enable",
    }};
    latentForPass1 = ["29", 0];
  }

  // Pass 1: High-Q model - initial denoising (add noise if no pass-0, return leftover)
  nodes["30"] = { class_type: "KSamplerAdvanced", inputs: {
    model: highRef,
    positive: ["6", 0], negative: ["6", 1], latent_image: latentForPass1,
    add_noise: actualPass1Start === 0 ? "enable" : "disable",
    noise_seed: seed,
    steps: totalSteps,
    cfg,
    sampler_name: params.sampler,
    scheduler: params.scheduler,
    start_at_step: actualPass1Start,
    end_at_step: pass1End,
    return_with_leftover_noise: "enable",
  }};

  // Pass 2: Low-Q model - refinement (no noise add, finalize)
  nodes["31"] = { class_type: "KSamplerAdvanced", inputs: {
    model: lowRef,
    positive: ["6", 0], negative: ["6", 1], latent_image: ["30", 0],
    add_noise: "disable",
    noise_seed: seed + 1,
    steps: totalSteps,
    cfg,
    sampler_name: params.sampler,
    scheduler: params.scheduler,
    start_at_step: pass1End,
    end_at_step: 10000,
    return_with_leftover_noise: "disable",
  }};

  // Decode + save as video
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["31", 0], vae: ["3", 0] } };
  nodes["40"] = { class_type: "CreateVideo", inputs: { fps: params.fps, images: ["8", 0] } };
  nodes["41"] = { class_type: "SaveVideo", inputs: { video: ["40", 0], filename_prefix: "video/VekSnap_WanRemix", format: "auto", codec: "auto" } };
  // Also save individual frames for gallery view
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_WanRemix" } };

  return nodes;
}

// ── Wan Remix Storyboard: Multi-Segment Extended Video ──
// Chains N segments using per-segment keyframes (start/end reference images).
// Reference image priority for each segment:
//   1. Segment's own startImageFile (user-uploaded keyframe)
//   2. Previous segment's endImageFile (user-uploaded end keyframe)
//   3. Extracted last frame from previous segment's decoded output
//   4. Main source image (segment 0 only, as fallback)
// All decoded image batches are concatenated (skipping duplicate overlap frames)
// into a single continuous video.
function buildWanRemixExtendedWorkflow(params: GenerationParams): Record<string, unknown> {
  const segments = params.storyboardSegments;
  const numSegments = segments.length;
  const seed = getSeed(params);
  const isSvi = params.wanSviMode;
  const highModel = isSvi
    ? WAN_SVI_MODELS.HIGH_GGUF
    : (params.wanRemixHighModel || WAN_REMIX_MODELS.HIGH_Q);
  const lowModel = isSvi
    ? WAN_SVI_MODELS.LOW_GGUF
    : (params.wanRemixLowModel || WAN_REMIX_MODELS.LOW_Q);
  const shift = params.wanRemixShift ?? (isSvi ? WAN_SVI_MODELS.DEFAULT_SHIFT : 5.0);
  const pass1End = params.wanRemixPass1Steps ?? (isSvi ? WAN_SVI_MODELS.DEFAULT_STEPS_PASS1 : 3);
  const totalSteps = params.wanRemixTotalSteps ?? (isSvi ? WAN_SVI_MODELS.DEFAULT_STEPS_TOTAL : 4);
  const cfg = isSvi ? WAN_SVI_MODELS.DEFAULT_CFG : params.cfg;

  const nodes: Record<string, unknown> = {};

  // ── Shared model infrastructure (same as single-segment) ──
  nodes["20"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: highModel } };
  nodes["21"] = { class_type: "UnetLoaderGGUF", inputs: { unet_name: lowModel } };
  nodes["2"] = { class_type: "CLIPLoader", inputs: { clip_name: WAN_MODELS.TEXT_ENCODER, type: "wan" } };
  nodes["3"] = { class_type: "VAELoader", inputs: { vae_name: WAN_MODELS.VAE } };

  let highRef: [string, number] = ["20", 0];
  let lowRef: [string, number] = ["21", 0];
  let clipRef: [string, number] = ["2", 0];
  let highRefClean: [string, number] | null = null;

  // ── SVI LoRAs: applied first as base infrastructure layer ──
  if (isSvi) {
    const sviStr = params.wanSviLoraStrength ?? 1.0;
    nodes["60"] = { class_type: "LoraLoader", inputs: { lora_name: WAN_SVI_MODELS.SVI_LORA_HIGH, strength_model: sviStr, strength_clip: 0, model: highRef, clip: clipRef } };
    highRef = ["60", 0];
    nodes["61"] = { class_type: "LoraLoader", inputs: { lora_name: WAN_SVI_MODELS.SVI_LORA_LOW, strength_model: sviStr, strength_clip: 0, model: lowRef, clip: clipRef } };
    lowRef = ["61", 0];
    highRefClean = [...highRef] as [string, number];
    if (params.wanSviLightningEnabled) {
      const combo = WAN_SVI_LIGHTNING_COMBOS[params.wanSviLightningCombo ?? 1];
      const lightHighLora = combo.highRank === "r128" ? WAN_SVI_MODELS.LIGHTNING_HIGH_R128 : WAN_SVI_MODELS.LIGHTNING_HIGH_R64;
      nodes["62"] = { class_type: "LoraLoader", inputs: { lora_name: lightHighLora, strength_model: combo.highWeight, strength_clip: 0, model: highRef, clip: clipRef } };
      highRef = ["62", 0];
      nodes["63"] = { class_type: "LoraLoader", inputs: { lora_name: WAN_SVI_MODELS.LIGHTNING_LOW, strength_model: combo.lowWeight, strength_clip: 0, model: lowRef, clip: clipRef } };
      lowRef = ["63", 0];
    }
  }

  // ── Standard LoRAs ──
  const activeLoras = (params.loras || []).filter((l) => l.enabled && l.name);
  if (activeLoras.length > 0) {
    let nextId = 100;
    for (const lora of activeLoras) {
      const id = String(nextId++);
      nodes[id] = { class_type: "LoraLoader", inputs: { lora_name: lora.name, strength_model: lora.strengthModel, strength_clip: lora.strengthClip, model: highRef, clip: clipRef } };
      highRef = [id, 0];
      clipRef = [id, 1];
    }
    for (const lora of activeLoras) {
      const id = String(nextId++);
      nodes[id] = { class_type: "LoraLoader", inputs: { lora_name: lora.name, strength_model: lora.strengthModel, strength_clip: 0, model: lowRef, clip: clipRef } };
      lowRef = [id, 0];
    }
  }

  // ── Paired WAN LoRAs ──
  const activePaired = (params.wanPairedLoras || []).filter((p) => p.enabled && (p.highName || p.lowName));
  if (activePaired.length > 0) {
    let nextId = 150;
    for (const pair of activePaired) {
      if (pair.highName) {
        const id = String(nextId++);
        nodes[id] = { class_type: "LoraLoader", inputs: { lora_name: pair.highName, strength_model: pair.strength, strength_clip: 0, model: highRef, clip: clipRef } };
        highRef = [id, 0];
      }
      if (pair.lowName) {
        const id = String(nextId++);
        nodes[id] = { class_type: "LoraLoader", inputs: { lora_name: pair.lowName, strength_model: pair.strength, strength_clip: 0, model: lowRef, clip: clipRef } };
        lowRef = [id, 0];
      }
    }
  }

  // ── ModelSamplingSD3 shift ──
  nodes["22"] = { class_type: "ModelSamplingSD3", inputs: { model: highRef, shift } };
  nodes["23"] = { class_type: "ModelSamplingSD3", inputs: { model: lowRef, shift } };
  highRef = ["22", 0];
  lowRef = ["23", 0];

  // Shared negative prompt
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };

  // Source image (fallback reference for segment 0 when no keyframe is set)
  // Only create node "10" if sourceImage is set, otherwise ComfyUI validation
  // fails on the null path even if the node is unreferenced.
  if (params.sourceImage) {
    nodes["10"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  }

  // Color drift correction reference: prefer sourceImage, but will be updated
  // to segment 0's start image if sourceImage is absent.
  let colorRef: [string, number] | null = params.sourceImage ? ["10", 0] : null;

  // ── Generate segments ──
  // Each segment gets 20 node IDs: base = 200 + seg * 20
  // +0: CLIPTextEncode, +1: WanImageToVideo, +2: KSampler Pass1,
  // +3: KSampler Pass2, +4: VAEDecode, +5: ImageFromBatch (last frame),
  // +6: LoadImage (start keyframe), +7: LoadImage (end keyframe)
  let autoLastFrameRef: [string, number] | null = params.sourceImage ? ["10", 0] : null; // extracted last frame chain
  const decodedImageRefs: [string, number][] = [];

  for (let s = 0; s < numSegments; s++) {
    const seg = segments[s];
    const base = 200 + s * 20;
    const segSeed = seed + s;

    // ── Determine this segment's reference (start) image ──
    // Priority: 1) own startImageFile, 2) prev endImageFile, 3) auto last frame, 4) source image
    let startRef: [string, number];
    if (seg.startImageFile) {
      const loadId = String(base + 6);
      nodes[loadId] = { class_type: "LoadImage", inputs: { image: seg.startImageFile } };
      startRef = [loadId, 0];
      // Use segment 0's start image as color reference when no sourceImage
      if (s === 0 && !colorRef) colorRef = [loadId, 0];
    } else if (s > 0 && segments[s - 1].endImageFile) {
      const loadId = String(base + 7);
      nodes[loadId] = { class_type: "LoadImage", inputs: { image: segments[s - 1].endImageFile } };
      startRef = [loadId, 0];
    } else {
      startRef = autoLastFrameRef!; // source image for seg 0, extracted last frame for seg 1+
    }

    // CLIP encode this segment's positive prompt (fall back to main prompt if empty)
    const posId = String(base);
    const segPrompt = seg.prompt?.trim() || params.positivePrompt;
    nodes[posId] = { class_type: "CLIPTextEncode", inputs: { text: segPrompt, clip: clipRef } };

    // WanFirstLastFrameToVideo conditioning: correct mask format for Wan 2.2 models.
    // When endImageFile is set → pass as end_image so model generates toward that frame.
    // When endImageFile is absent → omit end_image so model generates freely (no looping).
    const witId = String(base + 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const witInputs: Record<string, any> = {
      positive: [posId, 0], negative: ["5", 0], vae: ["3", 0],
      width: params.width, height: params.height, length: params.frames, batch_size: 1,
      start_image: startRef,
    };
    if (seg.endImageFile) {
      const endLoadId = String(base + 8);
      nodes[endLoadId] = { class_type: "LoadImage", inputs: { image: seg.endImageFile } };
      witInputs.end_image = [endLoadId, 0];
    }
    nodes[witId] = { class_type: "WanFirstLastFrameToVideo", inputs: witInputs };

    // ── Sampling passes (with optional 3-KSampler for SVI) ──
    let latentForPass1: [string, number] = [witId, 2];
    const useTriple = isSvi && params.wanSviTripleKSampler && params.wanSviLightningEnabled && highRefClean;
    const actualPass1Start = useTriple ? 1 : 0;

    if (useTriple) {
      // Pass 0: one clean step with HIGH model (no Lightning)
      const ks0ShiftId = String(base + 10);
      nodes[ks0ShiftId] = { class_type: "ModelSamplingSD3", inputs: { model: highRefClean, shift } };
      const ks0Id = String(base + 11);
      nodes[ks0Id] = { class_type: "KSamplerAdvanced", inputs: {
        model: [ks0ShiftId, 0],
        positive: [witId, 0], negative: [witId, 1], latent_image: [witId, 2],
        add_noise: "enable",
        noise_seed: segSeed,
        steps: totalSteps,
        cfg: params.wanSviCleanStepCfg ?? WAN_SVI_MODELS.DEFAULT_CLEAN_CFG,
        sampler_name: params.sampler,
        scheduler: params.scheduler,
        start_at_step: 0,
        end_at_step: 1,
        return_with_leftover_noise: "enable",
      }};
      latentForPass1 = [ks0Id, 0];
    }

    // Pass 1: High-Q model (add noise if no pass-0, partial steps)
    const ks1Id = String(base + 2);
    nodes[ks1Id] = { class_type: "KSamplerAdvanced", inputs: {
      model: highRef,
      positive: [witId, 0], negative: [witId, 1], latent_image: latentForPass1,
      add_noise: actualPass1Start === 0 ? "enable" : "disable",
      noise_seed: segSeed,
      steps: totalSteps,
      cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      start_at_step: actualPass1Start,
      end_at_step: pass1End,
      return_with_leftover_noise: "enable",
    }};

    // Pass 2: Low-Q model (no noise, finish steps)
    const ks2Id = String(base + 3);
    nodes[ks2Id] = { class_type: "KSamplerAdvanced", inputs: {
      model: lowRef,
      positive: [witId, 0], negative: [witId, 1], latent_image: [ks1Id, 0],
      add_noise: "disable",
      noise_seed: segSeed + 1000,
      steps: totalSteps,
      cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      start_at_step: pass1End,
      end_at_step: 10000,
      return_with_leftover_noise: "disable",
    }};

    // VAE Decode this segment
    const decId = String(base + 4);
    nodes[decId] = { class_type: "VAEDecode", inputs: { samples: [ks2Id, 0], vae: ["3", 0] } };

    // Extract last frame for next segment's auto-reference (skip for final segment)
    if (s < numSegments - 1) {
      const lastId = String(base + 5);
      nodes[lastId] = { class_type: "ImageFromBatch", inputs: {
        image: [decId, 0],
        batch_index: params.frames - 1,
        length: 1,
      }};
      autoLastFrameRef = [lastId, 0];

      // Color drift correction: histogram-match the extracted last frame
      // against the original source/keyframe image to prevent cumulative saturation shift
      // from repeated VAE decode→encode round-trips at segment boundaries.
      const ccStrength = params.segmentColorCorrection ?? 0;
      if (ccStrength > 0 && colorRef) {
        const ccId = String(base + 9);
        nodes[ccId] = { class_type: "VekSnapColorMatch", inputs: {
          image: [lastId, 0],
          reference: colorRef,  // source image or segment 0's start keyframe
          strength: ccStrength,
        }};
        autoLastFrameRef = [ccId, 0];
      }
    }

    decodedImageRefs.push([decId, 0]);
  }

  // ── Final assembly: trim overlap frames & concatenate ──
  // Segment 0: keep all frames. Segments 1+: skip first frame (near-duplicate of prev last).
  const trimmedRefs: [string, number][] = [];
  for (let s = 0; s < numSegments; s++) {
    if (s === 0) {
      trimmedRefs.push(decodedImageRefs[s]);
    } else {
      const trimId = String(2100 + s);
      nodes[trimId] = { class_type: "ImageFromBatch", inputs: {
        image: decodedImageRefs[s],
        batch_index: 1,
        length: params.frames - 1,
      }};
      trimmedRefs.push([trimId, 0]);
    }
  }

  // Chain ImageBatch nodes to build the full frame sequence
  let combinedRef = trimmedRefs[0];
  for (let s = 1; s < numSegments; s++) {
    const batchId = String(2200 + s);
    nodes[batchId] = { class_type: "ImageBatch", inputs: {
      image1: combinedRef,
      image2: trimmedRefs[s],
    }};
    combinedRef = [batchId, 0];
  }

  // Save final video + frames
  nodes["2010"] = { class_type: "CreateVideo", inputs: { fps: params.fps, images: combinedRef } };
  nodes["2011"] = { class_type: "SaveVideo", inputs: { video: ["2010", 0], filename_prefix: "video/VekSnap_WanRemix", format: "auto", codec: "auto" } };
  nodes["2012"] = { class_type: "SaveImage", inputs: { images: combinedRef, filename_prefix: "VekSnap_WanRemix" } };

  return nodes;
}

// ── Inpaint helpers ──
// Resolve effective denoise for compose/inpaint workflows.
// Uses inpaintStrength (Vek-Snap) instead of generic denoise.
function getComposeInpaintDenoise(params: GenerationParams): number {
  return params.inpaintStrength;
}

// Merge inpaintAdditionalPrompt into positive prompt when set.
function resolveInpaintPrompt(params: GenerationParams): string {
  const base = params.positivePrompt;
  const extra = params.inpaintAdditionalPrompt?.trim();
  if (!extra) return base;
  return base ? `${base}, ${extra}` : extra;
}

// Apply mask erode/dilate and invert via ComfyUI nodes.
// Returns the (possibly processed) mask reference.
// Uses GrowMask (positive=dilate, negative=erode) and InvertMask.
function applyMaskProcessing(
  nodes: Record<string, unknown>,
  maskRef: [string, number],
  params: GenerationParams,
  nodeIdBase: string = "52",
): [string, number] {
  let ref = maskRef;
  // Erode/dilate: GrowMask with expand=pixels (negative = erode)
  if (params.inpaintErodeDilate !== 0) {
    const id = `${nodeIdBase}e`;
    nodes[id] = { class_type: "GrowMask", inputs: { mask: ref, expand: params.inpaintErodeDilate, tapered_corners: true } };
    ref = [id, 0];
  }
  // Invert mask
  if (params.inpaintInvertMask) {
    const id = `${nodeIdBase}i`;
    nodes[id] = { class_type: "InvertMask", inputs: { mask: ref } };
    ref = [id, 0];
  }
  return ref;
}

// ── Content-Aware Fill/Removal Engine (BrushNet / PowerPaint / DifferentialDiffusion) ──
// Commercial-safe successor to a retired third-party inpaint engine (which called the
// custom nodes VEKSNAP_LoadInpaintPatch / VEKSNAP_ApplyInpaintPatch on an unregistered/unlicensed
// inpaint patch weight). Three engines:
//   diffdiff   : DifferentialDiffusion patch on the base model; reuses the noise-masked latent
//                built by buildContextAwareLatent*(). Zero downloads. Default.
//   brushnet   : BrushNetLoader + BrushNet - plug-and-play SOTA inpaint (SDXL/SD1.5/Pony).
//   powerpaint : BrushNetLoader + PowerPaintCLIPLoader + PowerPaint - dedicated object removal.
// BrushNet/PowerPaint consume the raw context image + mask and emit their own patched model +
// conditioning + zero latent for the KSampler. Node IDs are string-namespaced ("ce_*") to avoid
// collisions with the numeric IDs used by the surrounding scaffolding.
function applyContentAwareEngine(
  nodes: Record<string, unknown>,
  params: GenerationParams,
  modelRef: [string, number],
  vaeRef: [string, number],
  posRef: [string, number],
  negRef: [string, number],
  imageRef: [string, number],
  maskRef: [string, number],
  // Only used by the diffdiff branch. External engines (BrushNet/PowerPaint) emit their
  // own latent, so callers may pass null and skip building SetLatentNoiseMask entirely.
  diffdiffLatentRef: [string, number] | null,
): { modelRef: [string, number]; posRef: [string, number]; negRef: [string, number]; latentRef: [string, number] } {
  const engine = params.contentAwareEngine ?? "diffdiff";
  const scale = params.brushnetScale ?? 1.0;

  if (engine === "brushnet") {
    const arch = getCheckpointArch(params.checkpointSizeBytes, params.checkpoint);
    const file = arch === "sdxl" ? BRUSHNET_MODELS.SDXL : BRUSHNET_MODELS.SD15;
    nodes["ce_load"] = { class_type: "BrushNetLoader", inputs: { brushnet: file, dtype: "float16" } };
    nodes["ce_apply"] = {
      class_type: "BrushNet",
      inputs: {
        model: modelRef, vae: vaeRef, image: imageRef, mask: maskRef,
        brushnet: ["ce_load", 0], positive: posRef, negative: negRef,
        scale, start_at: 0, end_at: 10000,
      },
    };
    return { modelRef: ["ce_apply", 0], posRef: ["ce_apply", 1], negRef: ["ce_apply", 2], latentRef: ["ce_apply", 3] };
  }

  if (engine === "powerpaint") {
    nodes["ce_load"] = { class_type: "BrushNetLoader", inputs: { brushnet: POWERPAINT_MODELS.BRUSHNET, dtype: "float16" } };
    nodes["ce_ppclip"] = { class_type: "PowerPaintCLIPLoader", inputs: { base: POWERPAINT_MODELS.BASE_CLIP, powerpaint: POWERPAINT_MODELS.CLIP } };
    nodes["ce_apply"] = {
      class_type: "PowerPaint",
      inputs: {
        model: modelRef, vae: vaeRef, image: imageRef, mask: maskRef,
        powerpaint: ["ce_load", 0], clip: ["ce_ppclip", 0],
        positive: posRef, negative: negRef,
        fitting: 1.0,
        function: params.objectRemoval ? "object removal" : "text guided",
        scale, start_at: 0, end_at: 10000, save_memory: "none",
      },
    };
    return { modelRef: ["ce_apply", 0], posRef: ["ce_apply", 1], negRef: ["ce_apply", 2], latentRef: ["ce_apply", 3] };
  }

  // diffdiff fallback: DifferentialDiffusion patch, reuse the noise-masked latent.
  if (!diffdiffLatentRef) throw new Error("diffdiff content-aware engine requires a noise-masked latent");
  nodes["ce_load"] = { class_type: "DifferentialDiffusion", inputs: { model: modelRef } };
  return { modelRef: ["ce_load", 0], posRef, negRef, latentRef: diffdiffLatentRef };
}

// Positive prompt for content-aware modes. Object removal seeds an "empty scene"
// so the fill inpaints background rather than a new subject (all engines benefit).
function resolveContentAwarePrompt(params: GenerationParams): string {
  if (params.objectRemoval) return "empty scene blur";
  return resolveInpaintPrompt(params);
}

// BrushNet/PowerPaint require the raw image+mask (not a pre-encoded latent). This
// determines whether the selected engine bypasses the noise-masked latent path.
function usesExternalCAEngine(params: GenerationParams): boolean {
  const e = params.contentAwareEngine ?? "diffdiff";
  return e === "brushnet" || e === "powerpaint";
}

// ── Content-Aware Compose helpers ──
// When contentAware is ON, we load a padded context crop + mask.
// SetLatentNoiseMask tells the sampler to only denoise the white (inner) area.
// After sampling, LatentCrop extracts the inner region → output matches region dims.

function buildContextAwareLatent(
  nodes: Record<string, unknown>,
  params: GenerationParams,
): { latentRef: [string, number]; vaeRef: [string, number] } {
  const r = params.regionInfo!;
  // Vek-Snap: use filled image when denoise > 0.99 (full regen),
  // otherwise use original/context image (partial denoise preserves original)
  const effectiveDenoise = getComposeInpaintDenoise(params);
  const useFill = r.filledImageFile && effectiveDenoise > 0.99;
  const imageFile = useFill ? r.filledImageFile! : r.contextImageFile;
  nodes["50"] = { class_type: "LoadImage", inputs: { image: imageFile } };
  // Load mask + apply erode/dilate/invert
  nodes["52"] = { class_type: "LoadImageMask", inputs: { image: r.maskImageFile, channel: "red" } };
  const maskRef = applyMaskProcessing(nodes, ["52", 0], params, "52");
  // Use VAEEncodeForInpaint when mask grow is set (better edge blending)
  if (params.inpaintMaskGrow > 0) {
    nodes["51"] = { class_type: "VAEEncodeForInpaint", inputs: { pixels: ["50", 0], vae: ["1", 2], mask: maskRef, grow_mask_by: params.inpaintMaskGrow } };
  } else {
    nodes["51"] = { class_type: "VAEEncode", inputs: { pixels: ["50", 0], vae: ["1", 2] } };
    nodes["53"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["51", 0], mask: maskRef } };
  }
  const latentMaskedRef: [string, number] = params.inpaintMaskGrow > 0 ? ["51", 0] : ["53", 0];
  // Repeat across frames
  nodes["54"] = { class_type: "RepeatLatentBatch", inputs: { samples: latentMaskedRef, amount: params.frames } };
  return { latentRef: ["54", 0], vaeRef: ["1", 2] };
}

// Still-image variant: no RepeatLatentBatch
function buildContextAwareLatentStill(
  nodes: Record<string, unknown>,
  params: GenerationParams,
): { latentRef: [string, number]; vaeRef: [string, number]; imageRef: [string, number]; maskRef: [string, number] } {
  const r = params.regionInfo!;
  // Vek-Snap: use filled image when denoise > 0.99 (full regen)
  const effectiveDenoise = getComposeInpaintDenoise(params);
  const useFill = r.filledImageFile && effectiveDenoise > 0.99;
  const imageFile = useFill ? r.filledImageFile! : r.contextImageFile;
  nodes["50"] = { class_type: "LoadImage", inputs: { image: imageFile } };
  // Resize image to target generation resolution (allows user to generate at
  // a different size than the input image, e.g. scale down a 4K photo to 1024px)
  const noPad = (r.padLeft ?? 0) === 0 && (r.padTop ?? 0) === 0;
  let imgRef: [string, number] = ["50", 0];
  if (noPad && (params.width !== r.contextWidth || params.height !== r.contextHeight)) {
    nodes["50a"] = { class_type: "ImageScale", inputs: { image: ["50", 0], upscale_method: "lanczos", width: params.width, height: params.height, crop: "disabled" } };
    imgRef = ["50a", 0];
  }
  // Load mask + apply erode/dilate/invert
  // Note: mask is auto-resized to match latent dims by ComfyUI's prepare_mask at sample time,
  // and by VAEEncodeForInpaint when inpaintMaskGrow > 0. The uploaded mask should already be at
  // the same dimensions as the context image (ensured by page.tsx upload logic).
  nodes["52"] = { class_type: "LoadImageMask", inputs: { image: r.maskImageFile, channel: "red" } };
  const maskRef = applyMaskProcessing(nodes, ["52", 0], params, "52");
  // Use VAEEncodeForInpaint when mask grow is set (better edge blending)
  if (params.inpaintMaskGrow > 0) {
    nodes["51"] = { class_type: "VAEEncodeForInpaint", inputs: { pixels: imgRef, vae: ["1", 2], mask: maskRef, grow_mask_by: params.inpaintMaskGrow } };
  } else {
    nodes["51"] = { class_type: "VAEEncode", inputs: { pixels: imgRef, vae: ["1", 2] } };
    nodes["53"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["51", 0], mask: maskRef } };
  }
  const latentMaskedRef: [string, number] = params.inpaintMaskGrow > 0 ? ["51", 0] : ["53", 0];
  return { latentRef: latentMaskedRef, vaeRef: ["1", 2], imageRef: imgRef, maskRef };
}

function addContextAwareCrop(
  nodes: Record<string, unknown>,
  samplerOutputRef: [string, number],
  params: GenerationParams,
): [string, number] {
  const r = params.regionInfo!;
  // Paint-mask path (no padding) → no crop needed, latent IS the full output
  const noPad = (r.padLeft ?? 0) === 0 && (r.padTop ?? 0) === 0;
  if (noPad) return samplerOutputRef;
  // Crop latent back to inner region (LatentCrop coords in pixels, node divides by 8)
  nodes["55"] = {
    class_type: "LatentCrop",
    inputs: {
      samples: samplerOutputRef,
      width: r.width,
      height: r.height,
      x: r.padLeft ?? 0,
      y: r.padTop ?? 0,
    },
  };
  return ["55", 0];
}

// Vek-Snap post-composite (color_correction equivalent):
// Composites generated result back onto ORIGINAL source image using
// the soft gradient mask (morphological_open) for seamless edge blending.
// Only activates for paint-mask path when softMaskFile is available.
// When cropX/Y/W/H are set (intelligent crop), the generated result is first
// scaled back to the crop dimensions, then pasted at (cropX, cropY) on the original.
function addVekSnapPostComposite(
  nodes: Record<string, unknown>,
  decodedRef: [string, number],
  params: GenerationParams,
): [string, number] {
  const r = params.regionInfo;
  if (!r) return decodedRef;
  // Only apply for paint-mask inpainting (no padding, soft mask available)
  const noPad = (r.padLeft ?? 0) === 0 && (r.padTop ?? 0) === 0;
  if (!noPad || !r.softMaskFile) return decodedRef;

  // Load original source image and soft gradient mask
  nodes["57"] = { class_type: "LoadImage", inputs: { image: r.sourceImageFile } };
  nodes["56"] = { class_type: "LoadImageMask", inputs: { image: r.softMaskFile, channel: "red" } };

  // Vek-Snap intelligent crop path: two-step process:
  // Step 1: Hard-paste the scaled result into the original at crop position (no mask blending)
  // Step 2: Soft-blend the pasted image with the original using the full-size gradient mask
  // NOTE: ComfyUI's composite() resizes the mask to match SOURCE dimensions, so we can't pass
  // a srcW×srcH mask with a cropW×cropH source, it would squish the mask. The two-step
  // approach avoids this by ensuring source and mask are both at srcW×srcH in step 2.
  const hasCrop = r.cropX != null && r.cropY != null && r.cropW != null && r.cropH != null;
  if (hasCrop) {
    // Step 1: Scale generated image to crop dims, hard-paste onto original (no mask)
    nodes["59"] = { class_type: "ImageScale", inputs: { image: decodedRef, upscale_method: "lanczos", width: r.cropW!, height: r.cropH!, crop: "disabled" } };
    nodes["58a"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["57", 0], source: ["59", 0], x: r.cropX!, y: r.cropY!, resize_source: false } };
    // Step 2: Soft-blend pasted result with original using gradient mask (both at srcW×srcH)
    nodes["58"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["57", 0], source: ["58a", 0], mask: ["56", 0], x: 0, y: 0, resize_source: false } };
  } else {
    // No crop: generated image is at full source resolution, composite directly
    nodes["58"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["57", 0], source: decodedRef, mask: ["56", 0], x: 0, y: 0, resize_source: true } };
  }
  return ["58", 0];
}

// ── Content-Aware Compose: Inpaint ──
function buildComposeInpaintContextAwareWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  // Context-aware latent (padded image + mask)
  const { latentRef } = buildContextAwareLatent(nodes, params);
  // Content-aware smoothing on the AnimateDiff model (DifferentialDiffusion; BrushNet/PowerPaint are still-image only)
  nodes["60"] = { class_type: "DifferentialDiffusion", inputs: { model: ["3", 0] } };
  const inpaintModelRef: [string, number] = ["60", 0];
  nodes["7"] = { class_type: "KSampler", inputs: { model: inpaintModelRef, positive: ["4", 0], negative: ["5", 0], latent_image: latentRef, seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: getComposeInpaintDenoise(params) } };
  // Crop back to inner region
  const croppedRef = addContextAwareCrop(nodes, ["7", 0], params);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: croppedRef, vae: ["1", 2] } };
  const finalRef = addVekSnapPostComposite(nodes, ["8", 0], params);
  nodes["9"] = { class_type: "SaveImage", inputs: { images: finalRef, filename_prefix: `VekSnap_Compose_CA_${w}x${h}` } };
  return nodes;
}

// ── Content-Aware Compose: Overlay (context-aware + RMBG) ──
function buildComposeOverlayContextAwareWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  const { latentRef } = buildContextAwareLatent(nodes, params);
  // Overlay always uses denoise 1.0, we want fully new content in the masked region
  nodes["7"] = { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: latentRef, seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 } };
  const croppedRef = addContextAwareCrop(nodes, ["7", 0], params);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: croppedRef, vae: ["1", 2] } };
  const finalRef2 = addVekSnapPostComposite(nodes, ["8", 0], params);
  nodes["30"] = { class_type: "RMBG", inputs: { image: finalRef2, model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: finalRef2, filename_prefix: `VekSnap_Overlay_CA_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Overlay_CA_${w}x${h}` } };
  return nodes;
}

// ── Content-Aware Compose: Combined (context-aware inpaint + RMBG) ──
function buildComposeCombinedContextAwareWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  const { latentRef } = buildContextAwareLatent(nodes, params);
  // Content-aware smoothing on the AnimateDiff model (DifferentialDiffusion; BrushNet/PowerPaint are still-image only)
  nodes["60"] = { class_type: "DifferentialDiffusion", inputs: { model: ["3", 0] } };
  const inpaintModelRef: [string, number] = ["60", 0];
  nodes["7"] = { class_type: "KSampler", inputs: { model: inpaintModelRef, positive: ["4", 0], negative: ["5", 0], latent_image: latentRef, seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: getComposeInpaintDenoise(params) } };
  const croppedRef = addContextAwareCrop(nodes, ["7", 0], params);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: croppedRef, vae: ["1", 2] } };
  const finalRef3 = addVekSnapPostComposite(nodes, ["8", 0], params);
  nodes["30"] = { class_type: "RMBG", inputs: { image: finalRef3, model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: finalRef3, filename_prefix: `VekSnap_Combined_CA_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Combined_CA_${w}x${h}` } };
  return nodes;
}

// ── Compose: Region Inpaint (img2img on cropped region via AnimateDiff) ──
// The sourceImage is the cropped region. Generates at region dimensions.
function buildComposeInpaintWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  // Load cropped region and encode to latent
  nodes["20"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["21"] = { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["1", 2] } };
  nodes["22"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["21", 0], amount: params.frames } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["22", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: getComposeInpaintDenoise(params) } };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: `VekSnap_Compose_${w}x${h}` } };
  return nodes;
}

// ── Compose: Overlay (T2V at region dimensions + RMBG background removal) ──
function buildComposeOverlayWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  nodes["6"] = { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: params.frames } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 } };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };
  // Background removal: isolate subject on transparent background
  nodes["30"] = { class_type: "RMBG", inputs: { image: ["8", 0], model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  // Save both: raw frames and BG-removed frames
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: `VekSnap_Overlay_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Overlay_${w}x${h}` } };
  return nodes;
}

// ── Compose: Combined (img2img inpaint on region + RMBG subject isolation) ──
function buildComposeCombinedWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: modelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  // Load cropped region and encode to latent for img2img
  nodes["20"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["21"] = { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["1", 2] } };
  nodes["22"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["21", 0], amount: params.frames } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: ["3", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["22", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: getComposeInpaintDenoise(params) } };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };
  // Background removal: isolate subject from inpainted region
  nodes["30"] = { class_type: "RMBG", inputs: { image: ["8", 0], model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: `VekSnap_Combined_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Combined_${w}x${h}` } };
  return nodes;
}

// ── Video Edit: Cascaded AnimateDiff batch ──
// Takes an init frame (last frame of previous batch) and generates 16 frames via img2img.
// For the first batch (no init), generates from empty latent or source frame.
export function buildEditBatchWorkflow(
  params: GenerationParams,
  initImageFile: string | null,  // filename of init frame uploaded to ComfyUI (null for first batch if no source)
  batchIndex: number
): Record<string, unknown> {
  const seed = getSeed(params);
  const prefix = `VekSnap_Edit_B${String(batchIndex).padStart(3, "0")}`;

  // Base nodes: checkpoint + LoRAs + AnimateDiff + CLIP
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef: loraModelRef, clipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  nodes["2"] = { class_type: "ADE_AnimateDiffUniformContextOptions", inputs: { context_length: 16, context_stride: 1, context_overlap: 4, context_schedule: "uniform", closed_loop: false } };
  nodes["3"] = { class_type: "ADE_AnimateDiffLoaderWithContext", inputs: { model: loraModelRef, model_name: params.motionModule, beta_schedule: "sqrt_linear (AnimateDiff)", context_options: ["2", 0], apply_v2_models_properly: false } };

  // Base model reference (face conditioning removed)
  const modelRef: [string, number] = ["3", 0];

  // CLIP text encoding
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };

  // Latent source: init image (img2img) or empty latent (first batch)
  if (initImageFile) {
    nodes["20"] = { class_type: "LoadImage", inputs: { image: initImageFile } };
    nodes["21"] = { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["1", 2] } };
    nodes["22"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["21", 0], amount: params.frames } };
    nodes["7"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["4", 0], negative: ["5", 0], latent_image: ["22", 0], seed: seed + batchIndex, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.denoise } };
  } else {
    nodes["6"] = { class_type: "EmptyLatentImage", inputs: { width: params.width, height: params.height, batch_size: params.frames } };
    nodes["7"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed: seed + batchIndex, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 } };
  }

  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: prefix } };

  return nodes;
}

// ══════════════════════════════════════════════════════════════════
// ── Still-Image Compose workflows (no AnimateDiff, batch_size=1) ──
// ══════════════════════════════════════════════════════════════════

function buildComposeInpaintStillWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  nodes["20"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["21"] = { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["1", 2] } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["4", 0], negative: ["5", 0], latent_image: ["21", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: getComposeInpaintDenoise(params) } };
  const hiresRef = addHiresFix(nodes, params, ["7", 0], modelRef, ["4", 0], ["5", 0], seed);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: hiresRef, vae: ["1", 2] } };
  const enhancedImg4 = addEnhanceDetails(nodes, params, ["8", 0], modelRef, ["4", 0], ["5", 0], ["1", 2], seed);
  const finalImg = addFaceDetailer(nodes, params, enhancedImg4, modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);
  nodes["9"] = { class_type: "SaveImage", inputs: { images: finalImg, filename_prefix: `VekSnap_ReImagine_${w}x${h}` } };
  return nodes;
}

function buildComposeOverlayStillWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  nodes["6"] = { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: 1 } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 } };
  const hiresRef2 = addHiresFix(nodes, params, ["7", 0], modelRef, ["4", 0], ["5", 0], seed);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: hiresRef2, vae: ["1", 2] } };
  const enhancedImg5 = addEnhanceDetails(nodes, params, ["8", 0], modelRef, ["4", 0], ["5", 0], ["1", 2], seed);
  const detailedImg2 = addFaceDetailer(nodes, params, enhancedImg5, modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);
  nodes["30"] = { class_type: "RMBG", inputs: { image: detailedImg2, model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: detailedImg2, filename_prefix: `VekSnap_Overlay_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Overlay_${w}x${h}` } };
  return nodes;
}

function buildComposeCombinedStillWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  nodes["20"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["21"] = { class_type: "VAEEncode", inputs: { pixels: ["20", 0], vae: ["1", 2] } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["4", 0], negative: ["5", 0], latent_image: ["21", 0], seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: getComposeInpaintDenoise(params) } };
  const hiresRef3 = addHiresFix(nodes, params, ["7", 0], modelRef, ["4", 0], ["5", 0], seed);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: hiresRef3, vae: ["1", 2] } };
  const enhancedImg6 = addEnhanceDetails(nodes, params, ["8", 0], modelRef, ["4", 0], ["5", 0], ["1", 2], seed);
  const detailedImg3 = addFaceDetailer(nodes, params, enhancedImg6, modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);
  nodes["30"] = { class_type: "RMBG", inputs: { image: detailedImg3, model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: detailedImg3, filename_prefix: `VekSnap_Combined_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Combined_${w}x${h}` } };
  return nodes;
}

// Still-image CA variants
function buildComposeInpaintCAStillWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveContentAwarePrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  const { latentRef, vaeRef, imageRef, maskRef } = buildContextAwareLatentStill(nodes, params);
  // Content-aware engine: BrushNet / PowerPaint (external) or DifferentialDiffusion (fallback)
  const eng = applyContentAwareEngine(nodes, params, modelRef, vaeRef, ["4", 0], ["5", 0], imageRef, maskRef, latentRef);
  const caDenoise = usesExternalCAEngine(params) ? 1.0 : getComposeInpaintDenoise(params);
  nodes["7"] = { class_type: "KSampler", inputs: { model: eng.modelRef, positive: eng.posRef, negative: eng.negRef, latent_image: eng.latentRef, seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: caDenoise } };
  const croppedRef = addContextAwareCrop(nodes, ["7", 0], params);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: croppedRef, vae: ["1", 2] } };
  const finalRef4 = addVekSnapPostComposite(nodes, ["8", 0], params);
  const enhancedCA1 = addEnhanceDetails(nodes, params, finalRef4, modelRef, ["4", 0], ["5", 0], ["1", 2], seed);
  const detailedCA1 = addFaceDetailer(nodes, params, enhancedCA1, modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);
  nodes["9"] = { class_type: "SaveImage", inputs: { images: detailedCA1, filename_prefix: `VekSnap_ReImagine_CA_${w}x${h}` } };
  return nodes;
}

function buildComposeOverlayCAStillWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveContentAwarePrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  const { latentRef, vaeRef, imageRef, maskRef } = buildContextAwareLatentStill(nodes, params);
  // Content-aware engine (overlay generates fresh content in the masked region, denoise 1.0)
  const eng = applyContentAwareEngine(nodes, params, modelRef, vaeRef, ["4", 0], ["5", 0], imageRef, maskRef, latentRef);
  nodes["7"] = { class_type: "KSampler", inputs: { model: eng.modelRef, positive: eng.posRef, negative: eng.negRef, latent_image: eng.latentRef, seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1.0 } };
  const croppedRef = addContextAwareCrop(nodes, ["7", 0], params);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: croppedRef, vae: ["1", 2] } };
  const finalRef5 = addVekSnapPostComposite(nodes, ["8", 0], params);
  const enhancedCA2 = addEnhanceDetails(nodes, params, finalRef5, modelRef, ["4", 0], ["5", 0], ["1", 2], seed);
  const detailedCA2 = addFaceDetailer(nodes, params, enhancedCA2, modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);
  nodes["30"] = { class_type: "RMBG", inputs: { image: detailedCA2, model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: detailedCA2, filename_prefix: `VekSnap_Overlay_CA_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Overlay_CA_${w}x${h}` } };
  return nodes;
}

function buildComposeCombinedCAStillWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const w = r?.width ?? params.width;
  const h = r?.height ?? params.height;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveContentAwarePrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  const { latentRef, vaeRef, imageRef, maskRef } = buildContextAwareLatentStill(nodes, params);
  // Content-aware engine: BrushNet / PowerPaint (external) or DifferentialDiffusion (fallback)
  const eng = applyContentAwareEngine(nodes, params, modelRef, vaeRef, ["4", 0], ["5", 0], imageRef, maskRef, latentRef);
  const caDenoise = usesExternalCAEngine(params) ? 1.0 : getComposeInpaintDenoise(params);
  nodes["7"] = { class_type: "KSampler", inputs: { model: eng.modelRef, positive: eng.posRef, negative: eng.negRef, latent_image: eng.latentRef, seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: caDenoise } };
  const croppedRef = addContextAwareCrop(nodes, ["7", 0], params);
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: croppedRef, vae: ["1", 2] } };
  const finalRef6 = addVekSnapPostComposite(nodes, ["8", 0], params);
  const enhancedCA3 = addEnhanceDetails(nodes, params, finalRef6, modelRef, ["4", 0], ["5", 0], ["1", 2], seed);
  const detailedCA3 = addFaceDetailer(nodes, params, enhancedCA3, modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);
  nodes["30"] = { class_type: "RMBG", inputs: { image: detailedCA3, model: "INSPYRENET", sensitivity: 0.9, process_res: 512, mask_blur: 2, mask_offset: 0, background: "Alpha", invert_output: false, refine_foreground: false } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: detailedCA3, filename_prefix: `VekSnap_Combined_CA_Raw_${w}x${h}` } };
  nodes["31"] = { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: `VekSnap_Combined_CA_${w}x${h}` } };
  return nodes;
}

// ── Z-Image Turbo txt2img ──
// Modern turbo image model: UNETLoader (z_image_turbo) + CLIPLoader (Qwen 3 4B, lumina2 type) + VAELoader
// Uses SD3-style latent space, 20 steps, euler/simple, CFG 1.0
function buildZImageTurboWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const nodes: Record<string, unknown> = {
    // Load UNET model
    "1": { class_type: "UNETLoader", inputs: { unet_name: ZIMAGE_MODELS.UNET, weight_dtype: "default" } },
    // Load CLIP text encoder (Qwen 3 4B, lumina2 type, offloaded to CPU)
    "2": { class_type: "CLIPLoader", inputs: { clip_name: ZIMAGE_MODELS.CLIP, type: ZIMAGE_MODELS.CLIP_TYPE, device: "cpu" } },
    // Load VAE
    "3": { class_type: "VAELoader", inputs: { vae_name: ZIMAGE_MODELS.VAE } },
  };
  // LoRA chain: threads through both model and clip refs
  let modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["2", 0];
  const activeLoras = params.loras.filter((l) => l.enabled && l.name);
  for (let i = 0; i < activeLoras.length; i++) {
    const id = String(100 + i);
    nodes[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: activeLoras[i].name,
        strength_model: activeLoras[i].strengthModel,
        strength_clip: activeLoras[i].strengthClip,
        model: modelRef,
        clip: clipRef,
      },
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  }
  // Text encoding
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  // SD3-style empty latent
  nodes["6"] = { class_type: "EmptySD3LatentImage", inputs: { width: params.width, height: params.height, batch_size: 1 } };
  // Sample
  nodes["7"] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef,
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["6", 0],
      seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: 1.0,
    },
  };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_ZImage" } };
  return nodes;
}

// ── Z-Image Turbo img2img (I2I refinement) ──
// Loads a source image, encodes it through VAE, and re-samples with configurable denoise.
// Lower denoise (0.2–0.4) preserves composition and sharpens; higher (0.5–0.7) regenerates more detail.
function buildZImageI2IWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const nodes: Record<string, unknown> = {
    // Load UNET model
    "1": { class_type: "UNETLoader", inputs: { unet_name: ZIMAGE_MODELS.UNET, weight_dtype: "default" } },
    // Load CLIP text encoder (Qwen 3 4B, lumina2 type, offloaded to CPU)
    "2": { class_type: "CLIPLoader", inputs: { clip_name: ZIMAGE_MODELS.CLIP, type: ZIMAGE_MODELS.CLIP_TYPE, device: "cpu" } },
    // Load VAE
    "3": { class_type: "VAELoader", inputs: { vae_name: ZIMAGE_MODELS.VAE } },
  };
  // LoRA chain: threads through both model and clip refs
  let modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["2", 0];
  const activeLoras = params.loras.filter((l) => l.enabled && l.name);
  for (let i = 0; i < activeLoras.length; i++) {
    const id = String(100 + i);
    nodes[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: activeLoras[i].name,
        strength_model: activeLoras[i].strengthModel,
        strength_clip: activeLoras[i].strengthClip,
        model: modelRef,
        clip: clipRef,
      },
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  }
  // Text encoding
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  // Load source image and encode to latent
  nodes["10"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["11"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["3", 0] } };
  // Sample with denoise < 1.0 for I2I refinement
  nodes["7"] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef,
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["11", 0],
      seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: params.denoise,
    },
  };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_ZImage_I2I" } };
  return nodes;
}

// ── Z-Image Turbo "Enhance Details" (detail restoration, prompt-guided) ──
//
// Distinct from plain I2I in four ways that matter:
//   1. Conditioning is a DETAIL-QUALITY prompt block, not a subject prompt, so the model is told
//      to repair texture rather than to reinterpret content.
//   2. CFG is hard-clamped (distilled model, high CFG destroys it) and denoise is clamped to a
//      restoration window (high denoise makes Z-Image re-imagine instead of restore).
//   3. The sampler SCHEDULE is scaled so the requested step count actually runs. KSampler truncates
//      the schedule by denoise, so a literal 8 steps at denoise 0.30 performs only ~2 real steps.
//   4. Optional structure lock via ZImageFunControlnet, which patches the MODEL (not the
//      conditioning) and therefore composes with the LoRA chain. Inert unless a user-downloaded
//      model_patch is selected: the mode is fully functional without it.
function buildZImageEnhanceDetailsWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);

  const cfg = Math.min(params.cfg > 0 ? params.cfg : ZIMAGE_ENHANCE.CFG, ZIMAGE_ENHANCE.CFG_MAX);
  const denoise = Math.min(
    Math.max(params.denoise > 0 ? params.denoise : ZIMAGE_ENHANCE.DENOISE, ZIMAGE_ENHANCE.DENOISE_MIN),
    ZIMAGE_ENHANCE.DENOISE_MAX
  );
  const effectiveSteps = params.steps > 0 ? params.steps : ZIMAGE_ENHANCE.STEPS;
  const scheduleSteps = Math.min(
    ZIMAGE_ENHANCE.STEPS_MAX,
    Math.max(effectiveSteps, Math.round(effectiveSteps / denoise))
  );

  const userPrompt = (params.positivePrompt || "").trim();
  const positive = params.zimageEnhanceAppendPrompt && userPrompt
    ? `${ZIMAGE_ENHANCE_PROMPT}, ${userPrompt}`
    : ZIMAGE_ENHANCE_PROMPT;
  const negative = (params.negativePrompt || "").trim() || ZIMAGE_ENHANCE_NEGATIVE;

  const nodes: Record<string, unknown> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: ZIMAGE_MODELS.UNET, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: ZIMAGE_MODELS.CLIP, type: ZIMAGE_MODELS.CLIP_TYPE, device: "cpu" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: ZIMAGE_MODELS.VAE } },
  };

  // LoRA chain (a detail/skin LoRA is a legitimate addition here)
  let modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["2", 0];
  const activeLoras = params.loras.filter((l) => l.enabled && l.name);
  for (let i = 0; i < activeLoras.length; i++) {
    const id = String(100 + i);
    nodes[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: activeLoras[i].name,
        strength_model: activeLoras[i].strengthModel,
        strength_clip: activeLoras[i].strengthClip,
        model: modelRef,
        clip: clipRef,
      },
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  }

  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: positive, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: negative, clip: clipRef } };

  // Source image → latent
  nodes["10"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["11"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["3", 0] } };

  // ── Optional structure lock ──
  // Requires a Z-Image Fun ControlNet Union patch in ComfyUI/models/model_patches (a user-download,
  // NOT bundled), so this whole block stays inert unless a model has been selected.
  const cnModel = (params.zimageEnhanceControlNetModel || "").trim();
  if (params.zimageEnhanceControlNet && cnModel) {
    nodes["20"] = { class_type: "ModelPatchLoader", inputs: { name: cnModel } };
    let controlImageRef: [string, number] = ["10", 0];
    if ((params.zimageEnhanceControlNetType || "canny") === "canny") {
      nodes["21"] = {
        class_type: "Canny",
        inputs: {
          image: ["10", 0],
          low_threshold: params.zimageEnhanceCannyLow ?? ZIMAGE_ENHANCE.CANNY_LOW,
          high_threshold: params.zimageEnhanceCannyHigh ?? ZIMAGE_ENHANCE.CANNY_HIGH,
        },
      };
      controlImageRef = ["21", 0];
    }
    // ZImageFunControlnet returns a patched MODEL, so it must sit AFTER the LoRA chain.
    nodes["22"] = {
      class_type: "ZImageFunControlnet",
      inputs: {
        model: modelRef,
        model_patch: ["20", 0],
        vae: ["3", 0],
        image: controlImageRef,
        strength: params.zimageEnhanceControlNetStrength ?? ZIMAGE_ENHANCE.CN_STRENGTH,
      },
    };
    modelRef = ["22", 0];
  }

  nodes["7"] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef,
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["11", 0],
      seed,
      steps: scheduleSteps,
      cfg,
      sampler_name: params.sampler || ZIMAGE_ENHANCE.SAMPLER,
      scheduler: params.scheduler || ZIMAGE_ENHANCE.SCHEDULER,
      denoise,
    },
  };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "VekSnap_ZImage_Enhance" } };
  return nodes;
}

// ── Z-Image Turbo "Face Repair" (region-targeted semantic repair, Phase 2a) ──
//
// Fixes facial artifacts (melted teeth, warped eyes) by detecting each face, upscaling the crop,
// running a low-denoise Z-Image restoration on the crop ONLY, then compositing back with
// feathering, so correctly-rendered pixels are never touched.
//
// Uses Impact Pack's `FaceDetailer` which does detect -> crop -> upscale to guide_size -> sample
// -> feathered paste in one node, fed by `UltralyticsDetectorProvider` (Impact Subpack, bbox
// model). FaceDetailer's internal sampler is a KSampler, so it truncates the schedule by denoise
// like KSampler: the identical steps/denoise compensation is applied here. FaceDetailer output[0]
// is a finished IMAGE (no VAEDecode needed).
function buildZImageFaceRepairWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);

  // Hard rails resolved from ZIMAGE_FACE and re-clamped defensively so a stale studio-state value
  // can never fry the distilled model or push it into re-imagining.
  const cfg = Math.min(
    params.zimageFaceCfg && params.zimageFaceCfg > 0 ? params.zimageFaceCfg : ZIMAGE_FACE.CFG,
    ZIMAGE_FACE.CFG_MAX
  );
  const denoise = Math.min(
    Math.max(
      params.zimageFaceDenoise && params.zimageFaceDenoise > 0 ? params.zimageFaceDenoise : ZIMAGE_FACE.DENOISE,
      ZIMAGE_FACE.DENOISE_MIN
    ),
    ZIMAGE_FACE.DENOISE_MAX
  );
  const effectiveSteps = params.zimageFaceSteps && params.zimageFaceSteps > 0 ? params.zimageFaceSteps : ZIMAGE_FACE.STEPS;
  // FaceDetailer's internal KSampler truncates the schedule by denoise, so a literal 8 steps at
  // denoise 0.30 would run ~2 real steps. Scale the schedule up to hit the requested effective count.
  const scheduleSteps = Math.min(
    ZIMAGE_FACE.STEPS_MAX,
    Math.max(effectiveSteps, Math.round(effectiveSteps / denoise))
  );
  const userPrompt = (params.positivePrompt || "").trim();
  const positive = params.zimageFaceAppendPrompt && userPrompt
    ? `${ZIMAGE_FACE_PROMPT}, ${userPrompt}`
    : ZIMAGE_FACE_PROMPT;
  const negative = (params.negativePrompt || "").trim() || ZIMAGE_FACE_NEGATIVE;

  const nodes: Record<string, unknown> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: ZIMAGE_MODELS.UNET, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: ZIMAGE_MODELS.CLIP, type: ZIMAGE_MODELS.CLIP_TYPE, device: "cpu" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: ZIMAGE_MODELS.VAE } },
  };

  // LoRA chain (a face/skin-detail LoRA is a legitimate addition here)
  let modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["2", 0];
  const activeLoras = params.loras.filter((l) => l.enabled && l.name);
  for (let i = 0; i < activeLoras.length; i++) {
    const id = String(100 + i);
    nodes[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: activeLoras[i].name,
        strength_model: activeLoras[i].strengthModel,
        strength_clip: activeLoras[i].strengthClip,
        model: modelRef,
        clip: clipRef,
      },
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  }

  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: positive, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: negative, clip: clipRef } };
  nodes["10"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };

  // Florence-2 (MIT) face detection -> filled region MASK (output index 1). Permissive
  // replacement for the AGPL Ultralytics detector + Impact FaceDetailer.
  nodes["30"] = {
    class_type: "AILab_Florence2",
    inputs: {
      image: ["10", 0],
      model_name: FACE_DETECT.FLORENCE_MODEL,
      task: "Phrase Grounding (text boxes)",
      precision: "fp16",
      attention: "sdpa",
      fill_mask: true,
      text_prompt: FACE_DETECT.PROMPT,
    },
  };
  // Grow + feather the detected region so jaw/hairline are covered and the edge blends.
  nodes["32"] = {
    class_type: "GrowMask",
    inputs: { mask: ["30", 1], expand: params.zimageFaceDilation ?? ZIMAGE_FACE.BBOX_DILATION, tapered_corners: true },
  };
  const faceFeather = params.zimageFaceFeather ?? ZIMAGE_FACE.FEATHER;
  nodes["33"] = {
    class_type: "FeatherMask",
    inputs: { mask: ["32", 0], left: faceFeather, top: faceFeather, right: faceFeather, bottom: faceFeather },
  };

  // Low-denoise Z-Image redraw of the masked region only. DifferentialDiffusion gives
  // smooth masked gradients; SetLatentNoiseMask confines sampling to the face region.
  nodes["34"] = { class_type: "DifferentialDiffusion", inputs: { model: modelRef } };
  nodes["35"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["3", 0] } };
  nodes["36"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["35", 0], mask: ["33", 0] } };
  nodes["31"] = {
    class_type: "KSampler",
    inputs: {
      model: ["34", 0],
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["36", 0],
      seed,
      steps: scheduleSteps,
      cfg,
      sampler_name: params.sampler || ZIMAGE_FACE.SAMPLER,
      scheduler: params.scheduler || ZIMAGE_FACE.SCHEDULER,
      denoise,
    },
  };
  nodes["37"] = { class_type: "VAEDecode", inputs: { samples: ["31", 0], vae: ["3", 0] } };
  // Composite the redrawn face(s) back over the original via the feathered mask.
  nodes["38"] = {
    class_type: "ImageCompositeMasked",
    inputs: { destination: ["10", 0], source: ["37", 0], mask: ["33", 0], x: 0, y: 0, resize_source: false },
  };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["38", 0], filename_prefix: "VekSnap_ZImage_FaceRepair" } };
  return nodes;
}

// ── Z-Image Turbo Inpainting (Advanced) ──
// Uses DifferentialDiffusion for smooth masked-region gradients,
// InpaintModelConditioning for proper inpaint conditioning,
// ConditioningZeroOut for negative (Z-Image doesn't use text negative),
// and the two-step post-composite (hard paste + soft blend) for seamless results.
function buildZImageInpaintWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const r = params.regionInfo;
  const nodes: Record<string, unknown> = {
    // Load UNET model
    "1": { class_type: "UNETLoader", inputs: { unet_name: ZIMAGE_MODELS.UNET, weight_dtype: "default" } },
    // Load CLIP text encoder (Qwen 3 4B, lumina2 type, offloaded to CPU)
    "2": { class_type: "CLIPLoader", inputs: { clip_name: ZIMAGE_MODELS.CLIP, type: ZIMAGE_MODELS.CLIP_TYPE, device: "cpu" } },
    // Load VAE
    "3": { class_type: "VAELoader", inputs: { vae_name: ZIMAGE_MODELS.VAE } },
  };

  // LoRA chain
  let modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["2", 0];
  const activeLoras = params.loras.filter((l) => l.enabled && l.name);
  for (let i = 0; i < activeLoras.length; i++) {
    const id = String(100 + i);
    nodes[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: activeLoras[i].name,
        strength_model: activeLoras[i].strengthModel,
        strength_clip: activeLoras[i].strengthClip,
        model: modelRef,
        clip: clipRef,
      },
    };
    modelRef = [id, 0];
    clipRef = [id, 1];
  }

  // DifferentialDiffusion: smoother gradients in masked regions, reduces artifacts
  nodes["10"] = { class_type: "DifferentialDiffusion", inputs: { model: modelRef } };
  const diffModelRef: [string, number] = ["10", 0];

  // Text encoding: positive prompt + zeroed-out negative (Z-Image convention)
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: resolveInpaintPrompt(params), clip: clipRef } };
  nodes["5"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } };

  // Load context image (prefer vek-snap-filled if available, else cropped context)
  const contextFile = r?.filledImageFile ?? r?.contextImageFile;
  nodes["11"] = { class_type: "LoadImage", inputs: { image: contextFile } };
  nodes["12"] = { class_type: "LoadImageMask", inputs: { image: r?.maskImageFile, channel: "red" } };

  // InpaintModelConditioning: combines conditioning + VAE-encoded pixels + mask
  // Outputs: positive[0], negative[1], latent[2] (with noise_mask applied)
  nodes["13"] = {
    class_type: "InpaintModelConditioning",
    inputs: {
      positive: ["4", 0],
      negative: ["5", 0],
      vae: ["3", 0],
      pixels: ["11", 0],
      mask: ["12", 0],
      noise_mask: true,
    },
  };

  // KSampler: uses conditioning and latent from InpaintModelConditioning
  const denoise = getComposeInpaintDenoise(params);
  nodes["7"] = {
    class_type: "KSampler",
    inputs: {
      model: diffModelRef,
      positive: ["13", 0],
      negative: ["13", 1],
      latent_image: ["13", 2],
      seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise,
    },
  };

  // VAE Decode
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };

  // Post-composite: scale back to crop dims → hard paste → soft blend with gradient mask
  let outputRef: [string, number] = ["8", 0];
  outputRef = addVekSnapPostComposite(nodes, outputRef, params);

  nodes["9"] = { class_type: "SaveImage", inputs: { images: outputRef, filename_prefix: "VekSnap_ZImage_Inpaint" } };
  return nodes;
}

// ── Outpaint Still Image ──
// Expands a source image in selected directions using content-aware inpainting.
// Pipeline: LoadImage (filled) → VAEEncode → SetLatentNoiseMask (binary mask)
//           → KSampler (denoise=1.0) → VAEDecode
//           → ImageCompositeMasked (onto original padded, with soft gradient mask)
//           → SaveImage
function buildOutpaintStillWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const info = params.outpaintInfo!;
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);

  // CLIP text encoding
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };

  // Load vek-snap-filled padded image and encode to latent
  nodes["50"] = { class_type: "LoadImage", inputs: { image: info.filledImageFile } };
  nodes["51"] = { class_type: "VAEEncode", inputs: { pixels: ["50", 0], vae: ["1", 2] } };

  // Apply binary mask: tells sampler to only denoise the white (new) area
  nodes["52"] = { class_type: "LoadImageMask", inputs: { image: info.maskFile, channel: "red" } };
  nodes["53"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["51", 0], mask: ["52", 0] } };

  // Content-aware engine: BrushNet / PowerPaint (external) or DifferentialDiffusion (fallback).
  // Outpaint always fills fresh content in the new area (denoise 1.0). BrushNet/PowerPaint emit
  // their own latent from the raw filled image + mask; diffdiff reuses the noise-masked latent.
  const eng = applyContentAwareEngine(nodes, params, modelRef, ["1", 2], ["4", 0], ["5", 0], ["50", 0], ["52", 0], ["53", 0]);

  // KSampler: full denoise in new area, preserves original via noise mask
  nodes["7"] = {
    class_type: "KSampler",
    inputs: {
      model: eng.modelRef,
      positive: eng.posRef,
      negative: eng.negRef,
      latent_image: eng.latentRef,
      seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler,
      scheduler: params.scheduler,
      denoise: 1.0,
    },
  };

  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };

  // Post-composite: blend generated result onto original padded image using soft gradient mask
  // Where soft mask is white → use generated, black → use original, gradient → smooth blend
  nodes["57"] = { class_type: "LoadImage", inputs: { image: info.paddedImageFile } };
  nodes["56"] = { class_type: "LoadImageMask", inputs: { image: info.softMaskFile, channel: "red" } };
  nodes["58"] = {
    class_type: "ImageCompositeMasked",
    inputs: {
      destination: ["57", 0],
      source: ["8", 0],
      mask: ["56", 0],
      x: 0,
      y: 0,
      resize_source: false,
    },
  };

  // Enhance Details: real upscaler + img2img refinement (Vek-Snap)
  const enhancedOutpaint = addEnhanceDetails(nodes, params, ["58", 0], modelRef, ["4", 0], ["5", 0], ["1", 2], seed);
  // ADetailer: auto face refinement on final composite
  const outpaintFinal = addFaceDetailer(nodes, params, enhancedOutpaint, modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);

  nodes["9"] = {
    class_type: "SaveImage",
    inputs: {
      images: outpaintFinal,
      filename_prefix: `VekSnap_Outpaint_${info.totalWidth}x${info.totalHeight}`,
    },
  };

  return nodes;
}

// ── Smart Upscale: Fast (ESRGAN only - no diffusion) ──
// Loads source image → upscales with real ESRGAN model → scales to target dims → saves.
// Very fast, no KSampler involved. Single-pass upscale.
function buildUpscaleFastWorkflow(params: GenerationParams): Record<string, unknown> {
  const targetW = Math.round(params.width * params.upscaleScale);
  const targetH = Math.round(params.height * params.upscaleScale);
  const nodes: Record<string, unknown> = {};
  nodes["1"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["2"] = { class_type: "UpscaleModelLoader", inputs: { model_name: params.upscaleModel } };
  nodes["3"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } };
  nodes["4"] = { class_type: "ImageScale", inputs: { image: ["3", 0], upscale_method: "lanczos", width: targetW, height: targetH, crop: "disabled" } };
  nodes["9"] = { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: `VekSnap_Upscale_Fast_${targetW}x${targetH}` } };
  return nodes;
}

// ── Smart Upscale: Quality (ESRGAN + img2img refinement) ──
// Loads source image → upscales with ESRGAN → scales to target → VAE encode →
// KSampler at low denoise for detail refinement → VAE decode → saves.
// Quality route: ESRGAN + diffusion refinement.
function buildUpscaleQualityWorkflow(params: GenerationParams): Record<string, unknown> {
  const seed = getSeed(params);
  const targetW = Math.round(params.width * params.upscaleScale);
  const targetH = Math.round(params.height * params.upscaleScale);
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.checkpoint } },
  };
  const { modelRef, clipRef: loraClipRef } = injectLoras(nodes, params.loras, ["1", 0], ["1", 1]);
  const clipRef = injectClipSkip(nodes, loraClipRef, params.clipSkip);
  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: params.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt, clip: clipRef } };
  // Load and upscale source image
  nodes["10"] = { class_type: "LoadImage", inputs: { image: params.sourceImage } };
  nodes["11"] = { class_type: "UpscaleModelLoader", inputs: { model_name: params.upscaleModel } };
  nodes["12"] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["11", 0], image: ["10", 0] } };
  nodes["13"] = { class_type: "ImageScale", inputs: { image: ["12", 0], upscale_method: "lanczos", width: targetW, height: targetH, crop: "disabled" } };
  // Encode upscaled image and refine with diffusion
  nodes["14"] = { class_type: "VAEEncode", inputs: { pixels: ["13", 0], vae: ["1", 2] } };
  nodes["7"] = { class_type: "KSampler", inputs: { model: modelRef, positive: ["4", 0], negative: ["5", 0], latent_image: ["14", 0], seed, steps: params.upscaleSteps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: params.upscaleDenoise } };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["1", 2] } };
  // ADetailer on upscaled result
  const finalImg = addFaceDetailer(nodes, params, ["8", 0], modelRef, clipRef, ["1", 2], ["4", 0], ["5", 0], seed);
  nodes["9"] = { class_type: "SaveImage", inputs: { images: finalImg, filename_prefix: `VekSnap_Upscale_Quality_${targetW}x${targetH}` } };
  return nodes;
}

export function buildWorkflow(
  params: GenerationParams,
  mode: GenerationMode,
  composeSubMode?: "inpaint" | "overlay" | "combined"
): Record<string, unknown> {
  // Inject enabled embedding tokens into prompts before dispatching
  const resolved = resolveEmbeddings(params.positivePrompt, params.negativePrompt, params.embeddings);
  params = { ...params, positivePrompt: resolved.positive, negativePrompt: resolved.negative };

  const hasSource = !!params.sourceImage;

  // Smart Upscale: standalone image upscaling (ComfyUI routes)
  if (mode === "image" && hasSource && (params.upscaleMode === "fast" || params.upscaleMode === "quality")) {
    return params.upscaleMode === "fast" ? buildUpscaleFastWorkflow(params) : buildUpscaleQualityWorkflow(params);
  }

  // Outpaint: still-image expansion (takes priority in image mode)
  if (mode === "image" && params.outpaint.enabled && params.outpaintInfo) {
    return buildOutpaintStillWorkflow(params);
  }

  // Compose / Re-Imagine workflows: region-limited generation
  if (mode === "compose") {
    const ca = params.contentAware && params.regionInfo?.contextImageFile && params.regionInfo?.maskImageFile;
    const still = params.composeOutputType === "image";

    if (still && ca) {
      if (composeSubMode === "overlay") return buildComposeOverlayCAStillWorkflow(params);
      if (composeSubMode === "combined") return buildComposeCombinedCAStillWorkflow(params);
      return buildComposeInpaintCAStillWorkflow(params);
    }
    if (still) {
      if (composeSubMode === "overlay") return buildComposeOverlayStillWorkflow(params);
      if (composeSubMode === "combined") return buildComposeCombinedStillWorkflow(params);
      return buildComposeInpaintStillWorkflow(params);
    }
    if (ca) {
      if (composeSubMode === "overlay") return buildComposeOverlayContextAwareWorkflow(params);
      if (composeSubMode === "combined") return buildComposeCombinedContextAwareWorkflow(params);
      return buildComposeInpaintContextAwareWorkflow(params);
    }
    if (composeSubMode === "overlay") return buildComposeOverlayWorkflow(params);
    if (composeSubMode === "combined") return buildComposeCombinedWorkflow(params);
    return buildComposeInpaintWorkflow(params);
  }

  // Z-Image Turbo: modern turbo image model (UNETLoader + CLIPLoader lumina2 + VAELoader)
  // When source + mask are set (paint-mask inpainting), use advanced inpaint workflow
  // When source image is set (no mask), use I2I refinement workflow
  if (mode === "zimage") {
    if (params.regionInfo?.maskImageFile && params.regionInfo?.contextImageFile) {
      return buildZImageInpaintWorkflow(params);
    }
    // "Face Repair" (Phase 2a) outranks plain I2I: same source-image input, but region-targeted,
    // only detected faces are redrawn (the artifact hot-spot), the rest of the frame is preserved.
    if (params.sourceImage && params.zimageFaceRepair) {
      return buildZImageFaceRepairWorkflow(params);
    }
    // "Enhance Details" outranks plain I2I: same source-image input, but a deliberately constrained
    // restoration graph (clamped CFG/denoise, detail conditioning, optional structure lock) rather
    // than a free-form reinterpretation.
    if (params.sourceImage && params.zimageEnhanceDetails) {
      return buildZImageEnhanceDetailsWorkflow(params);
    }
    if (params.sourceImage) {
      return buildZImageI2IWorkflow(params);
    }
    return buildZImageTurboWorkflow(params);
  }

  // Wan Remix two-pass I2V (GGUF quantized), storyboard mode for multi-segment
  if (mode === "wan_remix") {
    if (params.storyboardSegments.length >= 2) return buildWanRemixExtendedWorkflow(params);
    return buildWanRemixI2VWorkflow(params);
  }

  // Wan 2.1 workflows
  if (mode === "wan" && hasSource) return buildWanI2VWorkflow(params);
  if (mode === "wan") return buildWanT2VWorkflow(params);

  // Image-to-Video (I2V): source image provided in video mode
  if (mode === "video" && hasSource) return buildI2VPlainWorkflow(params);

  // Text-to-Video (T2V)
  if (mode === "video") return buildVideoPlainWorkflow(params);

  // Still image
  return buildImagePlainWorkflow(params);
}

// ── Foley Audio Generation (HunyuanVideo-Foley) ──
// Loads video frames from a staging directory, generates synced audio via
// HunyuanFoley model, and saves the result as a WAV/FLAC file.
// Requires: ComfyUI-HunyuanVideo-Foley + ComfyUI-VideoHelperSuite custom nodes.
export function buildFoleyAudioWorkflow(
  params: GenerationParams,
  stagingDir: string,
): Record<string, unknown> {
  const seed = getSeed(params);
  const nodes: Record<string, unknown> = {};

  // Load video frames from staging directory (VHS node)
  nodes["1"] = {
    class_type: "VHS_LoadImagesPath",
    inputs: {
      directory: stagingDir,
      image_load_cap: 0,        // 0 = load all
      skip_first_images: 0,
      select_every_nth: 1,
    },
  };

  // Load Foley model (bf16 compute for Blackwell Tensor cores, auto quantization)
  nodes["2"] = {
    class_type: "HunyuanModelLoader",
    inputs: {
      model_name: "hunyuanvideo_foley_fp8_e5m2.safetensors",
      precision: "bf16",
      quantization: "auto",
    },
  };

  // Load dependencies (DAC-VAE + Synchformer; SigLIP2 + CLAP auto-download from HF)
  nodes["3"] = {
    class_type: "HunyuanDependenciesLoader",
    inputs: {
      vae_name: "vae_128d_48k_fp16.safetensors",
      synchformer_name: "synchformer_state_dict_fp16.safetensors",
    },
  };

  // Generate audio synced to video frames
  const duration = Math.max(1, Math.round((params.frames / Math.max(1, params.fps)) * 10) / 10);
  nodes["4"] = {
    class_type: "HunyuanFoleySampler",
    inputs: {
      hunyuan_model: ["2", 0],
      hunyuan_deps: ["3", 0],
      image: ["1", 0],
      frame_rate: params.fps,
      duration,
      prompt: params.foleyPrompt || "ambient sound effects",
      negative_prompt: params.foleyNegativePrompt || "noisy, harsh",
      cfg_scale: params.foleyCfg ?? 4.5,
      steps: params.foleySteps ?? 50,
      sampler: params.foleySampler || "euler",
      batch_size: 1,
      seed,
      force_offload: true,
    },
  };

  // Save generated audio
  nodes["5"] = {
    class_type: "SaveAudio",
    inputs: {
      audio: ["4", 0],
      filename_prefix: "audio/VekSnap_Foley",
    },
  };

  return nodes;
}

// ── LTX-2 Joint Audio-Video Generation (ComfyUI-based, "Alternative" community pipeline) ──
// Aligned with a community reference workflow for distilled joint AV sampling.
// Chain: DualCLIPLoader → CLIPTextEncode → ConditioningZeroOut → LTXVConditioning
//        UNETLoader → ChunkFeedForward → AttentionTunerPatch → BasicGuider → NormalizingSampler
//        I2V uses LTXVAddGuideMulti for image guides; T2V routes directly.
export function buildLTX2Workflow(
  config: LTX2Config,
  seed: number,
): Record<string, unknown> {
  // LTX-2.5 is a distinct two-stage distilled AV topology, delegate to its own builder.
  if (config.modelVersion === "2.5") return buildLTX25Workflow(config, seed);

  const nodes: Record<string, unknown> = {};
  const hasSourceImage = !!config.sourceImage;

  // ── Model Loaders ──

  const useGGUF = !!(config.useGGUF && config.ggufDiffusionModel);

  if (useGGUF) {
    // DualCLIPLoaderGGUF: GGUF-quantized Gemma text encoder + text projection
    nodes["88"] = {
      class_type: "DualCLIPLoaderGGUF",
      inputs: {
        clip_name1: config.ggufTextEncoder || LTX23_GGUF_DEFAULTS.ggufTextEncoder,
        clip_name2: config.connectorModel,
        type: "ltxv",
      },
    };

    // UnetLoaderGGUF: GGUF-quantized diffusion model
    nodes["91"] = {
      class_type: "UnetLoaderGGUF",
      inputs: {
        unet_name: config.ggufDiffusionModel,
      },
    };
  } else {
    // DualCLIPLoader: Gemma 12B text encoder + embeddings connector (Alternative's approach)
    // clip_name1 = Gemma from text_encoders/, clip_name2 = connector from text_encoders/
    nodes["88"] = {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: config.textEncoder,
        clip_name2: config.connectorModel,
        type: "ltxv",
        device: "cpu",
      },
    };

    // UNETLoader: diffusion model (default dtype - NVFP4 auto-detects via quantization metadata)
    nodes["91"] = {
      class_type: "UNETLoader",
      inputs: {
        unet_name: config.diffusionModel,
        weight_dtype: "default",
      },
    };
  }

  // LoraLoaderModelOnly: distill LoRA enables distilled sampling (8-step LCM)
  // Required for dev/dev-fp4 models; standalone distilled models skip this
  const skipDistillLora = !config.distillLoRA || config.distillLoRAStrength === 0;
  let lastLoraNode = "91";
  if (!skipDistillLora) {
    nodes["161"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["91", 0],
        lora_name: config.distillLoRA.replace(/\//g, "\\"),
        strength_model: config.distillLoRAStrength,
      },
    };
    lastLoraNode = "161";
  }

  // User LoRAs: split into standard (LoraLoaderModelOnly) and scheduled (Hook LoRA)
  const enabledLoras = config.userLoras.filter((l) => l.enabled && l.name);
  const scheduleMode = config.loraScheduleMode ?? "none";

  // Determine which LoRAs are scheduled based on mode:
  // - "none": no LoRAs are scheduled (all standard)
  // - "per_lora": only LoRAs with lora.scheduled=true are scheduled
  // - "all": ALL enabled LoRAs are scheduled with global schedule params
  const standardLoras = scheduleMode === "all"
    ? [] // all go through hooks
    : enabledLoras.filter((l) => !l.scheduled);
  const scheduledLoras = scheduleMode === "all"
    ? enabledLoras
    : scheduleMode === "per_lora"
      ? enabledLoras.filter((l) => l.scheduled)
      : []; // "none" = no scheduling

  // Standard LoRAs: chain after distill LoRA (or UNETLoader if no distill)
  standardLoras.forEach((lora, i) => {
    const nodeId = String(162 + i);
    nodes[nodeId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [lastLoraNode, 0],
        lora_name: lora.name.replace(/\//g, "\\"),
        strength_model: lora.strengthModel,
      },
    };
    lastLoraNode = nodeId;
  });

  // Scheduled LoRAs: use Hook system (CreateHookLora + CreateHookKeyframesInterpolated + SetHookKeyframes)
  // These are applied via CLIP hooks during sampling, not as direct model patches.
  // Schedule strength values are ABSOLUTE (not a multiplier on base strength).
  // We pass strength_model=1.0 to CreateHookLora and let keyframe values be the effective strength.
  let lastHookNode: string | null = null;
  scheduledLoras.forEach((lora, i) => {
    const hookId = String(600 + i * 3);
    const kfId = String(601 + i * 3);
    const setKfId = String(602 + i * 3);

    // Resolve schedule params: per-LoRA fields or global (when mode === "all")
    const sStartPct = scheduleMode === "all" ? (config.globalScheduleStartPercent ?? 0.0) : (lora.scheduleStartPercent ?? 0.0);
    const sEndPct = scheduleMode === "all" ? (config.globalScheduleEndPercent ?? 1.0) : (lora.scheduleEndPercent ?? 1.0);
    const sStrStart = scheduleMode === "all" ? (config.globalScheduleStrengthStart ?? 0.0) : (lora.scheduleStrengthStart ?? 0.0);
    const sStrEnd = scheduleMode === "all" ? (config.globalScheduleStrengthEnd ?? 1.0) : (lora.scheduleStrengthEnd ?? 1.0);
    const sInterp = scheduleMode === "all" ? (config.globalScheduleInterpolation ?? "linear") : (lora.scheduleInterpolation ?? "linear");
    const sKfCount = scheduleMode === "all" ? (config.globalScheduleKeyframes ?? 5) : (lora.scheduleKeyframes ?? 5);

    // CreateHookLora: load LoRA with strength=1.0 - actual strength is controlled by keyframes
    nodes[hookId] = {
      class_type: "CreateHookLora",
      inputs: {
        lora_name: lora.name.replace(/\//g, "\\"),
        strength_model: 1.0,
        strength_clip: 1.0,
        ...(lastHookNode ? { prev_hooks: [lastHookNode, 0] } : {}),
      },
    };

    // CreateHookKeyframesInterpolated: keyframe values ARE the absolute effective strength
    nodes[kfId] = {
      class_type: "CreateHookKeyframesInterpolated",
      inputs: {
        strength_start: sStrStart,
        strength_end: sStrEnd,
        interpolation: sInterp,
        start_percent: sStartPct,
        end_percent: sEndPct,
        keyframes_count: sKfCount,
        print_keyframes: false,
      },
    };

    // SetHookKeyframes: apply the schedule to the hook
    nodes[setKfId] = {
      class_type: "SetHookKeyframes",
      inputs: {
        hooks: [hookId, 0],
        hook_kf: [kfId, 0],
      },
    };

    lastHookNode = setKfId;
  });

  // SetClipHooks: if we have scheduled LoRAs, apply hooks to CLIP
  // The hooked CLIP is used downstream for text encoding (CLIPTextEncode or PromptRelayEncode)
  let clipSource: [string, number] = ["88", 0]; // default: raw DualCLIPLoader output
  if (lastHookNode) {
    nodes["651"] = {
      class_type: "SetClipHooks",
      inputs: {
        clip: ["88", 0],
        hooks: [lastHookNode, 0],
        apply_to_conds: true,
        schedule_clip: false,
      },
    };
    clipSource = ["651", 0];
  }

  // LTXVChunkFeedForward: chunk feedforward to reduce peak VRAM (Alternative: chunks=4, dim=4096)
  // Note: when Prompt Relay is active, the model is first patched by PromptRelayEncode (node 500)
  // before reaching ChunkFeedForward. Without Prompt Relay, model comes from the LoRA chain.
  const modelBeforeChunk = (config.promptRelay && config.promptRelaySegments?.length) ? "500" : lastLoraNode;
  nodes["122"] = {
    class_type: "LTXVChunkFeedForward",
    inputs: {
      model: [modelBeforeChunk, 0],
      chunks: config.ffChunks ?? 4,
      dim_threshold: config.ffDimThreshold ?? 4096,
    },
  };

  // LTX2AttentionTunerPatch: attention scaling (all defaults 1.0 - reduces peak VRAM via custom forward)
  // Requires ComfyUI v0.16+ with _apply_text_cross_attention in BasicAVTransformerBlock
  nodes["160"] = {
    class_type: "LTX2AttentionTunerPatch",
    inputs: {
      model: ["122", 0],
      blocks: "",
      video_scale: config.videoScale ?? 1,
      audio_scale: config.audioScale ?? 1,
      audio_to_video_scale: config.audioToVideoScale ?? 1,
      video_to_audio_scale: config.videoToAudioScale ?? 1,
    },
  };

  // VAELoader: video VAE
  nodes["107"] = {
    class_type: "VAELoader",
    inputs: {
      vae_name: config.videoVae,
    },
  };

  // LTXVAudioVAELoader: audio VAE (loads from checkpoints/ folder)
  nodes["87"] = {
    class_type: "LTXVAudioVAELoader",
    inputs: {
      ckpt_name: config.audioVae,
    },
  };

  // ── Text Encoding (No CFG, distilled model) ──

  const styledPrompt = applyStylePrefix(config.prompt, config.stylePreset || "none");
  const usePromptRelay = !!(config.promptRelay && config.promptRelaySegments?.length);

  // Conditioning source node: either CLIPTextEncode ("6") or PromptRelayEncode ("500")
  let conditioningSource: string;

  if (usePromptRelay) {
    // PromptRelayEncode: temporal segmentation of prompts with attention masking.
    // Outputs: [0] = patched model (attention-masked for temporal segments), [1] = conditioning
    const segments = config.promptRelaySegments!;
    const localPrompts = segments.map((s) => s.text).join(" | ");
    // Convert proportional weights → pixel-space frame counts (PromptRelay expects actual frame counts, not ratios)
    const totalWeight = segments.reduce((sum, s) => sum + s.weight, 0);
    const segmentLengths = segments.map((s) => String(Math.round((s.weight / totalWeight) * config.numFrames))).join(",");
    const globalPrompt = config.promptRelayGlobal || styledPrompt;

    nodes["500"] = {
      class_type: "PromptRelayEncode",
      inputs: {
        model: [lastLoraNode, 0],
        clip: clipSource,
        latent: ["13", 0],
        global_prompt: globalPrompt,
        local_prompts: localPrompts,
        segment_lengths: segmentLengths,
        epsilon: config.promptRelayEpsilon ?? 0.001,
      },
    };
    conditioningSource = "500";
    // Note: node "500" output [0] = patched model → goes to ChunkFeedForward (modelBeforeChunk above)
    //       node "500" output [1] = conditioning → used below
  } else {
    // Standard CLIPTextEncode: single prompt for the entire video
    nodes["6"] = {
      class_type: "CLIPTextEncode",
      inputs: {
        text: styledPrompt,
        clip: clipSource,
      },
    };
    conditioningSource = "6";
  }

  // ConditioningZeroOut: zero negative (no CFG with distilled model)
  nodes["86"] = {
    class_type: "ConditioningZeroOut",
    inputs: {
      conditioning: [conditioningSource, usePromptRelay ? 1 : 0],
    },
  };

  // LTXVConditioning: inject frame rate into conditioning
  nodes["20"] = {
    class_type: "LTXVConditioning",
    inputs: {
      positive: [conditioningSource, usePromptRelay ? 1 : 0],
      negative: ["86", 0],
      frame_rate: config.frameRate,
    },
  };

  // ── 10S Likeness Identity Preservation (optional) ──
  // When enabled, LTXLikenessGuide encodes a reference face into conditioning metadata,
  // and LTXLikenessAnchor hooks the model's attention to stabilize face identity over time.
  // Only active for I2V workflows (needs a face reference image).
  const useLikeness = !!(config.likenessEnabled && (config.likenessImage || config.sourceImage));
  let likenessCondPos: string = "20";  // conditioning source for downstream (may be overridden by Likeness)

  if (useLikeness) {
    const likenessRef = config.likenessImage || config.sourceImage;

    // Node 850: LoadImage - load the likeness reference face
    nodes["850"] = {
      class_type: "LoadImage",
      inputs: { image: likenessRef },
    };

    // Node 851: LTXLikenessGuide - encode face reference into conditioning + emit reference_info
    nodes["851"] = {
      class_type: "LTXLikenessGuide",
      inputs: {
        positive: ["20", 0],
        negative: ["20", 1],
        vae: ["107", 0],
        latent: ["13", 0],
        image: ["850", 0],
        strength: 0.90,
        placement_mode: "silent_reference",
        face_detect: config.likenessFaceDetect ?? "auto",
        reference_mask_mode: config.likenessRefMaskMode ?? "bbox_softfade",
        face_padding: 0.15,
        crf: 24,
        blur_radius: 0,
        interpolation: "area",
        crop: "center",
        attention_strength: 1.0,
        emit_latent: "passthrough",
        debug: false,
      },
    };

    // Node 852: LTXLikenessAnchor - hook attn1 to pull generated face tokens toward reference
    nodes["852"] = {
      class_type: "LTXLikenessAnchor",
      inputs: {
        model: ["160", 0],
        strength: config.likenessAnchorStrength ?? 0.25,
        reference_info: ["851", 3],
        reference_source: "auto",
        similarity_threshold: config.likenessSimThreshold ?? 0.50,
        decay_with_distance: config.likenessDecay ?? 0.0,
        bypass: false,
        debug: false,
        advanced_mode: true,
        depth_curve: "middle",
        block_index_filter: "",
        similarity_sharpness: 8.0,
        override_face_bbox: "",
        skip_when_sigma_above: 0.0,
        pull_mode: config.likenessPullMode ?? "directional",
        late_block_falloff: config.likenessLateBlockFalloff ?? 0.4,
      },
    };

    likenessCondPos = "851";  // downstream conditioning now comes from LikenessGuide
  }

  // ── Latent Preparation ──

  const isV2aFast = !!(config.v2aFastMode && config.sourceVideoPath);

  // ── Retake / Extend (native continuity editing of an existing video) ──
  // Load the source video, VAE-encode it, and freeze the "keep" region via
  // LTXVSetAudioVideoMaskByTime so only the target window is regenerated.
  const isRetake = config.continuityMode === "retake" && !!config.continuitySourceVideo;
  const isExtend = config.continuityMode === "extend" && !!config.continuitySourceVideo;
  const isContinuity = isRetake || isExtend;

  // ── Turbo Upscale: halve resolution for first pass, upscale + refine later ──
  // Disabled in continuity mode: we operate on real, full-resolution source frames.
  const isTurbo = !!(config.turboUpscale && !isV2aFast && !isContinuity);
  const turboMethod = config.turboUpscaleMethod || TURBO_UPSCALE_DEFAULTS.method;
  const turboHalf = isTurbo ? getTurboHalfResolution(config.width, config.height) : null;
  const samplingWidth = isTurbo ? turboHalf!.width : config.width;
  const samplingHeight = isTurbo ? turboHalf!.height : config.height;

  // EmptyLTXVLatentVideo: always created (used directly for T2V, as base for I2V AddGuideMulti,
  // or as base for V2A Fast Mode LTXVImgToVideoInplace)
  // When Turbo Upscale is enabled, uses half resolution for the first sampling pass.
  nodes["13"] = {
    class_type: "EmptyLTXVLatentVideo",
    inputs: {
      width: samplingWidth,
      height: samplingHeight,
      length: config.numFrames,
      batch_size: 1,
    },
  };

  if (isV2aFast) {
    // ── V2A Fast Mode ──
    // Load the pre-trimmed chunk video and encode ALL frames into the video latent.
    // With strength=1.0, the noise_mask is 0 everywhere → video is fully frozen.
    // The sampler only denoises the audio portion, conditioned on the real video content.

    // Node 400: Load source video (pre-trimmed to chunk, at target res/fps)
    nodes["400"] = {
      class_type: "VHS_LoadVideoPath",
      inputs: {
        video: config.sourceVideoPath,
        force_rate: config.frameRate,
        custom_width: config.width,
        custom_height: config.height,
        frame_load_cap: config.numFrames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    };

    // Node 401: VAE-encode video frames with tiling (temporal + spatial) to avoid VRAM OOM.
    // LTXVImgToVideoInplace encodes all frames at once → OOM on 257 frames.
    // VAEEncodeTiled chunks the encode into temporal_size batches with overlap.
    // The frozen noise mask is handled downstream by LTXVSetAudioVideoMaskByTime (mask_init_value_video=0).
    nodes["401"] = {
      class_type: "VAEEncodeTiled",
      inputs: {
        pixels: ["400", 0],
        vae: ["107", 0],
        tile_size: config.vaeTileSize ?? 512,
        overlap: config.vaeOverlap ?? 64,
        temporal_size: config.vaeTemporalSize ?? 64,
        temporal_overlap: config.vaeTemporalOverlap ?? 16,
      },
    };

  } else if (!isContinuity && (hasSourceImage || (config.guideFrames && config.guideFrames.length > 0))) {
    // Build guide list: combine sourceImage (as frame-0 guide) with any explicit guideFrames.
    // If a guide frame already targets frame 0, the user's explicit choice takes precedence.
    const guides: { image: string; frameIdx: number; strength: number }[] = [];
    if (config.guideFrames && config.guideFrames.length > 0) {
      for (const g of config.guideFrames) {
        guides.push({ image: g.image, frameIdx: g.frameIdx, strength: g.strength ?? 1.0 });
      }
    }
    if (hasSourceImage && !guides.some((g) => g.frameIdx === 0)) {
      guides.unshift({ image: config.sourceImage, frameIdx: 0, strength: config.i2vStrength ?? 1.0 });
    }
    // Perfect Loop: add source image as end-frame guide so the model cycles back to the start
    const lastFrameIdx = config.numFrames - 1;
    if (config.perfectLoop && hasSourceImage && !guides.some((g) => g.frameIdx === lastFrameIdx)) {
      guides.push({ image: config.sourceImage, frameIdx: lastFrameIdx, strength: config.perfectLoopEndStrength ?? 0.85 });
    }

    // For each guide: LoadImage (node 300+i*3) → ImageScale (301+i*3) → LTXVPreprocess (302+i*3)
    // Perfect Loop optimization: if first and last guides share the same image, reuse the
    // LoadImage + ImageScale + Preprocess nodes to avoid loading/encoding the image twice.
    const loopReuseIdx = config.perfectLoop
      ? guides.findIndex((g, i) => i > 0 && g.image === guides[0]?.image)
      : -1;

    for (let i = 0; i < guides.length; i++) {
      if (i === loopReuseIdx) continue; // skip, will reuse node from first guide
      const loadId = String(300 + i * 3);
      const scaleId = String(301 + i * 3);
      const prepId = String(302 + i * 3);

      nodes[loadId] = {
        class_type: "LoadImage",
        inputs: { image: guides[i].image },
      };
      nodes[scaleId] = {
        class_type: "ImageScale",
        inputs: {
          image: [loadId, 0],
          upscale_method: "lanczos",
          width: samplingWidth,
          height: samplingHeight,
          crop: "center",
        },
      };
      nodes[prepId] = {
        class_type: "LTXVPreprocess",
        inputs: {
          image: [scaleId, 0],
          img_compression: config.imgCompression,
        },
      };
    }

    // LTXVAddGuideMulti: inject all guide images into conditioning + latent
    // Uses DynamicCombo: num_guides selects option key, sub-inputs use dot-notation prefix
    // When Likeness is active, conditioning flows from LikenessGuide (node 801) instead of LTXVConditioning (20)
    const guideInputs: Record<string, unknown> = {
      positive: [likenessCondPos, 0],
      negative: [likenessCondPos, 1],
      vae: ["107", 0],
      latent: ["13", 0],
      num_guides: String(guides.length),
    };
    for (let i = 0; i < guides.length; i++) {
      // Perfect Loop: reuse the first guide's preprocessed node for the end-frame guide
      const srcIdx = (i === loopReuseIdx) ? 0 : i;
      const prepId = String(302 + srcIdx * 3);
      const n = i + 1; // 1-indexed for DynamicCombo
      guideInputs[`num_guides.image_${n}`] = [prepId, 0];
      guideInputs[`num_guides.frame_idx_${n}`] = guides[i].frameIdx;
      guideInputs[`num_guides.strength_${n}`] = guides[i].strength;
    }
    nodes["102"] = {
      class_type: "LTXVAddGuideMulti",
      inputs: guideInputs,
    };
  }

  // Empty audio latent
  nodes["18"] = {
    class_type: "LTXVEmptyLatentAudio",
    inputs: {
      audio_vae: ["87", 0],
      frames_number: config.numFrames,
      frame_rate: config.frameRate,
      batch_size: 1,
    },
  };

  // Concat audio + video latents
  // V2A Fast: video from LTXVImgToVideoInplace; I2V: from AddGuideMulti; T2V: from EmptyLTXVLatentVideo
  nodes["19"] = {
    class_type: "LTXVConcatAVLatent",
    inputs: {
      video_latent: isV2aFast ? ["401", 0] : (hasSourceImage || (config.guideFrames && config.guideFrames.length > 0)) ? ["102", 2] : ["13", 0],
      audio_latent: ["18", 0],
    },
  };

  // ── Audio Overlap Conditioning (optional) ──
  // When overlapAudioFile is set, we load a reference audio (voice sample or previous chunk tail),
  // VAE-encode it, prepend it to the empty audio latent, and freeze it with a noise mask.
  // The diffusion model then generates audio as a natural continuation of the reference.
  // In V2A Fast Mode, conditioning comes directly from LTXVConditioning (no guide frames)
  // When Likeness is active and no guides, conditioning comes from LikenessGuide (node 801) instead of "20"
  const condSource = (!isContinuity && (hasSourceImage || (config.guideFrames && config.guideFrames.length > 0)) && !isV2aFast) ? "102" : likenessCondPos;
  let samplerCondPos: unknown = [condSource, 0];
  let samplerCondNeg: unknown = [condSource, 1];
  let samplerLatent: unknown = ["19", 0];

  // ── Retake / Extend: source-video latents + time-based freeze/regenerate mask ──
  // Builds the source latent (+ an empty tail for Extend via LTXVAddLatents), overrides the
  // AV concat (node 19) to use it, then freezes everything outside the target window with
  // LTXVSetAudioVideoMaskByTime (init 0.0 = freeze; the [start,end] window is set to 1.0 = regenerate).
  if (isContinuity) {
    const fps = config.frameRate;
    const totalFrames = config.numFrames;
    // Retake: the whole clip IS the source. Extend: source is the first N frames, tail is appended.
    const sourceFrames = isExtend
      ? Math.max(1, Math.min(config.continuitySourceFrames ?? 0, totalFrames - 1))
      : totalFrames;
    const tailFrames = Math.max(0, totalFrames - sourceFrames);
    const sourceDur = sourceFrames / fps;
    const totalDur = totalFrames / fps;
    const audioOn = config.enableAudio;

    // Node 420: load the source video (ABSOLUTE path), normalized to target res/fps
    nodes["420"] = {
      class_type: "VHS_LoadVideoPath",
      inputs: {
        video: config.continuitySourceVideo,
        force_rate: fps,
        custom_width: config.width,
        custom_height: config.height,
        frame_load_cap: sourceFrames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    };
    // Node 421: VAE-encode the source frames into a video latent (tiled to avoid OOM)
    nodes["421"] = {
      class_type: "VAEEncodeTiled",
      inputs: {
        pixels: ["420", 0],
        vae: ["107", 0],
        tile_size: config.vaeTileSize ?? 512,
        overlap: config.vaeOverlap ?? 64,
        temporal_size: config.vaeTemporalSize ?? 64,
        temporal_overlap: config.vaeTemporalOverlap ?? 16,
      },
    };
    // Node 424: VAE-encode the source audio (output index 2 of VHS_LoadVideoPath)
    if (audioOn) {
      nodes["424"] = {
        class_type: "LTXVAudioVAEEncode",
        inputs: { audio: ["420", 2], audio_vae: ["87", 0] },
      };
    }

    let videoLatentRef: [string, number] = ["421", 0];
    let audioLatentRef: [string, number] = audioOn ? ["424", 0] : ["18", 0];

    if (isExtend && tailFrames > 0) {
      // Empty tail appended AFTER the source via frame-dim concat (LTXVAddLatents).
      nodes["422"] = {
        class_type: "EmptyLTXVLatentVideo",
        inputs: { width: config.width, height: config.height, length: tailFrames, batch_size: 1 },
      };
      nodes["423"] = {
        class_type: "LTXVAddLatents",
        inputs: { latents1: ["421", 0], latents2: ["422", 0] },
      };
      videoLatentRef = ["423", 0];
      if (audioOn) {
        nodes["425"] = {
          class_type: "LTXVEmptyLatentAudio",
          inputs: { audio_vae: ["87", 0], frames_number: tailFrames, frame_rate: fps, batch_size: 1 },
        };
        nodes["426"] = {
          class_type: "LTXVAddLatents",
          inputs: { latents1: ["424", 0], latents2: ["425", 0] },
        };
        audioLatentRef = ["426", 0];
      }
    }

    // Override the AV concat to use the source-derived latents
    nodes["19"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: { video_latent: videoLatentRef, audio_latent: audioLatentRef },
    };

    // Target window: retake → [retakeStart, retakeEnd]; extend → [sourceDur, totalDur] (the tail).
    const winStart = isExtend ? sourceDur : Math.max(0, Math.min(config.retakeStart ?? 0, totalDur));
    const winEnd = isExtend
      ? totalDur
      : Math.max(winStart, Math.min(config.retakeEnd ?? totalDur, totalDur));
    // Extend always regenerates the appended tail's audio (source audio frozen). Retake keeps the
    // original audio untouched unless retakeRegenAudio is set.
    const maskAudio = audioOn && (isExtend || !!config.retakeRegenAudio);

    nodes["430"] = {
      class_type: "LTXVSetAudioVideoMaskByTime",
      inputs: {
        av_latent: ["19", 0],
        positive: [condSource, 0],
        negative: [condSource, 1],
        model: ["160", 0],
        vae: ["107", 0],
        audio_vae: ["87", 0],
        start_time: winStart,
        end_time: winEnd,
        video_fps: fps,
        mask_video: true,
        mask_audio: maskAudio,
        mask_init_value_video: 0.0,
        mask_init_value_audio: 0.0,
        slope_len: 3,
      },
    };

    samplerCondPos = ["430", 0];
    samplerCondNeg = ["430", 1];
    samplerLatent = ["430", 2];
  }

  const hasOverlap = !isContinuity && !!(config.overlapAudioFile && config.overlapDuration && config.overlapDuration > 0);

  if (hasOverlap) {
    const overlapDur = config.overlapDuration!;
    const chunkDur = config.numFrames / config.frameRate;
    const overlapFrames = Math.round(overlapDur * config.frameRate);
    const remainingFrames = Math.max(1, config.numFrames - overlapFrames);

    // Load overlap/voice reference audio from ComfyUI input/
    nodes["200"] = {
      class_type: "LoadAudio",
      inputs: { audio: config.overlapAudioFile },
    };

    // Encode to audio latent via Audio VAE
    nodes["201"] = {
      class_type: "LTXVAudioVAEEncode",
      inputs: { audio: ["200", 0], audio_vae: ["87", 0] },
    };

    // Empty audio latent for the remaining (non-overlap) portion
    nodes["202"] = {
      class_type: "LTXVEmptyLatentAudio",
      inputs: {
        audio_vae: ["87", 0],
        frames_number: remainingFrames,
        frame_rate: config.frameRate,
        batch_size: 1,
      },
    };

    // Concatenate: [encoded overlap audio] + [empty remainder] → full-length audio latent
    nodes["203"] = {
      class_type: "LTXVAddLatents",
      inputs: {
        latents1: ["201", 0],
        latents2: ["202", 0],
      },
    };

    // Override ConcatAVLatent to use overlap-conditioned audio instead of empty
    nodes["19"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: {
        video_latent: isV2aFast ? ["401", 0] : (hasSourceImage ? ["102", 2] : ["13", 0]),
        audio_latent: ["203", 0],
      },
    };

    // Set noise mask to freeze overlap audio and (in V2A Fast Mode) freeze video
    nodes["204"] = {
      class_type: "LTXVSetAudioVideoMaskByTime",
      inputs: {
        av_latent: ["19", 0],
        positive: [condSource, 0],
        negative: [condSource, 1],
        model: ["160", 0],
        vae: ["107", 0],
        audio_vae: ["87", 0],
        start_time: overlapDur,
        end_time: chunkDur,
        video_fps: config.frameRate,
        mask_video: false,
        mask_audio: true,
        mask_init_value_video: isV2aFast ? 0.0 : 1.0,
        mask_init_value_audio: 0.0,
        slope_len: 3,
      },
    };

    // Rewire downstream nodes through masked outputs
    samplerCondPos = ["204", 0];
    samplerCondNeg = ["204", 1];
    samplerLatent = ["204", 2];

  } else if (isV2aFast) {
    // V2A Fast Mode without overlap: freeze video latent, open all audio
    const chunkDur = config.numFrames / config.frameRate;

    nodes["204"] = {
      class_type: "LTXVSetAudioVideoMaskByTime",
      inputs: {
        av_latent: ["19", 0],
        positive: ["20", 0],
        negative: ["20", 1],
        model: ["160", 0],
        vae: ["107", 0],
        audio_vae: ["87", 0],
        start_time: 0.0,
        end_time: chunkDur,
        video_fps: config.frameRate,
        mask_video: false,
        mask_audio: true,
        mask_init_value_video: 0.0,
        mask_init_value_audio: 0.0,
        slope_len: 3,
      },
    };

    samplerCondPos = ["204", 0];
    samplerCondNeg = ["204", 1];
    samplerLatent = ["204", 2];
  }

  // ── Sampling (LCM sampler, distilled sigmas, no CFG) ──

  nodes["124"] = {
    class_type: "RandomNoise",
    inputs: {
      noise_seed: seed,
    },
  };

  nodes["126"] = {
    class_type: "KSamplerSelect",
    inputs: {
      sampler_name: "lcm",
    },
  };

  // ManualSigmas: Alternative's distilled sigma schedule (8 steps)
  nodes["132"] = {
    class_type: "ManualSigmas",
    inputs: {
      sigmas: LTX2_DISTILLED_SIGMAS,
    },
  };

  // ── Optional Live Preview via Tiny VAE (KJNodes LTX2SamplingPreviewOverride) ──
  // Loads a lightweight ~23MB Tiny AutoEncoder for low-quality but real-time
  // preview frames during sampling. Wraps the model with a callback that
  // decodes latents to preview images at a configurable rate.
  // Off by default: adds VRAM pressure that can cause swapping on tight setups.
  // When Likeness is active, model comes from LikenessAnchor (852) instead of AttentionTunerPatch (160).
  const modelAfterPatches: [string, number] = useLikeness ? ["852", 0] : ["160", 0];
  const phrootModelOut: [string, number] = config.livePreview ? ["602", 0] : modelAfterPatches;
  if (config.livePreview) {
    nodes["601"] = {
      class_type: "VAELoader",
      inputs: { vae_name: "taeltx2_3.safetensors" },
    };
    nodes["602"] = {
      class_type: "LTX2SamplingPreviewOverride",
      inputs: {
        model: modelAfterPatches,
        preview_rate: config.previewRate ?? 8,
        vae: ["601", 0],
      },
    };
  }

  // BasicGuider: no-CFG guider - model from AttentionTunerPatch chain (or preview-wrapped if enabled)
  // Conditioning source: masked (if overlap) or direct from AddGuideMulti/LTXVConditioning
  nodes["170"] = {
    class_type: "BasicGuider",
    inputs: {
      model: phrootModelOut,
      conditioning: samplerCondPos,
    },
  };

  // Direct Sampling: bypass NormalizingSampler entirely, use SamplerCustomAdvanced.
  // Skips per-step audio/video normalization: community alternative that avoids
  // the normalization overhead and can produce different (sometimes cleaner) results.
  if (config.directSampling) {
    nodes["123"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["124", 0],
        guider: ["170", 0],
        sampler: ["126", 0],
        sigmas: ["132", 0],
        latent_image: samplerLatent,
      },
    };
  } else {
    // VekSnapAVNormSampler: drop-in for LTXVNormalizingSampler WITH live video preview.
    // Video norms: all 1s (no scaling). Audio norms: reduce at steps 3,6 to 0.25 (Alternative's recipe)
    nodes["123"] = {
      class_type: "LTXVNormalizingSampler", // was VekSnapAVNormSampler - disabled temporarily to isolate OOM
      inputs: {
        noise: ["124", 0],
        guider: ["170", 0],
        sampler: ["126", 0],
        sigmas: ["132", 0],
        latent_image: samplerLatent,
        video_normalization_factors: config.videoNormFactors,
        audio_normalization_factors: config.audioNormFactors,
      },
    };
  }

  // ── Post-Processing ──

  // Separate audio/video latents from sampler output
  nodes["14"] = {
    class_type: "LTXVSeparateAVLatent",
    inputs: {
      av_latent: ["123", 0],
    },
  };

  // Track decode sources: may be overridden by Turbo Upscale
  let videoDecodeSource: [string, number] = ["120", 2];
  let audioDecodeSource: [string, number] = ["14", 1];

  // In V2A Fast Mode, no guides were appended and we skip video decode entirely
  // (original frames from VHS_LoadVideoPath are used for the output video).
  if (!isV2aFast) {
    // Crop guides from video latent
    // Uses masked conditioning when overlap is active, otherwise direct from AddGuideMulti/LTXVConditioning
    // outputs: [0] positive, [1] negative, [2] latent
    nodes["120"] = {
      class_type: "LTXVCropGuides",
      inputs: {
        positive: samplerCondPos,
        negative: samplerCondNeg,
        latent: ["14", 0],
      },
    };

    // ── Turbo Upscale: 2x latent upscale + refinement pass ──
    // Inserts between CropGuides (120) and VAEDecode (129).
    // Upscales the half-res video latent back to full resolution, optionally re-injects
    // source image conditioning, then runs a short refinement sampling pass.

    if (isTurbo && turboMethod === "latent") {
      // Load latent upscale model
      nodes["800"] = {
        class_type: "LatentUpscaleModelLoader",
        inputs: {
          model_name: config.turboUpscaleModel || TURBO_UPSCALE_DEFAULTS.model,
        },
      };

      // Upscale video latent 2x (half-res → full-res)
      nodes["801"] = {
        class_type: "LTXVLatentUpsampler",
        inputs: {
          samples: ["120", 2],
          upscale_model: ["800", 0],
          vae: ["107", 0],
        },
      };

      // Re-inject source image at full resolution (anchors first frame after upscale)
      let upscaledVideoLatent: [string, number] = ["801", 0];
      if (hasSourceImage) {
        const refineStr = config.turboUpscaleRefineStrength ?? TURBO_UPSCALE_DEFAULTS.refineStrength;
        // Load source image at full resolution for re-injection (guide images were scaled to half-res)
        nodes["810"] = {
          class_type: "LoadImage",
          inputs: { image: config.sourceImage },
        };
        nodes["802"] = {
          class_type: "LTXVImgToVideoInplace",
          inputs: {
            vae: ["107", 0],
            image: ["810", 0],
            latent: ["801", 0],
            strength: refineStr,
            bypass: false,
          },
        };
        upscaledVideoLatent = ["802", 0];
      }

      // Recombine upscaled video + audio latent for refinement sampling
      nodes["803"] = {
        class_type: "LTXVConcatAVLatent",
        inputs: {
          video_latent: upscaledVideoLatent,
          audio_latent: audioDecodeSource,
        },
      };

      // CFGGuider for refinement (cfg=1: equivalent to no classifier-free guidance)
      nodes["804"] = {
        class_type: "CFGGuider",
        inputs: {
          model: phrootModelOut,
          positive: ["120", 0],
          negative: ["120", 1],
          cfg: 1.0,
        },
      };

      // Refinement sampler selection (default euler_cfg_pp, optimized for CFG-predicted noise)
      nodes["805"] = {
        class_type: "KSamplerSelect",
        inputs: { sampler_name: config.turboUpscaleSampler || TURBO_UPSCALE_DEFAULTS.sampler },
      };

      // Refinement sigmas: prefer user-supplied schedule, otherwise short auto schedule for detail recovery
      const refineSteps = config.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps;
      const defaultSigmas = [...TURBO_UPSCALE_DEFAULTS.refineSigmas];
      let refineSigmaStr: string;
      if (config.turboUpscaleCustomSigmas && config.turboUpscaleCustomSigmas.trim()) {
        // Trust the user-entered string verbatim (after trimming whitespace around commas)
        refineSigmaStr = config.turboUpscaleCustomSigmas.split(",").map(s => s.trim()).filter(Boolean).join(", ");
      } else if (refineSteps === TURBO_UPSCALE_DEFAULTS.refineSteps) {
        refineSigmaStr = defaultSigmas.join(", ");
      } else {
        const sigmas: number[] = [];
        for (let i = 0; i <= refineSteps; i++) {
          sigmas.push(0.85 * (1 - i / refineSteps));
        }
        refineSigmaStr = sigmas.map(s => s.toFixed(4)).join(", ");
      }
      nodes["806"] = {
        class_type: "ManualSigmas",
        inputs: { sigmas: refineSigmaStr },
      };

      // Refinement noise: same seed as stage 1 for temporal consistency (per Lightricks recommendation)
      nodes["807"] = {
        class_type: "RandomNoise",
        inputs: { noise_seed: seed },
      };

      // SamplerCustomAdvanced: refinement pass (direct sampling, no normalization needed)
      nodes["808"] = {
        class_type: "SamplerCustomAdvanced",
        inputs: {
          noise: ["807", 0],
          guider: ["804", 0],
          sampler: ["805", 0],
          sigmas: ["806", 0],
          latent_image: ["803", 0],
        },
      };

      // Separate refined output
      nodes["809"] = {
        class_type: "LTXVSeparateAVLatent",
        inputs: { av_latent: ["808", 0] },
      };

      videoDecodeSource = ["809", 0];
      audioDecodeSource = ["809", 1];
    }

    // VAE Decode: decode video latent to pixel space
    if (config.spatioTemporalVAE) {
      nodes["129"] = {
        class_type: "LTXVSpatioTemporalTiledVAEDecode",
        inputs: {
          latents: videoDecodeSource,
          vae: ["107", 0],
          spatial_tiles: config.spatioTemporalTiles ?? 4,
          spatial_overlap: config.spatioTemporalOverlap ?? 4,
          temporal_tile_length: config.spatioTemporalLength ?? 16,
          temporal_overlap: config.spatioTemporalTempOverlap ?? 4,
          last_frame_fix: false,
          working_device: "auto",
          working_dtype: "auto",
        },
      };
    } else {
      // VAEDecodeTiled: standard tiled decode
      // Alternative settings: tile=512, overlap=64, temporal_size=64, temporal_overlap=16
      nodes["129"] = {
        class_type: "VAEDecodeTiled",
        inputs: {
          samples: videoDecodeSource,
          vae: ["107", 0],
          tile_size: config.vaeTileSize ?? 512,
          overlap: config.vaeOverlap ?? 64,
          temporal_size: config.vaeTemporalSize ?? 64,
          temporal_overlap: config.vaeTemporalOverlap ?? 16,
        },
      };
    }
  }

  // RTX Video Super Resolution: hardware-accelerated pixel upscale (after VAE decode)
  let finalVideoImages: [string, number] = ["129", 0];
  if (isTurbo && turboMethod === "rtx_vsr") {
    nodes["820"] = {
      class_type: "RTXVideoSuperResolution",
      inputs: {
        images: ["129", 0],
        resize_type: "scale by multiplier",
        "resize_type.scale": 2.0,
        quality: TURBO_UPSCALE_DEFAULTS.rtxVsrQuality,
      },
    };
    finalVideoImages = ["820", 0];
  }

  // Audio VAE Decode (uses Turbo-refined audio if available, otherwise pass-1 audio)
  nodes["16"] = {
    class_type: "LTXVAudioVAEDecode",
    inputs: {
      samples: audioDecodeSource,
      audio_vae: ["87", 0],
    },
  };

  // VHS_VideoCombine: encode final MP4 with audio
  // V2A Fast Mode: use original video frames from VHS_LoadVideoPath (node 400)
  // Standard mode: use decoded video from VAEDecodeTiled (node 129)
  const videoCombineInputs: Record<string, unknown> = {
    images: isV2aFast ? ["400", 0] : finalVideoImages,
    frame_rate: config.frameRate,
    loop_count: 0,
    filename_prefix: "ltx2/VekSnap_LTX2",
    format: "video/h264-mp4",
    pix_fmt: "yuv420p",
    save_output: true,
    pingpong: false,
    save_metadata: config.embedWorkflowMetadata !== false,
  };

  if (config.enableAudio) {
    videoCombineInputs.audio = ["16", 0];
  }

  nodes["17"] = {
    class_type: "VHS_VideoCombine",
    inputs: videoCombineInputs,
  };

  return nodes;
}

// ── LTX-2 Official Lightricks Workflow ──
// Based on the official LTX-2.3_T2V_I2V_Single_Stage_Distilled_Full.json from
// https://github.com/Lightricks/ComfyUI-LTXVideo/tree/master/example_workflows/2.3
//
// Key differences from Alternative workflow:
// - Uses DualCLIPLoader (split files) but with official sampling chain
// - Actual negative prompt via CLIPTextEncode (not ConditioningZeroOut)
// - Distilled tier: CFGGuider(cfg=1) + euler_ancestral_cfg_pp + ManualSigmas (8 steps)
// - Full tier: MultimodalGuider + ClownSampler_Beta + LTXVScheduler (15 steps)
// - Lower distill LoRA strengths: 0.5 (distilled) / 0.2 (full)
// - VekSnapAVNormSampler for per-step audio latent normalization (with live preview)
// - No ChunkFeedForward / AttentionTunerPatch (relies on tiling for VRAM)
// - Supports A2V: upload audio → freeze audio latent → generate video conditioned on audio
/**
 * Compute LTXVScheduler sigmas in TypeScript (replicates the Python math exactly).
 * This bypasses the ComfyUI LTXVScheduler node which can produce NaN sigmas
 * when receiving certain latent inputs due to NestedTensor / execution-order issues.
 *
 * The formula matches comfy_extras/nodes_lt.py LTXVScheduler.execute():
 *   tokens = prod(latent.shape[2:])  →  latentT * latentH * latentW
 *   sigma_shift = tokens * (max_shift - base_shift) / (4096 - 1024) + base_shift - (max_shift - base_shift) / (4096 - 1024) * 1024
 *   shifted[i] = exp(sigma_shift) / (exp(sigma_shift) + (1/s - 1))  for s != 0
 *   stretch: scale so final non-zero sigma equals `terminal`
 */
function computeFullTierSigmas(config: LTX2Config): string {
  const steps = config.fullSteps ?? LTX2_OFFICIAL_SCHEDULER.steps;
  const maxShift = config.schedulerShift ?? LTX2_OFFICIAL_SCHEDULER.shift;
  const baseShift = config.schedulerBaseShift ?? LTX2_OFFICIAL_SCHEDULER.baseShift;
  const stretch = LTX2_OFFICIAL_SCHEDULER.stretch;
  const terminal = config.schedulerTerminal ?? LTX2_OFFICIAL_SCHEDULER.terminal;

  // Replicate EmptyLTXVLatentVideo shape: [B, 128, ((L-1)//8)+1, H//32, W//32]
  const latentT = Math.floor((config.numFrames - 1) / 8) + 1;
  const latentH = Math.floor(config.height / 32);
  const latentW = Math.floor(config.width / 32);
  const tokens = latentT * latentH * latentW;

  // Sigma shift (linear interpolation based on token count)
  const x1 = 1024, x2 = 4096;
  const mm = (maxShift - baseShift) / (x2 - x1);
  const b = baseShift - mm * x1;
  const sigmaShift = tokens * mm + b;
  const expShift = Math.exp(sigmaShift);

  // Generate raw sigmas: linspace(1, 0, steps+1)
  const sigmas: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = 1.0 - i / steps;
    if (s === 0) {
      sigmas.push(0);
    } else {
      sigmas.push(expShift / (expShift + (1.0 / s - 1.0)));
    }
  }

  // Stretch so final non-zero sigma equals terminal
  if (stretch) {
    for (let i = 0; i < sigmas.length; i++) {
      if (sigmas[i] !== 0) {
        const oneMinusZ = 1.0 - sigmas[i];
        // Find last non-zero sigma's (1 - sigma) for scale factor
        let lastOneMinusZ = 0;
        for (let j = sigmas.length - 1; j >= 0; j--) {
          if (sigmas[j] !== 0) {
            lastOneMinusZ = 1.0 - sigmas[j];
            break;
          }
        }
        const scaleFactor = lastOneMinusZ / (1.0 - terminal);
        sigmas[i] = 1.0 - oneMinusZ / scaleFactor;
      }
    }
  }

  // Format as comma-separated string for ManualSigmas
  return sigmas.map((s) => s.toFixed(6)).join(", ");
}

// ── Motion Track Helpers ──
// Catmull-Rom spline interpolation matching Lightricks LTXVSparseTrackEditor
function catmullRom(
  p0: MotionTrackPoint, p1: MotionTrackPoint, p2: MotionTrackPoint, p3: MotionTrackPoint, t: number
): MotionTrackPoint {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function interpolateSpline(controlPoints: MotionTrackPoint[], numSamples: number): MotionTrackPoint[] {
  if (controlPoints.length === 0) return [];
  if (controlPoints.length === 1) return Array(numSamples).fill(controlPoints[0]);
  if (controlPoints.length === 2) {
    const [a, b] = controlPoints;
    return Array.from({ length: numSamples }, (_, i) => ({
      x: a.x + (b.x - a.x) * i / (numSamples - 1),
      y: a.y + (b.y - a.y) * i / (numSamples - 1),
    }));
  }
  const pts = [controlPoints[0], ...controlPoints, controlPoints[controlPoints.length - 1]];
  const nSeg = pts.length - 3;
  const result: MotionTrackPoint[] = [];
  for (let i = 0; i < numSamples; i++) {
    const gT = (i / (numSamples - 1)) * nSeg;
    const seg = Math.min(Math.floor(gT), nSeg - 1);
    const lT = gT - seg;
    result.push(catmullRom(pts[seg], pts[seg + 1], pts[seg + 2], pts[seg + 3], lT));
  }
  return result;
}

/**
 * Apply easing function to a linear 0-1 parameter.
 */
function applyEasing(t: number, easing: MotionTrack["easing"]): number {
  switch (easing) {
    case "ease-in": return t * t;
    case "ease-out": return 1 - (1 - t) * (1 - t);
    case "ease-in-out": return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    default: return t; // linear
  }
}

/**
 * Convert motion tracks (normalized 0-1 control points) to the JSON string
 * format expected by LTXVDrawTracks: list of tracks, each track is a list of
 * {x, y} pixel-coordinate dicts (one per frame, Catmull-Rom interpolated).
 *
 * Supports per-track time windows (startTime/endTime) and easing curves.
 * Before startTime the dot stays at the first control point (stationary).
 * After endTime the dot stays at the last control point (stationary).
 */
export function motionTracksToDrawJSON(
  tracks: MotionTrack[],
  numFrames: number,
  imgWidth: number,
  imgHeight: number,
  frameRate: number = 24,
): string {
  const videoDuration = (numFrames - 1) / frameRate; // seconds
  const interpolated = tracks
    .filter((t) => t.points.length >= 2 && t.enabled !== false)
    .map((track) => {
      // Convert normalized → pixel control points
      const pixelPts = track.points.map((p) => ({
        x: p.x * imgWidth,
        y: p.y * imgHeight,
      }));

      // Resolve per-track time window
      const tStart = track.startTime ?? 0;
      const tEnd = (track.endTime && track.endTime > 0) ? track.endTime : videoDuration;
      const easing = track.easing ?? "linear";
      const firstPt = pixelPts[0];
      const lastPt = pixelPts[pixelPts.length - 1];

      // Determine frame range for the active window
      const startFrame = Math.round(tStart * frameRate);
      const endFrame = Math.round(tEnd * frameRate);
      const activeFrames = Math.max(endFrame - startFrame, 2); // at least 2 frames for interpolation

      // Interpolate spline only across the active window
      const splineSamples = interpolateSpline(pixelPts, activeFrames);

      // Build per-frame coordinates for the full video
      const frames: { x: number; y: number }[] = [];
      for (let f = 0; f < numFrames; f++) {
        let pt: { x: number; y: number };
        if (f < startFrame) {
          // Before active window: stationary at first control point
          pt = firstPt;
        } else if (f >= endFrame) {
          // After active window: stationary at last control point
          pt = lastPt;
        } else {
          // Inside active window: apply easing to spline parameter
          const linearT = (f - startFrame) / Math.max(activeFrames - 1, 1);
          const easedT = applyEasing(linearT, easing);
          const idx = Math.min(Math.floor(easedT * (splineSamples.length - 1)), splineSamples.length - 1);
          const frac = easedT * (splineSamples.length - 1) - idx;
          if (idx >= splineSamples.length - 1) {
            pt = splineSamples[splineSamples.length - 1];
          } else {
            // Lerp between adjacent spline samples for smooth eased motion
            const a = splineSamples[idx];
            const b = splineSamples[idx + 1];
            pt = { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac };
          }
        }
        frames.push({ x: Math.round(pt.x), y: Math.round(pt.y) });
      }
      return frames;
    });
  return JSON.stringify(interpolated);
}

/**
 * Autoregressive Long-Form ("Top-Tier" character consistency) builder.
 *
 * Emits the validated LTXVLoopingSampler pipeline: ONE continuous
 * autoregressive job over overlapping temporal tiles, with latent-space
 * continuity carrying identity/scene across the whole clip. This replaces the
 * lossy decoded-last-frame chaining for long single shots. VIDEO-ONLY in v1.
 *
 * Model-agnostic: honors the SAME model-selection config as
 * buildLTX2OfficialWorkflow:
 *   • GGUF distilled  → fast DRAFT tier   (DualCLIPLoaderGGUF + UnetLoaderGGUF; distill baked in)
 *   • safetensors     → FINAL quality     (DualCLIPLoader + UNETLoader + cond_safe distill LoRA @1.0)
 * Both run in the distilled few-step regime (STG off, cfg=1) that was validated.
 *
 * Node IDs: 88/91/161(+) loaders, 6/7/20 conditioning, 124/126/132 sampler
 * primitives, 170 guider, 19 latent, 50 cond image, 200 LTXVLoopingSampler,
 * 210 spatiotemporal tiled VAE decode, 220 VHS_VideoCombine.
 *
 * Experimental: surfaced in the GUI with a "use with caution" label.
 */
export function buildLTX2AutoregressiveWorkflow(
  config: LTX2Config,
  seed: number,
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const useGGUF = !!(config.useGGUF && config.ggufDiffusionModel);

  // ── Model Loaders (mirrors buildLTX2OfficialWorkflow §Model Loaders) ──
  if (useGGUF) {
    nodes["88"] = {
      class_type: "DualCLIPLoaderGGUF",
      inputs: {
        clip_name1: config.ggufTextEncoder || LTX23_GGUF_DEFAULTS.ggufTextEncoder,
        clip_name2: config.connectorModel,
        type: "ltxv",
      },
    };
    nodes["91"] = {
      class_type: "UnetLoaderGGUF",
      inputs: { unet_name: config.ggufDiffusionModel },
    };
  } else {
    nodes["88"] = {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: config.textEncoder,
        clip_name2: config.connectorModel,
        type: "ltxv",
        device: "cpu",
      },
    };
    nodes["91"] = {
      class_type: "UNETLoader",
      inputs: { unet_name: config.diffusionModel, weight_dtype: "default" },
    };
  }

  // Distill LoRA: full/10Eros tier pairs with the cond_safe distill LoRA @1.0;
  // GGUF distilled has distillation baked in (config.distillLoRA empty → skipped).
  let lastLoraNode = "91";
  const skipDistillLora = !config.distillLoRA || config.distillLoRAStrength === 0;
  if (!skipDistillLora) {
    nodes["161"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["91", 0],
        lora_name: config.distillLoRA!.replace(/\//g, "\\"),
        strength_model: config.distillLoRAStrength ?? 1.0,
      },
    };
    lastLoraNode = "161";
  }

  // User LoRAs chain after the distill LoRA (character/style LoRAs for the final tier).
  const enabledLoras = (config.userLoras || []).filter((l) => l.enabled && l.name);
  enabledLoras.forEach((lora, i) => {
    const nodeId = String(162 + i);
    nodes[nodeId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [lastLoraNode, 0],
        lora_name: lora.name.replace(/\//g, "\\"),
        strength_model: lora.strengthModel,
      },
    };
    lastLoraNode = nodeId;
  });

  // Video VAE
  nodes["107"] = { class_type: "VAELoader", inputs: { vae_name: config.videoVae } };

  // ── Conditioning ──
  const styledPrompt = applyStylePrefix(config.prompt, config.stylePreset || "none");
  nodes["6"] = { class_type: "CLIPTextEncode", inputs: { text: styledPrompt, clip: ["88", 0] } };
  nodes["7"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } };
  nodes["20"] = {
    class_type: "LTXVConditioning",
    inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: config.frameRate },
  };

  // ── Guider: STGGuiderAdvanced (required by LTXVLoopingSampler).
  // Distilled regime: cfg=1, stg=0 (no guidance overhead), matches the validated spike.
  // Opt-in override (config.arGuidanceOverride): drive the per-sigma cfg/stg arrays from
  // the Classifier-Free Guidance knobs (videoCfg / stg) so the Continuum loop can run
  // full guidance. OFF keeps exact parity with the validated Vek-Spike run.
  const arOverride = config.arGuidanceOverride === true;
  const arCfg = config.videoCfg ?? 3;
  const arStg = config.stg ?? 0.0;
  const g6 = (v: number) => Array(6).fill(v).join(", ");
  nodes["170"] = {
    class_type: "STGGuiderAdvanced",
    inputs: {
      model: [lastLoraNode, 0],
      positive: ["20", 0],
      negative: ["20", 1],
      skip_steps_sigma_threshold: 0.998,
      cfg_star_rescale: true,
      sigmas: "1.0, 0.9933, 0.9850, 0.9767, 0.9008, 0.6180",
      cfg_values: arOverride ? g6(arCfg) : "1, 1, 1, 1, 1, 1",
      stg_scale_values: arOverride ? g6(arStg) : "0, 0, 0, 0, 0, 0",
      stg_rescale_values: "1, 1, 1, 1, 1, 1",
      stg_layers_indices: "[29], [29], [29], [29], [29], [29]",
    },
  };

  // ── Sampler primitives ──
  nodes["124"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
  nodes["126"] = { class_type: "KSamplerSelect", inputs: { sampler_name: config.testSampler || "euler" } };
  nodes["132"] = { class_type: "ManualSigmas", inputs: { sigmas: LTX2_DISTILLED_SIGMAS } };

  // ── Empty latent target (full clip length; the sampler tiles it internally) ──
  nodes["19"] = {
    class_type: "EmptyLTXVLatentVideo",
    inputs: { width: config.width, height: config.height, length: config.numFrames, batch_size: 1 },
  };

  // ── LTXVLoopingSampler: the autoregressive core (reads ar* config fields) ──
  const loopInputs: Record<string, unknown> = {
    model: [lastLoraNode, 0],
    vae: ["107", 0],
    noise: ["124", 0],
    sampler: ["126", 0],
    sigmas: ["132", 0],
    guider: ["170", 0],
    latents: ["19", 0],
    temporal_tile_size: config.arTemporalTileSize ?? 40,
    temporal_overlap: config.arTemporalOverlap ?? 24,
    guiding_strength: config.arGuidingStrength ?? 1.0,
    temporal_overlap_cond_strength: config.arTemporalOverlapCondStrength ?? 0.5,
    cond_image_strength: config.arCondImageStrength ?? 1.0,
    horizontal_tiles: config.arHorizontalTiles ?? 1,
    vertical_tiles: config.arVerticalTiles ?? 1,
    spatial_overlap: config.arSpatialOverlap ?? 1,
    adain_factor: config.arAdainFactor ?? 0.15,
  };

  // I2V: anchor frame 0 on the source image (falls back to pure t2v if none).
  if (config.sourceImage) {
    nodes["50"] = { class_type: "LoadImage", inputs: { image: config.sourceImage } };
    loopInputs["optional_cond_images"] = ["50", 0];
    loopInputs["optional_cond_image_indices"] = "0";
  }

  // ── Negative-index long-memory anchor ──
  // Encodes a reference image into a 1-frame LTX latent and feeds it as
  // optional_negative_index_latents for GLOBAL identity/scene memory across the
  // whole clip. Defaults to the I2V source image. Opt-in.
  const negRefImage = config.arNegativeIndexImage || config.sourceImage;
  if (config.arNegativeIndexEnabled === true && negRefImage) {
    const negLoadId = negRefImage === config.sourceImage && nodes["50"] ? "50" : "60";
    if (negLoadId === "60") {
      nodes["60"] = { class_type: "LoadImage", inputs: { image: negRefImage } };
    }
    nodes["61"] = {
      class_type: "ImageScale",
      inputs: {
        image: [negLoadId, 0],
        upscale_method: "lanczos",
        width: config.width,
        height: config.height,
        crop: "center",
      },
    };
    nodes["62"] = {
      class_type: "VAEEncode",
      inputs: { pixels: ["61", 0], vae: ["107", 0] },
    };
    loopInputs["optional_negative_index_latents"] = ["62", 0];
  }

  nodes["200"] = { class_type: "LTXVLoopingSampler", inputs: loopInputs };

  // ── Spatiotemporal tiled VAE decode (bounds decode VRAM for long clips) ──
  nodes["210"] = {
    class_type: "LTXVSpatioTemporalTiledVAEDecode",
    inputs: {
      vae: ["107", 0],
      latents: ["200", 0],
      spatial_tiles: 2,
      spatial_overlap: 1,
      temporal_tile_length: 16,
      temporal_overlap: 1,
      last_frame_fix: false,
      working_device: "auto",
      working_dtype: "auto",
    },
  };

  // ── Output ──
  nodes["220"] = {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: ["210", 0],
      frame_rate: config.frameRate,
      loop_count: 0,
      filename_prefix: "ltx2/VekSnap_LTX2_Autoregressive",
      format: "video/h264-mp4",
      pingpong: false,
      save_output: true,
    },
  };

  return nodes;
}

export function buildLTX2OfficialWorkflow(
  config: LTX2Config,
  seed: number,
): Record<string, unknown> {
  // LTX-2.5 uses the dedicated two-stage distilled AV builder.
  if (config.modelVersion === "2.5") return buildLTX25Workflow(config, seed);

  const nodes: Record<string, unknown> = {};
  const hasSourceImage = !!config.sourceImage;
  const tier = config.qualityTier || "distilled";
  const isA2V = !!(config.a2vMode && config.a2vAudioFile);

  // ── Retake / Extend (native continuity editing of an existing video) ──
  const isRetake = config.continuityMode === "retake" && !!config.continuitySourceVideo;
  const isExtend = config.continuityMode === "extend" && !!config.continuitySourceVideo;
  const isContinuity = isRetake || isExtend;

  // ── Character Consistency: Reference Sheet (Official Lightricks IC-LoRA "Ingredients") ──
  // Conditions generation on a single reference sheet (looped into a static video) so the
  // characters/props/location carry into the output. Takes precedence over and is mutually
  // exclusive with the motion-guide / motion-track IC-LoRA paths (they share the IC-LoRA
  // guide mechanism). See the ingredients block below (nodes 760-771).
  const isIngredients = !!(config.ingredientsMode && config.ingredientsLoRAName && config.referenceSheetImage);

  // ── Model Loaders ──

  const useGGUF = !!(config.useGGUF && config.ggufDiffusionModel);

  if (useGGUF) {
    // DualCLIPLoaderGGUF: GGUF-quantized Gemma text encoder + text projection
    nodes["88"] = {
      class_type: "DualCLIPLoaderGGUF",
      inputs: {
        clip_name1: config.ggufTextEncoder || LTX23_GGUF_DEFAULTS.ggufTextEncoder,
        clip_name2: config.connectorModel,
        type: "ltxv",
      },
    };

    // UnetLoaderGGUF: GGUF-quantized diffusion model
    nodes["91"] = {
      class_type: "UnetLoaderGGUF",
      inputs: {
        unet_name: config.ggufDiffusionModel,
      },
    };
  } else {
    // DualCLIPLoader: Gemma 12B text encoder + text projection (same split-file approach)
    nodes["88"] = {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: config.textEncoder,
        clip_name2: config.connectorModel,
        type: "ltxv",
        device: "cpu",
      },
    };

    // UNETLoader: diffusion model
    nodes["91"] = {
      class_type: "UNETLoader",
      inputs: {
        unet_name: config.diffusionModel,
        weight_dtype: "default",
      },
    };
  }

  // Distill LoRA: strength from user config (full tier caps at 0.2 per Lightricks recommendation)
  const loraStrength = tier === "full" ? LTX2_OFFICIAL_LORA_STRENGTH.full : config.distillLoRAStrength;
  const skipDistillLora = !config.distillLoRA || config.distillLoRAStrength === 0;
  let lastLoraNode = "91";
  if (!skipDistillLora) {
    nodes["161"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["91", 0],
        lora_name: config.distillLoRA.replace(/\//g, "\\"),
        strength_model: loraStrength,
      },
    };
    lastLoraNode = "161";
  }

  // User LoRAs: chain after distill LoRA (or UNETLoader if no distill)
  const enabledLoras = config.userLoras.filter((l) => l.enabled && l.name);
  enabledLoras.forEach((lora, i) => {
    const nodeId = String(162 + i);
    nodes[nodeId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [lastLoraNode, 0],
        lora_name: lora.name.replace(/\//g, "\\"),
        strength_model: lora.strengthModel,
      },
    };
    lastLoraNode = nodeId;
  });

  // IC-LoRA: load IC-LoRA weights after user/style LoRAs (must be last in chain)
  const isICLoRA = !!(config.icLoraMode && config.icLoraName && config.guideVideoFile);
  if (isICLoRA) {
    nodes["600"] = {
      class_type: "LTXICLoRALoaderModelOnly",
      inputs: {
        model: [lastLoraNode, 0],
        lora_name: config.icLoraName!.replace(/\//g, "\\"),
        strength_model: config.icLoraStrength ?? 1.0,
      },
    };
    lastLoraNode = "600";
    // Output [0]=model, [1]=latent_downscale_factor (float)
  }

  // V2V Inpaint Edit Mode: load inpaint LoRA after all other LoRAs.
  // NOTE: This is the Slice 1a first cut. Workflow has NOT been empirically verified yet,
  // first user run may surface node-graph mismatches that we'll iterate on. Specifically
  // the SetLatentNoiseMask + LTXVPreprocessMasks chain below mirrors the standard inpaint
  // pattern but the LTX 2.3 inpaint LoRA's training-time graph may expect a different feed.
  const isEditVideo = !!(config.editVideoMode && config.editVideoSourceFile && config.editVideoMaskFile && config.editVideoLoraName);
  if (isEditVideo) {
    nodes["650"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [lastLoraNode, 0],
        lora_name: config.editVideoLoraName!.replace(/\//g, "\\"),
        strength_model: config.editVideoLoraStrength ?? 1.0,
      },
    };
    lastLoraNode = "650";
  }

  // VAELoader: video VAE
  nodes["107"] = {
    class_type: "VAELoader",
    inputs: { vae_name: config.videoVae },
  };

  // LTXVAudioVAELoader: audio VAE
  nodes["87"] = {
    class_type: "LTXVAudioVAELoader",
    inputs: { ckpt_name: config.audioVae },
  };

  // ── Text Encoding (with actual negative prompt) ──

  const styledPrompt = applyStylePrefix(config.prompt, config.stylePreset || "none");

  // CLIPTextEncode: positive prompt
  nodes["6"] = {
    class_type: "CLIPTextEncode",
    inputs: {
      text: styledPrompt,
      clip: ["88", 0],
    },
  };

  // Negative conditioning: full tier uses actual text (for CFG); distilled/test zeros it (like Alternative)
  if (tier === "full") {
    const negPrompt = config.negativePrompt || LTX2_OFFICIAL_NEGATIVE;
    nodes["7"] = {
      class_type: "CLIPTextEncode",
      inputs: {
        text: negPrompt,
        clip: ["88", 0],
      },
    };
  } else if ((isA2V && config.a2vPurpose === "lip_sync") || config.nagEnabled) {
    // Lip-sync A2V / standalone NAG uses CFGGuider at cfg=3, needs actual negative prompt text.
    // This enables negative prompt + NAG to suppress subtitles/text in distilled mode.
    // Music Video A2V skips this (no dialogue text = no subtitles to suppress).
    const negPrompt = config.negativePrompt || LTX2_OFFICIAL_NEGATIVE;
    nodes["7"] = {
      class_type: "CLIPTextEncode",
      inputs: {
        text: negPrompt,
        clip: ["88", 0],
      },
    };
  } else {
    // ConditioningZeroOut: null negative signal (no CFG in distilled mode)
    nodes["7"] = {
      class_type: "ConditioningZeroOut",
      inputs: {
        conditioning: ["6", 0],
      },
    };
  }

  // LTXVConditioning: inject frame rate
  nodes["20"] = {
    class_type: "LTXVConditioning",
    inputs: {
      positive: ["6", 0],
      negative: ["7", 0],
      frame_rate: config.frameRate,
    },
  };

  // ── Latent Preparation ──

  // ── Turbo Upscale: halve resolution for first pass, upscale + refine later ──
  // Activated by the turboUpscale toggle OR the "2-Stage" sampling mode dropdown.
  const isTurbo = !!((config.turboUpscale || config.samplingMode === "2stage") && !isA2V && !isContinuity);
  const turboHalf = isTurbo ? getTurboHalfResolution(config.width, config.height) : null;
  let samplingWidth = isTurbo ? turboHalf!.width : config.width;
  let samplingHeight = isTurbo ? turboHalf!.height : config.height;

  // IC-LoRA (motion tracks / V2V) requires latent spatial dims to be divisible by
  // latent_downscale_factor (2). Since latent = pixel // 32, pixel dims must be
  // divisible by 64 (32 × 2) to guarantee even latent dimensions.
  const willUseICLoRA = !!(
    (config.motionTracks && config.motionTracks.some((t) => t.points.length >= 2 && t.enabled !== false) && config.motionTrackLoRA) ||
    (config.icLoraMode && config.icLoraName)
  );
  if (willUseICLoRA) {
    const snap64 = (v: number) => Math.max(256, Math.round(v / 64) * 64);
    samplingWidth = snap64(samplingWidth);
    samplingHeight = snap64(samplingHeight);
  }

  // V2V Inpaint: LTXVPreprocessMasks requires H % 32 == 0 and W % 32 == 0
  // (ComfyUI-LTXVideo/masks.py:155-163). LTX-2's 1280x720 preset fails because
  // 720 % 32 != 0. Snap to nearest 32; source and mask load at this resolution
  // via VHS_LoadVideoPath custom_width/custom_height, so they stay aligned.
  if (config.editVideoMode && config.editVideoSourceFile && config.editVideoMaskFile && config.editVideoLoraName) {
    const snap32 = (v: number) => Math.max(256, Math.round(v / 32) * 32);
    samplingWidth = snap32(samplingWidth);
    samplingHeight = snap32(samplingHeight);
  }

  // EmptyLTXVLatentVideo
  // When Turbo Upscale is enabled, uses half resolution for the first sampling pass.
  nodes["13"] = {
    class_type: "EmptyLTXVLatentVideo",
    inputs: {
      width: samplingWidth,
      height: samplingHeight,
      length: config.numFrames,
      batch_size: 1,
    },
  };

  // I2V / Guide Frames: support source image, start+end frames, or standalone guide frames
  // A2V purpose determines guide behavior:
  //   lip_sync   → guide frames fight mouth-movement conditioning, so they are skipped
  //   music_video → guide frames anchor visuals while audio drives energy, so they are kept
  const a2vSkipGuide = isA2V && config.a2vPurpose === "lip_sync";
  let videoLatentRef: [string, number] = ["13", 0];
  const hasGuideFrames = config.guideFrames && config.guideFrames.length > 0;
  if ((hasSourceImage || hasGuideFrames) && !a2vSkipGuide && !isContinuity) {
    // Build guide list: combine sourceImage (as frame-0 guide) with any explicit guideFrames.
    // If a guide frame already targets frame 0, the user's explicit choice takes precedence.
    const guides: { image: string; frameIdx: number; strength: number }[] = [];
    if (hasGuideFrames) {
      for (const g of config.guideFrames!) {
        guides.push({ image: g.image, frameIdx: g.frameIdx, strength: g.strength ?? 1.0 });
      }
    }
    if (hasSourceImage && !guides.some((g) => g.frameIdx === 0)) {
      guides.unshift({ image: config.sourceImage, frameIdx: 0, strength: config.i2vStrength ?? 1.0 });
    }
    // Perfect Loop: add source image as end-frame guide so the model cycles back to the start
    const lastFrameIdx = config.numFrames - 1;
    if (config.perfectLoop && hasSourceImage && !guides.some((g) => g.frameIdx === lastFrameIdx)) {
      guides.push({ image: config.sourceImage, frameIdx: lastFrameIdx, strength: config.perfectLoopEndStrength ?? 0.85 });
    }

    // For each guide: LoadImage (node 300+i*3) → ImageScale (301+i*3) → LTXVPreprocess (302+i*3)
    // Perfect Loop optimization: reuse first guide's nodes when the end-frame shares the same image
    const loopReuseIdx = config.perfectLoop
      ? guides.findIndex((g, i) => i > 0 && g.image === guides[0]?.image)
      : -1;

    for (let i = 0; i < guides.length; i++) {
      if (i === loopReuseIdx) continue; // skip, will reuse node from first guide
      const loadId = String(300 + i * 3);
      const scaleId = String(301 + i * 3);
      const prepId = String(302 + i * 3);

      nodes[loadId] = {
        class_type: "LoadImage",
        inputs: { image: guides[i].image },
      };
      nodes[scaleId] = {
        class_type: "ImageScale",
        inputs: {
          image: [loadId, 0],
          upscale_method: "lanczos",
          width: samplingWidth,
          height: samplingHeight,
          crop: "center",
        },
      };
      nodes[prepId] = {
        class_type: "LTXVPreprocess",
        inputs: {
          image: [scaleId, 0],
          img_compression: config.imgCompression,
        },
      };
    }

    // LTXVAddGuideMulti: inject all guide images into conditioning + latent
    const guideInputs: Record<string, unknown> = {
      positive: ["20", 0],
      negative: ["20", 1],
      vae: ["107", 0],
      latent: ["13", 0],
      num_guides: String(guides.length),
    };
    for (let i = 0; i < guides.length; i++) {
      // Perfect Loop: reuse the first guide's preprocessed node for the end-frame guide
      const srcIdx = (i === loopReuseIdx) ? 0 : i;
      const prepId = String(302 + srcIdx * 3);
      const n = i + 1; // 1-indexed for DynamicCombo
      guideInputs[`num_guides.image_${n}`] = [prepId, 0];
      guideInputs[`num_guides.frame_idx_${n}`] = guides[i].frameIdx;
      guideInputs[`num_guides.strength_${n}`] = guides[i].strength;
    }
    nodes["102"] = {
      class_type: "LTXVAddGuideMulti",
      inputs: guideInputs,
    };
    // LTXVAddGuideMulti outputs: [0]=positive, [1]=negative, [2]=latent
    videoLatentRef = ["102", 2];
  }

  // ── V2V Inpaint Edit Mode ──
  // Two pipelines, selectable via `config.editVideoPipeline`:
  //
  //   1. "noise-mask" (default, original path): VAEEncodeTiled the unmodified source,
  //      then SetLatentNoiseMask binds the processed mask to the latent. Sampler only injects
  //      noise where mask>0. Latent-space gating.
  //
  //   2. "magenta-fill" (Alissonerdx pattern, hard-evidence reference workflows in
  //      `1_New_Workflow/NEW/ltx23_*_inpaint_v1.json`): the mask is rendered into the source
  //      PIXELS as a flat color (magenta or white) via ImageCompositeMasked; the modified
  //      source is then LTXVPreprocess-compressed, VAE-encoded, and fed BOTH as the latent
  //      AND as image_1 of LTXVAddGuideMulti. This matches the conditioning the author
  //      trained the inpaint LoRAs against (the model literally learned "magenta = regen").
  //
  // Both pipelines share node IDs 660 (source video load) but diverge after that.
  // "noise-mask" uses 661-668 (+672 for refs). "magenta-fill" uses 680-695 to avoid collisions.
  // `editV2VGuideNodeId` is set when a pipeline produces guide-attention conditioning that
  // must flow into condPosRef/condNegRef downstream (see line ~3741).
  const v2vPipeline: "noise-mask" | "magenta-fill" = config.editVideoPipeline ?? "noise-mask";
  let editV2VGuideNodeId: string | null = null;
  if (isEditVideo && v2vPipeline === "noise-mask") {
    // Node 660: Load source video frames at target res/fps
    nodes["660"] = {
      class_type: "VHS_LoadVideoPath",
      inputs: {
        video: config.editVideoSourceFile!,
        force_rate: config.frameRate,
        custom_width: samplingWidth,
        custom_height: samplingHeight,
        frame_load_cap: config.numFrames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    };

    // Node 661: VAE-encode source frames into video latent (tiled to manage VRAM)
    nodes["661"] = {
      class_type: "VAEEncodeTiled",
      inputs: {
        pixels: ["660", 0],
        vae: ["107", 0],
        tile_size: config.vaeTileSize ?? 512,
        overlap: config.vaeOverlap ?? 64,
        temporal_size: config.vaeTemporalSize ?? 64,
        temporal_overlap: config.vaeTemporalOverlap ?? 16,
      },
    };

    // Mask source can be either:
    //   (a) a static PNG (manual paint), replicated to all frames, or
    //   (b) an animated mask MP4 (SAM2 video tracking), already per-frame.
    // We detect (b) by file extension. The downstream chain expects an IMAGE batch
    // feeding ImageToMask at node 665, so the two branches converge there.
    const maskFile = config.editVideoMaskFile!;
    const isVideoMask = /\.(mp4|webm|mov|mkv|avi)$/i.test(maskFile);

    if (isVideoMask) {
      // Animated mask path: load the SAM2-produced MP4 as a frame batch
      nodes["662"] = {
        class_type: "VHS_LoadVideoPath",
        inputs: {
          video: maskFile,
          force_rate: config.frameRate,
          custom_width: samplingWidth,
          custom_height: samplingHeight,
          frame_load_cap: config.numFrames,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
      };
      // Node 665: ImageToMask - convert grayscale frames → per-frame mask batch
      nodes["665"] = {
        class_type: "ImageToMask",
        inputs: { image: ["662", 0], channel: "red" },
      };
    } else {
      // Static PNG path: single mask replicated across all frames
      // Node 662: Load mask PNG. LoadImage returns IMAGE [0] + MASK [1] (alpha).
      nodes["662"] = {
        class_type: "LoadImage",
        inputs: { image: maskFile },
      };
      // Node 663: MaskToImage - convert single-frame mask → IMAGE so we can batch-repeat it
      nodes["663"] = {
        class_type: "MaskToImage",
        inputs: { mask: ["662", 1] },
      };
      // Node 664: RepeatImageBatch - duplicate mask across all frames
      nodes["664"] = {
        class_type: "RepeatImageBatch",
        inputs: { image: ["663", 0], amount: config.numFrames },
      };
      // Node 665: ImageToMask - back to MASK type (channel: red since mask is grayscale)
      nodes["665"] = {
        class_type: "ImageToMask",
        inputs: { image: ["664", 0], channel: "red" },
      };
    }

    // Node 666: Optional BlockifyMask (KJNodes) - matches LoRA training mask granularity
    // KJNodes input is "masks" (plural) and block_size minimum is 8 per the node's INPUT_TYPES.
    let preprocessMaskInput: [string, number] = ["665", 0];
    const blockSize = config.editVideoBlockifyMaskSize ?? 8;
    if (blockSize >= 8) {
      nodes["666"] = {
        class_type: "BlockifyMask",
        inputs: {
          masks: ["665", 0],
          block_size: blockSize,
          device: "cpu",
        },
      };
      preprocessMaskInput = ["666", 0];
    }

    // Node 667: LTXVPreprocessMasks - temporal pooling + grow + clamp aligned with VAE downscale
    nodes["667"] = {
      class_type: "LTXVPreprocessMasks",
      inputs: {
        masks: preprocessMaskInput,
        vae: ["107", 0],
        invert_input_masks: false,
        ignore_first_mask: true,
        pooling_method: "max",
        grow_mask: config.editVideoMaskGrow ?? 8,
        tapered_corners: true,
        clamp_min: config.editVideoMaskClampMin ?? 0.5,
        clamp_max: 1.0,
      },
    };

    // Node 668: SetLatentNoiseMask - bind processed mask to source latent. The sampler will
    // only inject noise where mask > 0; everything else stays as the encoded source.
    nodes["668"] = {
      class_type: "SetLatentNoiseMask",
      inputs: {
        samples: ["661", 0],
        mask: ["667", 0],
      },
    };

    videoLatentRef = ["668", 0];

    // Optional reference-image conditioning: when present, inject ref image(s) as
    // LTXVAddGuideMulti guides on the masked source latent so the masked R2V LoRA
    // can pick up subject identity. Two paths:
    //   (a) Multi-reference (preferred): config.editVideoReferenceImages = up to 4
    //       images, each anchored at a chosen frame_idx. Use case: front/side/back
    //       character views injected as keyframes so the model interpolates rotation
    //       across the masked region.
    //   (b) Legacy single-reference: config.editVideoReferenceImage (string),
    //       treated as one guide at frame_idx 0. Preserved for back-compat with
    //       existing saved configs.
    // Both paths funnel into a single LTXVAddGuideMulti node (672) on the masked
    // latent; node IDs 669 + 100*i / 670 + 100*i / 671 + 100*i load + scale + preprocess
    // each reference image. Frame indices are clamped to [0, numFrames-1].
    const refImagesArr = Array.isArray(config.editVideoReferenceImages)
      ? config.editVideoReferenceImages.filter((r) => r && r.file)
      : [];
    const refList = refImagesArr.length > 0
      ? refImagesArr
      : (config.editVideoReferenceImage
          ? [{ file: config.editVideoReferenceImage, frameIdx: 0, strength: config.i2vStrength ?? 1.0 }]
          : []);

    if (refList.length > 0) {
      const guideMultiInputs: Record<string, unknown> = {
        positive: ["20", 0],
        negative: ["20", 1],
        vae: ["107", 0],
        latent: videoLatentRef,
        num_guides: String(refList.length),
      };
      const maxFrame = Math.max(0, (config.numFrames ?? 1) - 1);
      refList.slice(0, 4).forEach((ref, i) => {
        const idx = i + 1;                              // 1-based for ComfyUI multi-guide naming
        const loadId = `${669 + i * 100}`;              // 669, 769, 869, 969
        const scaleId = `${670 + i * 100}`;             // 670, 770, 870, 970
        const preId = `${671 + i * 100}`;               // 671, 771, 871, 971
        const frameIdx = Math.max(0, Math.min(maxFrame, Math.round(ref.frameIdx ?? 0)));
        const strength = ref.strength ?? config.i2vStrength ?? 1.0;

        nodes[loadId] = {
          class_type: "LoadImage",
          inputs: { image: ref.file },
        };
        nodes[scaleId] = {
          class_type: "ImageScale",
          inputs: {
            image: [loadId, 0],
            upscale_method: "lanczos",
            width: samplingWidth,
            height: samplingHeight,
            crop: "center",
          },
        };
        nodes[preId] = {
          class_type: "LTXVPreprocess",
          inputs: {
            image: [scaleId, 0],
            img_compression: config.imgCompression ?? 28,
          },
        };
        guideMultiInputs[`num_guides.image_${idx}`] = [preId, 0];
        guideMultiInputs[`num_guides.frame_idx_${idx}`] = frameIdx;
        guideMultiInputs[`num_guides.strength_${idx}`] = strength;
      });

      nodes["672"] = {
        class_type: "LTXVAddGuideMulti",
        inputs: guideMultiInputs,
      };
      videoLatentRef = ["672", 2];
      editV2VGuideNodeId = "672";
    }
  }

  // ── V2V Inpaint Edit Mode, "magenta-fill" pipeline (Alissonerdx pattern) ──
  // Mirrors the author's `ltx23_inpaint_v1.json` (white-fill, text-only LoRAs) and
  // `ltx23_masked_ref_inpaint_v1.json` (magenta-fill, r2v reference LoRA) workflows.
  // Color choice: per the author's two reference JSONs:
  //   r2v_*.safetensors → magenta FF00FF (training conditioning)
  //   t2v_*.safetensors → white   FFFFFF (training conditioning)
  // "auto" applies that heuristic by LoRA filename. Manual override via editVideoFillColor.
  if (isEditVideo && v2vPipeline === "magenta-fill") {
    const loraName = (config.editVideoLoraName || "").toLowerCase();
    const fillChoice = config.editVideoFillColor ?? "auto";
    const useMagenta =
      fillChoice === "magenta" ? true :
      fillChoice === "white"   ? false :
      /(^|[_\-])r2v($|[_\-])|masked_r2v|ref_inpaint/.test(loraName);
    const colorInt = useMagenta ? 0xFF00FF : 0xFFFFFF;

    // Node 660: load source frames (same ID as noise-mask path; only one pipeline runs at a time).
    nodes["660"] = {
      class_type: "VHS_LoadVideoPath",
      inputs: {
        video: config.editVideoSourceFile!,
        force_rate: config.frameRate,
        custom_width: samplingWidth,
        custom_height: samplingHeight,
        frame_load_cap: config.numFrames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    };

    // ── Mask source path (matches noise-mask branch's logic; uses distinct IDs 681-684) ──
    const maskFile = config.editVideoMaskFile!;
    const isVideoMask = /\.(mp4|webm|mov|mkv|avi)$/i.test(maskFile);
    if (isVideoMask) {
      nodes["681"] = {
        class_type: "VHS_LoadVideoPath",
        inputs: {
          video: maskFile,
          force_rate: config.frameRate,
          custom_width: samplingWidth,
          custom_height: samplingHeight,
          frame_load_cap: config.numFrames,
          skip_first_frames: 0,
          select_every_nth: 1,
        },
      };
      nodes["684"] = { class_type: "ImageToMask", inputs: { image: ["681", 0], channel: "red" } };
    } else {
      nodes["681"] = { class_type: "LoadImage", inputs: { image: maskFile } };
      nodes["682"] = { class_type: "MaskToImage", inputs: { mask: ["681", 1] } };
      nodes["683"] = { class_type: "RepeatImageBatch", inputs: { image: ["682", 0], amount: config.numFrames } };
      nodes["684"] = { class_type: "ImageToMask", inputs: { image: ["683", 0], channel: "red" } };
    }

    // Node 685: BlockifyMask (KJNodes) - author uses block_size=8 in both reference workflows.
    let maskRef: [string, number] = ["684", 0];
    const blockSize = config.editVideoBlockifyMaskSize ?? 8;
    if (blockSize >= 8) {
      nodes["685"] = {
        class_type: "BlockifyMask",
        inputs: { masks: maskRef, block_size: blockSize, device: "cpu" },
      };
      maskRef = ["685", 0];
    }

    // Node 686: GrowMaskWithBlur (KJNodes) - soft mask edges. Author's reference uses this
    // (single instance of GrowMaskWithBlur in ltx23_inpaint_v1.json). Replaces the
    // grow_mask + clamp_min/max behavior of LTXVPreprocessMasks in the noise-mask branch.
    // NOTE: editVideoMaskGrow can be negative in the noise-mask branch (LTXVPreprocessMasks
    // accepts -32..64) but GrowMaskWithBlur expects non-negative for grow_mask (it uses
    // expand=N to dilate). We clamp to >=0 here; negative values map to 0.
    const grow = Math.max(0, config.editVideoMaskGrow ?? 8);
    nodes["686"] = {
      class_type: "GrowMaskWithBlur",
      inputs: {
        mask: maskRef,
        expand: grow,
        incremental_expandrate: 0,
        tapered_corners: true,
        flip_input: false,
        blur_radius: 0,            // start at 0 to match author's defaults; can be exposed later
        lerp_alpha: 1.0,
        decay_factor: 1.0,
        fill_holes: false,
      },
    };

    // Node 690: EmptyImage - solid color batch (magenta or white) at sampling dims, batched
    // over numFrames. Per `comfy_extras/nodes_mask.py` ImageCompositeMasked accepts batches
    // and composites per-frame; per `nodes.py` EmptyImage encodes color as RGB-packed int.
    nodes["690"] = {
      class_type: "EmptyImage",
      inputs: {
        width: samplingWidth,
        height: samplingHeight,
        batch_size: config.numFrames,
        color: colorInt,
      },
    };

    // Node 691: ImageCompositeMasked - overlay color where mask>0. Inputs per
    // `comfy_extras/nodes_mask.py:77`: destination=under, source=over, mask=alpha.
    // resize_source=false: both batches are already at samplingWidth × samplingHeight.
    nodes["691"] = {
      class_type: "ImageCompositeMasked",
      inputs: {
        destination: ["660", 0],
        source: ["690", 0],
        x: 0,
        y: 0,
        resize_source: false,
        mask: ["686", 0],
      },
    };

    // Node 692: LTXVPreprocess (comfy-core, `nodes_lt.py:590`) - img_compression=18 matches
    // the widget value the author uses in both reference workflows. Applies JPEG-like
    // compression to the composite frames before VAE encoding (training-time augmentation).
    nodes["692"] = {
      class_type: "LTXVPreprocess",
      inputs: {
        image: ["691", 0],
        img_compression: 18,
      },
    };

    // NOTE: EmptyLTXVLatentVideo (old node 693) is no longer used. The base latent
    // is the source video encoded via VAEEncodeTiled (699) with SetLatentNoiseMask (700).
    // This preserves non-masked areas at the latent level (no jitter from full denoising).

    // Node 697: VAEEncodeTiled - pre-encode the masked composite (node 692) with
    // temporal + spatial tiling for VRAM safety.  LTXVAddGuideMulti's internal
    // vae.encode() processes ALL frames without temporal tiling; ComfyUI's OOM
    // fallback also uses tile_t=9999 (no temporal split).  At 1280x720 x 97 frames
    // on 16 GB VRAM, intermediate 3D conv activations per spatial tile still exceed
    // available memory when all 97 frames are processed together.
    // By pre-encoding here with temporal_size=17 (~2 latent steps per tile), each
    // chunk stays well within VRAM limits.
    nodes["697"] = {
      class_type: "VAEEncodeTiled",
      inputs: {
        pixels: ["692", 0],
        vae: ["107", 0],
        tile_size: 256,
        overlap: 64,
        temporal_size: 17,
        temporal_overlap: 4,
      },
    };

    // ── Reference image composition (r2v strip pattern) ──
    // The r2v inpaint LoRA was trained with ReservedRegionFrameComposer placing
    // a reference subject into a reserved strip on the LEFT edge of the GUIDE frames.
    // The model reads identity from that visual cue via keyframe attention.
    //
    // CRITICAL DESIGN: the reference strip exists ONLY in the guide, NOT in the
    // base latent or output. The base latent is the source video protected by
    // SetLatentNoiseMask (same as noise-mask pipeline). This ensures:
    //   - Non-masked areas are preserved at the latent level (no jitter)
    //   - The user's full mask area is available for generation (no overlap)
    //   - Output is full resolution (no ImageCrop needed)
    //   - The magenta + ref strip in the guide provide conditioning only
    //
    // When references exist:
    //   1. VekSnapReferenceComposer (698) embeds ref into the magenta-filled GUIDE frames
    //   2. LTXVPreprocess (692) receives from 698 (guide path with ref strip)
    //   3. VAEEncodeTiled (697) encodes the ref-composited guide
    //   4. Base latent = source video (node 660) encoded via VAEEncodeTiled (699)
    //      with SetLatentNoiseMask from the user's mask (same as noise-mask pipeline)
    //   5. VekSnapAppendGuideLatent (696) appends encoded guide to masked base
    //
    // When no refs: same structure but guide = magenta composite WITHOUT ref strip.
    // Base is still noise-masked source (not empty latent).
    const refImagesArrM = Array.isArray(config.editVideoReferenceImages)
      ? config.editVideoReferenceImages.filter((r) => r && r.file)
      : [];
    const refListM = refImagesArrM.length > 0
      ? refImagesArrM
      : (config.editVideoReferenceImage
          ? [{ file: config.editVideoReferenceImage, frameIdx: 0, strength: config.i2vStrength ?? 1.0 }]
          : []);

    const hasRefsM = refListM.length > 0;
    // Strip width matches author's ReservedRegionFrameComposer default (256px).
    // Must be divisible by 32 (VAE spatial scale factor) to avoid latent misalignment.
    const refStripWidth = 256;

    if (hasRefsM) {
      // Load the first reference image (the primary identity cue)
      nodes["720"] = {
        class_type: "LoadImage",
        inputs: { image: refListM[0].file },
      };

      // Node 698: VekSnapReferenceComposer - composite reference into a reserved
      // left-side strip on the magenta-filled GUIDE frames (not the output).
      nodes["698"] = {
        class_type: "VekSnapReferenceComposer",
        inputs: {
          frames: ["691", 0],
          reference: ["720", 0],
          strip_width: refStripWidth,
          position: "left",
          interval: 1,
        },
      };

      // Override node 692: LTXVPreprocess receives ref-composited guide frames
      nodes["692"] = {
        class_type: "LTXVPreprocess",
        inputs: {
          image: ["698", 0],
          img_compression: 18,
        },
      };
    }
    // (When no refs, node 692 already points to ["691", 0] from the initial creation above)

    // ── Base latent: source video with noise mask ──
    // Encode the SOURCE VIDEO (node 660, no magenta, no ref strip) as the base latent.
    // Apply SetLatentNoiseMask so only the masked area gets denoised, non-masked
    // areas are preserved at the latent level (no jitter from full-frame denoising).
    nodes["699"] = {
      class_type: "VAEEncodeTiled",
      inputs: {
        pixels: ["660", 0],
        vae: ["107", 0],
        tile_size: 256,
        overlap: 64,
        temporal_size: 17,
        temporal_overlap: 4,
      },
    };

    // Apply noise mask from the same mask processing chain used by node 686 (GrowMaskWithBlur)
    // Node 667 (LTXVPreprocessMasks) is NOT used here because it's for the noise-mask pipeline.
    // For magenta-fill, we use GrowMaskWithBlur (686) output directly as the noise mask.
    nodes["700"] = {
      class_type: "SetLatentNoiseMask",
      inputs: {
        samples: ["699", 0],
        mask: ["686", 0],
      },
    };

    // Conditioning + latent flow
    const condPosSource: [string, number] = ["20", 0];
    const condNegSource: [string, number] = ["20", 1];

    // Node 696: VekSnapAppendGuideLatent - append the pre-encoded magenta GUIDE
    // (with optional ref strip) to the noise-masked base latent.
    // Base = source video with mask (only masked area denoised)
    // Guide = magenta composite (+ ref strip if refs exist) for conditioning
    nodes["696"] = {
      class_type: "VekSnapAppendGuideLatent",
      inputs: {
        positive: condPosSource,
        negative: condNegSource,
        vae: ["107", 0],
        latent: ["700", 0],
        guide_latent: ["697", 0],
        frame_idx: 0,
        strength: 1.0,
      },
    };

    // Node 695: VekSnapCleanVRAM - flush VRAM after all guide encoding/appending,
    // before the sampler loads the diffusion model for weight-streaming.  The
    // author's reference workflow places 'easy cleanGpuUsed' at exactly this
    // position.  Without this, the VAE stays staged (~1.4 GB) in VRAM throughout
    // sampling, stealing headroom from the 22B model's weight-streaming.
    nodes["695"] = {
      class_type: "VekSnapCleanVRAM",
      inputs: {
        anything: ["696", 2],
      },
    };

    videoLatentRef = ["695", 0];
    editV2VGuideNodeId = "696";
  }

  // ── IC-LoRA Video Guide (motion transfer) ──
  // When enabled, loads guide video and injects it via LTXAddVideoICLoRAGuide.
  // The IC-LoRA attention mechanism conditions generation on the guide's structure/motion.
  // Skipped when V2V edit mode is active (mutually exclusive, different conditioning chains).
  if (isICLoRA && !isEditVideo) {
    // Node 601: Load guide video from ComfyUI input/ folder
    nodes["601"] = {
      class_type: "VHS_LoadVideo",
      inputs: {
        video: config.guideVideoFile!,
        force_rate: config.frameRate,
        custom_width: config.width,
        custom_height: config.height,
        frame_load_cap: config.guideFrameLoadCap || config.numFrames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    };

    // Node 602: LTXAddVideoICLoRAGuide - inject guide frames into conditioning + latent
    // Uses latent_downscale_factor from LTXICLoRALoaderModelOnly (node 600 output [1])
    // IMPORTANT: Must NOT chain from LTXVAddGuideMulti (node 102) - its keyframe tokens conflict
    // with IC-LoRA guide_attention_entries, causing "pre_filter_counts != keyframe grid mask" error.
    // Use raw conditioning + LTXVImgToVideoConditionOnly for I2V (same pattern as motion tracks).
    let icLatSource: [string, number] = ["13", 0];
    if (hasSourceImage) {
      // Node 603: LTXVImgToVideoConditionOnly - encode source image into latent first frame
      nodes["603"] = {
        class_type: "LTXVImgToVideoConditionOnly",
        inputs: {
          vae: ["107", 0],
          image: ["302", 0],       // First guide's preprocessed image
          latent: ["13", 0],
          strength: config.i2vStrength ?? 1.0,
        },
      };
      icLatSource = ["603", 0];
    }
    nodes["602"] = {
      class_type: "LTXAddVideoICLoRAGuide",
      inputs: {
        positive: ["20", 0],                  // Raw conditioning - no guide keyframe tokens
        negative: ["20", 1],
        vae: ["107", 0],
        latent: icLatSource,
        image: ["601", 0],           // Video frames as IMAGE tensor
        frame_idx: 0,
        strength: config.guideStrength ?? 1.0,
        latent_downscale_factor: ["600", 1],  // From IC-LoRA loader
        crop: "disabled",
        use_tiled_encode: true,
        tile_size: 256,
        tile_overlap: 64,
      },
    };
    // LTXAddVideoICLoRAGuide outputs: [0]=positive, [1]=negative, [2]=latent
    videoLatentRef = ["602", 2];
  }

  // ── Motion Tracks (sparse spline paths → IC-LoRA motion control) ──
  // When enabled, draws colored track overlays via LTXVDrawTracks and feeds them
  // through a dedicated IC-LoRA for motion guidance. Mutually exclusive with V2V IC-LoRA.
  const hasMotionTracks = !isICLoRA && !!(
    config.motionTracks && config.motionTracks.length > 0 &&
    config.motionTracks.some((t) => t.points.length >= 2 && t.enabled !== false) &&
    config.motionTrackLoRA
  );

  if (hasMotionTracks) {
    // Node 750: Load motion track IC-LoRA weights
    nodes["750"] = {
      class_type: "LTXICLoRALoaderModelOnly",
      inputs: {
        model: [lastLoraNode, 0],
        lora_name: config.motionTrackLoRA!.replace(/\//g, "\\"),
        strength_model: config.motionTrackLoRAStrength ?? 1.0,
      },
    };
    // Output [0]=model, [1]=latent_downscale_factor (float)

    // Node 751: LTXVDrawTracks - render track visualization frames from JSON
    // Uses the source image dimensions for track coordinate space.
    // The track image size should match what the IC-LoRA expects as reference input.
    const trackJSON = motionTracksToDrawJSON(
      config.motionTracks!,
      config.numFrames,
      config.width,
      config.height,
      config.frameRate,
    );
    nodes["751"] = {
      class_type: "LTXVDrawTracks",
      inputs: {
        tracks: trackJSON,
        width: config.width,
        height: config.height,
      },
    };
    // Output [0]=IMAGE (track visualization frames, BGR, one per frame)

    // Node 752: LTXAddVideoICLoRAGuide - inject track frames into conditioning + latent
    // IMPORTANT: LTXAddVideoICLoRAGuide adds keyframe tokens + guide_attention_entries to conditioning.
    // If we chain from LTXVAddGuideMulti (node 102), its keyframe tokens conflict with the IC-LoRA
    // guide entries, causing "guide pre_filter_counts != keyframe grid mask length" at runtime.
    // Fix: always feed RAW conditioning from LTXVConditioning (node 20) - no guide keyframe tokens.
    // For I2V, use LTXVImgToVideoConditionOnly (node 753) which encodes the source image directly
    // into the latent's first frame WITHOUT adding keyframe tokens or guide_attention_entries.
    let mtLatSource: [string, number] = ["13", 0];
    if (hasSourceImage) {
      // Node 753: LTXVImgToVideoConditionOnly - encode source image into latent first frame
      nodes["753"] = {
        class_type: "LTXVImgToVideoConditionOnly",
        inputs: {
          vae: ["107", 0],
          image: ["302", 0],       // First guide's preprocessed image (LoadImage→ImageScale→LTXVPreprocess)
          latent: ["13", 0],       // Empty video latent
          strength: config.i2vStrength ?? 1.0,
        },
      };
      mtLatSource = ["753", 0];
    }
    nodes["752"] = {
      class_type: "LTXAddVideoICLoRAGuide",
      inputs: {
        positive: ["20", 0],                       // Raw conditioning - no guide keyframe tokens
        negative: ["20", 1],
        vae: ["107", 0],
        latent: mtLatSource,
        image: ["751", 0],                        // Track visualization frames (BGR)
        frame_idx: 0,
        strength: config.motionTrackGuideStrength ?? 1.0,
        latent_downscale_factor: ["750", 1],       // From IC-LoRA loader metadata
        crop: "disabled",
        use_tiled_encode: true,
        tile_size: 256,
        tile_overlap: 64,
      },
    };
    // LTXAddVideoICLoRAGuide outputs: [0]=positive, [1]=negative, [2]=latent
    videoLatentRef = ["752", 2];
    // Override lastLoraNode so CFGGuider uses the patched model
    lastLoraNode = "750";
  }

  // ── Character Consistency: Reference Sheet (Official IC-LoRA "Ingredients") ──
  // The still reference sheet is scaled to output resolution and looped into a static
  // video (>=121 frames AND >= output length), the training/inference contract
  // (reference downscale factor 1). It is injected via LTXAddVideoICLoRAGuide exactly
  // like the motion-guide path, but the "guide" is the looped reference sheet.
  // Mutually exclusive with motion guide / motion tracks / V2V edit.
  // Node that carries the final ingredients conditioning (node 764, or the end-frame guide
  // 771 when the last-frame anchor is active). Consumed by the condPosRef/condNegRef wiring.
  let ingredientsCondNode = "764";
  if (isIngredients && !isEditVideo) {
    // Node 760: load the ingredients IC-LoRA (model-only), chained after existing LoRAs
    nodes["760"] = {
      class_type: "LTXICLoRALoaderModelOnly",
      inputs: {
        model: [lastLoraNode, 0],
        lora_name: config.ingredientsLoRAName!.replace(/\//g, "\\"),
        strength_model: config.ingredientsLoRAStrength ?? 1.4,
      },
    };
    // Node 761: load the reference-sheet still
    nodes["761"] = {
      class_type: "LoadImage",
      inputs: { image: config.referenceSheetImage! },
    };
    // Node 762: scale to output resolution (downscale factor 1 → same res as output)
    nodes["762"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["761", 0],
        upscale_method: "lanczos",
        width: samplingWidth,
        height: samplingHeight,
        crop: "center",
      },
    };
    // Node 763: loop the still into a static video (>=121 frames, and >= output length)
    const refFrames = Math.max(121, config.numFrames);
    nodes["763"] = {
      class_type: "RepeatImageBatch",
      inputs: { image: ["762", 0], amount: refFrames },
    };
    // Optional frame-0 source injection (I2V) ALONGSIDE the reference sheet.
    let icIngredientsLatent: [string, number] = ["13", 0];
    if (config.ingredientsUseSourceFrame && hasSourceImage) {
      nodes["765"] = {
        class_type: "LoadImage",
        inputs: { image: config.sourceImage },
      };
      nodes["766"] = {
        class_type: "ImageScale",
        inputs: {
          image: ["765", 0],
          upscale_method: "lanczos",
          width: samplingWidth,
          height: samplingHeight,
          crop: "center",
        },
      };
      nodes["767"] = {
        class_type: "LTXVPreprocess",
        inputs: {
          image: ["766", 0],
          img_compression: config.imgCompression,
        },
      };
      nodes["768"] = {
        class_type: "LTXVImgToVideoConditionOnly",
        inputs: {
          vae: ["107", 0],
          image: ["767", 0],
          latent: ["13", 0],
          strength: config.ingredientsSourceFrameStrength ?? 0.65,
          bypass: false,
        },
      };
      icIngredientsLatent = ["768", 0];
    }
    // Node 764: inject the reference-sheet static video as IC-LoRA reference conditioning.
    nodes["764"] = {
      class_type: "LTXAddVideoICLoRAGuide",
      inputs: {
        positive: ["20", 0],
        negative: ["20", 1],
        vae: ["107", 0],
        latent: icIngredientsLatent,
        image: ["763", 0],
        frame_idx: 0,
        strength: config.referenceSheetStrength ?? 1.0,
        latent_downscale_factor: ["760", 1],
        crop: "disabled",
        use_tiled_encode: false,
        tile_size: 256,
        tile_overlap: 64,
      },
    };
    // LTXAddVideoICLoRAGuide outputs: [0]=positive, [1]=negative, [2]=latent
    videoLatentRef = ["764", 2];
    ingredientsCondNode = "764";

    // Optional END-frame anchor (segment-to-segment continuity) ALONGSIDE the reference sheet.
    if (config.ingredientsUseEndFrame && config.ingredientsEndFrameImage) {
      nodes["769"] = {
        class_type: "LoadImage",
        inputs: { image: config.ingredientsEndFrameImage },
      };
      nodes["770"] = {
        class_type: "ImageScale",
        inputs: {
          image: ["769", 0],
          upscale_method: "lanczos",
          width: samplingWidth,
          height: samplingHeight,
          crop: "center",
        },
      };
      nodes["771"] = {
        class_type: "LTXAddVideoICLoRAGuide",
        inputs: {
          positive: ["764", 0],
          negative: ["764", 1],
          vae: ["107", 0],
          latent: ["764", 2],
          image: ["770", 0],
          frame_idx: -1,
          strength: config.ingredientsEndFrameStrength ?? 0.65,
          latent_downscale_factor: 1.0,
          crop: "disabled",
          use_tiled_encode: false,
          tile_size: 256,
          tile_overlap: 64,
        },
      };
      videoLatentRef = ["771", 2];
      ingredientsCondNode = "771";
    }

    // Override lastLoraNode so the guider uses the IC-LoRA-patched model
    lastLoraNode = "760";
  }

  // Track conditioning references: may be overridden by guide frames, A2V, IC-LoRA, motion tracks, or overlap.
  // V2V Inpaint takes highest priority when its pipeline produced an LTXVAddGuideMulti node
  // (`editV2VGuideNodeId`); the guide attention entries on its positive/negative outputs
  // MUST flow downstream or the inpaint LoRA's keyframe conditioning is silently dropped.
  // This particularly matters for the "magenta-fill" pipeline where the guide image IS the
  // primary mask signal: without these references, the sampler ignores the magenta regions.
  const hasGuides = (hasSourceImage || hasGuideFrames) && !a2vSkipGuide && !isContinuity;
  const condPosRef: [string, number] = editV2VGuideNodeId
    ? [editV2VGuideNodeId, 0]
    : hasMotionTracks
      ? ["752", 0]
      : isICLoRA
        ? ["602", 0]
        : isIngredients
          ? [ingredientsCondNode, 0]
          : hasGuides ? ["102", 0] : ["20", 0];
  const condNegRef: [string, number] = editV2VGuideNodeId
    ? [editV2VGuideNodeId, 1]
    : hasMotionTracks
      ? ["752", 1]
      : isICLoRA
        ? ["602", 1]
        : isIngredients
          ? [ingredientsCondNode, 1]
          : hasGuides ? ["102", 1] : ["20", 1];

  // Empty audio latent
  nodes["18"] = {
    class_type: "LTXVEmptyLatentAudio",
    inputs: {
      audio_vae: ["87", 0],
      frames_number: config.numFrames,
      frame_rate: config.frameRate,
      batch_size: 1,
    },
  };

  // ── A2V Mode: Load audio, encode, freeze it ──
  let audioLatentRef: [string, number] = ["18", 0];
  if (isA2V) {
    // Load the user's audio file
    nodes["500"] = {
      class_type: "LoadAudio",
      inputs: { audio: config.a2vAudioFile },
    };
    // Encode audio via Audio VAE
    nodes["501"] = {
      class_type: "LTXVAudioVAEEncode",
      inputs: {
        audio: ["500", 0],
        audio_vae: ["87", 0],
      },
    };
    audioLatentRef = ["501", 0];
  }

  // Concat audio + video latents
  nodes["19"] = {
    class_type: "LTXVConcatAVLatent",
    inputs: {
      video_latent: videoLatentRef,
      audio_latent: audioLatentRef,
    },
  };

  // ── A2V Masking: freeze audio, open video ──
  let samplerCondPos: unknown = condPosRef;
  let samplerCondNeg: unknown = condNegRef;
  let samplerLatent: unknown = ["19", 0];

  // ── Retake / Extend: source-video latents + time-based freeze/regenerate mask ──
  // Mirrors the Alternative builder: load+encode the source, build an empty tail for Extend via
  // LTXVAddLatents, override the AV concat (node 19), then freeze everything outside the target
  // window with LTXVSetAudioVideoMaskByTime (init 0.0 = freeze; [start,end] = 1.0 = regenerate).
  if (isContinuity) {
    const fps = config.frameRate;
    const totalFrames = config.numFrames;
    const sourceFrames = isExtend
      ? Math.max(1, Math.min(config.continuitySourceFrames ?? 0, totalFrames - 1))
      : totalFrames;
    const tailFrames = Math.max(0, totalFrames - sourceFrames);
    const sourceDur = sourceFrames / fps;
    const totalDur = totalFrames / fps;
    const audioOn = config.enableAudio;

    nodes["420"] = {
      class_type: "VHS_LoadVideoPath",
      inputs: {
        video: config.continuitySourceVideo,
        force_rate: fps,
        custom_width: config.width,
        custom_height: config.height,
        frame_load_cap: sourceFrames,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
    };
    nodes["421"] = {
      class_type: "VAEEncodeTiled",
      inputs: {
        pixels: ["420", 0],
        vae: ["107", 0],
        tile_size: config.vaeTileSize ?? 512,
        overlap: config.vaeOverlap ?? 64,
        temporal_size: config.vaeTemporalSize ?? 64,
        temporal_overlap: config.vaeTemporalOverlap ?? 16,
      },
    };
    if (audioOn) {
      nodes["424"] = {
        class_type: "LTXVAudioVAEEncode",
        inputs: { audio: ["420", 2], audio_vae: ["87", 0] },
      };
    }

    let cVideo: [string, number] = ["421", 0];
    let cAudio: [string, number] = audioOn ? ["424", 0] : ["18", 0];

    if (isExtend && tailFrames > 0) {
      nodes["422"] = {
        class_type: "EmptyLTXVLatentVideo",
        inputs: { width: config.width, height: config.height, length: tailFrames, batch_size: 1 },
      };
      nodes["423"] = {
        class_type: "LTXVAddLatents",
        inputs: { latents1: ["421", 0], latents2: ["422", 0] },
      };
      cVideo = ["423", 0];
      if (audioOn) {
        nodes["425"] = {
          class_type: "LTXVEmptyLatentAudio",
          inputs: { audio_vae: ["87", 0], frames_number: tailFrames, frame_rate: fps, batch_size: 1 },
        };
        nodes["426"] = {
          class_type: "LTXVAddLatents",
          inputs: { latents1: ["424", 0], latents2: ["425", 0] },
        };
        cAudio = ["426", 0];
      }
    }

    nodes["19"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: { video_latent: cVideo, audio_latent: cAudio },
    };

    const winStart = isExtend ? sourceDur : Math.max(0, Math.min(config.retakeStart ?? 0, totalDur));
    const winEnd = isExtend
      ? totalDur
      : Math.max(winStart, Math.min(config.retakeEnd ?? totalDur, totalDur));
    const maskAudio = audioOn && (isExtend || !!config.retakeRegenAudio);

    nodes["430"] = {
      class_type: "LTXVSetAudioVideoMaskByTime",
      inputs: {
        av_latent: ["19", 0],
        positive: condPosRef,
        negative: condNegRef,
        model: [lastLoraNode, 0],
        vae: ["107", 0],
        audio_vae: ["87", 0],
        start_time: winStart,
        end_time: winEnd,
        video_fps: fps,
        mask_video: true,
        mask_audio: maskAudio,
        mask_init_value_video: 0.0,
        mask_init_value_audio: 0.0,
        slope_len: 3,
      },
    };
    samplerCondPos = ["430", 0];
    samplerCondNeg = ["430", 1];
    samplerLatent = ["430", 2];
    videoLatentRef = cVideo;
  }

  if (isA2V) {
    const chunkDur = config.numFrames / config.frameRate;
    nodes["510"] = {
      class_type: "LTXVSetAudioVideoMaskByTime",
      inputs: {
        av_latent: ["19", 0],
        positive: condPosRef,
        negative: condNegRef,
        model: [lastLoraNode, 0],
        vae: ["107", 0],
        audio_vae: ["87", 0],
        start_time: 0.0,
        end_time: chunkDur,
        video_fps: config.frameRate,
        mask_video: true,
        mask_audio: false,
        mask_init_value_video: 1.0,  // Video: fully denoise (generate from scratch)
        mask_init_value_audio: 0.0,  // Audio: frozen (keep uploaded audio)
        slope_len: 3,
      },
    };
    samplerCondPos = ["510", 0];
    samplerCondNeg = ["510", 1];
    samplerLatent = ["510", 2];
  }

  // ── Audio Overlap Conditioning (chunked V2A, reused from Alternative path) ──
  const hasOverlap = !!(config.overlapAudioFile && config.overlapDuration && config.overlapDuration > 0);
  if (hasOverlap && !isA2V) {
    const overlapDur = config.overlapDuration!;
    const chunkDur = config.numFrames / config.frameRate;
    const remainingFrames = Math.max(1, config.numFrames - Math.round(overlapDur * config.frameRate));

    nodes["200"] = {
      class_type: "LoadAudio",
      inputs: { audio: config.overlapAudioFile },
    };
    nodes["201"] = {
      class_type: "LTXVAudioVAEEncode",
      inputs: { audio: ["200", 0], audio_vae: ["87", 0] },
    };
    nodes["202"] = {
      class_type: "LTXVEmptyLatentAudio",
      inputs: {
        audio_vae: ["87", 0],
        frames_number: remainingFrames,
        frame_rate: config.frameRate,
        batch_size: 1,
      },
    };
    nodes["203"] = {
      class_type: "LTXVAddLatents",
      inputs: {
        latents1: ["201", 0],
        latents2: ["202", 0],
      },
    };
    // Override ConcatAVLatent with overlap audio
    nodes["19"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: {
        video_latent: videoLatentRef,
        audio_latent: ["203", 0],
      },
    };
    nodes["204"] = {
      class_type: "LTXVSetAudioVideoMaskByTime",
      inputs: {
        av_latent: ["19", 0],
        positive: condPosRef,
        negative: condNegRef,
        model: [lastLoraNode, 0],
        vae: ["107", 0],
        audio_vae: ["87", 0],
        start_time: overlapDur,
        end_time: chunkDur,
        video_fps: config.frameRate,
        mask_video: false,
        mask_audio: true,
        mask_init_value_video: 1.0,
        mask_init_value_audio: 0.0,
        slope_len: 3,
      },
    };
    samplerCondPos = ["204", 0];
    samplerCondNeg = ["204", 1];
    samplerLatent = ["204", 2];
  }

  // ── NAG (Negative Attention Guidance) ──
  // Patches cross-attention to actively suppress unwanted visual content (subtitles, text, watermarks).
  // Required for distilled models where negative prompts have zero effect (CFG=1).
  // Auto-enabled in lip-sync A2V mode (dialogue text in prompts causes subtitles without NAG).
  // NOT auto-enabled in music video mode (no dialogue = no subtitle risk, saves render time).
  const useNAG = !!(config.nagEnabled || (isA2V && config.a2vPurpose === "lip_sync"));
  if (useNAG) {
    const nagPrompt = config.nagPrompt || LTX2_NAG_DEFAULT_PROMPT;
    // Encode NAG prompt into conditioning for the cross-attention patch
    nodes["520"] = {
      class_type: "CLIPTextEncode",
      inputs: {
        text: nagPrompt,
        clip: ["88", 0],
      },
    };
    // LTX2_NAG (KJNodes): patches model cross-attention to suppress NAG conditioning content
    nodes["522"] = {
      class_type: "LTX2_NAG",
      inputs: {
        model: [lastLoraNode, 0],
        nag_scale: config.nagScale ?? 11.0,
        nag_alpha: config.nagAlpha ?? 0.25,
        nag_tau: config.nagTau ?? 2.5,
        nag_cond_video: ["520", 0],
        inplace: true,
      },
    };
    lastLoraNode = "522";
  }

  // ── Sampling ──

  const isTiledMode = config.samplingMode === "tiled" && !isContinuity;
  const is2StageMode = config.samplingMode === "2stage";

  // Noise
  nodes["124"] = {
    class_type: "RandomNoise",
    inputs: { noise_seed: seed },
  };

  if (tier === "full") {
    // ── Full Quality Tier (15 steps) ──

    // GuiderParameters: Audio settings
    nodes["GP_AUDIO"] = {
      class_type: "GuiderParameters",
      inputs: {
        modality: "AUDIO",
        cfg: config.audioCfg ?? LTX2_OFFICIAL_GUIDER_PARAMS.audio.cfg,
        stg: config.stg ?? 0.0,
        perturb_attn: true,
        rescale: config.audioCfgRescale ?? LTX2_OFFICIAL_GUIDER_PARAMS.audio.rescale,
        modality_scale: 0.0,
        skip_step: 0,
        cross_attn: true,
      },
    };
    // GuiderParameters: Video settings (chained from audio)
    nodes["GP_VIDEO"] = {
      class_type: "GuiderParameters",
      inputs: {
        parameters: ["GP_AUDIO", 0],
        modality: "VIDEO",
        cfg: config.videoCfg ?? LTX2_OFFICIAL_GUIDER_PARAMS.video.cfg,
        stg: config.stg ?? 0.0,
        perturb_attn: true,
        rescale: config.videoCfgRescale ?? LTX2_OFFICIAL_GUIDER_PARAMS.video.rescale,
        modality_scale: 0.0,
        skip_step: 0,
        cross_attn: true,
      },
    };

    // MultimodalGuider
    nodes["170"] = {
      class_type: "MultimodalGuider",
      inputs: {
        model: [lastLoraNode, 0],
        positive: samplerCondPos,
        negative: samplerCondNeg,
        parameters: ["GP_VIDEO", 0],
        skip_blocks: "",
      },
    };

    // ClownSampler_Beta from RES4LYF custom node
    nodes["126"] = {
      class_type: "ClownSampler_Beta",
      inputs: {
        eta: config.fullEta ?? 0.25,
        sampler_name: config.fullSampler ?? "exponential/res_2s",
        seed: seed,
        bongmath: true,
      },
    };

    // ManualSigmas: pre-computed from LTXVScheduler math in TypeScript.
    // Bypasses the ComfyUI LTXVScheduler node which intermittently produces NaN sigmas
    // (likely due to NestedTensor / execution-order issues with the latent input).
    // The computeFullTierSigmas() function replicates the exact same formula.
    // When Turbo Upscale is on, use half-res dims for correct sigma shift calculation.
    const sigmaConfig = isTurbo
      ? { ...config, width: samplingWidth, height: samplingHeight }
      : config;
    nodes["132"] = {
      class_type: "ManualSigmas",
      inputs: { sigmas: computeFullTierSigmas(sigmaConfig) },
    };

  } else {
    // ── Distilled / Test Tier ──
    // Test: 3 steps for quick iteration; Distilled: 8 steps for fast quality

    // Advanced mode gates our non-stock tuning. OFF = stock Lightricks distilled recipe
    // (8 steps, euler, single joint pass). Test tier is implicitly advanced.
    const adv = (config.officialAdvanced ?? false) || tier === "test";
    // KSamplerSelect: euler is the stock distilled sampler; advanced may override.
    const samplerName = adv ? (config.testSampler || "euler") : "euler";
    nodes["126"] = {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: samplerName },
    };

    // ManualSigmas: test tier uses configurable step count, distilled uses fixed 8 steps
    if (tier === "test") {
      // Build sigmas from distilled schedule, subsampled to testVideoSteps
      const videoSteps = config.testVideoSteps ?? 3;
      const distilledArr = LTX2_DISTILLED_SIGMAS.split(",").map(s => parseFloat(s.trim()));
      // Evenly subsample: always include first and last, pick intermediate points
      const sigmaArr: number[] = [distilledArr[0]];
      for (let i = 1; i < videoSteps; i++) {
        const idx = Math.round(i * (distilledArr.length - 1) / videoSteps);
        sigmaArr.push(distilledArr[idx]);
      }
      sigmaArr.push(distilledArr[distilledArr.length - 1]);
      nodes["132"] = {
        class_type: "ManualSigmas",
        inputs: { sigmas: sigmaArr.join(", ") },
      };
    } else {
      // Distilled tier: stock 8 steps; advanced mode allows an override (subsampled schedule).
      const distSteps = adv ? (config.distilledSteps ?? 8) : 8;
      if (distSteps === 8) {
        nodes["132"] = {
          class_type: "ManualSigmas",
          inputs: { sigmas: LTX2_DISTILLED_SIGMAS },
        };
      } else {
        // Subsample distilled schedule to requested step count
        const distArr = LTX2_DISTILLED_SIGMAS.split(",").map(s => parseFloat(s.trim()));
        const sigmaArr: number[] = [distArr[0]];
        for (let i = 1; i < distSteps; i++) {
          const idx = Math.round(i * (distArr.length - 1) / distSteps);
          sigmaArr.push(distArr[idx]);
        }
        sigmaArr.push(distArr[distArr.length - 1]);
        nodes["132"] = {
          class_type: "ManualSigmas",
          inputs: { sigmas: sigmaArr.join(", ") },
        };
      }
    }

    if (isTiledMode) {
      // ── Tiled Sampling (1080p+ anti-repetition) ──
      // LTXVTiledSampler requires STGGuiderAdvanced (provides raw_conds for per-tile conditioning).
      // Operates on video-only latent: AV concat is incompatible with spatial tiling
      // because audio uses NestedTensor with different spatial dims.
      // Audio is generated via a separate normal pass after the tiled video pass.

      // LTXVApplySTG: mark transformer blocks to skip during perturbed attention pass
      nodes["900"] = {
        class_type: "LTXVApplySTG",
        inputs: {
          model: [lastLoraNode, 0],
          block_indices: "14, 19",
        },
      };

      // STGGuiderAdvanced: provides raw_conds for per-tile conditioning in LTXVTiledSampler.
      // For distilled models: cfg=1, stg=0 (no guidance overhead), matches "13b Distilled" preset.
      const tiledCfg = config.tiledSamplingCFG ?? 1.0;
      const tiledSTG = config.tiledSamplingSTG ?? 0;
      nodes["170"] = {
        class_type: "STGGuiderAdvanced",
        inputs: {
          model: ["900", 0],
          positive: samplerCondPos,
          negative: samplerCondNeg,
          skip_steps_sigma_threshold: 0.997,
          cfg_star_rescale: true,
          sigmas: "1.0",
          cfg_values: String(tiledCfg),
          stg_scale_values: String(tiledSTG),
          stg_rescale_values: "1",
          stg_layers_indices: "[25]",
        },
      };
    } else if ((isA2V && config.a2vPurpose === "lip_sync") || useNAG) {
      // Lip-sync A2V / standalone NAG: CFGGuider with moderate CFG so negative prompt + NAG have effect.
      // Without CFG > 1, negative prompts are ignored and NAG alone may not fully suppress subtitles.
      // Music Video A2V uses BasicGuider (no subtitle risk, normal render speed).
      const a2vCfg = config.a2vCfg ?? 3.0;
      nodes["170"] = {
        class_type: "CFGGuider",
        inputs: {
          model: [lastLoraNode, 0],
          positive: samplerCondPos,
          negative: samplerCondNeg,
          cfg: a2vCfg,
        },
      };
    } else {
      // BasicGuider: single conditioning, no CFG overhead
      // (CFGGuider at cfg=1 runs model 2x per step for identical result)
      nodes["170"] = {
        class_type: "BasicGuider",
        inputs: {
          model: [lastLoraNode, 0],
          conditioning: samplerCondPos,
        },
      };
    }
  }

  // ── Optional Live Preview via Tiny VAE (KJNodes LTX2SamplingPreviewOverride) ──
  // Loads a lightweight ~23MB Tiny AutoEncoder for low-quality but real-time
  // preview frames during sampling. Wraps the model with a callback that
  // decodes latents to preview images at a configurable rate.
  // Off by default: adds VRAM pressure that can cause swapping on tight setups.
  if (config.livePreview && !isTiledMode) {
    nodes["601"] = {
      class_type: "VAELoader",
      inputs: { vae_name: "taeltx2_3.safetensors" },
    };
    nodes["602"] = {
      class_type: "LTX2SamplingPreviewOverride",
      inputs: {
        model: [lastLoraNode, 0],
        preview_rate: config.previewRate ?? 8,
        vae: ["601", 0],
      },
    };
    // Re-point guider to use the preview-wrapped model
    (nodes["170"] as Record<string, unknown>).inputs = {
      ...((nodes["170"] as Record<string, unknown>).inputs as Record<string, unknown>),
      model: ["602", 0],
    };
  }

  if (isTiledMode) {
    // ── Tiled Sampling Path ──
    // LTXVTiledSampler operates on VIDEO-ONLY latent (not AV concat).
    // It splits the latent into overlapping spatial tiles, runs SamplerCustomAdvanced
    // per tile with per-tile image conditioning, then blends overlapping regions.
    const hTiles = config.tiledSamplingHTiles ?? 1;
    const vTiles = config.tiledSamplingVTiles ?? 2;
    const tileOverlap = config.tiledSamplingOverlap ?? 4;
    const condStrength = config.tiledSamplingCondStrength ?? 0.15;

    const tiledInputs: Record<string, unknown> = {
      model: [lastLoraNode, 0],
      vae: ["107", 0],
      noise: ["124", 0],
      sampler: ["126", 0],
      sigmas: ["132", 0],
      guider: ["170", 0],
      latents: videoLatentRef,
      horizontal_tiles: hTiles,
      vertical_tiles: vTiles,
      overlap: tileOverlap,
      latents_cond_strength: condStrength,
      boost_latent_similarity: false,
      crop: "disabled",
    };

    // NOTE: Do NOT pass optional_cond_images here when using LTXVAddGuideMulti (I2V).
    // The source image guides are already baked into videoLatentRef from node 102.
    // Adding them again via the tiled sampler's internal LTXVAddGuide would create
    // duplicate guide frames and break the conditioning alignment.
    // The tiled sampler will denoise the existing guided latent tiles as-is.

    nodes["123"] = {
      class_type: "LTXVTiledSampler",
      inputs: tiledInputs,
    };

    // Tiled sampler outputs video-only latent, no AV separation needed.
    // Create a synthetic "14" node entry that downstream expects:
    // Node 14 output [0] = video latent, [1] = audio latent.
    // For tiled path: video comes from tiled sampler, audio from empty latent.
    // We skip LTXVSeparateAVLatent entirely and wire directly.

  } else {
    // ── Normal Sampling Path ──
    // Direct Sampling: bypass NormalizingSampler entirely, use SamplerCustomAdvanced.
    // Skips per-step audio/video normalization: community alternative that avoids
    // the normalization overhead and can produce different (sometimes cleaner) results.
    if (config.directSampling) {
      nodes["123"] = {
        class_type: "SamplerCustomAdvanced",
        inputs: {
          noise: ["124", 0],
          guider: ["170", 0],
          sampler: ["126", 0],
          sigmas: ["132", 0],
          latent_image: samplerLatent,
        },
      };
    } else {
      // VekSnapAVNormSampler: drop-in for LTXVNormalizingSampler WITH live video preview.
      nodes["123"] = {
        class_type: "LTXVNormalizingSampler", // was VekSnapAVNormSampler - disabled temporarily to isolate OOM
        inputs: {
          noise: ["124", 0],
          guider: ["170", 0],
          sampler: ["126", 0],
          sigmas: ["132", 0],
          latent_image: samplerLatent,
          video_normalization_factors: config.videoNormFactors,
          // A2V: audio is frozen in the latent - do NOT normalize it or the 0.25×
          // steps will corrupt the encoded audio (reducing it to ~6% magnitude).
          audio_normalization_factors: isA2V ? "1,1,1,1,1,1,1,1" : config.audioNormFactors,
        },
      };
    }
  }

  // ── Post-Processing ──

  if (isTiledMode) {
    // Tiled path: video comes directly from LTXVTiledSampler (node 123, output 0).
    // No AV separation needed: create node 14 as passthrough for downstream compat.
    // Downstream expects: node "14" output [0] = video, [1] = audio.
    // We'll wire CropGuides and audio decode to use the correct sources directly.
    nodes["14"] = {
      class_type: "LTXVSeparateAVLatent",
      inputs: { av_latent: samplerLatent },
    };
    // Note: node 14 here processes the original AV latent just for audio extraction.
    // Video goes directly from tiled sampler (node 123) to CropGuides (node 120).
  } else {
    // Normal path: Separate audio/video latents from pass 1
    nodes["14"] = {
      class_type: "LTXVSeparateAVLatent",
      inputs: { av_latent: ["123", 0] },
    };
  }

  // ── Dual-Pass Audio Refinement (test tier, configurable) ──
  // Pass 1 produces good video but audio can be undercooked at low step counts.
  // Pass 2: freeze the video latent, re-denoise ONLY the audio with extra steps.
  let audioLatentForDecode: [string, number] = ["14", 1];
  const audioRefineSteps = config.testAudioSteps ?? 5;
  // The dual-pass audio refinement runs for Test always, and for Distilled when Advanced is on.
  const audioRefineAdv = (config.officialAdvanced ?? false) || tier === "test";

  if (((tier === "test") || (tier === "distilled" && audioRefineAdv)) && audioRefineSteps > 0 && config.enableAudio && !isA2V) {
    // Re-concat pass-1 video + audio for second sampling pass
    nodes["700"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: {
        video_latent: ["14", 0],   // video from pass 1 (good)
        audio_latent: ["14", 1],   // audio from pass 1 (noisy)
      },
    };

    // Mask: freeze video (mask=true, value=0), let audio denoise naturally (mask=false)
    const chunkDur = config.numFrames / config.frameRate;
    nodes["701"] = {
      class_type: "LTXVSetAudioVideoMaskByTime",
      inputs: {
        av_latent: ["700", 0],
        positive: samplerCondPos,
        negative: samplerCondNeg,
        model: [lastLoraNode, 0],
        vae: ["107", 0],
        audio_vae: ["87", 0],
        start_time: 0.0,
        end_time: chunkDur,
        video_fps: config.frameRate,
        mask_video: true,            // Apply mask to video
        mask_audio: false,           // Don't mask audio (let it denoise)
        mask_init_value_video: 0.0,  // Video mask=0 → frozen (preserve pass-1 result)
        mask_init_value_audio: 1.0,  // (unused since mask_audio=false)
        slope_len: 1,
      },
    };

    // Second noise seed (different from pass 1)
    nodes["702"] = {
      class_type: "RandomNoise",
      inputs: { noise_seed: seed + 1 },
    };

    // Audio refinement sigmas: evenly spaced from where pass-1 left off (0.421875) to 0
    const audioSigmas: number[] = [];
    const startSigma = 0.421875; // last non-zero sigma from test schedule
    for (let i = 0; i <= audioRefineSteps; i++) {
      audioSigmas.push(startSigma * (1 - i / audioRefineSteps));
    }
    nodes["703"] = {
      class_type: "ManualSigmas",
      inputs: { sigmas: audioSigmas.map(s => s.toFixed(6)).join(", ") },
    };

    // Build normalization factors string (all 1s, length = audioRefineSteps)
    const audioNormOnes = Array(audioRefineSteps).fill("1").join(",");

    // Pass-2 sampler: same guider + sampler, but with video frozen + more audio steps
    nodes["704"] = {
      class_type: "LTXVNormalizingSampler",
      inputs: {
        noise: ["702", 0],
        guider: ["170", 0],
        sampler: ["126", 0],
        sigmas: ["703", 0],
        latent_image: ["701", 2],       // masked AV latent (video frozen, audio open)
        video_normalization_factors: audioNormOnes,
        audio_normalization_factors: audioNormOnes,
      },
    };

    // Separate pass-2 result to get refined audio
    nodes["705"] = {
      class_type: "LTXVSeparateAVLatent",
      inputs: { av_latent: ["704", 0] },
    };

    audioLatentForDecode = ["705", 1];
  }

  // Crop guide frames from video latent (strips appended keyframe latents after sampling)
  // For T2V (no guides): passthrough. For I2V: removes guide frames to prevent black/corrupt output.
  // Tiled path: video comes directly from LTXVTiledSampler (node 123, output 0).
  // Normal path: video comes from LTXVSeparateAVLatent (node 14, output 0).
  const cropVideoSource: [string, number] = isTiledMode ? ["123", 0] : ["14", 0];
  nodes["120"] = {
    class_type: "LTXVCropGuides",
    inputs: {
      positive: samplerCondPos,
      negative: samplerCondNeg,
      latent: cropVideoSource,
    },
  };

  // ── Turbo Upscale: 2x latent upscale + refinement pass ──
  // Inserts between CropGuides (120) and VAEDecode (129).
  let videoDecodeSource: [string, number] = ["120", 2];

  const turboMethod = config.turboUpscaleMethod || TURBO_UPSCALE_DEFAULTS.method;

  if (isTurbo && turboMethod === "latent") {
    // Load latent upscale model
    nodes["800"] = {
      class_type: "LatentUpscaleModelLoader",
      inputs: {
        model_name: config.turboUpscaleModel || TURBO_UPSCALE_DEFAULTS.model,
      },
    };

    // Upscale video latent 2x (half-res → full-res)
    nodes["801"] = {
      class_type: "LTXVLatentUpsampler",
      inputs: {
        samples: ["120", 2],
        upscale_model: ["800", 0],
        vae: ["107", 0],
      },
    };

    // Re-inject source image at full resolution (anchors first frame after upscale)
    let upscaledVideoLatent: [string, number] = ["801", 0];
    if (hasSourceImage) {
      const refineStr = config.turboUpscaleRefineStrength ?? TURBO_UPSCALE_DEFAULTS.refineStrength;
      // Load source image at full resolution for re-injection (guide images were scaled to half-res)
      nodes["810"] = {
        class_type: "LoadImage",
        inputs: { image: config.sourceImage },
      };
      nodes["802"] = {
        class_type: "LTXVImgToVideoInplace",
        inputs: {
          vae: ["107", 0],
          image: ["810", 0],
          latent: ["801", 0],
          strength: refineStr,
          bypass: false,
        },
      };
      upscaledVideoLatent = ["802", 0];
    }

    // Recombine upscaled video + audio latent for refinement sampling
    nodes["803"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: {
        video_latent: upscaledVideoLatent,
        audio_latent: audioLatentForDecode,
      },
    };

    // CFGGuider for refinement (cfg=1: equivalent to no classifier-free guidance)
    nodes["804"] = {
      class_type: "CFGGuider",
      inputs: {
        model: [lastLoraNode, 0],
        positive: ["120", 0],
        negative: ["120", 1],
        cfg: 1.0,
      },
    };

    // Refinement sampler selection (default euler_cfg_pp, optimized for CFG-predicted noise)
    nodes["805"] = {
      class_type: "KSamplerSelect",
      inputs: { sampler_name: config.turboUpscaleSampler || TURBO_UPSCALE_DEFAULTS.sampler },
    };

    // Refinement sigmas: prefer user-supplied schedule, otherwise short auto schedule for detail recovery
    const refineSteps = config.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps;
    const defaultSigmas = [...TURBO_UPSCALE_DEFAULTS.refineSigmas];
    let refineSigmaStr: string;
    if (config.turboUpscaleCustomSigmas && config.turboUpscaleCustomSigmas.trim()) {
      refineSigmaStr = config.turboUpscaleCustomSigmas.split(",").map(s => s.trim()).filter(Boolean).join(", ");
    } else if (refineSteps === TURBO_UPSCALE_DEFAULTS.refineSteps) {
      refineSigmaStr = defaultSigmas.join(", ");
    } else {
      const sigmas: number[] = [];
      for (let i = 0; i <= refineSteps; i++) {
        sigmas.push(0.85 * (1 - i / refineSteps));
      }
      refineSigmaStr = sigmas.map(s => s.toFixed(4)).join(", ");
    }
    nodes["806"] = {
      class_type: "ManualSigmas",
      inputs: { sigmas: refineSigmaStr },
    };

    // Refinement noise: same seed as stage 1 for temporal consistency (per Lightricks recommendation)
    nodes["807"] = {
      class_type: "RandomNoise",
      inputs: { noise_seed: seed },
    };

    // SamplerCustomAdvanced: refinement pass (direct sampling, no normalization needed)
    nodes["808"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["807", 0],
        guider: ["804", 0],
        sampler: ["805", 0],
        sigmas: ["806", 0],
        latent_image: ["803", 0],
      },
    };

    // Separate refined output
    nodes["809"] = {
      class_type: "LTXVSeparateAVLatent",
      inputs: { av_latent: ["808", 0] },
    };

    videoDecodeSource = ["809", 0];
    audioLatentForDecode = ["809", 1];
  }

  // VAE Decode: decode video latent to pixel space
  // LTXVSpatioTemporalTiledVAEDecode: aggressive tiled decode for 1080p+ GGUF output
  // VAEDecodeTiled: standard tiled decode for lower resolutions
  if (config.spatioTemporalVAE) {
    nodes["129"] = {
      class_type: "LTXVSpatioTemporalTiledVAEDecode",
      inputs: {
        latents: videoDecodeSource,
        vae: ["107", 0],
        spatial_tiles: config.spatioTemporalTiles ?? 4,
        spatial_overlap: config.spatioTemporalOverlap ?? 4,
        temporal_tile_length: config.spatioTemporalLength ?? 16,
        temporal_overlap: config.spatioTemporalTempOverlap ?? 4,
        last_frame_fix: false,
        working_device: "auto",
        working_dtype: "auto",
      },
    };
  } else {
    nodes["129"] = {
      class_type: "VAEDecodeTiled",
      inputs: {
        samples: videoDecodeSource,
        vae: ["107", 0],
        tile_size: config.vaeTileSize ?? 512,
        overlap: config.vaeOverlap ?? 64,
        temporal_size: config.vaeTemporalSize ?? 64,
        temporal_overlap: config.vaeTemporalOverlap ?? 16,
      },
    };
  }

  // RTX Video Super Resolution: hardware-accelerated pixel upscale (after VAE decode)
  let finalVideoImages: [string, number] = ["129", 0];
  if (isTurbo && turboMethod === "rtx_vsr") {
    nodes["820"] = {
      class_type: "RTXVideoSuperResolution",
      inputs: {
        images: ["129", 0],
        resize_type: "scale by multiplier",
        "resize_type.scale": 2.0,
        quality: TURBO_UPSCALE_DEFAULTS.rtxVsrQuality,
      },
    };
    finalVideoImages = ["820", 0];
  }

  // Audio VAE Decode (uses turbo-refined or pass-2 or pass-1 audio, whichever is latest)
  nodes["16"] = {
    class_type: "LTXVAudioVAEDecode",
    inputs: {
      samples: audioLatentForDecode,
      audio_vae: ["87", 0],
    },
  };

  // VHS_VideoCombine: final MP4
  const videoCombineInputs: Record<string, unknown> = {
    images: finalVideoImages,
    frame_rate: config.frameRate,
    loop_count: 0,
    filename_prefix: "ltx2/VekSnap_LTX2_Official",
    format: "video/h264-mp4",
    pix_fmt: "yuv420p",
    save_output: true,
    pingpong: false,
    save_metadata: config.embedWorkflowMetadata !== false,
  };

  // For A2V: use the original uploaded audio directly (node 500) - avoids
  // quality degradation from the VAE encode→sample→decode round-trip.
  // For normal: use sampled/decoded audio (node 16).
  if (isA2V) {
    videoCombineInputs.audio = ["500", 0];
  } else if (config.enableAudio) {
    videoCombineInputs.audio = ["16", 0];
  }

  nodes["17"] = {
    class_type: "VHS_VideoCombine",
    inputs: videoCombineInputs,
  };

  return nodes;
}

// ── AceStep 1.5 XL Music Generation Workflow ──

export function buildAceStepWorkflow(
  config: AceStepConfig
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
  const seed = config.randomSeed || config.seed < 0
    ? Math.floor(Math.random() * 2 ** 32)
    : config.seed;

  // DualCLIPLoader: two text encoders (type: ace)
  nodes["1"] = {
    class_type: "DualCLIPLoader",
    inputs: {
      clip_name1: config.textEncoderSmall,
      clip_name2: config.textEncoderLarge,
      type: "ace",
      device: "default",
    },
  };

  // TextEncodeAceStepAudio1.5: encode tags + lyrics with music parameters
  nodes["2"] = {
    class_type: "TextEncodeAceStepAudio1.5",
    inputs: {
      clip: ["1", 0],
      tags: config.tags,
      lyrics: config.lyrics,
      seed: seed,
      bpm: config.bpm,
      duration: config.duration,
      timesignature: config.timeSignature,
      language: config.language,
      keyscale: config.keyScale,
      generate_audio_codes: config.generateAudioCodes,
      cfg_scale: config.cfgScale,
      temperature: config.temperature,
      top_p: config.topP,
      top_k: config.topK,
      min_p: 0,
    },
  };

  // UNETLoader: diffusion model
  nodes["3"] = {
    class_type: "UNETLoader",
    inputs: {
      unet_name: config.diffusionModel,
      weight_dtype: "default",
    },
  };

  // User LoRAs: chain after UNETLoader
  let lastModelNode = "3";
  const enabledLoras = config.userLoras.filter((l) => l.enabled && l.name);
  enabledLoras.forEach((lora, i) => {
    const nodeId = String(30 + i);
    nodes[nodeId] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: [lastModelNode, 0],
        lora_name: lora.name.replace(/\//g, "\\"),
        strength_model: lora.strengthModel,
      },
    };
    lastModelNode = nodeId;
  });

  // ModelSamplingAuraFlow: patch model for flow-matching sampling
  nodes["4"] = {
    class_type: "ModelSamplingAuraFlow",
    inputs: {
      model: [lastModelNode, 0],
      shift: config.samplerShift,
    },
  };

  // VAELoader: audio VAE
  nodes["6"] = {
    class_type: "VAELoader",
    inputs: {
      vae_name: config.vae,
    },
  };

  const isRemix = config.aceMode === "remix";
  const isCover = config.aceMode === "cover";
  const isExtend = config.aceMode === "extend";
  const hasSourceAudio = !!config.sourceAudioFile && (isRemix || isCover || isExtend);

  // Latent: either from source audio (remix/cover) or empty (generate/extend)
  let latentRef: [string, number] = ["5", 0];

  if (hasSourceAudio && (isRemix || isCover)) {
    // Remix/Cover: encode source audio → use as latent_image with partial denoise
    nodes["40"] = {
      class_type: "LoadAudio",
      inputs: { audio: config.sourceAudioFile },
    };
    nodes["41"] = {
      class_type: "VAEEncodeAudio",
      inputs: { audio: ["40", 0], vae: ["6", 0] },
    };
    latentRef = ["41", 0];
  } else {
    // Generate/Extend: empty latent for the target duration
    nodes["5"] = {
      class_type: "EmptyAceStep1.5LatentAudio",
      inputs: { seconds: config.duration, batch_size: 1 },
    };
  }

  // Conditioning: start from TextEncode output
  let conditioningRef: [string, number] = ["2", 0];

  // Source audio as style reference for Cover and Extend modes
  if (hasSourceAudio && (isCover || isExtend)) {
    // Load source audio (reuse node 40 if already created for cover, else create new)
    if (!nodes["40"]) {
      nodes["40"] = {
        class_type: "LoadAudio",
        inputs: { audio: config.sourceAudioFile },
      };
    }
    if (!nodes["41"]) {
      nodes["41"] = {
        class_type: "VAEEncodeAudio",
        inputs: { audio: ["40", 0], vae: ["6", 0] },
      };
    }
    // ReferenceTimbreAudio from source: transfers style/timbre to new generation
    nodes["42"] = {
      class_type: "ReferenceTimbreAudio",
      inputs: {
        conditioning: conditioningRef,
        latent: ["41", 0],
      },
    };
    conditioningRef = ["42", 0];
  }

  // Optional user reference audio (stacks on top of any source-based reference)
  if (config.referenceAudioFile) {
    nodes["20"] = {
      class_type: "LoadAudio",
      inputs: { audio: config.referenceAudioFile },
    };
    nodes["21"] = {
      class_type: "VAEEncodeAudio",
      inputs: { audio: ["20", 0], vae: ["6", 0] },
    };
    nodes["22"] = {
      class_type: "ReferenceTimbreAudio",
      inputs: {
        conditioning: conditioningRef,
        latent: ["21", 0],
      },
    };
    conditioningRef = ["22", 0];
  }

  // Denoise: 1.0 for generate/extend (full generation), partial for remix/cover
  const denoise = (isRemix || isCover) ? config.remixDenoise : 1.0;

  // BasicGuider: model + conditioning (CFG handled internally by TextEncode)
  nodes["10"] = {
    class_type: "BasicGuider",
    inputs: {
      model: ["4", 0],
      conditioning: conditioningRef,
    },
  };

  // RandomNoise: seed
  nodes["11"] = {
    class_type: "RandomNoise",
    inputs: {
      noise_seed: seed,
    },
  };

  // BasicScheduler: steps + scheduler
  nodes["12"] = {
    class_type: "BasicScheduler",
    inputs: {
      model: ["4", 0],
      scheduler: "simple",
      steps: config.steps,
      denoise,
    },
  };

  // KSamplerSelect: euler sampler
  nodes["14"] = {
    class_type: "KSamplerSelect",
    inputs: {
      sampler_name: "euler",
    },
  };

  // SamplerCustomAdvanced: run the sampling
  nodes["13"] = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["11", 0],
      guider: ["10", 0],
      sampler: ["14", 0],
      sigmas: ["12", 0],
      latent_image: latentRef,
    },
  };

  // VAEDecodeAudio: decode latent to audio
  nodes["15"] = {
    class_type: "VAEDecodeAudio",
    inputs: {
      samples: ["13", 0],
      vae: ["6", 0],
    },
  };

  // SaveAudioMP3: save output
  nodes["16"] = {
    class_type: "SaveAudioMP3",
    inputs: {
      audio: ["15", 0],
      filename_prefix: "audio/VekSnap_AceStep",
      quality: "V0",
    },
  };

  return nodes;
}

// ── HeartMuLa 3B Music Generation Workflow ──
// Pipeline: FL_HeartMuLa_ModelLoader → FL_HeartMuLa_Conditioning → FL_HeartMuLa_Sampler → FL_HeartMuLa_Decode → PreviewAudio / SaveAudioMP3

export function buildHeartMuLaWorkflow(
  config: HeartMuLaConfig
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
  const seed = config.randomSeed || config.seed < 0
    ? Math.floor(Math.random() * 2147483647)
    : config.seed;

  // Node 1: FL_HeartMuLa_ModelLoader - loads 3B model + HeartCodec
  nodes["1"] = {
    class_type: "FL_HeartMuLa_ModelLoader",
    inputs: {
      model_version: config.modelVariant,
      memory_mode: config.memoryMode,
      precision: config.precision,
      use_4bit: config.use4bit,
      force_reload: false,
    },
  };

  // Node 2: FL_HeartMuLa_Conditioning - tokenizes lyrics + tags
  nodes["2"] = {
    class_type: "FL_HeartMuLa_Conditioning",
    inputs: {
      model: ["1", 0],
      lyrics: config.lyrics,
      tags: config.tags,
      cfg_scale: config.cfgScale,
    },
  };

  // Node 3: FL_HeartMuLa_Sampler - autoregressive token generation
  nodes["3"] = {
    class_type: "FL_HeartMuLa_Sampler",
    inputs: {
      model: ["1", 0],
      conditioning: ["2", 0],
      max_duration_sec: config.maxDuration,
      temperature: config.temperature,
      top_k: config.topK,
      seed,
    },
  };

  // Node 4: FL_HeartMuLa_Decode - HeartCodec detokenize → waveform (48kHz)
  nodes["4"] = {
    class_type: "FL_HeartMuLa_Decode",
    inputs: {
      model: ["1", 0],
      audio_tokens: ["3", 0],
    },
  };

  // Node 5: PreviewAudio - allows playback in ComfyUI
  nodes["5"] = {
    class_type: "PreviewAudio",
    inputs: {
      audio: ["4", 0],
    },
  };

  // Node 6: SaveAudioMP3 - saves to ComfyUI/output/audio/
  nodes["6"] = {
    class_type: "SaveAudioMP3",
    inputs: {
      audio: ["4", 0],
      filename_prefix: "audio/VekSnap_HeartMuLa",
      quality: "V0",
    },
  };

  return nodes;
}

// ── Lip Sync Post-Processing (LatentSync 1.6 + Face Restoration) ──
// Takes an existing video file + audio file and produces a lip-synced version.
// Pipeline: LoadVideo → LatentSyncNode → (optional) FaceRestore → SaveVideo
// Requires: ComfyUI-LatentSyncWrapper + facerestore_cf custom nodes.
export function buildLipSyncWorkflow(opts: {
  videoPath: string;       // path to input video (ComfyUI output/ relative or absolute)
  audioPath: string;       // path to audio WAV in ComfyUI input/
  seed: number;
  inferenceSteps: number;  // 10-50
  lipsExpression: number;  // 1.0-3.0
  faceRestore: "gfpgan" | "none";
  faceRestoreFidelity: number; // 0.0-1.0
  faceDetection: string;       // e.g. "retinaface_resnet50"
  frameRate: number;
}): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};

  // Node 1: Load input video → IMAGE frames + audio
  nodes["1"] = {
    class_type: "VHS_LoadVideoPath",
    inputs: {
      video: opts.videoPath,
      force_rate: 25,             // LatentSync native rate
      force_size: "Disabled",
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
  };

  // Node 2: Load audio separately for LatentSync (AUDIO type)
  nodes["2"] = {
    class_type: "LoadAudio",
    inputs: { audio: opts.audioPath },
  };

  // Node 3: LatentSync1.6 - the core lip sync engine
  nodes["3"] = {
    class_type: "LatentSyncNode",
    inputs: {
      images: ["1", 0],          // IMAGE frames from loaded video
      audio: ["2", 0],           // AUDIO from loaded audio file
      seed: opts.seed,
      lips_expression: opts.lipsExpression,
      inference_steps: opts.inferenceSteps,
    },
  };

  // The source for final output, either restored or raw LatentSync output
  let finalImageSource: [string, number] = ["3", 0];
  const finalAudioSource: [string, number] = ["3", 1];

  // Node 4-5: Optional face restoration (GFPGAN - permissive/Apache).
  // CodeFormer was removed: its S-Lab weights are non-commercial.
  if (opts.faceRestore !== "none") {
    const modelName = "GFPGANv1.4.pth";

    // Node 4: Load face restore model
    nodes["4"] = {
      class_type: "FaceRestoreModelLoader",
      inputs: { model_name: modelName },
    };

    // Node 5: Restore faces in lip-synced output
    nodes["5"] = {
      class_type: "FaceRestoreCFWithModel",
      inputs: {
        facerestore_model: ["4", 0],
        image: ["3", 0],                    // lip-synced frames
        facedetection: opts.faceDetection,
        codeformer_fidelity: opts.faceRestoreFidelity,
      },
    };

    finalImageSource = ["5", 0];
  }

  // Node 10: Save final lip-synced video
  nodes["10"] = {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: finalImageSource,
      audio: finalAudioSource,
      frame_rate: opts.frameRate,
      loop_count: 0,
      filename_prefix: "lipsync/VekSnap_LipSync",
      format: "video/h264-mp4",
      save_output: true,
      pingpong: false,
      pix_fmt: "yuv420p",
      crf: 19,
    },
  };

  return nodes;
}


// ── DramaBox TTS (Resemble AI) Workflow ──

export function buildDramaBoxWorkflow(
  config: DramaBoxConfig
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
  const seed = config.randomSeed || config.seed < 0
    ? Math.floor(Math.random() * 2147483647)
    : Math.min(config.seed, 2147483647);

  // Node 1: DramaBox Options
  nodes["1"] = {
    class_type: "DramaBoxOptions",
    inputs: {
      steps: config.steps,
      negative_prompt: config.negativePrompt,
      cfg_scale: config.cfgScale,
      stg_scale: config.stgScale,
      rescale_scale: config.rescaleScale,
      id_guidance_scale: config.idGuidanceScale,
      gen_duration: config.genDuration,
      duration_multiplier: config.durationMultiplier,
      speed: config.speed,
      ref_duration: config.refDuration,
      post_generate_model_policy: config.modelPolicy,
      attention_policy: "auto",
      generation_mode: config.generationMode,
    },
  };

  // Node 2: DramaBox CLIP Loader (provides text encoder for clip_loader mode)
  if (config.generationMode === "clip_loader") {
    nodes["2"] = {
      class_type: "DramaBoxTextEncoderLoader",
      inputs: {
        gemma_model: config.textEncoder,
      },
    };
  }

  // Node 3: DramaBox TTS (main generation node)
  const ttsInputs: Record<string, unknown> = {
    seed: seed,
    use_prompt_input: false,
    text: config.prompt,
    options: ["1", 0],
  };

  // Connect CLIP if using clip_loader mode
  if (config.generationMode === "clip_loader") {
    ttsInputs.dramabox_clip = ["2", 0];
  }

  // Voice reference: connect LoadAudio output if we have one
  if (config.voiceRefFile) {
    ttsInputs.voice_ref = ["10", 0];
  }

  // LoRA stack: connect if we have enabled LoRAs
  const enabledLoras = config.userLoras.filter((l) => l.enabled && l.name);
  if (enabledLoras.length > 0) {
    ttsInputs.lora_stack = ["20", 0];
  }

  nodes["3"] = {
    class_type: "DramaBoxTTS",
    inputs: ttsInputs,
  };

  // Node 4: Save audio output
  nodes["4"] = {
    class_type: "SaveAudio",
    inputs: {
      audio: ["3", 0],
      filename_prefix: "dramabox_tts",
    },
  };

  // Node 10: Load voice reference (if provided)
  if (config.voiceRefFile) {
    nodes["10"] = {
      class_type: "LoadAudio",
      inputs: { audio: config.voiceRefFile },
    };
  }

  // Node 20+: LoRA stack builder (if LoRAs provided)
  if (enabledLoras.length > 0) {
    // Use ComfyUI's LoraStack or build a simple list passthrough
    // DramaBox accepts LORA_STACK: we'll build it with CR LoRA Stack or similar
    // For simplicity, use the first LoRA as a single entry via Power Lora Loader
    // Actually DramaBox uses its own internal LoRA apply, we just need the LORA_STACK format
    // which is a list of (name, model_strength, clip_strength) tuples
    nodes["20"] = {
      class_type: "CR LoRA Stack",
      inputs: {
        switch_1: "On",
        lora_name_1: enabledLoras[0].name.replace(/\//g, "\\"),
        model_weight_1: enabledLoras[0].strengthModel,
        clip_weight_1: enabledLoras[0].strengthClip ?? 1.0,
        switch_2: enabledLoras.length > 1 ? "On" : "Off",
        lora_name_2: enabledLoras.length > 1 ? enabledLoras[1].name.replace(/\//g, "\\") : "None",
        model_weight_2: enabledLoras.length > 1 ? enabledLoras[1].strengthModel : 1.0,
        clip_weight_2: enabledLoras.length > 1 ? (enabledLoras[1].strengthClip ?? 1.0) : 1.0,
        switch_3: enabledLoras.length > 2 ? "On" : "Off",
        lora_name_3: enabledLoras.length > 2 ? enabledLoras[2].name.replace(/\//g, "\\") : "None",
        model_weight_3: enabledLoras.length > 2 ? enabledLoras[2].strengthModel : 1.0,
        clip_weight_3: enabledLoras.length > 2 ? (enabledLoras[2].strengthClip ?? 1.0) : 1.0,
      },
    };
  }

  return nodes;
}
