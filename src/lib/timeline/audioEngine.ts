// Timeline audio engine: a Web Audio graph for live monitoring of audio clips.
// Plain HTMLAudioElement volume is capped at 1.0, so it cannot reproduce studio-grade
// amplification (up to +30 dB). Routing each clip through a GainNode lets us
// boost past unity AND apply real-time stereo panning, both driven by per-clip
// keyframe automation. One element + source + gain + panner per clip id.

"use client";

export interface ClipAudioNode {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
}

export class TimelineAudioEngine {
  private ctx: AudioContext | null = null;
  private nodes = new Map<string, ClipAudioNode>();
  // Master metering: every clip routes into `master`, which feeds the speakers
  // AND a stereo pair of analysers so the transport can draw live output levels.
  private master: GainNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;

  private context(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      // Build the master bus + stereo analysers once, alongside the context.
      const master = this.ctx.createGain();
      const splitter = this.ctx.createChannelSplitter(2);
      const aL = this.ctx.createAnalyser();
      const aR = this.ctx.createAnalyser();
      aL.fftSize = 1024; aR.fftSize = 1024;
      master.connect(this.ctx.destination);
      master.connect(splitter);
      splitter.connect(aL, 0);
      splitter.connect(aR, 1);
      this.master = master;
      this.analyserL = aL;
      this.analyserR = aR;
    }
    return this.ctx;
  }

  /** Master output bus (clips connect here so their sum is metered + audible). */
  private masterNode(): AudioNode {
    this.context();
    return this.master as GainNode;
  }

  /**
   * Current stereo output peak levels (0..1 linear) since the last read. Returns
   * null when there is nothing to meter yet. Cheap enough to poll on rAF.
   */
  meterLevels(): { l: number; r: number } | null {
    if (!this.analyserL || !this.analyserR) return null;
    const peak = (an: AnalyserNode): number => {
      const buf = new Float32Array(an.fftSize); // local alloc → correct ArrayBuffer typing
      an.getFloatTimeDomainData(buf);
      let p = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; }
      return Math.min(1, p);
    };
    return { l: peak(this.analyserL), r: peak(this.analyserR) };
  }

  /** Resume the context after a user gesture (browsers start it suspended). */
  resume(): void {
    void this.ctx?.resume?.();
  }

  /** Get (or lazily build) the audio graph for a clip, pointed at `src`. */
  ensure(clipId: string, src: string): ClipAudioNode {
    const existing = this.nodes.get(clipId);
    if (existing) {
      if (existing.el.src !== src) existing.el.src = src;
      return existing;
    }
    const ctx = this.context();
    const el = new Audio(src);
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    source.connect(gain).connect(panner).connect(this.masterNode());
    const node: ClipAudioNode = { el, source, gain, panner };
    this.nodes.set(clipId, node);
    return node;
  }

  has(clipId: string): boolean {
    return this.nodes.has(clipId);
  }

  get(clipId: string): ClipAudioNode | undefined {
    return this.nodes.get(clipId);
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  /** Apply linear gain (can exceed 1) + pan (-1..1) smoothly. */
  setParams(clipId: string, gainLinear: number, pan: number): void {
    const node = this.nodes.get(clipId);
    if (!node || !this.ctx) return;
    const now = this.ctx.currentTime;
    node.gain.gain.setTargetAtTime(Math.max(0, gainLinear), now, 0.01);
    node.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.01);
  }

  release(clipId: string): void {
    const node = this.nodes.get(clipId);
    if (!node) return;
    try { node.el.pause(); } catch { /* ignore */ }
    try {
      node.source.disconnect();
      node.gain.disconnect();
      node.panner.disconnect();
    } catch { /* ignore */ }
    this.nodes.delete(clipId);
  }

  releaseAll(): void {
    for (const id of [...this.nodes.keys()]) this.release(id);
  }
}
