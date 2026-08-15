// Shared shape for user-created Library categories. These form an app-global
// taxonomy (stored in library-categories.json next to veksnap-settings.json); a
// model is assigned to one by writing its name into the model's sidecar
// `category` field. Importable by both the store route and the Library UI.

export interface LibraryCategory {
  /** Unique, user-facing name (also the value written to a model's sidecar). */
  name: string;
  /** Badge colour as a hex string, e.g. "#7c3aed". */
  color: string;
}

/** A safe default palette offered in the picker (users can still pick any hex). */
export const DEFAULT_CATEGORY_COLOR = "#38bdf8";
