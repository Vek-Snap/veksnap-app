import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Per-workflow configuration store (Timeline Integration, Phase 1).
//
// Saves a SINGLE workflow's parameter set to a named, self-contained folder on
// disk (independent of the app-wide Quick Save, which stores ALL studios at
// once). Layout, under the program directory so it survives app updates:
//
//   <SABA_ROOT>/UserConfigs/<workflow>/<name>/config.json
//   <SABA_ROOT>/UserConfigs/<workflow>/<name>/resources/<file>   (optional)
//
// The optional resource copy exists because a saved configuration often depends
// on an external asset (e.g. a DramaBox voice reference living in ComfyUI/input,
// which is ephemeral): copying it beside the config guarantees the state can be
// reproduced later even if the original file is moved or cleaned.
// ─────────────────────────────────────────────────────────────────────────────

// The Next server runs with cwd = <SABA_ROOT>/saba-app, so ".." is the program
// root (sibling to ComfyUI/, Temp/, .cache/). Same convention as saba-settings.
const CONFIG_ROOT = path.resolve(process.cwd(), "..", "UserConfigs");
const COMFY_INPUT = path.resolve(process.cwd(), "..", "ComfyUI", "input");

const WORKFLOW_RE = /^[a-z0-9_-]{1,40}$/;

/** Filesystem-safe display name: keep it readable but strip path separators and
 *  control/reserved characters. Empty → null (caller auto-numbers). */
function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 60).trim();
  return cleaned.length ? cleaned : null;
}

function workflowDir(workflow: string): string {
  return path.join(CONFIG_ROOT, workflow);
}
function configDir(workflow: string, name: string): string {
  return path.join(workflowDir(workflow), name);
}

interface ResourceRef { label: string; fileName: string }
interface StoredConfig {
  workflow: string;
  name: string;
  savedAt: string;
  params: unknown;
  resources: ResourceRef[];
}

async function listConfigs(workflow: string) {
  const dir = workflowDir(workflow);
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: { name: string; savedAt: string; resourceCount: number }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cfgPath = path.join(dir, e.name, "config.json");
    try {
      const parsed = JSON.parse(await fsp.readFile(cfgPath, "utf-8")) as StoredConfig;
      out.push({ name: parsed.name ?? e.name, savedAt: parsed.savedAt ?? "", resourceCount: parsed.resources?.length ?? 0 });
    } catch {
      /* not a valid config folder, skip */
    }
  }
  // Newest first.
  out.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  return out;
}

/** Next free "Configuration N" for a workflow (1-based, skips existing). */
async function nextAutoName(workflow: string): Promise<string> {
  const existing = new Set((await listConfigs(workflow)).map((c) => c.name.toLowerCase()));
  for (let i = 1; i < 10000; i++) {
    const candidate = `Configuration ${i}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  return `Configuration ${Date.now()}`;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const workflow = url.searchParams.get("workflow") ?? "";
    if (!WORKFLOW_RE.test(workflow)) return NextResponse.json({ ok: false, error: "Invalid workflow id" }, { status: 400 });

    const name = sanitizeName(url.searchParams.get("name"));
    if (!name) {
      // List mode.
      return NextResponse.json({ ok: true, configs: await listConfigs(workflow) });
    }
    // Single-config load.
    const cfgPath = path.join(configDir(workflow, name), "config.json");
    if (!fs.existsSync(cfgPath)) return NextResponse.json({ ok: false, error: "Configuration not found" }, { status: 404 });
    const parsed = JSON.parse(await fsp.readFile(cfgPath, "utf-8")) as StoredConfig;
    const resDir = path.join(configDir(workflow, name), "resources");
    const resources = (parsed.resources ?? []).map((r) => ({ ...r, absPath: path.join(resDir, r.fileName) }));
    return NextResponse.json({ ok: true, config: { ...parsed, resources } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Read failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = body?.action as string;
    const workflow = body?.workflow as string;
    if (!WORKFLOW_RE.test(workflow ?? "")) return NextResponse.json({ ok: false, error: "Invalid workflow id" }, { status: 400 });

    if (action === "delete") {
      const name = sanitizeName(body?.name);
      if (!name) return NextResponse.json({ ok: false, error: "Missing name" }, { status: 400 });
      const dir = configDir(workflow, name);
      if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
      return NextResponse.json({ ok: true });
    }

    if (action === "save") {
      const name = sanitizeName(body?.name) ?? (await nextAutoName(workflow));
      const dir = configDir(workflow, name);
      if (fs.existsSync(dir) && !body?.overwrite) {
        return NextResponse.json({ ok: false, error: "exists", name }, { status: 409 });
      }
      await fsp.mkdir(dir, { recursive: true });

      // Optional resource copy: [{ label, srcPath }] - srcPath is an absolute
      // disk path the client resolved (e.g. ComfyUI/input/<ref voice>).
      const resources: ResourceRef[] = [];
      const requested = Array.isArray(body?.resources) ? body.resources : [];
      if (requested.length) {
        const resDir = path.join(dir, "resources");
        await fsp.mkdir(resDir, { recursive: true });
        for (const r of requested) {
          // Accept either an absolute srcPath or a ComfyUI/input filename.
          let srcPath = typeof r?.srcPath === "string" ? r.srcPath : "";
          if (!srcPath && typeof r?.comfyInput === "string" && r.comfyInput) {
            srcPath = path.join(COMFY_INPUT, path.basename(r.comfyInput));
          }
          if (!srcPath || !fs.existsSync(srcPath)) continue;
          const base = path.basename(srcPath).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
          await fsp.copyFile(srcPath, path.join(resDir, base));
          resources.push({ label: typeof r?.label === "string" ? r.label : base, fileName: base });
        }
      }

      const stored: StoredConfig = {
        workflow,
        name,
        savedAt: new Date().toISOString(),
        params: body?.params ?? {},
        resources,
      };
      await fsp.writeFile(path.join(dir, "config.json"), JSON.stringify(stored, null, 2) + "\n", "utf-8");
      return NextResponse.json({ ok: true, name, savedAt: stored.savedAt, resources });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Write failed" }, { status: 500 });
  }
}
