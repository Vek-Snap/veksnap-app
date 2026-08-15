/**
 * Shared server-side settings reader.
 * Used by API routes to read the persistent veksnap-settings.json.
 */
import fs from "fs";
import path from "path";

const SETTINGS_PATH = path.resolve(process.cwd(), "veksnap-settings.json");

export interface VekSnapSettings {
  extraCheckpointDirs: string[];
  allowOnline: boolean;
  verboseLogs: boolean;
  ramReserveMB: number;
  // Primary models directory. Empty = use the portable default
  // `<install-root>/ComfyUI/models` (see getModelsRoot).
  modelsRoot: string;
  // Optional fast-SSD / RAM-disk override for scratch/temp. Empty = OS temp.
  fastTempRoot: string;
  // Optional CivitAI API key (used only when Allow Online is on) for preview /
  // trigger-word lookups. Empty = keyless (public content only). Never logged.
  civitaiApiKey: string;
}

const DEFAULTS: VekSnapSettings = {
  extraCheckpointDirs: [],
  allowOnline: false,
  verboseLogs: false,
  ramReserveMB: 4096,
  modelsRoot: "",
  fastTempRoot: "",
  civitaiApiKey: "",
};

export function readVekSnapSettings(): VekSnapSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Returns the env vars for HuggingFace / Transformers offline mode.
 * When allowOnline is false (default), sets HF_HUB_OFFLINE=1, etc.
 * When allowOnline is true, omits them so downloads proceed normally.
 *
 * Always includes `getHfCacheEnv()` so HF caches land inside the Vek-Snap workspace
 * instead of `~/.cache/huggingface/`: keeps the project self-contained and
 * makes inventory / portability work simpler.
 */
export function getOfflineEnv(): Record<string, string> {
  const settings = readVekSnapSettings();
  const cache = getHfCacheEnv();
  // Pin spawned Python to OUR bundled runtime only, never the customer machine's
  // user-site-packages (%APPDATA%\Python\PythonXX\site-packages). If a customer has
  // a stray global/user-site install of transformers/torch/torchaudio, it can shadow
  // our runtime and make model loads crash (e.g. a torch↔torchaudio CUDA-version
  // mismatch surfaces as a misleading "Could not import module '<Model>ForCausalLM'").
  // Our packaged interpreter is a venv (user-site already off), but findPython() can
  // fall back to a conda/system python where user-site is ON, so we force it off
  // here for every subprocess, in both online and offline modes.
  const isolate = { PYTHONNOUSERSITE: "1" };
  if (settings.allowOnline) {
    return { VEKSNAP_ALLOW_ONLINE: "1", ...isolate, ...cache };
  }
  return {
    ...isolate,
    // Block HuggingFace / Transformers auto-downloads
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    // Block ALL outbound HTTP: catches raw requests/urllib/aiohttp calls
    // in custom nodes (e.g. LatentSyncWrapper, facerestore_cf, SeedVR2)
    HTTP_PROXY: "http://0.0.0.0:0",
    HTTPS_PROXY: "http://0.0.0.0:0",
    NO_PROXY: "localhost,127.0.0.1,0.0.0.0",
    // Prevent pip from reaching PyPI during lazy installs
    PIP_NO_INDEX: "1",
    // Block interactive git auth prompts
    GIT_TERMINAL_PROMPT: "0",
    ...cache,
  };
}

/**
 * Resolves the workspace-local HuggingFace cache directory and returns the env
 * vars that tell `huggingface_hub` / `transformers` to use it. Located at
 * `<workspace>/.hf_cache/` (sibling of `veksnap-app/`), so it lives within the
 * Vek-Snap project root rather than the user profile.
 *
 * Auto-creates the directory on first call. Safe to invoke repeatedly.
 *
 * Env vars set:
 *   - HF_HOME: root for all HF tooling (datasets, hub, etc.)
 *   - HF_HUB_CACHE: explicit hub-only override; transformers honors this for model weights
 *   - TRANSFORMERS_CACHE: legacy variable some versions still read
 */
