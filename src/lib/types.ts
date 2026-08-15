export interface LoraEntry {
  enabled: boolean;
  name: string;           // filename, e.g. "my_lora.safetensors"
  strengthModel: number;  // model weight  -5 .. 5, default 1
  strengthClip: number;   // clip weight   -5 .. 5, default 1
  triggerWord?: string;   // User-defined trigger word for per-segment timeline chips (overrides LORA_TRIGGER_MAP)
  // Hook LoRA scheduling: controls LoRA strength across denoising steps (sampling steps).
  // When enabled, the LoRA is loaded as a Hook instead of standard LoraLoaderModelOnly,
  // allowing its influence to ramp up/down during the diffusion process.
  // Use case: keep LoRA off during early steps (composition) then ramp on for style (late steps).
  scheduled?: boolean;              // Enable hook scheduling for this LoRA
  scheduleStartPercent?: number;    // Denoising step % where schedule begins (0.0 = start, default 0.0)
  scheduleEndPercent?: number;      // Denoising step % where schedule ends (1.0 = end, default 1.0)
  scheduleStrengthStart?: number;   // LoRA multiplier at scheduleStartPercent (default 0.0)
  scheduleStrengthEnd?: number;     // LoRA multiplier at scheduleEndPercent (default 1.0)
  scheduleKeyframes?: number;       // Number of interpolation keyframes (default 5)
  scheduleInterpolation?: "linear" | "ease_in" | "ease_out";  // Interpolation curve
}

// Timeline segment for Prompt Relay: defines per-segment prompt text and proportional time weight.
// The model's attention is masked so each segment's tokens only influence its time region.
export interface TimelineSegment {
  text: string;            // Segment prompt text (include LoRA trigger words here to activate in this segment)
  weight: number;          // Proportional time weight (relative to other segments, not absolute frames)
}

// Storyboard segment: each segment of a multi-segment extended video
export interface StoryboardSegment {
  prompt: string;                    // motion/scene description for this segment
  startImageFile: string | null;     // ComfyUI filename if user uploaded a start keyframe, null = inherit from previous
  endImageFile: string | null;       // ComfyUI filename if user uploaded an end keyframe, null = auto (last frame)
}

// Paired WAN LoRA: HIGH variant applied to pass-1 model, LOW variant to pass-2 model
export interface WanPairedLoraEntry {
  enabled: boolean;
  highName: string;       // filename for HIGH model lora (pass 1)
  lowName: string;        // filename for LOW model lora (pass 2)
  strength: number;       // shared strength for both, -5 .. 5, default 1
}

// Embedding (textual inversion) entry: selected embedding with target prompt assignment
export interface EmbeddingEntry {
  enabled: boolean;
  name: string;           // filename without extension, e.g. "EasyNegative"
  target: "positive" | "negative"; // which prompt to inject into
}

export type UpscaleMode = "off" | "fast" | "quality";

export interface GenerationParams {
  checkpoint: string;
  // Actual checkpoint file size in bytes, when known. Used for RELIABLE SDXL vs SD1.5
  // arch detection (filenames are unreliable), e.g. picking the matching BrushNet weight.
  checkpointSizeBytes?: number;
  motionModule: string;
  positivePrompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  randomSeed: boolean;
  denoise: number;
  sourceImage: string | null; // filename after upload - used for I2V (image-to-video)
  regionInfo: RegionInfo | null; // compose mode region info for compositing back
  contentAware: boolean; // compose: feed surrounding context to model via masked inpainting
  contextPadding: number; // 0.0–1.0 fraction of region size added as context on each side
  clipSkip: number; // CLIP skip layers (1 = no skip, 2 = skip last layer, etc.)
  loras: LoraEntry[];
  embeddings: EmbeddingEntry[]; // selected textual inversions with pos/neg assignment
  wanModel: string; // selected Wan T2V diffusion model filename
  composeOutputType: ComposeOutputType; // Re-Imagine: still image or animated video
  // WAN 2.2 Story two-pass params
  wanRemixHighModel: string;
  wanRemixLowModel: string;
  wanRemixShift: number; // ModelSamplingSD3 shift value
  wanRemixPass1Steps: number; // steps for high-Q first pass
  wanRemixTotalSteps: number; // total steps (pass2 picks up where pass1 left off)
  wanPairedLoras: WanPairedLoraEntry[]; // paired HIGH/LOW loras for two-pass pipeline
  wanRemixEndImage: string;     // optional end-frame image for single-segment I2V (guides motion toward target)
  segmentColorCorrection: number; // 0=off, 0.10-0.20=subtle, histogram-match last frame to source (prevents cumulative drift)
  // WAN 2.2 SVI mode params
  wanSviMode: boolean;                    // SVI mode: use SVI models + SVI LoRAs
  wanSviLoraStrength: number;             // SVI PRO LoRA strength (default 1.0)
  wanSviLightningEnabled: boolean;        // Enable Lightning LoRAs for 4-step speed
  wanSviLightningCombo: number;           // Index into WAN_SVI_LIGHTNING_COMBOS (0/1/2)
  wanSviTripleKSampler: boolean;          // 3-KSampler mode: extra clean first step without Lightning
  wanSviCleanStepCfg: number;              // CFG for clean first step in 3-KSampler (default 4.0)
  // Storyboard mode: multi-segment extended video generation
  storyboardSegments: StoryboardSegment[]; // per-segment config (empty = single segment using positivePrompt)
  // Foley audio generation (post-processing)
  foleyEnabled: boolean;
  foleyPrompt: string;
  foleyNegativePrompt: string;
  foleySteps: number;
  foleyCfg: number;
  foleySampler: string;
  // Outpainting (still-image expansion)
  outpaint: OutpaintConfig;
  outpaintInfo: OutpaintInfo | null;
  // HiRes Fix (two-pass upscale for still images)
  hiresEnabled: boolean;
  hiresScale: number;           // upscale factor (1.5, 2.0, etc.)
  hiresSteps: number;           // sampling steps for second pass
  hiresDenoise: number;         // denoise strength for second pass (0.3–0.7 typical)
  hiresUpscaleMethod: string;   // latent upscale method
  // Enhance Details (Vek-Snap style: real upscaler + img2img refinement)
  enhanceEnabled: boolean;
  enhanceUpscalerModel: string; // ESRGAN/RealESRGAN model filename in models/upscale_models/
  enhanceDenoise: number;       // low denoise for refinement pass (default: 0.382)
  enhanceSteps: number;         // sampling steps for refinement pass
  // Smart Upscale (standalone image upscaling, ESRGAN-based fast/quality routes)
  upscaleMode: UpscaleMode;          // off | fast | quality
  upscaleScale: number;              // target scale factor (1.5, 2.0, 4.0)
  upscaleModel: string;              // ESRGAN model for fast/quality routes
  upscaleDenoise: number;            // denoise for quality route (default: 0.382)
  upscaleSteps: number;              // steps for quality route
  // ADetailer / FaceDetailer (post-process face refinement)
  adetailerEnabled: boolean;
  adetailerDenoise: number;     // denoise for face inpaint pass
  adetailerCfg: number;         // CFG for face inpaint pass
  adetailerSteps: number;       // steps for face inpaint pass
  // Vek-Snap inpaint settings (used in compose/reimagine mode)
  inpaintMethod: InpaintMethod;           // default | detail | modify
  inpaintStrength: number;                // denoising strength (0.0–1.0, default 1.0)
  inpaintRespectiveField: number;         // area around mask to consider (0.0=only masked, 1.0=whole image, default 0.618)
  inpaintErodeDilate: number;             // mask erode (-64) or dilate (+64), default 0
  inpaintInvertMask: boolean;             // invert mask before processing
  inpaintDisableInitialLatent: boolean;   // if true, don't use filled content as starting latent
  inpaintAdditionalPrompt: string;        // extra prompt for inpaint (shown for detail/modify methods)
  dinoErodeDilate: number;                // GroundingDINO box erode/dilate (-64..64), default 0
  inpaintMaskGrow: number;                // VAEEncodeForInpaint grow_mask_by pixels (0–64, default 6)
  // Content-aware engine selection (Re-Image content-aware inpaint/overlay/combined + Outpaint)
  contentAwareEngine: ContentAwareEngine; // diffdiff (default, no downloads) | brushnet | powerpaint
  objectRemoval: boolean;                 // optimize for erasing subjects (empty-scene prompting; PowerPaint "object removal")
  brushnetScale: number;                  // BrushNet/PowerPaint conditioning scale (0.0–2.0, default 1.0)
  batchSize: number;                       // number of images to generate per run (still image modes)
  // ── Z-Image Turbo "Enhance Details" (prompt-guided detail restoration) ──
  // All optional; the builder resolves defaults from ZIMAGE_ENHANCE. Only meaningful with a source
  // image (zimage mode). ControlNet structure-lock requires a user-downloaded model_patch.
  zimageEnhanceDetails?: boolean;          // route to the detail-restoration graph
  zimageEnhanceAppendPrompt?: boolean;     // append the detail block to the user's own prompt
  zimageEnhanceControlNet?: boolean;       // structure lock via Z-Image Fun ControlNet
  zimageEnhanceControlNetModel?: string;   // model_patches/ filename (empty = not installed)
  zimageEnhanceControlNetType?: "canny" | "source"; // edge map, or the raw source as control
  zimageEnhanceControlNetStrength?: number;
  zimageEnhanceCannyLow?: number;
  zimageEnhanceCannyHigh?: number;
  // ── Z-Image Turbo "Face Repair" (Phase 2a: region-targeted semantic repair) ──
  // All optional; the builder resolves every default from ZIMAGE_FACE. Only meaningful with a
  // source image (zimage mode).
  zimageFaceRepair?: boolean;              // route to the FaceDetailer-based face-repair graph
  zimageFaceAppendPrompt?: boolean;        // append the user's prompt to the face-repair block
  zimageFaceDetector?: string;             // Ultralytics bbox model (default ZIMAGE_FACE.DETECTOR)
  zimageFaceDenoise?: number;              // restoration denoise (clamped to the repair window)
  zimageFaceSteps?: number;                // EFFECTIVE steps (schedule scaled internally)
  zimageFaceCfg?: number;                  // clamped to ZIMAGE_FACE.CFG_MAX
  zimageFaceGuideSize?: number;            // crop upscale target before sampling
  zimageFaceFeather?: number;              // composite blend at crop boundary (px)
  zimageFaceThreshold?: number;            // bbox detection confidence
  zimageFaceDilation?: number;             // grow detected box (px)
  zimageFaceCropFactor?: number;           // context around face fed to sampler
}

export const DEFAULT_PARAMS: GenerationParams = {
  checkpoint: "",
  motionModule: "",
  positivePrompt: "",
  negativePrompt: "",
  width: 1024,
  height: 1024,
  frames: 16,
  fps: 8,
  steps: 24,
  cfg: 3.5,
  sampler: "euler",
  scheduler: "simple",
  seed: -1,
  randomSeed: true,
  denoise: 1.0,
  sourceImage: null,
  regionInfo: null,
  contentAware: true,
  contextPadding: 0.35,
  clipSkip: 2,
  loras: [],
  embeddings: [],
  wanModel: "wan2.1_t2v_1.3B_fp16.safetensors",
  composeOutputType: "image",
  wanRemixHighModel: "",
  wanRemixLowModel: "",
  wanRemixShift: 5.0,
  wanRemixPass1Steps: 3,
  wanRemixTotalSteps: 4,
  wanPairedLoras: [],
  segmentColorCorrection: 0.15,
  wanRemixEndImage: "",
  wanSviMode: false,
  wanSviLoraStrength: 1.0,
  wanSviLightningEnabled: true,
  wanSviLightningCombo: 1,
  wanSviTripleKSampler: false,
  wanSviCleanStepCfg: 4.0,
  storyboardSegments: [],
  foleyEnabled: false,
  foleyPrompt: "",
  foleyNegativePrompt: "music, speech, silence, noisy, harsh",
  foleySteps: 75,
  foleyCfg: 5.5,
  foleySampler: "euler",
  outpaint: {
    enabled: false,
    directions: { left: false, right: false, top: false, bottom: false },
    percentages: { left: 30, right: 30, top: 30, bottom: 30 },
  },
  outpaintInfo: null,
  hiresEnabled: false,
  hiresScale: 2.0,
  hiresSteps: 20,
  hiresDenoise: 0.45,
  hiresUpscaleMethod: "bislerp",
  enhanceEnabled: false,
  enhanceUpscalerModel: "RealESRGAN_x4plus.pth",
  enhanceDenoise: 0.35,
  enhanceSteps: 15,
  upscaleMode: "off",
  upscaleScale: 2.0,
  upscaleModel: "RealESRGAN_x4plus.pth",
  upscaleDenoise: 0.38,
  upscaleSteps: 15,
  adetailerEnabled: false,
  adetailerDenoise: 0.4,
  adetailerCfg: 7.0,
  adetailerSteps: 20,
  inpaintMethod: "default",
  inpaintStrength: 1.0,
  inpaintRespectiveField: 0.618,
  inpaintErodeDilate: 0,
  inpaintInvertMask: false,
  inpaintDisableInitialLatent: false,
  inpaintAdditionalPrompt: "",
  dinoErodeDilate: 0,
  inpaintMaskGrow: 6,
  contentAwareEngine: "diffdiff",
  objectRemoval: false,
  brushnetScale: 1.0,
  batchSize: 1,
};

// Vek-Snap inpaint defaults: used by Restore Defaults button and settings import filtering
export const INPAINT_DEFAULTS = {
  inpaintMethod: "default" as InpaintMethod,
  inpaintStrength: 1.0,
  inpaintRespectiveField: 0.618,
  inpaintErodeDilate: 0,
  inpaintInvertMask: false,
  inpaintDisableInitialLatent: false,
  inpaintAdditionalPrompt: "",
  inpaintMaskGrow: 6,
  contentAwareEngine: "diffdiff" as ContentAwareEngine,
  objectRemoval: false,
  brushnetScale: 1.0,
};

// ── Content-Aware Fill/Removal Engine ──
// Commercial-safe successor to a retired third-party inpaint engine (which relied on
// unregistered/unlicensed inpaint patch weights). Three selectable engines:
//  diffdiff   : DifferentialDiffusion (built into ComfyUI core). No downloads. DEFAULT so the
//               feature works out-of-the-box; the BrushNet/PowerPaint weights ship OFF by default.
//  brushnet   : BrushNet (Apache-2.0) - plug-and-play SOTA inpaint for SDXL/SD1.5/Pony bases.
//  powerpaint : PowerPaint v2 (SD1.5 base only) - dedicated "object removal" mode; best eraser.
export type ContentAwareEngine = "diffdiff" | "brushnet" | "powerpaint";

export const CONTENT_AWARE_ENGINES = [
  { value: "diffdiff" as ContentAwareEngine, label: "Standard (DifferentialDiffusion)", description: "No extra downloads. Best for replacing/editing content. Works on any checkpoint." },
  { value: "brushnet" as ContentAwareEngine, label: "BrushNet (high quality)", description: "SOTA plug-and-play inpaint for SDXL / SD1.5 / Pony. Best overall fill quality. Requires BrushNet weights." },
  { value: "powerpaint" as ContentAwareEngine, label: "PowerPaint (object removal)", description: "SD1.5 base only. Dedicated object-removal mode: best for erasing people/objects. Requires PowerPaint weights." },
] as const;

// BrushNet / PowerPaint weight filenames, place (renamed, flat) in ComfyUI/models/inpaint/,
// except POWERPAINT.BASE_CLIP which goes in ComfyUI/models/clip/. Kept in exact sync with the
// installer model catalog + downloader (they rename to these names).
export const BRUSHNET_MODELS = {
  SDXL: "brushnet_sdxl.safetensors",   // BrushNet random_mask SDXL v0 diffusion_pytorch_model.safetensors
  SD15: "brushnet_sd15.safetensors",   // BrushNet random_mask SD1.5 diffusion_pytorch_model.safetensors
};
export const POWERPAINT_MODELS = {
  BRUSHNET: "powerpaint_v2.safetensors", // PowerPaint-v2-1 PowerPaint_Brushnet/diffusion_pytorch_model.safetensors
  CLIP: "powerpaint_v2_clip.bin",        // PowerPaint-v2-1 PowerPaint_Brushnet/pytorch_model.bin (must end .bin)
  BASE_CLIP: "sd15_text_encoder.safetensors", // SD1.5 text encoder -> ComfyUI/models/clip/
};

// Foley sampler options: only Euler is reliable; others have broken sub-step timestep scheduling
// in the upstream HunyuanVideo-Foley scheduler (model called at wrong intermediate sigmas)
export const FOLEY_SAMPLERS = [
  { value: "euler", label: "Euler (recommended)", defaultSteps: 75, defaultCfg: 5.5 },
  { value: "heun-2", label: "Heun-2 (experimental ⚠️)", defaultSteps: 50, defaultCfg: 4.5 },
  { value: "midpoint-2", label: "Midpoint-2 (experimental ⚠️)", defaultSteps: 50, defaultCfg: 4.5 },
  { value: "kutta-4", label: "Runge-Kutta 4 (experimental ⚠️)", defaultSteps: 50, defaultCfg: 4.5 },
] as const;

// HiRes Fix latent upscale methods (built-in, no external models required)
export const HIRES_UPSCALE_METHODS = [
  { value: "bislerp", label: "Bislerp (best quality)" },
  { value: "bilinear", label: "Bilinear" },
  { value: "nearest-exact", label: "Nearest Exact" },
  { value: "area", label: "Area" },
] as const;

// HiRes Fix scale presets
export const HIRES_SCALE_PRESETS = [
  { value: 1.5, label: "1.5x" },
  { value: 2.0, label: "2.0x" },
  { value: 2.5, label: "2.5x" },
  { value: 3.0, label: "3.0x" },
] as const;

// Foley audio prompt presets: action-specific sound effect descriptions
// Use layered sounds, temporal dynamics, and perspective cues for best CLAP results
export const FOLEY_PROMPT_PRESETS = [
  {
    label: "Footsteps (Indoor)",
    prompt: "Footsteps on a hardwood floor, steady walking rhythm, soft creak of floorboards, faint room reverb, close-mic perspective",
  },
  {
    label: "Footsteps (Gravel)",
    prompt: "Footsteps crunching on loose gravel, irregular pace, small stones shifting underfoot, outdoor ambience, dry crisp texture",
  },
  {
    label: "Rain & Thunder",
    prompt: "Steady rainfall on a window, distant rumbling thunder building and fading, water dripping from a gutter, soft wind, calm storm ambience",
  },
  {
    label: "Forest Ambience",
    prompt: "Birdsong layered over rustling leaves, a light breeze through trees, distant flowing stream, occasional insect chirps, peaceful daytime forest",
  },
  {
    label: "City Street",
    prompt: "Urban street ambience, passing cars, distant horns, footsteps on pavement, muffled crowd chatter, occasional bicycle bell",
  },
  {
    label: "Café Interior",
    prompt: "Cozy café ambience, espresso machine hissing, ceramic cups clinking, low murmur of conversation, soft background music, occasional chair scrape",
  },
  {
    label: "Door & Keys",
    prompt: "Keys jingling, a lock turning, a wooden door creaking open then clicking shut, footsteps entering a quiet room",
  },
  {
    label: "Kitchen Cooking",
    prompt: "Sizzling pan over a stove, chopping vegetables on a wooden board, water boiling, utensils clinking, refrigerator hum",
  },
  {
    label: "Fireplace",
    prompt: "Crackling wood fire, gentle pops and hisses, glowing embers shifting, soft warm room tone, occasional log settling",
  },
  {
    label: "Ocean Waves",
    prompt: "Rolling ocean waves breaking on a sandy shore, foam fizzing as water recedes, distant seagulls, gentle sea breeze",
  },
  {
    label: "Keyboard Typing",
    prompt: "Mechanical keyboard typing at a steady pace, occasional pauses, soft mouse clicks, quiet office room tone",
  },
  {
    label: "Crowd Applause",
    prompt: "Audience applause building from scattered claps to a full ovation, cheering and whistles, lively auditorium ambience",
  },
] as const;

// Segment-level progress tracking for WAN Remix storyboard mode
export type SegmentStatus = "pending" | "active" | "complete";
export type PassType = "conditioning" | "pass1" | "pass2" | "decoding" | "other";

export interface SegmentProgress {
  totalSegments: number;
  currentSegment: number;       // 0-indexed
  currentPass: PassType;
  passLabel: string;            // e.g. "Pass 1 (High-Q)" or "VAE Decode"
  segmentStatuses: SegmentStatus[];
}

// Preview history entry for the preview strip
export interface PreviewHistoryEntry {
  dataUrl: string;
  timestamp: number;
  segment: number;              // which segment this preview belongs to (-1 if unknown)
  passLabel: string;
}

export interface ComfyUIProgress {
  type: string;
  data: {
    value?: number;
    max?: number;
    prompt_id?: string;
    node?: string;
    output?: Record<string, unknown>;
  };
}

export interface QueueResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export interface HistoryEntry {
  prompt: unknown;
  outputs: Record<string, {
    images?: Array<{ filename: string; subfolder: string; type: string }>;
    gifs?: Array<{ filename: string; subfolder: string; type: string }>;
    audio?: Array<{ filename: string; subfolder: string; type: string }>;
  }>;
  status: { status_str: string; completed: boolean };
}

export const SAMPLERS = [
  "euler",
  "euler_ancestral",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "lcm",
  "ddim",
  "uni_pc",
  "uni_pc_bh2",
] as const;

export const SCHEDULERS = [
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "beta",
] as const;

export const WEIGHT_TYPES = [
  "linear",
  "ease in",
  "ease out",
  "ease in-out",
  "reverse in-out",
  "weak input",
  "weak output",
  "weak middle",
  "strong middle",
  "style transfer",
  "composition",
  "strong style transfer",
] as const;

export const RESOLUTION_PRESETS = [
  // SD1.5 native (512px base)
  { label: "512×512 (SD1.5 1:1)", width: 512, height: 512 },
  { label: "512×768 (SD1.5 2:3)", width: 512, height: 768 },
  { label: "768×512 (SD1.5 3:2)", width: 768, height: 512 },
  { label: "512×896 (SD1.5 9:16)", width: 512, height: 896 },
  { label: "896×512 (SD1.5 16:9)", width: 896, height: 512 },
  // SDXL / Pony native (1024px base)
  { label: "1024×1024 (SDXL 1:1)", width: 1024, height: 1024 },
  { label: "832×1216 (SDXL 2:3)", width: 832, height: 1216 },
  { label: "1216×832 (SDXL 3:2)", width: 1216, height: 832 },
  { label: "768×1344 (SDXL 9:16)", width: 768, height: 1344 },
  { label: "1344×768 (SDXL 16:9)", width: 1344, height: 768 },
] as const;

// Wan 2.1 480p resolution presets (must be multiples of 16)
export const WAN_RESOLUTION_PRESETS = [
  { label: "832×480 (Wan 16:9)", width: 832, height: 480 },
  { label: "480×832 (Wan 9:16)", width: 480, height: 832 },
  { label: "480×480 (Wan 1:1)", width: 480, height: 480 },
  { label: "624×480 (Wan 4:3)", width: 624, height: 480 },
  { label: "480×624 (Wan 3:4)", width: 480, height: 624 },
] as const;

// ── WAN 2.2 Story GGUF model constants ──
// Two-pass I2V: high-Q model for initial noise, low-Q model for refinement
export const WAN_REMIX_MODELS = {
  HIGH_Q: "wan22RemixI2VGGUFV20_highQ4KM.gguf",
  LOW_Q: "wan22RemixI2VGGUFV20_lowQ4KM.gguf",
} as const;

// ── WAN 2.2 SVI (Stable Video Infinity) model constants ──
// SVI infinite-video I2V with camera/prompt adherence + SVI continuity LoRAs.
// Uses official Apache-2.0 Wan 2.2 I2V A14B base (QuantStack GGUF) + MIT-licensed
// vita-video-gen SVI v2 PRO LoRAs. Users download these via the model manager.
export const WAN_SVI_MODELS = {
  // Base diffusion models: official SFW Wan 2.2 I2V A14B (QuantStack GGUF, high/low noise)
  HIGH_GGUF: "Wan2.2-I2V-A14B-HighNoise-Q6_K.gguf",
  LOW_GGUF: "Wan2.2-I2V-A14B-LowNoise-Q6_K.gguf",
  // SVI v2 PRO LoRAs (MIT, vita-video-gen/svi-model, required for SVI infinite video continuity)
  SVI_LORA_HIGH: "WAN-2.2\\SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors",
  SVI_LORA_LOW: "WAN-2.2\\SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors",
  // Lightning LoRAs (optional, for 4-step fast generation)
  LIGHTNING_HIGH_R64: "WAN-2.2\\wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors",
  LIGHTNING_HIGH_R128: "WAN-2.2\\lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors",
  LIGHTNING_LOW: "WAN-2.2\\wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors",
  // Default settings
  DEFAULT_SHIFT: 5.0,
  DEFAULT_STEPS_PASS1: 2,
  DEFAULT_STEPS_TOTAL: 4,
  DEFAULT_CFG: 1.0,
  DEFAULT_CLEAN_CFG: 4.0,
} as const;

// Lightning combo presets for SVI
// highRank: "r128" uses rank128 LoRA (more motion), "r64" uses rank64 (less degradation)
export const WAN_SVI_LIGHTNING_COMBOS = [
  { label: "Combo 1: More Motion (rapid degradation)", highRank: "r128" as const, highWeight: 4.0, lowWeight: 1.4 },
  { label: "Combo 2: Less Degradation (recommended)", highRank: "r64" as const, highWeight: 1.0, lowWeight: 1.0 },
  { label: "Combo 3: Balanced Motion/Degradation", highRank: "r128" as const, highWeight: 3.0, lowWeight: 1.5 },
] as const;

// WAN 2.2 Story resolution presets (higher res supported, multiples of 16)
export const WAN_REMIX_RESOLUTION_PRESETS = [
  { label: "704×1024 (Portrait)", width: 704, height: 1024 },
  { label: "1024×704 (Landscape)", width: 1024, height: 704 },
  { label: "832×480 (16:9)", width: 832, height: 480 },
  { label: "480×832 (9:16)", width: 480, height: 832 },
  { label: "704×704 (1:1)", width: 704, height: 704 },
  { label: "512×512 (1:1 Small)", width: 512, height: 512 },
] as const;

// WAN 2.2 Story step-count presets (pass1End / totalSteps)
export const WAN_REMIX_STEP_PRESETS = [
  { label: "Fast Draft (3/4)",       pass1: 3,  total: 4  },
  { label: "Light (8/12)",           pass1: 8,  total: 12 },
  { label: "Balanced (14/20)",       pass1: 14, total: 20 },
  { label: "High Quality (18/25)",   pass1: 18, total: 25 },
  { label: "Maximum (24/35)",        pass1: 24, total: 35 },
] as const;

// WAN 2.2 Story frame presets (longer clips possible with two-pass)
export const WAN_REMIX_FRAME_PRESETS = [33, 49, 65, 81, 97, 113, 129, 145] as const;

