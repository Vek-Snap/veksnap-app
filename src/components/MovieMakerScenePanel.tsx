"use client";

import { useMemo } from "react";
import { Clapperboard, RefreshCw, Wand2, Check, AlertTriangle, Loader2, Camera } from "lucide-react";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  SCENE_PERSPECTIVE_OPTIONS,
  type ScenePerspective,
  type MovieMakerSceneMeta,
  type MovieMakerCharacter,
} from "@/lib/types";
import { parseScenes } from "@/lib/movie-script";

interface MovieMakerScenePanelProps {
  script: string;
  characters: MovieMakerCharacter[];
  scenePerspectives: MovieMakerSceneMeta[];
  defaultPerspective: ScenePerspective;
  rewritingIndices: number[];
  disabled?: boolean;
  onChangeDefault: (p: ScenePerspective) => void;
  onApplyDefaultToAll: () => void;
  onChangeSceneMeta: (sceneIdx: number, meta: Partial<MovieMakerSceneMeta>) => void;
  onRewriteScene: (sceneIdx: number) => void;
  onRewriteAllDirty: () => void;
}

const PERSPECTIVE_BY_ID = Object.fromEntries(
  SCENE_PERSPECTIVE_OPTIONS.map((o) => [o.id, o]),
);

function metaFor(
  scenePerspectives: MovieMakerSceneMeta[],
  i: number,
  fallback: ScenePerspective,
): MovieMakerSceneMeta {
  return scenePerspectives[i] ?? { perspective: fallback, targetCharId: "", dirty: false };
}

export default function MovieMakerScenePanel({
  script,
  characters,
  scenePerspectives,
  defaultPerspective,
  rewritingIndices,
  disabled = false,
  onChangeDefault,
  onApplyDefaultToAll,
  onChangeSceneMeta,
  onRewriteScene,
  onRewriteAllDirty,
}: MovieMakerScenePanelProps) {
  const scenes = useMemo(() => parseScenes(script), [script]);
  const rewriting = useMemo(() => new Set(rewritingIndices), [rewritingIndices]);

  const dirtyCount = useMemo(
    () => scenes.reduce((n, _s, i) => {
      const m = metaFor(scenePerspectives, i, defaultPerspective);
      return n + (m.dirty && scenes[i].dirLineNo >= 0 ? 1 : 0);
    }, 0),
    [scenes, scenePerspectives, defaultPerspective],
  );

  if (scenes.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/50 p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Clapperboard className="size-4" /> Scenes
        </div>
        <p className="mt-1">
          Write or paste a script with <code className="rounded bg-muted px-1">[DIR]</code> blocks to
          control each scene&apos;s camera perspective here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card/50">
      {/* Header: title + film-wide default perspective + re-write all */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Clapperboard className="size-4" /> Scenes
          <span className="text-xs text-muted-foreground">({scenes.length})</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Default perspective</span>
          <Select
            value={defaultPerspective}
            onValueChange={(v) => onChangeDefault(v as ScenePerspective)}
            disabled={disabled}
          >
            <SelectTrigger size="sm" className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCENE_PERSPECTIVE_OPTIONS.map((o) => (
                <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onApplyDefaultToAll}
            disabled={disabled}
            title="Set every scene to the default perspective (marks them for re-write)"
          >
            Apply to all
          </Button>
          {dirtyCount > 0 && (
            <Button
              type="button"
              size="sm"
              onClick={onRewriteAllDirty}
              disabled={disabled}
              className="gap-1.5"
            >
              <Wand2 className="size-3.5" /> Re-write all ({dirtyCount})
            </Button>
          )}
        </div>
      </div>

      {/* Scene blocks */}
      <div className="max-h-[320px] space-y-2 overflow-y-auto p-3">
        {scenes.map((scene, i) => {
          const meta = metaFor(scenePerspectives, i, defaultPerspective);
          const opt = PERSPECTIVE_BY_ID[meta.perspective] ?? SCENE_PERSPECTIVE_OPTIONS[0];
          const isRewriting = rewriting.has(i);
          const hasDir = scene.dirLineNo >= 0;
          const isDirty = meta.dirty && hasDir;

          return (
            <div
              key={`${scene.index}-${scene.dirLineNo}`}
              className={`rounded-md border bg-background/40 p-2.5 transition-colors ${
                isRewriting
                  ? "border-l-4 border-l-sky-500 border-border"
                  : isDirty
                    ? "border-l-4 border-l-amber-500 border-border"
                    : hasDir
                      ? "border-l-4 border-l-emerald-600 border-border"
                      : "border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">Scene {scene.index}</span>
                    {scene.timestamp && <span>· {scene.timestamp}</span>}
                    {!hasDir && <span className="italic">· no [DIR] (can&apos;t re-write)</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-foreground/90">
                    {scene.direction || <span className="italic text-muted-foreground">No direction text.</span>}
                  </p>
                </div>

                {/* Status pill */}
                <div className="shrink-0 text-xs">
                  {isRewriting ? (
                    <span className="inline-flex items-center gap-1 text-sky-500">
                      <Loader2 className="size-3.5 animate-spin" /> Re-writing…
                    </span>
                  ) : isDirty ? (
                    <span className="inline-flex items-center gap-1 text-amber-500">
                      <AlertTriangle className="size-3.5" /> Needs re-write
                    </span>
                  ) : hasDir ? (
                    <span className="inline-flex items-center gap-1 text-emerald-500">
                      <Check className="size-3.5" /> Up to date
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Controls */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Camera className="size-3.5 text-muted-foreground" />
                <Select
                  value={meta.perspective}
                  onValueChange={(v) => {
                    const next = v as ScenePerspective;
                    const nextOpt = PERSPECTIVE_BY_ID[next];
                    // Seed a target character for perspectives that need one.
                    const targetCharId = nextOpt?.needsCharacter
                      ? (meta.targetCharId || characters[0]?.id || "")
                      : "";
                    onChangeSceneMeta(i, { perspective: next, targetCharId, dirty: true });
                  }}
                  disabled={disabled || isRewriting}
                >
                  <SelectTrigger size="sm" className="w-[190px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCENE_PERSPECTIVE_OPTIONS.map((o) => (
                      <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {opt.needsCharacter && (
                  <Select
                    value={meta.targetCharId || ""}
                    onValueChange={(v) => onChangeSceneMeta(i, { targetCharId: v, dirty: true })}
                    disabled={disabled || isRewriting || characters.length === 0}
                  >
                    <SelectTrigger size="sm" className="w-[170px]">
                      <SelectValue placeholder={opt.id === "ots" ? "Whose shoulder…" : "Camera character…"} />
                    </SelectTrigger>
                    <SelectContent>
                      {characters.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name || "Unnamed"}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <span className="text-xs text-muted-foreground">{opt.hint}</span>

                {isDirty && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="ml-auto gap-1.5"
                    onClick={() => onRewriteScene(i)}
                    disabled={disabled || isRewriting || (opt.needsCharacter && !meta.targetCharId)}
                    title={opt.needsCharacter && !meta.targetCharId ? "Pick a character first" : "Re-write this scene's direction"}
                  >
                    <RefreshCw className="size-3.5" /> Re-write
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
