import type { GenerationParams, GenerationMode, LTX2Config } from "./types";

// ── VRAM estimation for pre-render OOM prediction ──
// Uses empirical profiles per generation mode to estimate peak VRAM usage.
// Each profile defines a base overhead (model weights, text encoders, framework)
// and a scaling component proportional to the pixel-frame budget (W × H × frames).
// The scaling is normalized against a known-working reference configuration.

export interface VramEstimate {
  estimatedPeakGB: number;
  totalVramGB: number;
  risk: "safe" | "warning" | "danger";
  message: string;
  suggestion: string | null;
}

interface VramProfile {
  label: string;
  baseGB: number;           // fixed overhead: model weights + text encoder + framework
  scalingGB: number;         // additional VRAM at the reference pixel-frame budget
  refPixelFrames: number;    // W × H × F of a known-working configuration
  addonGB?: number;          // optional per-feature addon (e.g. FaceID)
}

// Empirical profiles based on ComfyUI with --fast, fp8/GGUF models, async offloading
// Tested on RTX 5070 Ti (16 GB), RTX 3090 (24 GB), RTX 4060 Ti (16 GB)
const PROFILES: Record<string, VramProfile> = {
  // Wan 2.1 I2V 14B: fp8 quantized UNet + fp8 text encoder, async offloading
  wan_i2v: {
    label: "Wan I2V 14B",
    baseGB: 6.0,
    scalingGB: 9.0,
    refPixelFrames: 832 * 480 * 81,  // known-working on 16 GB
  },
  // Wan 2.1 T2V 1.3B: fp16 UNet, much lighter
  wan_t2v: {
    label: "Wan T2V 1.3B",
    baseGB: 4.0,
    scalingGB: 5.0,
    refPixelFrames: 832 * 480 * 33,
  },
  // Wan Remix GGUF: Q4_K_M quantized, two-pass (each pass loads one model)
  wan_remix: {
    label: "Wan Remix GGUF",
    baseGB: 6.0,
    scalingGB: 9.0,
    refPixelFrames: 704 * 1024 * 113,  // default Remix config
  },
  // SD1.5 + AnimateDiff video
  sd15_video: {
    label: "SD1.5 Video",
    baseGB: 3.5,
    scalingGB: 2.5,
    refPixelFrames: 512 * 512 * 16,
    addonGB: 1.5,  // FaceID / IP-Adapter
  },
  // SD1.5 still image (1 frame)
  sd15_image: {
    label: "SD1.5 Image",
    baseGB: 3.0,
    scalingGB: 1.5,
    refPixelFrames: 1024 * 1024 * 1,
    addonGB: 1.5,
  },
  // Compose modes share SD1.5 profile but with context-aware overhead
  compose_video: {
    label: "Compose Video",
    baseGB: 4.0,
    scalingGB: 2.5,
    refPixelFrames: 512 * 512 * 16,
    addonGB: 1.5,
  },
  compose_image: {
    label: "Compose Image",
    baseGB: 3.5,
    scalingGB: 1.5,
    refPixelFrames: 1024 * 1024 * 1,
    addonGB: 1.5,
  },
};

function getProfile(
  mode: GenerationMode,
  params: GenerationParams
): VramProfile {
  if (mode === "wan") {
    return params.sourceImage ? PROFILES.wan_i2v : PROFILES.wan_t2v;
  }
  if (mode === "wan_remix") return PROFILES.wan_remix;
  if (mode === "compose") {
    return params.composeOutputType === "image"
      ? PROFILES.compose_image
      : PROFILES.compose_video;
  }
  if (mode === "image") return PROFILES.sd15_image;
  return PROFILES.sd15_video; // "video" or fallback
}

function getFrameCount(mode: GenerationMode, params: GenerationParams): number {
  if (mode === "image") return 1;
  if (mode === "compose" && params.composeOutputType === "image") return 1;
  return params.frames;
}

function hasAddon(_mode: GenerationMode, _params: GenerationParams): boolean {
  // No optional VRAM-heavy addons currently (FaceID/IP-Adapter removed).
  return false;
}