// Wan 2.1 model file constants
// Note: I2V only available in 14B (~16GB+), won't fit on ≤12GB VRAM cards
export const WAN_MODELS = {
  T2V_1_3B: "wan2.1_t2v_1.3B_fp16.safetensors",
  I2V_480P_14B: "wan2.1_i2v_480p_14B_fp16.safetensors",
  TEXT_ENCODER: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  VAE: "wan_2.1_vae.safetensors",
  CLIP_VISION: "clip_vision_h.safetensors",
} as const;

// Selectable T2V diffusion models for the Wan UI
// Official Apache-2.0 WAN checkpoints only (commercial-clean). Users may point to
// additional licensed WAN checkpoints via the model manager.
export const WAN_T2V_OPTIONS = [
  { value: WAN_MODELS.T2V_1_3B, label: "Wan 2.1 T2V 1.3B (Base)" },
] as const;

// Wan frame lengths must be 4n+1
export const WAN_FRAME_PRESETS = [17, 21, 25, 29, 33, 41, 49, 61, 81] as const;

// ── Z-Image Turbo model file constants ──
// Modern turbo image model: UNETLoader + CLIPLoader (Qwen 3 4B, lumina2) + VAELoader
// Uses SD3-style latent space, 20 steps, euler/simple, CFG 1.0
export const ZIMAGE_MODELS = {
  // Flat filenames as placed by the installer's model catalog (no dev-only
  // subfolder prefix). UNET -> models/diffusion_models, CLIP -> models/text_encoders,
  // VAE -> models/vae. These MUST match installer model-catalog.ts exactly.
  UNET: "z_image_turbo_bf16.safetensors",
  CLIP: "qwen_3_4b.safetensors",
  CLIP_TYPE: "lumina2" as const,
  VAE: "ae.safetensors",
  DEFAULT_STEPS: 20,
  DEFAULT_CFG: 1.0,
  DEFAULT_SAMPLER: "euler",
  DEFAULT_SCHEDULER: "simple",
  DEFAULT_BATCH_SIZE: 1,
  DEFAULT_I2I_DENOISE: 0.50,
  DEFAULT_I2I_STEPS: 9,
} as const;

// ── Z-Image Turbo "Enhance Details" (prompt-guided detail restoration) ──
// Detail RESTORATION on an uploaded image (repairs softness / mushy texture) rather than
// re-generating it. Two hard limits are the whole ballgame:
//  • CFG: Z-Image Turbo is a DISTILLED model; anything meaningfully above 1.0 fries it. Capped.
//  • DENOISE: Z-Image is trained to GENERATE, not restore; past ~0.5 it re-imagines the source.
export const ZIMAGE_ENHANCE = {
  DENOISE: 0.30,        // research sweet spot 0.25–0.35
  DENOISE_MIN: 0.10,
  DENOISE_MAX: 0.50,    // above this it re-imagines rather than restores
  STEPS: 8,             // EFFECTIVE refinement steps (Turbo is ~8 NFE)
  STEPS_MAX: 60,        // ceiling for the scaled schedule (see the builder)
  CFG: 1.0,
  CFG_MAX: 1.5,
  SAMPLER: "euler",
  SCHEDULER: "simple",
  CN_STRENGTH: 0.60,    // ControlNet structure-lock strength
  CANNY_LOW: 0.20,      // looser than node default - we want fine texture edges,
  CANNY_HIGH: 0.60,     // not just bold outlines
} as const;

// Detail-oriented conditioning. Describes IMAGE QUALITY rather than subject matter, so it composes
// with (or cleanly replaces) the user's own prompt instead of fighting it for content control.
export const ZIMAGE_ENHANCE_PROMPT =
  "ultra sharp, crisp fine detail, natural skin texture with visible pores, individual hair strands, " +
  "clean well-defined edges, accurate detailed eyes, realistic fabric weave and material texture, " +
  "high microcontrast, photographic clarity, no smoothing, no blur";

export const ZIMAGE_ENHANCE_NEGATIVE =
  "blurry, soft focus, out of focus, smeared, waxy plastic skin, over-smoothed, flat denoised texture, " +
  "compression artifacts, jpeg blocking, banding, ringing halos, oversharpened crunchy edges, " +
  "melted features, warped anatomy, extra fingers, garbled text, watermark, low resolution";

// ── Z-Image Turbo "Face Repair" (Phase 2a: region-targeted semantic repair) ──
// Detects face bounding boxes (Impact Pack FaceDetailer + Ultralytics YOLO), upscales each crop
// to GUIDE_SIZE, runs a low-denoise Z-Image restoration on the crop ONLY, then composites back
// with feathering. Purpose: fix melted-teeth / warped-eye facial artifacts without disturbing
// correctly-rendered pixels. FaceDetailer's internal sampler is a KSampler, so it truncates the
// schedule by denoise exactly like KSampler, the builder applies steps/denoise scaling.
// Permissive face detector used by the face-repair / ADetailer graphs. Florence-2
// (MIT, Microsoft) via ComfyUI-RMBG's `AILab_Florence2` node, "Phrase Grounding"
// on the prompt "face" returns a filled region MASK. Replaces the former AGPL
// Ultralytics YOLOv8 (`UltralyticsDetectorProvider` + Impact `FaceDetailer`) path.
export const FACE_DETECT = {
  FLORENCE_MODEL: "microsoft/Florence-2-base", // MIT; auto-fetched to models/LLM by the node
  PROMPT: "face",
  BBOX_DILATION: 10, // grow the detected region (px) so jaw/hairline are included
  FEATHER: 8,        // soft mask edge (px) for a seamless composite
} as const;

export const ZIMAGE_FACE = {
  // LEGACY (unused after the Florence-2 swap; kept for back-compat of saved params).
  DETECTOR: "bbox/face_yolov8n_v2.pt",
  DENOISE: 0.30,        // research sweet spot 0.25–0.35
  DENOISE_MIN: 0.10,
  DENOISE_MAX: 0.50,    // above this it re-imagines the face rather than repairing it
  STEPS: 8,             // EFFECTIVE steps; schedule scaled up internally to compensate for denoise
  STEPS_MAX: 60,
  CFG: 1.0,
  CFG_MAX: 1.5,
  SAMPLER: "euler",
  SCHEDULER: "simple",
  GUIDE_SIZE: 768,      // face crop is upscaled to this before sampling (detail headroom)
  GUIDE_SIZE_MIN: 256,
  GUIDE_SIZE_MAX: 1024,
  MAX_SIZE: 1024,
  FEATHER: 8,           // composite blend at the crop boundary (px)
  BBOX_THRESHOLD: 0.50, // detection confidence
  BBOX_DILATION: 10,    // grow the detected box (px) so jaw/hairline edges are included
  BBOX_CROP_FACTOR: 3.0,// context around the face fed to the sampler
} as const;

// Face-repair conditioning: targets the exact facial artifact classes (melted teeth, warped/
// asymmetric eyes, smeared skin) while suppressing this mode's own failure modes. Leads the
// prompt so it drives the redraw; the user's prompt is appended only when they opt in.
export const ZIMAGE_FACE_PROMPT =
  "a detailed realistic human face, sharp clear symmetric eyes with accurate pupils, " +
  "clean well-formed natural teeth, natural skin texture with visible pores, defined eyelashes and eyebrows, " +
  "in sharp focus, photographic clarity";

export const ZIMAGE_FACE_NEGATIVE =
  "melted teeth, extra teeth, crooked teeth, deformed mouth, warped eyes, asymmetric eyes, extra eyes, " +
  "misaligned pupils, blurry face, waxy plastic skin, over-smoothed, smeared features, distorted anatomy, " +
  "disfigured, low resolution, oversharpened crunchy edges";

// Z-Image Turbo resolution presets (SD3-style latent, multiples of 64 recommended)
export const ZIMAGE_RESOLUTION_PRESETS = [
  { label: "1024×1024 (1:1 Square)", width: 1024, height: 1024 },
  { label: "896×1152 (4:5 Social Portrait)", width: 896, height: 1152 },
  { label: "832×1216 (2:3 Portrait)", width: 832, height: 1216 },
  { label: "768×1344 (9:16 Phone Vertical)", width: 768, height: 1344 },
  { label: "1152×896 (5:4 Social Landscape)", width: 1152, height: 896 },
  { label: "1216×832 (3:2 Landscape)", width: 1216, height: 832 },
  { label: "1344×768 (16:9 Cinematic)", width: 1344, height: 768 },
  { label: "1536×640 (21:9 Ultrawide)", width: 1536, height: 640 },
] as const;

// Z-Image Turbo prompt presets (natural language)
export const ZIMAGE_PROMPT_PRESETS = [
  {
    label: "Photorealistic portrait",
    prompt: "A stunning photorealistic portrait with soft natural lighting and shallow depth of field. Detailed skin texture, expressive eyes, professional studio photography with creamy bokeh background.",
  },
  {
    label: "Cinematic scene",
    prompt: "A cinematic wide-angle shot bathed in golden hour light. Rich warm tones, deep shadows, film grain texture, anamorphic lens flare. Dramatic composition following the rule of thirds.",
  },
  {
    label: "Fantasy illustration",
    prompt: "An intricate fantasy illustration with rich colors, dramatic volumetric lighting, highly detailed magical environment. Painterly quality with depth and atmosphere, concept art style.",
  },
  {
    label: "Anime character",
    prompt: "A beautiful anime-style character illustration with vibrant colors and clean linework. Expressive features, dynamic pose, detailed background. Professional anime production quality.",
  },
] as const;

// ── Character Card (identity-anchor turnaround) ────────────────────────────
// Powers the "Character Card (6 views)" batch in the Z-Image studio. Each view
// wraps the user's IDENTITY block (from the prompt box) in a neutral, evenly-lit
// studio description at its own full resolution. The batch runs all six at ONE
// locked seed so the outputs composite into a consistent reference card.
// Generating each view full-frame (instead of six tiny panels in one image) is
// what keeps the detail sharp.
export interface CharacterCardView {
  key: string;
  label: string;
  width: number;
  height: number;
  prompt: string; // "{IDENTITY}" is replaced with the user's identity block
}

export const CHARACTER_CARD_VIEWS: CharacterCardView[] = [
  {
    key: "front",
    label: "Front (full body)",
    width: 832,
    height: 1216,
    prompt: "A crisp full-length studio photograph captured on an 85mm lens at f/5.6, a straight-on eye-level front view of {IDENTITY}, standing upright and centered in a relaxed neutral pose with arms resting at their sides and weight even on both feet. Soft, even, shadowless light from a large overhead softbox reveals lifelike skin texture with visible pores and fine flyaway hairs, while the seamless matte-black studio background stays clean and unlit. Photorealistic, ultra-sharp focus from head to feet, true-to-life color, no text.",
  },
  {
    key: "three_quarter",
    label: "Three-quarter (full body)",
    width: 832,
    height: 1216,
    prompt: "A crisp full-length studio photograph captured on an 85mm lens at f/5.6, a three-quarter view of {IDENTITY} turned about forty-five degrees, standing upright in a relaxed neutral pose with arms resting at their sides and weight even on both feet. Soft, even, shadowless light from a large overhead softbox reveals lifelike skin texture with visible pores and fine flyaway hairs, while the seamless matte-black studio background stays clean and unlit. Photorealistic, ultra-sharp focus from head to feet, true-to-life color, no text.",
  },
  {
    key: "side",
    label: "Side profile (full body)",
    width: 832,
    height: 1216,
    prompt: "A crisp full-length studio photograph captured on an 85mm lens at f/5.6, a full side-profile view of {IDENTITY} facing camera-left, standing upright in a relaxed neutral pose with arms resting at their sides and weight even on both feet. Soft, even, shadowless light from a large overhead softbox reveals lifelike skin texture with visible pores and fine flyaway hairs, while the seamless matte-black studio background stays clean and unlit. Photorealistic, ultra-sharp focus from head to feet, true-to-life color, no text.",
  },
  {
    key: "back",
    label: "Back (full body)",
    width: 832,
    height: 1216,
    prompt: "A crisp full-length studio photograph captured on an 85mm lens at f/5.6, a straight-on back view of {IDENTITY} facing away from camera, standing upright in a relaxed neutral pose with arms resting at their sides and weight even on both feet. Soft, even, shadowless light from a large overhead softbox reveals lifelike skin texture and hair detail at the nape, while the seamless matte-black studio background stays clean and unlit. Photorealistic, ultra-sharp focus from head to feet, true-to-life color, no text.",
  },
  {
    key: "head_neutral",
    label: "Head (neutral)",
    width: 896,
    height: 1152,
    prompt: "A close head-and-shoulders studio portrait captured on an 85mm lens at f/4.0, a straight-on eye-level view of {IDENTITY} with a calm neutral expression looking directly into the lens. Soft, even, shadowless light from a large overhead softbox reveals lifelike skin texture with visible pores, subtle skin translucency, and individual eyelashes and flyaway hairs, while the seamless matte-black studio background stays clean and unlit. Photorealistic, tack-sharp focus on the eyes, true-to-life color, no text.",
  },
  {
    key: "head_smile",
    label: "Head (soft smile)",
    width: 896,
    height: 1152,
    prompt: "A close head-and-shoulders studio portrait captured on an 85mm lens at f/4.0, a straight-on eye-level view of {IDENTITY} with a soft, natural closed-mouth smile looking directly into the lens. Soft, even, shadowless light from a large overhead softbox reveals lifelike skin texture with visible pores, subtle skin translucency, and individual eyelashes and flyaway hairs, while the seamless matte-black studio background stays clean and unlit. Photorealistic, tack-sharp focus on the eyes, true-to-life color, no text.",
  },
];

// Shared negative for card runs, kills text/labels, halos, and plastic skin.
export const CHARACTER_CARD_NEGATIVE = "text, labels, captions, watermark, logo, signature, extra fingers, deformed hands, extra limbs, duplicated body, blurry, low detail, plastic skin, oversaturated, harsh shadows, colored lighting, cropped, out of frame";

// Example identity blocks to seed the prompt box (users edit for their own
// character). These describe ONLY the subject's appearance + wardrobe, the
// per-view scene/lighting is supplied by CHARACTER_CARD_VIEWS.
export const CHARACTER_CARD_IDENTITY_PRESETS = [
  {
    label: "Vocalist (soft blonde)",
    prompt: "a 27-year-old female vocalist with soft rounded cheekbones, a chin-length platinum-blonde blunt bob with a middle part and pale blue eyes, dewy natural skin with a soft rosy lip, wearing a fitted white ribbed-knit crop top, a delicate layered gold necklace, high-waisted light-wash wide-leg jeans, and clean white leather sneakers",
  },
  {
    label: "Blank template",
    prompt: "a [age]-year-old [subject] with [face shape / jawline], [hair length, style, and color], [eye color], [skin description], wearing [top], [accessories], [bottoms], and [footwear]",
  },
] as const;

// Pony / PDXL prompt presets, uses booru tag format with score/rating prefix
export const PONY_PROMPT_PRESETS = [
  {
    label: "Portrait (SFW)",
    prompt: "score_9, score_8_up, score_7_up, score_6_up, rating_safe, 1girl, solo, beautiful face, detailed eyes, looking at viewer, portrait, upper body, soft lighting, natural skin texture, photorealistic, masterpiece, best quality",
  },
  {
    label: "Cinematic scene",
    prompt: "score_9, score_8_up, score_7_up, score_6_up, rating_safe, cinematic lighting, dramatic atmosphere, volumetric light, depth of field, film grain, wide shot, detailed background, masterpiece, best quality, absurdres",
  },
  {
    label: "Fantasy illustration",
    prompt: "score_9, score_8_up, score_7_up, score_6_up, rating_safe, fantasy, magical atmosphere, ethereal glow, detailed armor, sword, cape flowing in wind, epic composition, vibrant colors, digital painting, masterpiece, best quality",
  },
  {
    label: "Anime style",
    prompt: "score_9, score_8_up, score_7_up, score_6_up, rating_safe, anime, 1girl, solo, beautiful detailed eyes, colorful hair, dynamic pose, vibrant colors, clean lineart, detailed background, best quality, absurdres",
  },
  {
    label: "Dark & moody",
    prompt: "score_9, score_8_up, score_7_up, score_6_up, rating_safe, dark theme, noir aesthetic, chiaroscuro, dramatic shadows, single light source, moody atmosphere, high contrast, detailed, masterpiece, best quality",
  },
] as const;

export const PONY_NEGATIVE_PROMPT = "score_1, score_2, score_3, score_4, ugly, deformed, mutated, disfigured, poorly drawn face, extra limbs, bad anatomy, bad hands, missing fingers, extra fingers, watermark, text, signature, blurry, low quality, worst quality";

/** Detect Pony/PDXL checkpoint by filename pattern */
export function isPonyCheckpoint(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("pony") || lower.includes("pdxl") || lower.includes("ponydiffusion");
}

export const IPADAPTER_PRESETS = [
  "FACEID PLUS V2",
  "FACEID PLUS - SD1.5 only",
  "FACEID",
  "FACEID PORTRAIT (style transfer)",
] as const;

export type GenerationMode = "video" | "image" | "wan" | "wan_s2v" | "wan_remix" | "compose" | "edit" | "zimage" | "lora" | "ltx2" | "ltx25" | "director" | "restore" | "acestep" | "heartmula" | "lipsync" | "dramabox" | "moviemaker" | "components" | "metaguard";

// ── Video Restoration types (SeedVR2 + Real-ESRGAN via ComfyUI) ──

export type RestoreEngine = "seedvr2" | "realesrgan";

export interface VideoRestorationConfig {
  engine: RestoreEngine;
  // Output root override from Settings. Empty/undefined = the standard ComfyUI/output folder.
  // Restored files always land in a "Restore" subfolder beneath whichever root applies.
  outputDir?: string;
  // Input
  inputVideoPath: string;      // absolute path to source video on disk
  inputVideoName: string;      // display name
  inputDuration: number;       // seconds
  inputFps: number;
  inputWidth: number;
  inputHeight: number;
  // SeedVR2 settings
  seedvrModel: string;         // model filename (e.g. "SeedVR2-3B")
  seedvrOutputHeight: number;  // target output height (width auto-calculated)
  seedvrOutputWidth: number;   // target output width
  seedvrSeed: number;
  seedvrRandomSeed: boolean;
  seedvrTileSize: number;      // spatial tiling for VRAM management
  seedvrTemporalSize: number;  // temporal tiling (frames per chunk)
  seedvrColorFix: boolean;     // apply color correction post-processing
  // ── Z-Image Turbo repair PRE-PASS (Phase 2b) ──
  // Runs BEFORE SeedVR2. Repairs semantic artifacts (melted teeth, warped eyes, mushy detail) on
  // each extracted frame via the ComfyUI Z-Image graph, THEN hands the repaired frames to the
  // temporal SeedVR2 pass: whose cross-frame attention removes the per-frame flicker that the
  // independent per-frame repairs necessarily introduce. Order matters: repair must precede
  // SeedVR2. Only meaningful with engine="seedvr2"; a no-op when disabled.
  zimageRepairEnabled: boolean;
  zimageRepairMode: "face" | "enhance"; // face = region-targeted faces only; enhance = whole frame
  zimageRepairDenoise: number;          // 0 = use the graph's safe default (ZIMAGE_FACE/ENHANCE)
  zimageRepairPrompt: string;           // optional subject context appended to the repair prompt
  // Real-ESRGAN settings (lightweight / fast path)
  esrganModel: string;         // realesrgan-x4plus, realesr-animevideov3, etc.
  esrganScale: number;         // 2 or 4
  esrganTileSize: number;      // 0 = auto
  // Pre-processing (ffmpeg-based, applied before AI upscaling)
  denoiseEnabled: boolean;
  denoiseStrength: number;     // nlmeans strength (1-30, default 6)
  brightnessAdjust: number;    // -1.0 to 1.0 (0 = no change)
  contrastAdjust: number;      // 0.5 to 2.0 (1.0 = no change)
  // Post-processing
  faceRestoreEnabled: boolean; // run GFPGAN face restoration on output frames
  faceRestoreModel: string;    // "GFPGAN-v1.4"
  faceRestoreFidelity: number; // 0.0-1.0 (restore fidelity weight)
  // Output
  targetFps: number;           // 0 = same as input; otherwise decimates to this FPS
  outputFormat: "mp4" | "mkv";
  outputCodec: "h264" | "h265" | "h264_nvenc" | "hevc_nvenc";
  outputCrf: number;           // quality (lower = better, 17-23 typical)
  preserveAudio: boolean;
}

export const RESTORE_ENGINE_OPTIONS = [
  { value: "seedvr2" as RestoreEngine, label: "SeedVR2 (Best Quality)", desc: "Diffusion-based restoration: denoises, recovers detail, and upscales in one pass" },
  { value: "realesrgan" as RestoreEngine, label: "Real-ESRGAN (Fast)", desc: "Traditional upscaler: fast but no diffusion-based detail recovery" },
] as const;

export const SEEDVR2_MODELS = [
  { value: "SeedVR2-3B", label: "SeedVR2-3B (Recommended)", vram: "~12-14 GB" },
] as const;

export const ESRGAN_MODELS = [
  { value: "realesrgan-x4plus", label: "RealESRGAN x4+ (Best for real footage)" },
  { value: "realesr-animevideov3", label: "RealESR AnimeVideo v3 (Anime/cartoon)" },
  { value: "realesrgan-x4plus-anime", label: "RealESRGAN x4+ Anime" },
] as const;

export const RESTORE_OUTPUT_CODECS = [
  { value: "h264", label: "H.264 (Software, universal)" },
  { value: "h264_nvenc", label: "H.264 NVENC (RTX GPU, fast)" },
  { value: "h265", label: "H.265/HEVC (Software, better compression)" },
  { value: "hevc_nvenc", label: "HEVC NVENC (RTX GPU, fast + small)" },
] as const;

export const RESTORE_FPS_PRESETS = [
  { value: 0, label: "Same as input" },
  { value: 24, label: "24 fps (Film)" },
  { value: 30, label: "30 fps" },
  { value: 60, label: "60 fps" },
] as const;

export const RESTORE_RESOLUTION_PRESETS = [
  { label: "Same as input (restore only)", height: 0, width: 0 },
  { label: "720p (1280×720)", height: 720, width: 1280 },
  { label: "1080p (1920×1080)", height: 1080, width: 1920 },
  { label: "1440p / 2K (2560×1440)", height: 1440, width: 2560 },
  { label: "2160p / 4K (3840×2160)", height: 2160, width: 3840 },
] as const;

export const VIDEO_RESTORATION_DEFAULTS: VideoRestorationConfig = {
  engine: "seedvr2",
  inputVideoPath: "",
  inputVideoName: "",
  inputDuration: 0,
  inputFps: 0,
  inputWidth: 0,
  inputHeight: 0,
  seedvrModel: "SeedVR2-3B",
  seedvrOutputHeight: 720,
  seedvrOutputWidth: 1280,
  seedvrSeed: -1,
  seedvrRandomSeed: true,
  seedvrTileSize: 256,
  seedvrTemporalSize: 8,
  seedvrColorFix: true,
  zimageRepairEnabled: false,
  zimageRepairMode: "face",
  zimageRepairDenoise: 0,
  zimageRepairPrompt: "",
  esrganModel: "realesrgan-x4plus",
  esrganScale: 4,
  esrganTileSize: 0,
  denoiseEnabled: true,
  denoiseStrength: 6,
  brightnessAdjust: 0,
  contrastAdjust: 1.0,
  faceRestoreEnabled: true,
  faceRestoreModel: "GFPGAN-v1.4",
  faceRestoreFidelity: 0.7,
  targetFps: 0,
  outputFormat: "mp4",
  outputCodec: "h264_nvenc",
  outputCrf: 18,
  preserveAudio: true,
};

// ── LTX-2 types (ComfyUI-based workflow) ──

export type LTX2ModelVersion = "2.0" | "2.3" | "2.5";
export type LTX2PipelineMode = "alternative" | "official";
export type LTX2QualityTier = "test" | "distilled" | "full";
// A2V Purpose: determines how audio conditioning interacts with video generation.
// "lip_sync": Speech audio drives mouth movement. I2V guide is suspended (fights lip-sync).
//                 NAG + CFGGuider auto-enabled to suppress subtitles from dialogue prompts.
// "music_video": Audio drives energy/mood. I2V guide frames remain active to anchor visuals.
//                 No subtitle suppression overhead (BasicGuider, no NAG). Normal render speed.
export type LTX2A2vPurpose = "lip_sync" | "music_video";

// Motion Track: a spline path drawn on the source image to guide object movement.
// Control points are normalized (0-1) relative to image dimensions.
// The spline is interpolated via Catmull-Rom to produce per-frame coordinates
// consumed by LTXVDrawTracks, which renders colored track overlays for IC-LoRA.
export interface MotionTrackPoint {
  x: number;  // 0-1 normalized x position
  y: number;  // 0-1 normalized y position
}

export type MotionTrackEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export interface MotionTrack {
  id: string;                     // unique track ID
  points: MotionTrackPoint[];     // spline control points (2+ required)
  color: string;                  // display color (hex, for UI only - model uses its own palette)
  label: string;                  // user description of what this track controls (e.g. "ball", "hand")
  startTime: number;              // seconds, when this track's motion begins (dot stationary before)
  endTime: number;                // seconds, when this track's motion ends (dot stationary after). 0 = use full video duration
  easing: MotionTrackEasing;      // speed curve for interpolation between control points
  enabled: boolean;               // false = skip this track during generation (keep in editor)
  dotSize: number;                // relative dot size multiplier (1.0 = default). Controls motion influence radius
  groupId?: string;               // shared ID for constellation-generated groups - enables group drag
}

