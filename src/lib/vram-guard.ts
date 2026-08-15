/**
 * VRAM guard for CHAINED (multi-model) pipelines.
 *
 * ── THE DIVISION OF RESPONSIBILITY (read this before changing anything here) ──
 *
 *   SINGLE-model workflows  -> user preference. `auto-flush-prefs.ts`, master toggle, default OFF.
 *                              One model loads, does its work, and the user decides whether it
 *                              should be released afterwards. There is nothing to be clever about.
 *
 *   CHAINED  workflows      -> THIS FILE. Never a user preference.
 *                              Stage A's model is still resident when stage B needs to load.
 *                              Whether that is a problem is a *capacity* question, not a taste
 *                              question, so it is measured and decided programmatically.
 *
 * ── WHY IT WORKS THIS WAY (REVISED, read `ltx-memory-strategy.ts` first) ──
 * The original code flushed unconditionally at these handoffs. That was wrong in both directions:
 * on a 24 GB card it needlessly threw away a model that would fit alongside the next one (paying a
 * full reload for nothing), and it gave the user no visibility either way.
 *
 * The first fix ("measure free VRAM, flush only if the next stage doesn't fit") was ALSO wrong,
 * for two reasons documented in `ltx-memory-strategy.ts`: LTX-2 under DynamicVRAM streams rather
 * than OOMs (so there is no failure to insure against, only slowdown), and a streaming allocator
 * keeps VRAM saturated by design (so low free VRAM is not evidence of pressure). That made the
 * measurement nearly meaningless for LTX and quietly degraded it back into an unconditional flush.
 *
 * So the LTX handoff policy is now SELECTABLE (A/B/C) because there is no single right answer:
 *   A "stream"     : never flush; let DynamicVRAM stream. Default.
 *   B "optimistic" : don't pre-flush; free + retry once only if the stage actually OOMs.
 *   C "measure"    : compare estimated reload cost against estimated streaming cost.
 *
 * ── ADDING A NEW CHAINED STAGE ──
 * Add an entry to STAGE_REQUIREMENTS_GB, then `await ensureVramForStage("your-stage")` immediately
 * before the model loads. Do NOT gate it behind a user toggle.
 */

import { fetchVramSnapshot } from "./vram-estimator";
import { flushGpuMemory } from "./comfyui-api";
import { getLtxMemoryStrategy, type LtxMemoryStrategy } from "./ltx-memory-strategy";

export type PipelineStage = "zimage-refine" | "ltx2-regen" | "foley";

/**
 * Approximate VRAM needed to LOAD each stage's model (weights + working overhead at typical
 * settings), not its peak sampling usage. We only need to answer "will the next model fit in
 * what's free", so load cost is the right measure.
 *
 * These are grounded in the empirical profiles already in `vram-estimator.ts` rather than invented:
 *   zimage-refine : Z-Image is a Flux-class DiT -> PROFILES.flux.baseGB (10.0)
 *   ltx2-regen    : LTX-2 diffusion + framework -> LTX2_BASE_GB (8.0)
 *   foley         : audio model, materially smaller than any video/image DiT
 *
 * Tune these if real-world behaviour disagrees; they are deliberately in one place.
 */
const STAGE_REQUIREMENTS_GB: Record<PipelineStage, number> = {
  "zimage-refine": 10.0,
  "ltx2-regen": 8.0,
  foley: 4.0,
};

const STAGE_LABELS: Record<PipelineStage, string> = {
  "zimage-refine": "Z-Image refine",
  "ltx2-regen": "LTX-2 regeneration",
  foley: "Foley audio",
};

/**
 * Safety margin on top of the raw requirement. Fragmentation and allocator overhead mean a model
 * needing exactly N GB will not reliably load into exactly N GB free.
 */
const HEADROOM_GB = 1.5;

