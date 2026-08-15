// Timeline Editor store: a tiny dependency-free state container built on the
// same useSyncExternalStore primitive the app already uses (see usePersisted in
// studio-v2). Owns the editable project + transport, with a snapshot-based
// undo/redo history. Singleton so the edit survives studio switches/remounts.

"use client";

import { useSyncExternalStore } from "react";
import {
  TimelineProject,
  TimelineTransport,
  TimelineTrack,
  TimelineClip,
  TimelineAsset,
  TimelineMarker,
  MARKER_COLORS,
  Keyframe,
  KeyframeProp,
  KeyframeMap,
  TRANSPORT_DEFAULTS,
  createEmptyProject,
  timelineId,
} from "./types";
import { defaultParams, type ClipEffect, type EffectType } from "./effects";
import type { TitlePreset } from "./titles";

interface TimelineState {
  project: TimelineProject;
  transport: TimelineTransport;
}

const HISTORY_LIMIT = 100;

class TimelineStore {
  private state: TimelineState;
  private listeners = new Set<() => void>();
  private undoStack: TimelineProject[] = [];
  private redoStack: TimelineProject[] = [];
  // In-memory clip clipboard for Copy / Cut / Paste (not persisted).
  private clipboard: { clips: TimelineClip[]; base: number } | null = null;
  /** Breadcrumb stack while editing nested (combined) timelines. */
  private navStack: { assetId: string; name: string; project: TimelineProject; transport: TimelineTransport; undo: TimelineProject[]; redo: TimelineProject[] }[] = [];

  constructor() {
    this.state = {
      project: createEmptyProject(),
      transport: { ...TRANSPORT_DEFAULTS },
    };
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): TimelineState => this.state;

  private emit() {
    for (const cb of this.listeners) cb();
  }

  /** Replace state (new object identity so subscribers re-render). */
  private set(next: Partial<TimelineState>) {
    this.state = { ...this.state, ...next };
    this.emit();
  }

  /** Push the current project onto the undo stack before a structural edit. */
  private pushHistory() {
    this.undoStack.push(this.state.project);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  // ── Transport (no history; ephemeral playback state) ──
  setPlayhead = (t: number) => this.set({ transport: { ...this.state.transport, playhead: Math.max(0, t) } });
  setPlaying = (isPlaying: boolean) => this.set({ transport: { ...this.state.transport, isPlaying } });
  setZoom = (pxPerSecond: number) => this.set({ transport: { ...this.state.transport, pxPerSecond: Math.max(8, Math.min(400, pxPerSecond)) } });
  setLoop = (loop: boolean) => this.set({ transport: { ...this.state.transport, loop } });
  selectClip = (selectedClipId: string | null) =>
    this.set({ transport: { ...this.state.transport, selectedClipId, selectedClipIds: selectedClipId ? [selectedClipId] : [] } });

  /** Replace the whole multi-selection (e.g. timeline "Select All" via Ctrl+A). */
  selectClips = (ids: string[]) =>
    this.set({ transport: { ...this.state.transport, selectedClipIds: ids, selectedClipId: ids[ids.length - 1] ?? null } });

  /** Shift-click: toggle a clip in the multi-selection (primary = last clicked). */
  toggleSelectClip = (clipId: string) => {
    const cur = this.state.transport.selectedClipIds ?? [];
    const next = cur.includes(clipId) ? cur.filter((id) => id !== clipId) : [...cur, clipId];
    this.set({ transport: { ...this.state.transport, selectedClipIds: next, selectedClipId: next[next.length - 1] ?? null } });
  };

  getNav = () => this.navStack.map((n) => ({ assetId: n.assetId, name: n.name }));

  /**
   * Combine the given clips into a single "Combined Clip" asset (nested timeline).
   * The originals are lifted into a nested project (re-based to 0) and replaced on
   * the parent timeline by one video + one audio clip referencing the new asset.
   */
  combineClips = (clipIds: string[], name?: string) => {
    const proj = this.state.project;
    const picked = proj.clips.filter((c) => clipIds.includes(c.id));
    if (picked.length < 2) return;

    const minStart = Math.min(...picked.map((c) => c.start));
    const maxEnd = Math.max(...picked.map((c) => c.start + c.duration));
    const dur = maxEnd - minStart;

    // Clone the parent's track layout for the nested project (fresh ids).
    const trackMap = new Map<string, string>();
    const nestedTracks: TimelineTrack[] = proj.tracks.map((t) => {
      const id = timelineId("trk");
      trackMap.set(t.id, id);
      return { ...t, id };
    });
    // Re-base picked clips to nested time and remap their tracks.
    const nestedClips: TimelineClip[] = picked.map((c) => ({
      ...c,
      id: timelineId("clip"),
      trackId: trackMap.get(c.trackId) ?? c.trackId,
      start: c.start - minStart,
    }));
    // Carry over the assets the nested clips reference.
    const usedAssetIds = new Set(nestedClips.map((c) => c.assetId).filter(Boolean));
    const nestedAssets = proj.assets.filter((a) => usedAssetIds.has(a.id));

    const nested: TimelineProject = {
      id: timelineId("proj"),
      name: name ?? "Combined Clip",
      fps: proj.fps,
      width: proj.width,
      height: proj.height,
      tracks: nestedTracks,
      clips: nestedClips,
      assets: nestedAssets,
    };

    const hasVideo = picked.some((c) => proj.tracks.find((t) => t.id === c.trackId)?.kind !== "audio");
    const hasAudio = picked.some((c) => proj.tracks.find((t) => t.id === c.trackId)?.kind === "audio");

    const combinedAsset: TimelineAsset = {
      id: timelineId("asset"),
      kind: "combined",
      name: nested.name,
      src: "",
      duration: dur,
      nested,
    };

    const videoTrack = proj.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0];
    const audioTrack = proj.tracks.filter((t) => t.kind === "audio").sort((a, b) => a.index - b.index)[0];
    const linkId = hasVideo && hasAudio ? timelineId("link") : undefined;
    const newClips: TimelineClip[] = [];
    if (hasVideo && videoTrack) {
      newClips.push({ id: timelineId("clip"), assetId: combinedAsset.id, trackId: videoTrack.id, start: minStart, duration: dur, trimIn: 0, trimOut: dur, linkId });
    }
    if (hasAudio && audioTrack) {
      newClips.push({ id: timelineId("clip"), assetId: combinedAsset.id, trackId: audioTrack.id, start: minStart, duration: dur, trimIn: 0, trimOut: dur, linkId });
    }
    if (newClips.length === 0) return;

    this.pushHistory();
    const remaining = proj.clips.filter((c) => !clipIds.includes(c.id));
    const primary = newClips[0].id;
    this.set({
      project: { ...proj, assets: [...proj.assets, combinedAsset], clips: [...remaining, ...newClips] },
      transport: { ...this.state.transport, selectedClipId: primary, selectedClipIds: [primary] },
    });
  };