export interface LTX2Config {
  prompt: string;
  width: number;
  height: number;
  numFrames: number;       // must be divisible by 8 + 1 (e.g. 25, 33, 41, 49, 57, 65, 81, 97, 113, 121)
  frameRate: number;
  seed: number;
  randomSeed: boolean;
  sourceImage: string;     // ComfyUI input filename for I2V, or empty for T2V
  enableAudio: boolean;
  // Model file selections (filenames in ComfyUI/models/)
  diffusionModel: string;  // in diffusion_models/
  textEncoder: string;     // in text_encoders/ (Gemma 12B)
  connectorModel: string;  // in text_encoders/ (embeddings connector for DualCLIPLoader)
  videoVae: string;        // in vae/
  audioVae: string;        // in checkpoints/ (core LTXVAudioVAELoader)
  // Distill LoRA (required for dev/dev-fp4 models with distilled sampling)
  distillLoRA: string;           // in loras/ (distill LoRA filename)
  distillLoRAStrength: number;   // LoRA strength (Lightricks official: 0.6, Alternative baked: 1.0)
  // User LoRAs (stacked after distill LoRA, model-only, no CLIP weights for LTX-2)
  userLoras: LoraEntry[];
  // Normalizing Sampler weights (one value per sampling step, comma-separated)
  videoNormFactors: string;   // Per-step scaling for video latents (default: all 1s = no scaling)
  audioNormFactors: string;   // Per-step scaling for audio latents (Alternative: reduce steps 3,6 to 0.25)
  // Advanced: Attention Tuner (cross-modal attention scaling)
  videoScale: number;          // Video self-attention scale (default 1.0)
  audioScale: number;          // Audio self-attention scale (default 1.0)
  audioToVideoScale: number;   // Audio→Video cross-attention (default 1.0)
  videoToAudioScale: number;   // Video→Audio cross-attention (default 1.0)
  // Advanced: VAE Tiling (decode quality vs VRAM)
  vaeTileSize: number;         // Tile size in pixels (default 512)
  vaeOverlap: number;          // Spatial overlap in pixels (default 64)
  vaeTemporalSize: number;     // Temporal tile frames (default 64)
  vaeTemporalOverlap: number;  // Temporal overlap frames (default 16)
  // Advanced: Chunk feedforward (VRAM optimization)
  ffChunks: number;            // Number of chunks for feedforward (default 4, higher = less VRAM)
  ffDimThreshold: number;      // Dimension threshold for chunking (default 4096)
  // Advanced: I2V
  imgCompression: number;  // I2V preprocessing compression (default 28)
  // Model path override: alternative base path for model files (faster storage)
  // When set, updates ComfyUI's extra_model_paths.yaml to search this path first
  modelBasePath: string;   // e.g. "D:\\Models" - empty = use ComfyUI default
  // Model version selector
  modelVersion: LTX2ModelVersion;
  // ── LTX-2.5-only (optional; consumed by buildLTX25Workflow). The 2.5 graph is a distinct
  // two-stage distilled AV pipeline mirroring the official ComfyUI template; these fields are
  // ignored by the 2.0/2.3 builder. ──
  spatialUpscaler?: string;   // latent_upscale_models/ filename (LatentUpscaleModelLoader → LTXVLatentUpsampler)
  textEncoderAux?: string;    // 2nd Gemma4 (e2b) encoder, ONLY feeds the TextGenerateLTX2Prompt enhancer
  promptEnhance?: boolean;    // wire the TextGenerateLTX2Prompt enhancer (requires textEncoderAux)
  // Sampler controls (2.5 two-stage distilled AV). LTX-2.5 samples audio+video JOINTLY per
  // stage: there is no separate audio sampler; steps below apply to both modalities.
  ltx25BaseSteps?: number;    // stage-1 (base, half-res) sampler steps - default 8 (proven schedule)
  ltx25RefineSteps?: number;  // stage-2 (refine, upscaled) sampler steps - default 3 (proven schedule)
  ltx25Sampler?: string;      // KSamplerSelect sampler_name - default "euler_ancestral"
  ltx25VideoCfg?: number;     // LTXVDualCFGGuider video_cfg - default 1 (distilled)
  ltx25AudioCfg?: number;     // LTXVDualCFGGuider audio_cfg - default 1 (distilled)
  sourceImageLast?: string;   // FLF2V last-frame image (ComfyUI input filename); set with sourceImage → FLF2V
  // Auto Duration (LTX-2.5): LTXVDurationPredictor predicts the optimal clip length from the prompt
  // before sampling. Requires the duration-head model_patch (loaded via ModelPatchLoader).
  ltx25AutoDuration?: boolean;      // ON → num_frames is predicted, overriding numFrames
  durationHead?: string;            // model_patches/ filename for LTXVDurationPredictor
  ltx25AutoDurationMin?: number;    // predictor min_seconds - default 1
  ltx25AutoDurationMax?: number;    // predictor max_seconds - default 20
  // Pipeline mode: "alternative" = Alternative community workflow, "official" = Lightricks official workflow
  pipelineMode: LTX2PipelineMode;
  // Quality tier (official pipeline only): "distilled" = 8-step fast, "full" = 15-step high-quality
  qualityTier: LTX2QualityTier;
  // Advanced mode (official pipeline). OFF = stock Lightricks recipe only (distilled=8/euler,
  // full=15/res_2s, no Test tier, no audio-refine). ON = exposes Test tier, independent
  // video/audio steps, sampler, distilled steps>8, and enables the distilled audio-refine
  // pass. The builder honors this so UI and engine can't disagree. Test tier is implicitly
  // advanced. See workflow-builder buildLTX2OfficialWorkflow.
  officialAdvanced?: boolean;
  // Negative prompt (official pipeline uses actual negative text; Alternative zeros it out)
  negativePrompt: string;
  // A2V (Audio-to-Video) mode: upload audio, freeze it, generate video conditioned on audio
  a2vMode?: boolean;
  a2vAudioFile?: string;       // ComfyUI input/ filename for the uploaded audio (WAV/MP3)
  a2vPurpose?: LTX2A2vPurpose; // How the audio interacts with video generation
  a2vCfg?: number;             // CFG strength for lip-sync A2V (default 3.0 - needed for NAG/neg to work)
  // NAG (Negative Attention Guidance): patches cross-attention to actively suppress unwanted content.
  // Required for distilled models (CFG=1) where regular negative prompts have zero effect.
  // Proven fix for subtitle generation with non-Latin dialogue prompts.
  // Auto-enabled in lip-sync mode; manual toggle available for standalone use.
  nagEnabled?: boolean;                  // Enable NAG independently (without A2V)
  nagScale?: number;                     // NAG scale (default 11.0, range 0-100)
  nagAlpha?: number;                     // NAG alpha blend (default 0.25, range 0-1)
  nagTau?: number;                       // NAG tau normalization (default 2.5, range 0-10)
  nagPrompt?: string;                    // NAG negative prompt (default: "subtitles, text, watermark...")
  // Style preset (from prompt-architect): drives negative prompt, FPS hint, camera defaults
  stylePreset: string;         // key into STYLE_PRESETS ("none" = no override)
  // Audio overlap conditioning (for chunked V2A generation)
  // When set, the overlap audio is loaded, VAE-encoded, prepended to the empty audio latent,
  // and masked as "frozen" so the model generates a natural continuation of the reference voice/sound.
  overlapAudioFile?: string;   // ComfyUI input/ filename (WAV) for overlap or voice reference audio
  overlapDuration?: number;    // Duration in seconds of the overlap audio (used for noise mask timing)
  // Multi-guide frames (for V2A): multiple frames from the source video used as image guides
  // at corresponding frame indices. Constrains the generated video to follow the original,
  // producing audio that better matches the source video's visual content.
  guideFrames?: { image: string; frameIdx: number; strength?: number }[];
  // V2A Fast Mode: encode the full source video into the video latent and freeze it,
  // then only denoise the audio portion. Produces audio conditioned on the actual video
  // content without re-generating video. Much faster, preserves original video quality.
  v2aFastMode?: boolean;
  // Absolute path to the pre-trimmed chunk video file (used by V2A Fast Mode).
  // VHS_LoadVideoPath loads this file to get all frames for VAE encoding.
  sourceVideoPath?: string;
  // IC-LoRA Video Guide (motion transfer / video-to-video)
  // Uses LTXICLoRALoaderModelOnly + LTXAddVideoICLoRAGuide to inject structural
  // guidance from a reference video (depth/pose/edges) while generating new content.
  icLoraMode?: boolean;           // Enable IC-LoRA video-guided generation
  icLoraName?: string;            // IC-LoRA weight filename (from loras/ folder)
  icLoraStrength?: number;        // IC-LoRA weight strength (default 1.0)
  guideVideoFile?: string;        // Uploaded guide video filename in ComfyUI input/video/
  guideStrength?: number;         // Guide conditioning strength (0-1, default 1.0)
  guideFrameLoadCap?: number;     // Max frames to load from guide video (0 = all)
  // Motion Tracks: draw spline motion paths on source image to guide object movement.
  // Uses LTXVDrawTracks to render colored track overlays, then IC-LoRA motion-track-control
  // to condition generation. Each track is a spline defined by control points (normalized 0-1).
  motionTracks?: MotionTrack[];             // Array of spline motion tracks
  motionTrackLoRA?: string;                 // IC-LoRA model for motion tracks (from loras/)
  motionTrackLoRAStrength?: number;         // IC-LoRA weight strength (default 1.0)
  motionTrackGuideStrength?: number;        // Guide conditioning strength (0-1, default 1.0)
  // Character Consistency: Reference Sheet (Official Lightricks IC-LoRA "Ingredients").
  // Conditions generation on a single composite reference sheet (character turnarounds,
  // props, location) so those identities carry into the video. Reuses the IC-LoRA path
  // (LTXICLoRALoaderModelOnly + LTXAddVideoICLoRAGuide); the still sheet is looped into a
  // static video (>=121 frames) at output resolution (downscale factor 1). Official path,
  // LTX-2 Community License. Best at the trained bucket: 768x448, 121 frames, 24 fps.
  ingredientsMode?: boolean;                // Enable reference-sheet consistency (official IC-LoRA)
  ingredientsLoRAName?: string;             // Ingredients IC-LoRA filename (from loras/)
  ingredientsLoRAStrength?: number;         // IC-LoRA weight strength (recommended 1.4)
  referenceSheetImage?: string;             // Uploaded reference-sheet image filename in ComfyUI input/
  referenceSheetStrength?: number;          // Reference conditioning strength (0-1, default 1.0)
  // Inject the segment's source frame (chained last-frame / storyboard / manual start) as a
  // frame-0 latent anchor ALONGSIDE the reference sheet. Uses LTXVImgToVideoConditionOnly, which
  // writes a clean latent at frame 0 WITHOUT adding guide_attention_entries, so it does NOT
  // collide with LTXAddVideoICLoRAGuide's own keyframe tokens (unlike LTXVAddGuideMulti). This is
  // what lets Continuum drive high-quality image injection (I2V) while keeping reference-sheet
  // consistency, instead of falling back to pure T2V. Opt-in; off keeps the original behavior.
  ingredientsUseSourceFrame?: boolean;      // Inject frame-0 source image alongside the reference sheet
  ingredientsSourceFrameStrength?: number;  // Frame-0 source anchor strength (0-1, default 0.65). Lower avoids a hard frame-0 lock that jumps to the sheet on later frames.
  // Anchor the segment's END frame (chained/storyboard next-segment start) at the LAST frame
  // ALONGSIDE the reference sheet: the mirror of the frame-0 source injection, for smooth
  // segment-to-segment continuity. Uses a second LTXAddVideoICLoRAGuide at frame_idx -1 (NOT
  // LTXVImgToVideoConditionOnly, which is index-0 only). Because it stacks on the same
  // guide_attention_entries accounting as the reference guide, the whole clip "sees" the target
  // and interpolates toward it (graceful, not a hard cut). Strength governs graceful↔hard-lock.
  ingredientsUseEndFrame?: boolean;         // Inject last-frame end image alongside the reference sheet
  ingredientsEndFrameStrength?: number;     // Last-frame anchor strength (0-1, default 0.65). Lower = softer approach toward the end frame.
  ingredientsEndFrameImage?: string;        // ComfyUI input/ filename for the end-frame anchor image
  // Direct Sampling: bypass LTXVNormalizingSampler and use SamplerCustomAdvanced directly.
  // Skips per-step audio/video normalization factors, community-discovered alternative that
  // can produce different results (sometimes cleaner, sometimes less stable).
  directSampling?: boolean;
  // Live Preview: use KJNodes LTX2SamplingPreviewOverride + Tiny VAE for real-time preview
  // during sampling. Adds ~23MB VRAM overhead + periodic VAE decode. Disable if VRAM-tight.
  livePreview?: boolean;
  // Test tier tuning: separate step counts for video and audio passes
  testVideoSteps?: number;    // Steps for video pass (default 3)
  testAudioSteps?: number;    // Steps for audio refinement pass (default 5, 0 = skip)
  testSampler?: string;       // Sampler for test/distilled tier (default "euler")
  // Turbo Upscale: generate at half resolution, 2x latent upscale, then 3-step refinement pass
  // Dramatically faster than full-res sampling (~4x fewer pixels to denoise) with comparable quality.
  // Uses LTXVLatentUpsampler (official Lightricks spatial upscaler) + LTXVImgToVideoInplace reconditioning.
  turboUpscale?: boolean;                // Enable half-res + upscale + refine pipeline
  turboUpscaleMethod?: "latent" | "rtx_vsr"; // Upscale method: "rtx_vsr" (NVIDIA hardware, fast) or "latent" (AI latent upscaler + refinement)
  turboUpscaleRefineSteps?: number;      // Refinement steps after upscale (default 3, latent method only)
  turboUpscaleRefineStrength?: number;   // I2V reconditioning strength at full res (0-1, default 1.0, latent method only)
  turboUpscaleModel?: string;            // Latent upscale model filename (in latent_upscale_models/)
  turboUpscaleSampler?: string;          // Refinement sampler name - default "euler_cfg_pp" (override for tuning)
  turboUpscaleCustomSigmas?: string;     // Comma-separated custom sigma schedule. Empty/undefined = use auto-derived from refineSteps.
  // Full quality tier guider parameters (MultimodalGuider, only used when qualityTier === "full")
  // Test/distilled tiers use BasicGuider which ignores CFG entirely.
  videoCfg?: number;            // Video CFG strength (default 3, Lightricks recommendation)
  audioCfg?: number;            // Audio CFG strength (default 7)
  videoCfgRescale?: number;     // Video CFG rescale - prevents over-saturation (default 0.7)
  audioCfgRescale?: number;     // Audio CFG rescale (default 0.7)
  stg?: number;                 // Spatio-Temporal Guidance - extra structural coherence (default 0.0)
  // Full tier sampling controls (Official pipeline, qualityTier === "full")
  fullSteps?: number;           // Sampling steps for full tier (default 15, range 8-30)
  fullEta?: number;             // ClownSampler_Beta stochasticity (default 0.25, range 0-1)
  fullSampler?: string;         // Full tier sampler (default "exponential/res_2s")
  // Full tier scheduler shift: controls sigma distribution based on latent token count.
  // Higher shift = more emphasis on early (high-noise) steps. Tuned by Lightricks per resolution.
  schedulerShift?: number;      // Sigma shift (default 2.05)
  schedulerBaseShift?: number;  // Base shift (default 0.95)
  schedulerTerminal?: number;   // Minimum non-zero sigma before 0 (default 0.1)
  // Distilled tier step count override (Official pipeline, qualityTier === "distilled")
  // Overrides the default 8-step distilled sigma schedule with a subsampled schedule.
  distilledSteps?: number;      // Steps for distilled tier (default 8, range 4-12)
  // Live preview decode frequency: how often the tiny VAE decodes a frame during sampling.
  // Lower = more frequent previews (more VRAM/CPU overhead). 1 = every step.
  previewRate?: number;         // Preview decode interval (default 8, range 1-16)
  // I2V source image conditioning strength
  // Controls how strongly the source image anchors generation (all tiers).
  // 1.0 = full fidelity to source, lower = more creative freedom.
  i2vStrength?: number;         // Source image guide strength (default 1.0)
  // Perfect Loop: inject the source image as a guide at both the first AND last frame,
  // so the model generates a seamless cycle that returns to the starting point.
  // Requires a source image. The end-frame strength is slightly reduced (default 0.85)
  // to give the model natural "landing room" for a smooth transition.
  perfectLoop?: boolean;                   // Enable perfect loop mode
  perfectLoopEndStrength?: number;         // Last-frame guide strength (default 0.85)
  // GGUF Quantization: use GGUF-format models via ComfyUI-GGUF nodes for dramatically lower VRAM.
  // Enables 1080p+ generation on consumer GPUs by reducing UNET from ~22GB to ~12-18GB
  // and CLIP from ~12GB to ~7GB. Requires ComfyUI-GGUF custom node.
  useGGUF?: boolean;                     // Use GGUF loader nodes instead of standard loaders
  ggufDiffusionModel?: string;           // GGUF UNET file in unet/ (e.g. ltx-2.3-22b-distilled-Q6_K.gguf)
  ggufTextEncoder?: string;              // GGUF Gemma file in clip/ (e.g. gemma-3-12b-it-qat-Q4_0.gguf)
  // Spatio-Temporal Tiled VAE: aggressive tiled decode for 1080p+ output
  // Uses LTXVSpatioTemporalTiledVAEDecode instead of VAEDecodeTiled (handles large resolutions better)
  spatioTemporalVAE?: boolean;           // Enable spatio-temporal tiled VAE decode
  spatioTemporalTiles?: number;          // Number of spatial tiles (default 4)
  spatioTemporalOverlap?: number;        // Spatial overlap between tiles (default 4)
  spatioTemporalLength?: number;         // Temporal tile length in frames (default 16)
  spatioTemporalTempOverlap?: number;    // Temporal overlap in frames (default 4)
  // ── Sampling Mode (1080p+ anti-repetition) ──
  // "standard": normal single-pass sampling (default)
  // "tiled": LTXVTiledSampler splits spatial dimension into overlapping tiles during diffusion.
  //              Prevents 2×2 subject-repetition at high res. Requires STGGuider.
  // "2stage": 2-stage pipeline: generate at ~70% res, LTXVLatentUpsampler 1.5×, refine at low denoise.
  //              Avoids attention breakdown by doing structural gen at lower token count.
  samplingMode?: "standard" | "tiled" | "2stage";
  tiledSamplingHTiles?: number;          // Horizontal tiles (default: auto based on aspect)
  tiledSamplingVTiles?: number;          // Vertical tiles (default: auto based on aspect)
  tiledSamplingOverlap?: number;         // Tile overlap in latent units (default 4)
  tiledSamplingSTG?: number;             // STG scale for tiled guider (default 0 for distilled)
  tiledSamplingCFG?: number;             // CFG scale for tiled guider (default 1 for distilled)
  tiledSamplingCondStrength?: number;    // Latent conditioning strength between tiles (default 0.15)
  // 2-stage mode params
  twoStageUpscaleFactor?: number;        // Spatial upscale factor (default 1.5)
  twoStageDenoise?: number;              // Stage-2 denoise strength (default 0.15, low = refinement only)
  // ── V2V Inpaint / Edit Video (LTX 2.3) ──
  // Region-targeted editing of an existing video using a mask + inpaint LoRA.
  // Source video frames pass through VAE encode → SetLatentNoiseMask → inpaint LoRA → sampler.
  // The mask determines which pixels are regenerated; everything else is preserved.
  // Mask source can be: manual paint, or SAM2-tracked video propagation.
  editVideoMode?: boolean;              // Enable V2V inpaint edit mode
  editVideoSourceFile?: string;         // Source video - ABSOLUTE filesystem path. VHS_LoadVideoPath validates with os.path.isfile() (VideoHelperSuite utils.py:322), so input-relative forms are rejected. LTX2Studio resolves uploadVideo()'s relative form to absolute via /api/comfyui/abs-input-path before storing it here.
  editVideoMaskFile?: string;           // Mask: when a static PNG, ComfyUI-input-relative filename (LoadImage handles input-relative). When a SAM2-produced video MP4, ABSOLUTE filesystem path (VHS_LoadVideoPath path requirement) - sam2-track returns this form directly.
  editVideoReferenceImage?: string;     // [LEGACY] Single reference image filename. Kept for back-compat, when set and `editVideoReferenceImages` is empty, treated as one ref at frame_idx 0.
  editVideoReferenceImages?: Array<{    // Multi-reference: up to 4 images injected as LTXVAddGuideMulti guides at chosen frame indices.
    file: string;                       // ComfyUI input/ filename
    frameIdx: number;                   // 0..(numFrames-1) - where to anchor this view in time
    strength?: number;                  // Per-guide strength override (default = config.i2vStrength)
  }>;
  editVideoLoraName?: string;           // Inpaint LoRA filename in loras/ (recommended: ltx23_inpaint_masked_r2v_rank32_v1_3000steps.safetensors)
  editVideoLoraStrength?: number;       // Inpaint LoRA strength (default 1.0 - these LoRAs are designed for full strength)
  editVideoBlockifyMaskSize?: number;   // KJNodes BlockifyMask size - matches LoRA training mask granularity (default 8, range 0-512; 0 = disable)
  editVideoMaskGrow?: number;           // LTXVPreprocessMasks grow_mask pixels (default 8, range -32..64)
  editVideoMaskClampMin?: number;       // LTXVPreprocessMasks clamp_min - minimum opacity for masked region (default 0.5)
  editVideoMaskSource?: "manual" | "sam2-tracked"; // Mask provenance
  editVideoTrackMask?: boolean;         // Use SAM2 video predictor to propagate mask through frames
  // V2V Inpaint pipeline selector: added 2026-05-12 to A/B test against the LoRA author's reference graph.
  //   "noise-mask" (default, original Vek-Snap path): VAE-encode source unchanged → SetLatentNoiseMask binds the
  //     processed mask to the latent. Sampler only injects noise where mask>0. Latent-space gating.
  //   "magenta-fill" (Alissonerdx pattern from `1_New_Workflow/NEW/`): the mask is rendered into the source
  //     PIXELS as a flat color (magenta or white) via ImageCompositeMasked; the modified source is then
  //     LTXVPreprocess-compressed, VAE-encoded, and fed BOTH as the latent AND as image_1 of LTXVAddGuideMulti.
  //     This matches the conditioning the author trained the inpaint LoRAs against, the model literally
  //     learned "magenta=regenerate this region."
  editVideoPipeline?: "noise-mask" | "magenta-fill";
  // Fill color for the magenta-fill pipeline. "auto" picks magenta when the LoRA filename contains "r2v"
  // (reference-targeted inpaint LoRAs trained on FF00FF) and white otherwise (text-only t2v inpaint LoRAs
  // trained on FFFFFF). Per the author's `ltx23_inpaint_v1.json` (white) vs `ltx23_masked_ref_inpaint_v1.json` (magenta).
  editVideoFillColor?: "auto" | "magenta" | "white";
  // Workflow metadata embedding: when true, VHS_VideoCombine writes the full ComfyUI
  // prompt + workflow JSON into the output video file's metadata (ffmpeg -metadata).
  // Enables round-trip: load a video back into Vek-Snap to recover all generation settings.
  // Persisted in localStorage so the toggle survives page reloads.
  embedWorkflowMetadata?: boolean;
  // ── Hook LoRA Schedule Mode ──
  // Controls whether hook scheduling is configured per-LoRA or applied uniformly to all.
  loraScheduleMode?: "none" | "per_lora" | "all";  // default: "none"
  // Global schedule params (used when loraScheduleMode === "all"):
  globalScheduleStartPercent?: number;
  globalScheduleEndPercent?: number;
  globalScheduleStrengthStart?: number;
  globalScheduleStrengthEnd?: number;
  globalScheduleKeyframes?: number;
  globalScheduleInterpolation?: "linear" | "ease_in" | "ease_out";

  // ── Prompt Relay (Temporal LoRA / Prompt Scheduling) ──
  // Replaces single prompt with timeline segments. Each segment's text (including LoRA trigger words)
  // is attention-masked to its proportional time region of the video.
  // Requires: ComfyUI-PromptRelay custom node (kijai/ComfyUI-PromptRelay)
  promptRelay?: boolean;                  // Enable Prompt Relay timeline mode
  promptRelayGlobal?: string;             // Global prompt: persistent scene description anchoring the entire video
  promptRelaySegments?: TimelineSegment[];// Ordered timeline segments with per-segment prompts
  promptRelayEpsilon?: number;            // Boundary sharpness (0.001 = hard cut, 0.5+ = soft blend, default 0.001)
  // 10S Character Consistency (identity stabilization via PyTorch hooks on LTX2 DiT)
  likenessEnabled?: boolean;              // Enable 10S Likeness Guide + Anchor system
  likenessImage?: string;                 // Reference image filename in ComfyUI input/ (empty = use sourceImage)
  likenessAnchorStrength?: number;        // LikenessAnchor pull magnitude (author default 0.50, README says 0.08-0.18)
  likenessSimThreshold?: number;          // Cosine similarity threshold for token matching (default 0.50)
  likenessDecay?: number;                 // Per-frame strength decay from frame 0 (0 = uniform, default 0.0)
  likenessPullMode?: "directional" | "additive"; // directional preserves color, additive is legacy
  likenessLateBlockFalloff?: number;      // Strength falloff in last 12 blocks (0-1, default 0.4)
  likenessFaceDetect?: "auto" | "none";   // auto = detect face bbox, none = full body/whole frame mode
  likenessRefMaskMode?: "bbox_softfade" | "bbox_only" | "whole_frame"; // How to mask the reference latent
  // ── Retake / Extend (native continuity editing of an existing video) ──
  // Both load a source video (VHS_LoadVideoPath, ABSOLUTE path), VAE-encode it, then use
  // LTXVSetAudioVideoMaskByTime to FREEZE the "keep" region (mask 0.0) and REGENERATE the
  // "target" region (window set to 1.0) in a single native pass, preserved frames are never
  // re-diffused, so there is no seam or quality drift.
  //   "retake": regenerate only [retakeStart, retakeEnd] seconds; everything else frozen.
  //   "extend": LTXVAddLatents(sourceLatent, emptyTail) → freeze [0, sourceDur], generate the tail.
  continuityMode?: "off" | "retake" | "extend";
  continuitySourceVideo?: string;    // ABSOLUTE fs path to the source video (VHS_LoadVideoPath requires absolute)
  continuitySourceFrames?: number;   // frame count of the source clip at the target frame rate (drives the freeze window + extend math)
  // Retake window (seconds, relative to the start of the source clip)
  retakeStart?: number;              // default 0
  retakeEnd?: number;                // default = source duration
  retakeRegenAudio?: boolean;        // also regenerate audio inside the window (default false = keep original audio untouched)
  // Extend
  extendSeconds?: number;            // seconds of NEW content to append after the source (UI sets numFrames = sourceFrames + this*fps, snapped to 8n+1)
  extendFreezeSourceAudio?: boolean; // keep the source's audio in [0, sourceDur] and only generate the tail's audio (default true)

  // ── Autoregressive Long-Form ("Top-Tier" character consistency) ──
  // Native LTX long video via LTXVLoopingSampler (custom_nodes/ComfyUI-LTXVideo/looping_sampler.py):
  // one continuous job that autoregressively extends across overlapping temporal tiles, keeping a
  // negative-index "long memory" latent for global identity/scene coherence. Replaces the lossy
  // decoded-last-frame chaining for long segments. Requires an STGGuiderAdvanced guider.
  // VIDEO-ONLY in v1 (audio TBD). Experimental, surfaced with a "use with caution" GUI label.
  autoregressiveEnabled?: boolean;          // master toggle - route this generation through LTXVLoopingSampler
  arTemporalTileSize?: number;              // LTXVLoopingSampler temporal_tile_size (pixel frames; default 80, 24-1000, step 8)
  arTemporalOverlap?: number;               // temporal_overlap (pixel frames; default 24, 16-80, step 8; ~1/3 of tile size)
  arTemporalOverlapCondStrength?: number;   // temporal_overlap_cond_strength (0-1; default 0.5; higher = stronger continuity)
  arCondImageStrength?: number;             // cond_image_strength for the first-frame / keyframe images (0-1; default 1.0)
  arAdainFactor?: number;                   // adain_factor to curb accumulated oversaturation on long runs (0-1; 0.1-0.3 recommended)
  arGuidingStrength?: number;               // guiding_strength when IC-LoRA guiding latents are provided (0-1; default 1.0)
  // Negative-index long-memory identity anchor (encode a reference image → latent → optional_negative_index_latents)
  arNegativeIndexEnabled?: boolean;         // build + feed a negative-index memory latent for global coherence (default true)
  arNegativeIndexImage?: string;            // ABSOLUTE fs path / uploaded ref image for the identity anchor (falls back to sourceImage)
  arNegativeIndexStrength?: number;         // optional_negative_index_strength (0-1; default 1.0)
  // Spatial tiling for >base-resolution on constrained VRAM (one tile in memory at a time)
  arHorizontalTiles?: number;               // horizontal_tiles (1-6; default 1)
  arVerticalTiles?: number;                 // vertical_tiles (1-6; default 1)
  arSpatialOverlap?: number;                // spatial_overlap in latent pixels (1-8; default 1)
  // Opt-in advanced guidance for the autoregressive loop. OFF by default keeps the
  // guider at the validated distilled regime (cfg=1, stg=0). When ON, the loop's
  // STGGuiderAdvanced arrays are driven by videoCfg / stg / videoCfgRescale.
  arGuidanceOverride?: boolean;
}

