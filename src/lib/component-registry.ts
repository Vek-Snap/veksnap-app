/**
 * Component Registry: defines all known installable components in Vek-Snap.
 * Each component has a source (GitHub/HuggingFace), an install path, and
 * methods to detect its installed version.
 */
import path from "path";

const INSTALL_ROOT = path.resolve(process.cwd(), "..");

// ── Types ──

export type ComponentType = "service" | "model" | "module" | "lora" | "vae" | "llm";
export type SourceType = "github" | "huggingface";

export interface ComponentSource {
  type: SourceType;
  repo: string;         // e.g. "comfyanonymous/ComfyUI" or "Lightricks/LTX-Video"
  branch?: string;      // default branch for github repos
  file?: string;        // specific file path within the repo (for HF single-file downloads)
  subdir?: string;      // subdirectory within repo to check for version/files
}

export interface ComponentDef {
  id: string;
  name: string;
  description: string;
  type: ComponentType;
  installPath: string;         // relative to INSTALL_ROOT
  source: ComponentSource;
  sizeEstimate?: string;       // human-readable, e.g. "~4.5 GB"
  versionDetect?: "git" | "file-exists" | "safetensors-metadata";
  critical?: boolean;          // if true, component is required for core functionality
  tags?: string[];             // for filtering in UI
  /** Alternative filenames that also satisfy the "installed" check (e.g. fp8/fp4 variants) */
  alternateFiles?: string[];
  /** YAML key in extra_model_paths.yaml to search (e.g. "diffusion_models", "vae", "loras") */
  modelSubdir?: string;
  /**
   * GitHub update channel. "release" pins to the newest semver *release tag* (stable);
   * "head" tracks the branch HEAD (bleeding edge, may break custom nodes). Default: "release".
   */
  updateChannel?: "release" | "head";
  /**
   * The staff-validated known-good ref (a release tag like "v0.30.0", or a commit hash for
   * un-tagged custom nodes). Updating *to* this ref is classified SAFE; moving beyond it
   * (newer release, or bleeding-edge HEAD) is CAUTION/UNSAFE and requires explicit acceptance.
   */
  knownGoodRef?: string;
  /** Steps to run automatically after a successful git update (e.g. sync Python deps). */
  postUpdate?: PostUpdateSpec;
}

/** A local ComfyUI-core patch. MUST stay empty in this shipped tree (see PostUpdateSpec.corePatches). */
export interface CorePatch {
  id: string;
  /** Patch file path relative to the app root (cwd), or absolute. */
  file: string;
  description?: string;
}

export interface PostUpdateSpec {
  /**
   * Run `pip install -r requirements.txt` (NO `-U`, so an already-installed torch stack is left
   * untouched) after a successful git update, so new code doesn't run against stale Python deps.
   */
  pipInstall?: boolean;
  /**
   * Local ComfyUI-core patches to re-apply after upgrade. MUST stay EMPTY in this shipped tree:
   * shipping a modified ComfyUI core would convey a modified GPL-3.0 work. Any core enhancement is
   * instead offered as a *client-initiated* action (the user applies it to their own machine).
   */
  corePatches?: CorePatch[];
}

export interface InstalledComponent extends ComponentDef {
  installed: boolean;
  installedVersion?: string;   // git hash, file mod date, or metadata version
  installedDate?: string;      // ISO date string
  fileSizeBytes?: number;
}

/** Upgrade safety classification (see classifySafety). */
export type UpdateSafety = "safe" | "caution" | "unsafe";

export interface UpdateInfo {
  componentId: string;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  latestDate?: string;
  releaseNotes?: string;
  downloadUrl?: string;
  downloadSizeBytes?: number;
  /** The ref an "Update" would move to (release tag or commit). */
  targetRef?: string;
  /** Safety classification of moving to targetRef. */
  safety?: UpdateSafety;
  /** Human-readable reason for the classification. */
  safetyReason?: string;
  /** True when safety !== "safe": the user must explicitly accept responsibility. */
  requiresAck?: boolean;
}

