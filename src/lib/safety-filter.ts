// safety-filter.ts
// Always-on child-safety prompt filter (Tier-1 combination matcher). Refuses when a
// MINOR indicator and a SEXUAL indicator co-occur (or an under-18 age cue + sexual
// indicator). Ported from the reference `safety-filter.mjs` and wired into the app's
// generation funnel (the ComfyUI proxy route). No I/O beyond the bundled wordlist.
//
// This protection is NOT user-configurable and cannot be disabled.

import safetyData from "./safety-data.generated.json";

// --- data loading ----------------------------------------------------------
function b64decode(b64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
  // Fallback for non-Node environments.
  if (typeof atob !== "undefined") {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }
  throw new Error("No base64 decoder available");
}

type RawData = { minorAgeMax?: number; numberWords?: Record<string, number>; m: string; s: string };
const raw = safetyData as unknown as RawData;

const DATA = {
  minorAgeMax: raw.minorAgeMax ?? 17,
  numberWords: (raw.numberWords ?? {}) as Record<string, number>,
  m: JSON.parse(b64decode(raw.m)) as string[],
  s: JSON.parse(b64decode(raw.s)) as string[],
};

// --- term indexes ----------------------------------------------------------
// Single-word terms => exact token match. Multi-word terms => phrase search.
// "Glued" forms (letters only, length >= 4) => substring match to catch
// spaced-out / glued obfuscation while limiting short-term false positives.
type TermIndex = { singles: Set<string>; multi: string[]; glued: Set<string> };

function indexTerms(terms: string[]): TermIndex {
  const singles = new Set<string>();
  const multi: string[] = [];
  const glued = new Set<string>();
  for (const t of terms) {
    const term = String(t).toLowerCase();
    if (term.includes(" ")) multi.push(term);
    else singles.add(term);
    const lettersOnly = term.replace(/[^a-z]/g, "");
    if (lettersOnly.length >= 4) glued.add(lettersOnly);
  }
  return { singles, multi, glued };
}

const M_IDX = indexTerms(DATA.m);
const S_IDX = indexTerms(DATA.s);

// --- normalization ---------------------------------------------------------
const LEET_MAP: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g",
  "@": "a", "$": "s", "!": "i", "|": "l",
};

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Base form keeps digits (needed for age detection) and is lowercased/deaccented.
function toBase(rawStr: string): string {
  let s = String(rawStr).toLowerCase();
  s = s.normalize("NFKC");
  s = stripDiacritics(s);
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, ""); // zero-width
  return s;
}

type Forms = { base: string; tokens: string[]; tokenSet: Set<string>; spaced: string; glued: string; ageForm: string };

// Matching form: leet folded to letters, separators -> space, repeats collapsed.
function toMatchForms(base: string): Omit<Forms, "base"> {
  let s = base.replace(/[0-9@$!|]/g, (c) => LEET_MAP[c] ?? " ");
  s = s.replace(/[^a-z\s]/g, " "); // drop remaining punctuation
  s = s.replace(/(.)\1{2,}/g, "$1"); // chiiild -> child
  s = s.replace(/\s+/g, " ").trim();
  const tokens = s.length ? s.split(" ") : [];
  const tokenSet = new Set(tokens);
  const spaced = " " + tokens.join(" ") + " ";
  const glued = tokens.join("");
  // Age form: keep digits AND letters, collapse every other separator (incl.
  // hyphens) to a single space. This is what fixes "17-year-old" slipping past
  // age detection: the raw base kept the hyphens and broke the \s* match.
  const ageForm = base.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return { tokens, tokenSet, spaced, glued, ageForm };
}

function normalize(rawStr: string): Forms {
  const base = toBase(rawStr);
  return { base, ...toMatchForms(base) };
}

// --- detectors -------------------------------------------------------------
function matchesIndex(idx: TermIndex, forms: Forms): boolean {
  for (const t of forms.tokenSet) if (idx.singles.has(t)) return true;
  for (const phrase of idx.multi) if (forms.spaced.includes(" " + phrase + " ")) return true;
  for (const g of idx.glued) if (forms.glued.includes(g)) return true;
  return false;
}