  /** Rename a combined asset (and its placeholder clips' label source). */
  renameAsset = (assetId: string, name: string) => {
    this.pushHistory();
    this.set({ project: { ...this.state.project, assets: this.state.project.assets.map((a) => (a.id === assetId ? { ...a, name } : a)) } });
  };

  /**
   * Remove one or more assets from the media pool, along with any timeline clips
   * that reference them (and those clips' linked A/V partners). Undoable.
   */
  removeAssets = (assetIds: string[]) => {
    const ids = new Set(assetIds);
    if (!ids.size) return;
    const p = this.state.project;
    const doomed = new Set<string>();
    for (const c of p.clips) if (ids.has(c.assetId)) doomed.add(c.id);
    // Pull in linked partners so an A/V pair never half-survives.
    const linkIds = new Set<string>();
    for (const c of p.clips) if (doomed.has(c.id) && c.linkId) linkIds.add(c.linkId);
    for (const c of p.clips) if (c.linkId && linkIds.has(c.linkId)) doomed.add(c.id);
    this.pushHistory();
    const t = this.state.transport;
    this.set({
      project: {
        ...p,
        assets: p.assets.filter((a) => !ids.has(a.id)),
        clips: p.clips.filter((c) => !doomed.has(c.id)),
      },
      transport: {
        ...t,
        selectedClipId: doomed.has(t.selectedClipId ?? "") ? null : t.selectedClipId,
        selectedClipIds: (t.selectedClipIds ?? []).filter((sid) => !doomed.has(sid)),
      },
    });
  };

  /**
   * Re-point moved/offline media to new absolute paths (Relink). Rebuilds the
   * range-server `src` (and image thumbs) so preview/scrub/export work again.
   * Undoable.
   */
  relinkAssets = (entries: { assetId: string; filePath: string }[]) => {
    if (!entries.length) return;
    const map = new Map(entries.map((e) => [e.assetId, e.filePath]));
    this.pushHistory();
    const p = this.state.project;
    this.set({
      project: {
        ...p,
        assets: p.assets.map((a) => {
          const np = map.get(a.id);
          if (!np) return a;
          const src = `/api/timeline-media?path=${encodeURIComponent(np)}`;
          return { ...a, filePath: np, src, thumb: a.kind === "image" ? src : a.thumb };
        }),
      },
    });
  };

  // ── Media Pool groups ("bins") ──
  addGroup = (name = "New Group"): string => {
    this.pushHistory();
    const group = { id: timelineId("grp"), name };
    this.set({ project: { ...this.state.project, groups: [...(this.state.project.groups ?? []), group] } });
    return group.id;
  };

  renameGroup = (groupId: string, name: string) => {
    this.pushHistory();
    this.set({ project: { ...this.state.project, groups: (this.state.project.groups ?? []).map((g) => (g.id === groupId ? { ...g, name } : g)) } });
  };

  /** Delete a group; its assets fall back to Master (groupId = null). */
  deleteGroup = (groupId: string) => {
    this.pushHistory();
    this.set({
      project: {
        ...this.state.project,
        groups: (this.state.project.groups ?? []).filter((g) => g.id !== groupId),
        assets: this.state.project.assets.map((a) => (a.groupId === groupId ? { ...a, groupId: null } : a)),
      },
    });
  };

  /** Move an asset (and its linked audio companion) into a group (null = Master). */
  setAssetGroup = (assetId: string, groupId: string | null) => {
    this.pushHistory();
    const asset = this.state.project.assets.find((a) => a.id === assetId);
    const linkedId = asset?.linkedAudioAssetId;
    this.set({
      project: {
        ...this.state.project,
        assets: this.state.project.assets.map((a) =>
          a.id === assetId || (linkedId && a.id === linkedId) ? { ...a, groupId } : a,
        ),
      },
    });
  };

  /** Enter a combined clip's nested timeline for editing (breadcrumb push). */
  enterCombined = (assetId: string) => {
    const asset = this.state.project.assets.find((a) => a.id === assetId);
    if (!asset?.nested) return;
    this.navStack.push({
      assetId,
      name: asset.name,
      project: this.state.project,
      transport: this.state.transport,
      undo: this.undoStack,
      redo: this.redoStack,
    });
    this.undoStack = [];
    this.redoStack = [];
    this.set({
      project: JSON.parse(JSON.stringify(asset.nested)) as TimelineProject,
      transport: { ...TRANSPORT_DEFAULTS },
    });
  };

  /** Exit the current nested timeline, writing edits back into the parent asset. */
  exitCombined = () => {
    const frame = this.navStack.pop();
    if (!frame) return;
    const edited = this.state.project;
    const dur = edited.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    const parent: TimelineProject = {
      ...frame.project,
      assets: frame.project.assets.map((a) => (a.id === frame.assetId ? { ...a, nested: edited, duration: dur } : a)),
      // Keep the placeholder clips' duration in sync with the edited nested length.
      clips: frame.project.clips.map((c) => {
        const a = frame.project.assets.find((x) => x.id === c.assetId);
        return a?.id === frame.assetId ? { ...c, duration: dur, trimOut: dur } : c;
      }),
    };
    this.undoStack = frame.undo;
    this.redoStack = frame.redo;
    this.set({ project: parent, transport: frame.transport });
  };

  // ── Project mutations (history-tracked) ──
  replaceProject = (project: TimelineProject) => {
    this.pushHistory();
    this.set({ project });
  };

  /** Load a project from disk/JSON: replace state and reset history + transport. */
  loadProject = (project: TimelineProject) => {
    this.undoStack = [];
    this.redoStack = [];
    this.set({ project, transport: { ...TRANSPORT_DEFAULTS } });
  };

  /** Clear the timeline back to a blank project (page-scoped "Clear Timeline"). */
  newProject = () => {
    this.loadProject(createEmptyProject());
  };

  /**
   * Add a Title/text clip. Titles are no longer a dedicated track kind, they
   * ride on an ordinary VIDEO track (the topmost, so they composite on top),
   * creating one only if the project somehow has no video track.
   */
  addTextClip = (start: number, text = "Title", duration = 4, titlePreset?: TitlePreset) => {
    this.pushHistory();
    let tracks = this.state.project.tracks;
    let videoTrack = [...tracks].filter((t) => t.kind === "video").sort((a, b) => b.index - a.index)[0];
    if (!videoTrack) {
      const maxIndex = tracks.reduce((m, t) => Math.max(m, t.index), -1);
      videoTrack = { id: timelineId("trk"), kind: "video", name: "V1", index: maxIndex + 1, muted: false, locked: false };
      tracks = [videoTrack, ...tracks];
    }
    const clip: TimelineClip = {
      id: timelineId("clip"),
      assetId: "",
      trackId: videoTrack.id,
      start: Math.max(0, start),
      duration,
      trimIn: 0,
      trimOut: duration,
      text,
      titlePreset,
      opacity: 100,
      scale: 100,
      posX: 0,
      posY: 0,
      rotation: 0,
    };
    this.set({
      project: { ...this.state.project, tracks, clips: [...this.state.project.clips, clip] },
      transport: { ...this.state.transport, selectedClipId: clip.id, selectedClipIds: [clip.id] },
    });
  };

