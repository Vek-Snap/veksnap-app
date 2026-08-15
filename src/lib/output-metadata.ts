// ─────────────────────────────────────────────────────────────────────────────
// Output metadata embedding: client helpers.
//
// Three independent, privacy-sensitive options (all default OFF) control what
// Vek-Snap writes INTO the files it produces (image / video / audio):
//
//   • basic: authorship tags (Software: Vek-Snap, Author, Comment).
//   • workflow: the full ComfyUI workflow + prompt JSON (re-openable in Comfy).
//   • summary: a compact "what made this" note: model + LoRA(s)+strengths + seed.
//
// The flags are persisted SERVER-side (veksnap-settings.json via /api/settings)
// so the embedding backend (/api/embed-metadata) can read them authoritatively.
// The "don't warn me again" acknowledgement is pure UX and lives in localStorage.
// ─────────────────────────────────────────────────────────────────────────────

export type OutputMetaKey = "outputEmbedBasic" | "outputEmbedWorkflow" | "outputEmbedSummary";

export interface OutputMetaFlags {
  outputEmbedBasic: boolean;
  outputEmbedWorkflow: boolean;
  outputEmbedSummary: boolean;
}

export const OUTPUT_META_DEFAULTS: OutputMetaFlags = {
  outputEmbedBasic: false,
  outputEmbedWorkflow: false,
  outputEmbedSummary: false,
};

/** A ComfyUI-produced file the embed/delete backend can resolve on disk. */
export interface OutputFileRef {
  filename: string;
  subfolder?: string;
  type?: string; // "output" | "input" | "temp" - defaults to "output"
}

/** Compact generation summary (option 3). Kept intentionally minimal. */
export interface OutputSummary {
  model: string;
  seed: number | null;
  loras: { name: string; strength: number }[];
}

const PRIVACY_ACK_KEY = "veksnap-output-privacy-ack";

/** Whether the user has chosen to never see the privacy warning again. */
export function isPrivacyWarningAcked(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(PRIVACY_ACK_KEY) === "1"; } catch { return false; }
}

export function setPrivacyWarningAcked(acked: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (acked) localStorage.setItem(PRIVACY_ACK_KEY, "1");
    else localStorage.removeItem(PRIVACY_ACK_KEY);
  } catch { /* ignore */ }
}

/** Read the three flags from the server settings store (defaults on failure). */
export async function loadOutputFlags(): Promise<OutputMetaFlags> {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return { ...OUTPUT_META_DEFAULTS };
    const s = await res.json();
    return {
      outputEmbedBasic: !!s.outputEmbedBasic,
      outputEmbedWorkflow: !!s.outputEmbedWorkflow,
      outputEmbedSummary: !!s.outputEmbedSummary,
    };
  } catch {
    return { ...OUTPUT_META_DEFAULTS };
  }
}

/** Persist a single flag to the server settings store. Returns success. */
export async function setOutputFlag(key: OutputMetaKey, value: boolean): Promise<boolean> {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", key, value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** True if at least one embedding option is enabled. */
export function anyOutputFlagOn(flags: OutputMetaFlags): boolean {
  return flags.outputEmbedBasic || flags.outputEmbedWorkflow || flags.outputEmbedSummary;
}

/** Build the compact summary object from resolved generation values. */
export function buildOutputSummary(args: {
  model: string;
  seed: number | null;
  loras?: { name: string; enabled?: boolean; strengthModel?: number }[];
}): OutputSummary {
  const loras = (args.loras ?? [])
    .filter((l) => l && l.enabled !== false && !!l.name)
    .map((l) => ({ name: l.name, strength: Number(l.strengthModel ?? 1) }));
  return { model: args.model, seed: args.seed, loras };
}

/**
 * Apply the enabled metadata options to a batch of freshly-produced output
 * files. Self-gating: fetches the current flags and no-ops when all are OFF, so
 * callers can invoke it unconditionally after a generation. Best-effort, never
 * throws (embedding must never break a successful render).
 */
export async function applyOutputMetadata(args: {
  files: OutputFileRef[];
  workflow?: Record<string, unknown> | null;
  summary?: OutputSummary | null;
}): Promise<{ ok: boolean; processed: number }> {
  try {
    if (!args.files || args.files.length === 0) return { ok: true, processed: 0 };
    const flags = await loadOutputFlags();
    if (!anyOutputFlagOn(flags)) return { ok: true, processed: 0 };
    const res = await fetch("/api/embed-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: args.files, workflow: args.workflow ?? null, summary: args.summary ?? null }),
    });
    if (!res.ok) return { ok: false, processed: 0 };
    const data = await res.json().catch(() => ({}));
    return { ok: true, processed: Number(data?.processed ?? 0) };
  } catch {
    return { ok: false, processed: 0 };
  }
}
