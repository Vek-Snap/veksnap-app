"use client";

import { useState, useCallback } from "react";
import {
  Wand2,
  Loader2,
  Film,
  Clock,
  Users,
  MapPin,
  Palette,
  StickyNote,
  ArrowRight,
  AlertTriangle,
  Copy,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface ScriptSegment {
  frames: number;
  prompt: string;
  dialogue: string;
  shot_description: string;
  recommended_duration?: number;
}

interface ScriptWriterProps {
  onPopulateSegments: (segments: ScriptSegment[]) => void;
}

const DURATION_PRESETS = [
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
  { label: "15s", value: 15 },
  { label: "20s", value: 20 },
  { label: "30s", value: 30 },
  { label: "45s", value: 45 },
  { label: "60s", value: 60 },
];

export default function ScriptWriter({ onPopulateSegments }: ScriptWriterProps) {
  // Form state
  const [characters, setCharacters] = useState("");
  const [scene, setScene] = useState("");
  const [mood, setMood] = useState("");
  const [duration, setDuration] = useState(10);
  const [notes, setNotes] = useState("");

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<ScriptSegment[] | null>(null);
  const [totalSeconds, setTotalSeconds] = useState<number | null>(null);
  const [rawOutput, setRawOutput] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    setSegments(null);
    setRawOutput(null);

    try {
      const res = await fetch("/api/script-writer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characters,
          scene,
          mood,
          duration,
          notes,
        }),
      });

      const data = await res.json();

      if (data.error) {
        setError(data.error);
        if (data.raw_output) setRawOutput(data.raw_output);
        return;
      }

      if (data.segments && Array.isArray(data.segments)) {
        setSegments(data.segments);
        setTotalSeconds(data.total_seconds || null);
      } else {
        setError("Unexpected response format");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Script generation failed");
    } finally {
      setGenerating(false);
    }
  }, [characters, scene, mood, duration, notes, generating]);

  const handleAbort = useCallback(async () => {
    try {
      await fetch("/api/llm-abort", { method: "POST" });
    } catch { /* ignore */ }
    setGenerating(false);
    setError("Cancelled by user");
  }, []);

  const handlePopulate = useCallback(() => {
    if (segments) {
      onPopulateSegments(segments);
    }
  }, [segments, onPopulateSegments]);

  const handleReset = useCallback(() => {
    setSegments(null);
    setTotalSeconds(null);
    setError(null);
    setRawOutput(null);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3">
        <div className="flex items-center gap-2 mb-1">
          <Wand2 className="w-4 h-4 text-cyan-400" />
          <span className="text-[12px] text-cyan-400 font-semibold">Script Writer</span>
        </div>
        <p className="text-[9px] text-muted-foreground/70">
          Generate multi-segment video scripts tailored for LTX-2.3. Define your scene,
          and the AI drafts prompts formatted for optimal video generation quality.
        </p>
      </div>

      {/* Input Form */}
      <div className="space-y-3">
        {/* Characters */}
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground/80 flex items-center gap-1">
            <Users className="w-3 h-3" /> Characters
          </Label>
          <textarea
            className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
            rows={3}
            placeholder="Describe each character. Name, age, appearance, clothing.&#10;Example: Sarah - 28, shoulder-length dark brown hair, olive skin, wearing a black tank top and jeans"
            value={characters}
            onChange={(e) => setCharacters(e.target.value)}
            disabled={generating}
          />
        </div>

        {/* Scene */}
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground/80 flex items-center gap-1">
            <MapPin className="w-3 h-3" /> Scene / Setting
          </Label>
          <textarea
            className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
            rows={2}
            placeholder="Where does this take place? Time of day, location, atmosphere.&#10;Example: A dimly lit jazz bar at night, warm amber lighting, wood paneling"
            value={scene}
            onChange={(e) => setScene(e.target.value)}
            disabled={generating}
          />
        </div>

        {/* Mood */}
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground/80 flex items-center gap-1">
            <Palette className="w-3 h-3" /> Mood / Tone
          </Label>
          <input
            type="text"
            className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
            placeholder="e.g. Tense, intimate, playful, cinematic noir, dreamy"
            value={mood}
            onChange={(e) => setMood(e.target.value)}
            disabled={generating}
          />
        </div>

        {/* Duration */}
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground/80 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Target Duration
          </Label>
          <div className="flex items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setDuration(p.value)}
                  disabled={generating}
                  className={`px-2 py-0.5 rounded text-[9px] font-medium transition-colors ${
                    duration === p.value
                      ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/40"
                      : "bg-muted/20 text-muted-foreground/70 border border-border/30 hover:bg-muted/40"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={4}
              max={120}
              value={duration}
              onChange={(e) => setDuration(Math.max(4, Math.min(120, parseInt(e.target.value) || 10)))}
              disabled={generating}
              className="w-14 rounded-md border border-border/50 bg-background px-1.5 py-0.5 text-[10px] text-center focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
            />
            <span className="text-[9px] text-muted-foreground/50">seconds</span>
          </div>
          <p className="text-[8px] text-muted-foreground/40">
            LLM will split into segments of 4-10.7s each. Longer = more segments.
          </p>
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground/80 flex items-center gap-1">
            <StickyNote className="w-3 h-3" /> Additional Notes (optional)
          </Label>
          <textarea
            className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
            rows={2}
            placeholder="Any specific requests: camera styles, specific actions, dialogue topics, pacing notes..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={generating}
          />
        </div>

        {/* Generate Button */}
        <div className="flex items-center gap-2">
          <Button
            onClick={handleGenerate}
            disabled={generating || (!characters.trim() && !scene.trim() && !notes.trim())}
            className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-medium py-2"
          >
            {generating ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Writing Script...</>
            ) : (
              <><Wand2 className="w-3.5 h-3.5 mr-1.5" /> Generate Script</>
            )}
          </Button>
          {generating && (
            <Button
              onClick={handleAbort}
              variant="destructive"
              size="sm"
              className="text-[10px]"
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-[10px] text-red-400 font-medium">{error}</p>
              {rawOutput && (
                <details className="mt-1.5">
                  <summary className="text-[8px] text-muted-foreground/50 cursor-pointer">Raw LLM output</summary>
                  <pre className="text-[8px] text-muted-foreground/60 mt-1 max-h-32 overflow-auto whitespace-pre-wrap bg-black/20 p-1.5 rounded">
                    {rawOutput}
                  </pre>
                </details>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {segments && segments.length > 0 && (
        <div className="space-y-3">
          {/* Summary */}
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Film className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-[11px] text-emerald-400 font-medium">
                  Script Ready: {segments.length} segment{segments.length !== 1 ? "s" : ""}
                </span>
              </div>
              <span className="text-[9px] text-muted-foreground/60">
                {totalSeconds ? `${totalSeconds}s total` : ""}
              </span>
            </div>
            {segments[0]?.recommended_duration && (
              <p className="text-[9px] text-amber-400/80 mt-1">
                ⚠ LLM suggests {segments[0].recommended_duration}s for this scene
              </p>
            )}
          </div>

          {/* Segments */}
          <div className="space-y-2">
            {segments.map((seg, i) => (
              <div
                key={i}
                className="rounded-md border border-border/30 bg-muted/5 p-2.5 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-medium text-cyan-400/80">
                    Segment {i + 1}: {seg.shot_description}
                  </span>
                  <span className="text-[8px] text-muted-foreground/50">
                    {seg.frames} frames ({(seg.frames / 24).toFixed(1)}s)
                  </span>
                </div>
                <p className="text-[9px] text-foreground/80 leading-relaxed">
                  {seg.prompt}
                </p>
                {seg.dialogue && (
                  <p className="text-[8px] text-amber-400/70 italic">
                    Dialogue: &ldquo;{seg.dialogue}&rdquo;
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button
              onClick={handlePopulate}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium py-2"
            >
              <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
              Load into Director Pipeline
            </Button>
            <Button
              onClick={() => {
                const text = segments.map((s, i) =>
                  `[Segment ${i + 1}: ${s.shot_description}, ${s.frames}f (${(s.frames / 24).toFixed(1)}s)]\n${s.prompt}${s.dialogue ? `\nDialogue: ${s.dialogue}` : ""}`
                ).join("\n\n");
                navigator.clipboard.writeText(text);
              }}
              variant="outline"
              size="sm"
              className="text-[9px]"
              title="Copy script to clipboard"
            >
              <Copy className="w-3 h-3" />
            </Button>
            <Button
              onClick={handleReset}
              variant="outline"
              size="sm"
              className="text-[9px]"
              title="Clear results"
            >
              <RotateCcw className="w-3 h-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
