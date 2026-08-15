import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const { path: filePath } = await req.json();
    if (!filePath) {
      return NextResponse.json({ error: "No path provided" }, { status: 400 });
    }
    // Open containing folder with file selected. Detached spawn (no shell) so the
    // path can never be interpreted as a command, prevents shell injection via
    // body.path. NOTE: do NOT set windowsHide - CREATE_NO_WINDOW suppresses the
    // Explorer window and nothing opens.
    const dir = path.dirname(filePath);
    if (process.platform === "win32") {
      spawn("explorer.exe", [`/select,${filePath}`], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-R", filePath], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
    }
    return NextResponse.json({ ok: true, dir });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to open folder" },
      { status: 500 }
    );
  }
}