export const LTX2_DEFAULTS: LTX2Config = {
  prompt: "",
  width: 768,
  height: 512,
  numFrames: 97,
  frameRate: 24,
  seed: -1,
  randomSeed: true,
  sourceImage: "",
  enableAudio: true,
  diffusionModel: "ltx-2-19b-dev-fp4.safetensors",
  textEncoder: "gemma_3_12B_it_fp8_scaled.safetensors",
  connectorModel: "ltx-2-19b-embeddings_connector_distill_bf16.safetensors",
  videoVae: "LTX2_video_vae_bf16.safetensors",
  audioVae: "LTX2_audio_vae_bf16.safetensors",
  distillLoRA: "ltx-2-19b-distilled-lora-384.safetensors",
  distillLoRAStrength: 1.0,
  userLoras: [],
  videoNormFactors: "1,1,1,1,1,1,1,1",
  audioNormFactors: "1,1,0.25,1,1,0.25,1,1",
  videoScale: 1.0,
  audioScale: 1.0,
  audioToVideoScale: 1.0,
  videoToAudioScale: 1.0,
  vaeTileSize: 512,
  vaeOverlap: 64,
  vaeTemporalSize: 64,
  vaeTemporalOverlap: 16,
  ffChunks: 4,
  ffDimThreshold: 4096,
  imgCompression: 28,
  modelBasePath: "",
  modelVersion: "2.0",
  pipelineMode: "alternative",
  qualityTier: "distilled",
  officialAdvanced: false,   // LTX-2 Studio starts on the stock Lightricks recipe
  negativePrompt: "worst quality, inconsistent motion, blurry, jittery, distorted",
  stylePreset: "none",
  icLoraMode: false,
  icLoraName: "",
  icLoraStrength: 1.0,
  guideVideoFile: "",
  guideStrength: 1.0,
  guideFrameLoadCap: 0,
  motionTracks: [],
  motionTrackLoRA: "",
  motionTrackLoRAStrength: 1.0,
  motionTrackGuideStrength: 1.0,
  // Character Consistency: Reference Sheet (official IC-LoRA "Ingredients"), off by default
  ingredientsMode: false,
  ingredientsLoRAName: "",
  ingredientsLoRAStrength: 1.4,
  referenceSheetImage: "",
  referenceSheetStrength: 1.0,
  ingredientsUseSourceFrame: false,
  ingredientsSourceFrameStrength: 0.65,
  ingredientsUseEndFrame: false,
  ingredientsEndFrameStrength: 0.65,
  ingredientsEndFrameImage: "",
  samplingMode: "standard",
  tiledSamplingHTiles: 1,
  tiledSamplingVTiles: 2,
  tiledSamplingOverlap: 4,
  tiledSamplingSTG: 0,
  tiledSamplingCFG: 1.0,
  tiledSamplingCondStrength: 0.15,
  twoStageUpscaleFactor: 1.5,
  twoStageDenoise: 0.15,
  testVideoSteps: 3,
  testAudioSteps: 5,
  testSampler: "euler",
  // V2V Inpaint defaults: recommended values per Alissonerdx LoRA author's notes
  editVideoMode: false,
  editVideoSourceFile: "",
  editVideoMaskFile: "",
  editVideoReferenceImage: "",
  editVideoReferenceImages: [],
  editVideoLoraName: "ltx23_inpaint_masked_r2v_rank32_v1_3000steps.safetensors",
  editVideoLoraStrength: 1.0,
  editVideoBlockifyMaskSize: 8,
  editVideoMaskGrow: 8,
  editVideoMaskClampMin: 0.5,
  editVideoMaskSource: "manual",
  editVideoTrackMask: false,
  // Default to "noise-mask" so existing tests/state behave as before.
  // Switch to "magenta-fill" via UI to A/B test against the author's reference pattern.
  editVideoPipeline: "noise-mask",
  editVideoFillColor: "auto",
  embedWorkflowMetadata: false,
  // Retake / Extend
  continuityMode: "off",
  continuitySourceVideo: "",
  continuitySourceFrames: 0,
  retakeStart: 0,
  retakeEnd: 0,
  retakeRegenAudio: false,
  extendSeconds: 3,
  extendFreezeSourceAudio: true,
  // Autoregressive Long-Form (Top-Tier): off by default; matches LTXVLoopingSampler node defaults.
  autoregressiveEnabled: false,
  arTemporalTileSize: 80,
  arTemporalOverlap: 24,
  arTemporalOverlapCondStrength: 0.5,
  arCondImageStrength: 1.0,
  arAdainFactor: 0.15,
  arGuidingStrength: 1.0,
  arNegativeIndexEnabled: true,
  arNegativeIndexImage: "",
  arNegativeIndexStrength: 1.0,
  arHorizontalTiles: 1,
  arVerticalTiles: 1,
  arSpatialOverlap: 1,
  arGuidanceOverride: false,
};

// Recommended inpaint LoRA filenames (Alissonerdx/LTX-LoRAs HF repo)
// Place in: ComfyUI/models/loras/ (or your configured model base path)
export const LTX23_INPAINT_LORAS = [
  {
    filename: "ltx23_inpaint_masked_r2v_rank32_v1_3000steps.safetensors",
    label: "Masked R2V (recommended): works with or without reference image",
    supportsReference: true,
  },
  {
    filename: "ltx23_inpaint_rank128_v1_02500steps.safetensors",
    label: "Standard 2500-step: better prompt adherence",
    supportsReference: false,
  },
  {
    filename: "ltx23_inpaint_rank128_v1_10000steps.safetensors",
    label: "Standard 10000-step: better mask region use",
    supportsReference: false,
  },
] as const;

// GGUF model defaults for LTX-2.3 (Unsloth quantizations)
export const LTX23_GGUF_DEFAULTS = {
  ggufDiffusionModel: "ltx-2.3-22b-distilled-Q6_K.gguf",
  ggufTextEncoder: "gemma-3-12b-it-qat-Q4_0.gguf",
  connectorModel: "ltx-2.3-22b-distilled_embeddings_connectors.safetensors",
  // GGUF distilled models have distillation baked in, no LoRA needed
  distillLoRA: "",
  distillLoRAStrength: 0,
} as const;

// Turbo Upscale constants (latent spatial upscaler + refinement pass)
export const TURBO_UPSCALE_DEFAULTS = {
  method: "latent" as "latent" | "rtx_vsr",
  refineSteps: 3,
  refineStrength: 1.0,
  model: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
  // Detailer sigmas: 3-step schedule from reference workflow (front-loaded for detail recovery)
  refineSigmas: [0.85, 0.725, 0.4219, 0.0],
  sampler: "euler_cfg_pp",
  rtxVsrQuality: "ULTRA" as "LOW" | "MEDIUM" | "HIGH" | "ULTRA",
} as const;

// Default negative prompt for official pipeline
export const LTX2_OFFICIAL_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly, worst quality, blurry, jittery";

// Default NAG (Negative Attention Guidance) prompt, proven to suppress subtitle/text generation
// Especially effective with non-Latin dialogue prompts where the model renders subtitles
export const LTX2_NAG_DEFAULT_PROMPT = "cartoon, still image, bad quality, subtitles, text, watermark, overlay effects, captions, words, letters";

// Official pipeline GuiderParameters defaults
export const LTX2_OFFICIAL_GUIDER_PARAMS = {
  // Full quality tier: MultimodalGuider settings
  audio: { cfg: 7, rescale: 0.7 },
  video: { cfg: 3, rescale: 0.7 },
} as const;

// Official LTXVScheduler defaults (full quality tier)
export const LTX2_OFFICIAL_SCHEDULER = {
  steps: 15,
  shift: 2.05,
  baseShift: 0.95,
  stretch: true,
  terminal: 0.1,
} as const;

// LTX-2.3 model file defaults (Kijai ComfyUI-optimized split files)
// Diffusion: fp8_input_scaled_v2 for RTX 40xx+/50xx FP8 matmul support
// Uses NEW VAEs and text projection (not backwards-compatible with 2.0 VAEs)
export const LTX23_MODEL_DEFAULTS = {
  diffusionModel: "ltx-2.3-22b-dev-fp8.safetensors",
  textEncoder: "gemma_3_12B_it_fp4_mixed.safetensors",
  connectorModel: "ltx-2.3_text_projection_bf16.safetensors",
  videoVae: "LTX23_video_vae_bf16.safetensors",
  audioVae: "LTX23_audio_vae_bf16.safetensors",
  distillLoRA: "LTX-2.3\\ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
} as const;

export const LTX25_MODEL_DEFAULTS = {
  diffusionModel: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", // template-proven pairing w/ int8-convrot with-proj encoder; models/diffusion_models
  diffusionModelNvfp4: "ltx-2.5-22b-distilled-transformer-nvfp4.safetensors",    // Blackwell-native but NOT paired w/ any official encoder (stage-1 matmul mismatch)
  textEncoder: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",  // projection baked in; models/text_encoders
  textEncoderAux: "gemma4_e2b_it_bf16.safetensors",                            // 2nd Gemma4 (prompt enhancer / aux)
  videoVae: "ltx-2.5-video-vae-bf16.safetensors",
  audioVae: "ltx-2.5-audio-vae-bf16.safetensors",
  distillLoRA: "ltx-2.5-22b-distilled-lora-450-bf16.safetensors",
  spatialUpscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",  // models/latent_upscale_models
  durationHead: "ltx-2.5-duration-head-bf16.safetensors",                      // models/model_patches (auto-duration)
} as const;

// Helper: get LTX-2 model defaults for a given version
export function getLTX2ModelDefaults(version: LTX2ModelVersion): Partial<LTX2Config> {
  if (version === "2.5") {
    // 2.5 file defaults (int8-convrot DiT + Gemma4 with-proj encoder). connectorModel is
    // intentionally cleared: 2.5 bakes the projection into the encoder.
    return {
      diffusionModel: LTX25_MODEL_DEFAULTS.diffusionModel,
      textEncoder: LTX25_MODEL_DEFAULTS.textEncoder,
      connectorModel: "",
      videoVae: LTX25_MODEL_DEFAULTS.videoVae,
      audioVae: LTX25_MODEL_DEFAULTS.audioVae,
      distillLoRA: LTX25_MODEL_DEFAULTS.distillLoRA,
      spatialUpscaler: LTX25_MODEL_DEFAULTS.spatialUpscaler,
      textEncoderAux: LTX25_MODEL_DEFAULTS.textEncoderAux,
      durationHead: LTX25_MODEL_DEFAULTS.durationHead,
      modelVersion: "2.5",
    };
  }
  if (version === "2.3") {
    return {
      diffusionModel: LTX23_MODEL_DEFAULTS.diffusionModel,
      textEncoder: LTX23_MODEL_DEFAULTS.textEncoder,
      connectorModel: LTX23_MODEL_DEFAULTS.connectorModel,
      videoVae: LTX23_MODEL_DEFAULTS.videoVae,
      audioVae: LTX23_MODEL_DEFAULTS.audioVae,
      distillLoRA: LTX23_MODEL_DEFAULTS.distillLoRA,
      modelVersion: "2.3",
    };
  }
  return {
    diffusionModel: LTX2_DEFAULTS.diffusionModel,
    textEncoder: LTX2_DEFAULTS.textEncoder,
    connectorModel: LTX2_DEFAULTS.connectorModel,
    videoVae: LTX2_DEFAULTS.videoVae,
    audioVae: LTX2_DEFAULTS.audioVae,
    distillLoRA: LTX2_DEFAULTS.distillLoRA,
    modelVersion: "2.0",
  };
}

// Default config for the dedicated LTX-2.5 Studio (pop-out, blank-canvas). Reuses the full
// LTX2Config shape (so every required field is present) with the 2.5 model files + a modest
// default resolution/duration tuned for the 16 GB RTX 5070 Ti. The 2.5 builder generates the
// two-stage distilled AV graph; pipelineMode/qualityTier are inherited but unused by it.
export const LTX25_DEFAULTS: LTX2Config = {
  ...LTX2_DEFAULTS,
  modelVersion: "2.5",
  diffusionModel: LTX25_MODEL_DEFAULTS.diffusionModel,
  textEncoder: LTX25_MODEL_DEFAULTS.textEncoder,
  connectorModel: "",
  videoVae: LTX25_MODEL_DEFAULTS.videoVae,
  audioVae: LTX25_MODEL_DEFAULTS.audioVae,
  distillLoRA: LTX25_MODEL_DEFAULTS.distillLoRA,
  spatialUpscaler: LTX25_MODEL_DEFAULTS.spatialUpscaler,
  textEncoderAux: LTX25_MODEL_DEFAULTS.textEncoderAux,
  durationHead: LTX25_MODEL_DEFAULTS.durationHead,
  promptEnhance: false,
  width: 1280,
  height: 704,
  numFrames: 97,      // 8n+1 → ~4 s at 24 fps
  frameRate: 24,
  enableAudio: true,
  negativePrompt: "pc game, console game, video game, cartoon, childish, ugly",
  ltx25BaseSteps: 8,
  ltx25RefineSteps: 3,
  ltx25Sampler: "euler_ancestral",
  ltx25VideoCfg: 1,
  ltx25AudioCfg: 1,
  ltx25AutoDuration: false,
  ltx25AutoDurationMin: 1,
  ltx25AutoDurationMax: 20,
  userLoras: [],
};

// Available LTX-2 diffusion model checkpoints (main model selector)
// Each entry maps a diffusion model file to its version affinity and companion models
export interface LTX2CheckpointPreset {
  label: string;
  diffusionModel: string;
  version: LTX2ModelVersion;
  description: string;
  // Optional recommended distill LoRA override for this checkpoint
  recommendedDistillLoRA?: string;
  recommendedDistillLoRAStrength?: number;
}

export const LTX2_CHECKPOINT_PRESETS: LTX2CheckpointPreset[] = [
  // v2.3 checkpoints
  {
    label: "🚀 LTX 2.3 Dev NVFP4 (Blackwell 2x)",
    diffusionModel: "ltx-2.3-22b-dev-nvfp4.safetensors",
    version: "2.3",
    description: "NVFP4 quantized: ~2x faster on RTX 50-series (Blackwell FP4 Tensor Cores). Auto-applies: full tier, 20 steps, CFG 4, RTX VSR upscale.",
  },
  {
    label: "LTX 2.3 Dev FP8 (Official)",
    diffusionModel: "ltx-2.3-22b-dev-fp8.safetensors",
    version: "2.3",
    description: "Official 22B dev model: best quality, recommended for detailed scenes + LoRA",
  },
  {
    label: "LTX 2.3 Distilled v1.1",
    diffusionModel: "ltx-2.3-22b-distilled-1.1.safetensors",
    version: "2.3",
    description: "Distilled v1.1: standalone 8-step model, improved quality over original distilled",
  },
  {
    label: "⚡ LTX 2.3 GGUF Distilled Q6_K",
    diffusionModel: "ltx-2.3-22b-distilled-Q6_K.gguf",
    version: "2.3",
    description: "GGUF Q6_K (17.8 GB): massive VRAM savings, enables 1080p. Best GGUF quality.",
  },
  {
    label: "⚡ LTX 2.3 GGUF Distilled Q5_K_M",
    diffusionModel: "ltx-2.3-22b-distilled-Q5_K_M.gguf",
    version: "2.3",
    description: "GGUF Q5_K_M (16.1 GB): good quality/VRAM balance for 1080p.",
  },
  {
    label: "⚡ LTX 2.3 GGUF Distilled Q4_K_M",
    diffusionModel: "ltx-2.3-22b-distilled-Q4_K_M.gguf",
    version: "2.3",
    description: "GGUF Q4_K_M (14.3 GB): lowest VRAM, slight quality trade-off.",
  },
  {
    label: "10Eros v1 (Community)",
    diffusionModel: "ltx2310eros_v1.safetensors",
    version: "2.3",
    description: "I2V-focused finetune by TenStrip: enhanced anatomy & motion. Use cond_safe distill LoRA at 1.0 for I2V.",
    recommendedDistillLoRA: "ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors",
    recommendedDistillLoRAStrength: 1.0,
  },
  {
    label: "10Eros Beta (Community)",
    diffusionModel: "ltx2310eros_beta.safetensors",
    version: "2.3",
    description: "Older beta version: enhanced anatomy and motion. Use cond_safe distill LoRA.",
    recommendedDistillLoRA: "ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors",
    recommendedDistillLoRAStrength: 1.0,
  },
  // v2.0 checkpoints
  {
    label: "LTX 2.0 Dev FP4 (Official)",
    diffusionModel: "ltx-2-19b-dev-fp4.safetensors",
    version: "2.0",
    description: "Official 19B dev model: FP4 quantized, good VRAM efficiency",
  },
  {
    label: "Sulphur Beta (Community)",
    diffusionModel: "SulphurBeta_200-LTX2.0dev_fp8.safetensors",
    version: "2.0",
    description: "Community finetune based on 2.0 dev: FP8, enhanced visuals",
  },
];

// Standalone distilled models have distillation baked into weights, no distill LoRA needed
const STANDALONE_DISTILLED_MODELS = [
  "ltx-2.3-22b-distilled-1.1.safetensors",
  // GGUF distilled models also have distillation baked in
  "ltx-2.3-22b-distilled-Q",
] as const;

export function isStandaloneDistilledModel(diffusionModel: string): boolean {
  return STANDALONE_DISTILLED_MODELS.some(m => diffusionModel.includes(m));
}

// Helper: get full model config for a selected checkpoint
// Helper: detect if a model file is GGUF format
export function isGGUFModel(diffusionModel: string): boolean {
  return diffusionModel.endsWith(".gguf");
}

export function getLTX2CheckpointConfig(diffusionModel: string): Partial<LTX2Config> {
  const preset = LTX2_CHECKPOINT_PRESETS.find(p => p.diffusionModel === diffusionModel);
  const version = preset?.version ?? "2.3";
  const base = getLTX2ModelDefaults(version);

  // GGUF models: enable GGUF loaders + spatio-temporal VAE + set GGUF-specific model files
  if (isGGUFModel(diffusionModel)) {
    return {
      ...base,
      diffusionModel,
      useGGUF: true,
      ggufDiffusionModel: diffusionModel,
      ggufTextEncoder: LTX23_GGUF_DEFAULTS.ggufTextEncoder,
      connectorModel: LTX23_GGUF_DEFAULTS.connectorModel,
      distillLoRA: LTX23_GGUF_DEFAULTS.distillLoRA,
      distillLoRAStrength: LTX23_GGUF_DEFAULTS.distillLoRAStrength,
      spatioTemporalVAE: true,
    };
  }

  // Non-GGUF: explicitly clear all GGUF-specific flags to prevent stale state
  // from persisting when switching from a GGUF model back to a standard model.
  // Without this, spread-merge config updates leave useGGUF=true from a prior selection.
  const ggufReset: Partial<LTX2Config> = {
    useGGUF: false,
    ggufDiffusionModel: "",
    ggufTextEncoder: "",
    spatioTemporalVAE: false,
  };

  // NVFP4 models: apply quality-compensating settings for FP4 quantization.
  // FP4 trades precision for ~2x speed on Blackwell, needs higher steps, CFG, and
  // Turbo Upscale (latent 2x + refinement) to recover edge sharpness and prompt adherence.
  // Requires: comfy-kitchen[cublas] + PyTorch cu130+ (both verified installed).
  if (diffusionModel.includes("nvfp4")) {
    return {
      ...base,
      ...ggufReset,
      diffusionModel,
      pipelineMode: "official" as LTX2PipelineMode,  // Full tier needs official pipeline (MultimodalGuider + CFG)
      qualityTier: "full" as LTX2QualityTier,
      fullSteps: 20,          // Extra steps (vs 15 default) - gives quantized weights more iterations to converge
      videoCfg: 4.0,          // Slightly higher CFG (vs 3.0) - counteracts FP4 prompt drift
      videoCfgRescale: 0.7,   // Prevents over-saturation from higher CFG
      turboUpscale: false,    // Disabled by default - requires correct ltx-2.3 spatial upscaler model (v1.1)
      turboUpscaleMethod: "latent" as "latent" | "rtx_vsr",  // Latent upscale + 3-step refinement (Lightricks validated)
      distillLoRAStrength: 1.0,
    };
  }

  // Standalone distilled models don't use the distill LoRA
  if (isStandaloneDistilledModel(diffusionModel)) {
    return { ...base, ...ggufReset, diffusionModel, distillLoRA: "", distillLoRAStrength: 0 };
  }

  // Apply recommended distill LoRA if the preset specifies one
  if (preset?.recommendedDistillLoRA) {
    return {
      ...base,
      ...ggufReset,
      diffusionModel,
      distillLoRA: preset.recommendedDistillLoRA,
      distillLoRAStrength: preset.recommendedDistillLoRAStrength ?? base.distillLoRAStrength ?? 0.75,
    };
  }

  return { ...base, ...ggufReset, diffusionModel };
}

// Distilled sigma schedule (shared by both Alternative and Official workflows, 8 steps)
export const LTX2_DISTILLED_SIGMAS = "1., 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
// 3-step test sigma schedule (subsampled from distilled for quick testing)
export const LTX2_TEST_SIGMAS = "1., 0.975, 0.421875, 0.0";

// "Gooner Magic Sauce": tested optimal settings for the test tier
// Result of 40+ render tests: studio-grade audio, cinematic video, ~2.5 min render times
export const LTX2_MAGIC_SAUCE: Partial<LTX2Config> = {
  stylePreset: "none",
  testVideoSteps: 5,
  testAudioSteps: 8,
  testSampler: "euler",
  negativePrompt: "",
  diffusionModel: "ltx-2.3-22b-dev-fp8.safetensors",
  distillLoRAStrength: 0.75,
  directSampling: false,
  imgCompression: 15,
  qualityTier: "test",
  pipelineMode: "official",
};

// Official pipeline distill LoRA strengths (different per quality tier)
export const LTX2_OFFICIAL_LORA_STRENGTH = {
  test: 0.5,       // Quick 3-step test path
  distilled: 0.5,  // Fast 8-step path
  full: 0.2,       // 15-step refinement path
} as const;

export const LTX2_PROMPT_PRESETS = [
  {
    label: "Ocean Sunset",
    prompt: "A cinematic drone shot flying over a turquoise ocean at golden hour, waves crashing against rocky cliffs, seabirds soaring through warm light, ambient ocean sounds and wind",
  },
  {
    label: "City Timelapse",
    prompt: "A smooth timelapse of a bustling city intersection at night, neon signs reflecting on wet pavement, cars leaving light trails, pedestrians moving quickly, urban ambient soundscape",
  },
  {
    label: "Forest Walk",
    prompt: "A steady first-person walk through a sunlit ancient forest, rays of light filtering through the canopy, leaves rustling, birds singing, a gentle stream trickling nearby",
  },
  {
    label: "Cat on Piano",
    prompt: "A fluffy orange cat walking across piano keys in a cozy living room, each paw pressing a different note, warm afternoon light through curtains, piano notes and soft purring",
  },
  {
    label: "Rainstorm Window",
    prompt: "Close-up of rain droplets running down a window pane, a blurred city skyline in the background with warm lights, thunder rumbling softly, rain pattering on glass",
  },
  {
    label: "Campfire Night",
    prompt: "A crackling campfire in a clearing under a starry sky, sparks floating upward, warm orange glow illuminating surrounding pine trees, fire crackling and crickets chirping",
  },
] as const;

export const LTX2_RESOLUTION_PRESETS = [
  // 16:9 / 9:16 - 1080p
  { label: "1920×1088 (1080p Landscape)", width: 1920, height: 1088, vramTier: "extreme" },
  { label: "1088×1920 (1080p Portrait)", width: 1088, height: 1920, vramTier: "extreme" },
  // 16:9 / 9:16 - 720p
  { label: "1280×720 (720p Landscape)", width: 1280, height: 720, vramTier: "high" },
  { label: "720×1280 (720p Portrait)", width: 720, height: 1280, vramTier: "high" },
  { label: "960×544 (540p Landscape)", width: 960, height: 544, vramTier: "medium" },
  { label: "544×960 (540p Portrait)", width: 544, height: 960, vramTier: "medium" },
  { label: "832×480 (Cinematic Wide)", width: 832, height: 480, vramTier: "low" },
  { label: "480×832 (Cinematic Vertical)", width: 480, height: 832, vramTier: "low" },
  // 9:16 - near-native (minimal crop from 1152×2048 / 1080×1920 sources)
  { label: "480×864 (9:16 Fast)", width: 480, height: 864, vramTier: "low" },
  { label: "864×480 (16:9 Fast)", width: 864, height: 480, vramTier: "low" },
  { label: "576×1024 (9:16 Mid)", width: 576, height: 1024, vramTier: "medium" },
  { label: "1024×576 (16:9 Mid)", width: 1024, height: 576, vramTier: "medium" },
  // 3:2 / 2:3
  { label: "768×512 (3:2 Landscape)", width: 768, height: 512, vramTier: "low" },
  { label: "512×768 (2:3 Portrait)", width: 512, height: 768, vramTier: "low" },
  // 4:3 / 3:4
  { label: "832×640 (4:3 Landscape)", width: 832, height: 640, vramTier: "medium" },
  { label: "640×832 (3:4 Portrait)", width: 640, height: 832, vramTier: "medium" },
  // 1:1
  { label: "512×512 (Square)", width: 512, height: 512, vramTier: "low" },
  { label: "704×704 (Square HD)", width: 704, height: 704, vramTier: "medium" },
  // Wide / Tall
  { label: "704×480 (Wide)", width: 704, height: 480, vramTier: "low" },
  { label: "480×704 (Tall)", width: 480, height: 704, vramTier: "low" },
  // Fast preview (ideal for rapid iteration + upscale)
  { label: "384×672 (9:16 Preview)", width: 384, height: 672, vramTier: "low" },
  { label: "672×384 (16:9 Preview)", width: 672, height: 384, vramTier: "low" },
] as const;

// Compute half-resolution for preview mode / turbo upscale (snap to multiples of 32 for LTX VAE compatibility)
export function getPreviewResolution(width: number, height: number): { width: number; height: number } {
  const snap = (v: number) => Math.max(256, Math.round(v / 2 / 32) * 32);
  return { width: snap(width), height: snap(height) };
}
// Alias for Turbo Upscale clarity, same half-res snap logic
export const getTurboHalfResolution = getPreviewResolution;

