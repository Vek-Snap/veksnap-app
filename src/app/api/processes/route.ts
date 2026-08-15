import { NextResponse } from "next/server";
import { exec } from "child_process";
import { COMFYUI_PORT } from "@/lib/comfyui-config";

export const dynamic = "force-dynamic";

interface ProcessInfo {
  pid: number;
  name: string;
  memoryMB: number;
  commandLine: string;
  category: "python" | "node" | "ffmpeg" | "other";
}

/**
 * GET /api/processes
 * Lists running processes spawned by or related to Vek-Snap.
 * Scans for python.exe, node.exe, and ffmpeg.exe processes,
 * filters to those with Vek-Snap-related paths or ports.
 */
export async function GET() {
  try {
    // Use WMIC to get process details including command line
    const raw = await new Promise<string>((resolve, reject) => {
      exec(
        `wmic process where "name='python.exe' or name='node.exe' or name='ffmpeg.exe' or name='ffprobe.exe'" get ProcessId,Name,WorkingSetSize,CommandLine /format:csv`,
        { timeout: 10000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        }
      );
    });

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    // CSV header is: Node,CommandLine,Name,ProcessId,WorkingSetSize
    const processes: ProcessInfo[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 5) continue;

      // WMIC CSV: Node,CommandLine,Name,ProcessId,WorkingSetSize
      // But CommandLine can contain commas, so we parse carefully
      const line = lines[i].trim();
      if (!line) continue;

      // Find the first comma (after Node)
      const firstComma = line.indexOf(",");
      if (firstComma < 0) continue;
      const rest = line.substring(firstComma + 1);

      // Name is near the end, find ProcessId and WorkingSetSize from the right
      // Format: ...CommandLine,Name,ProcessId,WorkingSetSize
      const lastComma = rest.lastIndexOf(",");
      if (lastComma < 0) continue;
      const workingSetStr = rest.substring(lastComma + 1).trim();

      const beforeWS = rest.substring(0, lastComma);
      const pidComma = beforeWS.lastIndexOf(",");
      if (pidComma < 0) continue;
      const pidStr = beforeWS.substring(pidComma + 1).trim();

      const beforePid = beforeWS.substring(0, pidComma);
      const nameComma = beforePid.lastIndexOf(",");
      if (nameComma < 0) continue;
      const procName = beforePid.substring(nameComma + 1).trim();
      const cmdLine = beforePid.substring(0, nameComma).trim();

      const pid = parseInt(pidStr);
      const workingSet = parseInt(workingSetStr);
      if (isNaN(pid)) continue;

      // Filter: only include Vek-Snap-related processes
      const cmdLower = cmdLine.toLowerCase();
      const isVekSnapRelated =
        cmdLower.includes("veksnap") ||
        cmdLower.includes("comfyui") ||
        cmdLower.includes("next-server") ||
        cmdLower.includes("next dev") ||
        cmdLower.includes("ffmpeg") ||
        cmdLower.includes("ffprobe") ||
        cmdLower.includes(`:${COMFYUI_PORT}`) ||
        // Loopback UI port (see shell/main.js UI_PORT), the app never uses the framework default.
        cmdLower.includes(":41573");

      if (!isVekSnapRelated) continue;

      const nameLower = procName.toLowerCase();
      let category: ProcessInfo["category"] = "other";
      if (nameLower.includes("python")) category = "python";
      else if (nameLower.includes("node")) category = "node";
      else if (nameLower.includes("ffmpeg") || nameLower.includes("ffprobe")) category = "ffmpeg";

      // Shorten command line for display
      let shortCmd = cmdLine;
      if (shortCmd.length > 200) shortCmd = shortCmd.substring(0, 200) + "...";

      processes.push({
        pid,
        name: procName,
        memoryMB: Math.round((workingSet || 0) / (1024 * 1024)),
        commandLine: shortCmd,
        category,
      });
    }

    // Sort: python first, then node, then ffmpeg, then other
    const order = { python: 0, node: 1, ffmpeg: 2, other: 3 };
    processes.sort((a, b) => order[a.category] - order[b.category] || a.pid - b.pid);

    return NextResponse.json({ processes });
  } catch (err) {
    return NextResponse.json(
      { processes: [], error: (err as Error).message },
      { status: 200 } // Return 200 with empty list even on error
    );
  }
}
