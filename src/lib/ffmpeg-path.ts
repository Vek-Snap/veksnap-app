import path from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";

/**
 * Shared async exec wrapper: uses spawn with windowsHide: true to reliably
 * prevent console windows from flashing on Windows.  All API routes should
 * use this instead of their own promisify(exec) wrappers.
 */
export function execAsync(cmd: string, opts?: { env?: Record<string, string> }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve({ stdout, stderr });
      } else {
        const err: any = new Error(`Command failed (exit ${code}): ${stderr.slice(-2000)}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });
  });
}

/**
 * Shell-FREE exec wrapper.  Runs a binary with an explicit argument array so
 * that user-controlled values (file paths, names) can NEVER be interpreted by
 * a shell.  Use this for any command that includes untrusted input (e.g. file
 * paths in the metadata tools) to prevent command injection.
 */
export function execFileAsync(
  file: string,
  args: string[],
  opts?: { env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve({ stdout, stderr });
      } else {
        const err: any = new Error(`Command failed (exit ${code}): ${stderr.slice(-2000)}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });
  });
}

/**
 * Resolves the absolute path to ffmpeg.exe bundled in the miniconda environment.
 * As of April 2026: FFmpeg 8.1 static GPL build (BtbN) with librubberband.
 * Falls back to bare "ffmpeg" if the bundled binary isn't found (e.g. system PATH).
 */
export function getFFmpegPath(): string {
  // Primary: installer-bundled static FFmpeg (new venv-based layout)
  const runtimeFf = path.resolve(process.cwd(), "..", "runtime", "ffmpeg", "bin", "ffmpeg.exe");
  if (existsSync(runtimeFf)) return runtimeFf;

  // Legacy: miniconda base Library/bin (dev machines)
  const bundled = path.resolve(process.cwd(), "..", "miniconda", "Library", "bin", "ffmpeg.exe");
  if (existsSync(bundled)) return bundled;

  // Last resort: hope it's on PATH
  return "ffmpeg";
}

/**
 * Resolves the absolute path to ffprobe.exe (lives alongside ffmpeg).
 */
export function getFFprobePath(): string {
  // Primary: installer-bundled static FFmpeg (new venv-based layout)
  const runtimeFp = path.resolve(process.cwd(), "..", "runtime", "ffmpeg", "bin", "ffprobe.exe");
  if (existsSync(runtimeFp)) return runtimeFp;

  const bundled = path.resolve(process.cwd(), "..", "miniconda", "Library", "bin", "ffprobe.exe");
  if (existsSync(bundled)) return bundled;

  return "ffprobe";
}
