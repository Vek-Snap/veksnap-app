// Timeline transitions: a small, framework-agnostic registry describing the
// basic transitions the editor can apply to a clip. These map onto mechanisms
// the preview + ffmpeg export ALREADY support (cross-dissolve overlap and
// fade-in/out ramps to/from black), so no new render code is required.
//
// Kept deliberately minimal (an industry-standard "most basic" set); more can be added
// here + wired to store mutations without touching the editor UI.

export type TransitionType = "cross-dissolve" | "fade-in" | "fade-out";

export interface TransitionDef {
  type: TransitionType;
  label: string;
  /** One-line description shown under the button in the add-menu. */
  summary: string;
  /** Whether it needs a previous abutting clip on the same track. */
  needsPrevClip: boolean;
}

export const TRANSITIONS: TransitionDef[] = [
  {
    type: "cross-dissolve",
    label: "Cross Dissolve",
    summary: "Blend this clip out of the previous one (overlap dissolve).",
    needsPrevClip: true,
  },
  {
    type: "fade-in",
    label: "Fade In (from black)",
    summary: "Ramp up from black at the clip's head.",
    needsPrevClip: false,
  },
  {
    type: "fade-out",
    label: "Fade Out (to black)",
    summary: "Ramp down to black at the clip's tail.",
    needsPrevClip: false,
  },
];

export const TRANSITION_MAP: Record<TransitionType, TransitionDef> = Object.fromEntries(
  TRANSITIONS.map((t) => [t.type, t]),
) as Record<TransitionType, TransitionDef>;
