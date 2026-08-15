/**
 * GET /api/components
 * Returns list of all known components with their installed status.
 *
 * POST /api/components
 * Actions: { action: "check-updates", ids?: string[] }
 *          { action: "update", id: string }
 *          { action: "create-restore-point", label?: string }
 *          { action: "list-restore-points" }
 *          { action: "apply-restore-point", id: string }
 *          { action: "delete-restore-point", id: string }
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  COMPONENT_REGISTRY,
  getAbsoluteInstallPath,
  classifySafety,
  parseSemver,
  type InstalledComponent,
  type UpdateInfo,
  type ComponentDef,
  type ComponentType,
} from "@/lib/component-registry";
import { readVekSnapSettings } from "@/lib/veksnap-settings";
import { getPythonPath } from "@/lib/python-path";

export const dynamic = "force-dynamic";

const INSTALL_ROOT = path.resolve(process.cwd(), "..");

type GitOpts = { cwd?: string; timeout?: number; ignore?: boolean };

/**
 * Run git with an explicit argv array (NO shell) so repo URLs, refs, tags, and
 * paths can never be interpreted as a command. Prevents command injection via a
 * component's registry entry OR a crafted upstream git tag/branch name.
 */
function git(args: string[], opts: GitOpts = {}): string {
  const out = execFileSync("git", args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    windowsHide: true,
    encoding: "utf-8",
    stdio: opts.ignore ? "ignore" : undefined,
  });
  return typeof out === "string" ? out : "";
}

// ── Scanning ──

function getGitInfo(dir: string): { hash: string; date: string } | null {
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) return null;
    const hash = git(["rev-parse", "--short", "HEAD"], { cwd: dir, timeout: 5000 }).trim();
    const date = git(["log", "-1", "--format=%ci"], { cwd: dir, timeout: 5000 }).trim();
    return { hash, date };
  } catch {
    return null;
  }
}

function getFileStat(filePath: string): { size: number; date: string } | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) return { size: stat.size, date: stat.mtime.toISOString() };
    return null;
  } catch {
    return null;
  }
}

/** Parse extra_model_paths.yaml to get all search directories for a given model subdir key */
function getExtraModelDirs(subdir: string): string[] {
  const dirs: string[] = [];
  const yamlPath = path.join(INSTALL_ROOT, "ComfyUI", "extra_model_paths.yaml");
  try {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    let basePath = "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const kv = trimmed.match(/^(\w[\w_-]*):\s*(.+)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      if (key === "base_path") {
        basePath = val.replace(/\//g, path.sep).replace(/["']/g, "");
      } else if (key === subdir && basePath) {
        dirs.push(path.join(basePath, val.trim()));
      }
    }
  } catch { /* yaml missing */ }
  return dirs;
}

/** Search for a file across primary path + extra model paths, including subdirectories */
function findFileInPaths(filename: string, primaryDir: string, extraDirs: string[]): { size: number; date: string } | null {
  // Check primary directory (recursive)
  const found = findFileRecursive(primaryDir, filename);
  if (found) return found;
  // Check each extra directory (recursive)
  for (const dir of extraDirs) {
    const result = findFileRecursive(dir, filename);
    if (result) return result;
  }
  return null;
}

/** Recursively search for a filename within a directory tree */
function findFileRecursive(dir: string, filename: string): { size: number; date: string } | null {
  try {
    // Direct check first (fast path)
    const direct = path.join(dir, filename);
    const stat = getFileStat(direct);
    if (stat) return stat;
    // Recursive search in subdirectories
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const result = findFileRecursive(path.join(dir, entry.name), filename);
        if (result) return result;
      }
    }
  } catch { /* dir doesn't exist */ }
  return null;
}

