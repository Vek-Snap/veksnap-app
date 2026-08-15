/**
 * Prompt Architect: Style presets, negative prompts, character seeds, and content detection
 * Ported from LoRA-Daddy's LTX2EasyPromptQwen ComfyUI node to TypeScript.
 * Pure logic: no LLM required. All functions are deterministic given a seed.
 */

// ─── Style Preset Definition ──────────────────────────────────────────────────

export interface StylePreset {
  label: string;
  description: string;            // full system-level style instruction
  isPortrait: boolean;            // forces 9:16 vertical framing
  fps: number;                    // recommended FPS for this style
  negativeExtra: string;          // style-specific negative prompt additions
  cameraAngle: string | null;     // default shot angle (null = LLM/user decides)
  cameraMovement: string | null;  // default camera movement
  styleLabel: string;             // short label for prompt prefix
}

// ─── Negative Prompt Fragments ────────────────────────────────────────────────

const NEG_BASE =
  "watermark, text, signature, duplicate, " +
  "static, no motion, frozen, " +
  "poorly drawn, bad anatomy, deformed, disfigured, " +
  "extra limbs, missing limbs, floating limbs, disconnected body parts, " +
  "micro jitter, flickering, strobing, aliasing, high frequency patterns, " +
  "motion artifacts, temporal inconsistency, frame stuttering";

const NEG_PORTRAIT_SHOT = "wide angle distortion, fish eye, full body shot";
const NEG_WIDE          = "close-up, portrait crop, tight frame";
const NEG_MULTI         = "merged bodies, fused figures, incorrect number of people";
const NEG_PORTRAIT_ORI  = "landscape orientation, letterbox, pillarbox, horizontal crop, widescreen framing";
const NEG_VHS           = "clean digital, sharp edges, 4K, high resolution, pristine quality";
const NEG_HORROR        = "bright happy lighting, warm tones, cheerful atmosphere, soft light";
const NEG_FASHION       = "casual handheld, amateur footage, flat lighting, unposed";
const NEG_SELFIE        = "tripod, gimbal stabilised, smooth camera movement, rack focus, dolly, crane, cinematic bokeh, dramatic depth of field, professional lighting, film grain, colour grade, cinematic lens, landscape orientation";
const NEG_ANIME         = "photorealistic, live action, real person, CGI, 3D render, western cartoon, flat shading";
const NEG_2DCARTOON     = "photorealistic, 3D render, CGI, anime, live action, flat digital art, no line work";
const NEG_3DCGI         = "photorealistic, live action, 2D flat, hand-drawn, sketch, anime, watercolour";
const NEG_STOPMOTION    = "smooth motion, CGI, photorealistic, digital, fluid movement, motion blur";
const NEG_COMICBOOK     = "photorealistic, soft gradients, 3D render, painterly, no line art, anime";
const NEG_CELSHADED     = "photorealistic, soft shading, gradients, painterly, hand-drawn lines, anime";
const NEG_ROTOSCOPE     = "fully animated, cartoon, CGI, no live action base, unnatural movement";
const NEG_CYBERPUNK     = "natural lighting, pastoral, warm tones, daylight, photorealistic skin, muted colour";
const NEG_SCIFI         = "medieval, fantasy, nature, pastoral, historical, period costume, warm earthy tones";

// ─── Style Presets ────────────────────────────────────────────────────────────