// ── Registry ──

export const COMPONENT_REGISTRY: ComponentDef[] = [
  // ─── Services ───
  {
    id: "comfyui",
    name: "ComfyUI",
    description: "Core image & video generation engine",
    type: "service",
    installPath: "ComfyUI",
    source: { type: "github", repo: "comfyanonymous/ComfyUI" },
    versionDetect: "git",
    critical: true,
    tags: ["core", "service"],
    updateChannel: "release",
    // Staff-validated release. Bump only after a boot test + workflow-builder class_type
    // cross-check passes on the new release (see the ComfyUI upgrade logs).
    knownGoodRef: "v0.27.0",
    postUpdate: {
      // A ComfyUI git bump can change frontend/aimdo/kitchen/templates deps; sync them so new
      // code doesn't run on stale packages. No `-U` => the installed torch stack is held.
      pipInstall: true,
      // Shipped tree keeps ComfyUI core PRISTINE (GPL). No core patches here.
      corePatches: [],
    },
  },

  // ─── Checkpoints ───
  {
    id: "ltx-video-2.3",
    name: "LTX Video 2.3",
    description: "Main video generation checkpoint (Lightricks)",
    type: "model",
    installPath: "ComfyUI/models/diffusion_models",
    source: { type: "huggingface", repo: "Lightricks/LTX-2.3-fp8", file: "ltx-2.3-22b-dev-fp8.safetensors" },
    alternateFiles: ["ltx-2.3-22b-dev-fp8.safetensors", "ltx-2.3-22b-dev-nvfp4.safetensors", "ltx-2.3-22b-distilled-1.1.safetensors"],
    modelSubdir: "diffusion_models",
    versionDetect: "file-exists",
    sizeEstimate: "~9.8 GB",
    critical: true,
    tags: ["model", "video", "checkpoint"],
  },

  // ─── VAEs ───
  {
    id: "ltx-video-vae",
    name: "LTX Video VAE",
    description: "VAE decoder for LTX Video pipeline",
    type: "vae",
    installPath: "ComfyUI/models/vae",
    source: { type: "huggingface", repo: "Kijai/LTX2.3_comfy", file: "vae/LTX23_video_vae_bf16.safetensors" },
    alternateFiles: ["LTX23_video_vae_bf16.safetensors"],
    modelSubdir: "vae",
    versionDetect: "file-exists",
    sizeEstimate: "~320 MB",
    tags: ["model", "video", "vae"],
  },

  // ─── LoRAs ───
  {
    id: "ltx-av-lora-talking-head",
    name: "LTX A2V Talking Head LoRA",
    description: "Audio-to-video talking head LoRA for lip-sync",
    type: "lora",
    installPath: "ComfyUI/models/loras",
    source: { type: "huggingface", repo: "elix3r/LTX-2.3-22b-AV-LoRA-talking-head", file: "LTX-2.3-22b-AV-LoRA-talking-head-v1.safetensors" },
    modelSubdir: "loras",
    versionDetect: "file-exists",
    sizeEstimate: "~654 MB",
    tags: ["model", "video", "lora"],
  },
  {
    id: "ltx-ic-lora-union",
    name: "LTX IC-LoRA Union Control",
    description: "Video-guided generation (Canny+Depth+Pose)",
    type: "lora",
    installPath: "ComfyUI/models/loras",
    source: { type: "huggingface", repo: "Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control", file: "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors" },
    modelSubdir: "loras",
    versionDetect: "file-exists",
    sizeEstimate: "~654 MB",
    tags: ["model", "video", "lora"],
  },

  // ─── LLMs ───
  {
    id: "qwen2.5-vl-7b",
    name: "Qwen2.5-VL-7B (Vision)",
    description: "Vision-language model for image description",
    type: "llm",
    installPath: path.join("ComfyUI", "models", "Qwen2.5-VL-7B-Instruct"),
    source: { type: "huggingface", repo: "Qwen/Qwen2.5-VL-7B-Instruct" },
    versionDetect: "file-exists",
    sizeEstimate: "~16 GB",
    tags: ["model", "llm", "vision"],
  },
  {
    id: "qwen2.5-7b-instruct",
    name: "Qwen2.5-7B-Instruct (Text)",
    description: "Text LLM for prompt expansion",
    type: "llm",
    installPath: path.join("ComfyUI", "models", "Qwen2.5-7B-Instruct"),
    source: { type: "huggingface", repo: "Qwen/Qwen2.5-7B-Instruct" },
    versionDetect: "file-exists",
    sizeEstimate: "~15 GB",
    tags: ["model", "llm", "text"],
  },
];

