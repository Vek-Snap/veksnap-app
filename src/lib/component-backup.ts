/**
 * Full file-level component backup ("Vek-Snap Verified Restore Point").
 *
 * Unlike the lightweight git-hash restore points (which only record which commit
 * each component was on and therefore need the commit to be re-fetchable), a full
 * backup captures the ACTUAL files into a single sealed, compressed archive. That
 * makes rollback:
 *   - fully offline (no git remote, no network, ever), and
 *   - version-independent (the exact bytes are preserved, not just a pointer).
 *
 * Archive format: a single `veksnap-restore_<ts>.tar.br` - a `tar` stream (ISC
 * licensed, pure-JS) piped through Node's built-in Brotli (zlib). The archive
 * embeds a `__veksnap_seal__.json` manifest at its root (app version, ComfyUI
 * ref, per-scope git hashes, scopes, timestamp) and its SHA-256 is recorded in
 * the local index for tamper detection. No external binaries, no network.
 *
 * SERVER-ONLY (uses fs / child_process / os). Import from API routes only.
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import zlib from "zlib";
import { execSync } from "child_process";
import { pipeline } from "stream/promises";
import * as tar from "tar";

/** Install root (one level above the Next.js app, matching the components route). */
const ROOT = path.resolve(process.cwd(), "..");
const COMFYUI = path.join(ROOT, "ComfyUI");
// User-facing, NON-hidden folder in the install root so restore points are easy
// to find, copy, or archive. (Was the hidden ".component-backups"; see
// migrateLegacyBackupDir() for the one-time move of any existing snapshots.)
const BACKUP_DIR = path.join(ROOT, "Restore Points");
const LEGACY_BACKUP_DIR = path.join(ROOT, ".component-backups");
const INDEX_FILE = path.join(BACKUP_DIR, "index.json");
const TRASH_DIR = path.join(BACKUP_DIR, ".restore-trash");
const SEAL_NAME = "__veksnap_seal__.json";
const SEAL_MARK = "Vek-Snap Verified Restore Point";
const FORMAT_VERSION = 1;

/** Rough brotli quality: favour speed over max ratio for multi-GB trees. */
const BROTLI_QUALITY = 5;
/** Estimated read+compress throughput (bytes/sec) used only for time hints. */
const THROUGHPUT_BPS = 35 * 1024 * 1024;

/** Directory names never worth archiving (caches / prior backups / vcs noise). */
const EXCLUDED_DIR_NAMES = new Set([
  "__pycache__", ".mypy_cache", ".pytest_cache", "node_modules",
  "Restore Points", ".component-backups",
]);
/** Model-weight extensions excluded from CODE scopes (re-downloadable, huge). */
const WEIGHT_EXTS = new Set([
  ".safetensors", ".ckpt", ".pth", ".pt", ".bin", ".onnx", ".gguf",
  ".msgpack", ".h5", ".pkl", ".sft",
]);

export type BackupScopeId =
  | "comfyui-core" | "custom-nodes" | "python-env" | "user-data" | "models";

interface ScopeDef {
  id: BackupScopeId;
  label: string;
  description: string;
  /** Top-level entries (relative to ROOT) that make up this scope. */
  roots: () => string[];
  /** Exclude model-weight files (true for code scopes). */
  excludeWeights: boolean;
  /** Rough compressed/source ratio for the size estimate. */
  ratio: number;
}

