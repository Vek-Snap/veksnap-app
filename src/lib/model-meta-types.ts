// Shared shape for a model's user-curated sidecar metadata (`<model>.model-meta.json`,
// stored next to the model file). Importable by both server routes and client UI.
//
// This is the durable home for the things users edit in the Library, trigger
// words, a category override, notes, favorite flag, and a chosen preview image.
// The rename API moves this sidecar alongside the model so edits survive renames.

export interface ModelMeta {
  version: number;
  /** User-curated trigger/activation words. */
  triggerWords: string[];
  /** Category override ("" = fall back to auto-classification). */
  category: string;
  /** Free-form user notes. */
  notes: string;
  /** Favorite / pinned. */
  favorite: boolean;
  /** Filename (relative to the model's own folder) of a preview image, "" if none. */
  preview: string;
  /** CivitAI model-version id this file is linked to (0 = not linked). Persists
   *  the association so previews can be re-fetched without re-hashing or re-pasting. */
  civitaiVersionId: number;
  /** CivitAI model id (0 = unknown). */
  civitaiModelId: number;
  /** Privacy Control: when true this card's media is obscured (mosaic/blur) while
   *  the Library's master Privacy toggle is on. Stored per-model so it's portable. */
  mosaic: boolean;
  /** Last-write epoch ms. */
  updatedAt: number;
}

export const EMPTY_MODEL_META: ModelMeta = {
  version: 1,
  triggerWords: [],
  category: "",
  notes: "",
  favorite: false,
  preview: "",
  civitaiVersionId: 0,
  civitaiModelId: 0,
  mosaic: false,
  updatedAt: 0,
};