function scanComponent(comp: ComponentDef): InstalledComponent {
  const absPath = getAbsoluteInstallPath(comp);
  const result: InstalledComponent = { ...comp, installed: false };

  if (comp.versionDetect === "git") {
    const exists = fs.existsSync(absPath) && fs.existsSync(path.join(absPath, ".git"));
    result.installed = exists;
    if (exists) {
      const gitInfo = getGitInfo(absPath);
      if (gitInfo) {
        result.installedVersion = gitInfo.hash;
        result.installedDate = gitInfo.date;
      }
    }
  } else if (comp.versionDetect === "file-exists") {
    if (comp.source.file) {
      // Build list of filenames to check (primary + alternates)
      const filenames = [comp.source.file, ...(comp.alternateFiles || [])];
      // Build list of directories to search
      const extraDirs = comp.modelSubdir ? getExtraModelDirs(comp.modelSubdir) : [];

      for (const fname of filenames) {
        const found = findFileInPaths(fname, absPath, extraDirs);
        if (found) {
          result.installed = true;
          result.installedDate = found.date;
          result.fileSizeBytes = found.size;
          break;
        }
      }
    } else {
      // Directory-based check
      result.installed = fs.existsSync(absPath);
      if (result.installed) {
        try {
          const stat = fs.statSync(absPath);
          result.installedDate = stat.mtime.toISOString();
        } catch { /* ignore */ }
      }
    }
  } else {
    result.installed = fs.existsSync(absPath);
  }

  return result;
}

// ── Dynamic Custom Node Discovery ──

const CUSTOM_NODES_DIR = path.join(INSTALL_ROOT, "ComfyUI", "custom_nodes");
const SKIP_DIRS = new Set(["__pycache__", "ComfyUI-Manager", "veksnap_utils"]);

/** Auto-discover all git-tracked custom nodes and build ComponentDefs for them */
function discoverCustomNodes(): InstalledComponent[] {
  const results: InstalledComponent[] = [];
  try {
    const entries = fs.readdirSync(CUSTOM_NODES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const nodePath = path.join(CUSTOM_NODES_DIR, entry.name);
      const gitDir = path.join(nodePath, ".git");
      if (!fs.existsSync(gitDir)) continue;

      // Get remote URL
      let remote = "";
      try {
        remote = git(["remote", "get-url", "origin"], { cwd: nodePath, timeout: 5000 }).trim();
      } catch { /* no remote */ }

      // Extract owner/repo from URL
      let repo = "";
      const ghMatch = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      if (ghMatch) repo = ghMatch[1].replace(/\.git$/, "");

      const gitInfo = getGitInfo(nodePath);

      results.push({
        id: `node:${entry.name}`,
        name: entry.name,
        description: `ComfyUI custom node`,
        type: "module" as ComponentType,
        installPath: `ComfyUI/custom_nodes/${entry.name}`,
        source: { type: "github", repo },
        versionDetect: "git",
        tags: ["custom-node"],
        installed: true,
        installedVersion: gitInfo?.hash,
        installedDate: gitInfo?.date,
      });
    }
  } catch { /* custom_nodes dir missing */ }
  return results;
}

// ── Update Checking ──

/** GitHub API headers (auth-optional to relax rate limits). */
function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Newest published semver release tag (stable channel), or null if the repo publishes none. */
async function getLatestReleaseTag(owner: string, repo: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: ghHeaders(), signal: AbortSignal.timeout(10000),
    });
    if (r.ok) { const d = await r.json(); return (d.tag_name as string) || null; }
  } catch { /* no releases / network */ }
  return null;
}

/** Resolve a ref (tag / branch / sha) to its short commit sha. */
async function resolveRefToSha(owner: string, repo: string, ref: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
      headers: ghHeaders(), signal: AbortSignal.timeout(10000),
    });
    if (r.ok) { const d = await r.json(); return (d.sha as string)?.slice(0, 7) || null; }
  } catch { /* network */ }
  return null;
}

function isNodeComp(comp: ComponentDef): boolean {
  return (comp.tags || []).includes("custom-node") || comp.id.startsWith("node:");
}

/**
 * Resolve the ref an update would move TO, on the appropriate channel:
 *   • core github, release channel → newest release tag (falls back to branch HEAD if none)
 *   • custom nodes / head channel  → branch HEAD sha
 */
