/**
 * Segment Tracker: Maps ComfyUI node IDs to segment/pass progress
 *
 * Node ID layout from buildWanRemixExtendedWorkflow:
 *   Each segment gets 20 node IDs: base = 200 + seg * 20
 *   +0: CLIPTextEncode (conditioning)
 *   +1: WanImageToVideo (conditioning)
 *   +2: KSamplerAdvanced Pass 1 (High-Q model)
 *   +3: KSamplerAdvanced Pass 2 (Low-Q model)
 *   +4: VAEDecode
 *   +5: ImageFromBatch (last frame extraction)
 *   +6: LoadImage (start keyframe)
 *   +7: LoadImage (end keyframe)
 *
 * Single-segment WAN Remix (buildWanRemixI2VWorkflow):
 *   Node "30": KSampler Pass 1
 *   Node "31": KSampler Pass 2
 *   Node "8":  VAEDecode
 */

import { SegmentProgress, PassType, SegmentStatus } from "./types";

// Offset within a segment's 20-node block → pass type + label
const OFFSET_MAP: Record<number, { pass: PassType; label: string }> = {
  0: { pass: "conditioning", label: "Encoding prompt" },
  1: { pass: "conditioning", label: "WanImageToVideo" },
  2: { pass: "pass1", label: "Pass 1 (High-Q)" },
  3: { pass: "pass2", label: "Pass 2 (Low-Q)" },
  4: { pass: "decoding", label: "VAE Decode" },
  5: { pass: "other", label: "Extracting last frame" },
  6: { pass: "other", label: "Loading keyframe" },
  7: { pass: "other", label: "Loading keyframe" },
};

/**
 * Parse a ComfyUI node ID into segment progress info.
 * Returns null if the node ID doesn't belong to a storyboard segment.
 */
export function parseSegmentFromNode(
  nodeId: string,
  totalSegments: number
): { segment: number; pass: PassType; label: string } | null {
  const id = parseInt(nodeId, 10);
  if (isNaN(id)) return null;

  // Storyboard segments: IDs 200+
  if (id >= 200 && id < 200 + totalSegments * 20) {
    const segIndex = Math.floor((id - 200) / 20);
    const offset = (id - 200) % 20;
    const info = OFFSET_MAP[offset];
    if (info && segIndex < totalSegments) {
      return { segment: segIndex, ...info };
    }
  }

  // Final output nodes (2010-2012: CreateVideo, SaveVideo, SaveImage)
  if (id >= 2010 && id <= 2012) {
    return { segment: totalSegments - 1, pass: "other", label: "Saving video" };
  }

  // Trim/concat nodes (2100+, 2200+): final assembly
  if (id >= 2100) {
    return { segment: totalSegments - 1, pass: "other", label: "Assembling video" };
  }

  // Shared infrastructure nodes (LoRA loading, model loading, etc.)
  if (id < 200) {
    return { segment: 0, pass: "other", label: "Loading models" };
  }

  return null;
}

/**
 * Build a SegmentProgress object from the current executing node.
 */
export function buildSegmentProgress(
  nodeId: string,
  totalSegments: number
): SegmentProgress | null {
  if (totalSegments <= 0) return null;

  const parsed = parseSegmentFromNode(nodeId, totalSegments);
  if (!parsed) return null;

  const statuses: SegmentStatus[] = [];
  for (let i = 0; i < totalSegments; i++) {
    if (i < parsed.segment) {
      statuses.push("complete");
    } else if (i === parsed.segment) {
      statuses.push("active");
    } else {
      statuses.push("pending");
    }
  }

  return {
    totalSegments,
    currentSegment: parsed.segment,
    currentPass: parsed.pass,
    passLabel: parsed.label,
    segmentStatuses: statuses,
  };
}

/**
 * For single-segment WAN Remix, map node IDs to pass info.
 */
export function parseSingleSegmentPass(nodeId: string): { pass: PassType; label: string } | null {
  switch (nodeId) {
    case "30": return { pass: "pass1", label: "Pass 1 (High-Q)" };
    case "31": return { pass: "pass2", label: "Pass 2 (Low-Q)" };
    case "8":  return { pass: "decoding", label: "VAE Decode" };
    case "40": return { pass: "other", label: "Creating video" };
    case "41": return { pass: "other", label: "Saving video" };
    default:   return null;
  }
}