  /**
   * Add an ADJUSTMENT LAYER at `start`: a no-asset clip on the TOPMOST video
   * track whose effects apply to the composite of everything below it (the
   * "adjustment clip" pattern). Seeded with a Glitch effect so it does something
   * out of the box; the user adds/removes effects in Component Control. Creates a
   * video track only if the project somehow has none. Returns the new clip id.
   */
  addAdjustmentClip = (start: number, duration = 2, seed: EffectType | null = "glitch"): string => {
    this.pushHistory();
    let tracks = this.state.project.tracks;
    let videoTrack = [...tracks].filter((t) => t.kind === "video").sort((a, b) => b.index - a.index)[0];
    if (!videoTrack) {
      const maxIndex = tracks.reduce((m, t) => Math.max(m, t.index), -1);
      videoTrack = { id: timelineId("trk"), kind: "video", name: "V1", index: maxIndex + 1, muted: false, locked: false };
      tracks = [videoTrack, ...tracks];
    }
    const effects: ClipEffect[] = seed
      ? [{ id: timelineId("fx"), type: seed, enabled: true, params: defaultParams(seed) }]
      : [];
    const clip: TimelineClip = {
      id: timelineId("clip"),
      assetId: "",
      trackId: videoTrack.id,
      start: Math.max(0, start),
      duration,
      trimIn: 0,
      trimOut: duration,
      isAdjustment: true,
      effects,
      opacity: 100,
    };
    this.set({
      project: { ...this.state.project, tracks, clips: [...this.state.project.clips, clip] },
      transport: { ...this.state.transport, selectedClipId: clip.id, selectedClipIds: [clip.id] },
    });
    return clip.id;
  };

  /**
   * Cross-dissolve clip B from the previous abutting clip on the same track.
   * Shifts B left by `duration` so it overlaps A, then fades B in over A
   * (true dissolve). For audio tracks, A also fades out for even loudness.
   * Applies to B's linked partner (A/V pair) when present.
   */
  addCrossDissolve = (clipBId: string, duration = 1) => {
    const clips = this.state.project.clips;
    const root = clips.find((c) => c.id === clipBId);
    if (!root) return;
    const targets = root.linkId ? clips.filter((c) => c.linkId === root.linkId) : [root];
    const updates = new Map<string, Partial<TimelineClip>>();
    let applied = false;

    for (const bx of targets) {
      const a = clips
        .filter((c) => c.trackId === bx.trackId && c.id !== bx.id && c.start < bx.start)
        .sort((p, q) => q.start - p.start)
        .find((cand) => Math.abs(cand.start + cand.duration - bx.start) < 0.05);
      if (!a) continue;
      const d = Math.max(0.1, Math.min(duration, a.duration * 0.9, bx.duration * 0.9));
      updates.set(bx.id, { start: Math.max(0, bx.start - d), crossfadeFromPrev: d });
      const tr = this.state.project.tracks.find((t) => t.id === bx.trackId);
      if (tr?.kind === "audio") updates.set(a.id, { ...(updates.get(a.id) ?? {}), fadeOut: d });
      applied = true;
    }
    if (!applied) return;
    this.pushHistory();
    this.set({
      project: {
        ...this.state.project,
        clips: clips.map((c) => (updates.has(c.id) ? { ...c, ...updates.get(c.id) } : c)),
      },
    });
  };

  /** Remove a clip's cross-dissolve, shifting it back to where it abutted. */
  removeTransition = (clipId: string) => {
    const root = this.state.project.clips.find((c) => c.id === clipId);
    if (!root) return;
    const ids = root.linkId
      ? this.state.project.clips.filter((c) => c.linkId === root.linkId).map((c) => c.id)
      : [clipId];
    this.pushHistory();
    this.set({
      project: {
        ...this.state.project,
        clips: this.state.project.clips.map((c) => {
          if (!ids.includes(c.id) || !c.crossfadeFromPrev) return c;
          return { ...c, start: c.start + c.crossfadeFromPrev, crossfadeFromPrev: undefined };
        }),
      },
    });
  };

  addAsset = (asset: TimelineAsset) => {
    this.pushHistory();
    this.set({ project: { ...this.state.project, assets: [...this.state.project.assets, asset] } });
  };

  addClip = (clip: TimelineClip) => {
    this.pushHistory();
    this.set({ project: { ...this.state.project, clips: [...this.state.project.clips, clip] } });
  };

  /** Add several clips in one history step (e.g. a linked video + audio pair). */
  addClips = (clips: TimelineClip[]) => {
    if (clips.length === 0) return;
    this.pushHistory();
    this.set({ project: { ...this.state.project, clips: [...this.state.project.clips, ...clips] } });
  };

  /** Remove the link from a clip and all clips that share its linkId. */
  unlinkClip = (id: string) => {
    const clip = this.state.project.clips.find((c) => c.id === id);
    if (!clip?.linkId) return;
    this.pushHistory();
    const linkId = clip.linkId;
    this.set({
      project: {
        ...this.state.project,
        clips: this.state.project.clips.map((c) => (c.linkId === linkId ? { ...c, linkId: undefined } : c)),
      },
    });
  };

  /** Link the given clips (>=2) under a shared new linkId so they move together. */
  linkClips = (ids: string[]) => {
    const unique = Array.from(new Set(ids));
    if (unique.length < 2) return;
    this.pushHistory();
    const linkId = timelineId("link");
    this.set({
      project: {
        ...this.state.project,
        clips: this.state.project.clips.map((c) => (unique.includes(c.id) ? { ...c, linkId } : c)),
      },
    });
  };

  /**
   * Re-link a single (currently unlinked) clip to its most-overlapping
   * opposite-kind clip: the natural way to restore a broken A/V link when the
   * user re-checks "Link" without a multi-selection.
   */
  relinkClip = (id: string) => {
    const p = this.state.project;
    const clip = p.clips.find((c) => c.id === id);
    if (!clip || clip.linkId) return;
    const track = p.tracks.find((t) => t.id === clip.trackId);
    if (!track || track.kind === "text") return;
    const oppositeKind = track.kind === "video" ? "audio" : "video";
    const oppTrackIds = new Set(p.tracks.filter((t) => t.kind === oppositeKind).map((t) => t.id));
    let best: { cid: string; overlap: number } | null = null;
    for (const c of p.clips) {
      if (c.id === id || c.linkId || !oppTrackIds.has(c.trackId)) continue;
      const overlap = Math.min(clip.start + clip.duration, c.start + c.duration) - Math.max(clip.start, c.start);
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { cid: c.id, overlap };
    }
    if (best) this.linkClips([id, best.cid]);
  };

