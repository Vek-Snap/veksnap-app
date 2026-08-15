"use client";

// Keyframe editor: an industry-standard automation panel for the selected clip.
// One row per keyframable property; the graph plots keyframes as draggable points
// connected by linear ramps. Double-click the lane to add a point (lands on the
// current curve); drag a point to retime/revalue it; double-click a point to delete.
// The diamond in the label column adds a keyframe at the playhead.

import { useRef } from "react";
import { Diamond } from "lucide-react";
import { timelineStore } from "@/lib/timeline/store";
import {
  AUDIO_KF_PROPS,
  VIDEO_KF_PROPS,
  KF_PROPS,
  evalClipProp,
  type Keyframe,
  type KeyframeProp,
  type TimelineClip,
  type TrackKind,
} from "@/lib/timeline/types";

const ROW_H = 34;
const PAD = 6;
const LABEL_W = 140;

export default function KeyframeEditor({ clip, kind, pxPerSecond, playhead }: {
  clip: TimelineClip;
  kind: TrackKind;
  pxPerSecond: number;
  playhead: number;
}) {
  const dragRef = useRef<{ prop: KeyframeProp; others: Keyframe[] } | null>(null);
  // Audio clips automate volume/pan; everything else (video clips AND title/text
  // layers, which live on a video track) automates the visual transform set.
  const props = kind === "audio" ? AUDIO_KF_PROPS : VIDEO_KF_PROPS;
  const graphW = Math.max(clip.duration * pxPerSecond, 240);
  const local = Math.max(0, Math.min(clip.duration, playhead - clip.start));

  const yFor = (prop: KeyframeProp, v: number) => {
    const m = KF_PROPS[prop];
    const f = (v - m.min) / (m.max - m.min || 1);
    return PAD + (1 - Math.max(0, Math.min(1, f))) * (ROW_H - 2 * PAD);
  };
  const valFromY = (prop: KeyframeProp, y: number) => {
    const m = KF_PROPS[prop];
    const f = 1 - (y - PAD) / (ROW_H - 2 * PAD);
    return Math.max(m.min, Math.min(m.max, m.min + f * (m.max - m.min)));
  };

  const onCircleDown = (e: React.PointerEvent, prop: KeyframeProp, index: number) => {
    e.stopPropagation();
    const kfs = clip.keyframes?.[prop] ?? [];
    const svg = (e.currentTarget as Element).closest("svg");
    if (!svg) return;
    timelineStore.beginInteraction();
    dragRef.current = { prop, others: kfs.filter((_, i) => i !== index) };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const rect = svg.getBoundingClientRect();
      const t = Math.max(0, Math.min(clip.duration, (ev.clientX - rect.left) / pxPerSecond));
      const v = valFromY(d.prop, ev.clientY - rect.top);
      timelineStore.setClipKeyframes(clip.id, d.prop, [...d.others, { t, value: v }]);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onLaneDouble = (e: React.MouseEvent, prop: KeyframeProp) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const t = Math.max(0, Math.min(clip.duration, (e.clientX - rect.left) / pxPerSecond));
    timelineStore.addKeyframe(clip.id, prop, t, evalClipProp(clip, prop, t));
  };

  return (
    <div className="flex text-[10px] select-none">
      {/* Parameter labels */}
      <div className="shrink-0 border-r border-border/60" style={{ width: LABEL_W }}>
        <div className="h-6 flex items-center px-2 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
          Keyframes
        </div>
        {props.map((prop) => {
          const m = KF_PROPS[prop];
          const cur = evalClipProp(clip, prop, local);
          const has = (clip.keyframes?.[prop]?.length ?? 0) > 0;
          return (
            <div key={prop} className="flex items-center gap-1 px-2 border-b border-border/40" style={{ height: ROW_H }}>
              <button
                type="button"
                title="Add keyframe at playhead"
                onClick={() => timelineStore.addKeyframe(clip.id, prop, local, evalClipProp(clip, prop, local))}
                className={has ? "text-amber-400" : "text-muted-foreground hover:text-foreground"}
              >
                <Diamond className="w-3 h-3" fill={has ? "currentColor" : "none"} />
              </button>
              <span className="flex-1 truncate text-muted-foreground">{m.label}</span>
              <span className="tabular-nums text-foreground/80">{cur.toFixed(m.decimals)}{m.unit}</span>
            </div>
          );
        })}
      </div>

      {/* Graphs */}
      <div className="flex-1 overflow-x-auto">
        <div style={{ width: graphW }}>
          <div className="h-6 border-b border-border/60" />
          {props.map((prop) => {
            const kfs = clip.keyframes?.[prop] ?? [];
            const playX = local * pxPerSecond;
            const flatY = yFor(prop, evalClipProp(clip, prop, 0));
            return (
              <svg
                key={prop}
                width={graphW}
                height={ROW_H}
                onDoubleClick={(e) => onLaneDouble(e, prop)}
                className="block border-b border-border/40 bg-card/20 cursor-crosshair"
              >
                {kfs.length === 0 ? (
                  <line x1={0} x2={graphW} y1={flatY} y2={flatY} stroke="rgb(120 120 130)" strokeDasharray="3 3" strokeWidth={1} />
                ) : (
                  <>
                    <polyline
                      fill="none"
                      stroke="rgb(74 222 128)"
                      strokeWidth={1.5}
                      points={[
                        `0,${yFor(prop, kfs[0].value)}`,
                        ...kfs.map((k) => `${k.t * pxPerSecond},${yFor(prop, k.value)}`),
                        `${graphW},${yFor(prop, kfs[kfs.length - 1].value)}`,
                      ].join(" ")}
                    />
                    {kfs.map((k, i) => (
                      <circle
                        key={i}
                        cx={k.t * pxPerSecond}
                        cy={yFor(prop, k.value)}
                        r={4}
                        fill="rgb(248 113 113)"
                        stroke="white"
                        strokeWidth={1}
                        className="cursor-grab"
                        onPointerDown={(e) => onCircleDown(e, prop, i)}
                        onDoubleClick={(e) => { e.stopPropagation(); timelineStore.removeKeyframe(clip.id, prop, i); }}
                      />
                    ))}
                  </>
                )}
                <line x1={playX} x2={playX} y1={0} y2={ROW_H} stroke="rgb(244 63 94)" strokeWidth={1} />
              </svg>
            );
          })}
        </div>
      </div>
    </div>
  );
}
