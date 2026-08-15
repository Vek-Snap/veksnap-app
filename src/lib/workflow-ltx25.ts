import { LTX2Config, LTX25_MODEL_DEFAULTS } from "./types";

// Exact distilled sigma schedules from the official v0.32.0 template (video_ltx2_5_t2v):
//   stage-1 (#404, empty latents) = long 8-step; stage-2 (#395, upscaled) = short 3-step refine.
const LTX25_STAGE1_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
const LTX25_STAGE2_SIGMAS = "0.85, 0.7250, 0.4219, 0.0";

/**
 * LTX-2.5 workflow builder: mirrors the official ComfyUI template
 * (comfyui-workflow-templates: video_ltx2_5_{t2v,i2v}).
 *
 * Two-stage distilled audio+video pipeline:
 *   stage-1 (half-res) latents → SamplerCustomAdvanced (base sigmas)
 *   → LTXVLatentUpsampler (2×) → stage-2 (full-res, refine sigmas)
 *   → tiled video decode + audio VAE decode → VHS_VideoCombine.
 *
 * The 2.5 topology differs enough from 2.3 that it lives in its own builder rather than
 * branching the large 2.3 emitter. T2V and I2V are wired here; FLF2V (both sourceImage +
 * sourceImageLast) delegates to buildLTX25FLF2VWorkflow: a distinct single-stage guide graph.
 * Optional Auto Duration (LTXVDurationPredictor) can predict num_frames from the prompt.
 */