export function estimateVram(
  mode: GenerationMode,
  params: GenerationParams,
  totalVramMB: number
): VramEstimate {
  const profile = getProfile(mode, params);
  const frames = getFrameCount(mode, params);
  const pixelFrames = params.width * params.height * frames;
  const totalVramGB = totalVramMB / 1024;

  // Linear scaling from reference configuration
  const ratio = pixelFrames / profile.refPixelFrames;
  let estimated = profile.baseGB + profile.scalingGB * ratio;

  // Add feature overhead (FaceID, etc.)
  if (hasAddon(mode, params) && profile.addonGB) {
    estimated += profile.addonGB;
  }

  // Storyboard multi-segment adds overhead (context images held in VRAM)
  if (mode === "wan_remix" && params.storyboardSegments.length >= 2) {
    estimated += 0.5 * params.storyboardSegments.length;
  }

  // Round to 1 decimal
  estimated = Math.round(estimated * 10) / 10;

  // Risk assessment
  const utilizationPct = (estimated / totalVramGB) * 100;
  let risk: VramEstimate["risk"];
  let message: string;
  let suggestion: string | null = null;

  if (utilizationPct <= 85) {
    risk = "safe";
    message = `Estimated peak VRAM: ${estimated.toFixed(1)} GB / ${totalVramGB.toFixed(1)} GB (${utilizationPct.toFixed(0)}%)`;
  } else if (utilizationPct <= 100) {
    risk = "warning";
    message = `Estimated peak VRAM: ${estimated.toFixed(1)} GB / ${totalVramGB.toFixed(1)} GB (${utilizationPct.toFixed(0)}%), may run out of memory`;
    suggestion = buildSuggestion(mode, params, frames, totalVramGB, profile);
  } else {
    risk = "danger";
    message = `Estimated peak VRAM: ${estimated.toFixed(1)} GB / ${totalVramGB.toFixed(1)} GB (${utilizationPct.toFixed(0)}%), very likely to OOM`;
    suggestion = buildSuggestion(mode, params, frames, totalVramGB, profile);
  }

  return { estimatedPeakGB: estimated, totalVramGB, risk, message, suggestion };
}

function buildSuggestion(
  mode: GenerationMode,
  params: GenerationParams,
  frames: number,
  totalVramGB: number,
  profile: VramProfile
): string {
  const parts: string[] = [];

  // Calculate safe pixel-frame budget: solve for ratio where estimated = 85% of VRAM
  const safeVram = totalVramGB * 0.85;
  const addonCost = hasAddon(mode, params) && profile.addonGB ? profile.addonGB : 0;
  const safeScaling = safeVram - profile.baseGB - addonCost;
  const safeRatio = Math.max(0, safeScaling / profile.scalingGB);
  const safePixelFrames = Math.floor(safeRatio * profile.refPixelFrames);

  if (frames > 1) {
    // Video mode: suggest reducing frames or resolution
    const safeFrames = Math.max(1, Math.floor(safePixelFrames / (params.width * params.height)));
    if (safeFrames < frames) {
      parts.push(`reduce frames to ~${safeFrames}`);
    }

    const safePixels = Math.floor(safePixelFrames / frames);
    const safeHeight = Math.floor(Math.sqrt(safePixels * (params.height / params.width)) / 16) * 16;
    const safeWidth = Math.floor((safeHeight * params.width / params.height) / 16) * 16;
    if (safeWidth < params.width || safeHeight < params.height) {
      parts.push(`or lower resolution to ~${safeWidth}x${safeHeight}`);
    }
  } else {
    // Image mode: suggest reducing resolution
    const safePixels = safePixelFrames;
    const safeHeight = Math.floor(Math.sqrt(safePixels * (params.height / params.width)) / 16) * 16;
    const safeWidth = Math.floor((safeHeight * params.width / params.height) / 16) * 16;
    if (safeWidth < params.width || safeHeight < params.height) {
      parts.push(`lower resolution to ~${safeWidth}x${safeHeight}`);
    }
  }

  if (parts.length === 0) {
    return "Close other GPU-using applications to free VRAM.";
  }
  return `Try: ${parts.join(" ")}`;
}

