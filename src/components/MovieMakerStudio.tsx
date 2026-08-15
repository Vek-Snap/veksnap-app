"use client";

import { useState, useCallback, useRef } from "react";
import {
  Clapperboard,
  Plus,
  Trash2,
  Play,
  Square,
  Upload,
  Settings2,
  ChevronDown,
  ChevronRight,
  Volume2,
  Loader2,
  Download,
  RefreshCw,
  Sparkles,
  Wand2,
  Pause,
  Film,
  Camera,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  MovieMakerConfig,
  MovieMakerCharacter,
  MOVIEMAKER_CHARACTER_COLORS,
  MOVIEMAKER_DEFAULTS,
  SCENE_PERSPECTIVE_OPTIONS,
  type ScenePerspective,
  type MovieMakerSceneMeta,
} from "@/lib/types";
import MovieMakerScenePanel from "@/components/MovieMakerScenePanel";
import { parseScenes, replaceSceneDirection, stripLinePrefix } from "@/lib/movie-script";
import { isAutoFlushEnabled } from "@/lib/auto-flush-prefs";

interface MovieMakerStudioProps {
  config: MovieMakerConfig;
  onConfigChange: (config: MovieMakerConfig) => void;
  onExportToDirector?: (segments: unknown[], configOverrides: Record<string, unknown>) => void;
}

