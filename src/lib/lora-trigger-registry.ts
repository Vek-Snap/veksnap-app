/**
 * Global LoRA Trigger Registry
 *
 * Persistent localStorage database mapping LoRA filenames to user-defined trigger words.
 * Once a user defines a trigger for a LoRA, it's remembered across all sessions and projects.
 * Falls back to LORA_TRIGGER_MAP for known LoRAs when no user override exists.
 */

import { getLoRATriggerInfo } from "@/lib/types";

const STORAGE_KEY = "veksnap-lora-triggers";

/** Get the full registry from localStorage */
function getRegistry(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Save the registry to localStorage */
function saveRegistry(reg: Record<string, string>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(reg));
}

/**
 * Look up the trigger word for a LoRA filename.
 * Priority: 1) user registry, 2) LORA_TRIGGER_MAP, 3) undefined
 */
export function getTriggerForLora(loraName: string): string | undefined {
  if (!loraName) return undefined;
  const reg = getRegistry();
  // Normalize: check both the full name and just the filename portion
  const key = loraName.trim();
  if (reg[key]) return reg[key];
  // Also check without path prefix (in case stored with/without subfolder)
  const basename = key.split(/[/\\]/).pop() ?? key;
  if (reg[basename]) return reg[basename];
  // Fallback to built-in map
  const mapInfo = getLoRATriggerInfo(loraName);
  return mapInfo?.triggers[0] ?? undefined;
}

/**
 * Save a trigger word for a LoRA to the persistent registry.
 * Pass empty string to remove the entry.
 */
export function setTriggerForLora(loraName: string, triggerWord: string): void {
  if (!loraName) return;
  const reg = getRegistry();
  const key = loraName.trim();
  if (triggerWord.trim()) {
    reg[key] = triggerWord.trim();
  } else {
    delete reg[key];
  }
  saveRegistry(reg);
}

/**
 * Get the entire registry (for display/export).
 */
export function getAllTriggers(): Record<string, string> {
  return getRegistry();
}

/**
 * Bulk-set triggers (for import).
 */
export function importTriggers(entries: Record<string, string>): void {
  const reg = getRegistry();
  for (const [key, val] of Object.entries(entries)) {
    if (val.trim()) reg[key.trim()] = val.trim();
  }
  saveRegistry(reg);
}