export interface VramGuardResult {
  /** Whether a flush was actually performed. */
  flushed: boolean;
  /** Human-readable explanation, suitable for a status line. Always populated. */
  reason: string;
  freeBeforeGB: number | null;
  requiredGB: number;
  /** True when VRAM could actually be measured (false = estimate unavailable). */
  measured: boolean;
  /** Which policy produced this decision. */
  strategy: LtxMemoryStrategy;
  /**
   * Strategy B only: the stage should be attempted as-is, and if it fails with an out-of-memory
   * error the caller should call `freeAndRetry()` once. Wrap the stage in `withOomRetry` to get
   * this behaviour automatically.
   */
  retryOnOom: boolean;
}

/**
 * Decide what to do about the previous stage's resident models before `stage` loads, according to
 * the user's selected LTX memory strategy (A/B/C, see `ltx-memory-strategy.ts`).
 *
 * Never throws: a guard failure must not take down the pipeline it is protecting. On any error it
 * degrades to leaving models resident, which streaming can absorb, rather than forcing a reload.
 *
 * @param onStatus Optional progress callback so the calling panel can surface what's happening
 *                 instead of appearing to stall.
 */
export async function ensureVramForStage(
  stage: PipelineStage,
  onStatus?: (message: string) => void
): Promise<VramGuardResult> {
  const requiredGB = STAGE_REQUIREMENTS_GB[stage];
  const neededGB = requiredGB + HEADROOM_GB;
  const label = STAGE_LABELS[stage];

  const strategy = getLtxMemoryStrategy();

  // ── A: keep resident, let DynamicVRAM stream ──
  // No measurement needed: the decision is "never flush", precisely because free VRAM is not a
  // meaningful signal under a streaming allocator and there is no OOM to avoid.
  if (strategy === "stream") {
    const reason =
      `Keeping models resident for ${label}; weights stream from RAM if VRAM is tight (strategy A).`;
    onStatus?.(reason);
    return {
      flushed: false,
      reason,
      freeBeforeGB: null,
      requiredGB,
      measured: false,
      strategy,
      retryOnOom: false,
    };
  }

  // ── B: attempt as-is, free only if it actually fails ──
  // The only policy that needs no VRAM numbers at all, so it cannot be miscalibrated. The caller
  // (or `withOomRetry`) performs the free-and-retry if an OOM genuinely occurs.
  if (strategy === "optimistic") {
    const reason = `Attempting ${label} with models resident; will free and retry only if it runs out of memory (strategy B).`;
    onStatus?.(reason);
    return {
      flushed: false,
      reason,
      freeBeforeGB: null,
      requiredGB,
      measured: false,
      strategy,
      retryOnOom: true,
    };
  }

  // ── C: compare estimated reload cost against estimated streaming cost ──
  const snapshot = await fetchVramSnapshot();

  // Unmeasurable (no nvidia-smi, non-NVIDIA GPU, endpoint down). Unlike the original version, the
  // fallback here is NOT to flush: with streaming available, doing nothing degrades to strategy A
  // (possibly slower) whereas flushing blindly guarantees a reload we may not need.
  if (!snapshot) {
    const reason =
      `VRAM usage could not be measured; keeping models resident for ${label} ` +
      `(falling back to streaming rather than forcing a reload).`;
    onStatus?.(reason);
    return {
      flushed: false,
      reason,
      freeBeforeGB: null,
      requiredGB,
      measured: false,
      strategy,
      retryOnOom: false,
    };
  }

  const freeBeforeGB = snapshot.freeMB / 1024;

  // Fits outright; nothing to weigh up.
  if (freeBeforeGB >= neededGB) {
    const reason =
      `${label} fits in available VRAM ` +
      `(${freeBeforeGB.toFixed(1)} GB free, needs ~${neededGB.toFixed(1)} GB); nothing freed.`;
    onStatus?.(reason);
    return { flushed: false, reason, freeBeforeGB, requiredGB, measured: true, strategy, retryOnOom: false };
  }

  // Doesn't fit. Streaming the shortfall over PCIe costs roughly `shortfall / PCIE_GBPS` seconds
  // per pass; freeing costs a full reload of whatever we evict, later. Flush only when streaming is
  // the more expensive of the two.
  const shortfallGB = neededGB - freeBeforeGB;
  const streamCostSec = (shortfallGB / PCIE_EFFECTIVE_GBPS) * STREAM_PASSES_PER_STAGE;
  const reloadCostSec = (snapshot.usedMB / 1024) / DISK_LOAD_GBPS;

  if (streamCostSec <= reloadCostSec) {
    const reason =
      `Keeping models resident for ${label}: streaming ~${shortfallGB.toFixed(1)} GB ` +
      `(~${streamCostSec.toFixed(0)}s) is cheaper than a ~${reloadCostSec.toFixed(0)}s reload (strategy C).`;
    onStatus?.(reason);
    return { flushed: false, reason, freeBeforeGB, requiredGB, measured: true, strategy, retryOnOom: false };
  }

  onStatus?.(
    `Freeing VRAM for ${label}: streaming ~${shortfallGB.toFixed(1)} GB would cost ~${streamCostSec.toFixed(0)}s (strategy C)...`
  );
  const flushOk = await safeFlush();

  // Re-measure so the report reflects reality rather than assuming the flush helped.
  const after = await fetchVramSnapshot();
  const freeAfterGB = after ? after.freeMB / 1024 : null;

  let reason: string;
  if (!flushOk) {
    reason = `Could not free VRAM before ${label}; it will stream from RAM instead.`;
  } else if (freeAfterGB !== null && freeAfterGB < neededGB) {
    reason =
      `Freed models before ${label}, but only ${freeAfterGB.toFixed(1)} GB is free of the ` +
      `~${neededGB.toFixed(1)} GB needed; another application or a running job may be holding VRAM.`;
  } else {
    reason =
      `Freed previous models to make room for ${label} ` +
      `(${freeBeforeGB.toFixed(1)} GB -> ${freeAfterGB !== null ? freeAfterGB.toFixed(1) + " GB" : "unknown"} free).`;
  }

  return { flushed: flushOk, reason, freeBeforeGB, requiredGB, measured: true, strategy, retryOnOom: false };
}