  /** Delete a clip (and its linked partners) and close the gap on each affected track. */
  rippleDelete = (id: string) => {
    const clip = this.state.project.clips.find((c) => c.id === id);
    if (!clip) return;
    this.pushHistory();
    const victims = this.state.project.clips.filter((c) => c.id === id || (clip.linkId && c.linkId === clip.linkId));
    let clips = this.state.project.clips.filter((c) => !victims.includes(c));
    for (const v of victims) {
      clips = clips.map((c) => (c.trackId === v.trackId && c.start >= v.start ? { ...c, start: Math.max(0, c.start - v.duration) } : c));
    }
    const t = this.state.transport;
    const victimIds = new Set(victims.map((v) => v.id));
    this.set({
      project: { ...this.state.project, clips },
      transport: {
        ...t,
        selectedClipId: victimIds.has(t.selectedClipId ?? "") ? null : t.selectedClipId,
        selectedClipIds: (t.selectedClipIds ?? []).filter((sid) => !victimIds.has(sid)),
      },
    });
  };

  updateClip = (id: string, patch: Partial<TimelineClip>) => {
    this.pushHistory();
    this.setClip(id, patch);
  };

  /**
   * Retime a clip (playback-rate). The consumed source region (`trimOut-trimIn`)
   * is held fixed; the visible timeline `duration` = sourceSpan / speed. Linked
   * partners (A/V pairs) retime in lock-step. Live (no per-tick history) so a
   * slider drag stays smooth: matches the pitch/volume control pattern.
   */
  setClipSpeed = (id: string, speed: number) => {
    const clip = this.state.project.clips.find((c) => c.id === id);
    if (!clip) return;
    const sp = Math.max(0.25, Math.min(4, speed));
    const retime = (c: TimelineClip): number => Math.max(0.05, (c.trimOut - c.trimIn) / sp);
    this.setClip(id, { speed: sp, duration: retime(clip) });
    if (clip.linkId) {
      for (const p of this.state.project.clips) {
        if (p.linkId === clip.linkId && p.id !== id) this.setClip(p.id, { speed: sp, duration: retime(p) });
      }
    }
  };

  addEffect = (clipId: string, type: EffectType) => {
    const clip = this.state.project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const effect: ClipEffect = { id: timelineId("fx"), type, enabled: true, params: defaultParams(type) };
    this.updateClip(clipId, { effects: [...(clip.effects ?? []), effect] });
  };

  removeEffect = (clipId: string, effectId: string) => {
    const clip = this.state.project.clips.find((c) => c.id === clipId);
    if (!clip?.effects) return;
    this.updateClip(clipId, { effects: clip.effects.filter((e) => e.id !== effectId) });
  };

  toggleEffect = (clipId: string, effectId: string) => {
    const clip = this.state.project.clips.find((c) => c.id === clipId);
    if (!clip?.effects) return;
    this.updateClip(clipId, {
      effects: clip.effects.map((e) => (e.id === effectId ? { ...e, enabled: !e.enabled } : e)),
    });
  };

  /** Live effect-param update WITHOUT a history checkpoint (slider drag). */
  setEffectParam = (clipId: string, effectId: string, key: string, value: number) => {
    const clip = this.state.project.clips.find((c) => c.id === clipId);
    if (!clip?.effects) return;
    this.setClip(clipId, {
      effects: clip.effects.map((e) => (e.id === effectId ? { ...e, params: { ...e.params, [key]: value } } : e)),
    });
  };

  /** Capture one undo checkpoint at the start of a drag/trim interaction. */
  beginInteraction = () => this.pushHistory();