/**
 * Resolution-dependent defaults for VAE tiling, feedforward chunking, and attention scaling.
 * These must scale with pixel count to maintain motion quality and VRAM efficiency.
 *
 * The key insight: temporal VAE settings (vaeTemporalSize, vaeTemporalOverlap) are critical
 * for motion smoothness at higher resolutions, too-low values cause jerky/unnatural movement.
 * Spatial tile size and feedforward chunks primarily affect VRAM usage, not quality.
 *
 * Tiers based on total pixel count:
 *   preview  (<350k px): 384×672, 672×384 etc.
 *   low      (<500k px): 768×512, 512×768, 480×832, etc.
 *   medium   (<700k px): 960×544, 576×1024, 832×640, 704×704, etc.
 *   high     (<1.2M px): 1280×720, 720×1280
 *   extreme  (≥1.2M px): 1920×1088, 1088×1920 (1080p+)
 */
export function getResolutionScaledDefaults(width: number, height: number): {
  vaeTileSize: number;
  vaeOverlap: number;
  vaeTemporalSize: number;
  vaeTemporalOverlap: number;
  ffChunks: number;
  ffDimThreshold: number;
} {
  const pixels = width * height;

  if (pixels >= 1_200_000) {
    // 1080p+ (extreme): e.g. 1920×1088 = 2,088,960 px
    return {
      vaeTileSize: 1024,
      vaeOverlap: 64,
      vaeTemporalSize: 128,
      vaeTemporalOverlap: 32,
      ffChunks: 6,
      ffDimThreshold: 4096,
    };
  }
  if (pixels >= 700_000) {
    // 720p (high): e.g. 1280×720 = 921,600 px
    return {
      vaeTileSize: 768,
      vaeOverlap: 64,
      vaeTemporalSize: 96,
      vaeTemporalOverlap: 24,
      ffChunks: 4,
      ffDimThreshold: 4096,
    };
  }
  if (pixels >= 400_000) {
    // 540p / mid (medium): e.g. 960×544 = 522,240 px
    return {
      vaeTileSize: 512,
      vaeOverlap: 64,
      vaeTemporalSize: 64,
      vaeTemporalOverlap: 16,
      ffChunks: 4,
      ffDimThreshold: 4096,
    };
  }
  if (pixels >= 250_000) {
    // Small (low): e.g. 768×512 = 393,216 px
    return {
      vaeTileSize: 512,
      vaeOverlap: 48,
      vaeTemporalSize: 48,
      vaeTemporalOverlap: 12,
      ffChunks: 2,
      ffDimThreshold: 4096,
    };
  }
  // Preview: e.g. 384×672 = 258,048 px
  return {
    vaeTileSize: 384,
    vaeOverlap: 32,
    vaeTemporalSize: 32,
    vaeTemporalOverlap: 8,
    ffChunks: 2,
    ffDimThreshold: 4096,
  };
}

export const LTX2_FRAME_PRESETS = [
  { label: "25 (~1s)", value: 25 },
  { label: "33 (~1.4s)", value: 33 },
  { label: "41 (~1.7s)", value: 41 },
  { label: "49 (~2s)", value: 49 },
  { label: "57 (~2.4s)", value: 57 },
  { label: "65 (~2.7s)", value: 65 },
  { label: "81 (~3.4s)", value: 81 },
  { label: "97 (~4s)", value: 97 },
  { label: "113 (~4.7s)", value: 113 },
  { label: "121 (~5s)", value: 121 },
  { label: "145 (~6s)", value: 145 },
  { label: "169 (~7s)", value: 169 },
  { label: "193 (~8s)", value: 193 },
  { label: "217 (~9s)", value: 217 },
  { label: "241 (~10s)", value: 241 },
  { label: "257 (~10.7s)", value: 257 },
  { label: "289 (~12s)", value: 289 },
  { label: "321 (~13.4s)", value: 321 },
  { label: "385 (~16s)", value: 385 },
  { label: "481 (~20s)", value: 481 },
] as const;

// ── LTX-2 frame-count math ──
// LTX-2's temporal VAE requires frame counts of the form 8n+1 (e.g. 25, 97, 297).
// These helpers pin a desired duration to the nearest achievable frame count so that
// video duration (numFrames/fps) and any audio sliced to match it stay perfectly aligned
// at ANY frame rate: the root fix for music-video segment drift.

/** Snap an arbitrary frame count to the nearest valid LTX-2 8n+1 count (min 25). */
export function snapToLtx2FrameCount(frames: number): number {
  return Math.max(25, Math.round((frames - 1) / 8) * 8 + 1);
}

/** Nearest valid 8n+1 frame count whose duration (frames/fps) is closest to `durationSec`. */
export function ltx2FrameCountForDuration(durationSec: number, fps: number): number {
  return snapToLtx2FrameCount(durationSec * fps);
}

/** Exact video duration (seconds) for a given frame count at a frame rate. */
export function ltx2DurationForFrames(numFrames: number, fps: number): number {
  return numFrames / fps;
}

// Re-slice the master-audio timeline after a per-segment duration change.
// Overlap contract (must match the "Prepare Segments" handler + the assembler's 1-frame
// trim): each segment's audio slice length = numFrames/fps, but the timeline advances by
// the trimmed contribution step = (numFrames-1)/fps, so the song stays contiguous.
//
// mode "this": only the edited segment takes `newFrames`; following segments keep
//                    their own durations; trailing segments added to fill the track use the
//                    master cadence (`masterFrames`).
// mode "following": the edited segment AND every following/added segment take `newFrames`.
export interface ResegmentPlanEntry {
  startTime: number;   // slice start in the master track (seconds)
  duration: number;    // slice length = numFrames/fps (seconds)
}
export function resegmentAudioTimeline(params: {
  segments: DirectorSegment[];
  editedIdx: number;
  newFrames: number;
  mode: "this" | "following";
  fps: number;
  trackDuration: number;
  masterFrames: number;
}): { segments: DirectorSegment[]; slicePlan: ResegmentPlanEntry[]; changedStartIdx: number } {
  const { segments, editedIdx, newFrames, mode, fps, trackDuration, masterFrames } = params;
  const EPS = 1e-3;
  const result: DirectorSegment[] = segments.slice(0, editedIdx).map((s) => ({ ...s }));
  const slicePlan: ResegmentPlanEntry[] = [];

  // Cursor = start time of the edited segment, accumulated across the (untouched)
  // preceding segments using the same step math (independent of stored audioStartTime).
  let cursor = 0;
  for (let i = 0; i < editedIdx; i++) {
    cursor += (segments[i].numFrames - 1) / fps;
  }

  let i = editedIdx;
  while (cursor < trackDuration - EPS) {
    // Target frame count for this position.
    let frames: number;
    if (i === editedIdx) frames = newFrames;
    else if (mode === "following") frames = newFrames;
    else if (i < segments.length) frames = segments[i].numFrames; // "this": keep existing
    else frames = masterFrames;                                    // "this": new trailing → master cadence

    let sliceDur = frames / fps;
    let clamped = false;
    if (cursor + sliceDur > trackDuration) {
      // Final (partial) segment: snap the remaining tail to a valid frame count.
      const remaining = trackDuration - cursor;
      frames = ltx2FrameCountForDuration(remaining, fps);
      sliceDur = frames / fps;
      clamped = true;
    }
    const startTime = cursor;
    const endTime = Math.min(startTime + sliceDur, trackDuration);

    // Reuse the existing segment at this index (preserve prompt/images/energy/dialogue);
    // beyond the original length create a fresh, image-less trailing segment.
    const base = i < segments.length ? segments[i] : createDirectorSegment();
    result.push({
      ...base,
      numFrames: frames,
      audioStartTime: parseFloat(startTime.toFixed(3)),
      audioEndTime: parseFloat(endTime.toFixed(3)),
      audioSliceFile: undefined, // filled after the slice API returns
      // Re-timing invalidates any prior render of this segment.
      status: "pending",
      outputUrl: null,
      lastFrameFile: null,
      error: null,
    });
    slicePlan.push({ startTime: parseFloat(startTime.toFixed(3)), duration: parseFloat(sliceDur.toFixed(3)) });

    cursor += (frames - 1) / fps;
    i++;
    if (clamped) break; // reached the end of the track
  }

  return { segments: result, slicePlan, changedStartIdx: editedIdx };
}

// ── WAN 2.2 S2V (Sound-to-Video) types ──

// Official WAN 2.2 S2V GGUF models from QuantStack/Wan2.2-S2V-14B-GGUF
// Single model file: no H/L pair needed (unlike two-pass I2V approach)
export const WAN_S2V_MODELS = {
  S2V_Q3_K_M: "Wan2.2-S2V-14B-Q3_K_M.gguf",     // 11.4 GB - recommended for 16GB VRAM
  S2V_Q4_0:   "Wan2.2-S2V-14B-Q4_0.gguf",         // 12.8 GB
  S2V_Q4_K_S: "Wan2.2-S2V-14B-Q4_K_S.gguf",       // 13.0 GB
  S2V_Q4_K_M: "Wan2.2-S2V-14B-Q4_K_M.gguf",       // 13.9 GB
  S2V_Q5_0:   "Wan2.2-S2V-14B-Q5_0.gguf",         // 14.5 GB
  AUDIO_ENCODER: "wav2vec2_large_english_fp16.safetensors",
} as const;

// WAN S2V resolution presets (multiples of 16, common aspect ratios)
export const WAN_S2V_RESOLUTION_PRESETS = [
  // 16:9 / 9:16
  { label: "848×480 (16:9 Landscape)", width: 848, height: 480 },
  { label: "480×848 (9:16 Portrait)", width: 480, height: 848 },
  { label: "1280×720 (720p Landscape)", width: 1280, height: 720 },
  { label: "720×1280 (720p Portrait)", width: 720, height: 1280 },
  // 4:3 / 3:4
  { label: "640×480 (4:3 Standard)", width: 640, height: 480 },
  { label: "480×640 (3:4 Portrait)", width: 480, height: 640 },
  { label: "832×624 (4:3 Large)", width: 832, height: 624 },
  // 1:1
  { label: "512×512 (1:1 Square)", width: 512, height: 512 },
  { label: "704×704 (1:1 Square HD)", width: 704, height: 704 },
  // Wider/Taller
  { label: "832×480 (Wide)", width: 832, height: 480 },
  { label: "480×832 (Tall)", width: 480, height: 832 },
  { label: "1024×704 (Landscape HD)", width: 1024, height: 704 },
  { label: "704×1024 (Portrait HD)", width: 704, height: 1024 },
] as const;

// WAN S2V frame presets (must be 4n+1 for WAN temporal structure)
export const WAN_S2V_FRAME_PRESETS = [41, 49, 61, 77, 81, 97, 113, 121] as const;

// WAN S2V step presets (single-pass: just total steps)
export const WAN_S2V_STEP_PRESETS = [
  { label: "Fast (8)",          pass1: 8,  total: 8  },
  { label: "Balanced (12)",     pass1: 12, total: 12 },
  { label: "Quality (20)",      pass1: 20, total: 20 },
  { label: "High Quality (30)", pass1: 30, total: 30 },
] as const;

export interface WanS2VConfig {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  frames: number;          // video frame count (4n+1)
  fps: number;
  seed: number;
  randomSeed: boolean;
  cfg: number;
  sampler: string;
  scheduler: string;
  shift: number;           // ModelSamplingSD3 shift
  // Two-pass model selection
  highModel: string;       // GGUF high-noise model (pass 1)
  lowModel: string;        // GGUF low-noise model (pass 2)
  pass1Steps: number;      // steps for high-Q first pass
  totalSteps: number;      // total steps (pass2 picks up where pass1 left off)
  // Reference image (subject/face for the video)
  refImage: string;        // ComfyUI input filename (uploaded ref image)
  // Audio (lipsync / sound-driven video)
  audioFile: string;       // ComfyUI input filename (uploaded audio)
  audioTrimStart: number;  // trim start in seconds
  audioTrimEnd: number;    // trim end in seconds
  audioLocked: boolean;    // true once audio is trimmed → video params locked
  // LoRAs
  loras: LoraEntry[];
  pairedLoras: WanPairedLoraEntry[];
}

export const WAN_S2V_DEFAULTS: WanS2VConfig = {
  prompt: "",
  negativePrompt: "text, watermark, blurry, low quality",
  width: 480,
  height: 848,
  frames: 81,
  fps: 16,
  seed: -1,
  randomSeed: true,
  cfg: 2.0,
  sampler: "uni_pc_bh2",
  scheduler: "normal",
  shift: 5.0,
  highModel: WAN_S2V_MODELS.S2V_Q3_K_M,
  lowModel: WAN_S2V_MODELS.S2V_Q3_K_M,
  pass1Steps: 20,
  totalSteps: 20,
  refImage: "",
  audioFile: "",
  audioTrimStart: 0,
  audioTrimEnd: 0,
  audioLocked: false,
  loras: [],
  pairedLoras: [],
};

// ── LoRA Trigger Word Database ──
// Maps LoRA filename substrings to trigger info. Matched via case-insensitive substring.

export interface LoRATriggerInfo {
  triggers: string[];
  tips?: string[];
  presets?: { label: string; text: string }[];
}

// Built-in trigger database for known community LoRAs.
// Vek-Snap ships no bundled LoRA triggers; users define their own trigger words
// per LoRA via the LoRA Trigger registry (persisted in localStorage).
export const LORA_TRIGGER_MAP: { pattern: string; info: LoRATriggerInfo }[] = [];

/** Look up trigger info for a LoRA by filename (case-insensitive substring match) */
export function getLoRATriggerInfo(loraName: string): LoRATriggerInfo | null {
  if (!loraName) return null;
  const lower = loraName.toLowerCase();
  for (const entry of LORA_TRIGGER_MAP) {
    if (lower.includes(entry.pattern.toLowerCase())) return entry.info;
  }
  return null;
}

// ── LoRA Factory types ──

export type LoraFactoryStep = "dataset" | "caption" | "configure" | "train" | "done";

export interface TrainingImage {
  id: string;            // unique ID
  filename: string;      // original filename
  serverPath: string;    // path on server (for display)
  caption: string;       // editable caption / tags
  tags: string[];        // parsed tag list (split from caption)
  width: number;
  height: number;
  sizeBytes: number;
  quality?: ImageQuality; // from quality analysis
}

export interface ImageQuality {
  blurScore: number;     // 0-1, higher = sharper
  isBlurry: boolean;
  isDuplicate: boolean;
  duplicateOf?: string;  // ID of similar image
  resolution: "low" | "ok" | "good";
}

export type LoraTrainingPreset = "character" | "style" | "concept" | "custom";

export interface LoraTrainingConfig {
  datasetName: string;
  preset: LoraTrainingPreset;
  baseModel: string;          // checkpoint filename
  baseModelArch: CheckpointArch; // sd15 | sdxl | zimage (zimage selected explicitly, never size-detected)
  triggerWord: string;        // e.g. "ohwx" - prepended to all captions
  resolution: number;         // training resolution (512 for SD1.5, 1024 for SDXL)
  networkRank: number;        // LoRA rank (dim) - 8, 16, 32, 64, 128
  networkAlpha: number;       // LoRA alpha - typically rank/2 or rank
  learningRate: number;       // e.g. 1e-4
  unetLr: number;             // unet learning rate
  textEncoderLr: number;      // text encoder LR (lower, e.g. 5e-5)
  epochs: number;             // training epochs
  batchSize: number;          // 2-4 on 16GB
  saveEveryNEpochs: number;   // checkpoint frequency
  optimizerType: string;      // AdamW8bit, Prodigy, etc.
  lrScheduler: string;        // cosine, constant, etc.
  mixedPrecision: "fp16" | "bf16" | "no";
  gradientCheckpointing: boolean;
  shuffleCaptions: boolean;   // randomize tag order each step
  flipAugmentation: boolean;  // horizontal flip augmentation
  outputName: string;         // output LoRA filename
  // ── Z-Image (musubi-tuner) route: only used when baseModelArch === "zimage" ──
  // Z-Image trains from separate DiT + VAE + Qwen3 text-encoder files (not a single checkpoint).
  ditModel?: string;          // Z-Image DiT weights (Base recommended), e.g. z_image_bf16.safetensors
  vaeModel?: string;          // Z-Image VAE, e.g. ae.safetensors
  textEncoder?: string;       // Qwen3 text encoder, e.g. qwen_3_4b.safetensors
  turboAdapter?: string;      // optional Turbo training adapter LoRA (applied via --base_weights)
  fp8Base?: boolean;          // fp8 DiT to fit 16GB VRAM (Turbo-drift/memory optimisation)
  fp8Llm?: boolean;           // fp8 text encoder for VRAM savings
  blocksToSwap?: number;      // CPU-offload N transformer blocks (0-28) for very tight VRAM
  discreteFlowShift?: number; // flow-match discrete shift (default 2.0)
  numRepeats?: number;        // dataset repeat count per epoch
}

export const LORA_TRAINING_PRESETS: Record<LoraTrainingPreset, Partial<LoraTrainingConfig>> = {
  character: {
    triggerWord: "ohwx",
    resolution: 512,
    networkRank: 32,
    networkAlpha: 16,
    learningRate: 1e-4,
    unetLr: 1e-4,
    textEncoderLr: 5e-5,
    epochs: 20,
    batchSize: 2,
    saveEveryNEpochs: 5,
    optimizerType: "AdamW8bit",
    lrScheduler: "cosine",
    mixedPrecision: "bf16",
    gradientCheckpointing: true,
    shuffleCaptions: true,
    flipAugmentation: true,
  },
  style: {
    triggerWord: "stylename",
    resolution: 512,
    networkRank: 64,
    networkAlpha: 32,
    learningRate: 5e-5,
    unetLr: 5e-5,
    textEncoderLr: 1e-5,
    epochs: 30,
    batchSize: 2,
    saveEveryNEpochs: 10,
    optimizerType: "AdamW8bit",
    lrScheduler: "cosine",
    mixedPrecision: "bf16",
    gradientCheckpointing: true,
    shuffleCaptions: false,
    flipAugmentation: false,
  },
  concept: {
    triggerWord: "concept_token",
    resolution: 512,
    networkRank: 16,
    networkAlpha: 8,
    learningRate: 1e-4,
    unetLr: 1e-4,
    textEncoderLr: 5e-5,
    epochs: 15,
    batchSize: 2,
    saveEveryNEpochs: 5,
    optimizerType: "AdamW8bit",
    lrScheduler: "cosine",
    mixedPrecision: "bf16",
    gradientCheckpointing: true,
    shuffleCaptions: true,
    flipAugmentation: true,
  },
  custom: {},
};

export const DEFAULT_TRAINING_CONFIG: LoraTrainingConfig = {
  datasetName: "",
  preset: "character",
  baseModel: "",
  baseModelArch: "sd15",
  triggerWord: "ohwx",
  resolution: 512,
  networkRank: 32,
  networkAlpha: 16,
  learningRate: 1e-4,
  unetLr: 1e-4,
  textEncoderLr: 5e-5,
  epochs: 20,
  batchSize: 2,
  saveEveryNEpochs: 5,
  optimizerType: "AdamW8bit",
  lrScheduler: "cosine",
  mixedPrecision: "bf16",
  gradientCheckpointing: true,
  shuffleCaptions: true,
  flipAugmentation: true,
  outputName: "my_lora",
  // Z-Image defaults (ComfyUI-packaged filenames from Comfy-Org/z_image)
  ditModel: "z_image_bf16.safetensors",
  vaeModel: "ae.safetensors",
  textEncoder: "qwen_3_4b.safetensors",
  turboAdapter: "",
  fp8Base: true,
  fp8Llm: true,
  blocksToSwap: 0,
  discreteFlowShift: 2.0,
  numRepeats: 1,
};

export const LORA_RANK_OPTIONS = [4, 8, 16, 32, 64, 128] as const;

export const LORA_OPTIMIZER_OPTIONS = [
  { value: "AdamW8bit", label: "AdamW 8-bit (recommended, low VRAM)" },
  { value: "Prodigy", label: "Prodigy (adaptive, no LR tuning)" },
  { value: "AdamW", label: "AdamW (standard, more VRAM)" },
  { value: "SGDNesterov", label: "SGD Nesterov (stable, slow)" },
] as const;

export const LORA_SCHEDULER_OPTIONS = [
  { value: "cosine", label: "Cosine (recommended)" },
  { value: "cosine_with_restarts", label: "Cosine with Restarts" },
  { value: "constant", label: "Constant" },
  { value: "constant_with_warmup", label: "Constant with Warmup" },
  { value: "polynomial", label: "Polynomial" },
] as const;

export interface TrainingProgress {
  status: "idle" | "preparing" | "training" | "complete" | "error";
  epoch: number;
  totalEpochs: number;
  step: number;
  totalSteps: number;
  loss: number;
  lossHistory: number[];  // for graphing
  sampleImages: string[]; // paths to sample outputs
  elapsedSec: number;
  estimatedRemainingSec: number;
  error?: string;
}

// Checkpoint architecture classification: determined by file size, not filename
// SD1.5: ~2GB (fp16) or ~4GB (fp32) → under 5GB
// SDXL / Pony / Illustrious: ~6.5GB (fp16) or ~13GB (fp32) → 5–15GB
// "zimage" is a trainer route (musubi-tuner), not a size-classified checkpoint;
// it is selected explicitly in the LoRA Factory UI, never returned by getCheckpointArch().
export type CheckpointArch = "sd15" | "sdxl" | "zimage";

const SIZE_SDXL_THRESHOLD = 5 * 1024 * 1024 * 1024;   // 5 GB

/** Classify a checkpoint by its file size (bytes) and optionally filename.
 *  Pass 0 / undefined if size unknown, will fall back to filename hints. */
export function getCheckpointArch(sizeBytes: number | undefined, filename?: string): CheckpointArch {
  // Size-based classification (most reliable)
  if (sizeBytes) {
    return sizeBytes >= SIZE_SDXL_THRESHOLD ? "sdxl" : "sd15";
  }
  // Fallback: filename hint when size is unavailable
  if (filename) {
    const lower = filename.toLowerCase();
    if (lower.includes("sdxl") || lower.includes("pony") || lower.includes("illustrious")) return "sdxl";
  }
  return "sd15"; // ultimate fallback
}

/** Check if a checkpoint is compatible with the given generation mode */
export function isCheckpointCompatible(sizeBytes: number | undefined, mode: GenerationMode, composeOutputType?: ComposeOutputType): boolean {
  // Wan, Wan Remix, and ZImage use their own models, checkpoint selection is irrelevant
  if (mode === "wan" || mode === "wan_remix" || mode === "zimage") return true;
  // Image and LoRA training modes work with all architectures
  if (mode === "image" || mode === "lora") return true;
  // Compose in still-image mode doesn't need AnimateDiff, all checkpoints work
  if (mode === "compose" && composeOutputType === "image") return true;
  // Video/Compose(video)/Edit modes use AnimateDiff which requires SD1.5
  return getCheckpointArch(sizeBytes) === "sd15";
}

// Context padding presets for content-aware compose
export const CONTEXT_PADDING_PRESETS = [
  { value: 0.15, label: "15% (Minimal)" },
  { value: 0.25, label: "25% (Light)" },
  { value: 0.35, label: "35% (Standard)" },
  { value: 0.50, label: "50% (Wide)" },
  { value: 0.75, label: "75% (Extra wide)" },
  { value: 1.00, label: "100% (Maximum)" },
] as const;

export type ComposeSubMode = "inpaint" | "overlay" | "combined";
export type ComposeOutputType = "image" | "video";

// Vek-Snap inpaint method: controls default settings per mode
export type InpaintMethod = "default" | "detail" | "modify";

export const INPAINT_METHODS = [
  { value: "default" as InpaintMethod, label: "Inpaint or Outpaint (default)", description: "Standard inpainting: fill or replace masked area. Denoise 1.0, field 0.618." },
  { value: "detail" as InpaintMethod, label: "Improve Detail (face, hand, eyes, etc.)", description: "Tight crop around mask, low denoise for refinement. Best for fixing details." },
  { value: "modify" as InpaintMethod, label: "Modify Content (add objects, change background)", description: "Replace masked area with new content guided by prompt. Denoise 1.0, field 0.0." },
] as const;

export const EXAMPLE_INPAINT_PROMPTS = [
  "highly detailed face",
  "detailed girl face",
  "detailed man face",
  "detailed hand",
  "beautiful eyes",
  "detailed fingers",
  "smooth skin texture",
] as const;

// ── Outpainting ──
export type OutpaintDirection = "left" | "right" | "top" | "bottom";

export interface OutpaintConfig {
  enabled: boolean;
  directions: Record<OutpaintDirection, boolean>;
  percentages: Record<OutpaintDirection, number>; // 5–100 (% of source dimension)
}

export interface OutpaintInfo {
  filledImageFile: string;    // vek-snap-filled padded image (VAE encode input)
  paddedImageFile: string;    // edge-padded original (post-composite destination)
  maskFile: string;           // binary mask - white = new area to generate
  softMaskFile: string;       // gradient mask for seamless blending
  totalWidth: number;         // padded canvas width (mult of 8)
  totalHeight: number;        // padded canvas height (mult of 8)
}

export interface RegionInfo {
  x: number;        // region top-left X in source image pixels
  y: number;        // region top-left Y in source image pixels
  width: number;    // region width (model-compatible)
  height: number;   // region height (model-compatible)
  sourceWidth: number;   // original source image width
  sourceHeight: number;  // original source image height
  sourceImageFile: string; // filename after upload to ComfyUI
  // Content-aware inpainting fields (set when contentAware is ON)
  contextImageFile?: string; // padded context crop uploaded to ComfyUI
  maskImageFile?: string;    // mask image uploaded to ComfyUI
  padLeft?: number;          // padding pixels on left (multiple of 8)
  padTop?: number;           // padding pixels on top (multiple of 8)
  contextWidth?: number;     // total padded crop width
  contextHeight?: number;    // total padded crop height
  // Vek-Snap inpainting: fill + soft mask for seamless compositing
  filledImageFile?: string;  // vekSnapFill result - smooth color fill in masked area
  softMaskFile?: string;     // morphological_open result - gradient mask for post-composite
  // Vek-Snap intelligent crop (paint-mask path only):
  // When set, the context/mask were cropped around the mask bbox and scaled to ~1024.
  // Post-composite must scale result back to cropW×cropH and paste at (cropX, cropY).
  cropX?: number;     // crop region left in original image pixels
  cropY?: number;     // crop region top in original image pixels
  cropW?: number;     // crop region width in original image pixels
  cropH?: number;     // crop region height in original image pixels
}

// Common upscaler models for Enhance Details (placed in ComfyUI/models/upscale_models/)
// NOTE: 4x-UltraSharp / UltraMix (CC-BY-NC-SA) and SUPIR (non-commercial) are
// intentionally excluded: they cannot be bundled/distributed in a commercial
// product. Only permissively licensed upscalers belong here. See
// VEK-SNAP_Deployment_Plan/Vek-Snap Commercial/Upscaler_Model_Licenses/.
export const ENHANCE_UPSCALER_MODELS = [
  { value: "RealESRGAN_x4plus.pth", label: "RealESRGAN x4+" },
  { value: "RealESRGAN_x4plus_anime_6B.pth", label: "RealESRGAN x4+ Anime" },
  { value: "4x_NMKD-Siax_200k.pth", label: "4x NMKD-Siax" },
  { value: "ESRGAN_4x.pth", label: "ESRGAN 4x" },
] as const;

