"use client";

import { useState } from "react";
import { Camera, Copy, Check, ChevronDown, ChevronRight, Move, RotateCcw, Maximize2 } from "lucide-react";

interface ShotEntry {
  label: string;
  abbr?: string;
  description: string;
  promptText: string;
}

interface CategoryDef {
  label: string;
  icon: React.ReactNode;
  entries: ShotEntry[];
}

const SHOT_SIZES: ShotEntry[] = [
  { label: "Extreme Close-Up", abbr: "ECU", description: "Eyes, mouth, or a single detail fills the frame", promptText: "extreme close-up shot, tight framing on face details" },
  { label: "Close-Up", abbr: "CU", description: "Face fills the frame, shoulders barely visible", promptText: "close-up shot, face filling the frame" },
  { label: "Medium Close-Up", abbr: "MCU", description: "Head and chest visible, common for dialogue", promptText: "medium close-up, head to chest framing" },
  { label: "Medium Shot", abbr: "MS", description: "Waist up: the classic 'cowboy shot'", promptText: "medium shot, waist-up framing, natural composition" },
  { label: "Medium Full Shot", abbr: "MFS", description: "Knees up, shows body language clearly", promptText: "medium full shot, knees-up framing" },
  { label: "Full Shot", abbr: "FS", description: "Entire body visible with small headroom/footroom", promptText: "full shot, entire body visible head to toe, slight headroom" },
  { label: "Wide Shot", abbr: "WS", description: "Subject is small in frame, environment dominates", promptText: "wide shot, subject small in frame, environment visible" },
  { label: "Extreme Wide Shot", abbr: "EWS", description: "Vast landscape, subject barely visible or absent", promptText: "extreme wide shot, vast landscape, epic scale" },
];

const CAMERA_ANGLES: ShotEntry[] = [
  { label: "Eye Level", description: "Camera at subject's eye height: neutral, natural", promptText: "eye-level camera angle, neutral perspective" },
  { label: "Low Angle", description: "Camera looks up at subject: makes them powerful/imposing", promptText: "low angle shot, camera looking up at subject" },
  { label: "High Angle", description: "Camera looks down at subject: diminishing, vulnerable", promptText: "high angle shot, camera looking down at subject" },
  { label: "Bird's Eye", description: "Directly overhead, looking straight down", promptText: "bird's eye view, top-down overhead perspective" },
  { label: "Worm's Eye", description: "Extremely low, looking almost straight up", promptText: "worm's eye view, extreme low angle looking up" },
  { label: "Dutch Angle", description: "Camera tilted sideways: disorientation, tension, unease", promptText: "dutch angle, tilted camera, off-kilter framing" },
  { label: "Over the Shoulder", description: "Behind one person looking at another: conversation framing", promptText: "over-the-shoulder shot, looking past one figure at another" },
  { label: "POV / First Person", description: "Camera IS the subject's eyes", promptText: "POV first-person perspective, seeing through character's eyes" },
];

const CAMERA_MOVEMENTS: ShotEntry[] = [
  { label: "Static / Locked Off", description: "Camera doesn't move: stable, documentary feel", promptText: "static camera, locked off, no camera movement" },
  { label: "Pan Left", description: "Camera rotates horizontally to the left on a fixed point", promptText: "camera slowly pans left, smooth horizontal rotation" },
  { label: "Pan Right", description: "Camera rotates horizontally to the right on a fixed point", promptText: "camera slowly pans right, smooth horizontal rotation" },
  { label: "Tilt Up", description: "Camera tilts upward from a fixed position: reveals height", promptText: "camera tilts up, revealing upward, smooth vertical rotation" },
  { label: "Tilt Down", description: "Camera tilts downward from a fixed position", promptText: "camera tilts down, smooth downward vertical rotation" },
  { label: "Dolly In / Push In", description: "Camera physically moves toward subject: builds intensity", promptText: "camera dolly in, slowly pushing toward subject, increasing intimacy" },
  { label: "Dolly Out / Pull Back", description: "Camera moves away from subject: reveals context", promptText: "camera dolly out, slowly pulling back, revealing the wider scene" },
  { label: "Tracking Shot (Left)", description: "Camera moves laterally following or alongside subject", promptText: "tracking shot, camera moves left following subject, smooth lateral movement" },
  { label: "Tracking Shot (Right)", description: "Camera moves laterally following or alongside subject", promptText: "tracking shot, camera moves right following subject, smooth lateral movement" },
  { label: "Crane Up", description: "Camera rises vertically: grand reveal, ascending", promptText: "crane shot rising up, camera ascending smoothly, grand reveal" },
  { label: "Crane Down", description: "Camera descends vertically: grounding, approaching", promptText: "crane shot descending, camera lowering smoothly toward subject" },
  { label: "Zoom In", description: "Lens zooms (no physical movement): focus/surprise", promptText: "slow zoom in, lens gradually magnifying subject" },
  { label: "Zoom Out", description: "Lens zooms out: reveals scope, isolation", promptText: "slow zoom out, lens gradually widening to reveal full scene" },
  { label: "Orbit / Arc", description: "Camera circles around the subject", promptText: "orbit shot, camera slowly circling around subject, 360 arc movement" },
  { label: "Steadicam / Floating", description: "Smooth handheld follow: organic, immersive", promptText: "steadicam shot, smooth floating camera following subject naturally" },
  { label: "Handheld / Shaky", description: "Deliberate instability: urgency, documentary realism", promptText: "handheld camera, slight natural shake, documentary style" },
  { label: "Whip Pan", description: "Extremely fast horizontal rotation: transition, energy", promptText: "whip pan, fast horizontal blur transition" },
  { label: "Dolly Zoom (Vertigo)", description: "Zoom in while dollying out (or vice versa): surreal", promptText: "dolly zoom vertigo effect, background warping while subject stays same size" },
];

