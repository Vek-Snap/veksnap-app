/**
 * LTX chained-handoff memory strategy (A / B / C).
 *
 * ── WHY THIS EXISTS ──
 * The first version of `vram-guard.ts` assumed that NOT freeing a resident model risks an OOM that
 * loses the chain, so it flushed whenever free VRAM looked insufficient. That premise is wrong for
 * LTX-2. See the note already in `vram-estimator.ts` above `estimateLtx2Vram`:
 *
 *     "With DynamicVRAM (comfy-aimdo), ComfyUI streams model weights to/from system RAM rather
 *      than OOMing, so the real question is speed impact, not whether the generation will fail."
 *
 * Two consequences:
 *   1. There is no OOM to insure against, so the "flush defensively" asymmetry is inverted, the
 *      only real cost is a reload of a model that can be 45+ GB.
 *   2. A streaming allocator deliberately keeps VRAM saturated as cache. Low free VRAM is therefore
 *      NOT evidence of pressure, which makes raw `nvidia-smi` free memory a poor decision input:
 *      it cannot distinguish reclaimable cache from genuinely pinned allocations.
 *
 * No single policy is correct for every card and chain shape, and quantifying the tradeoff is an
 * open R&D question here, so the strategy is selectable. Scoped to the LTX chain ONLY, every
 * current `ensureVramForStage` call site is an LTX handoff (Z-Refine works on LTX keyframes, Foley
 * on LTX video), so this governs exactly those and nothing else.
 */

export type LtxMemoryStrategy = "stream" | "optimistic" | "measure";

/**
 * Default: A (stream). Chosen because it is the only option that cannot make things worse - it
 * never pays an unnecessary multi-GB reload, and the failure mode it accepts (slower streaming) is
 * recoverable, whereas a needless reload is pure lost time. B and C are opt-in experiments.
 */
export const DEFAULT_LTX_MEMORY_STRATEGY: LtxMemoryStrategy = "stream";

const STORAGE_KEY = "saba.ltxMemoryStrategy";

export interface LtxStrategyMeta {
  value: LtxMemoryStrategy;
  label: string;
  /** One-line summary for the selector. */
  summary: string;
  /** The tradeoff being accepted, stated plainly so the choice is informed. */
  tradeoff: string;
}

export const LTX_MEMORY_STRATEGIES: LtxStrategyMeta[] = [
  {
    value: "stream",
    label: "A: Keep resident, let it stream",
    summary: "Never free the LTX model at a handoff. Trust DynamicVRAM to stream weights from RAM.",
    tradeoff:
      "The next stage may run slower while weights stream over PCIe, but you never pay a multi-GB " +
      "model reload. Best when your chains return to LTX repeatedly.",
  },
  {
    value: "optimistic",
    label: "B: Try first, free only on OOM",
    summary: "Attempt the next stage with the model still resident; free and retry once if it OOMs.",
    tradeoff:
      "Costs one failed attempt in the bad case, but needs no hardcoded VRAM numbers, so it stays " +
      "correct on any card. Best if you sometimes genuinely do run out of memory.",
  },
  {
    value: "measure",
    label: "C: Compare reload vs streaming cost",
    summary: "Estimate whether reloading later is cheaper than streaming now, and free only if so.",
    tradeoff:
      "EXPERIMENTAL. Most theoretically correct, but its accuracy depends on reload/stream timing " +
      "estimates that are not yet calibrated on your hardware. Use it to gather data.",
  },
];

export function getLtxMemoryStrategy(): LtxMemoryStrategy {
  if (typeof window === "undefined") return DEFAULT_LTX_MEMORY_STRATEGY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return LTX_MEMORY_STRATEGIES.some((s) => s.value === raw)
      ? (raw as LtxMemoryStrategy)
      : DEFAULT_LTX_MEMORY_STRATEGY;
  } catch {
    return DEFAULT_LTX_MEMORY_STRATEGY;
  }
}

export function setLtxMemoryStrategy(value: LtxMemoryStrategy): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private mode / quota, the in-memory default still applies for this session */
  }
}