// Fetch current total VRAM from the system-stats endpoint
export async function fetchTotalVramMB(): Promise<number | null> {
  try {
    const res = await fetch("/api/system-stats", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.gpu?.memTotalMB ?? null;
  } catch {
    return null;
  }
}

export interface VramSnapshot {
  totalMB: number;
  usedMB: number;
  freeMB: number;
}

/**
 * Live VRAM occupancy. Unlike `estimateVram()` (which predicts a peak from parameters), this
 * reports what the GPU is ACTUALLY holding right now, which is what a mid-pipeline decision
 * needs, since it must account for whatever model the previous stage left resident.
 *
 * Returns null if stats are unavailable; callers must decide their own fallback rather than
 * assuming a value.
 */
export async function fetchVramSnapshot(): Promise<VramSnapshot | null> {
  try {
    const res = await fetch("/api/system-stats", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    const totalMB = data?.gpu?.memTotalMB;
    const usedMB = data?.gpu?.memUsedMB;
    if (typeof totalMB !== "number" || typeof usedMB !== "number") return null;
    return { totalMB, usedMB, freeMB: Math.max(0, totalMB - usedMB) };
  } catch {
    return null;
  }
}

// ── LTX-2 specific VRAM + render time estimation ──
// Uses latent-token-based scaling instead of raw pixels.
// With DynamicVRAM (comfy-aimdo), ComfyUI streams model weights to/from
// system RAM rather than OOMing, so the real question is speed impact,
// not whether the generation will fail.

export interface LTX2VramEstimate extends VramEstimate {
  estimatedRenderTimeSec: number | null; // null if can't estimate
  renderTimeLabel: string;
  pixelFrameBudget: number;
}

// Reference config: 768×512 × 97 frames (distilled, 8 steps) on RTX 5070 Ti 16 GB
// Latent shape: [1, 128, 13, 16, 24] → 4992 tokens
// Observed peak VRAM: ~12 GB, render time: ~45s
const LTX2_REF_TOKENS = 4992;
const LTX2_REF_TOKEN_STEPS = 4992 * 8; // 39936
const LTX2_REF_RENDER_SEC = 45;

// VRAM model: constant base (model weights) + sub-linear scaling with latent tokens.
// Model weights (FP8 diffusion + framework) ≈ 8 GB constant during sampling.
// Latent/activation overhead grows sub-linearly due to VAE tiling + chunked feedforward.
const LTX2_BASE_GB = 8.0;
const LTX2_SCALING_GB = 4.0; // additional GB at reference token count (sqrt-scaled)
const LTX2_AUDIO_GB = 1.5;   // audio VAE + audio attention overhead

function getLtx2LatentTokens(config: LTX2Config): number {
  const latentT = Math.floor((config.numFrames - 1) / 8) + 1;
  const latentH = Math.floor(config.height / 32);
  const latentW = Math.floor(config.width / 32);
  return latentT * latentH * latentW;
}

function getLtx2Steps(config: LTX2Config): number {
  const tier = config.qualityTier || "distilled";
  return tier === "full" ? 15 : tier === "test" ? 3 : 8;
}

export function estimateLtx2Vram(
  config: LTX2Config,
  totalVramMB: number
): LTX2VramEstimate {
  const totalVramGB = totalVramMB / 1024;
  const tokens = getLtx2LatentTokens(config);
  const pixelFrames = config.width * config.height * config.numFrames;

  // VRAM: base + sub-linear (sqrt) scaling with latent token ratio
  const tokenRatio = tokens / LTX2_REF_TOKENS;
  let estimated = LTX2_BASE_GB + LTX2_SCALING_GB * Math.sqrt(tokenRatio);

  if (config.enableAudio) estimated += LTX2_AUDIO_GB;
  if (config.sourceImage) estimated += 0.3;

  estimated = Math.round(estimated * 10) / 10;

  // Risk assessment: DynamicVRAM handles slight overflow seamlessly
  const utilizationPct = (estimated / totalVramGB) * 100;
  let risk: VramEstimate["risk"];
  let message: string;
  let suggestion: string | null = null;

  if (utilizationPct <= 85) {
    risk = "safe";
    message = `~${estimated.toFixed(1)} GB / ${totalVramGB.toFixed(1)} GB (${utilizationPct.toFixed(0)}%)`;
  } else if (utilizationPct <= 110) {
    risk = "warning";
    message = `~${estimated.toFixed(1)} GB / ${totalVramGB.toFixed(1)} GB (${utilizationPct.toFixed(0)}%), tight, may stream to RAM`;
    suggestion = buildLtx2Suggestion(config, totalVramGB, tokens);
  } else {
    risk = "danger";
    message = `~${estimated.toFixed(1)} GB / ${totalVramGB.toFixed(1)} GB (${utilizationPct.toFixed(0)}%), will stream to RAM, slower`;
    suggestion = buildLtx2Suggestion(config, totalVramGB, tokens);
  }

  // Render time: linear with latent tokens × steps (compute IS proportional)
  const steps = getLtx2Steps(config);
  const tokenSteps = tokens * steps;
  let estimatedRenderTimeSec: number | null = Math.round(
    (tokenSteps / LTX2_REF_TOKEN_STEPS) * LTX2_REF_RENDER_SEC
  );

  // Streaming penalty: DynamicVRAM prevents OOM, just adds overhead
  // Penalty capped at 2.5x; real-world overhead is modest with PCIe 4.0/5.0
  if (utilizationPct > 110) {
    const overflowPct = utilizationPct - 100;
    const penalty = Math.min(2.5, 1 + overflowPct / 150);
    estimatedRenderTimeSec = Math.round(estimatedRenderTimeSec * penalty);
  } else if (utilizationPct > 85) {
    estimatedRenderTimeSec = Math.round(estimatedRenderTimeSec * 1.15);
  }

  // Audio generation adds ~30% overhead
  if (config.enableAudio) {
    estimatedRenderTimeSec = Math.round(estimatedRenderTimeSec * 1.3);
  }

  let renderTimeLabel: string;
  if (estimatedRenderTimeSec < 60) {
    renderTimeLabel = `~${estimatedRenderTimeSec}s`;
  } else {
    const mins = Math.floor(estimatedRenderTimeSec / 60);
    const secs = estimatedRenderTimeSec % 60;
    renderTimeLabel = secs > 0 ? `~${mins}m ${secs}s` : `~${mins}m`;
  }

  return {
    estimatedPeakGB: estimated,
    totalVramGB,
    risk,
    message,
    suggestion,
    estimatedRenderTimeSec,
    renderTimeLabel,
    pixelFrameBudget: pixelFrames,
  };
}

function buildLtx2Suggestion(
  config: LTX2Config,
  totalVramGB: number,
  currentTokens: number
): string {
  const parts: string[] = [];
  const audioCost = config.enableAudio ? LTX2_AUDIO_GB : 0;
  const i2vCost = config.sourceImage ? 0.3 : 0;

  // Solve for safe token count: base + scaling * sqrt(tokens/ref) + addons <= 85% vram
  const safeVram = totalVramGB * 0.85;
  const available = safeVram - LTX2_BASE_GB - audioCost - i2vCost;
  // scaling * sqrt(tokens/ref) <= available → tokens <= ref * (available/scaling)²
  const safeRatioSqrt = Math.max(0, available / LTX2_SCALING_GB);
  const safeTokens = Math.floor(safeRatioSqrt * safeRatioSqrt * LTX2_REF_TOKENS);

  if (safeTokens < currentTokens) {
    // Suggest reducing frames (in latent space, snap to 8n+1 pixel frames)
    const latentH = Math.floor(config.height / 32);
    const latentW = Math.floor(config.width / 32);
    const safeLatentT = Math.max(1, Math.floor(safeTokens / (latentH * latentW)));
    const safeFrames = Math.max(25, (safeLatentT - 1) * 8 + 1);
    if (safeFrames < config.numFrames) {
      const snapped = Math.floor((safeFrames - 1) / 8) * 8 + 1;
      parts.push(`reduce frames to ~${snapped}`);
    }

    // Suggest reducing resolution (in latent space, snap to ×32 pixel dims)
    const latentT = Math.floor((config.numFrames - 1) / 8) + 1;
    const safeHW = Math.floor(safeTokens / latentT);
    const aspectRatio = config.width / config.height;
    const safeLatentH = Math.max(1, Math.floor(Math.sqrt(safeHW / aspectRatio)));
    const safeLatentW = Math.max(1, Math.floor(safeLatentH * aspectRatio));
    const safeW = safeLatentW * 32;
    const safeH = safeLatentH * 32;
    if (safeW < config.width || safeH < config.height) {
      parts.push(`or lower resolution to ~${safeW}×${safeH}`);
    }
  }

  if (config.enableAudio) {
    parts.push("or disable audio");
  }

  return parts.length > 0 ? `Try: ${parts.join(" ")}` : "Close other GPU-using apps to free VRAM.";
}