export const STYLE_PRESETS: Record<string, StylePreset> = {
  "none": {
    label: "None (no style override)",
    description: "",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: null,
    cameraMovement: null,
    styleLabel: "",
  },
  "cinematic_drama": {
    label: "Cinematic (Drama)",
    description: "Cinematic drama. Intimate, character-driven. Shallow depth of field: subject sharp, world behind them soft. Colour grade: cool shadows, warm skin tones, restrained palette. Camera: medium close-ups and close-ups dominate. Moves are slow and purposeful. Kodak 2383 print emulation. Sound: intimate and close.",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: "OTS (over the shoulder)",
    cameraMovement: "Slow push in",
    styleLabel: "Cinematic drama, shallow depth of field, Kodak 2383.",
  },
  "cinematic_epic": {
    label: "Cinematic (Epic)",
    description: "Epic cinematic. Scale and environment are the protagonist. Wide establishing shots and vast compositions. Camera: sweeping crane moves, slow orbital shots, long tracking shots. Colour grade: rich, contrasty. Kodak 5219 for natural daylight, ARRI Alexa for clean digital grandeur. Sound: environmental and large.",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Pull back (reveal)",
    styleLabel: "Cinematic epic, vast wide-angle compositions.",
  },
  "cinematic_closeup": {
    label: "Cinematic (Intimate close-up)",
    description: "Intimate close-up cinema. The entire world is a face, a hand, a detail. Razor-thin depth of field. Framing: extreme close-ups and close-ups only. Camera: barely moves, micro drifts. Colour grade: skin-tone faithful, warm and close. Sound: amplified intimacy, breath, fabric against skin.",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Slow push in",
    styleLabel: "Intimate close-up cinema, razor-thin depth of field.",
  },
  "thriller": {
    label: "Slow-burn thriller",
    description: "Slow-burn psychological thriller. Tight framing, long held shots, shallow depth of field. Colour palette: desaturated teal and amber. Sound design is sparse: silence punctuated by single sounds. Camera moves deliberately and slowly.",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: "High angle (vulnerable)",
    cameraMovement: "Static (locked off)",
    styleLabel: "Slow-burn psychological thriller.",
  },
  "documentary": {
    label: "Handheld documentary",
    description: "Handheld documentary. Camera moves with the subject, never static. Slight shake on movement. Natural available light only. Colour grade: flat, slightly washed. Intimate and observational.",
    isPortrait: false,
    fps: 30,
    negativeExtra: "",
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Handheld (natural shake)",
    styleLabel: "Handheld documentary footage.",
  },
  "fashion": {
    label: "High fashion editorial",
    description: "High fashion editorial. Striking, composed frames. Hard directional lighting with deep shadows. Colour palette: high contrast, often monochrome or single accent colour. Movement is deliberate and posed.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_FASHION,
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Static (locked off)",
    styleLabel: "High fashion editorial video.",
  },
  "noir": {
    label: "Noir (deep shadows, venetian light)",
    description: "Classic noir. Low-key lighting, venetian blind shadow patterns across faces and walls. Black and white or heavily desaturated with single colour accent. Camera angles: low, Dutch tilt, shot through objects.",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Slow push in",
    styleLabel: "Classic noir, black and white, venetian blind shadows.",
  },
  "golden_hour": {
    label: "Golden hour drama",
    description: "Golden hour drama. Warm amber and orange light from a low sun. Heavy lens flare. Soft shadows, glowing skin tones. Wide establishing shots and medium shots. Emotional, sweeping camera movement.",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Slow push in",
    styleLabel: "Golden hour cinematic drama.",
  },
  "horror": {
    label: "Horror (desaturated, harsh contrast)",
    description: "Horror. Heavily desaturated colour, crushed blacks. Harsh top-down or under-lighting. Camera movements are slow and uneasy. Framing leaves negative space: empty doorways, dark corners.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_HORROR,
    cameraAngle: "High angle (vulnerable)",
    cameraMovement: "Static (locked off)",
    styleLabel: "Horror film, desaturated, harsh contrast.",
  },
  "action": {
    label: "Action blockbuster",
    description: "Action blockbuster. Fast kinetic energy. Dutch angles, crash zooms, whip pans. Colour grade: teal and orange, high contrast. Camera is never still. Slow motion inserts on key moments.",
    isPortrait: false,
    fps: 30,
    negativeExtra: "",
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Tracking (follows subject)",
    styleLabel: "Action blockbuster, teal and orange grade.",
  },
  "sports": {
    label: "Sports documentary",
    description: "Sports documentary. Tracking shots following the athlete. Telephoto compression. Slow motion bursts at peak moments. Natural sound: crowd noise, impact, breathing. Camera is athletic.",
    isPortrait: false,
    fps: 30,
    negativeExtra: "",
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Tracking (follows subject)",
    styleLabel: "Sports documentary footage.",
  },
  "music_video": {
    label: "Music video (stylised)",
    description: "Music video. Rhythm-cut visual language: movement is driven by the beat. High contrast colour grade with stylised palette. Mix of tight close-ups and dramatic wide shots. Camera movement is expressive.",
    isPortrait: false,
    fps: 30,
    negativeExtra: "",
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Orbit (360 around subject)",
    styleLabel: "Stylised music video.",
  },
  "vhs": {
    label: "Lo-fi home video (VHS)",
    description: "Lo-fi home video. VHS tape aesthetic: slightly washed colour, faint scan lines, soft edges. Colour grade: faded, slightly green-shifted. Camera is handheld and casual.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_VHS,
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Handheld (natural shake)",
    styleLabel: "Lo-fi VHS home video footage.",
  },
  "hyperreal": {
    label: "Hyper-real 4K (clinical sharpness)",
    description: "Hyper-real 4K. Clinical sharpness: every texture, pore, and fibre rendered in full detail. Even lighting, no blown highlights, no crushed blacks. Camera movement is minimal and precise.",
    isPortrait: false,
    fps: 30,
    negativeExtra: "",
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Slow push in",
    styleLabel: "Hyper-real 4K, clinical sharpness.",
  },
  "dreamy": {
    label: "Dreamy (soft focus, slow motion)",
    description: "Dreamy aesthetic. Soft focus edges with sharp centre. Pastel colour bleed. Movement is slow: the frame breathes rather than cuts. Shallow depth of field with heavy bokeh.",
    isPortrait: false,
    fps: 24,
    negativeExtra: "",
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Slow push in",
    styleLabel: "Dreamy soft focus, slow motion.",
  },
  "gritty": {
    label: "Gritty realism (flat, natural light)",
    description: "Gritty realism. Flat colour grade, no cinematic enhancement. Natural light only. Camera is direct and unsentimental. No stylisation. The scene is shot as if it is actually happening.",
    isPortrait: false,
    fps: 30,
    negativeExtra: "",
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Handheld (natural shake)",
    styleLabel: "Gritty realism, flat natural light.",
  },
  "pov": {
    label: "POV (first person, immersive)",
    description: "First-person POV. The camera IS the viewer's eyes. Frame moves as a head would: natural breathing movement, slight tilt on turns. Everything is seen, not watched.",
    isPortrait: false,
    fps: 30,
    negativeExtra: "",
    cameraAngle: "POV (first person)",
    cameraMovement: null,
    styleLabel: "First-person POV footage.",
  },
  "portrait_mobile": {
    label: "Portrait vertical (9:16 mobile)",
    description: "Native portrait video, 9:16 aspect ratio. Optimised for mobile. Frame is vertical throughout. Tight head-to-torso framing. Action moves vertically in frame.",
    isPortrait: true,
    fps: 30,
    negativeExtra: NEG_PORTRAIT_ORI,
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Slow push in",
    styleLabel: "Vertical 9:16 mobile video.",
  },
  "selfie": {
    label: "Selfie (self-shot, arm's length)",
    description: "Self-shot selfie video. Camera at arm's length, facing back at subject. 9:16 vertical. Tight head-and-shoulders. Camera moves with the subject's arm. Natural available light.",
    isPortrait: true,
    fps: 30,
    negativeExtra: NEG_SELFIE,
    cameraAngle: "High angle (vulnerable)",
    cameraMovement: "Handheld (natural shake)",
    styleLabel: "Selfie video, self-shot at arm's length, vertical 9:16.",
  },
  "anime": {
    label: "Anime (Japanese animation)",
    description: "Japanese anime. Hand-drawn animation aesthetic: clean ink outlines, flat colour fills with subtle cel shading. Large expressive eyes. Vivid, high saturation. Dynamic angles, speed lines on action.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_ANIME,
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Tracking (follows subject)",
    styleLabel: "Japanese anime animation, hand-drawn cel style.",
  },
  "cartoon_2d": {
    label: "2D cartoon (hand-drawn)",
    description: "Classic hand-drawn 2D cartoon. Expressive ink outlines with variable line weight. Flat colour fills, minimal shading, bold colour palette. Squash-and-stretch movement. Snappy timing.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_2DCARTOON,
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Static (locked off)",
    styleLabel: "2D hand-drawn cartoon animation.",
  },
  "cgi_3d": {
    label: "3D CGI (Pixar/DreamWorks)",
    description: "High-end 3D CGI animation in the style of Pixar or DreamWorks. Subsurface scattering on skin. Highly detailed surface textures. Expressive faces. Warm, soft three-point lighting. Smooth cinematic camera moves.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_3DCGI,
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Orbit (360 around subject)",
    styleLabel: "3D CGI animation, Pixar style.",
  },
  "stop_motion": {
    label: "Stop motion (claymation)",
    description: "Stop motion claymation. Physical clay or puppet aesthetic: visible fingerprints and tool marks. Slightly jerky movement at 12fps. Matte, tactile textures. Miniature sets with real shadows.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_STOPMOTION,
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Static (locked off)",
    styleLabel: "Stop motion claymation animation.",
  },
  "comic_book": {
    label: "Comic book / graphic novel",
    description: "Comic book or graphic novel. Bold ink outlines, halftone dot patterns. Flat colour with hard-edged shadows. Dynamic Dutch angles, strong perspective distortion on action. Speed lines on impact.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_COMICBOOK,
    cameraAngle: "Dutch angle (tilted, unsettling)",
    cameraMovement: "Static (locked off)",
    styleLabel: "Comic book graphic novel style.",
  },
  "cel_shaded": {
    label: "Cel-shaded (flat colour 3D)",
    description: "Cel-shaded 3D. Three-dimensional geometry rendered with flat, stepped colour fills. Hard shadow threshold. Ink outlines on all silhouettes. The image reads as animated despite being 3D.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_CELSHADED,
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Orbit (360 around subject)",
    styleLabel: "Cel-shaded 3D animation, flat colour fills.",
  },
  "rotoscope": {
    label: "Rotoscope (animated over live action)",
    description: "Rotoscoped animation. Movement traced from live action: uncanny physical accuracy within a hand-drawn surface. Outlines are slightly wobbly, varying in weight. Colour is painted in loose washes.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_ROTOSCOPE,
    cameraAngle: "Eye-level (neutral, natural)",
    cameraMovement: "Tracking (follows subject)",
    styleLabel: "Rotoscoped animation over live action.",
  },
  "cyberpunk": {
    label: "Cyberpunk neon illustrated",
    description: "Cyberpunk illustrated. Neon-lit urban environment: magenta, cyan, electric blue. Hard rim lighting from neon signs. Rain-slick surfaces reflect light. Graphic novel meets blade runner.",
    isPortrait: false,
    fps: 30,
    negativeExtra: NEG_CYBERPUNK,
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Tracking (follows subject)",
    styleLabel: "Cyberpunk neon illustrated, magenta and cyan.",
  },
  "scifi": {
    label: "Sci-fi (cinematic, practical)",
    description: "Cinematic science fiction. Clean, practical-feeling environments: metal corridors, reinforced glass, industrial lighting. Colour palette: cool blue-white with accent LEDs. Sound is mechanical.",
    isPortrait: false,
    fps: 24,
    negativeExtra: NEG_SCIFI,
    cameraAngle: "Low angle (powerful, imposing)",
    cameraMovement: "Slow push in",
    styleLabel: "Cinematic science fiction, practical sets.",
  },
};