export function buildLTX25Workflow(
  config: LTX2Config,
  seed: number,
): Record<string, unknown> {
  // FLF2V (first + last frame) uses the official single-stage guide graph, not the
  // two-stage T2V/I2V topology: delegate when both endpoints are supplied.
  if (config.sourceImage && config.sourceImageLast) return buildLTX25FLF2VWorkflow(config, seed);

  const nodes: Record<string, unknown> = {};
  const s32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);

  // Model files: fall back to the official 2.5 defaults when a field is unset.
  const diffusionModel = config.diffusionModel || LTX25_MODEL_DEFAULTS.diffusionModel;
  const textEncoder = config.textEncoder || LTX25_MODEL_DEFAULTS.textEncoder;
  const videoVae = config.videoVae || LTX25_MODEL_DEFAULTS.videoVae;
  const audioVae = config.audioVae || LTX25_MODEL_DEFAULTS.audioVae;
  const spatialUpscaler = config.spatialUpscaler || LTX25_MODEL_DEFAULTS.spatialUpscaler;
  const auxEncoder = config.textEncoderAux || LTX25_MODEL_DEFAULTS.textEncoderAux;

  const hasSourceImage = !!config.sourceImage;
  const enhance = !!config.promptEnhance;
  const wantAudio = config.enableAudio !== false;

  // Geometry: final target (÷32) + half-res stage-1 latent (÷32); the upsampler doubles it.
  const targetW = s32(config.width);
  const targetH = s32(config.height);
  const stageW = s32(targetW / 2);
  const stageH = s32(targetH / 2);
  const length = config.numFrames; // caller guarantees length % 8 == 1
  const fps = config.frameRate;

  // Distilled sigma schedules. Stage-1 uses the LONG schedule; stage-2 (refine) the SHORT one.
  // At the proven defaults (8 base / 3 refine) we emit the exact template strings; any other
  // step count generates a linear schedule down to 0 (experimental).
  const linSigmas = (start: number, steps: number): string => {
    const n = Math.max(1, Math.round(steps));
    return Array.from({ length: n + 1 }, (_, i) =>
      (i === n ? 0 : start * (1 - i / n)).toFixed(4),
    ).join(", ");
  };
  const baseSteps = config.ltx25BaseSteps ?? 8;
  const refineSteps = config.ltx25RefineSteps ?? 3;
  const STAGE1_SIGMAS = baseSteps === 8 ? LTX25_STAGE1_SIGMAS : linSigmas(1.0, baseSteps);
  const STAGE2_SIGMAS = refineSteps === 3 ? LTX25_STAGE2_SIGMAS : linSigmas(0.85, refineSteps);
  const samplerName = config.ltx25Sampler || "euler_ancestral";
  const videoCfg = config.ltx25VideoCfg ?? 1;
  const audioCfg = config.ltx25AudioCfg ?? 1;

  // ── Loaders ──
  nodes["10"] = { class_type: "UNETLoader", inputs: { unet_name: diffusionModel, weight_dtype: "default" } };
  nodes["11"] = { class_type: "CLIPLoader", inputs: { clip_name: textEncoder, type: "ltxv", device: "default" } };
  nodes["13"] = { class_type: "VAELoader", inputs: { vae_name: videoVae } };
  nodes["14"] = { class_type: "VAELoader", inputs: { vae_name: audioVae } };
  nodes["15"] = { class_type: "LatentUpscaleModelLoader", inputs: { model_name: spatialUpscaler } };

  // ── User LoRAs (model-only, stacked after the DiT). The 2.5 transformer is pre-distilled,
  // so NO distill LoRA is applied (unlike the 2.3 builder). LTX-2.3 LoRAs can be stacked here
  // to experiment, but shape/key mismatches against the 2.5 transformer will be logged by
  // ComfyUI and simply skipped rather than applied. ──
  let modelRef: [string, number] = ["10", 0];
  const enabledLoras = (config.userLoras || []).filter((l) => l.enabled && l.name);
  enabledLoras.forEach((lora, i) => {
    const id = String(70 + i);
    nodes[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: modelRef, lora_name: lora.name.replace(/\//g, "\\"), strength_model: lora.strengthModel },
    };
    modelRef = [id, 0];
  });

  // ── I2V: load + preprocess the source image (reused by both stages + the enhancer) ──
  if (hasSourceImage) {
    nodes["29"] = { class_type: "LoadImage", inputs: { image: config.sourceImage } };
    nodes["30"] = { class_type: "LTXVPreprocess", inputs: { image: ["29", 0], img_compression: config.imgCompression || 18 } };
  }

  // ── Prompt path: raw prompt, or the LTX-2.5 prompt enhancer (needs the aux e2b encoder) ──
  let posText: unknown = config.prompt;
  if (enhance) {
    nodes["12"] = { class_type: "CLIPLoader", inputs: { clip_name: auxEncoder, type: "ltxv", device: "default" } };
    const enh: Record<string, unknown> = { clip: ["12", 0], prompt: config.prompt, max_length: 512, sampling_mode: "on" };
    if (hasSourceImage) enh.image = ["30", 0];
    nodes["20"] = { class_type: "TextGenerateLTX2Prompt", inputs: enh };
    posText = ["20", 0];
  }
  nodes["21"] = { class_type: "CLIPTextEncode", inputs: { text: posText, clip: ["11", 0] } };
  const negText = config.negativePrompt && config.negativePrompt.trim()
    ? config.negativePrompt
    : "pc game, console game, video game, cartoon, childish, ugly";
  nodes["22"] = { class_type: "CLIPTextEncode", inputs: { text: negText, clip: ["11", 0] } };
  nodes["23"] = { class_type: "LTXVConditioning", inputs: { positive: ["21", 0], negative: ["22", 0], frame_rate: fps } };

  // ── Shared sampler pieces (distilled: CFG=1, euler_ancestral by default) ──
  nodes["24"] = { class_type: "LTXVDualCFGGuider", inputs: { model: modelRef, positive: ["23", 0], negative: ["23", 1], video_cfg: videoCfg, audio_cfg: audioCfg } };
  nodes["25"] = { class_type: "KSamplerSelect", inputs: { sampler_name: samplerName } };
  nodes["26"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };

  // ── Auto Duration (optional): LTXVDurationPredictor estimates the optimal frame count from
  //    the positive conditioning + a duration-head model_patch. When ON, its num_frames output
  //    drives BOTH empty latents, overriding config.numFrames. Requires the duration-head file. ──
  let lengthInput: number | [string, number] = length;
  if (config.ltx25AutoDuration) {
    const durationHead = config.durationHead || LTX25_MODEL_DEFAULTS.durationHead;
    nodes["16"] = { class_type: "ModelPatchLoader", inputs: { name: durationHead } };
    nodes["17"] = {
      class_type: "LTXVDurationPredictor",
      inputs: {
        model: modelRef,
        positive: ["21", 0],
        duration_head: ["16", 0],
        frame_rate: fps,
        min_seconds: config.ltx25AutoDurationMin ?? 1,
        max_seconds: config.ltx25AutoDurationMax ?? 20,
      },
    };
    lengthInput = ["17", 0]; // num_frames (output 0)
  }

  // ── Stage-1 latents (half-res) ──
  nodes["28"] = { class_type: "EmptyLTXVLatentVideo", inputs: { width: stageW, height: stageH, length: lengthInput, batch_size: 1 } };
  nodes["31"] = { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: lengthInput, frame_rate: fps, batch_size: 1, audio_vae: ["14", 0] } };

  let stage1Video: [string, number] = ["28", 0];
  if (hasSourceImage) {
    nodes["32"] = { class_type: "LTXVImgToVideoInplace", inputs: { vae: ["13", 0], image: ["30", 0], latent: ["28", 0], strength: 0.7, bypass: false } };
    stage1Video = ["32", 0];
  }

  nodes["33"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: stage1Video, audio_latent: ["31", 0] } };
  nodes["35"] = { class_type: "ManualSigmas", inputs: { sigmas: STAGE1_SIGMAS } };
  nodes["34"] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["26", 0], guider: ["24", 0], sampler: ["25", 0], sigmas: ["35", 0], latent_image: ["33", 0] } };
  nodes["36"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["34", 0] } };

  // ── Latent 2× upsample (video only), then re-inject image for I2V ──
  nodes["40"] = { class_type: "LTXVLatentUpsampler", inputs: { samples: ["36", 0], upscale_model: ["15", 0], vae: ["13", 0] } };
  let stage2Video: [string, number] = ["40", 0];
  if (hasSourceImage) {
    nodes["41"] = { class_type: "LTXVImgToVideoInplace", inputs: { vae: ["13", 0], image: ["30", 0], latent: ["40", 0], strength: 1.0, bypass: false } };
    stage2Video = ["41", 0];
  }

  // ── Stage-2 (full-res, refine) ──
  nodes["42"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: stage2Video, audio_latent: ["36", 1] } };
  nodes["43"] = { class_type: "ManualSigmas", inputs: { sigmas: STAGE2_SIGMAS } };
  nodes["44"] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["26", 0], guider: ["24", 0], sampler: ["25", 0], sigmas: ["43", 0], latent_image: ["42", 0] } };
  nodes["45"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["44", 0] } };

  // ── Decode video (tiled) ──
  nodes["50"] = {
    class_type: "VAEDecodeTiled",
    inputs: {
      samples: ["45", 0],
      vae: ["13", 0],
      tile_size: config.vaeTileSize || 768,
      overlap: config.vaeOverlap || 64,
      temporal_size: config.vaeTemporalSize || 4096,
      temporal_overlap: config.vaeTemporalOverlap || 32,
    },
  };

  // ── Output: VHS_VideoCombine (app-consistent mp4; template uses CreateVideo→SaveVideo) ──
  const combine: Record<string, unknown> = {
    images: ["50", 0],
    frame_rate: fps,
    loop_count: 0,
    filename_prefix: "ltx2_5/VekSnap_LTX25",
    format: "video/h264-mp4",
    pix_fmt: "yuv420p",
    save_output: true,
    pingpong: false,
  };
  if (wantAudio) {
    nodes["51"] = { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["45", 1], audio_vae: ["14", 0] } };
    combine.audio = ["51", 0];
  }
  nodes["60"] = { class_type: "VHS_VideoCombine", inputs: combine };

  return nodes;
}