  /** Live clip update WITHOUT a history checkpoint (use during a drag; pair with beginInteraction). */
  setClip = (id: string, patch: Partial<TimelineClip>) => {
    this.set({
      project: {
        ...this.state.project,
        clips: this.state.project.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    });
  };

  /**
   * Replace a clip's underlying media in place (used by the AI Processing Queue:
   * e.g. an image clip becomes its AI-refined version). Adds the new asset,
   * points the clip at it, and resets the clip's trim to the new full duration
   * while keeping its timeline position. One undo step.
   */
  replaceClipAsset = (clipId: string, asset: TimelineAsset) => {
    const clip = this.state.project.clips.find((c) => c.id === clipId);
    if (!clip) return;
    this.pushHistory();
    this.set({
      project: {
        ...this.state.project,
        assets: [...this.state.project.assets, asset],
        clips: this.state.project.clips.map((c) =>
          c.id === clipId
            ? { ...c, assetId: asset.id, trimIn: 0, trimOut: asset.duration, duration: asset.duration }
            : c,
        ),
      },
    });
  };

  /**
   * Add a placeholder AUDIO-generation clip (no asset yet) on an audio track.
   * It reserves a short blank span the user can position; its Component Control
   * exposes the DramaBox script editor, and the AI Processing Queue later swaps
   * in the generated audio (see resolveGeneratedAudio). Creates an audio track
   * only if the project somehow has none. Returns the new clip id.
   */
  addPendingAudioClip = (start: number, trackId?: string, duration = 2): string => {
    this.pushHistory();
    let tracks = this.state.project.tracks;
    let track = trackId
      ? tracks.find((t) => t.id === trackId && t.kind === "audio")
      : [...tracks].filter((t) => t.kind === "audio").sort((a, b) => a.index - b.index)[0];
    if (!track) {
      const maxIndex = tracks.reduce((m, t) => Math.max(m, t.index), -1);
      track = { id: timelineId("trk"), kind: "audio", name: "A1", index: maxIndex + 1, muted: false, locked: false };
      tracks = [...tracks, track];
    }
    const clip: TimelineClip = {
      id: timelineId("clip"),
      assetId: "",
      trackId: track.id,
      start: Math.max(0, start),
      duration,
      trimIn: 0,
      trimOut: duration,
      pendingAudioGen: { workflow: "dramabox", script: "", useSavedConfig: false },
    };
    this.set({
      project: { ...this.state.project, tracks, clips: [...this.state.project.clips, clip] },
      transport: { ...this.state.transport, selectedClipId: clip.id, selectedClipIds: [clip.id] },
    });
    return clip.id;
  };

  /** Patch a placeholder clip's pending-audio-generation request (no history, live edit). */
  updatePendingAudioGen = (clipId: string, patch: Partial<NonNullable<TimelineClip["pendingAudioGen"]>>) => {
    const clip = this.state.project.clips.find((c) => c.id === clipId);
    if (!clip?.pendingAudioGen) return;
    this.setClip(clipId, { pendingAudioGen: { ...clip.pendingAudioGen, ...patch } });
  };

  /**
   * Resolve a completed AI audio generation for a placeholder clip. If placing
   * the real audio (at the placeholder's start, for its real duration) would
   * OVERLAP another clip on that track, the placeholder is removed and the asset
   * is parked in the Media Pool (Master bin) instead, so an unknown-length
   * result never clobbers existing audio. The user drags it in from the bin.
   * Otherwise the placeholder becomes the real clip in place (start kept).
   * Returns what happened so the caller can notify the user. One undo step.
   */
  resolveGeneratedAudio = (clipId: string, asset: TimelineAsset): "placed" | "binned" | "missing" => {
    const clip = this.state.project.clips.find((c) => c.id === clipId);
    if (!clip) {
      // Placeholder was deleted while generating, just deposit the asset in the bin.
      this.addAsset({ ...asset, groupId: null });
      return "missing";
    }
    const overlaps = this.state.project.clips.some(
      (c) => c.id !== clipId && c.trackId === clip.trackId &&
        c.start < clip.start + asset.duration && c.start + c.duration > clip.start,
    );
    this.pushHistory();
    if (overlaps) {
      this.set({
        project: {
          ...this.state.project,
          assets: [...this.state.project.assets, { ...asset, groupId: null }],
          clips: this.state.project.clips.filter((c) => c.id !== clipId),
        },
        transport: clip.id === this.state.transport.selectedClipId
          ? { ...this.state.transport, selectedClipId: null, selectedClipIds: [] }
          : this.state.transport,
      });
      return "binned";
    }
    this.set({
      project: {
        ...this.state.project,
        assets: [...this.state.project.assets, asset],
        clips: this.state.project.clips.map((c) =>
          c.id === clipId
            ? { ...c, assetId: asset.id, pendingAudioGen: undefined, trimIn: 0, trimOut: asset.duration, duration: asset.duration }
            : c,
        ),
      },
    });
    return "placed";
  };

  /**
   * Split a clip at an absolute timeline time, preserving source trim offsets.
   * LINK-AWARE: when the clip is part of a linked group (e.g. a video + its
   * extracted audio), every linked member that spans the cut point is split at
   * the same time so the pair stays in sync. The left halves keep the original
   * linkId; the right halves are re-linked under a fresh shared linkId so both
   * sides remain independently linked pairs.
   */
  splitClip = (id: string, atTime: number) => {
    const clip = this.state.project.clips.find((c) => c.id === id);
    if (!clip) return;
    const min = 0.05;
    const group = clip.linkId
      ? this.state.project.clips.filter((c) => c.linkId === clip.linkId)
      : [clip];
    const splittable = group.filter((c) => atTime > c.start + min && atTime < c.start + c.duration - min);
    if (splittable.length === 0) return;
    this.pushHistory();
    const rightLinkId = clip.linkId ? timelineId("link") : undefined;
    const splitIds = new Set(splittable.map((c) => c.id));
    this.set({
      project: {
        ...this.state.project,
        clips: this.state.project.clips.flatMap((c) => {
          if (!splitIds.has(c.id)) return [c];
          const leftDur = atTime - c.start;
          const sp = c.speed && c.speed > 0 ? c.speed : 1; // source consumed = timeline * speed
          const cut = c.trimIn + leftDur * sp;
          const left: TimelineClip = { ...c, duration: leftDur, trimOut: cut };
          const right: TimelineClip = {
            ...c,
            id: timelineId("clip"),
            start: atTime,
            duration: c.duration - leftDur,
            trimIn: cut,
            linkId: rightLinkId,
          };
          return [left, right];
        }),
      },
    });
  };

  /** Expand a set of clip ids to include every linked-group partner. */
  private expandLinked(ids: Iterable<string>): Set<string> {
    const set = new Set(ids);
    const p = this.state.project;
    for (const c of p.clips) {
      if (c.linkId && set.has(c.id)) {
        for (const m of p.clips) if (m.linkId === c.linkId) set.add(m.id);
      }
    }
    return set;
  }

  private cloneClipFields(c: TimelineClip): Pick<TimelineClip, "keyframes" | "effects"> {
    return {
      keyframes: c.keyframes ? structuredClone(c.keyframes) : undefined,
      effects: c.effects ? structuredClone(c.effects) : undefined,
    };
  }

  // ── Clipboard: Copy / Cut / Paste ──
  hasClipboard = () => !!this.clipboard && this.clipboard.clips.length > 0;

  /** Copy clips (auto-including linked partners) to the in-memory clipboard. */
  copyClips = (ids: string[]) => {
    const set = this.expandLinked(ids);
    const picked = this.state.project.clips.filter((c) => set.has(c.id));
    if (picked.length === 0) { this.clipboard = null; return; }
    const base = Math.min(...picked.map((c) => c.start));
    this.clipboard = { clips: picked.map((c) => ({ ...c, ...this.cloneClipFields(c) })), base };
  };

  /** Copy then delete the clips (one history step for the delete). */
  cutClips = (ids: string[]) => {
    this.copyClips(ids);
    if (!this.clipboard) return;
    const rm = new Set(this.clipboard.clips.map((c) => c.id));
    this.pushHistory();
    const t = this.state.transport;
    this.set({
      project: { ...this.state.project, clips: this.state.project.clips.filter((c) => !rm.has(c.id)) },
      transport: rm.has(t.selectedClipId ?? "") ? { ...t, selectedClipId: null, selectedClipIds: [] } : t,
    });
  };

  /**
   * Paste the clipboard so its earliest clip lands at atTime, keeping each clip's
   * relative offset and track (fresh ids + remapped linkIds). Selects the pasted
   * clips. Resolves overlaps unless stacking is on. One history step.
   */
  pasteClips = (atTime: number) => {
    if (!this.clipboard || this.clipboard.clips.length === 0) return;
    const p = this.state.project;
    const base = this.clipboard.base;
    const linkMap = new Map<string, string>();
    const newClips: TimelineClip[] = this.clipboard.clips.map((c) => {
      let linkId = c.linkId;
      if (linkId) { if (!linkMap.has(linkId)) linkMap.set(linkId, timelineId("link")); linkId = linkMap.get(linkId); }
      const trackId = p.tracks.some((t) => t.id === c.trackId) ? c.trackId : (p.tracks[0]?.id ?? c.trackId);
      return { ...c, ...this.cloneClipFields(c), id: timelineId("clip"), start: Math.max(0, atTime + (c.start - base)), trackId, linkId };
    });
    this.pushHistory();
    this.set({
      project: { ...p, clips: [...p.clips, ...newClips] },
      transport: { ...this.state.transport, selectedClipId: newClips[0].id, selectedClipIds: newClips.map((c) => c.id) },
    });
    if (!(p.allowStacking ?? false)) for (const c of newClips) this.resolveTrackOverlaps(c.id);
  };

  /**
   * Duplicate clips (auto-including linked partners), placing the copies right
   * after the group's end on the same tracks. Selects the copies. One history step.
   */
  duplicateClips = (ids: string[]) => {
    const set = this.expandLinked(ids);
    const p = this.state.project;
    const picked = p.clips.filter((c) => set.has(c.id));
    if (picked.length === 0) return;
    const minStart = Math.min(...picked.map((c) => c.start));
    const maxEnd = Math.max(...picked.map((c) => c.start + c.duration));
    const offset = maxEnd - minStart;
    const linkMap = new Map<string, string>();
    const copies: TimelineClip[] = picked.map((c) => {
      let linkId = c.linkId;
      if (linkId) { if (!linkMap.has(linkId)) linkMap.set(linkId, timelineId("link")); linkId = linkMap.get(linkId); }
      return { ...c, ...this.cloneClipFields(c), id: timelineId("clip"), start: c.start + offset, linkId };
    });
    this.pushHistory();
    this.set({
      project: { ...p, clips: [...p.clips, ...copies] },
      transport: { ...this.state.transport, selectedClipId: copies[0].id, selectedClipIds: copies.map((c) => c.id) },
    });
    if (!(p.allowStacking ?? false)) for (const c of copies) this.resolveTrackOverlaps(c.id);
  };

  /**
   * Nudge selected clips (auto-including linked partners) by delta seconds,
   * clamped so the earliest selected clip can't cross 0. One history step.
   * Resolves overlaps unless stacking is on (mirrors drag-move semantics).
   */
  nudgeClips = (ids: string[], delta: number) => {
    const set = this.expandLinked(ids);
    const p = this.state.project;
    const picked = p.clips.filter((c) => set.has(c.id));
    if (picked.length === 0) return;
    const minStart = Math.min(...picked.map((c) => c.start));
    const d = Math.max(delta, -minStart);
    if (d === 0) return;
    this.pushHistory();
    this.set({ project: { ...p, clips: p.clips.map((c) => (set.has(c.id) ? { ...c, start: c.start + d } : c)) } });
    if (!(p.allowStacking ?? false)) for (const c of picked) this.resolveTrackOverlaps(c.id);
  };

  /**
   * Blade ("add edit" / razor-all): split every clip that spans atTime on all
   * UNLOCKED tracks. Link-aware: right halves of a linked group are re-linked
   * under one fresh shared linkId. One history step.
   */
  bladeAllAtPlayhead = (atTime: number) => {
    const p = this.state.project;
    const min = 0.05;
    const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
    const spanning = p.clips.filter((c) => !locked.has(c.trackId) && atTime > c.start + min && atTime < c.start + c.duration - min);
    if (spanning.length === 0) return;
    const splitIds = new Set(spanning.map((c) => c.id));
    const rightLinkByOld = new Map<string, string>();
    this.pushHistory();
    this.set({
      project: {
        ...p,
        clips: p.clips.flatMap((c) => {
          if (!splitIds.has(c.id)) return [c];
          const leftDur = atTime - c.start;
          const sp = c.speed && c.speed > 0 ? c.speed : 1; // source consumed = timeline * speed
          const cut = c.trimIn + leftDur * sp;
          let rlink = c.linkId;
          if (rlink) { if (!rightLinkByOld.has(rlink)) rightLinkByOld.set(rlink, timelineId("link")); rlink = rightLinkByOld.get(rlink); }
          const left: TimelineClip = { ...c, duration: leftDur, trimOut: cut };
          const right: TimelineClip = { ...c, ...this.cloneClipFields(c), id: timelineId("clip"), start: atTime, duration: c.duration - leftDur, trimIn: cut, linkId: rlink };
          return [left, right];
        }),
      },
    });
  };

  /**
   * Swap a clip's underlying source asset while KEEPING its timeline position,
   * keyframes, effects, fades, and (as far as possible) its trim window. Trim is
   * clamped to the new asset's duration. Differs from replaceClipAsset, which
   * resets the trim to the new asset's full duration.
   */
  replaceClipSource = (clipId: string, assetId: string) => {
    const p = this.state.project;
    const clip = p.clips.find((c) => c.id === clipId);
    const asset = p.assets.find((a) => a.id === assetId);
    if (!clip || !asset) return;
    this.pushHistory();
    const isImage = asset.kind === "image";
    const srcDur = isImage ? Infinity : asset.duration;
    const trimIn = Number.isFinite(srcDur) ? Math.min(clip.trimIn, Math.max(0, srcDur - 0.1)) : clip.trimIn;
    const maxDur = Number.isFinite(srcDur) ? Math.max(0.1, srcDur - trimIn) : clip.duration;
    const duration = Math.min(clip.duration, maxDur);
    this.set({
      project: {
        ...p,
        clips: p.clips.map((c) => (c.id === clipId ? { ...c, assetId, trimIn, trimOut: trimIn + duration, duration, speed: 1 } : c)),
      },
    });
  };

  /** Toggle a track's locked state (locked tracks resist edits). No history. */
  toggleTrackLock = (id: string) => {
    this.set({
      project: {
        ...this.state.project,
        tracks: this.state.project.tracks.map((t) => (t.id === id ? { ...t, locked: !t.locked } : t)),
      },
    });
  };

  // ── Markers (ruler notes / sync points) ──

  /**
   * Add a marker at the given time (default: playhead). Cycles the palette by the
   * current marker count so successive markers are visually distinct. Returns the id.
   */
  addMarker = (time: number, name?: string): string => {
    this.pushHistory();
    const existing = this.state.project.markers ?? [];
    const color = MARKER_COLORS[existing.length % MARKER_COLORS.length];
    const marker: TimelineMarker = { id: timelineId("mrk"), time: Math.max(0, time), name, color };
    this.set({ project: { ...this.state.project, markers: [...existing, marker] } });
    return marker.id;
  };

  updateMarker = (id: string, patch: Partial<Omit<TimelineMarker, "id">>) => {
    this.pushHistory();
    this.set({
      project: {
        ...this.state.project,
        markers: (this.state.project.markers ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
      },
    });
  };

  removeMarker = (id: string) => {
    this.pushHistory();
    this.set({
      project: {
        ...this.state.project,
        markers: (this.state.project.markers ?? []).filter((m) => m.id !== id),
      },
    });
  };

  clearMarkers = () => {
    if ((this.state.project.markers ?? []).length === 0) return;
    this.pushHistory();
    this.set({ project: { ...this.state.project, markers: [] } });
  };

  /** Move the playhead to the previous / next marker relative to the current time. */
  jumpToMarker = (dir: "prev" | "next") => {
    const times = (this.state.project.markers ?? []).map((m) => m.time).sort((a, b) => a - b);
    if (times.length === 0) return;
    const cur = this.state.transport.playhead;
    const eps = 1e-3;
    const target = dir === "next"
      ? times.find((t) => t > cur + eps)
      : [...times].reverse().find((t) => t < cur - eps);
    if (target !== undefined) {
      this.set({ transport: { ...this.state.transport, playhead: target, isPlaying: false } });
    }
  };

  /** Internal: replace one property's keyframe list immutably (sorted), pruning empties. */
  private applyKeyframes(id: string, prop: KeyframeProp, fn: (kfs: Keyframe[]) => Keyframe[]) {
    this.set({
      project: {
        ...this.state.project,
        clips: this.state.project.clips.map((c) => {
          if (c.id !== id) return c;
          const cur = c.keyframes?.[prop] ?? [];
          const next = [...fn(cur)].sort((a, b) => a.t - b.t);
          const km: KeyframeMap = { ...(c.keyframes ?? {}) };
          if (next.length === 0) delete km[prop];
          else km[prop] = next;
          return { ...c, keyframes: km };
        }),
      },
    });
  }

  /** Add or replace (within ~20ms) a keyframe at a clip-local time. History-tracked. */
  addKeyframe = (id: string, prop: KeyframeProp, t: number, value: number) => {
    this.pushHistory();
    this.applyKeyframes(id, prop, (kfs) => [...kfs.filter((k) => Math.abs(k.t - t) > 0.02), { t, value }]);
  };

  /** Live keyframe upsert WITHOUT history (use during a slider/drag; pair with beginInteraction). */
  upsertKeyframeNoHistory = (id: string, prop: KeyframeProp, t: number, value: number) => {
    this.applyKeyframes(id, prop, (kfs) => [...kfs.filter((k) => Math.abs(k.t - t) > 0.02), { t, value }]);
  };

  /** Replace the whole keyframe list for a property WITHOUT history (drag in the editor). */
  setClipKeyframes = (id: string, prop: KeyframeProp, kfs: Keyframe[]) => {
    this.applyKeyframes(id, prop, () => kfs);
  };

  removeKeyframe = (id: string, prop: KeyframeProp, index: number) => {
    this.pushHistory();
    this.applyKeyframes(id, prop, (kfs) => kfs.filter((_, i) => i !== index));
  };

  toggleTrackMuted = (id: string) => {
    this.set({
      project: {
        ...this.state.project,
        tracks: this.state.project.tracks.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t)),
      },
    });
  };