// Export as ordered array for UI dropdowns
export const STYLE_PRESET_OPTIONS = Object.entries(STYLE_PRESETS).map(([key, preset]) => ({
  key,
  label: preset.label,
}));

// ─── Shot-framing Detection (neutral) ─────────────────────────────────────────
// Used only to resolve framing/multi-person conflicts in the auto negative prompt.

const MULTI_RE = /\b(two\s+(women|men|people|girls|guys)|both\s+(of\s+them|women|men)|couple|trio)\b/i;
const CLOSEUP_RE = /\b(close-up|close up|face shot|headshot)\b/i;
const WIDE_RE = /\b(wide shot|wide angle|aerial|bird's-eye|establishing)\b/i;

// ─── Auto Negative Prompt Builder ─────────────────────────────────────────────

export function buildNegativePrompt(
  prompt: string,
  styleKey: string = "none",
): string {
  const preset = STYLE_PRESETS[styleKey];
  const combined = (prompt + " " + (preset?.description || "") + " " + (preset?.styleLabel || "")).toLowerCase();
  const extras: string[] = [];

  // Shot framing conflicts
  if (CLOSEUP_RE.test(combined)) extras.push(NEG_PORTRAIT_SHOT);
  else if (WIDE_RE.test(combined)) extras.push(NEG_WIDE);

  // Multi-person
  if (MULTI_RE.test(combined)) extras.push(NEG_MULTI);

  // Portrait orientation
  if (preset?.isPortrait) extras.push(NEG_PORTRAIT_ORI);

  // Style-specific negatives (already on preset)
  if (preset?.negativeExtra) extras.push(preset.negativeExtra);

  const parts = [NEG_BASE, ...extras].filter(Boolean);
  return parts.join(", ");
}

// ─── Character Seed Pools ─────────────────────────────────────────────────────

type Gender = "female" | "male";

interface EthnicityEntry {
  ethnicity: string;
  skinTone: string;
}

const ETHNICITIES_FEMALE: EthnicityEntry[] = [
  { ethnicity: "White", skinTone: "pale freckled skin with pink undertones" },
  { ethnicity: "White", skinTone: "fair skin with cool undertones" },
  { ethnicity: "White", skinTone: "light skin with warm peachy tones" },
  { ethnicity: "White", skinTone: "porcelain skin with visible blue veins at the temples" },
  { ethnicity: "White", skinTone: "fair skin with a light golden summer tan" },
  { ethnicity: "White", skinTone: "light skin with a soft rosy flush across the cheeks" },
  { ethnicity: "White", skinTone: "pale skin with cool blue-pink undertones" },
  { ethnicity: "White", skinTone: "creamy fair skin with warm neutral undertones" },
  { ethnicity: "White", skinTone: "light skin, slightly olive-toned from sun exposure" },
  { ethnicity: "White", skinTone: "fair freckled skin with warm amber undertones" },
  { ethnicity: "White", skinTone: "light skin with warm honey undertones" },
  { ethnicity: "White", skinTone: "fair skin, slightly flushed at the cheeks" },
  { ethnicity: "Japanese", skinTone: "pale skin with cool beige undertones" },
  { ethnicity: "Korean", skinTone: "fair skin with a soft peachy-pink flush" },
  { ethnicity: "Chinese", skinTone: "light golden-toned skin" },
  { ethnicity: "East Asian", skinTone: "fair cool-toned skin with a subtle pink undertone" },
  { ethnicity: "East Asian", skinTone: "light ivory skin with warm golden undertones" },
  { ethnicity: "Japanese", skinTone: "very fair skin, almost translucent in soft light" },
  { ethnicity: "Korean", skinTone: "smooth fair skin with a cool porcelain tone" },
  { ethnicity: "Chinese", skinTone: "warm ivory skin with golden undertones" },
  { ethnicity: "East Asian", skinTone: "pale skin with a subtle warm peach cast" },
  { ethnicity: "East Asian", skinTone: "light skin with cool neutral undertones and a natural glow" },
  { ethnicity: "Black", skinTone: "deep ebony skin with cool blue-black undertones" },
  { ethnicity: "Black", skinTone: "medium warm brown skin with golden undertones" },
];

const ETHNICITIES_MALE: EthnicityEntry[] = [
  { ethnicity: "White", skinTone: "fair skin with cool undertones" },
  { ethnicity: "White", skinTone: "light skin with warm peachy tones" },
  { ethnicity: "White", skinTone: "fair skin with a light golden summer tan" },
  { ethnicity: "White", skinTone: "light skin, slightly olive-toned from sun exposure" },
  { ethnicity: "White", skinTone: "fair freckled skin with warm amber undertones" },
  { ethnicity: "White", skinTone: "light skin with warm honey undertones" },
  { ethnicity: "White", skinTone: "creamy fair skin with warm neutral undertones" },
  { ethnicity: "White", skinTone: "pale skin with cool blue-pink undertones" },
  { ethnicity: "White", skinTone: "fair skin, slightly flushed at the cheeks" },
  { ethnicity: "White", skinTone: "pale freckled skin with pink undertones" },
  { ethnicity: "Japanese", skinTone: "pale skin with cool beige undertones" },
  { ethnicity: "Korean", skinTone: "fair skin with a soft peachy-pink flush" },
  { ethnicity: "East Asian", skinTone: "light golden-toned skin with warm undertones" },
  { ethnicity: "East Asian", skinTone: "light skin with cool neutral undertones" },
  { ethnicity: "Black", skinTone: "medium warm brown skin with golden undertones" },
];

const HAIR_EAST_ASIAN = ["jet black", "jet black", "jet black", "dark brown", "dark brown", "blue-black", "natural dark brown with caramel highlights", "dyed burgundy", "dyed bleach blonde with dark roots"];
const HAIR_WHITE = ["dark brown", "dark brown", "warm medium brown", "warm medium brown", "warm chestnut brown", "honey blonde", "honey blonde", "ash blonde", "strawberry blonde", "auburn", "copper red", "platinum blonde", "natural dark brown with caramel highlights"];
const HAIR_DARK = ["jet black", "jet black", "jet black", "dark brown", "dark brown", "warm medium brown", "blue-black", "natural dark brown with caramel highlights", "warm chestnut brown"];

const STYLES_STRAIGHT = [
  "pin-straight, very long, falling to the waist", "pin-straight, blunt cut to the shoulder",
  "sleek straight hair, cut to the chin", "straight with a heavy blunt fringe",
  "loose beach waves, mid-back length", "tousled waves, shoulder-length",
  "soft waves with a side part, collarbone length", "chin-length bob, blunt",
  "asymmetric bob, longer on one side", "high ponytail, sleek",
  "messy bun with loose strands framing the face", "half-up half-down, loosely pinned",
  "low bun, tight and smooth", "very long straight hair, centre-parted",
  "long layered hair with curtain bangs", "long thick hair in a loose braid over one shoulder",
  "cropped pixie cut, textured", "short sleek crop, close to the head",
];
const STYLES_TEXTURED = [
  "tight 4C coils, natural and full", "thick natural afro, rounded",
  "big loose natural curls, voluminous", "long box braids falling past the shoulders",
  "short box braids, chin-length", "thick cornrows flat to the scalp",
  "two-strand twists, loose and mid-length", "high bun of twisted locs",
  "long faux locs, loose", "defined 3C ringlets, shoulder-length",
  "cropped natural coils, close to the head", "sleek pressed hair, shoulder-length",
];
const STYLES_MALE = [
  "short cropped cut, neat", "short textured cut with a natural part",
  "buzz cut, close to the scalp", "faded sides with longer hair on top",
  "slicked back, medium length", "messy textured crop",
  "short curls, close-cropped", "tight natural curls, short",
  "short afro, rounded", "mid-length waves, loosely swept back",
  "shoulder-length straight hair, centre-parted", "shaved head",
  "close-cropped with a defined hairline", "undercut with longer hair swept to one side",
];

const BODY_FEMALE_EAST_ASIAN = [
  "petite and slender, small-framed", "slim with a flat stomach and narrow hips",
  "thin with delicate bone structure", "lean and tall with long limbs",
  "athletic build with defined shoulders", "lean and athletic with visible muscle definition",
  "full hourglass figure with wide hips and a defined waist",
];
const BODY_FEMALE_WHITE = [
  "slender build with narrow shoulders", "lean and tall with long limbs",
  "slim with a flat stomach and narrow hips", "athletic build with defined shoulders",
  "lean and athletic with visible muscle definition", "strong legs and a narrow waist",
  "full hourglass figure with wide hips and a defined waist",
  "curvy with a round bust and full hips", "tall and willowy with long legs",
];
const BODY_FEMALE_BLACK = [
  "full hourglass figure with wide hips and a defined waist",
  "curvy with a round bust and full hips", "athletic build with defined shoulders",
  "lean and athletic with visible muscle definition", "strong legs and a narrow waist",
  "tall and willowy with long legs",
];
const BODY_MALE = [
  "lean and wiry with narrow shoulders", "tall and slim with long limbs",
  "slim with a flat stomach, average build", "compact and lightly muscled",
  "athletic build with broad shoulders and a tapered waist",
  "muscular and powerfully built, broad chest",
  "lean and athletic with visible muscle definition",
  "tall with a rangy, angular frame",
  "well-built with a defined chest and flat stomach",
];

const AGES = ["18", "19", "19", "19", "20", "20", "20", "21", "21"];

// Seeded PRNG (simple mulberry32)
function seededRng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

export interface CharacterSeed {
  description: string;
  gender: Gender;
  ethnicity: string;
  age: string;
}

export function generateCharacterSeed(
  seed: number,
  gender: Gender = "female",
): CharacterSeed {
  const rng = seededRng(seed);
  const age = pick(AGES, rng);
  const ethPool = gender === "male" ? ETHNICITIES_MALE : ETHNICITIES_FEMALE;
  const { ethnicity, skinTone } = pick(ethPool, rng);

  // Hair colour
  const isEastAsian = ["Japanese", "Korean", "Chinese", "East Asian"].includes(ethnicity);
  const hairColour = isEastAsian ? pick(HAIR_EAST_ASIAN, rng) :
    ethnicity === "White" ? pick(HAIR_WHITE, rng) : pick(HAIR_DARK, rng);

  // Hair style
  let hairStyle: string;
  if (gender === "male") {
    hairStyle = pick(STYLES_MALE, rng);
  } else if (ethnicity === "Black") {
    hairStyle = pick(STYLES_TEXTURED, rng);
  } else {
    hairStyle = pick(STYLES_STRAIGHT, rng);
  }

  // Body type
  let bodyType: string;
  if (gender === "male") {
    bodyType = pick(BODY_MALE, rng);
  } else if (isEastAsian) {
    bodyType = pick(BODY_FEMALE_EAST_ASIAN, rng);
  } else if (ethnicity === "Black") {
    bodyType = pick(BODY_FEMALE_BLACK, rng);
  } else {
    bodyType = pick(BODY_FEMALE_WHITE, rng);
  }

  const genderWord = gender === "male" ? "man" : "woman";
  const hairPhrase = gender === "male"
    ? `${hairColour} hair, ${hairStyle}`
    : `${hairColour} hair in a ${hairStyle}`;

  const description =
    `a ${age}-year-old ${ethnicity} ${genderWord}, ` +
    `${hairPhrase}, ${skinTone}, ${bodyType}`;

  return { description, gender, ethnicity, age };
}

// ─── Prompt Enhancement Utilities ─────────────────────────────────────────────

/** Prepend style label to prompt if a style is selected */
export function applyStylePrefix(prompt: string, styleKey: string): string {
  const preset = STYLE_PRESETS[styleKey];
  if (!preset || !preset.styleLabel) return prompt;
  return `${preset.styleLabel} ${prompt}`;
}

/** Get suggested FPS for a style preset */
export function getPresetFps(styleKey: string): number {
  return STYLE_PRESETS[styleKey]?.fps ?? 24;
}

/** Get default camera settings for a style preset */
export function getPresetCamera(styleKey: string): { angle: string | null; movement: string | null } {
  const p = STYLE_PRESETS[styleKey];
  return { angle: p?.cameraAngle ?? null, movement: p?.cameraMovement ?? null };
}