// Standalone image upscalers for the post-generation "Upscale selected" feature.
// COMMERCIAL-SAFE ONLY: RealESRGAN_x4plus = BSD-3, 4x_NMKD-Superscale = WTFPL.
// Both are native 4x ESRGAN models. Do NOT add CC-BY-NC (UltraSharp/UltraMix) or
// SUPIR here: see Vek-Snap Commercial/Upscaler_Model_Licenses/.
export const IMAGE_UPSCALE_MODELS = [
  { value: "RealESRGAN_x4plus.pth", label: "RealESRGAN x4+ (photoreal)" },
  { value: "4x_NMKD-Superscale-SP_178000_G.pth", label: "NMKD Superscale (sharp)" },
] as const;

export const IMAGE_UPSCALE_FACTORS = [
  { value: 2, label: "2x" },
  { value: 4, label: "4x" },
] as const;

// Smart Upscale modes and scale presets
export const UPSCALE_MODES = [
  { value: "off", label: "Off" },
  { value: "fast", label: "Fast (ESRGAN only)" },
  { value: "quality", label: "Quality (ESRGAN + diffusion)" },
] as const;

export const UPSCALE_SCALE_PRESETS = [
  { value: 1.5, label: "1.5x" },
  { value: 2.0, label: "2x" },
  { value: 4.0, label: "4x" },
] as const;

// Predefined region sizes for compose mode (must be model-compatible)
export const REGION_SIZE_PRESETS = [
  { label: "512×512 (SD1.5 square)", width: 512, height: 512 },
  { label: "512×768 (SD1.5 portrait)", width: 512, height: 768 },
  { label: "768×512 (SD1.5 landscape)", width: 768, height: 512 },
  { label: "480×480 (Wan square)", width: 480, height: 480 },
  { label: "624×480 (Wan landscape)", width: 624, height: 480 },
  { label: "480×624 (Wan portrait)", width: 480, height: 624 },
  { label: "256×256: Tiny (fast)", width: 256, height: 256 },
  { label: "384×384: Small (fast)", width: 384, height: 384 },
] as const;

export type GenerationStatus = "idle" | "uploading" | "queued" | "generating" | "complete" | "error";

export interface GenerationResult {
  images: Array<{ filename: string; subfolder: string; type: string }>;
  promptId: string;
}

// ── Director Mode types (unified pipeline: LTX-2 segments + Foley) ──

export type DirectorAudioMode = "joint" | "foley" | "none";

// Preview presentation (UI-only): how generated segment previews render.
export type PreviewSize = "sm" | "md" | "lg" | "xl";
export type PreviewFit = "contain" | "cover"; // contain = fit (letterbox), cover = fill (crop)

// ── Storyboard / Music Video types ──

// A keyframe image in the storyboard timeline. Ordered list defines visual anchors
// that prevent quality degradation over long multi-segment generations.
export interface StoryboardImage {
  id: string;              // unique ID
  image: string;           // ComfyUI input/ filename
  preview: string;         // local blob URL for UI thumbnail (not persisted)
  label: string;           // optional user label (e.g. "Verse 1", "Chorus")
  energyBucket?: EnergyLevel;  // optional energy category for music video bucket assignment
}

// How storyboard images are scheduled across segments:
//   "pair": Overlapping pairs: seg 1=img1→img2, seg 2=img2→img3, …, last=imgN→img1 (wraps)
//   "single": Each segment uses one storyboard image as sourceImage (cycles through list)
//   "manual": Storyboard is ignored; user manually sets sourceImage/endImage per segment
export type StoryboardScheduleMode = "pair" | "single" | "manual";

// How each segment's source image is determined during generation:
//   "storyboard": Use storyboard-assigned images (no degradation over time)
//   "chain": Use extracted last frame from previous segment (classic, degrades)
//   "manual": Only use user-uploaded sourceImage per segment (existing behavior)
export type SegmentChainingMode = "storyboard" | "chain" | "manual";

export interface DirectorSegment {
  id: string;                      // unique segment ID
  prompt: string;                  // scene/motion description for LTX-2
  dialogue: string;                // optional per-segment dialogue text (Script subtab)
  numFrames: number;               // frames for this segment (8n+1)
  sourceImage: string;             // ComfyUI input filename for I2V (uploaded by user), or "" for T2V / auto-chain
  sourceImagePreview: string;      // local blob URL for thumbnail preview (not persisted)
  endImage: string;                // ComfyUI input filename for end-frame guide (uploaded by user), or "" for none
  endImagePreview: string;         // local blob URL for end-frame thumbnail preview (not persisted)
  // End-frame anchor override (reference-sheet mode). undefined = follow the global default
  // (auto-lock when an end image exists); false = deliberately let this segment drift.
  lockEndFrame?: boolean;
  // Audio slice (Music Video mode): pre-extracted chunk of the master audio for this segment.
  // When set, the segment renders in A2V mode, audio is frozen, only video is generated.
  audioSliceFile?: string;         // ComfyUI input/ filename for this segment's audio slice
  audioStartTime?: number;         // start time in master audio (seconds, for UI display)
  audioEndTime?: number;           // end time in master audio (seconds, for UI display)
  // Storyboard tracking: which storyboard images were assigned to this segment.
  // Used for UI display and re-scheduling. -1 or undefined = not storyboard-assigned.
  storyboardStartIdx?: number;     // index into storyboardImages[] for source image
  storyboardEndIdx?: number;       // index into storyboardImages[] for end image
  // Runtime state (not persisted in config)
  status: "pending" | "generating" | "extracting" | "complete" | "error";
  outputUrl: string | null;        // ComfyUI output URL for this segment's video
  lastFrameFile: string | null;    // extracted last frame filename (ComfyUI input/)
  error: string | null;
  usedSeed?: number;               // seed actually used on the last run (for the resolved-seeds readout)
  // Energy classification for auto-prompt: auto-detected from audio, user-overridable
  detectedEnergy?: EnergyLevel;    // computed from audio analysis RMS (read-only display)
  energyOverride?: EnergyLevel;    // user override - takes precedence over detectedEnergy
}

export interface DirectorConfig {
  segments: DirectorSegment[];
  // Video settings (shared across all segments)
  width: number;
  height: number;
  frameRate: number;
  // Audio
  audioMode: DirectorAudioMode;    // "joint" = LTX-2 audio per segment, "foley" = single Foley pass, "none" = silent
  // Pipeline control
  pauseBetweenSegments: boolean;   // pause after each segment for user review/interjection
  // ── Storyboard / Music Video ──
  // Storyboard: ordered keyframe images that anchor segments visually.
  // Prevents quality degradation by using pre-selected images instead of chained generated output.
  storyboardImages: StoryboardImage[];
  storyboardSchedule: StoryboardScheduleMode;  // how storyboard images map to segments
  chainingMode: SegmentChainingMode;            // how source images are resolved at render time
  // Music Video: upload a long audio track, auto-slice into segment-duration chunks.
  // Each segment renders in A2V mode (audio frozen, video generated to match).
  masterAudioFile?: string;        // ComfyUI input/ filename for the master audio (song/dialogue)
  masterAudioName?: string;        // display name of the master audio file
  masterAudioPreview?: string;     // local blob URL for UI audio player (not persisted)
  masterAudioDuration?: number;    // total duration in seconds (read from file)
  segmentDuration: number;         // target duration per auto-generated segment (seconds)
  autoSegmentFromAudio: boolean;   // auto-generate segments by slicing masterAudio
  // Audio analysis cache (populated by /api/director/audio-analyze)
  waveformPeaks?: number[];        // normalized 0–1 peak amplitudes for waveform display
  energyData?: Array<{ time: number; rms: number }>;  // RMS energy per window
  beatMarkers?: number[];          // detected beat timestamps (seconds)
  // Auto-prompt settings
  characterDescription: string;    // character description for {character} template placeholder
  musicGenre?: MusicGenre;         // selected music genre - drives auto-fill template selection
  subjectCount?: SubjectCount;     // one vs multiple subjects - drives solo/group framing in templates
  promptTemplates: MusicVideoPromptTemplate[];  // energy-based prompt templates (resolved from genre+subjectCount)
  // Energy detection sensitivity: multiplied against default thresholds (default 1.0)
  // Lower values = more sensitive (more segments classified as medium/high)
  // Higher values = less sensitive (more segments classified as low)
  energyHighThreshold: number;     // RMS threshold for "high" (default 0.15)
  energyMediumThreshold: number;   // RMS threshold for "medium" (default 0.06)
  // LTX-2 model settings
  diffusionModel: string;
  textEncoder: string;
  connectorModel: string;
  videoVae: string;
  audioVae: string;
  distillLoRA: string;
  distillLoRAStrength: number;
  userLoras: LoraEntry[];
  // Normalization
  videoNormFactors: string;
  audioNormFactors: string;
  // Advanced
  videoScale: number;
  audioScale: number;
  audioToVideoScale: number;
  videoToAudioScale: number;
  vaeTileSize: number;
  vaeOverlap: number;
  vaeTemporalSize: number;
  vaeTemporalOverlap: number;
  ffChunks: number;
  ffDimThreshold: number;
  imgCompression: number;
  // Seed
  seed: number;
  randomSeed: boolean;
  // Crossfade between segments (in frames)
  crossfadeFrames: number;
  // Foley audio (post-processing pass over final concatenated video)
  foleyPrompt: string;
  foleyNegativePrompt: string;
  foleySteps: number;
  foleyCfg: number;
  foleySampler: string;
  // Lip Sync post-processing (LatentSync 1.6 + face restoration)
  lipSyncEnabled: boolean;
  lipSyncInferenceSteps: number;       // 10–50, default 20
  lipSyncExpression: number;           // 1.0–3.0, default 1.5
  lipSyncFaceRestore: "gfpgan" | "none";
  lipSyncFaceRestoreFidelity: number;  // 0.0–1.0, default 0.7
  lipSyncFaceDetection: string;        // face detection model for restore node
  lipSyncTiming: "per_segment" | "post_assembly";  // when to run lip sync: per-segment (swap models each segment) or after final assembly (efficient, one model swap)
  // Model base path (SSD fast-path override)
  modelBasePath: string;
  // LTX-2 model version
  modelVersion: LTX2ModelVersion;
  // Pipeline mode + quality tier (same as LTX2Config)
  pipelineMode: LTX2PipelineMode;
  qualityTier: LTX2QualityTier;
  officialAdvanced?: boolean;    // see LTX2Config.officialAdvanced (defaults true for Continuum)
  negativePrompt: string;
  // Style preset (from prompt-architect): drives negative prompt, FPS hint, camera defaults
  stylePreset: string;
  // ── Character Consistency (10S Method), identity stabilization across ALL segments ──
  // Mirrors a subset of LTX2Config's likeness* fields; passed through per-segment in
  // buildSegmentConfig. Runs on the Alternative pipeline (the 10S nodes only exist there).
  // For long video, upload ONE fixed character reference so every segment anchors to it.
  // NOTE: Best Face-ID is intentionally NOT present on Y (commercial licensing + it drifts
  // from simple character consistency into deepfake territory we do not support).
  likenessEnabled?: boolean;
  likenessImage?: string;              // ComfyUI input/ filename of a fixed character reference (empty = per-segment source frame, which drifts)
  likenessAnchorStrength?: number;
  likenessSimThreshold?: number;
  likenessLateBlockFalloff?: number;
  likenessFaceDetect?: "auto" | "none";
  likenessRefMaskMode?: "bbox_softfade" | "bbox_only" | "whole_frame";
  // Character Consistency: Reference Sheet (Official Lightricks IC-LoRA "Ingredients").
  // ONE fixed reference sheet shared across ALL segments so identities stay consistent for
  // the whole video. Official pipeline / LTX 2.3 only. Mapped into each segment's LTX2Config.
  ingredientsMode?: boolean;
  ingredientsLoRAName?: string;
  ingredientsLoRAStrength?: number;
  referenceSheetImage?: string;        // ComfyUI input/ filename of the shared reference sheet
  referenceSheetStrength?: number;
  ingredientsUseSourceFrame?: boolean;       // Inject each segment's source frame alongside the sheet (I2V)
  ingredientsSourceFrameStrength?: number;   // Frame-0 source anchor strength (0-1, default 0.65)
  // End-frame anchoring (segment-to-segment continuity). Auto-locks the LAST frame to the
  // segment's end image whenever one exists; per-segment `lockEndFrame` can disable it.
  ingredientsUseEndFrame?: boolean;          // Global default: auto-lock the end frame when an end image exists (default true)
  ingredientsEndFrameStrength?: number;      // Last-frame anchor strength (0-1, default 0.65)
  // ── Autoregressive Long-Form (Top-Tier character consistency), mirrored from LTX2Config ──
  // When enabled, each segment routes through buildLTX2AutoregressiveWorkflow (LTXVLoopingSampler).
  autoregressiveEnabled?: boolean;
  arTemporalTileSize?: number;
  arTemporalOverlap?: number;
  arTemporalOverlapCondStrength?: number;
  arCondImageStrength?: number;
  arAdainFactor?: number;
  arGuidingStrength?: number;
  arNegativeIndexEnabled?: boolean;
  arNegativeIndexImage?: string;
  arNegativeIndexStrength?: number;
  arHorizontalTiles?: number;
  arVerticalTiles?: number;
  arSpatialOverlap?: number;
  // Sampling controls (mirrored from LTX2Config)
  directSampling: boolean;
  // Test/distilled tier controls
  testVideoSteps: number;        // default 3 (test) or 8 (distilled)
  testAudioSteps: number;        // default 5 (test) or 8 (distilled)
  testSampler: string;           // default "euler"
  // Full tier controls
  fullSteps: number;             // default 15
  fullSampler: string;           // default "exponential/res_2s"
  videoCfg: number;              // default 3
  audioCfg: number;              // default 7
  distilledSteps: number;        // default 8
  // Turbo Upscale (mirrored from LTX2Config), half-res sample + 2x latent upscale + refine.
  // Passed through per-segment in buildSegmentConfig; disabled by the builder in A2V /
  // continuity segments. 2.3-only.
  turboUpscale?: boolean;
  turboUpscaleMethod?: "latent" | "rtx_vsr";
  turboUpscaleRefineSteps?: number;
  turboUpscaleRefineStrength?: number;
  turboUpscaleModel?: string;
  turboUpscaleSampler?: string;
  turboUpscaleCustomSigmas?: string;
  // ── Preview presentation (UI-only): how generated segment previews render ──
  previewSize: PreviewSize;      // thumbnail size for segment output previews
  previewFit: PreviewFit;        // object-fit for preview media (contain = fit, cover = fill)
}

export function createDirectorSegment(overrides?: Partial<DirectorSegment>): DirectorSegment {
  return {
    id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    prompt: "",
    dialogue: "",
    numFrames: 97,
    sourceImage: "",
    sourceImagePreview: "",
    endImage: "",
    endImagePreview: "",
    status: "pending",
    outputUrl: null,
    lastFrameFile: null,
    error: null,
    ...overrides,
  };
}

// Music genre presets for auto-fill prompt templates.
// Each genre maps to a 3-tier energy template set tuned to LTX-2.3 prompting
// best practices (specific subject + present-tense action + camera move + lighting + audio cue).
export type MusicGenre =
  | "generic"
  | "rap"
  | "drill"
  | "trap"
  | "rnb"
  | "rock"
  | "metal"
  | "punk"
  | "electronic"
  | "lofi"
  | "pop"
  | "kpop"
  | "country"
  | "folk"
  | "jazz"
  | "disco"
  | "reggae"
  | "latin"
  | "classical";

// Subject count helps the auto-fill choose between solo-shot framing vs. group framing.
export type SubjectCount = "one" | "multiple";

export const MUSIC_GENRE_OPTIONS: Array<{ value: MusicGenre; label: string; description: string }> = [
  { value: "generic", label: "Generic / Cinematic", description: "Neutral music-video templates suitable for any genre" },
  { value: "rap", label: "Rap / Hip-Hop", description: "Fast camera moves, aggressive bounce, swagger, lyrical gestures" },
  { value: "drill", label: "Drill (UK/NY)", description: "Dark moody street energy, sliding 808s, masked crew framing" },
  { value: "trap", label: "Trap", description: "Slow-mo flexes, lean-in poses, smoke, syrupy hi-hats" },
  { value: "rnb", label: "R&B / Soul", description: "Sensual sway, intimate close-ups, warm color grading" },
  { value: "rock", label: "Rock", description: "Stage performance, dynamic camera, classic rock energy" },
  { value: "metal", label: "Metal", description: "Aggressive headbanging, harsh red/white strobes, pyrotechnics" },
  { value: "punk", label: "Punk", description: "Raw chaotic energy, mosh pits, handheld DIY aesthetic" },
  { value: "electronic", label: "Electronic / EDM", description: "Synced strobe pulses, crowd shots, neon" },
  { value: "lofi", label: "Lofi / Chillhop", description: "Anime-style calm, study vibes, warm desk light, tape grain" },
  { value: "pop", label: "Pop", description: "Choreographed motion, glossy color, glamorous lighting" },
  { value: "kpop", label: "K-Pop", description: "Precision group choreography, vibrant sets, point-moves" },
  { value: "country", label: "Country", description: "Open landscapes, warm sunset light, denim and boots" },
  { value: "folk", label: "Folk / Acoustic", description: "Intimate acoustic performance, natural light, organic motion" },
  { value: "jazz", label: "Jazz / Lounge", description: "Smoky club, brass instruments, low-key tungsten light" },
  { value: "disco", label: "Disco / Funk", description: "Mirror balls, glittery costumes, groove dancing, saturated colors" },
  { value: "reggae", label: "Reggae / Dancehall", description: "Loose island sway, warm golden light, smoke, palm trees" },
  { value: "latin", label: "Latin / Reggaeton", description: "Hip-driven dance, neon street energy, rapid camera arcs" },
  { value: "classical", label: "Classical / Orchestral", description: "Elegant concert hall, sweeping camera moves, dramatic lighting" },
];

export const SUBJECT_COUNT_OPTIONS: Array<{ value: SubjectCount; label: string }> = [
  { value: "one", label: "One subject" },
  { value: "multiple", label: "Multiple subjects" },
];

// Default prompt templates for music video auto-fill (placed before DIRECTOR_DEFAULTS to avoid forward reference)
export const MV_DEFAULT_TEMPLATES: MusicVideoPromptTemplate[] = [
  {
    id: "mv_low",
    label: "Low Energy (Verse/Intro)",
    energyLevel: "low",
    prompt: "{character} performs softly, subtle swaying motion, moody ambient lighting, slow gentle camera movement, cinematic depth of field",
  },
  {
    id: "mv_med",
    label: "Medium Energy (Pre-Chorus)",
    energyLevel: "medium",
    prompt: "{character} sings with building intensity, moderate movement, stage lights brightening, dynamic camera angles, cinematic music video",
  },
  {
    id: "mv_high",
    label: "High Energy (Chorus/Drop)",
    energyLevel: "high",
    prompt: "{character} performs with powerful energy, dramatic movement, vivid colorful stage lights pulsing, wide angle dynamic shots, high energy cinematic music video",
  },
];

