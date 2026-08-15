// Shared shapes for the broadened Model Library scan. Importable by client UI.

export type ModelKind = "generative" | "functional";

export interface ModelScanEntry {
  /** Path relative to its scan directory (may include subfolders). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** ComfyUI model sub-key this came from, e.g. "checkpoints", "vae". */
  subKey: string;
  /** Bucket: generative checkpoints vs functional/utility models. */
  kind: ModelKind;
  /** File size in bytes. */
  sizeBytes: number;
}

export interface ModelScanResult {
  generative: ModelScanEntry[];
  functional: ModelScanEntry[];
}