const COMPOSITION: ShotEntry[] = [
  { label: "Rule of Thirds", description: "Subject placed at 1/3 intersections: balanced, natural", promptText: "rule of thirds composition, subject off-center" },
  { label: "Center Framing", description: "Subject dead center: power, symmetry, Kubrick-style", promptText: "symmetrical center framing, subject in exact middle of frame" },
  { label: "Leading Lines", description: "Lines in scene draw eye to subject", promptText: "leading lines composition, perspective lines drawing attention to subject" },
  { label: "Negative Space", description: "Large empty area around subject: isolation, breathing room", promptText: "negative space composition, subject small with large empty area" },
  { label: "Frame Within Frame", description: "Subject framed by doorway, window, arch", promptText: "frame within frame composition, subject viewed through doorway" },
  { label: "Shallow DOF", description: "Background blurred, subject sharp: cinematic separation", promptText: "shallow depth of field, bokeh background, subject in sharp focus" },
  { label: "Deep Focus", description: "Everything sharp from foreground to background", promptText: "deep focus, everything sharp from foreground to background" },
];

const CATEGORIES: CategoryDef[] = [
  { label: "Shot Size", icon: <Maximize2 className="w-3 h-3" />, entries: SHOT_SIZES },
  { label: "Camera Angle", icon: <RotateCcw className="w-3 h-3" />, entries: CAMERA_ANGLES },
  { label: "Camera Movement", icon: <Move className="w-3 h-3" />, entries: CAMERA_MOVEMENTS },
  { label: "Composition", icon: <Camera className="w-3 h-3" />, entries: COMPOSITION },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 p-1 rounded hover:bg-cyan-500/20 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-cyan-400/60" />}
    </button>
  );
}

function ShotEntryRow({ entry }: { entry: ShotEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded border border-border/30 bg-background/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-cyan-500/5 transition-colors"
      >
        <span className="text-[10px] font-medium text-cyan-300/90 flex-1">
          {entry.abbr && <span className="text-cyan-400 font-bold mr-1.5">{entry.abbr}</span>}
          {entry.label}
        </span>
        {expanded ? <ChevronDown className="w-3 h-3 text-muted-foreground/50" /> : <ChevronRight className="w-3 h-3 text-muted-foreground/50" />}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-border/20">
          <p className="text-[9px] text-muted-foreground/70 pt-1.5 leading-relaxed">{entry.description}</p>
          <div className="flex items-center gap-1.5 bg-cyan-500/5 border border-cyan-500/20 rounded px-2 py-1.5">
            <code className="text-[9px] text-cyan-300/90 flex-1 leading-relaxed select-all">{entry.promptText}</code>
            <CopyButton text={entry.promptText} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function CameraShotHelper() {
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set(["Shot Size"]));

  const toggleCategory = (label: string) => {
    setOpenCategories(prev => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Camera className="w-4 h-4 text-cyan-400" />
        <h3 className="text-[11px] font-semibold text-cyan-400">Camera Shot Helper</h3>
      </div>
      <p className="text-[8px] text-muted-foreground/60 px-1 leading-relaxed">
        Click any term to reveal LTX-optimized prompt text. Copy and paste into your prompt.
      </p>

      {CATEGORIES.map((cat) => (
        <div key={cat.label} className="rounded-lg border border-cyan-500/15 bg-cyan-500/5 overflow-hidden">
          <button
            onClick={() => toggleCategory(cat.label)}
            className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-cyan-500/10 transition-colors"
          >
            {cat.icon}
            <span className="text-[10px] font-medium text-cyan-400/90 flex-1 text-left">{cat.label}</span>
            <span className="text-[8px] text-muted-foreground/40">{cat.entries.length}</span>
            {openCategories.has(cat.label) ? <ChevronDown className="w-3 h-3 text-cyan-400/50" /> : <ChevronRight className="w-3 h-3 text-cyan-400/50" />}
          </button>
          {openCategories.has(cat.label) && (
            <div className="px-1.5 pb-1.5 space-y-0.5">
              {cat.entries.map((entry) => (
                <ShotEntryRow key={entry.label} entry={entry} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