export default function MovieMakerStudio({ config, onConfigChange, onExportToDirector }: MovieMakerStudioProps) {
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error" | "paused">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputDuration, setOutputDuration] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scriptWriterOpen, setScriptWriterOpen] = useState(false);
  const [scriptWriterScenario, setScriptWriterScenario] = useState("");
  const [scriptWriterTone, setScriptWriterTone] = useState("");
  const [scriptWriterDuration, setScriptWriterDuration] = useState(60);
  const [scriptWriterNotes, setScriptWriterNotes] = useState("");
  const [scriptWriterLoading, setScriptWriterLoading] = useState(false);
  const [scriptWriterError, setScriptWriterError] = useState<string | null>(null);
  const [scriptWriterProgress, setScriptWriterProgress] = useState<{
    message: string; percent: number; tokens: number; maxTokens: number;
    elapsed: number; eta: number; tokensPerSec: number;
    chunk: number; totalChunks: number; phase: string;
  } | null>(null);
  const scriptWriterAbortRef = useRef<AbortController | null>(null);
  const [scriptWriterMaxSegment, setScriptWriterMaxSegment] = useState(25);
  const [scriptWriterPace, setScriptWriterPace] = useState(2.5);
  const [scriptWriterPovCharacter, setScriptWriterPovCharacter] = useState("");
  const [expandedCharId, setExpandedCharId] = useState<string | null>(null);
  // Scene panel: per-scene perspective re-write (which scene indices are currently re-writing)
  const [rewritingIndices, setRewritingIndices] = useState<number[]>([]);
  // Progress tracking for dialogue generation
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressStartTime, setProgressStartTime] = useState<number | null>(null);
  const abortRef = useRef(false);
  const pauseRef = useRef(false);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Scene image prompt state
  const [scenePromptsOpen, setScenePromptsOpen] = useState(false);
  const [scenePromptsSelected, setScenePromptsSelected] = useState<Set<number>>(new Set());
  const [scenePromptsGenerating, setScenePromptsGenerating] = useState(false);
  const [scenePromptsError, setScenePromptsError] = useState<string | null>(null);
  const [scenePromptsProgress, setScenePromptsProgress] = useState<{
    message: string; percent: number; phase: string;
    tokens: number; maxTokens: number; elapsed: number; eta: number; tokensPerSec: number;
  } | null>(null);
  const [scenePromptsResult, setScenePromptsResult] = useState<{
    prompts: { index: number; timestamp: string; direction: string; prompt: string }[];
    output_file: string;
  } | null>(null);
  const scenePromptsAbortRef = useRef<AbortController | null>(null);

  const update = useCallback(
    (partial: Partial<MovieMakerConfig>) => {
      onConfigChange({ ...config, ...partial });
    },
    [config, onConfigChange]
  );

  // ── Character Management ──
  const addCharacter = useCallback(() => {
    if (config.characters.length >= 4) return;
    const id = `char_${Date.now()}`;
    const idx = config.characters.length;
    const newChar: MovieMakerCharacter = {
      id,
      name: `Character ${idx + 1}`,
      age: "",
      gender: "",
      role: "",
      personality: "",
      description: "",
      voiceSampleFile: "",
      voiceSamplePreview: "",
      color: MOVIEMAKER_CHARACTER_COLORS[idx % MOVIEMAKER_CHARACTER_COLORS.length],
    };
    update({ characters: [...config.characters, newChar] });
    setExpandedCharId(id);
  }, [config.characters, update]);

  const removeCharacter = useCallback(
    (id: string) => {
      update({ characters: config.characters.filter((c) => c.id !== id) });
    },
    [config.characters, update]
  );

  const updateCharacter = useCallback(
    (id: string, partial: Partial<MovieMakerCharacter>) => {
      update({
        characters: config.characters.map((c) => (c.id === id ? { ...c, ...partial } : c)),
      });
    },
    [config.characters, update]
  );

  const handleVoiceSampleUpload = useCallback(
    async (charId: string, file: File) => {
      // Upload to ComfyUI input
      const formData = new FormData();
      formData.append("image", file); // ComfyUI upload endpoint uses 'image' field for all files
      formData.append("subfolder", "movie_maker_voices");
      formData.append("type", "input");

      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error("Upload failed");
        const data = await res.json();
        const filename = data.name || file.name;

        // Create preview URL
        const previewUrl = URL.createObjectURL(file);
        updateCharacter(charId, {
          voiceSampleFile: `movie_maker_voices/${filename}`,
          voiceSamplePreview: previewUrl,
        });
      } catch (err) {
        console.error("[MovieMaker] Voice sample upload failed:", err);
      }
    },
    [updateCharacter]
  );

  // ── Timestamp Formatter (seconds → MM:SS.ms) ──
  const fmtTs = (s: number): string => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    const whole = Math.floor(secs);
    const ms = Math.round((secs - whole) * 100);
    return `${String(mins).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
  };

  // ── Script Writer (SSE Streaming) ──
  const handleWriteScript = useCallback(async () => {
    if (!scriptWriterScenario.trim() && !scriptWriterNotes.trim()) {
      setScriptWriterError("Provide a scenario or notes.");
      return;
    }
    setScriptWriterLoading(true);
    setScriptWriterError(null);
    setScriptWriterProgress(null);

    const abortController = new AbortController();
    scriptWriterAbortRef.current = abortController;

    try {
      const res = await fetch("/api/movie-maker/write-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characters: config.characters.map((c, i) => ({
            name: c.name || `Character ${i + 1}`,
            personality: c.personality || "",
            role: c.role || "",
            description: c.description || "",
            age: c.age || "",
            gender: c.gender || "",
          })),
          scenario: scriptWriterScenario,
          tone: scriptWriterTone,
          durationSeconds: scriptWriterDuration,
          notes: scriptWriterNotes,
          maxSegmentDuration: scriptWriterMaxSegment,
          speakingPace: scriptWriterPace,
          povCharacter: scriptWriterPovCharacter,
        }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text();
        try {
          const errJson = JSON.parse(errText);
          setScriptWriterError(errJson.error || "Script generation failed");
        } catch {
          setScriptWriterError(errText || "Script generation failed");
        }
        return;
      }

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: Record<string, unknown> | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "";
          let eventData = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            if (line.startsWith("data: ")) eventData = line.slice(6);
          }
          if (!eventType || !eventData) continue;

          try {
            const parsed = JSON.parse(eventData);
            if (eventType === "progress") {
              if (parsed.type === "progress") {
                setScriptWriterProgress({
                  message: parsed.message || "",
                  percent: parsed.percent || 0,
                  tokens: parsed.tokens || 0,
                  maxTokens: parsed.max_tokens || 0,
                  elapsed: parsed.elapsed || 0,
                  eta: parsed.eta || 0,
                  tokensPerSec: parsed.tokens_per_sec || 0,
                  chunk: parsed.chunk || 1,
                  totalChunks: parsed.total_chunks || 1,
                  phase: parsed.phase || "",
                });
              } else if (parsed.type === "status") {
                setScriptWriterProgress(prev => ({
                  message: parsed.message || "",
                  percent: prev?.percent || 0,
                  tokens: prev?.tokens || 0,
                  maxTokens: prev?.maxTokens || 0,
                  elapsed: prev?.elapsed || 0,
                  eta: prev?.eta || 0,
                  tokensPerSec: prev?.tokensPerSec || 0,
                  chunk: prev?.chunk || 1,
                  totalChunks: prev?.totalChunks || 1,
                  phase: parsed.phase || prev?.phase || "",
                }));
              }
            } else if (eventType === "result") {
              result = parsed;
            } else if (eventType === "error") {
              setScriptWriterError(parsed.error || "Script generation failed");
              return;
            }
          } catch { /* skip malformed event */ }
        }
      }

      if (!result) {
        setScriptWriterError("No result received from script writer");
        return;
      }

      // Convert the tagged script to Movie Maker display format
      // Timestamps are preserved as a prefix for user review
      const scriptLines: string[] = [];
      for (const line of ((result.lines || []) as Array<{ type: string; speaker: number; text: string; start: number | null; end: number | null }>)) {
        const ts = (line.start != null && line.end != null)
          ? `# [${fmtTs(line.start)} - ${fmtTs(line.end)}]`
          : "";
        if (line.type === "dialogue") {
          scriptLines.push(`${ts ? ts : "  "}[${line.speaker}]: ${line.text}`);
        } else if (line.type === "sfx") {
          scriptLines.push(`${ts}[SFX] ${line.text}`);
        } else if (line.type === "music") {
          scriptLines.push(`${ts}[MUS] ${line.text}`);
        } else if (line.type === "narrator") {
          scriptLines.push(`${ts}[NAR] ${line.text}`);
        } else if (line.type === "direction") {
          scriptLines.push(`${ts}[DIR] ${line.text}`);
        }
      }

      // Fresh script → reset per-scene perspectives so they don't misalign with new scenes.
      update({ script: scriptLines.join("\n"), scenePerspectives: [] });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setScriptWriterError("Cancelled by user.");
      } else {
        setScriptWriterError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      setScriptWriterLoading(false);
      setScriptWriterProgress(null);
      scriptWriterAbortRef.current = null;
    }
  }, [scriptWriterScenario, scriptWriterTone, scriptWriterDuration, scriptWriterNotes, scriptWriterMaxSegment, scriptWriterPace, scriptWriterPovCharacter, config.characters, update]);

  const handleCancelScriptWriter = useCallback(async () => {
    // Abort the SSE fetch
    scriptWriterAbortRef.current?.abort();
    // Also send cancel to server
    try {
      await fetch("/api/movie-maker/write-script", { method: "DELETE" });
    } catch { /* ignore */ }
    try {
      await fetch("/api/llm-abort", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processName: "dialogue-writer" }) });
    } catch { /* ignore */ }
    setScriptWriterLoading(false);
    setScriptWriterProgress(null);
    setScriptWriterError("Cancelled by user.");
  }, []);

  // ── Scene Panel: per-scene camera perspective ──
  const setDefaultPerspective = useCallback(
    (p: ScenePerspective) => update({ defaultPerspective: p }),
    [update],
  );

  // Normalize the scenePerspectives array to the current scene count.
  const normalizedSceneMeta = useCallback((): MovieMakerSceneMeta[] => {
    const scenes = parseScenes(config.script);
    const existing = config.scenePerspectives ?? [];
    const def = config.defaultPerspective ?? "default";
    return scenes.map((_s, k) => existing[k] ?? { perspective: def, targetCharId: "", dirty: false });
  }, [config.script, config.scenePerspectives, config.defaultPerspective]);

  const changeSceneMeta = useCallback(
    (sceneIdx: number, partial: Partial<MovieMakerSceneMeta>) => {
      const arr = normalizedSceneMeta();
      if (sceneIdx < 0 || sceneIdx >= arr.length) return;
      arr[sceneIdx] = { ...arr[sceneIdx], ...partial };
      update({ scenePerspectives: arr });
    },
    [normalizedSceneMeta, update],
  );

  const applyDefaultToAll = useCallback(() => {
    const scenes = parseScenes(config.script);
    const def = config.defaultPerspective ?? "default";
    const opt = SCENE_PERSPECTIVE_OPTIONS.find((o) => o.id === def);
    const existing = config.scenePerspectives ?? [];
    const arr: MovieMakerSceneMeta[] = scenes.map((_s, k) => ({
      perspective: def,
      targetCharId: opt?.needsCharacter ? (existing[k]?.targetCharId || config.characters[0]?.id || "") : "",
      dirty: true,
    }));
    update({ scenePerspectives: arr });
  }, [config.script, config.defaultPerspective, config.scenePerspectives, config.characters, update]);

  // Re-write one or many scenes (single model load) and splice the new [DIR] text back in.
  const rewriteScenes = useCallback(async (indices: number[]) => {
    const scenes = parseScenes(config.script);
    const meta = normalizedSceneMeta();
    const targets = indices.filter((i) => i >= 0 && i < scenes.length && scenes[i].dirLineNo >= 0);
    if (targets.length === 0) return;

    const reqScenes = targets.map((i) => ({
      index: scenes[i].index,
      dialogue: scenes[i].dialogue,
      currentDirection: scenes[i].direction,
      perspective: meta[i].perspective,
      targetCharId: meta[i].targetCharId,
    }));

    setRewritingIndices((prev) => Array.from(new Set([...prev, ...targets])));
    try {
      const res = await fetch("/api/movie-maker/rewrite-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenes: reqScenes,
          characters: config.characters.map((c) => ({
            id: c.id, name: c.name, age: c.age, gender: c.gender, description: c.description,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setStatus("error");
        setStatusMessage(`Scene re-write failed: ${data.error || "Unknown error"}`);
        return;
      }

      // Splice returned directions back into the script (line count unchanged → dirLineNos stable).
      const directions: { index: number; direction: string }[] = data.directions || [];
      let newScript = config.script;
      const freshScenes = parseScenes(newScript);
      const byIndex = new Map(freshScenes.map((s) => [s.index, s]));
      const rewritten = new Set<number>();
      for (const d of directions) {
        const sb = byIndex.get(d.index);
        if (sb && d.direction) {
          newScript = replaceSceneDirection(newScript, sb.dirLineNo, d.direction);
          rewritten.add(d.index);
        }
      }

      // Clear dirty flags for the scenes that were successfully re-written.
      const arr = freshScenes.map((s, k) => {
        const m = meta[k] ?? { perspective: config.defaultPerspective ?? "default", targetCharId: "", dirty: false };
        return rewritten.has(s.index) ? { ...m, dirty: false } : m;
      });
      update({ script: newScript, scenePerspectives: arr });
    } catch (err) {
      setStatus("error");
      setStatusMessage(`Scene re-write error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRewritingIndices((prev) => prev.filter((i) => !targets.includes(i)));
    }
  }, [config.script, config.characters, config.defaultPerspective, normalizedSceneMeta, update]);

  const rewriteScene = useCallback((i: number) => rewriteScenes([i]), [rewriteScenes]);

  const rewriteAllDirty = useCallback(() => {
    const scenes = parseScenes(config.script);
    const existing = config.scenePerspectives ?? [];
    const dirty: number[] = [];
    scenes.forEach((s, k) => {
      if (existing[k]?.dirty && s.dirLineNo >= 0) dirty.push(k);
    });
    rewriteScenes(dirty);
  }, [config.script, config.scenePerspectives, rewriteScenes]);

  // ── Progress helper ──
  const getEtaString = useCallback(() => {
    if (!progressStartTime || progressCurrent === 0 || progressTotal === 0) return "";
    const elapsed = (Date.now() - progressStartTime) / 1000;
    const perSegment = elapsed / progressCurrent;
    const remaining = perSegment * (progressTotal - progressCurrent);
    if (remaining < 60) return `~${Math.round(remaining)}s remaining`;
    return `~${(remaining / 60).toFixed(1)}m remaining`;
  }, [progressStartTime, progressCurrent, progressTotal]);

  // ── Generation ──
  const handleGenerate = useCallback(async () => {
    if (!config.script.trim()) {
      setStatus("error");
      setStatusMessage("Please enter a script.");
      return;
    }
    if (config.characters.length === 0) {
      setStatus("error");
      setStatusMessage("Add at least one character with a voice sample.");
      return;
    }
    const samplesProvided = config.characters.filter((c) => c.voiceSampleFile);
    if (samplesProvided.length === 0) {
      setStatus("error");
      setStatusMessage("Provide at least one voice sample.");
      return;
    }

    setStatus("generating");
    setStatusMessage("Sending to DramaBox (per-line)...");
    setOutputUrl(null);
    setOutputDuration(null);
    setProgressCurrent(0);
    setProgressTotal(0);
    setProgressStartTime(null);
    abortRef.current = false;
    pauseRef.current = false;

    // Build the formatted script (0-indexed speakers)
    // Script format in UI: [1]: Hello -> Speaker 0: Hello. Lines may carry a
    // leading "# " and/or [timestamp] prefix (LLM output), strip that first, then
    // skip SFX/music/direction/narration annotations and keep only dialogue.
    const lines = config.script
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const formattedLines: string[] = [];
    for (const line of lines) {
      const bare = stripLinePrefix(line);
      if (/^\[(SFX|MUS|DIR|NAR)\]/i.test(bare)) continue; // annotation, not spoken
      const match = bare.match(/^\[(\d+)\]:\s*(.+)$/);
      if (match) {
        const speakerNum = parseInt(match[1]) - 1; // Convert 1-indexed to 0-indexed
        const text = match[2].trim();
        if (text) {
          formattedLines.push(`Speaker ${speakerNum}: ${text}`);
        }
      } else if (bare && !bare.startsWith("[")) {
        // Plain untagged line: assign to speaker 0
        formattedLines.push(`Speaker 0: ${bare}`);
      }
    }

    if (formattedLines.length === 0) {
      setStatus("error");
      setStatusMessage("No valid dialogue lines found. Use format: [1]: Hello");
      return;
    }

    // Set progress tracking
    const totalLines = formattedLines.length;
    setProgressTotal(totalLines);
    setProgressStartTime(Date.now());

    // Build voice sample paths. Pass filenames through verbatim, the
    // generate-dialogue route resolves them server-side (ComfyUI input-relative
    // names are used directly; absolute paths inside ComfyUI/input are converted
    // to relative). This avoids hardcoding the install location.
    const voiceSamples = config.characters.map((c) => c.voiceSampleFile || "");

    const seed = config.randomSeed ? -1 : config.seed;

    try {
      const res = await fetch("/api/movie-maker/generate-dialogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: config.engine,
          script: formattedLines.join("\n"),
          voiceSamples: voiceSamples.filter(Boolean),
          seed,
          cfgScale: config.cfgScale,
          numSteps: config.numSteps,
          doSample: config.doSample,
          temperature: config.temperature,
          topK: config.topK,
          topP: config.topP,
          repetitionPenalty: config.repetitionPenalty,
          chunkBySpeaker: config.chunkBySpeaker,
        }),
      });

      // Check if response is streaming (DramaBox progress) or JSON
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        // Stream progress events from DramaBox per-line generation
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let finalResult: Record<string, unknown> | null = null;

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === "progress") {
                  setProgressCurrent(evt.current);
                  setProgressTotal(evt.total);
                  setStatusMessage(`Generating line ${evt.current}/${evt.total}...`);
                } else if (evt.type === "done") {
                  finalResult = evt;
                }
              } catch { /* skip malformed */ }
            }

            // Check abort/pause
            if (abortRef.current) { reader.cancel(); break; }
            if (pauseRef.current) {
              reader.cancel();
              setStatus("paused");
              setStatusMessage(`Paused at line ${progressCurrent}/${progressTotal}`);
              return;
            }
          }
        }

        if (abortRef.current) {
          setStatus("idle");
          setStatusMessage("Cancelled");
          return;
        }

        if (finalResult && finalResult.output_path) {
          const outputPath = finalResult.output_path as string;
          const filename = outputPath.split(/[/\\]/).pop() || "";
          const url = `/api/comfyui/view?filename=${encodeURIComponent(filename)}&type=output`;
          setOutputUrl(url);
          setOutputDuration(finalResult.duration_seconds as number);
          setStatus("done");
          setStatusMessage(`Generated ${finalResult.duration_seconds}s of dialogue | Seed: ${finalResult.seed_used}`);
          if (config.randomSeed && finalResult.seed_used) {
            update({ seed: finalResult.seed_used as number });
          }
        } else if (!abortRef.current) {
          setStatus("error");
          setStatusMessage("No output received from streaming generation");
        }
      } else {
        // Standard JSON response (non-streaming)
        const result = await res.json();

        if (!res.ok || result.error) {
          setStatus("error");
          setStatusMessage(result.error || "Generation failed");
          return;
        }

        // Mark progress complete
        setProgressCurrent(totalLines);

        // Build playback URL from ComfyUI output
        const outputPath = result.output_path as string;
        const filename = outputPath.split(/[/\\]/).pop() || "";
        const url = `/api/comfyui/view?filename=${encodeURIComponent(filename)}&type=output`;

        setOutputUrl(url);
        setOutputDuration(result.duration_seconds);
        setStatus("done");
        setStatusMessage(
          `Generated ${result.duration_seconds}s of dialogue | Seed: ${result.seed_used}`
        );

        // Update seed if it was random
        if (config.randomSeed && result.seed_used) {
          update({ seed: result.seed_used });
        }
      }
    } catch (err) {
      if (!abortRef.current) {
        setStatus("error");
        setStatusMessage(err instanceof Error ? err.message : "Network error");
      }
    }
  }, [config, update]);

  const handleCancel = useCallback(async () => {
    abortRef.current = true;
    // Single-model workflow: only flush on cancel if the user opted in (AutoFlush, default off).
    // Chained pipelines are handled automatically by the VRAM guard, regardless of this toggle.
    if (isAutoFlushEnabled()) {
      try {
        await fetch("/api/flush-ram", { method: "POST" });
      } catch { /* ignore */ }
    }
    setStatus("idle");
    setStatusMessage("Cancelled");
    setProgressCurrent(0);
    setProgressTotal(0);
  }, []);

  const handlePause = useCallback(() => {
    pauseRef.current = true;
  }, []);

  const handleResume = useCallback(() => {
    pauseRef.current = false;
    // Re-trigger generation from where we left off, for now just set back to generating
    setStatus("generating");
    setStatusMessage(`Resuming from line ${progressCurrent}/${progressTotal}...`);
  }, [progressCurrent, progressTotal]);

  // ── Recover Concat (for when generation succeeds but concat fails) ──
  const handleRecoverConcat = useCallback(async () => {
    setStatus("generating");
    setStatusMessage("Recovering: re-running concat on existing segments...");
    try {
      const res = await fetch("/api/movie-maker/concat-segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pattern: "moviemaker_dramabox_line",
          silenceGapMs: config.engine === "dramabox" ? (config as any).dramabox?.silenceGapMs ?? 400 : 400,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setStatus("error");
        setStatusMessage(`Recovery failed: ${data.error || "Unknown error"}`);
        return;
      }
      setStatus("done");
      setStatusMessage(`Recovered! ${data.segments_concatenated} segments → ${data.duration_seconds}s`);
      if (data.output_path) {
        const filename = data.output_path.split(/[\\/]/).pop();
        setOutputUrl(`/api/comfyui-output/${filename}`);
        setOutputDuration(data.duration_seconds);
      }
    } catch (err) {
      setStatus("error");
      setStatusMessage(`Recovery error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [config]);

  // ── Scene Image Prompt Generation ──
  // Extract DIR blocks from the current script
  const extractDirBlocks = useCallback(() => {
    const blocks: { index: number; text: string; timestamp: string }[] = [];
    const lines = config.script.split("\n");
    let dirIndex = 1;
    for (const line of lines) {
      const trimmed = line.replace(/^#\s*/, "").trim();
      // Match timestamped: [MM:SS.ms - MM:SS.ms][DIR] text
      const tsMatch = trimmed.match(/^\[(\d{2}:\d{2}\.\d{2}\s*-\s*\d{2}:\d{2}\.\d{2})\]\[DIR\]\s*(.+)$/i);
      if (tsMatch) {
        blocks.push({ index: dirIndex, text: tsMatch[2], timestamp: tsMatch[1] });
        dirIndex++;
        continue;
      }
      // Match non-timestamped: [DIR] text
      const plainMatch = trimmed.match(/^\[DIR\]\s*(.+)$/i);
      if (plainMatch) {
        blocks.push({ index: dirIndex, text: plainMatch[1], timestamp: "" });
        dirIndex++;
      }
    }
    return blocks;
  }, [config.script]);

  const handleGenerateScenePrompts = useCallback(async () => {
    const allDirs = extractDirBlocks();
    const selectedDirs = allDirs.filter(d => scenePromptsSelected.has(d.index));
    if (!selectedDirs.length) {
      setScenePromptsError("Select at least one scene direction.");
      return;
    }

    setScenePromptsGenerating(true);
    setScenePromptsError(null);
    setScenePromptsProgress(null);
    setScenePromptsResult(null);

    const abortController = new AbortController();
    scenePromptsAbortRef.current = abortController;

    try {
      const res = await fetch("/api/movie-maker/generate-scene-prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directions: selectedDirs,
          characters: config.characters.map((c, i) => ({
            name: c.name || `Character ${i + 1}`,
            age: c.age || "",
            gender: c.gender || "",
            description: c.description || "",
            role: c.role || "",
            personality: c.personality || "",
          })),
        }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text();
        try { setScenePromptsError(JSON.parse(errText).error || "Failed"); }
        catch { setScenePromptsError(errText || "Failed"); }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "", eventData = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            if (line.startsWith("data: ")) eventData = line.slice(6);
          }
          if (!eventType || !eventData) continue;

          try {
            const parsed = JSON.parse(eventData);
            if (eventType === "progress") {
              if (parsed.type === "progress") {
                setScenePromptsProgress({
                  message: parsed.message || "",
                  percent: parsed.percent || 0,
                  tokens: parsed.tokens || 0,
                  maxTokens: parsed.max_tokens || 0,
                  elapsed: parsed.elapsed || 0,
                  eta: parsed.eta || 0,
                  tokensPerSec: parsed.tokens_per_sec || 0,
                  phase: parsed.phase || "",
                });
              } else if (parsed.type === "status") {
                setScenePromptsProgress(prev => ({
                  message: parsed.message || "",
                  percent: prev?.percent || 0,
                  tokens: prev?.tokens || 0,
                  maxTokens: prev?.maxTokens || 0,
                  elapsed: prev?.elapsed || 0,
                  eta: prev?.eta || 0,
                  tokensPerSec: prev?.tokensPerSec || 0,
                  phase: parsed.phase || prev?.phase || "",
                }));
              }
            } else if (eventType === "result") {
              setScenePromptsResult(parsed);
            } else if (eventType === "error") {
              setScenePromptsError(parsed.error || "Generation failed");
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setScenePromptsError("Cancelled by user.");
      } else {
        setScenePromptsError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      setScenePromptsGenerating(false);
      setScenePromptsProgress(null);
      scenePromptsAbortRef.current = null;
    }
  }, [extractDirBlocks, scenePromptsSelected, config.characters]);

  const handleCancelScenePrompts = useCallback(async () => {
    scenePromptsAbortRef.current?.abort();
    try {
      await fetch("/api/movie-maker/generate-scene-prompts", { method: "DELETE" });
    } catch { /* ignore */ }
    try {
      await fetch("/api/llm-abort", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processName: "scene-prompt-writer" }) });
    } catch { /* ignore */ }
    setScenePromptsGenerating(false);
    setScenePromptsProgress(null);
    setScenePromptsError("Cancelled by user.");
  }, []);

  // ── Export to Director Mode ──
  const [exportingToDirector, setExportingToDirector] = useState(false);
  const [exportOptionsOpen, setExportOptionsOpen] = useState(false);
  const [exportIncludeDialogue, setExportIncludeDialogue] = useState(true);
  const [exportSendSfxDescriptions, setExportSendSfxDescriptions] = useState(true);

  const handleExportToDirector = useCallback(async () => {
    if (!onExportToDirector) return;

    // Get dialogue audio filename from outputUrl
    let dialogueAudioFile = "";
    if (exportIncludeDialogue && outputUrl) {
      const match = outputUrl.match(/filename=([^&]+)/);
      if (match) dialogueAudioFile = decodeURIComponent(match[1]);
      else {
        const parts = outputUrl.split("/");
        dialogueAudioFile = parts[parts.length - 1];
      }
    }

    // SFX foley is handled by LTX from [SFX] text descriptions (license-clean).
    const includeSfxDescriptions = exportSendSfxDescriptions;

    setExportingToDirector(true);
    setExportOptionsOpen(false);
    try {
      const res = await fetch("/api/movie-maker/export-to-director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: config.script,
          dialogueAudioFile,
          sfxAudioFiles: [],
          includeSfxDescriptions,
          // Send full character records (not just names) so the exporter can build
          // brief, name-free physical descriptions for the LTX prompt and strip
          // character names out of the direction text.
          characters: config.characters.map((c) => ({
            name: c.name || "",
            age: c.age || "",
            gender: c.gender || "",
            description: c.description || "",
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setStatusMessage(`Export failed: ${data.error || "Unknown error"}`);
        setStatus("error");
        return;
      }

      onExportToDirector(data.segments, data.config || {});
      setStatusMessage(`Exported ${data.sceneCount} scenes to Director Mode`);
      setStatus("done");
    } catch (err) {
      setStatusMessage(`Export error: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
    } finally {
      setExportingToDirector(false);
    }
  }, [config.script, config.characters, outputUrl, onExportToDirector, exportIncludeDialogue, exportSendSfxDescriptions]);

  // ── Enrich Script with Visual Directions ──
  const [enrichSetting, setEnrichSetting] = useState("");
  const [enrichStyle, setEnrichStyle] = useState("");
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  const handleEnrichDirections = useCallback(async () => {
    if (!config.script.trim()) {
      setEnrichError("Script is empty");
      return;
    }
    setEnrichLoading(true);
    setEnrichError(null);

    try {
      const res = await fetch("/api/movie-maker/enrich-directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: config.script,
          setting: enrichSetting,
          style: enrichStyle,
          characters: config.characters.map((c) => ({
            name: c.name,
            description: c.description || "",
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setEnrichError(data.error || "Failed to enrich script");
        return;
      }

      if (data.enrichedScript) {
        // New directions → reset per-scene perspectives to stay aligned.
        update({ script: data.enrichedScript, scenePerspectives: [] });
      }
    } catch (err) {
      setEnrichError(err instanceof Error ? err.message : "Network error");
    } finally {
      setEnrichLoading(false);
    }
  }, [config.script, config.characters, enrichSetting, enrichStyle, update]);

  const handleCancelEnrich = useCallback(async () => {
    try {
      await fetch("/api/llm-abort", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processName: "enrich-directions" }) });
    } catch { /* ignore */ }
    setEnrichLoading(false);
    setEnrichError("Cancelled by user.");
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-teal-500/30 bg-teal-500/5">
        <Clapperboard className="w-5 h-5 text-teal-400" />
        <h2 className="text-sm font-semibold text-teal-300">VS - Movie Maker</h2>
        <span className="text-[10px] text-teal-500/70 ml-auto">Multi-Speaker Dialogue</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ── Engine ── */}
        <div className="flex gap-2">
          <button
            disabled
            className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-teal-500/20 text-teal-300 border border-teal-500/40 cursor-default"
          >
            DramaBox (Per-Line)
          </button>
          <button
            disabled
            title="Additional TTS engines are planned for a future update"
            className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-muted/20 text-muted-foreground/50 border border-border/20 cursor-not-allowed"
          >
            Reserved: stay tuned
          </button>
        </div>

        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md p-2">
          DramaBox generates each line individually via ComfyUI, then stitches them with silence gaps for expressive per-line delivery.
        </div>

        {/* ── Characters ── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">Characters (max 4)</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={addCharacter}
              disabled={config.characters.length >= 4}
              className="h-6 px-2 text-[10px] text-teal-400 hover:text-teal-300"
            >
              <Plus className="w-3 h-3 mr-1" /> Add
            </Button>
          </div>

          <div className="space-y-2">
            {config.characters.map((char, idx) => (
              <div key={char.id} className="rounded-md border border-border/30 bg-muted/20 overflow-hidden">
                {/* Header row */}
                <div className="flex items-center gap-2 p-2">
                  {/* Color indicator */}
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: char.color }}
                  />

                  {/* Name */}
                  <input
                    type="text"
                    value={char.name}
                    onChange={(e) => updateCharacter(char.id, { name: e.target.value })}
                    className="flex-1 bg-transparent text-xs text-foreground border-none outline-none placeholder:text-muted-foreground/50 min-w-0 font-medium"
                    placeholder={`Speaker ${idx + 1}`}
                  />

                  {/* Speaker number badge */}
                  <span className="text-[9px] font-mono text-muted-foreground/60 px-1">
                    [{idx + 1}]
                  </span>

                  {/* Expand/collapse identity */}
                  <button
                    onClick={() => setExpandedCharId(expandedCharId === char.id ? null : char.id)}
                    className="text-muted-foreground/60 hover:text-foreground transition-colors"
                  >
                    {expandedCharId === char.id ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>

                  {/* Voice sample button */}
                  <button
                    onClick={() => fileInputRefs.current[char.id]?.click()}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                      char.voiceSampleFile
                        ? "bg-teal-500/20 text-teal-300"
                        : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
                    }`}
                  >
                    {char.voiceSampleFile ? (
                      <Volume2 className="w-3 h-3" />
                    ) : (
                      <Upload className="w-3 h-3" />
                    )}
                    {char.voiceSampleFile ? "Voice" : "Upload"}
                  </button>
                  <input
                    ref={(el) => { fileInputRefs.current[char.id] = el; }}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleVoiceSampleUpload(char.id, file);
                      e.target.value = "";
                    }}
                  />

                  {/* Remove */}
                  <button
                    onClick={() => removeCharacter(char.id)}
                    className="text-muted-foreground/40 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {/* Expanded identity fields */}
                {expandedCharId === char.id && (
                  <div className="px-2 pb-2 pt-0 space-y-1.5 border-t border-border/20 mt-0">
                    <div className="grid grid-cols-4 gap-1.5 pt-1.5">
                      <div>
                        <label className="text-[9px] text-muted-foreground/60 block mb-0.5">Age</label>
                        <input
                          type="text"
                          value={char.age || ""}
                          onChange={(e) => updateCharacter(char.id, { age: e.target.value })}
                          placeholder="e.g. 24"
                          className="w-full bg-muted/30 border border-border/20 rounded px-1.5 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-muted-foreground/60 block mb-0.5">Gender</label>
                        <select
                          value={char.gender || ""}
                          onChange={(e) => updateCharacter(char.id, { gender: e.target.value })}
                          className="w-full bg-muted/30 border border-border/20 rounded px-1.5 py-0.5 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-teal-500/30"
                        >
                          <option value="">-</option>
                          <option value="male">Male</option>
                          <option value="female">Female</option>
                          <option value="non-binary">Non-binary</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[9px] text-muted-foreground/60 block mb-0.5">Role</label>
                        <input
                          type="text"
                          value={char.role}
                          onChange={(e) => updateCharacter(char.id, { role: e.target.value })}
                          placeholder="Detective"
                          className="w-full bg-muted/30 border border-border/20 rounded px-1.5 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
                        />
                      </div>
                      <div>
                        <label className="text-[9px] text-muted-foreground/60 block mb-0.5">Personality</label>
                        <input
                          type="text"
                          value={char.personality}
                          onChange={(e) => updateCharacter(char.id, { personality: e.target.value })}
                          placeholder="Sarcastic"
                          className="w-full bg-muted/30 border border-border/20 rounded px-1.5 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[9px] text-muted-foreground/60 block mb-0.5">Description (voice/physical, used by script writer &amp; SFX)</label>
                      <textarea
                        value={char.description}
                        onChange={(e) => updateCharacter(char.id, { description: e.target.value })}
                        placeholder="e.g. Deep baritone, speaks slowly and deliberately. Tall, dark hair, leather jacket."
                        rows={2}
                        className="w-full bg-muted/30 border border-border/20 rounded px-1.5 py-1 text-[10px] text-foreground resize-none placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-teal-500/30"
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {config.characters.length === 0 && (
              <div className="text-xs text-muted-foreground/50 text-center py-4 border border-dashed border-border/30 rounded-md">
                No characters yet. Click &quot;Add&quot; to create one.
              </div>
            )}
          </div>
        </div>

        <Separator className="opacity-30" />

        {/* ── Script Writer (AI) ── */}
        <div>
          <button
            onClick={() => setScriptWriterOpen(!scriptWriterOpen)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {scriptWriterOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            <Sparkles className="w-3 h-3 text-amber-400" />
            AI Script Writer
            <span className="text-[9px] text-muted-foreground/40 ml-auto">Generate dialogue from a scenario</span>
          </button>

          {scriptWriterOpen && (
            <div className="mt-2 p-3 rounded-md border border-amber-500/20 bg-amber-500/5 space-y-2">
              {/* Scenario */}
              <div>
                <label className="text-[10px] text-muted-foreground mb-0.5 block">Scenario</label>
                <textarea
                  value={scriptWriterScenario}
                  onChange={(e) => setScriptWriterScenario(e.target.value)}
                  placeholder="Two detectives interrogate a suspect who knows more than they're letting on..."
                  className="w-full h-16 bg-muted/20 border border-border/30 rounded px-2 py-1.5 text-xs text-foreground resize-y placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                />
              </div>

              {/* Tone + Duration row */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-muted-foreground mb-0.5 block">Tone</label>
                  <input
                    type="text"
                    value={scriptWriterTone}
                    onChange={(e) => setScriptWriterTone(e.target.value)}
                    placeholder="tense, suspenseful"
                    className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                  />
                </div>
                <div className="w-20">
                  <label className="text-[10px] text-muted-foreground mb-0.5 block">Duration</label>
                  <input
                    type="number"
                    value={scriptWriterDuration}
                    onChange={(e) => setScriptWriterDuration(parseInt(e.target.value) || 60)}
                    min={10}
                    max={300}
                    className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                  />
                  <span className="text-[8px] text-muted-foreground/40">seconds</span>
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="text-[10px] text-muted-foreground mb-0.5 block">Notes (optional)</label>
                <input
                  type="text"
                  value={scriptWriterNotes}
                  onChange={(e) => setScriptWriterNotes(e.target.value)}
                  placeholder="Include a plot twist, end on a cliffhanger..."
                  className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                />
              </div>

              {/* Video & Timing Parameters */}
              <div className="flex gap-2">
                <div className="w-24">
                  <label className="text-[10px] text-muted-foreground mb-0.5 block">Max Segment</label>
                  <input
                    type="number"
                    value={scriptWriterMaxSegment}
                    onChange={(e) => setScriptWriterMaxSegment(parseInt(e.target.value) || 25)}
                    min={5}
                    max={60}
                    className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                  />
                  <span className="text-[8px] text-muted-foreground/40">sec (video limit)</span>
                </div>
                <div className="w-20">
                  <label className="text-[10px] text-muted-foreground mb-0.5 block">Pace</label>
                  <input
                    type="number"
                    value={scriptWriterPace}
                    onChange={(e) => setScriptWriterPace(parseFloat(e.target.value) || 2.5)}
                    min={1.0}
                    max={5.0}
                    step={0.1}
                    className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                  />
                  <span className="text-[8px] text-muted-foreground/40">words/sec</span>
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-muted-foreground mb-0.5 block">POV Character (optional)</label>
                  <select
                    value={scriptWriterPovCharacter}
                    onChange={(e) => setScriptWriterPovCharacter(e.target.value)}
                    className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/40"
                  >
                    <option value="">None (third-person camera)</option>
                    {config.characters.map((c, i) => (
                      <option key={c.id} value={c.name || `Character ${i + 1}`}>
                        {c.name || `Character ${i + 1}`}
                      </option>
                    ))}
                  </select>
                  <span className="text-[8px] text-muted-foreground/40">first-person for [DIR]</span>
                </div>
              </div>

              {/* Generate / Cancel buttons */}
              {scriptWriterLoading ? (
                <div className="space-y-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="w-full text-xs"
                    onClick={handleCancelScriptWriter}
                  >
                    <Square className="w-3 h-3 mr-1.5" /> Cancel Script Writing
                  </Button>

                  {/* Progress display */}
                  {scriptWriterProgress && (
                    <div className="bg-muted/20 border border-amber-500/20 rounded p-2 space-y-1.5">
                      {/* Status message */}
                      <div className="text-[10px] text-amber-400/90 truncate">
                        {scriptWriterProgress.message}
                      </div>

                      {/* Progress bar (only during generate phase) */}
                      {scriptWriterProgress.phase === "generate" && scriptWriterProgress.percent > 0 && (
                        <>
                          <div className="w-full bg-muted/30 rounded-full h-1.5">
                            <div
                              className="bg-amber-500 h-1.5 rounded-full transition-all duration-500"
                              style={{ width: `${Math.min(100, scriptWriterProgress.percent)}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-[9px] text-muted-foreground/60">
                            <span>
                              {scriptWriterProgress.tokens}/{scriptWriterProgress.maxTokens} tokens
                              {scriptWriterProgress.totalChunks > 1 && ` (chunk ${scriptWriterProgress.chunk}/${scriptWriterProgress.totalChunks})`}
                            </span>
                            <span>
                              {scriptWriterProgress.tokensPerSec > 0 && `${scriptWriterProgress.tokensPerSec} tok/s · `}
                              {scriptWriterProgress.elapsed > 0 && `${Math.round(scriptWriterProgress.elapsed)}s`}
                              {scriptWriterProgress.eta > 0 && ` · ~${Math.round(scriptWriterProgress.eta)}s left`}
                            </span>
                          </div>
                        </>
                      )}

                      {/* Phase indicator for non-generate phases */}
                      {scriptWriterProgress.phase !== "generate" && (
                        <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground/50">
                          <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                          {scriptWriterProgress.phase === "load" && "Loading model..."}
                          {scriptWriterProgress.phase === "parse" && "Parsing output..."}
                          {scriptWriterProgress.phase === "cleanup" && "Freeing VRAM..."}
                          {scriptWriterProgress.phase === "done" && "Complete!"}
                          {scriptWriterProgress.phase === "init" && "Initializing..."}
                          {scriptWriterProgress.phase === "log" && "Working..."}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Fallback spinner when no progress yet */}
                  {!scriptWriterProgress && (
                    <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground/50 px-1">
                      <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                      Starting script writer...
                    </div>
                  )}
                </div>
              ) : (
                <Button
                  size="sm"
                  className="w-full bg-amber-600 hover:bg-amber-700 text-white text-xs"
                  onClick={handleWriteScript}
                >
                  <Wand2 className="w-3 h-3 mr-1.5" /> Write Script
                </Button>
              )}

              {scriptWriterError && (
                <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
                  {scriptWriterError}
                </div>
              )}

              <div className="text-[9px] text-muted-foreground/40">
                Uses Qwen3.5-9B to generate tagged dialogue. Long scripts ({">"}120s) auto-chunk with context recycling.
              </div>
            </div>
          )}
        </div>

        <Separator className="opacity-30" />

        {/* ── Script Input ── */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-muted-foreground">Dialogue Script</span>
            <span className="text-[9px] text-muted-foreground/50">
              Format: [N]: dialogue text
            </span>
          </div>

          {/* Scene Panel: per-scene camera perspective control */}
          <div className="mb-2">
            <MovieMakerScenePanel
              script={config.script}
              characters={config.characters}
              scenePerspectives={config.scenePerspectives ?? []}
              defaultPerspective={config.defaultPerspective ?? "default"}
              rewritingIndices={rewritingIndices}
              disabled={status === "generating" || scriptWriterLoading}
              onChangeDefault={setDefaultPerspective}
              onApplyDefaultToAll={applyDefaultToAll}
              onChangeSceneMeta={changeSceneMeta}
              onRewriteScene={rewriteScene}
              onRewriteAllDirty={rewriteAllDirty}
            />
          </div>

          <textarea
            value={config.script}
            onChange={(e) => update({ script: e.target.value })}
            placeholder={`[1]: Hello, welcome to our show!\n[2]: Thanks for having me, it's great to be here.\n[1]: Let's dive right into the topic.\n[3]: I have some thoughts on that...`}
            className="w-full h-40 bg-muted/20 border border-border/30 rounded-md p-3 text-xs text-foreground font-mono resize-y placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-teal-500/40"
            spellCheck={false}
          />
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[9px] text-muted-foreground/40">
              {config.script.split("\n").filter((l) => /^\[\d+\]:/.test(stripLinePrefix(l))).length} dialogue
            </span>
            <span className="text-[9px] text-muted-foreground/40">
              | {config.script.split("\n").filter((l) => /^\[(SFX|MUS|DIR|NAR)\]/i.test(stripLinePrefix(l))).length} annotations
            </span>
            {config.characters.length > 0 && (
              <span className="text-[9px] text-muted-foreground/40">
                | {config.characters.length} speaker{config.characters.length > 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* ── Enrich with Visual Directions ── */}
          <div className="mt-2 p-2.5 rounded-md border border-fuchsia-500/20 bg-fuchsia-500/5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Film className="w-3 h-3 text-fuchsia-400" />
              <span className="text-[10px] font-medium text-fuchsia-300">Add Scene Directions for Video</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="text-[9px] text-muted-foreground/60 mb-0.5 block">Setting / Environment</label>
                <input
                  type="text"
                  value={enrichSetting}
                  onChange={(e) => setEnrichSetting(e.target.value)}
                  placeholder="Noir office, 1940s"
                  className="w-full bg-muted/20 border border-border/30 rounded px-1.5 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-fuchsia-500/40"
                />
              </div>
              <div>
                <label className="text-[9px] text-muted-foreground/60 mb-0.5 block">Visual Style</label>
                <input
                  type="text"
                  value={enrichStyle}
                  onChange={(e) => setEnrichStyle(e.target.value)}
                  placeholder="cinematic, moody lighting"
                  className="w-full bg-muted/20 border border-border/30 rounded px-1.5 py-0.5 text-[10px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-fuchsia-500/40"
                />
              </div>
            </div>
            {enrichLoading ? (
              <Button
                size="sm"
                variant="destructive"
                className="w-full text-[10px] h-6"
                onClick={handleCancelEnrich}
              >
                <Square className="w-2.5 h-2.5 mr-1" /> Cancel
              </Button>
            ) : (
              <Button
                size="sm"
                className="w-full bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-[10px] h-6"
                disabled={!config.script.trim()}
                onClick={handleEnrichDirections}
              >
                <Wand2 className="w-2.5 h-2.5 mr-1" /> Generate Scene Directions (AI)
              </Button>
            )}
            {enrichError && (
              <div className="text-[9px] text-red-400">{enrichError}</div>
            )}
            <div className="text-[8px] text-muted-foreground/40">
              Reads your existing script and inserts # [DIR] visual descriptions for LTX video generation.
            </div>
          </div>
        </div>

        <Separator className="opacity-30" />

        {/* ── Generation Settings (collapsible) ── */}
        <div>
          <button
            onClick={() => setSettingsOpen(!settingsOpen)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
          >
            {settingsOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            <Settings2 className="w-3 h-3" />
            Generation Settings
          </button>

          {settingsOpen && (
            <div className="mt-2 p-3 rounded-md border border-border/20 bg-muted/10 space-y-3">
              {/* Seed */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-muted-foreground w-24">Seed</label>
                <input
                  type="number"
                  value={config.seed}
                  onChange={(e) => update({ seed: parseInt(e.target.value) || -1 })}
                  className="flex-1 bg-muted/30 border border-border/30 rounded px-2 py-0.5 text-[10px] text-foreground"
                  disabled={config.randomSeed}
                />
                <button
                  onClick={() => update({ randomSeed: !config.randomSeed })}
                  className={`px-2 py-0.5 rounded text-[9px] font-medium transition-colors ${
                    config.randomSeed
                      ? "bg-teal-500/20 text-teal-300"
                      : "bg-muted/30 text-muted-foreground"
                  }`}
                >
                  Random
                </button>
              </div>

              {/* CFG Scale */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-muted-foreground w-24">CFG Scale</label>
                <Slider
                  value={[config.cfgScale]}
                  onValueChange={([v]) => update({ cfgScale: v })}
                  min={1}
                  max={7}
                  step={0.5}
                  className="flex-1"
                />
                <span className="text-[10px] text-muted-foreground w-8 text-right">
                  {config.cfgScale}
                </span>
              </div>

              {/* Steps */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-muted-foreground w-24">Diffusion Steps</label>
                <Slider
                  value={[config.numSteps]}
                  onValueChange={([v]) => update({ numSteps: v })}
                  min={5}
                  max={50}
                  step={5}
                  className="flex-1"
                />
                <span className="text-[10px] text-muted-foreground w-8 text-right">
                  {config.numSteps}
                </span>
              </div>

              {/* Temperature */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-muted-foreground w-24">Temperature</label>
                <Slider
                  value={[config.temperature]}
                  onValueChange={([v]) => update({ temperature: v })}
                  min={0.1}
                  max={1.5}
                  step={0.05}
                  className="flex-1"
                />
                <span className="text-[10px] text-muted-foreground w-8 text-right">
                  {config.temperature.toFixed(2)}
                </span>
              </div>

              {/* Chunk by speaker */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-muted-foreground w-24">Chunk by Speaker</label>
                <button
                  onClick={() => update({ chunkBySpeaker: !config.chunkBySpeaker })}
                  className={`px-2 py-0.5 rounded text-[9px] font-medium transition-colors ${
                    config.chunkBySpeaker
                      ? "bg-teal-500/20 text-teal-300"
                      : "bg-muted/30 text-muted-foreground"
                  }`}
                >
                  {config.chunkBySpeaker ? "ON" : "OFF"}
                </button>
                <span className="text-[9px] text-muted-foreground/50">
                  Prevents quality degradation on long scripts
                </span>
              </div>
            </div>
          )}
        </div>

        <Separator className="opacity-30" />

        {/* ── Pipeline Controls ── */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => update({ pauseBetweenSegments: !config.pauseBetweenSegments })}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-medium transition-colors ${
              config.pauseBetweenSegments
                ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                : "bg-muted/30 text-muted-foreground border border-border/20"
            }`}
          >
            <Pause className="w-2.5 h-2.5" />
            {config.pauseBetweenSegments ? "Pause Enabled" : "Pause Between"}
          </button>
          <span className="text-[8px] text-muted-foreground/40">
            Pauses after each segment for review
          </span>
        </div>

        <Separator className="opacity-30" />

        {/* ── Generate Button ── */}
        <div className="space-y-2">
          {status === "generating" ? (
            <div className="flex gap-2">
              <Button
                variant="destructive"
                className="flex-1"
                onClick={handleCancel}
              >
                <Square className="w-4 h-4 mr-2" />
                Cancel
              </Button>
              <Button
                className="bg-sky-600 hover:bg-sky-700 text-white"
                onClick={handlePause}
              >
                <Pause className="w-4 h-4" />
              </Button>
            </div>
          ) : status === "paused" ? (
            <div className="flex gap-2">
              <Button
                className="flex-1 bg-teal-600 hover:bg-teal-700 text-white"
                onClick={handleResume}
              >
                <Play className="w-4 h-4 mr-2" />
                Resume
              </Button>
              <Button
                variant="destructive"
                onClick={handleCancel}
              >
                <Square className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <Button
              className="w-full bg-teal-600 hover:bg-teal-700 text-white"
              onClick={handleGenerate}
            >
              <Play className="w-4 h-4 mr-2" />
              Generate Dialogue
            </Button>
          )}

          {/* Progress bar */}
          {(status === "generating" || status === "paused") && progressTotal > 0 && (
            <div className="space-y-1">
              <div className="w-full h-1.5 bg-muted/30 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    status === "paused" ? "bg-sky-400" : "bg-teal-400"
                  }`}
                  style={{ width: `${Math.round((progressCurrent / progressTotal) * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-muted-foreground/60">
                  {progressCurrent}/{progressTotal} lines ({Math.round((progressCurrent / progressTotal) * 100)}%)
                </span>
                <span className="text-[9px] text-muted-foreground/60">
                  {getEtaString()}
                </span>
              </div>
            </div>
          )}

          {/* Status message */}
          {statusMessage && (
            <div
              className={`text-xs px-3 py-1.5 rounded-md ${
                status === "error"
                  ? "bg-red-500/10 text-red-400 border border-red-500/20"
                  : status === "done"
                  ? "bg-teal-500/10 text-teal-300 border border-teal-500/20"
                  : status === "paused"
                  ? "bg-sky-500/10 text-sky-300 border border-sky-500/20"
                  : "bg-muted/30 text-muted-foreground"
              }`}
            >
              {status === "generating" && <Loader2 className="w-3 h-3 inline mr-1 animate-spin" />}
              {status === "paused" && <Pause className="w-3 h-3 inline mr-1" />}
              {statusMessage}
            </div>
          )}

          {/* Recovery button: always visible for re-concatenating existing segments */}
          {status !== "generating" && (
            <Button
              variant="outline"
              className="w-full border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
              onClick={handleRecoverConcat}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-2" />
              Recover: Re-concat Existing Segments
            </Button>
          )}
        </div>

        {/* ── Output Player ── */}
        {outputUrl && (
          <div className="p-3 rounded-md border border-teal-500/20 bg-teal-500/5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-teal-300">Generated Dialogue</span>
              {outputDuration && (
                <span className="text-[10px] text-teal-400/70">{outputDuration.toFixed(1)}s</span>
              )}
            </div>
            <audio controls className="w-full h-8" src={outputUrl} />
            <div className="flex gap-2">
              <a
                href={outputUrl}
                download
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-muted/30 text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                <Download className="w-3 h-3" /> Download
              </a>
              <button
                onClick={() => {
                  setOutputUrl(null);
                  setStatus("idle");
                  setStatusMessage("");
                }}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-muted/30 text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                <RefreshCw className="w-3 h-3" /> Clear
              </button>
              {onExportToDirector && config.script.includes("[DIR]") && (
                <button
                  onClick={() => setExportOptionsOpen(true)}
                  disabled={exportingToDirector}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-fuchsia-500/20 text-fuchsia-300 hover:bg-fuchsia-500/30 transition-colors disabled:opacity-50"
                  title="Export script + audio to Director Mode for video generation"
                >
                  {exportingToDirector ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> Exporting...</>
                  ) : (
                    <><Film className="w-3 h-3" /> → Director</>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Scene Image Prompts ── */}
        {config.script.includes("[DIR]") && (
          <>
            <Separator className="opacity-30" />
            <div>
              <button
                onClick={() => setScenePromptsOpen(!scenePromptsOpen)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
              >
                {scenePromptsOpen ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                <Camera className="w-3.5 h-3.5 text-cyan-400" />
                <span className="font-medium">Scene Image Prompts</span>
                <span className="text-[9px] text-muted-foreground/50 ml-auto">
                  {extractDirBlocks().length} scenes
                </span>
              </button>

              {scenePromptsOpen && (() => {
                const dirBlocks = extractDirBlocks();
                return (
                  <div className="mt-2 p-3 rounded-md border border-cyan-500/20 bg-cyan-500/5 space-y-2">
                    {/* Select All / None */}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-cyan-300/80 font-medium">Select scenes for prompt generation:</span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setScenePromptsSelected(new Set(dirBlocks.map(d => d.index)))}
                          className="text-[9px] text-cyan-400 hover:text-cyan-300 transition-colors"
                        >
                          Select All
                        </button>
                        <span className="text-[9px] text-muted-foreground/30">|</span>
                        <button
                          onClick={() => setScenePromptsSelected(new Set())}
                          className="text-[9px] text-cyan-400 hover:text-cyan-300 transition-colors"
                        >
                          None
                        </button>
                      </div>
                    </div>

                    {/* DIR checkboxes */}
                    <div className="max-h-48 overflow-y-auto space-y-1 pr-1 scrollbar-thin">
                      {dirBlocks.map((d) => (
                        <label
                          key={d.index}
                          className="flex items-start gap-2 cursor-pointer hover:bg-cyan-500/10 rounded px-1.5 py-1 transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={scenePromptsSelected.has(d.index)}
                            onChange={(e) => {
                              const next = new Set(scenePromptsSelected);
                              if (e.target.checked) next.add(d.index); else next.delete(d.index);
                              setScenePromptsSelected(next);
                            }}
                            className="mt-0.5 rounded border-muted-foreground/30 accent-cyan-500"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-medium text-cyan-300/80">Scene {d.index}</span>
                              {d.timestamp && (
                                <span className="text-[9px] text-muted-foreground/40">[{d.timestamp}]</span>
                              )}
                            </div>
                            <div className="text-[9px] text-muted-foreground/60 truncate">
                              {d.text.slice(0, 120)}{d.text.length > 120 ? "..." : ""}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>

                    {/* Generate / Cancel */}
                    {scenePromptsGenerating ? (
                      <div className="space-y-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="w-full text-xs"
                          onClick={handleCancelScenePrompts}
                        >
                          <Square className="w-3 h-3 mr-1.5" /> Cancel
                        </Button>

                        {scenePromptsProgress && (
                          <div className="bg-muted/20 border border-cyan-500/20 rounded p-2 space-y-1.5">
                            <div className="text-[10px] text-cyan-400/90 truncate">
                              {scenePromptsProgress.message}
                            </div>
                            {scenePromptsProgress.phase === "generate" && scenePromptsProgress.percent > 0 && (
                              <>
                                <div className="w-full bg-muted/30 rounded-full h-1.5">
                                  <div
                                    className="bg-cyan-500 h-1.5 rounded-full transition-all duration-500"
                                    style={{ width: `${Math.min(100, scenePromptsProgress.percent)}%` }}
                                  />
                                </div>
                                <div className="flex justify-between text-[9px] text-muted-foreground/60">
                                  <span>{scenePromptsProgress.tokens}/{scenePromptsProgress.maxTokens} tokens</span>
                                  <span>
                                    {scenePromptsProgress.tokensPerSec > 0 && `${scenePromptsProgress.tokensPerSec} tok/s · `}
                                    {scenePromptsProgress.elapsed > 0 && `${Math.round(scenePromptsProgress.elapsed)}s`}
                                    {scenePromptsProgress.eta > 0 && ` · ~${Math.round(scenePromptsProgress.eta)}s left`}
                                  </span>
                                </div>
                              </>
                            )}
                            {scenePromptsProgress.phase !== "generate" && (
                              <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground/50">
                                <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
                                {scenePromptsProgress.phase === "load" && "Loading model..."}
                                {scenePromptsProgress.phase === "parse" && "Parsing prompts..."}
                                {scenePromptsProgress.phase === "cleanup" && "Freeing VRAM..."}
                                {scenePromptsProgress.phase === "done" && "Complete!"}
                                {scenePromptsProgress.phase === "init" && "Initializing..."}
                                {scenePromptsProgress.phase === "log" && "Working..."}
                              </div>
                            )}
                          </div>
                        )}

                        {!scenePromptsProgress && (
                          <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground/50 px-1">
                            <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
                            Starting scene prompt writer...
                          </div>
                        )}
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        className="w-full bg-cyan-600 hover:bg-cyan-700 text-white text-xs"
                        disabled={scenePromptsSelected.size === 0}
                        onClick={handleGenerateScenePrompts}
                      >
                        <Camera className="w-3 h-3 mr-1.5" /> Generate Scene Prompts ({scenePromptsSelected.size})
                      </Button>
                    )}

                    {scenePromptsError && (
                      <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
                        {scenePromptsError}
                      </div>
                    )}

                    {/* Results */}
                    {scenePromptsResult && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-green-400/80 font-medium">
                            ✓ {scenePromptsResult.prompts.length} prompts generated
                          </span>
                          {scenePromptsResult.output_file && (
                            <span className="text-[9px] text-muted-foreground/50 truncate ml-2">
                              Saved to output/
                            </span>
                          )}
                        </div>
                        <div className="max-h-64 overflow-y-auto space-y-2 pr-1 scrollbar-thin">
                          {scenePromptsResult.prompts.map((p) => (
                            <div key={p.index} className="bg-muted/20 border border-cyan-500/10 rounded p-2">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] font-medium text-cyan-300/80">
                                  Scene {p.index}
                                  {p.timestamp && <span className="text-muted-foreground/40 ml-1">[{p.timestamp}]</span>}
                                </span>
                                <button
                                  onClick={() => navigator.clipboard.writeText(p.prompt)}
                                  className="text-[9px] text-cyan-400 hover:text-cyan-300 transition-colors"
                                >
                                  Copy
                                </button>
                              </div>
                              <div className="text-[9px] text-foreground/70 leading-relaxed">
                                {p.prompt}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="text-[9px] text-muted-foreground/40">
                      Generates photorealistic image prompts optimized as LTX2.3 I2V starter frames.
                      Prompts saved to ComfyUI/output/ for easy access.
                    </div>
                  </div>
                );
              })()}
            </div>
          </>
        )}

        {/* ── Export to Director (standalone, visible when script has [DIR]) ── */}
        {onExportToDirector && config.script.includes("[DIR]") && (
          <div className="pt-2 space-y-2">
            {!exportOptionsOpen && !exportingToDirector && (
              <button
                onClick={() => setExportOptionsOpen(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-xs font-medium bg-fuchsia-500/20 text-fuchsia-300 hover:bg-fuchsia-500/30 border border-fuchsia-500/30 transition-colors"
                title="Export script + audio to Director Mode for video generation"
              >
                <Film className="w-4 h-4" /> Export to Director Mode
              </button>
            )}
            {exportingToDirector && (
              <div className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-xs font-medium bg-fuchsia-500/20 text-fuchsia-300 border border-fuchsia-500/30">
                <Loader2 className="w-4 h-4 animate-spin" /> Exporting to Director...
              </div>
            )}
            {exportOptionsOpen && !exportingToDirector && (
              <div className="p-3 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/5 space-y-3">
                <div className="text-xs font-medium text-fuchsia-300">Export Options</div>

                {/* Dialogue toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportIncludeDialogue}
                    onChange={(e) => setExportIncludeDialogue(e.target.checked)}
                    className="rounded border-muted-foreground/30 accent-fuchsia-500"
                  />
                  <span className="text-[11px] text-foreground/80">Include Dialogue Audio</span>
                  {outputUrl && <span className="text-[9px] text-muted-foreground/50 ml-auto">generated WAV</span>}
                  {!outputUrl && <span className="text-[9px] text-yellow-400/60 ml-auto">no audio generated</span>}
                </label>

                {/* Send SFX descriptions to LTX for license-clean foley generation */}
                {config.script.includes("[SFX]") && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={exportSendSfxDescriptions}
                      onChange={(e) => setExportSendSfxDescriptions(e.target.checked)}
                      className="rounded border-muted-foreground/30 accent-violet-500"
                    />
                    <span className="text-[11px] text-foreground/70">Send SFX descriptions to LTX</span>
                    <span className="text-[9px] text-violet-400/60 ml-auto">LTX generates foley</span>
                  </label>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={handleExportToDirector}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded text-[11px] font-medium bg-fuchsia-500/30 text-fuchsia-200 hover:bg-fuchsia-500/40 transition-colors"
                  >
                    <Film className="w-3.5 h-3.5" /> Export
                  </button>
                  <button
                    onClick={() => setExportOptionsOpen(false)}
                    className="px-3 py-2 rounded text-[11px] text-muted-foreground hover:text-foreground bg-muted/20 hover:bg-muted/40 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Help / Format Guide ── */}
        <div className="text-[10px] text-muted-foreground/40 space-y-1 pt-2">
          <p><strong className="text-muted-foreground/60">Script format:</strong> Each line starts with [N]: where N is the character number (1-4). Lines starting with # are annotations (ignored during generation).</p>
          <p><strong className="text-muted-foreground/60">Annotations:</strong> # [SFX] sound effects, # [MUS] music cues, # [NAR] narration, # [DIR] stage directions, preserved for future orchestration.</p>
          <p><strong className="text-muted-foreground/60">AI Script Writer:</strong> Provide a scenario and let Qwen3.5-9B draft a full tagged script with dialogue, SFX, and music cues.</p>
          <p><strong className="text-muted-foreground/60">Voice samples:</strong> Upload a short (5-30s) audio clip of each character speaking clearly.</p>
          <p><strong className="text-muted-foreground/60">DramaBox:</strong> Generates each line individually with expressive TTS via ComfyUI, then stitches them with silence gaps.</p>
        </div>
      </div>
    </div>
  );
}