/**
 * Strategy-C cost-model constants. These are ESTIMATES, not measurements; strategy C is labelled
 * experimental in the UI for exactly this reason. Calibrate from real runs before trusting C
 * over A.
 *
 * PCIE_EFFECTIVE_GBPS  : usable host->device bandwidth, well below the theoretical link rate.
 * STREAM_PASSES_PER_STAGE: weights are re-fetched roughly once per sampling pass, so the streaming
 *                        cost is paid repeatedly, not once.
 * DISK_LOAD_GBPS       : NVMe read + deserialize throughput when reloading an evicted model.
 */
const PCIE_EFFECTIVE_GBPS = 12.0;
const STREAM_PASSES_PER_STAGE = 8;
const DISK_LOAD_GBPS = 2.0;

/**
 * Strategy-B helper: run a chained stage and, if it fails with an out-of-memory error, free GPU
 * memory and try exactly once more.
 *
 * Only retries on OOM. Any other failure is rethrown untouched, because freeing models would not
 * fix it and would hide the real cause.
 */
export async function withOomRetry<T>(
  guard: VramGuardResult,
  run: () => Promise<T>,
  onStatus?: (message: string) => void
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!guard.retryOnOom || !isOomError(err)) throw err;
    onStatus?.("Out of memory; freeing models and retrying once...");
    await safeFlush();
    return await run();
  }
}

/** Matches the OOM phrasings PyTorch/ComfyUI actually emit. */
function isOomError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("out of memory") ||
    msg.includes("cuda oom") ||
    msg.includes("outofmemory") ||
    (msg.includes("alloc") && msg.includes("fail"))
  );
}

/**
 * GPU-scope flush that never kills an in-flight job (`includeActive` stays false). A pipeline
 * handoff must not terminate a restore the user is running in another panel.
 */
async function safeFlush(): Promise<boolean> {
  try {
    await flushGpuMemory();
    return true;
  } catch {
    return false;
  }
}
