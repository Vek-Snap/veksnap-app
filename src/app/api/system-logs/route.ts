import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, readdir, truncate } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { scrubPii } from "@/lib/log-scrub";

export const dynamic = "force-dynamic";

// Resolved LAZILY: a module-scope os.tmpdir() path makes Next's output-file-
// tracer (@vercel/nft) evaluate it and try to bundle the runtime dir into
// .next/standalone (ENOENT). Keeping it in a function hides it from tracing.
function logDir(): string {
  return path.join(os.tmpdir(), "veksnap-logs");
}

// UTF-8 BOM. Prepended to downloadable text so editors never misdetect the
// encoding: a log containing a run of NUL bytes otherwise auto-detects as
// UTF-16 and renders as CJK mojibake.
const UTF8_BOM = "\uFEFF";

// Remove NUL and other C0 control bytes (keeping \t \r \n) that can appear in a
// service .log and trip a viewer's encoding auto-detection.
function sanitizeLog(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

// Display-friendly names for log sections
const DISPLAY_NAMES: Record<string, string> = {
  comfyui: "ComfyUI",
  veksnap: "Vek-Snap",
  lora_training: "LoRA Training",
  video_restore: "Video Restore",
  voice_tools: "Voice Tools",
  ai_tools: "AI Tools",
};

// Sections that are still WRITTEN and still INCLUDED in the "Export All" /
// "Export Diagnostics" bundles (so we can validate a genuine customer from a
// support export), but are hidden from the in-app log viewer tabs, the user
// has no need to browse them live. Compared case-insensitively without the
// ".log" extension.
const HIDDEN_FROM_VIEWER = new Set<string>(["license"]);

/**
 * GET /api/system-logs
 *   ?service=ComfyUI|VekSnap: return logs for a specific service
 *   ?list=true: return list of available log files
 *   ?tail=N: return last N lines (default: 200)
 *   ?export=true&service=...: download full log file
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // List available logs
  if (sp.get("list") === "true") {
    const dir = logDir();
    if (!existsSync(dir)) {
      return NextResponse.json({ logs: [], logDir: dir });
    }
    const files = await readdir(dir);
    const logs = files
      .filter((f) => f.endsWith(".log"))
      .filter((f) => !HIDDEN_FROM_VIEWER.has(f.replace(/\.log$/i, "").toLowerCase()))
      .map((f) => {
        const key = f.replace(".log", "");
        return {
          name: DISPLAY_NAMES[key] || key.replace(/_/g, " "),
          file: f,
          path: path.join(dir, f),
        };
      });
    return NextResponse.json({ logs, logDir: dir });
  }

  // Get logs for a service
  const service = sp.get("service");
  if (!service) {
    return NextResponse.json({ error: "Specify ?service= or ?list=true" }, { status: 400 });
  }

  const logFile = path.join(logDir(), `${service.toLowerCase().replace(/\s+/g, "_")}.log`);
  if (!existsSync(logFile)) {
    return NextResponse.json({
      lines: [`No log file found for "${service}". Make sure the launcher is running.`],
      file: logFile,
    });
  }

  const content = await readFile(logFile, "utf-8");

  // Export full log as downloadable file (PII-scrubbed, it may be sent to us)
  if (sp.get("export") === "true") {
    return new Response(UTF8_BOM + scrubPii(sanitizeLog(content)), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${service}_${new Date().toISOString().slice(0, 10)}.log"`,
      },
    });
  }

  // Return last N lines
  const tail = parseInt(sp.get("tail") || "200", 10);

  // Handle \r (carriage return) from tqdm / progress bars.
  // In a terminal, \r moves cursor to line start and overwrites.
  // In a log file, \r is preserved verbatim, creating garbled output.
  const rawLines = content.split("\n");
  const resolvedLines: string[] = [];
  for (const raw of rawLines) {
    if (raw.includes("\r")) {
      // Simulate terminal: keep only the last \r segment (the final overwrite)
      const segments = raw.split("\r").filter(s => s.length > 0);
      if (segments.length > 0) {
        resolvedLines.push(segments[segments.length - 1]);
      }
    } else {
      resolvedLines.push(raw);
    }
  }

  // Collapse consecutive progress bar lines (tqdm/HF) to show only the latest.
  // This prevents hundreds of "Loading weights: 37%|..." lines flooding the viewer.
  const allLines: string[] = [];
  for (const line of resolvedLines) {
    const isProgress = /\d+%\|/.test(line);
    if (isProgress && allLines.length > 0 && /\d+%\|/.test(allLines[allLines.length - 1])) {
      const currLabel = line.split(/\d+%/)[0].trim();
      const prevLabel = allLines[allLines.length - 1].split(/\d+%/)[0].trim();
      if (currLabel === prevLabel) {
        allLines[allLines.length - 1] = line; // Replace with newer update
        continue;
      }
    }
    allLines.push(line);
  }
  const lines = allLines.slice(-tail);

  return NextResponse.json({
    lines,
    totalLines: allLines.length,
    file: logFile,
  });
}

/**
 * POST /api/system-logs: export all logs as a combined file
 */
export async function POST() {
  const dir = logDir();
  if (!existsSync(dir)) {
    return NextResponse.json({ error: "No log directory found" }, { status: 404 });
  }

  const files = await readdir(dir);
  const logFiles = files.filter((f) => f.endsWith(".log"));

  let combined = `Vek-Snap: System Logs Export\n`;
  combined += `Date: ${new Date().toISOString()}\n`;
  combined += `${"=".repeat(60)}\n\n`;

  for (const f of logFiles) {
    const content = await readFile(path.join(logDir(), f), "utf-8");
    combined += `\n${"─".repeat(40)}\n`;
    combined += `SERVICE: ${f.replace(".log", "").toUpperCase()}\n`;
    combined += `${"─".repeat(40)}\n`;
    combined += content;
    combined += "\n";
  }

  // Redact OS-account PII (usernames in paths, etc.) before the export leaves
  // the machine. The license section is preserved for customer validation.
  combined = scrubPii(sanitizeLog(combined));

  return new Response(UTF8_BOM + combined, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="veksnap_logs_${new Date().toISOString().slice(0, 10)}.txt"`,
    },
  });
}

/**
 * DELETE /api/system-logs?service=comfyui: clear (truncate) a specific service log
 */
export async function DELETE(req: NextRequest) {
  const service = req.nextUrl.searchParams.get("service");
  if (!service) {
    return NextResponse.json({ error: "Specify ?service=" }, { status: 400 });
  }

  const logFile = path.join(logDir(), `${service.toLowerCase().replace(/\s+/g, "_")}.log`);
  if (!existsSync(logFile)) {
    return NextResponse.json({ error: `No log file for "${service}"` }, { status: 404 });
  }

  await truncate(logFile, 0);
  return NextResponse.json({ ok: true, cleared: logFile });
}
