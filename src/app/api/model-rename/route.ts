import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isInsideAllowedRoots } from "@/lib/model-paths";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Guarded model/LoRA file rename.
//
// Safety rules:
//   • The source must be an existing file inside a configured model root.
//   • The new name is reduced to a bare basename (no path separators / traversal)
//     and the ORIGINAL extension is always preserved (rename ≠ retype).
//   • Refuses to overwrite an existing file.
//   • Moves the `<stem>.model-meta.json` sidecar alongside, so user-curated
//     trigger words / notes / category survive the rename.
//   • Auto-updates references to the old filename in saved workflow configs under
//     <root>/UserConfigs so presets keep pointing at the model.
//
// Fully offline; touches only the model directory and the local UserConfigs tree.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_ROOT = path.resolve(process.cwd(), "..", "UserConfigs");
const SIDECAR_SUFFIX = ".model-meta.json";
// Windows-illegal filename characters (also covers path separators).
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;

function sidecarFor(modelAbsPath: string): string {
  const dir = path.dirname(modelAbsPath);
  const ext = path.extname(modelAbsPath);
  return path.join(dir, path.basename(modelAbsPath, ext) + SIDECAR_SUFFIX);
}

/** Remap a single string value if it names (or path-qualifies) the old filename. */
function remapString(s: string, oldName: string, newName: string): string {
  if (s === oldName) return newName;
  for (const sep of ["/", "\\"]) {
    if (s.endsWith(sep + oldName)) return s.slice(0, s.length - oldName.length) + newName;
  }
  return s;
}

/** Deep-transform any JSON value, remapping filename references. Returns [value, changeCount]. */
function transform(node: unknown, oldName: string, newName: string): [unknown, number] {
  if (typeof node === "string") {
    const next = remapString(node, oldName, newName);
    return [next, next !== node ? 1 : 0];
  }
  if (Array.isArray(node)) {
    let count = 0;
    const arr = node.map((x) => {
      const [v, c] = transform(x, oldName, newName);
      count += c;
      return v;
    });
    return [arr, count];
  }
  if (node && typeof node === "object") {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      const [v, c] = transform((node as Record<string, unknown>)[k], oldName, newName);
      count += c;
      out[k] = v;
    }
    return [out, count];
  }
  return [node, 0];
}

/** Recursively collect every config.json under the UserConfigs tree. */
function findConfigFiles(root: string, depth = 0): string[] {
  if (depth > 6 || !fs.existsSync(root)) return [];
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...findConfigFiles(full, depth + 1));
    else if (e.isFile() && e.name === "config.json") out.push(full);
  }
  return out;
}

function updateConfigReferences(oldName: string, newName: string): { filesUpdated: number; refsUpdated: number } {
  let filesUpdated = 0;
  let refsUpdated = 0;
  for (const file of findConfigFiles(CONFIG_ROOT)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      const [next, count] = transform(parsed, oldName, newName);
      if (count > 0) {
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf-8");
        filesUpdated += 1;
        refsUpdated += count;
      }
    } catch { /* skip unreadable / non-JSON */ }
  }
  return { filesUpdated, refsUpdated };
}

export async function POST(req: NextRequest) {
  let body: { path?: string; newName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const src = body.path;
  if (typeof src !== "string" || !src.trim()) {
    return NextResponse.json({ ok: false, error: "A source path is required." }, { status: 400 });
  }
  const abs = path.resolve(src);
  if (!isInsideAllowedRoots(abs)) {
    return NextResponse.json({ ok: false, error: "Path is outside the configured model directories." }, { status: 400 });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return NextResponse.json({ ok: false, error: "Model file not found." }, { status: 400 });
  }

  // Reduce the requested name to a safe basename; always keep the original extension.
  const ext = path.extname(abs);
  const requested = typeof body.newName === "string" ? body.newName.trim() : "";
  const baseNoExt = path.basename(requested, path.extname(requested));
  if (!baseNoExt) {
    return NextResponse.json({ ok: false, error: "A new name is required." }, { status: 400 });
  }
  if (ILLEGAL.test(baseNoExt) || baseNoExt === "." || baseNoExt === "..") {
    return NextResponse.json({ ok: false, error: "New name contains invalid characters." }, { status: 400 });
  }

  const dir = path.dirname(abs);
  const newAbs = path.join(dir, baseNoExt + ext);

  if (path.resolve(newAbs) === abs) {
    return NextResponse.json({ ok: false, error: "New name is the same as the current name." }, { status: 400 });
  }
  if (fs.existsSync(newAbs)) {
    return NextResponse.json({ ok: false, error: `A file named "${baseNoExt + ext}" already exists here.` }, { status: 409 });
  }

  const oldName = path.basename(abs);
  const newName = path.basename(newAbs);

  try {
    fs.renameSync(abs, newAbs);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Rename failed: ${(e as Error).message}` }, { status: 500 });
  }

  // Move the metadata sidecar so curated data follows the file (best-effort).
  let sidecarMoved = false;
  try {
    const oldSidecar = sidecarFor(abs);
    const newSidecar = sidecarFor(newAbs);
    if (fs.existsSync(oldSidecar) && !fs.existsSync(newSidecar)) {
      fs.renameSync(oldSidecar, newSidecar);
      sidecarMoved = true;
    }
  } catch { /* non-fatal */ }

  const { filesUpdated, refsUpdated } = updateConfigReferences(oldName, newName);

  return NextResponse.json({
    ok: true,
    oldName,
    newName,
    newPath: newAbs,
    sidecarMoved,
    filesUpdated,
    refsUpdated,
  });
}
