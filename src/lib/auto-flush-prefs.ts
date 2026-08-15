/**
 * "AutoFlush": the master user preference, and it governs SINGLE-MODEL WORKFLOWS ONLY.
 *
 * ── SCOPE (this is the important part) ──
 *
 *   SINGLE-model workflows  -> THIS FILE. A user preference, default OFF.
 *                              One model loads, works, finishes. Whether it should then be
 *                              released is a matter of user taste (keep it warm for the next run
 *                              vs. hand VRAM back to other apps). There is no capacity question to
 *                              reason about, so the user simply decides.
 *
 *   CHAINED (multi-model)   -> `vram-guard.ts`. NOT a preference, and deliberately not exposed
 *      workflows               here. Stage A's model is resident when stage B must load, so it is
 *                              a measurable capacity question: free VRAM is compared against the
 *                              next model's requirement and a flush happens only if it would not
 *                              fit. Never ask the user to answer that.
 *
 * ── WHY THE SPLIT ──
 * Chained handoffs originally flushed unconditionally, which threw away models that would have fit
 * fine on a larger card. Making them a per-workflow checkbox was no better: it handed a
 * hardware-capacity judgement to the user, who could only find the right setting by hitting an OOM
 * first. Capacity is measured; taste is configured. This file is only the latter.
 *
 * Do NOT add pipeline-handoff toggles here. Add the stage to `vram-guard.ts` instead.
 */

const STORAGE_KEY = "veksnap.autoFlush.master";

/**
 * Master AutoFlush switch for single-model workflows. Defaults to FALSE: memory is never released
 * automatically unless the user opts in.
 *
 * This has NO effect on chained pipelines, those are handled by `vram-guard.ts` regardless of
 * this setting, because letting it disable them would reintroduce avoidable OOMs.
 */
export function isAutoFlushEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoFlushEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    /* storage unavailable: stays at the safe default */
  }
}