/** Resolve the Python environment dir (venv preferred, then conda), F/Y agnostic. */
function pythonEnvDir(): string | null {
  const candidates = [
    path.join(ROOT, "venv"),
    path.join(ROOT, "ComfyUI", "venv"),
    path.join(ROOT, "miniconda", "envs", "comfyui"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Immediate children of ComfyUI/ that are neither data dirs nor other scopes. */
function comfyCoreRoots(): string[] {
  const dataDirs = new Set([
    "custom_nodes", "models", "output", "input", "user", "temp", "checkpoints",
  ]);
  let children: string[] = [];
  try {
    children = fs.readdirSync(COMFYUI, { withFileTypes: true })
      .filter((d) => !dataDirs.has(d.name))
      .filter((d) => !/^_.*backup/i.test(d.name))
      .filter((d) => !EXCLUDED_DIR_NAMES.has(d.name))
      .map((d) => path.posix.join("ComfyUI", d.name));
  } catch { /* ComfyUI missing */ }
  return children;
}

const SCOPES: ScopeDef[] = [
  {
    id: "comfyui-core",
    label: "ComfyUI core (code)",
    description: "ComfyUI application source, excluding models, outputs and custom nodes.",
    roots: comfyCoreRoots,
    excludeWeights: true,
    ratio: 0.32,
  },
  {
    id: "custom-nodes",
    label: "Custom nodes (code)",
    description: "All installed custom node source under ComfyUI/custom_nodes.",
    roots: () => ["ComfyUI/custom_nodes"],
    excludeWeights: true,
    ratio: 0.32,
  },
  {
    id: "python-env",
    label: "Python environment",
    description: "The full Python venv/conda env (bulletproof offline rollback of dependencies). Large.",
    roots: () => {
      const env = pythonEnvDir();
      return env ? [path.posix.join(...path.relative(ROOT, env).split(path.sep))] : [];
    },
    excludeWeights: false,
    ratio: 0.45,
  },
  {
    id: "user-data",
    label: "User settings & workflows",
    description: "ComfyUI/user (saved workflows, settings) and model-path config.",
    roots: () => ["ComfyUI/user", "ComfyUI/extra_model_paths.yaml"].filter((r) => fs.existsSync(path.join(ROOT, r))),
    excludeWeights: false,
    ratio: 0.5,
  },
  {
    id: "models",
    label: "Model weights (very large)",
    description: "ComfyUI/models. Usually unnecessary: models are re-downloadable via the catalog. Expect many GB and near-zero compression.",
    roots: () => ["ComfyUI/models"],
    excludeWeights: false,
    ratio: 0.98,
  },
];

export function listScopes() {
  return SCOPES.map((s) => ({ id: s.id, label: s.label, description: s.description }));
}

function scopeById(id: BackupScopeId): ScopeDef | undefined {
  return SCOPES.find((s) => s.id === id);
}

/** True if this relative path (posix) should be included given a scope's rules. */
function makeFilter(excludeWeights: boolean) {
  return (entryPath: string): boolean => {
    const norm = entryPath.replace(/\\/g, "/");
    const segments = norm.split("/");
    for (const seg of segments) {
      if (EXCLUDED_DIR_NAMES.has(seg)) return false;
      if (/^_.*backup/i.test(seg)) return false;
    }
    if (excludeWeights) {
      const ext = path.extname(norm).toLowerCase();
      if (WEIGHT_EXTS.has(ext)) return false;
    }
    return true;
  };
}

/** Recursively sum the byte size + file count of a path under the given filter. */
function walkSize(absPath: string, rootRel: string, include: (p: string) => boolean): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  let stat: fs.Stats;
  try { stat = fs.lstatSync(absPath); } catch { return { bytes, files }; }
  const rel = rootRel.replace(/\\/g, "/");
  if (!include(rel)) return { bytes, files };
  if (stat.isSymbolicLink()) return { bytes, files };
  if (stat.isDirectory()) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(absPath, { withFileTypes: true }); } catch { return { bytes, files }; }
    for (const e of entries) {
      const sub = walkSize(path.join(absPath, e.name), path.posix.join(rel, e.name), include);
      bytes += sub.bytes; files += sub.files;
    }
  } else if (stat.isFile()) {
    bytes += stat.size; files += 1;
  }
  return { bytes, files };
}

export interface BackupEstimate {
  scopes: { id: BackupScopeId; label: string; sourceBytes: number; files: number; estArchiveBytes: number }[];
  totalSourceBytes: number;
  estArchiveBytes: number;
  estSeconds: number;
  freeBytes: number;
  enoughSpace: boolean;
}

/** Estimate source size, compressed size, duration, and free space for a selection. */
export function estimateBackup(scopeIds: BackupScopeId[]): BackupEstimate {
  const perScope: BackupEstimate["scopes"] = [];
  let totalSource = 0, estArchive = 0;
  for (const id of scopeIds) {
    const scope = scopeById(id);
    if (!scope) continue;
    const include = makeFilter(scope.excludeWeights);
    let bytes = 0, files = 0;
    for (const rel of scope.roots()) {
      const sub = walkSize(path.join(ROOT, rel), rel, include);
      bytes += sub.bytes; files += sub.files;
    }
    const est = Math.round(bytes * scope.ratio);
    perScope.push({ id, label: scope.label, sourceBytes: bytes, files, estArchiveBytes: est });
    totalSource += bytes; estArchive += est;
  }
  let freeBytes = 0;
  try {
    const s = fs.statfsSync(BACKUP_DIR_parent());
    freeBytes = s.bavail * s.bsize;
  } catch { /* statfs unavailable */ }
  return {
    scopes: perScope,
    totalSourceBytes: totalSource,
    estArchiveBytes: estArchive,
    estSeconds: Math.max(1, Math.round(totalSource / THROUGHPUT_BPS)),
    freeBytes,
    enoughSpace: freeBytes === 0 ? true : freeBytes > estArchive * 1.15,
  };
}

function BACKUP_DIR_parent(): string {
  // statfs needs an existing path; use ROOT (the volume we write to).
  return ROOT;
}

/** Git short hash for a component dir, or null. */
function gitHash(absDir: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: absDir, timeout: 8000, windowsHide: true })
      .toString().trim();
  } catch { return null; }
}

