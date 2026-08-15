import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Timeline media relink / scan (industry-standard "offline media" recovery).
//
// When source files are moved on disk a project's absolute `filePath`s go stale
// and previews/exports show offline clips. This route:
//   • mode "status": reports which targets are offline (path no longer exists).
//   • mode "scan":   recursively walks a chosen folder and proposes a new path
//                    for each offline target: matched first by exact filename,
//                    then by same stem/different extension. Bounded so a huge
//                    tree can't hang the server.
// The client applies the chosen matches via the store's relinkAssets().
// ─────────────────────────────────────────────────────────────────────────────

interface Target { id: string; name: string; filePath?: string }

const MAX_ENTRIES = 40000; // hard cap on files visited during a scan
const MAX_DEPTH = 8;

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

// Walk `root` breadth-first, collecting basename → first path and stem → paths.
async function indexFolder(root: string): Promise<{ byName: Map<string, string>; byStem: Map<string, string[]> }> {
  const byName = new Map<string, string>();
  const byStem = new Map<string, string[]>();
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (depth > MAX_DEPTH || visited > MAX_ENTRIES) break;
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (visited > MAX_ENTRIES) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        visited++;
        const lower = e.name.toLowerCase();
        if (!byName.has(lower)) byName.set(lower, full);
        const stem = lower.slice(0, lower.length - path.extname(lower).length);
        if (stem) { const arr = byStem.get(stem) ?? []; arr.push(full); byStem.set(stem, arr); }
      }
    }
  }
  return { byName, byStem };
}

export async function POST(req: NextRequest) {
  let body: { mode?: string; folder?: string; targets?: Target[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const targets = Array.isArray(body.targets) ? body.targets : [];

  if (body.mode === "status") {
    const offline: string[] = [];
    await Promise.all(targets.map(async (t) => {
      if (!t.filePath || !(await pathExists(t.filePath))) offline.push(t.id);
    }));
    return NextResponse.json({ offline });
  }

  if (body.mode === "scan") {
    const folder = String(body.folder ?? "");
    if (!folder || !(await pathExists(folder))) {
      return NextResponse.json({ error: "Folder not found" }, { status: 400 });
    }
    const { byName, byStem } = await indexFolder(folder);
    const matches = targets.map((t) => {
      const nameLower = (t.name ?? "").toLowerCase();
      const stem = nameLower.slice(0, nameLower.length - path.extname(nameLower).length);
      // 1) exact filename, 2) same stem (different container/extension).
      const exact = byName.get(nameLower);
      const byStemHit = !exact && stem ? (byStem.get(stem)?.[0] ?? null) : null;
      const found = exact ?? byStemHit ?? null;
      return { id: t.id, name: t.name, path: found, match: exact ? "exact" : byStemHit ? "stem" : "none" as const };
    });
    return NextResponse.json({ matches, scanned: byName.size });
  }

  return NextResponse.json({ error: "Unknown mode" }, { status: 400 });
}
