import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Render Tracker: server-side safety net for OOM crashes.
 *
 * When the frontend queues a render, it registers the prompt_id here.
 * If the renderer crashes and recovers, it checks this tracker to find
 * any renders that completed while the UI was dead.
 *
 * The tracker persists to disk so it survives process restarts.
 *
 * Endpoints:
 *   GET: returns all tracked renders (pending + completed)
 *   POST { action: "register", prompt_id, mode, timestamp } - register a new render
 *   POST { action: "complete", prompt_id } - mark as completed (frontend received output)
 *   POST { action: "clear" } - clear all tracked renders
 */

// Resolved LAZILY: a module-scope tmpdir() path makes Next's output-file-tracer
// (@vercel/nft) evaluate it and try to bundle the runtime dir into
// .next/standalone (ENOENT during "Collecting build traces").
function trackerDir(): string {
  return join(tmpdir(), "veksnap-logs");
}
function trackerFile(): string {
  return join(trackerDir(), "render-tracker.json");
}

interface TrackedRender {
  prompt_id: string;
  mode: string;          // e.g. "zimage", "wan_story", "ltx"
  timestamp: number;     // when queued
  recovered?: boolean;   // true if output was recovered after crash
}

function readTracker(): TrackedRender[] {
  try {
    if (existsSync(trackerFile())) {
      const data = JSON.parse(readFileSync(trackerFile(), "utf-8"));
      // Prune entries older than 24 hours
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return (data as TrackedRender[]).filter((r) => r.timestamp > cutoff);
    }
  } catch { /* corrupt file, start fresh */ }
  return [];
}

function writeTracker(renders: TrackedRender[]) {
  try {
    mkdirSync(trackerDir(), { recursive: true });
    writeFileSync(trackerFile(), JSON.stringify(renders, null, 2));
  } catch { /* best effort */ }
}

export async function GET() {
  const renders = readTracker();
  return NextResponse.json({ renders });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;

  if (action === "register") {
    const { prompt_id, mode, timestamp } = body;
    if (!prompt_id) {
      return NextResponse.json({ error: "prompt_id required" }, { status: 400 });
    }
    const renders = readTracker();
    // Avoid duplicates
    if (!renders.some((r) => r.prompt_id === prompt_id)) {
      renders.push({
        prompt_id,
        mode: mode || "unknown",
        timestamp: timestamp || Date.now(),
      });
      writeTracker(renders);
    }
    return NextResponse.json({ ok: true, tracked: renders.length });
  }

  if (action === "complete") {
    const { prompt_id } = body;
    const renders = readTracker();
    const filtered = renders.filter((r) => r.prompt_id !== prompt_id);
    writeTracker(filtered);
    return NextResponse.json({ ok: true, remaining: filtered.length });
  }

  if (action === "clear") {
    writeTracker([]);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