export interface BackupSeal {
  mark: string;
  formatVersion: number;
  id: string;
  label: string;
  createdAt: string;
  appVersion: string;
  scopes: BackupScopeId[];
  roots: string[];
  components: { path: string; hash: string | null }[];
}

export interface BackupIndexEntry {
  id: string;
  label: string;
  createdAt: string;
  scopes: BackupScopeId[];
  roots: string[];
  archiveFile: string;
  sizeBytes: number;
  sha256: string;
  appVersion: string;
}

/**
 * One-time move of the legacy hidden ".component-backups" folder to the new
 * user-facing "Restore Points" folder. Idempotent and safe: only runs when the
 * old folder exists and the new one does not, so existing snapshots are never
 * orphaned by the rename. Best-effort, a failure here must not break backups.
 */
function migrateLegacyBackupDir(): void {
  try {
    if (fs.existsSync(LEGACY_BACKUP_DIR) && !fs.existsSync(BACKUP_DIR)) {
      fs.renameSync(LEGACY_BACKUP_DIR, BACKUP_DIR);
    }
  } catch { /* leave legacy dir in place; new backups still write to Restore Points */ }
}

function readIndex(): BackupIndexEntry[] {
  migrateLegacyBackupDir();
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")); } catch { return []; }
}
function writeIndex(entries: BackupIndexEntry[]): void {
  migrateLegacyBackupDir();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2) + "\n", "utf-8");
}

export function listBackups(): BackupIndexEntry[] {
  return readIndex().filter((e) => fs.existsSync(path.join(BACKUP_DIR, e.archiveFile)));
}

function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(absPath).on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

export interface CreateProgress {
  phase: "scanning" | "archiving" | "sealing" | "done" | "error";
  processedBytes: number;
  totalBytes: number;
  message?: string;
}

/**
 * Create a sealed, compressed full backup. `onProgress` is called as entries are
 * written. Returns the new index entry on success.
 */