// Genre-specific template library.
// Each entry has prompts tuned for SOLO ("one") and GROUP ("multiple") subject framing.
// Following LTX-2.3 best practices: present tense, specific motion verbs, camera move,
// lighting, and an audio cue. Avoid numerical micro-direction; favor natural language.
export const MV_GENRE_TEMPLATES: Record<MusicGenre, Record<SubjectCount, MusicVideoPromptTemplate[]>> = {
  generic: {
    one: MV_DEFAULT_TEMPLATES,
    multiple: [
      { id: "gen_grp_low", label: "Low Energy", energyLevel: "low",
        prompt: "{character} stand close together, breathing slowly, subtle swaying, moody low-key lighting, slow dolly-in, shallow depth of field, faint ambient hum" },
      { id: "gen_grp_med", label: "Medium Energy", energyLevel: "medium",
        prompt: "{character} move in loose unison, exchanging glances and gestures, warm stage lights brightening, medium tracking shot circling the group, building cinematic score" },
      { id: "gen_grp_high", label: "High Energy", energyLevel: "high",
        prompt: "{character} burst into synchronized motion, arms raised, vivid colorful lights pulsing, wide dynamic shot with fast lateral push, lens flare, loud crowd cheer" },
    ],
  },
  rap: {
    // Tuned for fast/hard rap: short-burst camera moves, sharp gestures, urban grit.
    one: [
      { id: "rap_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stands center-frame against a graffiti-tagged brick wall, nods rhythmically on the off-beat, mouths lyrics with sharp lip movement, slow handheld push-in, harsh fluorescent overhead light casting deep shadows, faint trap hi-hat in the background, gritty cinematic look, shallow depth of field" },
      { id: "rap_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} steps forward with one hand cutting through the air punctuating each bar, chains and jewelry catching the light, gold and amber backlight rim-lighting the silhouette, camera dollies left in a smooth lateral track, low-angle hero shot, kicking 808 sub-bass and crisp snare in the audio, urban music video aesthetic, anamorphic lens flare" },
      { id: "rap_solo_high", label: "Hook / Drop / High Energy", energyLevel: "high",
        prompt: "{character} explodes into motion, throws both hands up in sharp staccato gestures synced to the beat, sways aggressively side to side, jumps once on the downbeat, vivid red and blue strobes pulsing in rapid bursts, smoke billowing across the frame, handheld camera whip-pans following the body, wide dynamic shot with motion blur, distorted 808 drop and chopped vocal ad-libs, high contrast cinematic hip-hop music video" },
    ],
    multiple: [
      { id: "rap_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand shoulder to shoulder in a tight horizontal line, heads nodding in loose sync, the lead steps half a pace forward to deliver his bar while the others mouth ad-libs behind him, neon street signs glowing in the background, slow lateral dolly across the lineup, low-angle wide shot, muted trap hi-hat" },
      { id: "rap_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} move together with attitude, throwing pointed gestures toward the camera, exchanging head nods and shoulder shrugs in time with the beat, warm orange streetlight backlight, camera arcs around the group in a medium tracking shot, smoke drifting at ankle height, punchy snare and rolling hi-hat, cinematic hip-hop video" },
      { id: "rap_grp_high", label: "Hook / Drop / High Energy", energyLevel: "high",
        prompt: "{character} jump and bounce on the downbeat in a tight cypher formation, arms swinging wide, chains swinging, the crew leans into the camera with aggressive synced gestures, vivid red and white strobes flashing, dust and smoke kicking up around their feet, handheld wide shot with whip-pan and quick zoom-in, hard-hitting 808 drop with chopped ad-libs, gritty high-contrast hip-hop music video" },
    ],
  },
  rnb: {
    one: [
      { id: "rnb_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stands in soft warm tungsten light, head tilted, eyes half closed, mouths the lyric slowly, body sways gently in place, slow push-in close-up framing the face, shallow depth of field, smooth Rhodes chord and brushed snare in the background, intimate cinematic music video" },
      { id: "rnb_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} runs a hand through their hair, turns slowly toward the camera, hips moving in a slow figure-eight, golden-hour backlight glowing through sheer curtains, medium dolly-in, soft falloff lighting, building drum groove and smooth bass" },
      { id: "rnb_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} steps into the light, arms open, body rolling to the beat, expressive face singing with conviction, lens flare across the frame, warm amber and magenta stage wash, camera circles slowly around the subject, lush layered vocals and full drum kit" },
    ],
    multiple: [
      { id: "rnb_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand close together in soft warm light, leaning into one another, gentle synchronized sway, exchanging tender glances, slow dolly-in, shallow depth of field, intimate Rhodes and brushed snare" },
      { id: "rnb_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} move in slow loose unison, hands gliding through the air, hips rolling to the beat, warm amber rim light, camera tracks slowly past the group, building groove with smooth bass" },
      { id: "rnb_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} sway and turn together in choreographed motion, arms raised, expressive faces singing harmonies, warm magenta and gold stage wash, camera circles the group in a smooth arc, lush layered vocals and full drum kit" },
    ],
  },
  rock: {
    one: [
      { id: "rock_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} grips the microphone with one hand, head down, mouthing the lyric, slow handheld push-in, single hard overhead spotlight, deep shadows around the eyes, sparse clean guitar and tom rolls" },
      { id: "rock_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} lifts the mic, leans toward the camera, body swaying side to side, stage lights brightening from blue to white, handheld medium shot tracking with the motion, building distorted guitar and driving snare" },
      { id: "rock_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} headbangs aggressively, hair flying, jumps once on the downbeat, throws the mic stand back, strobes flashing white and red, smoke filling the stage, handheld wide shot with whip-pan, fast lateral push, screaming distorted guitars and full drums" },
    ],
    multiple: [
      { id: "rock_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand at their instruments in deep shadow, lit only by a single overhead spot, heads down, subtle nodding, slow handheld dolly across the stage, sparse clean guitar" },
      { id: "rock_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} lean into their instruments, the vocalist steps forward, drummer locks into a driving groove, stage lights brightening, handheld tracking shot moving past each member, building distorted guitars" },
      { id: "rock_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} thrash in sync, headbanging, the guitarist jumps off the riser, drummer hammering the kit, vivid red and white strobes flashing, smoke and sparks across the stage, handheld wide shot with whip-pan and fast push-in, screaming distorted guitars and crashing drums" },
    ],
  },
  electronic: {
    one: [
      { id: "edm_solo_low", label: "Build / Low Energy", energyLevel: "low",
        prompt: "{character} stands behind glowing decks in a haze of fog, head down, slow methodical knob movements, single cyan light overhead, slow push-in, low ambient pad and rising filter sweep" },
      { id: "edm_solo_med", label: "Pre-Drop / Medium Energy", energyLevel: "medium",
        prompt: "{character} raises one arm slowly above the head, the other hand riding the filter knob, white lasers cutting through the fog, camera dollies forward steadily, rising synth and snare roll" },
      { id: "edm_solo_high", label: "Drop / High Energy", energyLevel: "high",
        prompt: "{character} throws both arms up on the downbeat, jumps once with the drop, strobes flashing in rapid bursts of cyan and magenta, confetti raining down, wide camera push-out revealing a massive crowd, distorted bass and pounding kick" },
    ],
    multiple: [
      { id: "edm_grp_low", label: "Build / Low Energy", energyLevel: "low",
        prompt: "{character} stand together in deep fog lit only by faint cyan haze, subtle nods, slow steady dolly toward them, low ambient pad" },
      { id: "edm_grp_med", label: "Pre-Drop / Medium Energy", energyLevel: "medium",
        prompt: "{character} raise their arms in loose unison, white lasers sweeping across the frame, camera tracks forward with rising tension, synth lead climbing and snare roll" },
      { id: "edm_grp_high", label: "Drop / High Energy", energyLevel: "high",
        prompt: "{character} jump together on the drop, hands in the air, confetti and pyro bursting overhead, vivid cyan and magenta strobes flashing, camera push-out revealing the crowd, distorted bass and pounding kick" },
    ],
  },
  pop: {
    one: [
      { id: "pop_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stands in soft pastel light, gentle sway, mouths the lyric with a small smile, slow push-in, glossy color grade, light airy production with finger snaps" },
      { id: "pop_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} spins once, flicks their hair, gestures to the camera, bright daylight or pink neon backlight, smooth gimbal tracking shot, building drums and synth lead" },
      { id: "pop_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} performs sharp choreographed dance moves, arms slicing through the air, bright vivid colored lights, confetti or sparkle effects, camera circles dynamically around the subject, four-on-the-floor kick and bright synth hook" },
    ],
    multiple: [
      { id: "pop_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand in a soft pastel-lit row, gentle synchronized sway, small smiles, slow dolly past the line, glossy color grade, airy production" },
      { id: "pop_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} step forward together, spinning and flicking their hair in unison, bright pink neon backlight, smooth gimbal tracking shot around the group, building drums and synth lead" },
      { id: "pop_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} perform sharp synchronized choreography, arms slicing the air in unison, vivid colored stage lights and sparkle effects, camera circles dynamically around the formation, four-on-the-floor kick and bright synth hook" },
    ],
  },
  drill: {
    one: [
      { id: "drill_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stands under a flickering streetlight in a dim alley at night, hood pulled low, head tilting side to side, mouths bars with menacing intensity, slow handheld push-in, cold blue moonlight rim, faint sliding 808 and rolling hi-hat, dark gritty cinematic look" },
      { id: "drill_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} leans against a brick wall, lights a cigarette, exhales slowly, makes a sharp finger gun gesture toward the camera, low blue-and-red emergency light flicker, handheld medium shot tracking sideways, sliding 808 bassline and snare triplets, moody street video aesthetic" },
      { id: "drill_solo_high", label: "Hook / High Energy", energyLevel: "high",
        prompt: "{character} stomps forward through swirling smoke, arms cutting sharp staccato motions, head jerks aggressively to the beat, harsh white-and-red strobe flashes, handheld camera whip-pans following the body, low-angle wide shot, hard sliding 808 with snare rolls and ad-libs, dark high-contrast UK drill music video" },
    ],
    multiple: [
      { id: "drill_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand in a tight semicircle under a single streetlight, masks and hoods obscuring faces, subtle nods, slow handheld dolly closing in, cold blue moonlight, faint rolling hi-hat" },
      { id: "drill_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} pace together in a dim parking lot, exchanging sharp hand gestures, leaning into the lead's bars, cold mixed blue and red emergency light, handheld tracking shot moving past the crew, sliding 808 and snare triplets" },
      { id: "drill_grp_high", label: "Hook / High Energy", energyLevel: "high",
        prompt: "{character} march forward through thick smoke in a tight wedge formation, throwing hooded silhouette gestures in sync, hard white-and-red strobes flashing, handheld wide shot with whip-pan and quick zoom-in, hard sliding 808 with chopped ad-libs, dark cinematic UK drill aesthetic" },
    ],
  },
  trap: {
    one: [
      { id: "trap_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} reclines against a luxury car at night, head tilted back, slowly raising a hand to flash jewelry, slow-motion push-in, deep purple and gold rim light, faint syrupy hi-hats and 808 sub, glossy cinematic luxury aesthetic" },
      { id: "trap_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} steps forward through colored smoke, casually swaying side to side, throws a slow lean-back pose, makes it rain in slow motion, magenta and teal backlight, smooth lateral dolly, rolling hi-hat triplets and booming 808, hazy cinematic trap video" },
      { id: "trap_solo_high", label: "Hook / High Energy", energyLevel: "high",
        prompt: "{character} bounces on the balls of their feet, throws sharp slow-motion ad-lib gestures, head tilting and shoulders rolling to the beat, gold chains swinging, vivid purple-and-gold strobes pulsing through smoke, handheld camera with quick whip-pans, fast hi-hat rolls and distorted 808 drop, glossy trap music video" },
    ],
    multiple: [
      { id: "trap_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} lounge around a luxury car together, subtle head nods, the lead steps forward to deliver his bar, deep purple and gold rim light, slow handheld dolly across the group, syrupy hi-hats and 808 sub" },
      { id: "trap_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} stride forward together through magenta smoke, throwing synchronized lean-back poses, exchanging gestures and head nods, smooth lateral dolly past the crew, rolling hi-hat triplets and booming 808" },
      { id: "trap_grp_high", label: "Hook / High Energy", energyLevel: "high",
        prompt: "{character} bounce in formation, jewelry swinging, throwing synced slow-motion ad-lib gestures, vivid purple-and-gold strobes pulsing through smoke, handheld wide shot with whip-pan, fast hi-hat rolls and distorted 808 drop, glossy cinematic trap video" },
    ],
  },
  metal: {
    one: [
      { id: "metal_solo_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stands center stage in deep shadow, head bowed, gripping the microphone with both hands, single harsh overhead spotlight, slow handheld push-in, dense atmospheric drone and double-kick rumble in the distance" },
      { id: "metal_solo_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} snarls into the microphone, body swaying menacingly, the camera circles slowly, deep red wash light pulsing, smoke rolling across the stage, building tremolo-picked guitars and pounding double kick" },
      { id: "metal_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} headbangs violently, hair whipping in circles, jumps onto a monitor, throws horns toward the camera, blinding red-and-white strobes flashing, pyrotechnic flames bursting upward, handheld wide shot with whip-pan and motion blur, blast-beat drums and screaming distorted guitars" },
    ],
    multiple: [
      { id: "metal_grp_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stand at their instruments in near-total darkness, lit only by a harsh single backlight casting long shadows, slow handheld dolly across the stage, atmospheric drone and double-kick rumble" },
      { id: "metal_grp_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} lean into their instruments with menacing intensity, the vocalist snarls into the mic, drummer locks into pounding double kick, deep red wash brightening, smoke rolling across the stage, handheld tracking shot passing each player" },
      { id: "metal_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} thrash in sync, headbanging violently, guitarists windmilling, drummer hammering blast beats, pyrotechnic flame bursts shooting up from the stage, blinding red-and-white strobes, handheld wide shot with whip-pan and motion blur, screaming distorted guitars and crushing double kick" },
    ],
  },
  punk: {
    one: [
      { id: "punk_solo_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stands on a graffiti-covered stage in a dingy basement venue, gripping the mic with attitude, scowling toward the floor, single harsh fluorescent overhead, handheld grainy lo-fi camera, sparse clean guitar and tense feedback" },
      { id: "punk_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} shouts into the mic, leans aggressively over the front of the stage, body rocking side to side, harsh fluorescent flicker, handheld jittery medium shot, driving snare and fuzzed-out guitar power chords" },
      { id: "punk_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} jumps off the stage into the mosh pit, screams into the mic, raises a fist, swings the mic stand, harsh strobe flashes and beer flying through the air, handheld grainy camera shaking with motion blur, fast hardcore drums and screaming distorted guitars" },
    ],
    multiple: [
      { id: "punk_grp_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stand at their instruments in a cramped basement venue, harsh fluorescent overhead, sneering at the camera, slow handheld dolly across them, tense feedback and sparse clean guitar" },
      { id: "punk_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} lean into their instruments aggressively, the vocalist shouts and leans over the crowd, drummer pounds a driving beat, harsh fluorescent flicker, handheld jittery tracking shot, fuzzed-out power chords and driving snare" },
      { id: "punk_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} thrash chaotically, the vocalist dives into the crowd, guitarists jump on the monitors, drummer hammering blast beats, harsh strobes and beer flying through the air, handheld grainy lo-fi camera with violent shake and motion blur, fast hardcore drums and screaming distorted guitars" },
    ],
  },
  lofi: {
    one: [
      { id: "lofi_solo_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} sits at a wooden desk by a rainy window in an anime-style bedroom, head resting on one hand, slowly turning a page of a book, soft warm desk lamp glowing, slow gentle push-in, shallow depth of field with bokeh, dusty tape grain, mellow jazzy piano loop and soft rain on the window" },
      { id: "lofi_solo_med", label: "Mid / Medium Energy", energyLevel: "medium",
        prompt: "{character} stretches at the desk, sips from a steaming mug, taps fingers gently to the beat, looks out the rainy window with a soft smile, warm orange-and-teal color grade, slow gimbal arc, tape grain and chromatic aberration, smooth lofi drum loop and mellow Rhodes" },
      { id: "lofi_solo_high", label: "Build / High Energy", energyLevel: "high",
        prompt: "{character} leans back in the chair, hands behind their head, gently bobbing to the beat, sunset light breaking through the rain clouds, golden-hour warm wash, gentle camera dolly around the desk, vinyl crackle and a slightly busier drum loop with rich Rhodes chords" },
    ],
    multiple: [
      { id: "lofi_grp_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} sit together at a small cafe table by a rainy window, reading, sketching, sipping tea, warm tungsten lamp light, slow push-in, shallow depth of field, tape grain, soft piano loop and rain ambience" },
      { id: "lofi_grp_med", label: "Mid / Medium Energy", energyLevel: "medium",
        prompt: "{character} chat softly across the table, gentle smiles and nods, fingers tapping along to the beat, warm orange-and-teal color grade, slow gimbal arc around them, smooth lofi drums and mellow Rhodes" },
      { id: "lofi_grp_high", label: "Build / High Energy", energyLevel: "high",
        prompt: "{character} laugh and lean back together as golden sunset light breaks through the clouds, warm wash flooding the room, gentle dolly arc around the table, vinyl crackle and a fuller lofi groove with rich keys" },
    ],
  },
  kpop: {
    one: [
      { id: "kpop_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stands center-frame on a glossy pastel-colored set, head tilted with a soft expressive look, performs a precise hand-to-cheek point move, slow smooth push-in, bright clean studio lighting, fashion-magazine color grade, light bell synth and finger snaps" },
      { id: "kpop_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} executes a crisp choreography move, hits a clean stop-pose, flicks the head and points to the camera, vibrant magenta-and-cyan backlight, smooth lateral gimbal slide, bright synth lead climbing with snare roll" },
      { id: "kpop_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} performs sharp synchronized choreography with precise leg lifts and arm slices, hits a powerful point-move on the downbeat, vivid kaleidoscopic set lighting, camera arcs around the subject with quick whip-pans, full bright synth hook with four-on-the-floor kick and chopped vocal samples, high-gloss K-pop music video" },
    ],
    multiple: [
      { id: "kpop_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand in a tight diamond formation on a glossy pastel set, perform a soft synchronized hand-to-cheek point move, slow smooth push-in, bright clean studio lighting, light bell synth and finger snaps" },
      { id: "kpop_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} execute crisp synchronized footwork, hit a unison stop-pose, point to the camera together, vibrant magenta-and-cyan backlight, smooth lateral gimbal slide, bright synth lead and snare roll" },
      { id: "kpop_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} perform tightly synchronized choreography with precise leg lifts, arm slices, and rotating formations, hit a powerful unison point-move on the downbeat, vivid kaleidoscopic set lighting, camera arcs around the formation with quick whip-pans, full bright synth hook with four-on-the-floor kick, glossy K-pop music video" },
    ],
  },
  country: {
    one: [
      { id: "country_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} sits on the porch of a weathered wooden farmhouse at golden hour, strums an acoustic guitar slowly, hums softly, warm sunset backlight, slow handheld push-in, shallow depth of field, soft acoustic strumming and crickets" },
      { id: "country_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} stands up holding the guitar, steps off the porch into a golden wheat field, smiles toward the camera, warm sunset side-light glowing through the field, smooth gimbal dolly, building acoustic strum and steel guitar slide" },
      { id: "country_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} strums vigorously while walking through the wheat field, throws their head back singing, swings the guitar, golden hour light flaring through the camera lens, wide tracking shot following the motion, full country band kicks in with snare, bass, and steel guitar, joyful Americana music video" },
    ],
    multiple: [
      { id: "country_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} sit together on the porch of a weathered farmhouse at golden hour, one strums acoustic guitar, others tap along and hum softly, warm sunset rim light, slow handheld push-in, soft acoustic strum and crickets" },
      { id: "country_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} step off the porch together into a golden wheat field, smiling and exchanging glances, warm sunset side-light glowing, smooth gimbal dolly following the group, building acoustic strum and steel guitar slide" },
      { id: "country_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} stride through the wheat field in a loose line, the lead strums vigorously while singing, others clap and harmonize, golden hour lens flare, wide tracking shot following the motion, full country band kicks in with snare, bass, and steel guitar" },
    ],
  },
  folk: {
    one: [
      { id: "folk_solo_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} sits cross-legged on a wooden floor in a sunlit room, slowly tunes an acoustic guitar, soft natural window light, slow gentle push-in, shallow depth of field, faint sparse fingerpicked guitar" },
      { id: "folk_solo_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} begins fingerpicking gently, eyes closed, head swaying softly, leans toward the microphone to sing, warm window light glowing, smooth handheld medium shot, building fingerpicked guitar and soft vocals" },
      { id: "folk_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} strums passionately with their whole body, eyes open and expressive, throws their head back singing, sunlight breaking through the window, gentle dolly arc around the performer, full acoustic ensemble with harmonies, mandolin, and upright bass joining in" },
    ],
    multiple: [
      { id: "folk_grp_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} sit in a circle on a wooden floor in a sunlit room with their acoustic instruments, slowly tuning together, soft natural window light, slow gentle push-in, sparse fingerpicked guitar" },
      { id: "folk_grp_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} lean in toward one another and begin playing, fingerpicking gently and harmonizing, warm window light glowing, smooth handheld medium shot circling the circle, building fingerpicked guitar and soft vocals" },
      { id: "folk_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} strum and pluck passionately together, swaying in sync, throwing their heads back singing harmonies, sunlight breaking through the window, gentle dolly arc around the ensemble, full acoustic group with mandolin, fiddle, and upright bass" },
    ],
  },
  jazz: {
    one: [
      { id: "jazz_solo_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stands beside a vintage microphone in a smoke-filled jazz club, snaps fingers softly on the off-beat, mouths a slow phrase, single warm tungsten spotlight, slow handheld push-in, shallow depth of field, sparse upright bass and brushed snare" },
      { id: "jazz_solo_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} leans into the microphone, swaying smoothly, gestures gracefully with one hand, smoke drifting through the warm tungsten beams, smooth lateral dolly past the stage, building bass and brushed drums with a Rhodes chord" },
      { id: "jazz_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} dances on the spot with effortless rhythm, hits a sustained note with arms open, smoke swirling in golden spotlights, lens flare across the frame, smooth gimbal arc around the performer, full jazz combo with walking bass, snare, piano, and brass" },
    ],
    multiple: [
      { id: "jazz_grp_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stand around a vintage microphone in a smoke-filled jazz club, snapping softly in sync, single warm tungsten spotlight, slow handheld push-in, sparse upright bass and brushed snare" },
      { id: "jazz_grp_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} sway smoothly together, taking turns leaning into the mic with graceful gestures, smoke drifting through warm tungsten beams, smooth lateral dolly past the stage, building bass and brushed drums with Rhodes chord" },
      { id: "jazz_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} dance in loose sync with effortless rhythm, harmonize a sustained note with arms open, smoke swirling in golden spotlights, lens flare, smooth gimbal arc around the group, full jazz combo with walking bass, snare, piano, and brass section" },
    ],
  },
  disco: {
    one: [
      { id: "disco_solo_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stands under a slowly rotating mirror ball, body swaying in place, light specks drifting across the face, deep purple-and-magenta wash, slow push-in, faint four-on-the-floor kick and a funky bassline starting up" },
      { id: "disco_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} starts grooving with hip rolls and pointed disco moves, glittery jumpsuit catching the rotating mirror-ball light, smooth lateral dolly, building funk guitar wakka-wakka and four-on-the-floor kick" },
      { id: "disco_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} explodes into classic disco choreography, hip thrusts, finger points to the sky, spinning under the mirror ball, vivid red-and-magenta strobes pulsing on the four-on-the-floor kick, camera circles dynamically, full funk band with horns, slap bass, and lush strings" },
    ],
    multiple: [
      { id: "disco_grp_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stand in formation under a slowly rotating mirror ball, swaying together in place, light specks drifting across them, deep purple-and-magenta wash, slow push-in, faint four-on-the-floor kick" },
      { id: "disco_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} start grooving in unison with hip rolls and synchronized disco moves, glittery jumpsuits catching the mirror-ball light, smooth lateral dolly, funk guitar wakka-wakka and four-on-the-floor kick" },
      { id: "disco_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} burst into classic synchronized disco choreography, hip thrusts and finger points to the sky in unison, spinning together under the mirror ball, vivid strobes pulsing on the four-on-the-floor kick, camera circles dynamically, full funk band with horns and slap bass" },
    ],
  },
  reggae: {
    one: [
      { id: "reggae_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stands on a tropical beach at golden hour with palm trees swaying, loose island sway from side to side, head nods on the off-beat, warm sunset backlight, slow handheld push-in, faint skanking guitar and dub bass" },
      { id: "reggae_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} walks slowly along the shoreline, raises a hand in a peace gesture, smiles toward the camera, smoke drifting in the warm air, smooth lateral dolly along the beach, building skanking guitar and laid-back drums" },
      { id: "reggae_solo_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} dances in loose island style with arms raised, sways hips deeply, jumps gently on the down-beat, vivid golden sunset wash with warm lens flare, wide camera circling the subject, full roots reggae band with skanking guitar, dub bass, and horn stabs" },
    ],
    multiple: [
      { id: "reggae_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand together on a tropical beach at golden hour, loose island sway in unison, head nods on the off-beat, warm sunset backlight, slow handheld push-in, faint skanking guitar and dub bass" },
      { id: "reggae_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} walk slowly along the shoreline together, raising hands in peace gestures, smiling and exchanging glances, smoke drifting in the warm air, smooth lateral dolly along the beach, building skanking guitar and laid-back drums" },
      { id: "reggae_grp_high", label: "Chorus / High Energy", energyLevel: "high",
        prompt: "{character} dance together in loose island style with arms raised, swaying hips deeply in sync, jumping gently on the down-beat, vivid golden sunset wash with warm lens flare, wide camera circling the group, full roots reggae band with skanking guitar, dub bass, and horn stabs" },
    ],
  },
  latin: {
    one: [
      { id: "latin_solo_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stands on a neon-lit street corner at night, slow hip sway, runs a hand through their hair, looks toward the camera with sultry intensity, pink and cyan neon rim light, slow handheld push-in, faint reggaeton dembow beat and Latin percussion" },
      { id: "latin_solo_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} steps forward with rolling hip motion, throws sharp shoulder accents on the beat, makes eye contact with the camera, vivid neon pink and cyan backlight, smooth lateral gimbal slide, building dembow beat with synth horns and trap hi-hats" },
      { id: "latin_solo_high", label: "Hook / High Energy", energyLevel: "high",
        prompt: "{character} explodes into hip-driven reggaeton dance, sharp body rolls, sudden stop-poses on the beat, spins once with arms raised, vivid neon street lights and rapid colored strobes, handheld camera arcs and whip-pans, full dembow beat with synth horns, layered ad-libs, and bass drops, urban Latin music video aesthetic" },
    ],
    multiple: [
      { id: "latin_grp_low", label: "Verse / Low Energy", energyLevel: "low",
        prompt: "{character} stand together on a neon-lit street corner, slow synchronized hip sway, exchanging sultry glances, pink and cyan neon rim light, slow handheld push-in, faint dembow beat and Latin percussion" },
      { id: "latin_grp_med", label: "Pre-Chorus / Medium Energy", energyLevel: "medium",
        prompt: "{character} step forward together with rolling hip motion, throwing sharp shoulder accents in unison on the beat, vivid neon pink and cyan backlight, smooth lateral gimbal slide, building dembow beat with synth horns and trap hi-hats" },
      { id: "latin_grp_high", label: "Hook / High Energy", energyLevel: "high",
        prompt: "{character} explode into synchronized hip-driven reggaeton choreography, sharp body rolls, sudden unison stop-poses on the beat, spinning together with arms raised, vivid neon street lights and rapid colored strobes, handheld camera arcs and whip-pans, full dembow beat with synth horns, ad-libs, and bass drops" },
    ],
  },
  classical: {
    one: [
      { id: "classical_solo_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} stands center stage in an opulent concert hall, raises their instrument or hands slowly, head bowed in concentration, single warm spotlight, slow gentle push-in, distant string section playing a soft sustained chord, ornate cinematic look" },
      { id: "classical_solo_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} draws a long expressive note from the instrument, body swaying with feeling, eyes closed, warm spotlight brightening, smooth camera dolly arc, building strings and timpani rolls, dramatic concert hall ambience" },
      { id: "classical_solo_high", label: "Crescendo / High Energy", energyLevel: "high",
        prompt: "{character} performs with passionate full-body motion, arms sweeping dramatically through the air, hair and clothing catching the wind from movement, golden light flooding the stage, wide camera circling dynamically, full orchestra at peak intensity with strings, brass, and crashing timpani" },
    ],
    multiple: [
      { id: "classical_grp_low", label: "Intro / Low Energy", energyLevel: "low",
        prompt: "{character} sit poised at their instruments in an opulent concert hall, raising bows slowly in unison, soft warm spotlights, slow gentle push-in across the ensemble, distant sustained chord, ornate cinematic look" },
      { id: "classical_grp_med", label: "Build / Medium Energy", energyLevel: "medium",
        prompt: "{character} draw long expressive notes together, bodies swaying in sync with feeling, eyes closed in concentration, warm spotlights brightening, smooth camera dolly arc across the ensemble, building strings and timpani rolls" },
      { id: "classical_grp_high", label: "Crescendo / High Energy", energyLevel: "high",
        prompt: "{character} perform with passionate synchronized full-body motion, arms sweeping dramatically together, hair and clothing catching motion-wind, golden light flooding the stage, wide camera circling the ensemble dynamically, full orchestra at peak intensity with strings, brass, and crashing timpani" },
    ],
  },
};

// Helper: get the active template set for a given genre + subject count.
// Falls back to MV_DEFAULT_TEMPLATES if anything is missing.
export function getGenreTemplates(genre: MusicGenre, subjectCount: SubjectCount): MusicVideoPromptTemplate[] {
  return MV_GENRE_TEMPLATES[genre]?.[subjectCount] ?? MV_DEFAULT_TEMPLATES;
}

export const DIRECTOR_DEFAULTS: DirectorConfig = {
  segments: [createDirectorSegment({ prompt: "" })],
  width: 768,
  height: 512,
  frameRate: 24,
  audioMode: "foley",
  pauseBetweenSegments: true,
  storyboardImages: [],
  storyboardSchedule: "pair",
  chainingMode: "chain",
  segmentDuration: 4,
  autoSegmentFromAudio: false,
  characterDescription: "",
  musicGenre: "generic",
  subjectCount: "one",
  promptTemplates: MV_DEFAULT_TEMPLATES,
  energyHighThreshold: 0.15,
  energyMediumThreshold: 0.06,
  diffusionModel: LTX23_MODEL_DEFAULTS.diffusionModel,
  textEncoder: LTX23_MODEL_DEFAULTS.textEncoder,
  connectorModel: LTX23_MODEL_DEFAULTS.connectorModel,
  videoVae: LTX23_MODEL_DEFAULTS.videoVae,
  audioVae: LTX23_MODEL_DEFAULTS.audioVae,
  distillLoRA: LTX23_MODEL_DEFAULTS.distillLoRA,
  distillLoRAStrength: 0.75,
  userLoras: [],
  videoNormFactors: "1,1,1,1,1,1,1,1",
  audioNormFactors: "1,1,0.25,1,1,0.25,1,1",
  videoScale: 1.0,
  audioScale: 1.0,
  audioToVideoScale: 1.0,
  videoToAudioScale: 1.0,
  vaeTileSize: 512,
  vaeOverlap: 64,
  vaeTemporalSize: 64,
  vaeTemporalOverlap: 16,
  ffChunks: 4,
  ffDimThreshold: 4096,
  imgCompression: 28,
  seed: -1,
  randomSeed: true,
  crossfadeFrames: 0,
  foleyPrompt: "",
  foleyNegativePrompt: "music, speech, silence, noisy, harsh",
  foleySteps: 75,
  foleyCfg: 5.5,
  foleySampler: "euler",
  lipSyncEnabled: false,
  lipSyncInferenceSteps: 20,
  lipSyncExpression: 1.5,
  lipSyncFaceRestore: "gfpgan",
  lipSyncFaceRestoreFidelity: 0.7,
  lipSyncFaceDetection: "retinaface_resnet50",
  lipSyncTiming: "post_assembly" as const,
  modelBasePath: "",
  modelVersion: "2.3",
  pipelineMode: "official",
  qualityTier: "distilled",
  negativePrompt: "worst quality, inconsistent motion, blurry, jittery, distorted",
  stylePreset: "none",
  // Character Consistency (10S): off by default; balanced starting values
  likenessEnabled: false,
  likenessImage: "",
  likenessAnchorStrength: 0.25,
  likenessSimThreshold: 0.50,
  likenessLateBlockFalloff: 0.4,
  likenessFaceDetect: "auto",
  likenessRefMaskMode: "bbox_softfade",
  // Character Consistency: Reference Sheet (official IC-LoRA "Ingredients"), off by default
  ingredientsMode: false,
  ingredientsLoRAName: "",
  ingredientsLoRAStrength: 1.4,
  referenceSheetImage: "",
  referenceSheetStrength: 1.0,
  ingredientsUseSourceFrame: false,
  ingredientsSourceFrameStrength: 0.65,
  ingredientsUseEndFrame: true,
  ingredientsEndFrameStrength: 0.65,
  directSampling: false,
  testVideoSteps: 3,
  testAudioSteps: 5,
  testSampler: "euler",
  fullSteps: 15,
  fullSampler: "exponential/res_2s",
  videoCfg: 3,
  audioCfg: 7,
  distilledSteps: 8,
  officialAdvanced: true,   // Continuum is the advanced multi-segment tool; keep controls live
  turboUpscale: false,
  turboUpscaleMethod: "latent",
  previewSize: "md",
  previewFit: "contain",
};

// ── Storyboard scheduling helpers ──

// Compute how many segments a storyboard produces given the schedule mode.
// "pair" mode: N images → N pairs (wrapping: 1→2, 2→3, …, N→1)
// "single" mode: each image is used once (N images → N segments)
export function storyboardSegmentCount(images: StoryboardImage[], mode: StoryboardScheduleMode): number {
  if (mode === "manual" || images.length === 0) return 0;
  if (mode === "single") return images.length;
  // "pair": wrapping pairs: 1→2, 2→3, …, N→1
  return images.length;
}

// Apply storyboard schedule to segments: assigns sourceImage/endImage and tracking indices.
// Only modifies segments that don't already have a user-uploaded sourceImage (manual override preserved).
// Returns a new segments array with storyboard images applied.
export function applyStoryboardSchedule(
  segments: DirectorSegment[],
  images: StoryboardImage[],
  mode: StoryboardScheduleMode,
): DirectorSegment[] {
  if (mode === "manual" || images.length === 0) return segments;

  return segments.map((seg, i) => {
    // Preserve user-uploaded images (non-storyboard)
    if (seg.sourceImage && seg.storyboardStartIdx === undefined) return seg;

    if (mode === "pair") {
      // Overlapping pairs: seg i gets image[i % N] → image[(i+1) % N]
      const startIdx = i % images.length;
      const endIdx = (i + 1) % images.length;
      return {
        ...seg,
        sourceImage: images[startIdx].image,
        sourceImagePreview: images[startIdx].preview,
        endImage: images[endIdx].image,
        endImagePreview: images[endIdx].preview,
        storyboardStartIdx: startIdx,
        storyboardEndIdx: endIdx,
      };
    }

    // "single": each segment uses one image as source (no end frame from storyboard)
    const imgIdx = i % images.length;
    return {
      ...seg,
      sourceImage: images[imgIdx].image,
      sourceImagePreview: images[imgIdx].preview,
      endImage: seg.endImage, // preserve user-uploaded end image if any
      endImagePreview: seg.endImagePreview,
      storyboardStartIdx: imgIdx,
      storyboardEndIdx: undefined,
    };
  });
}

