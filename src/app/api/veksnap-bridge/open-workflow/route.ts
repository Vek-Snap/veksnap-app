import { NextRequest, NextResponse } from "next/server";
import { COMFYUI_ORIGIN } from "@/lib/comfyui-config";

export const dynamic = "force-dynamic";

/**
 * Vek-Snap → ComfyUI workflow relay (the "Open in ComfyUI" bridge).
 *
 * This route lives inside the Vek-Snap app (proprietary), NOT inside ComfyUI, so
 * the bridge no longer needs a ComfyUI custom-node that imports/links GPL
 * ComfyUI Python. The studio UI POSTs the active workflow here; ComfyUI's
 * front-end glue (custom_nodes/veksnap_bridge/web, GPL-3.0) GETs it back
 * cross-origin and loads it into the canvas.
 *
 * The slot is one-shot (cleared on read) so a manual ComfyUI refresh never
 * reloads a stale graph. Module-scoped state persists for the life of the single
 * Next.js server process, mirroring the previous in-ComfyUI behavior.
 */
let pending: { workflow: Record<string, unknown> | null; name: string | null } = {
  workflow: null,
  name: null,
};

/**
 * ComfyUI's front-end (on our non-standard loopback port) fetches this
 * cross-origin, so we echo back any loopback origin. We never use credentials,
 * so this is safe.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  const allow =
    origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
      ? origin
      : COMFYUI_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get("origin")),
  });
}

export async function POST(req: NextRequest) {
  const headers = corsHeaders(req.headers.get("origin"));

  let data: { workflow?: unknown; name?: unknown };
  try {
    data = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400, headers });
  }

  const workflow = data.workflow;
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    Array.isArray(workflow) ||
    Object.keys(workflow as object).length === 0
  ) {
    return NextResponse.json(
      { error: "missing or empty workflow" },
      { status: 400, headers }
    );
  }

  pending = {
    workflow: workflow as Record<string, unknown>,
    name: (typeof data.name === "string" && data.name) || "Vek-Snap Workflow",
  };
  return NextResponse.json({ ok: true }, { headers });
}

export async function GET(req: NextRequest) {
  const headers = corsHeaders(req.headers.get("origin"));
  const { workflow, name } = pending;
  // One-shot: clear immediately so a refresh won't reload it.
  pending = { workflow: null, name: null };
  if (workflow === null) {
    return NextResponse.json({ workflow: null }, { headers });
  }
  return NextResponse.json({ workflow, name }, { headers });
}
