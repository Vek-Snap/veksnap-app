import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { isInsideAllowedRoots } from "@/lib/model-paths";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Reveal a model file in the OS file manager (Windows Explorer "select" the
// file). Sandboxed to the configured model roots so an arbitrary path can never
// be opened. Local-only convenience: no network.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.path !== "string" || !body.path.trim()) {
    return NextResponse.json({ ok: false, error: "A path is required." }, { status: 400 });
  }
  const abs = path.resolve(body.path.trim());
  if (!isInsideAllowedRoots(abs)) {
    return NextResponse.json({ ok: false, error: "Path is outside the configured model directories." }, { status: 400 });
  }
  if (!fs.existsSync(abs)) {
    return NextResponse.json({ ok: false, error: "File not found." }, { status: 404 });
  }

  try {
    if (process.platform === "win32") {
      // explorer.exe /select,"<file>" highlights the file in its folder.
      spawn("explorer.exe", [`/select,${abs}`], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-R", abs], { detached: true, stdio: "ignore" }).unref();
    } else {
      // Linux: no universal "select" - open the containing folder.
      spawn("xdg-open", [path.dirname(abs)], { detached: true, stdio: "ignore" }).unref();
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
