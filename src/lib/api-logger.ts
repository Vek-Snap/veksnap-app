/**
 * Persistent API-route logger: appends timestamped lines to per-section
 * log files inside the veksnap-logs directory (same dir used by the launcher
 * for ComfyUI / Vek-Snap logs).
 *
 * Log files created by this module appear as additional tabs in the
 * System Logs viewer and are included in the "Download All" export.
 *
 * Usage:
 *   import { apiLog } from "@/lib/api-logger";
 *   apiLog("lora_training", "Epoch 3/10: loss 0.0412");
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import os from "os";

// Resolve + ensure the log dir LAZILY on first use. Computing it at module
// scope (and running mkdirSync as an import-time side effect) makes Next's
// output-file-tracer (@vercel/nft) statically evaluate os.tmpdir() and treat
// the resulting runtime dir as a build asset to copy into .next/standalone,
// which then fails with ENOENT. A lazy getter keeps the path unresolvable at
// trace time.
let cachedLogDir: string | null = null;
function getLogDir(): string {
  if (cachedLogDir) return cachedLogDir;
  const dir = path.join(os.tmpdir(), "veksnap-logs");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // Directory creation is best-effort; apiLog swallows write failures too.
  }
  cachedLogDir = dir;
  return dir;
}

/**
 * Append a timestamped line to a named log file.
 * @param section  Log file name (without .log extension), e.g. "lora_training"
 * @param message  Single or multi-line message to append
 */
export function apiLog(section: string, message: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const logFile = path.join(getLogDir(), `${section}.log`);
  const lines = message.split("\n");
  const formatted = lines.map((l) => `[${ts}] ${l}\n`).join("");
  try {
    appendFileSync(logFile, formatted);
  } catch {
    // Don't crash the API route if logging fails
  }
}

/**
 * Pipe a child process's stdout/stderr into a log section in real time.
 * Useful for long-running subprocesses (training, restoration, etc.)
 *
 * @param section  Log file name
 * @param child    ChildProcess with readable stdout/stderr streams
 * @param label    Optional prefix label for stderr lines (e.g. "stderr")
 */
export function pipeToLog(
  section: string,
  child: { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null },
  label?: string,
): void {
  const prefix = label ? `[${label}] ` : "";
  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) apiLog(section, `${line}`);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) apiLog(section, `${prefix}${line}`);
      }
    });
  }
}