// Energy-aware storyboard scheduling: assign images from energy buckets to segments
// based on each segment's detected/overridden energy level.
// For each segment, picks the next image (in order) from the matching energy bucket.
// If a bucket runs out, it cycles. If a segment's energy has no bucket images, falls
// back to unassigned images, then any available image.
// In "pair" mode, maintains frame overlap: each segment's end frame is the next
// segment's start frame (seg1: A→B, seg2: B→C, …), ensuring smooth transitions.
export function applyEnergyBucketSchedule(
  segments: DirectorSegment[],
  images: StoryboardImage[],
  mode: StoryboardScheduleMode,
): DirectorSegment[] {
  if (mode === "manual" || images.length === 0) return segments;

  // Build per-level image pools (preserving order within each bucket)
  const buckets: Record<EnergyLevel, StoryboardImage[]> = {
    low: images.filter((sb) => sb.energyBucket === "low"),
    medium: images.filter((sb) => sb.energyBucket === "medium"),
    high: images.filter((sb) => sb.energyBucket === "high"),
  };
  const unassigned = images.filter((sb) => !sb.energyBucket);
  // Per-bucket round-robin counters
  const counters: Record<EnergyLevel, number> = { low: 0, medium: 0, high: 0 };
  let unassignedCounter = 0;

  function pickImage(level: EnergyLevel): StoryboardImage | null {
    const pool = buckets[level];
    if (pool.length > 0) {
      const img = pool[counters[level] % pool.length];
      counters[level]++;
      return img;
    }
    // Fallback: unassigned images
    if (unassigned.length > 0) {
      const img = unassigned[unassignedCounter % unassigned.length];
      unassignedCounter++;
      return img;
    }
    return null;
  }

  if (mode === "pair") {
    // Pair mode with overlap: first pick one image per segment from its energy bucket,
    // then build overlapping pairs: seg[i] source = picked[i], end = picked[i+1] (wraps).
    // This ensures the end frame of segment N is the start frame of segment N+1.
    const picked: (StoryboardImage | null)[] = segments.map((seg) => {
      if (seg.sourceImage && seg.storyboardStartIdx === undefined) return null; // user-uploaded, skip
      const energy: EnergyLevel = seg.energyOverride || seg.detectedEnergy || "low";
      return pickImage(energy);
    });

    return segments.map((seg, i) => {
      if (seg.sourceImage && seg.storyboardStartIdx === undefined) return seg;
      const startImg = picked[i];
      if (!startImg) return seg;

      // End frame = next segment's picked image (wrap to first)
      let endImg: StoryboardImage | null = null;
      for (let offset = 1; offset <= segments.length; offset++) {
        const candidate = picked[(i + offset) % segments.length];
        if (candidate) { endImg = candidate; break; }
      }

      const startIdx = images.indexOf(startImg);
      if (!endImg) {
        return {
          ...seg,
          sourceImage: startImg.image,
          sourceImagePreview: startImg.preview,
          storyboardStartIdx: startIdx,
          storyboardEndIdx: undefined,
        };
      }
      const endIdx = images.indexOf(endImg);
      return {
        ...seg,
        sourceImage: startImg.image,
        sourceImagePreview: startImg.preview,
        endImage: endImg.image,
        endImagePreview: endImg.preview,
        storyboardStartIdx: startIdx,
        storyboardEndIdx: endIdx,
      };
    });
  }

  // "single" mode: one image per segment from its energy bucket
  return segments.map((seg) => {
    if (seg.sourceImage && seg.storyboardStartIdx === undefined) return seg;

    const energy: EnergyLevel = seg.energyOverride || seg.detectedEnergy || "low";
    const startImg = pickImage(energy);
    if (!startImg) return seg;

    const startIdx = images.indexOf(startImg);
    return {
      ...seg,
      sourceImage: startImg.image,
      sourceImagePreview: startImg.preview,
      endImage: seg.endImage,
      endImagePreview: seg.endImagePreview,
      storyboardStartIdx: startIdx,
      storyboardEndIdx: undefined,
    };
  });
}

// Generate segments from a master audio track by slicing it into chunks.
// segmentDuration is in seconds; frameRate determines numFrames per segment.
// Returns segment definitions WITHOUT audio slice files (those are created server-side).
export function generateAudioSegments(
  masterDuration: number,
  segmentDuration: number,
  frameRate: number,
  images: StoryboardImage[],
  schedule: StoryboardScheduleMode,
  existingPrompts?: string[],
): DirectorSegment[] {
  if (masterDuration <= 0 || segmentDuration <= 0) return [];

  const segCount = Math.ceil(masterDuration / segmentDuration);
  const segments: DirectorSegment[] = [];

  for (let i = 0; i < segCount; i++) {
    const startTime = i * segmentDuration;
    const endTime = Math.min((i + 1) * segmentDuration, masterDuration);
    const duration = endTime - startTime;
    // LTX frames must be 8n+1: round to nearest valid frame count
    const rawFrames = Math.round(duration * frameRate);
    const numFrames = Math.max(9, Math.round((rawFrames - 1) / 8) * 8 + 1);

    segments.push(createDirectorSegment({
      prompt: existingPrompts?.[i] || "",
      numFrames,
      audioStartTime: startTime,
      audioEndTime: endTime,
    }));
  }

  // Apply storyboard schedule if available
  if (images.length > 0 && schedule !== "manual") {
    return applyStoryboardSchedule(segments, images, schedule);
  }

  return segments;
}

// Create a StoryboardImage entry from an uploaded file
export function createStoryboardImage(image: string, preview: string, label?: string): StoryboardImage {
  return {
    id: `sb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    image,
    preview,
    label: label || "",
  };
}

// ── Music Video Prompt Templates ──

// Energy levels for auto-prompt assignment based on audio RMS analysis
export type EnergyLevel = "low" | "medium" | "high";

// A prompt template that maps to an energy level range.
// During auto-fill, each segment's average RMS energy is classified and the
// matching template is used (with optional character description prepended).
export interface MusicVideoPromptTemplate {
  id: string;
  label: string;          // e.g. "Verse", "Chorus", "Bridge"
  energyLevel: EnergyLevel;
  prompt: string;         // template text (may contain {character} placeholder)
}

// (MV_DEFAULT_TEMPLATES defined above DIRECTOR_DEFAULTS to avoid forward reference)

// Classify a 0–1 RMS energy value into an EnergyLevel.
// Default thresholds calibrated for typical mastered music (-10 to -20 dB RMS → 0.1–0.316 linear).
// The old thresholds (0.4 / 0.18) were far too high, most music never exceeds 0.3 RMS linear.
export function classifyEnergy(rms: number, highThreshold = 0.15, mediumThreshold = 0.06): EnergyLevel {
  if (rms > highThreshold) return "high";
  if (rms > mediumThreshold) return "medium";
  return "low";
}

// Auto-fill prompts for segments based on their energy and templates.
// characterDesc is prepended via {character} placeholder substitution.
export function autoFillSegmentPrompts(
  segments: DirectorSegment[],
  energyData: Array<{ time: number; rms: number }>,
  templates: MusicVideoPromptTemplate[],
  characterDesc: string,
  highThreshold = 0.15,
  mediumThreshold = 0.06,
): DirectorSegment[] {
  if (!energyData.length || !templates.length) return segments;

  const templateMap: Record<EnergyLevel, string> = {
    low: templates.find((t) => t.energyLevel === "low")?.prompt || "",
    medium: templates.find((t) => t.energyLevel === "medium")?.prompt || "",
    high: templates.find((t) => t.energyLevel === "high")?.prompt || "",
  };

  return segments.map((seg) => {
    // Skip segments that already have user-written prompts
    if (seg.prompt && seg.prompt.trim().length > 0) return seg;

    // Use override if set, otherwise compute from audio energy
    let level: EnergyLevel;
    if (seg.energyOverride) {
      level = seg.energyOverride;
    } else {
      const start = seg.audioStartTime ?? 0;
      const end = seg.audioEndTime ?? 0;
      const windowsInRange = energyData.filter((e) => e.time >= start && e.time < end);
      const avgRms = windowsInRange.length > 0
        ? windowsInRange.reduce((s, e) => s + e.rms, 0) / windowsInRange.length
        : 0;
      level = classifyEnergy(avgRms, highThreshold, mediumThreshold);
    }
    const template = templateMap[level] || templateMap.medium || "";
    const prompt = template.replace(/\{character\}/g, characterDesc || "a performer");

    return { ...seg, prompt };
  });
}

// Compute and stamp detectedEnergy on each segment from audio analysis data.
// Does not overwrite energyOverride: that's user-controlled.
export function computeSegmentEnergy(
  segments: DirectorSegment[],
  energyData: Array<{ time: number; rms: number }>,
  highThreshold = 0.15,
  mediumThreshold = 0.06,
): DirectorSegment[] {
  if (!energyData.length) return segments;
  return segments.map((seg) => {
    const start = seg.audioStartTime ?? 0;
    const end = seg.audioEndTime ?? 0;
    const windowsInRange = energyData.filter((e) => e.time >= start && e.time < end);
    const avgRms = windowsInRange.length > 0
      ? windowsInRange.reduce((s, e) => s + e.rms, 0) / windowsInRange.length
      : 0;
    return { ...seg, detectedEnergy: classifyEnergy(avgRms, highThreshold, mediumThreshold) };
  });
}

// ── AceStep Music Generation ──

export type AceStepMode = "generate" | "extend" | "remix" | "cover";
export type AceStepModelVariant = "turbo" | "sft" | "base";

export interface AceStepConfig {
  // Music parameters
  tags: string;             // genre/style tags (comma-separated)
  lyrics: string;           // song lyrics (multiline)
  duration: number;         // seconds (1-600)
  bpm: number;              // beats per minute (10-300)
  timeSignature: "2" | "3" | "4" | "6";
  language: string;         // en, ja, zh, es, de, fr, etc.
  keyScale: string;         // e.g. "C minor", "A major"
  lyricsStrength: number;   // 0-10, how closely to follow lyrics

  // Generation parameters
  seed: number;
  randomSeed: boolean;
  steps: number;            // turbo: 4-8, sft: 30-50
  samplerShift: number;     // ModelSamplingAuraFlow shift (1.0-5.0)
  generateAudioCodes: boolean; // LLM chain-of-thought planning
  cfgScale: number;         // internal CFG (0-100)
  temperature: number;      // LLM temperature (0-2)
  topP: number;             // nucleus sampling (0-1)
  topK: number;             // top-k sampling (0-100)

  // Model selection
  modelVariant: AceStepModelVariant;
  diffusionModel: string;
  textEncoderSmall: string;
  textEncoderLarge: string;
  vae: string;

  // LoRAs
  userLoras: LoraEntry[];

  // Reference audio (optional)
  referenceAudioFile: string;

  // Mode: generate (default), extend, remix, cover
  aceMode: AceStepMode;
  sourceAudioFile: string;    // uploaded audio for remix/cover/extend
  remixDenoise: number;       // 0-1: how much to change in remix/cover mode
  batchCount: number;         // 1-4: how many variations to generate (different seeds)

  // Audio Reactive Video sub-option
  audioReactiveEnabled: boolean;
  audioReactiveSourceImage: string;   // source image for LTX I2V
  audioReactiveVideoPrompt: string;   // prompt for LTX video generation
  audioReactiveZoom: number;          // 0-1: zoom intensity on beats
  audioReactiveColorCycle: number;    // 0-1: hue rotation from spectral
  audioReactiveBlur: number;          // 0-1: blur on onsets
  audioReactiveWarp: number;          // 0-1: distortion on amplitude
  audioReactiveBrightness: number;    // 0-1: brightness modulation

  // Music Video sub-workflow (AceStep audio → LTX 2.3 A2V)
  musicVideoEnabled: boolean;
  musicVideoPrompt: string;
  musicVideoNegativePrompt: string;
  musicVideoWidth: number;
  musicVideoHeight: number;
  musicVideoNumFrames: number;        // must be 8n+1 (49, 97, 121, 161, 201, 257)
  musicVideoFrameRate: number;
  musicVideoSourceImage: string;      // optional I2V source image
  musicVideoQualityTier: LTX2QualityTier;
  musicVideoLoras: LoraEntry[];
}

export const ACESTEP_MODELS = {
  turbo: "acestep_v1.5_xl_turbo_bf16.safetensors",
  sft: "acestep_v1.5_xl_sft_bf16.safetensors",
  base: "acestep_v1.5_xl_base_bf16.safetensors",
} as const;

export const ACESTEP_MODEL_DEFAULTS = {
  textEncoderSmall: "qwen_0.6b_ace15.safetensors",
  textEncoderLarge: "qwen_4b_ace15.safetensors",
  vae: "ace_1.5_vae.safetensors",
} as const;

export const ACESTEP_LANGUAGES = [
  "en", "ja", "zh", "es", "de", "fr", "pt", "ru", "it", "nl",
  "pl", "tr", "vi", "cs", "fa", "id", "ko", "uk", "hu", "ar", "sv", "ro", "el",
] as const;

export const ACESTEP_KEY_SCALES = [
  ...["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"]
    .flatMap(root => [`${root} major`, `${root} minor`]),
] as const;

export const KEY_VIBES: Record<string, { feel: string; uses: string }> = {
  "C major":  { feel: "Pure, simple, and clean", uses: "Innocent, straightforward pop" },
  "C minor":  { feel: "Heavy, tragic, dramatic", uses: "Intense orchestral, soulful R&B" },
  "D major":  { feel: "Triumphant, bright", uses: "Anthems, high-energy rock" },
  "D minor":  { feel: "Melancholy but driving", uses: "Electronic, moody tracks" },
  "E major":  { feel: "Loud, warm, vibrant", uses: "Classic guitar rock, folk" },
  "E minor":  { feel: "Dark, edgy, tense", uses: "Metal, suspense, deep house" },
  "F major":  { feel: "Pastoral, calm, grounded", uses: "Easy-listening, acoustic" },
  "F# major": { feel: "Shimmering, complex", uses: "Sophisticated pop & R&B" },
  "Gb major": { feel: "Shimmering, complex", uses: "Sophisticated pop & R&B" },
  "G major":  { feel: "Earthy, honest, friendly", uses: "Country, folk, classic pop" },
  "A major":  { feel: "Youthful, cheerful, sunny", uses: "Upbeat indie, pop-punk" },
  "A minor":  { feel: "Versatile; cold but clear", uses: "Modern pop, sad ballads" },
  "Bb major": { feel: "Rich, warm, majestic", uses: "Jazz, orchestral, brass" },
  "B major":  { feel: "Bright, piercing, joyful", uses: "Uplifting pop, dance" },
};

export const ACESTEP_DEFAULTS: AceStepConfig = {
  tags: "pop, upbeat, energetic",
  lyrics: "",
  duration: 120,
  bpm: 120,
  timeSignature: "4",
  language: "en",
  keyScale: "C major",
  lyricsStrength: 1.0,
  seed: -1,
  randomSeed: true,
  steps: 8,
  samplerShift: 3.0,
  generateAudioCodes: true,
  cfgScale: 2.0,
  temperature: 0.85,
  topP: 0.9,
  topK: 0,
  aceMode: "generate",
  sourceAudioFile: "",
  remixDenoise: 0.7,
  batchCount: 1,
  modelVariant: "turbo",
  diffusionModel: ACESTEP_MODELS.turbo,
  textEncoderSmall: ACESTEP_MODEL_DEFAULTS.textEncoderSmall,
  textEncoderLarge: ACESTEP_MODEL_DEFAULTS.textEncoderLarge,
  vae: ACESTEP_MODEL_DEFAULTS.vae,
  userLoras: [],
  referenceAudioFile: "",
  audioReactiveEnabled: false,
  audioReactiveSourceImage: "",
  audioReactiveVideoPrompt: "abstract fractal patterns, flowing waves of light, cosmic energy, psychedelic visuals, kaleidoscope",
  audioReactiveZoom: 0.4,
  audioReactiveColorCycle: 0.3,
  audioReactiveBlur: 0.15,
  audioReactiveWarp: 0.25,
  audioReactiveBrightness: 0.35,
  musicVideoEnabled: false,
  musicVideoPrompt: "singer performing on stage, concert lighting, crowd cheering, cinematic",
  musicVideoNegativePrompt: "worst quality, blurry, jittery, text, watermark, static image",
  musicVideoWidth: 768,
  musicVideoHeight: 512,
  musicVideoNumFrames: 97,
  musicVideoFrameRate: 24,
  musicVideoSourceImage: "",
  musicVideoQualityTier: "distilled" as LTX2QualityTier,
  musicVideoLoras: [],
};

// ── HeartMuLa Music Generation ──

export type HeartMuLaModelVariant = "3B";

export interface HeartMuLaConfig {
  // Music parameters
  tags: string;             // style tags (comma-separated): genre, vocal, mood, tempo, instruments
  lyrics: string;           // song lyrics with section markers [Verse], [Chorus], etc.
  maxDuration: number;      // seconds (10-240, max 4 minutes)

  // Generation parameters
  seed: number;
  randomSeed: boolean;
  temperature: number;      // 0.1-2.0 sampling temperature
  topK: number;             // 1-500 top-k sampling
  cfgScale: number;         // 1.0-10.0 classifier-free guidance

  // Model settings
  modelVariant: HeartMuLaModelVariant;
  memoryMode: "auto" | "normal" | "low" | "ultra";
  precision: "auto" | "fp32" | "fp16" | "bf16";
  use4bit: boolean;

  // Batch
  batchCount: number;       // 1-4 variations
}

export const HEARTMULA_LANGUAGES = ["en", "zh", "ja", "ko", "es"] as const;

export const HEARTMULA_SECTION_MARKERS = [
  "[Intro]", "[Verse]", "[Prechorus]", "[Chorus]", "[Bridge]", "[Outro]", "[Instrumental]",
] as const;

export const HEARTMULA_DEFAULTS: HeartMuLaConfig = {
  tags: "pop, female vocal, energetic",
  lyrics: "",
  maxDuration: 60,
  seed: -1,
  randomSeed: true,
  temperature: 1.0,
  topK: 50,
  cfgScale: 1.5,
  modelVariant: "3B",
  memoryMode: "auto",
  precision: "auto",
  use4bit: false,
  batchCount: 1,
};

// ── DramaBox TTS (Resemble AI) ──

export type DramaBoxGenerationMode = "clip_loader" | "dramabox_wrapper";
export type DramaBoxModelPolicy = "keep_loaded" | "offload_to_cpu" | "offload";

export interface DramaBoxConfig {
  // Prompt
  prompt: string;

  // Voice reference
  voiceRefFile: string;       // ComfyUI input/ filename for uploaded voice reference
  refDuration: number;        // how many seconds of voice ref to use (1-30)

  // Generation parameters
  seed: number;
  randomSeed: boolean;
  steps: number;              // denoising steps (10-80)
  cfgScale: number;           // classifier-free guidance (1-10)
  stgScale: number;           // skip-token guidance (0-5)
  rescaleScale: number;       // -1 = auto, 0-1 = manual
  idGuidanceScale: number;    // identity guidance (0-10)

  // Duration
  genDuration: number;        // 0 = auto-estimate from prompt
  durationMultiplier: number; // headroom multiplier (0.5-3.0)
  speed: number;              // speaking rate (0.1-3.0)

  // Negative prompt
  negativePrompt: string;

  // Model / Memory
  generationMode: DramaBoxGenerationMode;
  modelPolicy: DramaBoxModelPolicy;
  textEncoder: string;        // Gemma model filename in text_encoders/

  // LoRAs (voice LoRAs)
  userLoras: LoraEntry[];
}

export const DRAMABOX_DEFAULT_NEGATIVE = "worst quality, inconsistent, robotic, distorted, noise, static, muffled, unclear, unnatural, monotone";

export const DRAMABOX_DEFAULTS: DramaBoxConfig = {
  prompt: "",
  voiceRefFile: "",
  refDuration: 10.0,
  seed: -1,
  randomSeed: true,
  steps: 30,
  cfgScale: 2.5,
  stgScale: 1.5,
  rescaleScale: -1.0,
  idGuidanceScale: 3.0,
  genDuration: 0,
  durationMultiplier: 1.1,
  speed: 1.0,
  negativePrompt: DRAMABOX_DEFAULT_NEGATIVE,
  generationMode: "clip_loader",
  modelPolicy: "offload",
  textEncoder: "gemma_3_12B_it_fp4_mixed.safetensors",
  userLoras: [],
};

export const DRAMABOX_PROMPT_EXAMPLES = [
  {
    label: "Warm Greeting",
    prompt: 'A woman speaks warmly, "Hello, how are you today?" She laughs, "Hahaha, it is so good to see you!"',
  },
  {
    label: "Cold Fury Queen",
    prompt: 'A regal woman speaks with cold fury in a measured, low voice. She sighs deeply, "I have told you a thousand times, and yet here we are again." Her voice sharpens with rising anger, "Do you honestly think I enjoy repeating myself?! Do you?!" She lets out a cold, mocking laugh, "Hahaha, how utterly pathetic you are."',
  },
  {
    label: "Playful Giggling",
    prompt: 'A playful girl speaks in a bright, singsong voice, already mid-giggle, "Hehehe, oh my gosh you should see your face right now, it is priceless!" She gasps for air between giggles, "Oh my, hehe, oh my, I cannot stop laughing!"',
  },
  {
    label: "Villain Sinister",
    prompt: 'A deep-voiced villain speaks with theatrical menace, chuckling softly at first, "Heh heh heh, ha ha ha ha ha! Oh, forgive me, forgive me." He catches his breath with a sinister grin, He clears his throat. "It is just SO amusing when they struggle, is it not?"',
  },
  {
    label: "Whispered Secret",
    prompt: 'A young woman whispers conspiratorially, leaning close, "Can I tell you a secret?" A long pause. She continues even softer, "I have been thinking about this all day, and I just cannot keep it in anymore."',
  },
];

// ── VS Movie Maker (Multi-Speaker Dialogue) ──

export type MovieMakerEngine = "dramabox";

export interface MovieMakerCharacter {
  id: string;
  name: string;
  age: string;                   // e.g. "24", "mid-30s" - used by SFX and DIR for physical descriptions
  gender: string;                // e.g. "female", "male" - used by SFX to describe character sounds
  role: string;                  // e.g. "Protagonist", "Detective", "Narrator"
  personality: string;           // e.g. "Sarcastic, quick-witted, guarded"
  description: string;           // Physical/vocal description for the script writer
  voiceSampleFile: string;       // filename in ComfyUI/input/ or absolute path
  voiceSamplePreview: string;    // blob URL for playback in UI
  color: string;                 // UI accent color for this character
}

// ── Scene perspective (camera framing) ──
// Per-scene camera perspective chosen in the Scene Panel. "default" lets the
// writer decide; pov/ots require a target character (the camera subject / whose
// shoulder). The rewriteInstruction guides the LLM re-write when perspective changes.
export type ScenePerspective = "default" | "pov" | "ots" | "wide" | "closeup" | "aerial";

export interface ScenePerspectiveOption {
  id: ScenePerspective;
  label: string;
  needsCharacter: boolean; // requires a target character (POV / over-the-shoulder)
  hint: string;            // short tooltip shown in the dropdown
  rewriteInstruction: string; // guidance injected into the scene re-write; {char} = target character description
}

export const SCENE_PERSPECTIVE_OPTIONS: ScenePerspectiveOption[] = [
  {
    id: "default",
    label: "Third-person cinematic",
    needsCharacter: false,
    hint: "Writer chooses the most fitting framing for the scene.",
    rewriteInstruction:
      "Frame this scene in third person with conventional cinematic coverage: the camera observes the characters from outside. Describe each visible character briefly and where they are in the frame.",
  },
  {
    id: "pov",
    label: "First-person POV",
    needsCharacter: true,
    hint: "The camera IS a chosen character's eyes. They are never seen.",
    rewriteInstruction:
      "Rewrite as a strict first-person POV from {char}. The camera is {char}'s eyes: NEVER describe {char}'s own face or body (only their hands/arms may enter frame if they are acting). Describe only what {char} sees in front of them: the other people, objects, and environment.",
  },
  {
    id: "ots",
    label: "Over-the-shoulder",
    needsCharacter: true,
    hint: "Framed over a chosen character's shoulder toward what they face.",
    rewriteInstruction:
      "Frame this scene over the shoulder of {char}: the back of {char}'s head/shoulder is soft in the near foreground at one edge, with the person or focal point they face sharp in the frame beyond them.",
  },
  {
    id: "wide",
    label: "Wide establishing shot",
    needsCharacter: false,
    hint: "Pull back to show the whole space and where everyone is.",
    rewriteInstruction:
      "Frame this scene as a wide establishing shot: emphasize the full setting and spatial layout, with the characters smaller within the environment so their positions and the location read clearly.",
  },
  {
    id: "closeup",
    label: "Close-up / intimate",
    needsCharacter: false,
    hint: "Tight framing on the key subject's face or detail.",
    rewriteInstruction:
      "Frame this scene as an intimate close-up: tight on the key subject's face or a telling detail, shallow but structured background, emphasizing expression and emotion.",
  },
  {
    id: "aerial",
    label: "Aerial / high-angle",
    needsCharacter: false,
    hint: "Looking down on the scene from above.",
    rewriteInstruction:
      "Frame this scene from a high angle looking down on the space: describe the overhead vantage, the layout of the floor/ground, and the characters as seen from above.",
  },
];

// Per-scene panel metadata, aligned by order to the [DIR] blocks parsed from the script.
export interface MovieMakerSceneMeta {
  perspective: ScenePerspective;
  targetCharId: string; // MovieMakerCharacter.id for pov/ots; "" otherwise
  dirty: boolean;       // perspective changed since last write - needs a re-write (shown amber until re-written)
}

export interface MovieMakerConfig {
  // Script
  script: string;

  // Characters (unlimited for DramaBox per-line)
  characters: MovieMakerCharacter[];

  // Per-scene camera perspective metadata (Scene Panel), aligned to [DIR] block order
  scenePerspectives: MovieMakerSceneMeta[];

  // Film-wide default perspective that seeds new scenes
  defaultPerspective: ScenePerspective;

  // Engine selection
  engine: MovieMakerEngine;

  // Pipeline control
  pauseBetweenSegments: boolean;

  // Generation parameters
  seed: number;
  randomSeed: boolean;
  cfgScale: number;
  numSteps: number;
  doSample: boolean;
  temperature: number;
  topK: number;
  topP: number;
  repetitionPenalty: number;
  chunkBySpeaker: boolean;
}

export const MOVIEMAKER_CHARACTER_COLORS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#10b981", // emerald
  "#f59e0b", // amber
];

export const MOVIEMAKER_DEFAULTS: MovieMakerConfig = {
  script: "",
  characters: [],
  scenePerspectives: [],
  defaultPerspective: "default",
  engine: "dramabox",
  pauseBetweenSegments: false,
  seed: -1,
  randomSeed: true,
  cfgScale: 3.0,
  numSteps: 20,
  doSample: true,
  temperature: 0.9,
  topK: 50,
  topP: 0.95,
  repetitionPenalty: 1.0,
  chunkBySpeaker: true,
};