// Age detection runs on the AGE FORM (hyphens/punctuation collapsed to spaces),
// so "17-year-old", "17 year old", "17yo", and "aged 7" are all caught.
function hasMinorAge(ageForm: string): boolean {
  const max = DATA.minorAgeMax;
  const numRe = /\b(\d{1,2})\s*(?:yo\b|y\/?o\b|yrs?\b|years?\b)/g;
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(ageForm))) {
    const n = Number(m[1]);
    if (n >= 0 && n <= max) return true;
  }
  const agedRe = /\bage[d]?\s*(?:of\s*)?(\d{1,2})\b/g;
  while ((m = agedRe.exec(ageForm))) {
    const n = Number(m[1]);
    if (n >= 0 && n <= max) return true;
  }
  const words = Object.keys(DATA.numberWords);
  if (words.length) {
    const spelledRe = new RegExp(
      "\\b(" + words.join("|") + ")\\s*(?:yo\\b|y/?o\\b|yrs?\\b|years?\\b|year\\s*old)",
      "g"
    );
    while ((m = spelledRe.exec(ageForm))) {
      const n = DATA.numberWords[m[1]];
      if (typeof n === "number" && n <= max) return true;
    }
  }
  return false;
}

export type SafetyVerdict = {
  action: "allow" | "refuse";
  layer: number;
  reason: string;
  message?: string;
};

const REFUSAL_MESSAGE =
  "This request was blocked. Vek-Snap does not generate sexual content involving minors. This protection cannot be disabled.";

// --- public API ------------------------------------------------------------
export function evaluatePrompt(rawStr: string): SafetyVerdict {
  const forms = normalize(rawStr);
  const hasMinor = matchesIndex(M_IDX, forms) || hasMinorAge(forms.ageForm);
  const hasSexual = matchesIndex(S_IDX, forms);
  if (hasMinor && hasSexual) {
    return { action: "refuse", layer: 2, reason: "minor_x_sexual", message: REFUSAL_MESSAGE };
  }
  return { action: "allow", layer: 2, reason: "clear" };
}

// Only scan "prose-like" strings (actual prompt text), not single-token
// identifiers such as model/LoRA/checkpoint filenames, sampler names, or file
// paths. This avoids false positives (e.g. a filename containing "analog"
// substring-matching a sexual term) while still catching every real prompt,
// which is always a multi-word phrase.
const FILE_LIKE = /\.(safetensors|ckpt|pt|pth|gguf|onnx|bin|vae|yaml|yml|json|png|jpe?g|webp|gif|mp4|webm|wav|mp3|flac|txt)\b/i;
function looksLikeProse(s: string): boolean {
  if (!/\s/.test(s)) return false; // single token => filename/model/sampler id
  if (FILE_LIKE.test(s)) return false; // a path or asset reference
  return true;
}

// Recursively collect prose strings from a ComfyUI workflow graph (node inputs,
// nested arrays/objects). We evaluate each field AND the COMBINED text so a
// minor cue in one field and a sexual cue in another (e.g. positive vs. negative
// prompt, or split across nodes) are still caught.
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (looksLikeProse(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

// Evaluate an entire ComfyUI workflow (the object POSTed to /prompt as `prompt`).
export function evaluateWorkflow(workflow: unknown): SafetyVerdict {
  const strings: string[] = [];
  collectStrings(workflow, strings);
  // Per-field check first (cheap, precise)…
  for (const s of strings) {
    const v = evaluatePrompt(s);
    if (v.action === "refuse") return v;
  }
  // …then a combined check to catch cues split across fields/nodes.
  const combined = strings.join(" \n ");
  return evaluatePrompt(combined);
}

// Recursively collect EVERY string (no prose filter). Use this for structured
// text inputs to the LLM routes, where the caller passes ONLY user-authored
// content fields (prompt/scene/notes/character descriptions, etc.), never model
// paths or config, so filename false-positives aren't a concern and we want to
// catch short tokens too (e.g. a synthetic "aged 12" derived from a numeric age).
function collectAllStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectAllStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectAllStrings(v, out);
  }
}

// Evaluate an arbitrary bag of user-authored text (object/array/string). Refuses
// if any single field OR the combined text trips the minor×sexual rule. Callers
// MUST pass only user content (not model paths/config), see collectAllStrings.
export function evaluateContent(value: unknown): SafetyVerdict {
  const strings: string[] = [];
  collectAllStrings(value, strings);
  for (const s of strings) {
    const v = evaluatePrompt(s);
    if (v.action === "refuse") return v;
  }
  return evaluatePrompt(strings.join(" \n "));
}

export function assertSafeOrThrow(rawStr: string): true {
  const v = evaluatePrompt(rawStr);
  if (v.action === "refuse") {
    const err = new Error(v.message ?? REFUSAL_MESSAGE) as Error & { code?: string; verdict?: SafetyVerdict };
    err.code = "VEKSNAP_SAFETY_REFUSAL";
    err.verdict = v;
    throw err;
  }
  return true;
}

export const SAFETY_REFUSAL_MESSAGE = REFUSAL_MESSAGE;