/**
 * LTX-2.5 First + Last Frame → Video (FLF2V). A DISTINCT single-stage guide-based graph from the
 * official template (`video_ltx2_5_flf2v`), NOT the two-stage T2V/I2V topology:
 *   both endpoints are injected as `LTXVAddGuide` anchors (first @ frame 0, last @ frame -1, both
 *   strength 0.7) into a full-res empty AV latent → single `SamplerCustomAdvanced` pass
 *   (8-step distilled schedule, `SamplerEulerAncestral` eta=0) → `LTXVCropGuides` removes the guide
 *   frames → tiled video + audio VAE decode. NO latent upscaler and NO refine pass.
 *
 * NOTE (pre-GPU): `SamplerEulerAncestral` (eta/s_noise) and `LTXVAddGuide` (frame_idx/strength)
 * input-key names are taken from the template + the existing 2.3 usage; confirm against a live
 * `/object_info` on the 2.5 environment before shipping.
 */
export function buildLTX25FLF2VWorkflow(
  config: LTX2Config,
  seed: number,
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const s32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);

  const diffusionModel = config.diffusionModel || LTX25_MODEL_DEFAULTS.diffusionModel;
  const textEncoder = config.textEncoder || LTX25_MODEL_DEFAULTS.textEncoder;
  const videoVae = config.videoVae || LTX25_MODEL_DEFAULTS.videoVae;
  const audioVae = config.audioVae || LTX25_MODEL_DEFAULTS.audioVae;
  const auxEncoder = config.textEncoderAux || LTX25_MODEL_DEFAULTS.textEncoderAux;

  const enhance = !!config.promptEnhance;
  const wantAudio = config.enableAudio !== false;
  const targetW = s32(config.width);
  const targetH = s32(config.height);
  const length = config.numFrames;
  const fps = config.frameRate;

  const baseSteps = config.ltx25BaseSteps ?? 8;
  const sigmas = baseSteps === 8
    ? LTX25_STAGE1_SIGMAS
    : Array.from({ length: baseSteps + 1 }, (_, i) => (i === baseSteps ? 0 : 1.0 * (1 - i / baseSteps)).toFixed(4)).join(", ");
  const videoCfg = config.ltx25VideoCfg ?? 1;
  const audioCfg = config.ltx25AudioCfg ?? 1;

  // ── Loaders (no LatentUpscaleModelLoader: FLF2V has no upscale stage) ──
  nodes["10"] = { class_type: "UNETLoader", inputs: { unet_name: diffusionModel, weight_dtype: "default" } };
  nodes["11"] = { class_type: "CLIPLoader", inputs: { clip_name: textEncoder, type: "ltxv", device: "default" } };
  nodes["13"] = { class_type: "VAELoader", inputs: { vae_name: videoVae } };
  nodes["14"] = { class_type: "VAELoader", inputs: { vae_name: audioVae } };

  let modelRef: [string, number] = ["10", 0];
  const enabledLoras = (config.userLoras || []).filter((l) => l.enabled && l.name);
  enabledLoras.forEach((lora, i) => {
    const id = String(70 + i);
    nodes[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: modelRef, lora_name: lora.name.replace(/\//g, "\\"), strength_model: lora.strengthModel } };
    modelRef = [id, 0];
  });

  nodes["29"] = { class_type: "LoadImage", inputs: { image: config.sourceImage } };
  nodes["30"] = { class_type: "LTXVPreprocess", inputs: { image: ["29", 0], img_compression: config.imgCompression || 18 } };
  nodes["37"] = { class_type: "LoadImage", inputs: { image: config.sourceImageLast } };
  nodes["38"] = { class_type: "LTXVPreprocess", inputs: { image: ["37", 0], img_compression: config.imgCompression || 18 } };

  let posText: unknown = config.prompt;
  if (enhance) {
    nodes["12"] = { class_type: "CLIPLoader", inputs: { clip_name: auxEncoder, type: "ltxv", device: "default" } };
    nodes["20"] = { class_type: "TextGenerateLTX2Prompt", inputs: { clip: ["12", 0], prompt: config.prompt, image: ["30", 0], max_length: 512, sampling_mode: "on" } };
    posText = ["20", 0];
  }
  nodes["21"] = { class_type: "CLIPTextEncode", inputs: { text: posText, clip: ["11", 0] } };
  const negText = config.negativePrompt && config.negativePrompt.trim()
    ? config.negativePrompt
    : "pc game, console game, video game, cartoon, childish, ugly";
  nodes["22"] = { class_type: "CLIPTextEncode", inputs: { text: negText, clip: ["11", 0] } };
  nodes["23"] = { class_type: "LTXVConditioning", inputs: { positive: ["21", 0], negative: ["22", 0], frame_rate: fps } };

  // ── Empty full-res AV latent ──
  nodes["28"] = { class_type: "EmptyLTXVLatentVideo", inputs: { width: targetW, height: targetH, length, batch_size: 1 } };
  nodes["31"] = { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: length, frame_rate: fps, batch_size: 1, audio_vae: ["14", 0] } };

  // ── Frame anchors: first @ idx 0, last @ idx -1 (both strength 0.7). LTXVAddGuide outputs
  //    [0]=positive, [1]=negative, [2]=latent; the last-frame guide chains from the first. ──
  nodes["61"] = { class_type: "LTXVAddGuide", inputs: { positive: ["23", 0], negative: ["23", 1], vae: ["13", 0], latent: ["28", 0], image: ["30", 0], frame_idx: 0, strength: 0.7 } };
  nodes["62"] = { class_type: "LTXVAddGuide", inputs: { positive: ["61", 0], negative: ["61", 1], vae: ["13", 0], latent: ["61", 2], image: ["38", 0], frame_idx: -1, strength: 0.7 } };

  nodes["33"] = { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["62", 2], audio_latent: ["31", 0] } };

  // ── Single-stage sampling (SamplerEulerAncestral eta=0 per template) ──
  nodes["24"] = { class_type: "LTXVDualCFGGuider", inputs: { model: modelRef, positive: ["62", 0], negative: ["62", 1], video_cfg: videoCfg, audio_cfg: audioCfg } };
  nodes["25"] = { class_type: "SamplerEulerAncestral", inputs: { eta: 0, s_noise: 1 } };
  nodes["26"] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
  nodes["35"] = { class_type: "ManualSigmas", inputs: { sigmas } };
  nodes["34"] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["26", 0], guider: ["24", 0], sampler: ["25", 0], sigmas: ["35", 0], latent_image: ["33", 0] } };

  // ── Separate AV (flf2v uses the sampler's denoised output, index 1), crop guide frames, decode. ──
  nodes["36"] = { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["34", 1] } };
  nodes["55"] = { class_type: "LTXVCropGuides", inputs: { positive: ["62", 0], negative: ["62", 1], latent: ["36", 0] } };
  nodes["50"] = {
    class_type: "VAEDecodeTiled",
    inputs: {
      samples: ["55", 2],
      vae: ["13", 0],
      tile_size: config.vaeTileSize || 768,
      overlap: config.vaeOverlap || 64,
      temporal_size: config.vaeTemporalSize || 4096,
      temporal_overlap: config.vaeTemporalOverlap || 64,
    },
  };

  // ── Output: VHS_VideoCombine (app-consistent mp4) ──
  const combine: Record<string, unknown> = {
    images: ["50", 0],
    frame_rate: fps,
    loop_count: 0,
    filename_prefix: "ltx2_5/VekSnap_LTX25_flf2v",
    format: "video/h264-mp4",
    pix_fmt: "yuv420p",
    save_output: true,
    pingpong: false,
  };
  if (wantAudio) {
    nodes["51"] = { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["36", 1], audio_vae: ["14", 0] } };
    combine.audio = ["51", 0];
  }
  nodes["60"] = { class_type: "VHS_VideoCombine", inputs: combine };

  return nodes;
}