// ── Helpers ──

export function getAbsoluteInstallPath(comp: ComponentDef): string {
  if (path.isAbsolute(comp.installPath)) return comp.installPath;
  return path.join(INSTALL_ROOT, comp.installPath);
}

export function getComponentById(id: string): ComponentDef | undefined {
  return COMPONENT_REGISTRY.find((c) => c.id === id);
}

// ── Safe-upgrade classification (shared core logic used by the API + UI) ──

/** Parse a semver-ish tag ("v0.30.0", "0.30", "1.2.3-rc1") into [major, minor, patch]. */
export function parseSemver(ref?: string): [number, number, number] | null {
  if (!ref) return null;
  const m = ref.trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

/** Compare two semver tags. Returns <0 if a<b, 0 if equal, >0 if a>b. Non-semver sorts last. */
export function semverCompare(a?: string, b?: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export interface ClassifyOpts {
  /** Where the update would move: "release" (semver tag), "head" (branch tip), or "file" (HF data). */
  channel: "release" | "head" | "file";
  /** Whether this component is a ComfyUI custom node (lower blast radius than the core engine). */
  isNode: boolean;
  /** Our staff-validated known-good ref. */
  blessedRef?: string;
  /** The ref the update would move to. */
  targetRef?: string;
  /** True when targetRef is a proper semver release tag. */
  targetIsRelease: boolean;
}

/**
 * Classify an upgrade's safety. Philosophy (matches the "staff-tested" model):
 *   • SAFE: moving TO the staff-validated version (or a data-only file update).
 *   • CAUTION: a newer stable release than we've validated, or an un-tagged custom-node commit.
 *   • UNSAFE: the bleeding-edge core HEAD, a non-release commit, or a major-version jump.
 * CAUTION/UNSAFE require the user to explicitly accept responsibility before running.
 */
export function classifySafety(o: ClassifyOpts): { safety: UpdateSafety; reason: string } {
  if (o.channel === "file") {
    return { safety: "safe", reason: "Data/model file update: no engine code changes." };
  }
  if (o.targetRef && o.blessedRef && o.targetRef === o.blessedRef) {
    return { safety: "safe", reason: "Moves to the staff-validated version." };
  }
  if (o.channel === "head" || !o.targetIsRelease) {
    return o.isNode
      ? { safety: "caution", reason: "Custom-node update tracks the latest commit (no tagged release). Unverified here." }
      : { safety: "unsafe", reason: "Moves the core engine to an untagged bleeding-edge commit: may break custom nodes." };
  }
  // Release-channel target that differs from our blessed release.
  if (o.blessedRef && parseSemver(o.blessedRef)) {
    const cmp = semverCompare(o.targetRef, o.blessedRef);
    if (cmp <= 0) return { safety: "safe", reason: "Target is the staff-validated release (or older)." };
    const t = parseSemver(o.targetRef)!;
    const b = parseSemver(o.blessedRef)!;
    if (t[0] > b[0]) return { safety: "unsafe", reason: "Major-version jump beyond the validated release." };
    return { safety: "caution", reason: "Newer stable release than the staff-validated version: not yet verified here." };
  }
  return { safety: "caution", reason: "No staff-validated baseline recorded for this component." };
}