export function getHfCacheEnv(): Record<string, string> {
  const installRoot = path.resolve(process.cwd(), "..");
  const root = path.join(installRoot, ".hf_cache");
  const hub = path.join(root, "hub");
  // Regenerable compute caches (torch extensions, triton fp8 kernels, generic XDG).
  // Redirected into <install>/.cache so nothing lands under ~/.cache or AppData.
  const computeCache = path.join(installRoot, ".cache");
  const torchHome = path.join(computeCache, "torch");
  const tritonCache = path.join(computeCache, "triton");
  try {
    fs.mkdirSync(hub, { recursive: true });
    fs.mkdirSync(torchHome, { recursive: true });
    fs.mkdirSync(tritonCache, { recursive: true });
  } catch {
    /* non-fatal: let the child process error if it actually can't write */
  }
  return {
    HF_HOME: root,
    HF_HUB_CACHE: hub,
    TRANSFORMERS_CACHE: hub,
    // Keep GPU/compile caches inside the install dir (see 10_SECURITY_AND_PRIVACY_HARDENING).
    TORCH_HOME: torchHome,
    TRITON_CACHE_DIR: tritonCache,
    XDG_CACHE_HOME: computeCache,
    // Defense-in-depth telemetry kill (redundant with the offline proxy dead-end,
    // but explicit so nothing tracks even when the user opens the online gate).
    HF_HUB_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    WANDB_DISABLED: "true",
    WANDB_MODE: "offline",
  };
}

/**
 * Resolves the primary models root.
 * Uses the user-configured `modelsRoot` when set; otherwise falls back to the
 * portable default `<install-root>/ComfyUI/models` (the install root is the
 * parent of `veksnap-app/`, with `ComfyUI/` as a sibling).
 */
export function getModelsRoot(): string {
  const configured = readVekSnapSettings().modelsRoot?.trim();
  if (configured) return configured;
  return path.resolve(process.cwd(), "..", "ComfyUI", "models");
}

/**
 * Resolves an absolute path to a model directory/file by name under the
 * configured models root, e.g. getModelPath("Qwen2.5-7B-Instruct").
 */
export function getModelPath(name: string): string {
  return path.join(getModelsRoot(), name);
}

/**
 * Directory names of the text-prompt LLMs we support, in preference order:
 * the full 7B first, then the smaller CPU/AMD fallbacks (installer "Text LLM
 * (CPU/AMD fallback)" card), then the VL model last (it can also do text-only
 * prompting, just heavier). Kept in sync with the installer model catalog.
 */
export const PROMPT_LLM_CANDIDATES = [
  "Qwen2.5-7B-Instruct",
  "Qwen2.5-3B-Instruct",
  "Qwen2.5-1.5B-Instruct",
  "Qwen2.5-VL-7B-Instruct",
] as const;

/**
 * Resolves the best INSTALLED text-prompt LLM directory. Lets CPU/AMD customers
 * who could only install a smaller fallback model still use the prompt tools,
 * instead of every route hard-failing on the missing 7B. Returns the first
 * candidate that exists on disk; if none exist, returns the 7B path so callers
 * still emit a sensible "download Qwen2.5-7B-Instruct" message.
 */
export function resolvePromptLlm(): string {
  const root = getModelsRoot();
  for (const name of PROMPT_LLM_CANDIDATES) {
    const p = path.join(root, name);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore and try next */
    }
  }
  return path.join(root, PROMPT_LLM_CANDIDATES[0]);
}

/**
 * Optional fast-SSD / RAM-disk scratch root. Returns the configured
 * `fastTempRoot` when set, otherwise an empty string (callers should fall back
 * to the OS temp dir).
 */
export function getFastTempRoot(): string {
  return readVekSnapSettings().fastTempRoot?.trim() || "";
}