async function resolveTargetRef(comp: ComponentDef): Promise<{ ref?: string; isRelease: boolean }> {
  if (!comp.source.repo || !comp.source.repo.includes("/")) return { isRelease: false };
  const [owner, repo] = comp.source.repo.split("/");
  const channel = comp.updateChannel ?? "release";
  if (channel === "release" && !isNodeComp(comp)) {
    const tag = await getLatestReleaseTag(owner, repo);
    if (tag) return { ref: tag, isRelease: true };
  }
  const branch = comp.source.branch || "main";
  const sha = (await resolveRefToSha(owner, repo, branch)) || (await resolveRefToSha(owner, repo, "master"));
  return { ref: sha || undefined, isRelease: false };
}

async function checkGitHubUpdate(comp: ComponentDef, installed: InstalledComponent): Promise<UpdateInfo> {
  const info: UpdateInfo = {
    componentId: comp.id,
    currentVersion: installed.installedVersion,
    updateAvailable: false,
  };

  if (!installed.installed) {
    info.updateAvailable = true;
    info.latestVersion = "(not installed)";
    info.targetRef = comp.knownGoodRef;
    info.safety = "safe";
    info.safetyReason = "Fresh install of the staff-validated version.";
    info.requiresAck = false;
    return info;
  }

  try {
    if (!comp.source.repo || !comp.source.repo.includes("/")) return info;
    const [owner, repo] = comp.source.repo.split("/");
    if (!owner || !repo) return info;

    const { ref: targetRef, isRelease } = await resolveTargetRef(comp);
    if (!targetRef) return info;
    info.latestVersion = targetRef;
    info.targetRef = targetRef;

    const targetSha = isRelease ? await resolveRefToSha(owner, repo, targetRef) : targetRef;
    const cur = installed.installedVersion;
    info.updateAvailable = !!targetSha && !!cur
      ? !(targetSha.startsWith(cur) || cur.startsWith(targetSha))
      : !!targetRef;

    const cls = classifySafety({
      channel: isRelease ? "release" : "head",
      isNode: isNodeComp(comp),
      blessedRef: comp.knownGoodRef,
      targetRef,
      targetIsRelease: isRelease,
    });
    info.safety = cls.safety;
    info.safetyReason = cls.reason;
    info.requiresAck = cls.safety !== "safe";
  } catch { /* network error, skip */ }

  return info;
}