  toggleTrackSolo = (id: string) => {
    this.set({
      project: {
        ...this.state.project,
        tracks: this.state.project.tracks.map((t) => (t.id === id ? { ...t, solo: !t.solo } : t)),
      },
    });
  };

  /** Hide/show a track: excluded from preview AND export when hidden. */
  toggleTrackHidden = (id: string) => {
    this.set({
      project: {
        ...this.state.project,
        tracks: this.state.project.tracks.map((t) => (t.id === id ? { ...t, hidden: !t.hidden } : t)),
      },
    });
  };

  /**
   * Add a new video or audio track. Video tracks stack above existing video
   * (below any text track); audio tracks stack below existing audio. Named
   * V{n} / A{n} by count. Returns the new track id.
   */
  addTrack = (kind: "video" | "audio"): string => {
    this.pushHistory();
    const p = this.state.project;
    const n = p.tracks.filter((t) => t.kind === kind).length + 1;
    const id = timelineId("trk");
    let tracks: TimelineTrack[];
    if (kind === "video") {
      const maxVideo = p.tracks.filter((t) => t.kind === "video").reduce((m, t) => Math.max(m, t.index), -1);
      // Bump text tracks up 1 so they stay above the new (topmost) video track.
      tracks = p.tracks.map((t) => (t.kind === "text" ? { ...t, index: t.index + 1 } : t));
      tracks.push({ id, kind: "video", name: `V${n}`, index: maxVideo + 1, muted: false, locked: false });
    } else {
      const minAudio = p.tracks.filter((t) => t.kind === "audio").reduce((m, t) => Math.min(m, t.index), 0);
      tracks = [...p.tracks, { id, kind: "audio", name: `A${n}`, index: minAudio - 1, muted: false, locked: false }];
    }
    this.set({ project: { ...p, tracks } });
    return id;
  };

