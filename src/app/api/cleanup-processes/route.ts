import { NextResponse } from "next/server";
import { exec } from "child_process";

export const dynamic = "force-dynamic";

/**
 * POST /api/cleanup-processes
 * Kills orphaned Vek-Snap-related Python and Node.js processes that survived
 * a crash or abnormal shutdown.
 *
 * Safety: Only kills processes whose command line references Vek-Snap paths.
 * Does NOT kill the current Node.js process (next-server).
 */
export async function POST() {
  const currentPid = process.pid;
  const killed: { pid: number; name: string; cmd: string }[] = [];
  const skipped: { pid: number; reason: string }[] = [];
  const errors: string[] = [];

  try {
    // Get all python.exe and node.exe processes with their command lines
    const raw = await new Promise<string>((resolve, reject) => {
      exec(
        `wmic process where "name='python.exe' or name='pythonw.exe' or name='node.exe'" get ProcessId,Name,CommandLine /format:csv`,
        { timeout: 15000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        }
      );
    });

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // CSV: Node,CommandLine,Name,ProcessId
      // CommandLine can contain commas, so parse from the right
      const lastComma = line.lastIndexOf(",");
      if (lastComma < 0) continue;
      const pidStr = line.substring(lastComma + 1).trim();

      const beforePid = line.substring(0, lastComma);
      const nameComma = beforePid.lastIndexOf(",");
      if (nameComma < 0) continue;
      const procName = beforePid.substring(nameComma + 1).trim();

      const firstComma = line.indexOf(",");
      const cmdLine = line.substring(firstComma + 1, nameComma).trim();

      const pid = parseInt(pidStr);
      if (isNaN(pid)) continue;

      // Skip our own process
      if (pid === currentPid) {
        skipped.push({ pid, reason: "current process" });
        continue;
      }

      const cmdLower = cmdLine.toLowerCase();

      // Only target VekSnap-related processes
      const isVekSnapRelated =
        cmdLower.includes("veksnap") ||
        cmdLower.includes("comfyui") ||
        cmdLower.includes("next-server") ||
        cmdLower.includes("next dev");

      if (!isVekSnapRelated) continue;

      // Skip the Next.js dev server itself (we want to keep it running)
      if (
        procName.toLowerCase() === "node.exe" &&
        (cmdLower.includes("next dev") || cmdLower.includes("next-server"))
      ) {
        skipped.push({ pid, reason: "Next.js server (keep alive)" });
        continue;
      }

      // Kill the orphaned process
      try {
        await new Promise<void>((resolve, reject) => {
          exec(
            `taskkill /PID ${pid} /T /F`,
            { timeout: 5000, windowsHide: true },
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        killed.push({
          pid,
          name: procName,
          cmd: cmdLine.length > 150 ? cmdLine.slice(0, 150) + "..." : cmdLine,
        });
      } catch (e) {
        errors.push(`PID ${pid}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, killed, skipped, errors },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    killed,
    skipped,
    errors,
    message: killed.length
      ? `Killed ${killed.length} orphaned process(es)`
      : "No orphaned Vek-Snap processes found",
  });
}