async function checkHuggingFaceUpdate(comp: ComponentDef, installed: InstalledComponent): Promise<UpdateInfo> {
  const info: UpdateInfo = {
    componentId: comp.id,
    currentVersion: installed.installedVersion,
    updateAvailable: false,
    // HuggingFace entries are data/model files, no engine code, so always SAFE.
    safety: "safe",
    safetyReason: "Data/model file update: no engine code changes.",
    requiresAck: false,
  };

  if (!installed.installed) {
    info.updateAvailable = true;
    info.latestVersion = "(not installed)";
    return info;
  }

  try {
    // Check repo last modified via HF API
    const resp = await fetch(
      `https://huggingface.co/api/models/${comp.source.repo}`,
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!resp.ok) return info;
    const data = await resp.json();
    info.latestDate = data.lastModified;

    // Compare dates if we have both
    if (installed.installedDate && data.lastModified) {
      const localDate = new Date(installed.installedDate).getTime();
      const remoteDate = new Date(data.lastModified).getTime();
      info.updateAvailable = remoteDate > localDate + 86400000; // 24h buffer
    }

    // For single-file models, check specific file info
    if (comp.source.file) {
      try {
        const fileResp = await fetch(
          `https://huggingface.co/api/models/${comp.source.repo}/tree/main`,
          {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (fileResp.ok) {
          const files = await fileResp.json() as { rfilename: string; size: number }[];
          const target = files.find((f: { rfilename: string }) => f.rfilename === comp.source.file);
          if (target) {
            info.downloadSizeBytes = target.size;
            // If local file size differs significantly, consider it an update
            if (installed.fileSizeBytes && Math.abs(installed.fileSizeBytes - target.size) > 1024) {
              info.updateAvailable = true;
            }
          }
        }
      } catch { /* skip file check */ }
    }
  } catch { /* network error, skip */ }

  return info;
}

// ── Update Execution ──

async function updateGitComponent(
  comp: ComponentDef,
  targetRef?: string,
  isTag?: boolean,
): Promise<{ ok: boolean; message: string }> {
  const absPath = getAbsoluteInstallPath(comp);
  const url = comp.source.repo.startsWith("http")
    ? comp.source.repo
    : `https://github.com/${comp.source.repo}.git`;
  try {
    if (!fs.existsSync(path.join(absPath, ".git"))) {
      // Fresh clone: pin to the target tag when we have one.
      const parentDir = path.dirname(absPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      if (targetRef && isTag) {
        git(["clone", "--depth", "1", "--branch", targetRef, url, absPath], { timeout: 180000 });
      } else {
        git(["clone", "--depth", "1", url, absPath], { timeout: 180000 });
      }
      return { ok: true, message: `Cloned ${comp.name}${targetRef ? ` @ ${targetRef}` : ""}` };
    }
    if (targetRef) {
      // Fetch the specific ref (tag or commit), then hard-reset to it, no more blind
      // jump to origin/HEAD. Falls back to a full tag fetch if the shallow fetch fails.
      try {
        git(["fetch", "--depth", "1", "origin", ...(isTag ? ["tag", targetRef] : [targetRef])], { cwd: absPath, timeout: 120000, ignore: true });
      } catch {
        try { git(["fetch", "--tags", "origin"], { cwd: absPath, timeout: 120000, ignore: true }); } catch { /* may already have it */ }
      }
      git(["reset", "--hard", targetRef], { cwd: absPath, timeout: 60000 });
      return { ok: true, message: `Updated ${comp.name} to ${targetRef}` };
    }
    // Legacy fallback: latest HEAD.
    git(["fetch", "--depth", "1", "origin"], { cwd: absPath, timeout: 120000 });
    git(["reset", "--hard", "origin/HEAD"], { cwd: absPath, timeout: 120000 });
    return { ok: true, message: `Updated ${comp.name}` };
  } catch (e) {
    return { ok: false, message: `Failed to update ${comp.name}: ${(e as Error).message}` };
  }
}

/**
 * Run a component's declared post-update steps after a successful git update:
 *   • pipInstall: sync Python deps (`pip install -r requirements.txt`, NO `-U` => torch held)
 *   • corePatches: kept EMPTY in this shipped tree (ComfyUI core stays pristine; GPL)
 * Returns a human-readable step list. Never throws (best-effort; failures are reported, not fatal).
 */
async function runPostUpdate(comp: ComponentDef, absPath: string): Promise<string[]> {
  const spec = comp.postUpdate;
  const steps: string[] = [];
  if (!spec) return steps;

  if (spec.pipInstall) {
    const req = path.join(absPath, "requirements.txt");
    const py = getPythonPath();
    if (py === "python" || !fs.existsSync(py)) {
      steps.push("⚠ pip skipped: Python interpreter not found");
    } else if (!fs.existsSync(req)) {
      steps.push("⚠ pip skipped: requirements.txt not found");
    } else {
      try {
        execFileSync(py, ["-m", "pip", "install", "-r", req], { cwd: absPath, timeout: 600000, windowsHide: true, stdio: "ignore" });
        steps.push("✓ deps synced (pip install -r requirements.txt; torch held, no -U)");
      } catch (e) {
        steps.push(`✗ pip install failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  for (const patch of spec.corePatches ?? []) {
    const patchPath = path.isAbsolute(patch.file) ? patch.file : path.join(process.cwd(), patch.file);
    if (!fs.existsSync(patchPath)) { steps.push(`⚠ patch ${patch.id}: file not found, skipped`); continue; }
    try {
      git(["apply", "--reverse", "--check", patchPath], { cwd: absPath, timeout: 15000, ignore: true });
      steps.push(`• patch ${patch.id}: already applied`);
      continue;
    } catch { /* not applied yet */ }
    try {
      git(["apply", "--check", patchPath], { cwd: absPath, timeout: 15000, ignore: true });
    } catch {
      steps.push(`⚠ patch ${patch.id}: does not apply to this version, skipped`);
      continue;
    }
    try {
      git(["apply", patchPath], { cwd: absPath, timeout: 15000 });
      steps.push(`✓ patch ${patch.id}: applied`);
    } catch (e) {
      steps.push(`✗ patch ${patch.id}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return steps;
}

async function updateHuggingFaceComponent(comp: ComponentDef): Promise<{ ok: boolean; message: string }> {
  if (!comp.source.file) {
    return { ok: false, message: `No specific file defined for ${comp.name}: HF repo downloads not yet supported` };
  }

  const absPath = getAbsoluteInstallPath(comp);
  const targetFile = path.join(absPath, comp.source.file);

  try {
    if (!fs.existsSync(absPath)) fs.mkdirSync(absPath, { recursive: true });

    const url = `https://huggingface.co/${comp.source.repo}/resolve/main/${comp.source.file}`;

    // Use Python + huggingface_hub for robust download with resume support
    const python = getPythonPath();
    if (python !== "python" && fs.existsSync(python)) {
      // argv form: repo/file/dir are passed as discrete process args (via sys.argv),
      // so neither the shell NOR the Python string literal can be injected.
      const pyScript = "import sys; from huggingface_hub import hf_hub_download; hf_hub_download(sys.argv[1], sys.argv[2], local_dir=sys.argv[3], local_dir_use_symlinks=False)";
      execFileSync(python, ["-c", pyScript, comp.source.repo, comp.source.file, absPath], { timeout: 600000, windowsHide: true });
    } else {
      // Fallback: direct fetch (no resume, but works)
      const resp = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(targetFile, buffer);
    }

    return { ok: true, message: `Downloaded ${comp.source.file} (${comp.name})` };
  } catch (e) {
    return { ok: false, message: `Failed to download ${comp.name}: ${(e as Error).message}` };
  }
}

// ── Restore Points ──

interface RestorePointEntry {
  id: string;           // node directory name or component id
  name: string;
  hash: string;         // git commit hash (full)
  path: string;         // relative path from INSTALL_ROOT
}

interface RestorePoint {
  id: string;           // unique ID (timestamp-based)
  label: string;
  createdAt: string;    // ISO date
  entries: RestorePointEntry[];
  trigger: "manual" | "auto-pre-update";
}

const RESTORE_POINTS_FILE = path.join(INSTALL_ROOT, "veksnap-app", "restore-points.json");
const MAX_RESTORE_POINTS = 20;

function readRestorePoints(): RestorePoint[] {
  try {
    if (!fs.existsSync(RESTORE_POINTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(RESTORE_POINTS_FILE, "utf-8"));
  } catch { return []; }
}

function writeRestorePoints(points: RestorePoint[]) {
  fs.writeFileSync(RESTORE_POINTS_FILE, JSON.stringify(points, null, 2), "utf-8");
}

/** Capture current git hashes for all git-tracked components */
function captureSystemState(): RestorePointEntry[] {
  const entries: RestorePointEntry[] = [];

  // Custom nodes
  try {
    const dirs = fs.readdirSync(CUSTOM_NODES_DIR, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const nodePath = path.join(CUSTOM_NODES_DIR, entry.name);
      if (!fs.existsSync(path.join(nodePath, ".git"))) continue;
      try {
        const hash = git(["rev-parse", "HEAD"], { cwd: nodePath, timeout: 5000 }).trim();
        entries.push({
          id: `node:${entry.name}`,
          name: entry.name,
          hash,
          path: `ComfyUI/custom_nodes/${entry.name}`,
        });
      } catch { /* skip */ }
    }
  } catch { /* custom_nodes missing */ }

  // Registry git components (ComfyUI itself, etc.)
  for (const comp of COMPONENT_REGISTRY) {
    if (comp.versionDetect !== "git") continue;
    const absPath = getAbsoluteInstallPath(comp);
    if (!fs.existsSync(path.join(absPath, ".git"))) continue;
    try {
      const hash = git(["rev-parse", "HEAD"], { cwd: absPath, timeout: 5000 }).trim();
      entries.push({
        id: comp.id,
        name: comp.name,
        hash,
        path: comp.installPath,
      });
    } catch { /* skip */ }
  }

  return entries;
}

function createRestorePoint(label: string, trigger: "manual" | "auto-pre-update"): RestorePoint {
  const point: RestorePoint = {
    id: `rp-${Date.now()}`,
    label,
    createdAt: new Date().toISOString(),
    entries: captureSystemState(),
    trigger,
  };

  const points = readRestorePoints();
  points.unshift(point);
  // Trim to max
  if (points.length > MAX_RESTORE_POINTS) points.length = MAX_RESTORE_POINTS;
  writeRestorePoints(points);
  return point;
}

function applyRestorePoint(pointId: string, allowOnline: boolean): { ok: boolean; message: string; details: string[] } {
  const points = readRestorePoints();
  const point = points.find((p) => p.id === pointId);
  if (!point) return { ok: false, message: "Restore point not found", details: [] };

  const details: string[] = [];
  let hasError = false;

  for (const entry of point.entries) {
    const absPath = path.isAbsolute(entry.path) ? entry.path : path.join(INSTALL_ROOT, entry.path);
    if (!fs.existsSync(path.join(absPath, ".git"))) {
      details.push(`⚠ ${entry.name}: directory missing, skipped`);
      continue;
    }

    try {
      // Privacy: only reach the network to re-fetch a missing commit when the user has
      // opened the online gate. Offline, we rely on the commit already being present
      // locally (it usually is): no silent outbound connection (see 10_SECURITY §5.4).
      if (allowOnline) {
        try {
          git(["fetch", "--depth", "1", "origin", entry.hash], {
            cwd: absPath, timeout: 30000, ignore: true,
          });
        } catch { /* may already have the commit locally */ }
      }

      git(["checkout", entry.hash], {
        cwd: absPath, timeout: 10000,
      });
      details.push(`✓ ${entry.name}: restored to ${entry.hash.slice(0, 7)}`);
    } catch (e) {
      hasError = true;
      const msg = (e as Error).message.split("\n")[0];
      const hint = !allowOnline ? " (commit may not be present locally: enable Online mode and retry)" : "";
      details.push(`✗ ${entry.name}: failed, ${msg}${hint}`);
    }
  }

  return {
    ok: !hasError,
    message: hasError ? "Restore completed with some errors" : `Restored ${point.entries.length} components to "${point.label}"`,
    details,
  };
}

// ── API Handlers ──

export async function GET() {
  const registryComponents = COMPONENT_REGISTRY.map(scanComponent);
  const customNodes = discoverCustomNodes();
  return NextResponse.json({ components: [...registryComponents, ...customNodes] });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const settings = readVekSnapSettings();

  if (body.action === "check-updates") {
    if (!settings.allowOnline) {
      return NextResponse.json(
        { error: "System is in offline mode. Enable online mode to check for updates." },
        { status: 403 }
      );
    }

    // Build full component list (registry + custom nodes)
    const customNodes = discoverCustomNodes();
    const allComponents: InstalledComponent[] = [...COMPONENT_REGISTRY.map(scanComponent), ...customNodes];
    const ids: string[] = body.ids || allComponents.map((c) => c.id);
    const updates: UpdateInfo[] = [];

    for (const id of ids) {
      const comp = allComponents.find((c) => c.id === id);
      if (!comp) continue;

      if (comp.source.type === "github" && comp.source.repo) {
        updates.push(await checkGitHubUpdate(comp, comp));
      } else if (comp.source.type === "huggingface") {
        updates.push(await checkHuggingFaceUpdate(comp, comp));
      }
    }

    return NextResponse.json({ updates });
  }

  if (body.action === "update") {
    if (!settings.allowOnline) {
      return NextResponse.json(
        { error: "System is in offline mode. Enable online mode to download updates." },
        { status: 403 }
      );
    }

    // Look in registry first, then custom nodes
    let comp: ComponentDef | InstalledComponent | undefined = COMPONENT_REGISTRY.find((c) => c.id === body.id);
    if (!comp) {
      const customNodes = discoverCustomNodes();
      comp = customNodes.find((c) => c.id === body.id);
    }
    if (!comp) {
      return NextResponse.json({ error: `Unknown component: ${body.id}` }, { status: 404 });
    }

    // ── Safe-upgrade gate ──
    // Resolve where this update would move to, classify it, and REFUSE non-safe
    // upgrades unless the caller explicitly accepts responsibility (acceptRisk).
    let targetRef: string | undefined;
    let isRelease = false;
    if (comp.source.type === "github") {
      if (typeof body.ref === "string" && body.ref) {
        targetRef = body.ref;
        isRelease = !!parseSemver(body.ref);
      } else {
        const resolved = await resolveTargetRef(comp);
        targetRef = resolved.ref;
        isRelease = resolved.isRelease;
      }
      const cls = classifySafety({
        channel: isRelease ? "release" : "head",
        isNode: isNodeComp(comp),
        blessedRef: comp.knownGoodRef,
        targetRef,
        targetIsRelease: isRelease,
      });
      if (cls.safety !== "safe" && body.acceptRisk !== true) {
        return NextResponse.json({
          ok: false,
          requiresAck: true,
          safety: cls.safety,
          safetyReason: cls.reason,
          targetRef,
          message: `This update is classified ${cls.safety.toUpperCase()}: ${cls.reason} Re-run with acceptRisk=true to proceed (you assume responsibility).`,
        }, { status: 409 });
      }
    }

    // Auto-create restore point before update (unless user opted out)
    if (body.skipRestorePoint !== true) {
      createRestorePoint(`Pre-update: ${comp.name}${targetRef ? ` → ${targetRef}` : ""}`, "auto-pre-update");
    }

    let result: { ok: boolean; message: string; postUpdate?: string[] };
    if (comp.source.type === "github") {
      result = await updateGitComponent(comp, targetRef, isRelease);
      // After a successful git bump, sync deps (opt-out via runPostUpdate:false).
      if (result.ok && comp.postUpdate && body.runPostUpdate !== false) {
        const steps = await runPostUpdate(comp, getAbsoluteInstallPath(comp));
        if (steps.length) {
          result = { ...result, postUpdate: steps, message: `${result.message}\nPost-update:\n  ${steps.join("\n  ")}` };
        }
      }
    } else if (comp.source.type === "huggingface") {
      result = await updateHuggingFaceComponent(comp);
    } else {
      result = { ok: false, message: "Unsupported source type" };
    }

    return NextResponse.json(result);
  }

  if (body.action === "plan") {
    if (!settings.allowOnline) {
      return NextResponse.json(
        { error: "System is in offline mode. Enable online mode to plan updates." },
        { status: 403 }
      );
    }
    const customNodes = discoverCustomNodes();
    const allComponents: InstalledComponent[] = [...COMPONENT_REGISTRY.map(scanComponent), ...customNodes];
    const ids: string[] = body.ids || allComponents.map((c) => c.id);
    const plan: (UpdateInfo & { name: string; type: string })[] = [];
    for (const id of ids) {
      const comp = allComponents.find((c) => c.id === id);
      if (!comp) continue;
      let info: UpdateInfo;
      if (comp.source.type === "github" && comp.source.repo) {
        info = await checkGitHubUpdate(comp, comp);
      } else if (comp.source.type === "huggingface") {
        info = await checkHuggingFaceUpdate(comp, comp);
      } else {
        continue;
      }
      plan.push({ ...info, name: comp.name, type: (comp.tags || []).includes("custom-node") ? "custom-node" : comp.type });
    }
    return NextResponse.json({ plan });
  }

  // ── Restore Point Actions ──

  if (body.action === "create-restore-point") {
    const label = body.label || `Manual snapshot: ${new Date().toLocaleString()}`;
    const point = createRestorePoint(label, "manual");
    return NextResponse.json({ ok: true, restorePoint: point });
  }

  if (body.action === "list-restore-points") {
    const points = readRestorePoints();
    return NextResponse.json({ restorePoints: points });
  }

  if (body.action === "apply-restore-point") {
    if (!body.id) {
      return NextResponse.json({ error: "Missing restore point ID" }, { status: 400 });
    }
    const result = applyRestorePoint(body.id, settings.allowOnline);
    return NextResponse.json(result);
  }

  if (body.action === "delete-restore-point") {
    if (!body.id) {
      return NextResponse.json({ error: "Missing restore point ID" }, { status: 400 });
    }
    const points = readRestorePoints();
    const filtered = points.filter((p) => p.id !== body.id);
    if (filtered.length === points.length) {
      return NextResponse.json({ error: "Restore point not found" }, { status: 404 });
    }
    writeRestorePoints(filtered);
    return NextResponse.json({ ok: true, message: "Restore point deleted" });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