  /**
   * Remove a track and any clips on it. Refuses to delete the last remaining
   * video or audio track (the editor always needs one of each).
   */
  removeTrack = (id: string) => {
    const p = this.state.project;
    const track = p.tracks.find((t) => t.id === id);
    if (!track) return;
    if (track.kind !== "text" && p.tracks.filter((t) => t.kind === track.kind).length <= 1) return;
    this.pushHistory();
    this.set({
      project: {
        ...p,
        tracks: p.tracks.filter((t) => t.id !== id),
        clips: p.clips.filter((c) => c.trackId !== id),
      },
    });
  };

  /** Set a track's accent color (undefined clears it). */
  setTrackColor = (id: string, color?: string) => {
    this.pushHistory();
    this.set({
      project: {
        ...this.state.project,
        tracks: this.state.project.tracks.map((t) => (t.id === id ? { ...t, color } : t)),
      },
    });
  };

  /** Move a track up/down within its own kind by swapping stack indices. */
  moveTrack = (id: string, dir: "up" | "down") => {
    const p = this.state.project;
    const t = p.tracks.find((x) => x.id === id);
    if (!t) return;
    const sameKind = p.tracks.filter((x) => x.kind === t.kind).sort((a, b) => a.index - b.index);
    const i = sameKind.findIndex((x) => x.id === id);
    const j = dir === "up" ? i + 1 : i - 1; // "up" in the stack = higher index
    if (j < 0 || j >= sameKind.length) return;
    const other = sameKind[j];
    this.pushHistory();
    this.set({
      project: {
        ...p,
        tracks: p.tracks.map((x) =>
          x.id === id ? { ...x, index: other.index } : x.id === other.id ? { ...x, index: t.index } : x,
        ),
      },
    });
  };

  /** Remove all empty tracks, always keeping at least one video and one audio track. */
  deleteEmptyTracks = () => {
    const p = this.state.project;
    const used = new Set(p.clips.map((c) => c.trackId));
    let vCount = p.tracks.filter((t) => t.kind === "video").length;
    let aCount = p.tracks.filter((t) => t.kind === "audio").length;
    const survivors: TimelineTrack[] = [];
    for (const t of p.tracks) {
      const empty = !used.has(t.id);
      if (empty && t.kind === "video" && vCount > 1) { vCount--; continue; }
      if (empty && t.kind === "audio" && aCount > 1) { aCount--; continue; }
      survivors.push(t);
    }
    if (survivors.length === p.tracks.length) return;
    this.pushHistory();
    this.set({ project: { ...p, tracks: survivors } });
  };

  /** Toggle whether clips may overlap on a track (compact stacking). */
  setAllowStacking = (on: boolean) => {
    this.pushHistory();
    this.set({ project: { ...this.state.project, allowStacking: on } });
  };

  /** Raise a clip above all others where video clips overlap ("Bring to Top"). */
  bringClipToTop = (id: string) => {
    const maxZ = this.state.project.clips.reduce((m, c) => Math.max(m, c.z ?? 0), 0);
    this.updateClip(id, { z: maxZ + 1 });
  };