export async function createBackup(
  label: string,
  scopeIds: BackupScopeId[],
  appVersion: string,
  onProgress?: (p: CreateProgress) => void,
): Promise<BackupIndexEntry> {
  const scopes = scopeIds.map(scopeById).filter((s): s is ScopeDef => !!s);
  if (scopes.length === 0) throw new Error("No valid backup scopes selected.");

  migrateLegacyBackupDir();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const est = estimateBackup(scopeIds);
  const totalBytes = est.totalSourceBytes;
  onProgress?.({ phase: "scanning", processedBytes: 0, totalBytes });

  // Gather entries (relative to ROOT) and the combined include filter.
  const roots: string[] = [];
  for (const s of scopes) for (const r of s.roots()) if (!roots.includes(r)) roots.push(r);

  // A file is included if ANY selected scope owning its root permits it.
  const rootExcludeWeights = new Map<string, boolean>();
  for (const s of scopes) for (const r of s.roots()) {
    rootExcludeWeights.set(r, (rootExcludeWeights.get(r) ?? true) && s.excludeWeights);
  }
  const filter = (entryPath: string): boolean => {
    const norm = entryPath.replace(/\\/g, "/");
    const owner = roots.find((r) => norm === r || norm.startsWith(r + "/"));
    const excludeWeights = owner ? (rootExcludeWeights.get(owner) ?? true) : true;
    return makeFilter(excludeWeights)(norm);
  };

  const id = `vsbk-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const archiveFile = `veksnap-restore_${createdAt.replace(/[:.]/g, "-")}.tar.br`;
  const archiveAbs = path.join(BACKUP_DIR, archiveFile);
  const tmpAbs = archiveAbs + ".partial";

  // Build the seal and drop it at ROOT so it archives at the root of the tar.
  const seal: BackupSeal = {
    mark: SEAL_MARK,
    formatVersion: FORMAT_VERSION,
    id, label, createdAt, appVersion,
    scopes: scopeIds,
    roots,
    components: roots.map((r) => ({ path: r, hash: gitHash(path.join(ROOT, r)) })),
  };
  const sealAtRoot = path.join(ROOT, SEAL_NAME);
  fs.writeFileSync(sealAtRoot, JSON.stringify(seal, null, 2), "utf-8");

  let processed = 0;
  try {
    onProgress?.({ phase: "archiving", processedBytes: 0, totalBytes });
    const tarStream = tar.create(
      {
        cwd: ROOT,
        portable: true,
        follow: false,
        filter,
        onWriteEntry: (entry: { size?: number }) => {
          processed += entry.size ?? 0;
          onProgress?.({ phase: "archiving", processedBytes: processed, totalBytes });
        },
      } as unknown as tar.TarOptionsWithAliasesAsync,
      [SEAL_NAME, ...roots],
    );
    await pipeline(
      tarStream as unknown as NodeJS.ReadableStream,
      zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: est.estArchiveBytes,
        },
      }),
      fs.createWriteStream(tmpAbs),
    );
  } finally {
    try { fs.unlinkSync(sealAtRoot); } catch { /* best effort */ }
  }

  onProgress?.({ phase: "sealing", processedBytes: totalBytes, totalBytes });
  fs.renameSync(tmpAbs, archiveAbs);
  const sizeBytes = fs.statSync(archiveAbs).size;
  const sha256 = await sha256File(archiveAbs);

  const entry: BackupIndexEntry = {
    id, label, createdAt, scopes: scopeIds, roots, archiveFile, sizeBytes, sha256, appVersion,
  };
  const index = readIndex();
  index.unshift(entry);
  writeIndex(index);

  onProgress?.({ phase: "done", processedBytes: totalBytes, totalBytes });
  return entry;
}

/** Read the embedded seal by extracting only that entry to a temp dir. */
async function readSeal(archiveAbs: string): Promise<BackupSeal | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsbk-seal-"));
  try {
    await pipeline(
      fs.createReadStream(archiveAbs),
      zlib.createBrotliDecompress(),
      tar.x({
        cwd: tmpDir,
        filter: (p: string) => p.replace(/\\/g, "/") === SEAL_NAME,
      } as unknown as tar.TarOptionsWithAliasesAsync) as unknown as NodeJS.WritableStream,
    );
    return JSON.parse(fs.readFileSync(path.join(tmpDir, SEAL_NAME), "utf-8"));
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface RestoreResult {
  ok: boolean;
  message: string;
  details: string[];
}

/**
 * Restore a full backup. Verifies the archive SHA-256 against the index and the
 * embedded seal, then atomically swaps each captured root: the current dir is
 * moved into a trash folder first, so a failed extraction can be rolled back.
 * Entirely offline: no network of any kind.
 */
export async function restoreBackup(id: string): Promise<RestoreResult> {
  const details: string[] = [];
  const entry = readIndex().find((e) => e.id === id);
  if (!entry) return { ok: false, message: "Backup not found.", details };
  const archiveAbs = path.join(BACKUP_DIR, entry.archiveFile);
  if (!fs.existsSync(archiveAbs)) return { ok: false, message: "Archive file is missing from disk.", details };

  // Integrity: the archive must match the sealed checksum.
  const actual = await sha256File(archiveAbs);
  if (actual !== entry.sha256) {
    return { ok: false, message: "Integrity check FAILED: archive checksum does not match its seal. Refusing to restore.", details };
  }
  const seal = await readSeal(archiveAbs);
  if (!seal || seal.mark !== SEAL_MARK) {
    return { ok: false, message: "Seal missing or invalid: this is not a valid Vek-Snap restore point.", details };
  }
  details.push(`✓ Verified seal: created ${seal.createdAt} (app ${seal.appVersion})`);

  const stamp = Date.now().toString();
  const trash = path.join(TRASH_DIR, stamp);
  fs.mkdirSync(trash, { recursive: true });
  const moved: { root: string; from: string; to: string }[] = [];

  try {
    // 1) Move current captured roots aside (fast rename on the same volume).
    for (const root of seal.roots) {
      const from = path.join(ROOT, root);
      if (!fs.existsSync(from)) continue;
      const to = path.join(trash, root);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push({ root, from, to });
    }
    // 2) Extract the archive back over ROOT.
    await pipeline(
      fs.createReadStream(archiveAbs),
      zlib.createBrotliDecompress(),
      tar.x({ cwd: ROOT, preservePaths: false } as unknown as tar.TarOptionsWithAliasesAsync) as unknown as NodeJS.WritableStream,
    );
    // 3) Remove the stray root-level seal that extraction recreated.
    try { fs.unlinkSync(path.join(ROOT, SEAL_NAME)); } catch { /* fine */ }
    for (const root of seal.roots) details.push(`✓ Restored ${root}`);
  } catch (e) {
    // Roll back: move the originals back into place.
    for (const m of moved) {
      try { if (fs.existsSync(m.from)) fs.rmSync(m.from, { recursive: true, force: true }); fs.renameSync(m.to, m.from); } catch { /* best effort */ }
    }
    return { ok: false, message: `Restore failed and was rolled back: ${(e as Error).message}`, details };
  }

  // Success: discard the trash copy.
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok: true, message: `Restored ${seal.roots.length} path(s) from "${entry.label}"`, details };
}

export function deleteBackup(id: string): { ok: boolean; message: string } {
  const index = readIndex();
  const entry = index.find((e) => e.id === id);
  if (!entry) return { ok: false, message: "Backup not found." };
  try { fs.unlinkSync(path.join(BACKUP_DIR, entry.archiveFile)); } catch { /* already gone */ }
  writeIndex(index.filter((e) => e.id !== id));
  return { ok: true, message: "Backup deleted." };
}