  /**
   * Overwrite mode (allowStacking = false): after a clip is dropped/moved, trim
   * or remove the portions of OTHER clips on the SAME track that the kept clip
   * now overlaps (splitting a clip that fully contains it). No history of its
   * own: call right after the move's checkpointed mutation.
   */
  resolveTrackOverlaps = (keepId: string) => {
    const p = this.state.project;
    const keep = p.clips.find((c) => c.id === keepId);
    if (!keep) return;
    const ks = keep.start;
    const ke = keep.start + keep.duration;
    const eps = 0.02;
    const out: TimelineClip[] = [];
    let changed = false;
    for (const c of p.clips) {
      if (c.id === keepId || c.trackId !== keep.trackId) { out.push(c); continue; }
      const cs = c.start;
      const ce = c.start + c.duration;
      if (ce <= ks + eps || cs >= ke - eps) { out.push(c); continue; }
      const leftPart = ks - cs;
      const rightPart = ce - ke;
      const sp = c.speed && c.speed > 0 ? c.speed : 1; // source consumed = timeline * speed
      changed = true;
      if (leftPart > eps && rightPart > eps) {
        out.push({ ...c, duration: leftPart, trimOut: c.trimIn + leftPart * sp });
        out.push({ ...c, id: timelineId("clip"), start: ke, duration: rightPart, trimIn: c.trimIn + (ke - cs) * sp, linkId: undefined });
      } else if (leftPart > eps) {
        out.push({ ...c, duration: leftPart, trimOut: c.trimIn + leftPart * sp });
      } else if (rightPart > eps) {
        out.push({ ...c, start: ke, duration: rightPart, trimIn: c.trimIn + (ke - cs) * sp });
      } // else fully covered → dropped
    }
    if (!changed) return;
    this.set({ project: { ...p, clips: out } });
  };

  /**
   * After a linked clip is moved to a track that has no mirror across the V/A
   * boundary (e.g. video dragged to V2 when only A1 exists), create the missing
   * opposite-kind track(s) and move the clip's linked partners onto the mirror
   * so a linked pair stays vertically aligned (standard NLE behavior). No own history.
   */
  ensureLinkedMirrors = (movedId: string) => {
    const p0 = this.state.project;
    const moved = p0.clips.find((c) => c.id === movedId);
    if (!moved?.linkId) return;
    const movedTrack = p0.tracks.find((t) => t.id === moved.trackId);
    if (!movedTrack || movedTrack.kind === "text") return;
    const oppKind: "video" | "audio" = movedTrack.kind === "video" ? "audio" : "video";
    const orderSame = (arr: TimelineTrack[]) =>
      [...arr].sort((a, b) => (movedTrack.kind === "video" ? a.index - b.index : b.index - a.index));
    const orderOpp = (arr: TimelineTrack[]) =>
      [...arr].sort((a, b) => (oppKind === "video" ? a.index - b.index : b.index - a.index));
    const pos = orderSame(p0.tracks.filter((t) => t.kind === movedTrack.kind)).findIndex((t) => t.id === moved.trackId);
    if (pos < 0) return;
    let tracks = [...p0.tracks];
    let oppList = orderOpp(tracks.filter((t) => t.kind === oppKind));
    while (oppList.length <= pos) {
      const n = tracks.filter((t) => t.kind === oppKind).length + 1;
      const id = timelineId("trk");
      if (oppKind === "audio") {
        const minAudio = tracks.filter((t) => t.kind === "audio").reduce((m, t) => Math.min(m, t.index), 0);
        tracks.push({ id, kind: "audio", name: `A${n}`, index: minAudio - 1, muted: false, locked: false });
      } else {
        const maxVideo = tracks.filter((t) => t.kind === "video").reduce((m, t) => Math.max(m, t.index), -1);
        tracks = tracks.map((t) => (t.kind === "text" ? { ...t, index: t.index + 1 } : t));
        tracks.push({ id, kind: "video", name: `V${n}`, index: maxVideo + 1, muted: false, locked: false });
      }
      oppList = orderOpp(tracks.filter((t) => t.kind === oppKind));
    }
    const mirror = oppList[pos];
    let partnersMoved = false;
    const clips = p0.clips.map((c) => {
      if (c.linkId === moved.linkId && c.id !== movedId && c.trackId !== mirror.id) {
        partnersMoved = true;
        return { ...c, trackId: mirror.id };
      }
      return c;
    });
    if (tracks.length === p0.tracks.length && !partnersMoved) return;
    this.set({ project: { ...p0, tracks, clips } });
  };

  /** Set a per-track lane height (px), clamped to a sane range. */
  setTrackHeight = (id: string, height: number) => {
    const h = Math.max(32, Math.min(320, Math.round(height)));
    this.set({
      project: {
        ...this.state.project,
        tracks: this.state.project.tracks.map((t) => (t.id === id ? { ...t, height: h } : t)),
      },
    });
  };

  /** Change the project resolution / frame rate at any time (with history). */
  setProjectFormat = (fmt: { width?: number; height?: number; fps?: number }) => {
    this.pushHistory();
    const p = this.state.project;
    this.set({
      project: {
        ...p,
        width: fmt.width != null ? Math.max(2, Math.round(fmt.width)) : p.width,
        height: fmt.height != null ? Math.max(2, Math.round(fmt.height)) : p.height,
        fps: fmt.fps != null ? Math.max(1, fmt.fps) : p.fps,
      },
    });
  };

  removeClip = (id: string) => {
    const clip = this.state.project.clips.find((c) => c.id === id);
    if (!clip) return;
    this.pushHistory();
    // Delete the clip AND any linked partners (an A/V pair is removed together
    // unless the user unlinked it). Ripple delete already did this; plain delete
    // must match so the two halves never diverge.
    const victimIds = new Set(
      this.state.project.clips.filter((c) => c.id === id || (clip.linkId && c.linkId === clip.linkId)).map((c) => c.id),
    );
    const t = this.state.transport;
    this.set({
      project: { ...this.state.project, clips: this.state.project.clips.filter((c) => !victimIds.has(c.id)) },
      transport: {
        ...t,
        selectedClipId: victimIds.has(t.selectedClipId ?? "") ? null : t.selectedClipId,
        selectedClipIds: (t.selectedClipIds ?? []).filter((sid) => !victimIds.has(sid)),
      },
    });
  };

  // ── History ──
  canUndo = () => this.undoStack.length > 0;
  canRedo = () => this.redoStack.length > 0;

  undo = () => {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.state.project);
    this.set({ project: prev });
  };

  redo = () => {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.state.project);
    this.set({ project: next });
  };
}

export const timelineStore = new TimelineStore();

/** React hook: subscribe to the timeline state. */
export function useTimeline(): TimelineState {
  return useSyncExternalStore(timelineStore.subscribe, timelineStore.getSnapshot, timelineStore.getSnapshot);
}
