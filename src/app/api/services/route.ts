import { NextResponse } from "next/server";
import { spawn, exec } from "child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, openSync, closeSync, readSync, statSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import { tmpdir } from "os";
import net from "net";
import { getOfflineEnv } from "@/lib/veksnap-settings";
import { COMFYUI_HTTP, COMFYUI_PORT } from "@/lib/comfyui-config";

const APP_ROOT = path.resolve(process.cwd(), "..");
const SETTINGS_PATH = path.resolve(process.cwd(), "veksnap-settings.json");

// Resolved LAZILY. Computing a tmpdir() path at module scope makes Next's
// output-file-tracer (@vercel/nft) evaluate it and try to bundle the runtime
// temp file into .next/standalone (ENOENT during "Collecting build traces").
function serviceDefsPath(): string {
  return path.join(tmpdir(), "veksnap-service-defs.json");
}
// File-based autostart flag: survives HMR module reloads (unlike `let` vars)
function autostartFlag(): string {
  return path.join(tmpdir(), "veksnap-autostart-done.flag");
}

// Per-service spawn locks: prevents concurrent starts of the same service
const spawnLocks = new Set<string>();

// Per-service spawn timestamps: used (with log freshness) to keep the UI in a
// "starting" state for the ENTIRE boot, not just the brief spawn-lock window.
// ComfyUI with many custom nodes can take 2+ minutes to bind its port; without
// this the status indicator falsely flips to "offline" mid-boot AND lets a user
// trigger a second launch (the spawn lock has already expired, the port isn't
// open yet, so both start-guards pass).
const spawnStartedAt = new Map<string, number>();
// Absolute ceiling for treating a service as "still booting".
const BOOT_MAX_MS = 5 * 60_000;
// If the service log hasn't been written within this window, assume the boot
// stalled/crashed; stop showing "starting" so the user can retry.
const LOG_IDLE_MS = 45_000;

// Track spawned child PIDs (in-memory) AND mirror each to a PID file. `killByPort`
// can only reach a service AFTER its port binds; a service killed mid-boot (or on
// app exit during boot) must be stopped by PID. Children are spawned detached, so
// a parent-tree kill won't reach them either; the PID is the only reliable handle.
// The PID file lets the Electron shell (separate process) do the same on exit.
const spawnedPids = new Map<string, number>();
function servicePidFile(svcId: string): string {
  return path.join(tmpdir(), `veksnap-${svcId}.pid`);
}

// File-based "user stopped" flag: prevents auto-restart after manual stop.
// Written when user explicitly stops a service; cleared when user explicitly starts it.
function getUserStoppedFlag(svcId: string): string {
  return path.join(tmpdir(), `veksnap-${svcId}-user-stopped.flag`);
}
function markUserStopped(svcId: string): void {
  try { writeFileSync(getUserStoppedFlag(svcId), new Date().toISOString()); } catch {}
}
function clearUserStopped(svcId: string): void {
  try { const f = getUserStoppedFlag(svcId); if (existsSync(f)) unlinkSync(f); } catch {}
}
function isUserStopped(svcId: string): boolean {
  try { return existsSync(getUserStoppedFlag(svcId)); } catch { return false; }
}

/** Ensure ComfyUI-Manager config.ini has network_mode = offline before launch */
function enforceComfyManagerOffline() {
  const ini = path.join(APP_ROOT, "ComfyUI", "user", "__manager", "config.ini");
  try {
    if (!existsSync(ini)) return;
    let content = readFileSync(ini, "utf-8");
    if (/network_mode\s*=\s*offline/i.test(content)) return; // already correct
    content = content.replace(/network_mode\s*=\s*\S+/i, "network_mode = offline");
    writeFileSync(ini, content, "utf-8");
    console.log("[services] Enforced ComfyUI-Manager network_mode = offline");
  } catch (e) {
    console.warn("[services] Could not enforce Manager offline config:", (e as Error).message);
  }
}

/** Protect extra_model_paths.yaml from deletion by ComfyUI updates.
 *  If the file is missing but a .bak exists, restore it.
 *  If the file exists, refresh the .bak so it stays current. */
function protectExtraModelPaths() {
  const yaml = path.join(APP_ROOT, "ComfyUI", "extra_model_paths.yaml");
  const bak = yaml + ".bak";
  try {
    if (!existsSync(yaml) && existsSync(bak)) {
      copyFileSync(bak, yaml);
      console.log("[services] Restored extra_model_paths.yaml from backup");
    } else if (existsSync(yaml)) {
      copyFileSync(yaml, bak);
    }
  } catch (e) {
    console.warn("[services] Could not protect extra_model_paths.yaml:", (e as Error).message);
  }
}

// ── Read launcher-written service definitions ──
function readLauncherDefs(): { envs: Record<string, string | null> } | null {
  try {
    const defsPath = serviceDefsPath();
    if (existsSync(defsPath)) {
      return JSON.parse(readFileSync(defsPath, "utf-8"));
    }
  } catch { /* missing or corrupt, fall back to local detection */ }
  return null;
}

// ── Get log directory (same as launcher uses) ──
function getLogDir(): string {
  try {
    const p = path.join(tmpdir(), "veksnap-log-dir.txt");
    if (existsSync(p)) return readFileSync(p, "utf-8").trim();
  } catch { /* ignore */ }
  const dir = path.join(tmpdir(), "veksnap-logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Find python executable for a named conda environment ──
// Prefers pythonw.exe (windowless) over python.exe to prevent console windows
// from appearing for the process and ALL its subprocesses.
function findPythonExe(envName: string): string | null {
  // 1. Try launcher-detected path
  const defs = readLauncherDefs();
  if (defs?.envs?.[envName]) {
    const pw = path.join(defs.envs[envName]!, "pythonw.exe");
    if (existsSync(pw)) return pw;
    const p = path.join(defs.envs[envName]!, "python.exe");
    if (existsSync(p)) return p;
  }
  // 2. Fallback: bundled miniconda
  const candidateW = path.join(APP_ROOT, "miniconda", "envs", envName, "pythonw.exe");
  if (existsSync(candidateW)) return candidateW;
  const candidate = path.join(APP_ROOT, "miniconda", "envs", envName, "python.exe");
  return existsSync(candidate) ? candidate : null;
}

// ── TCP port check (faster + more reliable than HTTP) ──
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.connect(port, "127.0.0.1");
  });
}

// ── ComfyUI readiness check: verifies the API is actually responding ──
// Port can bind early while custom nodes are still loading. This hits
// /system_stats which is a lightweight endpoint available once ComfyUI is ready.
function isComfyReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = require("http").get(
      `${COMFYUI_HTTP}/system_stats`,
      { timeout: 2000 },
      (res: { statusCode?: number }) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// ── Parse ComfyUI startup phase from its log ──
// ComfyUI is spawned with stdio piped to <logDir>/comfyui.log (truncated each
// start). While it boots, the port can be open long before the API is ready,
// so we surface the *real* init phase by scanning the log tail for ordered
// markers and reporting the furthest-along one (monotonic, robust to ordering).
const COMFY_INIT_MARKERS: { needle: string; phase: string; pct: number }[] = [
  { needle: "to see the gui", phase: "Finishing up…", pct: 97 },
  { needle: "starting server", phase: "Starting server…", pct: 92 },
  { needle: "import times for custom nodes", phase: "Finalizing custom nodes…", pct: 85 },
  { needle: "[comfyui-manager]", phase: "Loading custom nodes…", pct: 65 },
  { needle: "loading:", phase: "Loading custom nodes…", pct: 60 },
  { needle: "vae dtype", phase: "Initializing PyTorch & GPU…", pct: 42 },
  { needle: "set vram", phase: "Initializing PyTorch & GPU…", pct: 40 },
  { needle: "total vram", phase: "Initializing PyTorch & GPU…", pct: 35 },
  { needle: "pytorch version", phase: "Initializing PyTorch & GPU…", pct: 30 },
];

function getComfyInitProgress(): { phase: string; pct: number } {
  const logFile = path.join(getLogDir(), "comfyui.log");
  let content = "";
  try {
    if (existsSync(logFile)) {
      const size = statSync(logFile).size;
      const readLen = Math.min(size, 65536); // tail; startup logs are small
      if (readLen > 0) {
        const fd = openSync(logFile, "r");
        try {
          const buf = Buffer.alloc(readLen);
          readSync(fd, buf, 0, readLen, size - readLen);
          content = buf.toString("utf-8").toLowerCase();
        } finally {
          closeSync(fd);
        }
      }
    }
  } catch { /* ignore; fall through to default */ }

  if (!content) return { phase: "Launching ComfyUI…", pct: 5 };
  let best = { phase: "Starting Python…", pct: 15 };
  for (const m of COMFY_INIT_MARKERS) {
    if (m.pct > best.pct && content.includes(m.needle)) best = { phase: m.phase, pct: m.pct };
  }
  return best;
}

// ── Boot detection: is a service actively initialising (before its port binds)? ──
// A service's log is truncated ("w") at spawn and written continuously while it
// loads. If it was spawned recently AND its log is still being written, it's
// mid-boot even though the port hasn't bound yet.
function logRecentlyWritten(svcId: string, withinMs: number): boolean {
  try {
    const age = Date.now() - statSync(path.join(getLogDir(), `${svcId}.log`)).mtimeMs;
    return age < withinMs;
  } catch { return false; }
}
function isServiceBooting(svcId: string): boolean {
  const started = spawnStartedAt.get(svcId);
  if (!started || Date.now() - started > BOOT_MAX_MS) return false;
  return logRecentlyWritten(svcId, LOG_IDLE_MS);
}

// ── Kill processes listening on a port ──
function killByPort(port: number): Promise<string> {
  return new Promise((resolve) => {
    exec(
      `for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${port}.*LISTENING"') do @taskkill /PID %a /T /F`,
      { shell: "cmd.exe", timeout: 10000, windowsHide: true },
      (err, stdout) => resolve(stdout?.trim() || (err ? "error" : "done"))
    );
  });
}

// ── Kill a process tree by PID (reaches a service whose port hasn't bound yet) ──
function killByPid(pid: number): Promise<void> {
  return new Promise((resolve) => {
    exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true, timeout: 10000 }, () => resolve());
  });
}

// Stop a service by its tracked PID (in-memory first, then the PID file) so a
// still-booting instance is killed even before its port binds. Clears both.
async function killTrackedPid(svcId: string): Promise<void> {
  let pid = spawnedPids.get(svcId);
  if (!pid) {
    try {
      const f = servicePidFile(svcId);
      if (existsSync(f)) pid = parseInt(readFileSync(f, "utf-8").trim(), 10) || undefined;
    } catch { /* ignore */ }
  }
  if (pid) await killByPid(pid);
  spawnedPids.delete(svcId);
  try { const f = servicePidFile(svcId); if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
}

// ── Service definitions ──
interface ServiceDef {
  id: string;
  name: string;
  description: string;
  port: number;
  condaEnv: string;
  cwd: string;
  script: string;
  args: string[];
  extraEnv?: Record<string, string>;
}

function getServiceDefs(): ServiceDef[] {
  // Read preview method from settings (default: "none")
  const settings = readVekSnapSettings();
  const previewMethod = settings.comfyPreviewMethod || "none";

  // LatentSync custom-node checkpoint dir, kept inside the install so it
  // resolves on any machine. ComfyUI handles its own temp dir (<ComfyUI>/temp)
  // by default, so we no longer override --temp-directory.
  const latentSyncDir = path.join(APP_ROOT, "ComfyUI", "models", "latentsync");

  return [
    {
      id: "comfyui",
      name: "ComfyUI",
      description: "Image & video generation, LTX-2 audio-video, Director pipeline",
      port: COMFYUI_PORT,
      condaEnv: "comfyui",
      cwd: path.join(APP_ROOT, "ComfyUI"),
      script: "ram_limited_launcher.py",
      // CORS: restrict to OUR UI origin (the renderer page) instead of the wildcard
      // "*". The only browser->ComfyUI cross-origin call is uploadImage()'s direct XHR,
      // whose Origin is this UI page, so it still works; arbitrary external sites the
      // user visits can no longer READ ComfyUI's responses (model lists, output bytes,
      // object_info paths, system stats). Must match the shell UI_PORT (41573).
      // --disable-pinned-memory: ComfyUI v0.32.0 added comfy_aimdo's pinned host-buffer
      // manager (default on for NVIDIA/AMD). On a 32GB box it reserves ~2x model size of
      // pinned RAM; Continuum/LTX offload overflows that reserve, flooding logs with
      // handled-but-noisy "aimdo hostbuf_grow ... beyond reserved host buffer" errors and
      // thrashing on pin-steal fallbacks. Disabling restores pre-update pageable-transfer
      // behavior. Pure launch-flag fix, no ComfyUI code edits.
      args: ["--listen", "127.0.0.1", "--port", String(COMFYUI_PORT), "--preview-method", previewMethod, "--fast", "--bf16-vae", "--disable-pinned-memory", "--disable-auto-launch", "--enable-cors-header", "http://127.0.0.1:41573", "--max-upload-size", "500"],
      extraEnv: {
        RAM_RESERVE_MB: String(settings.ramReserveMB || 4096),
        PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True",
        // Suppress known harmless PyTorch startup warnings (unless verbose mode is on):
        //   - "Redirects are currently not supported in Windows" (torch.distributed.elastic)
        //   - "expandable_segments not supported on this platform" (SeedVR2 probe)
        ...(settings.verboseLogs ? {} : { PYTHONWARNINGS: "ignore::UserWarning:torch.distributed,ignore:expandable_segments:UserWarning" }),
        GIT_PYTHON_REFRESH: "quiet",
        LATENTSYNC_CKPT_DIR: latentSyncDir,
        ...getOfflineEnv(),
      },
    },
  ];
}

/** Start a single service by its ID. Returns a status string.
 *  Uses a spawn lock to prevent concurrent starts of the same service. */
async function startServiceById(svcId: string): Promise<string> {
  // Prevent concurrent spawns of the same service. The short-lived spawn lock
  // covers the first seconds; `isServiceBooting` covers the rest of a long boot
  // (recent spawn + still-writing log) so a user can't launch a second copy
  // during the window before the port binds.
  if (spawnLocks.has(svcId)) return "already_starting";
  if (isServiceBooting(svcId)) return "already_starting";

  const defs = getServiceDefs();
  const svc = defs.find((s) => s.id === svcId);
  if (!svc) return "error: unknown service";

  if (await isPortListening(svc.port)) return "already_running";

  const python = findPythonExe(svc.condaEnv);
  if (!python) return "error: environment not found";
  if (!existsSync(svc.cwd)) return "error: directory not found";

  // Acquire lock
  spawnLocks.add(svcId);

  try {
    if (svc.id === "comfyui") {
      enforceComfyManagerOffline();
      protectExtraModelPaths();
    }

    const envDir = path.dirname(python);
    const logDir = getLogDir();
    const logFile = path.join(logDir, `${svc.id}.log`);
    const fd = openSync(logFile, "w");

    const child = spawn(python, ["-u", svc.script, ...svc.args], {
      cwd: svc.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        ...(svc.extraEnv ?? {}),
        PYTHONUNBUFFERED: "1",
        // Isolate the conda env: ignore the machine's per-user site-packages
        // (%APPDATA%\Python\Python3xx\site-packages). A user-site torch there can
        // shadow the env's torch (wrong CUDA build), which drops comfy_kitchen to
        // its eager quantization path and OOMs on quantized (nvfp4/int8) models.
        PYTHONNOUSERSITE: "1",
        PATH: [
          path.join(envDir, "Library", "bin"),
          path.join(envDir, "Lib", "site-packages", "torch", "lib"),
          process.env.PATH ?? "",
        ].join(";"),
      },
    });
    child.unref();
    closeSync(fd);

    // Record spawn time so the status endpoint can keep reporting "starting"
    // (with real init progress) for the whole boot, not just the lock window.
    spawnStartedAt.set(svcId, Date.now());

    // Record the PID (memory + file) so a mid-boot stop / app-exit can kill this
    // instance by PID, before its port has bound.
    if (child.pid) {
      spawnedPids.set(svcId, child.pid);
      try { writeFileSync(servicePidFile(svcId), String(child.pid)); } catch { /* ignore */ }
    }

    // Release lock after a delay, gives the process time to bind the port
    // so subsequent isPortListening checks see it as running. (The longer boot
    // is now covered by spawnStartedAt + log freshness via isServiceBooting.)
    setTimeout(() => spawnLocks.delete(svcId), 15000);

    return `started (PID ${child.pid})`;
  } catch (e) {
    spawnLocks.delete(svcId);
    return `error: ${(e as Error).message}`;
  }
}

/** Read veksnap-settings.json (same file as /api/settings uses). */
function readVekSnapSettings(): { comfyAutostart?: boolean; comfyPreviewMethod?: string; verboseLogs?: boolean; ramReserveMB?: number } {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * GET /api/services
 * Returns the status of all backend services.
 * On the first call per server lifetime, triggers autostart if configured.
 */
export async function GET() {
  const defs = getServiceDefs();

  // ── Server-side startup tasks (once per session) ──
  // Must run BEFORE status computation so spawnLock is set and the first
  // response already includes `starting: true` for autostarted services.
  let autostartDone = false;
  try { autostartDone = existsSync(autostartFlag()); } catch {}
  if (!autostartDone) {
    try { writeFileSync(autostartFlag(), new Date().toISOString()); } catch {}
    enforceComfyManagerOffline();
    protectExtraModelPaths();
    const settings = readVekSnapSettings();
    if (settings.comfyAutostart) {
      const comfyDef = defs.find((s) => s.id === "comfyui");
      const comfyEnv = comfyDef ? !!findPythonExe(comfyDef.condaEnv) : false;
      const comfyPort = comfyDef ? await isPortListening(comfyDef.port) : true;
      const comfyStopped = isUserStopped("comfyui");
      if (comfyDef && !comfyPort && comfyEnv && !comfyStopped) {
        console.log("[services] Server-side autostart: starting ComfyUI");
        startServiceById("comfyui").then((status) =>
          console.log("[services] Autostart result:", status)
        ).catch((e: unknown) =>
          console.warn("[services] Autostart failed:", e)
        );
        // Mark as starting for the status computation below.
        // startServiceById will also set it (redundant but harmless).
        spawnLocks.add("comfyui");
      } else {
        console.log(`[services] Autostart skipped: port=${comfyPort}, env=${comfyEnv}, userStopped=${comfyStopped}`);
      }
    }
  }

  // ── Compute statuses (spawnLock is now set if autostart fired) ──
  const statuses = await Promise.all(defs.map(async (svc) => {
    const portOpen = await isPortListening(svc.port);
    const envAvailable = !!findPythonExe(svc.condaEnv);

    // For ComfyUI: port can open early while it's still loading nodes.
    // Do a real HTTP health check to distinguish "running" from "starting".
    let running = portOpen;
    let isStarting = spawnLocks.has(svc.id);
    if (svc.id === "comfyui" && portOpen) {
      const ready = await isComfyReady();
      if (!ready) {
        // Port is open but API isn't responding yet; still booting
        running = false;
        isStarting = true;
      }
    }
    // Port not bound yet, but the service is actively initialising (spawned
    // recently + log still being written). Keep it "starting" for the ENTIRE
    // boot so the indicator never flashes offline mid-launch (ComfyUI with many
    // custom nodes can take 2+ minutes to bind its port).
    if (!running && !isStarting && isServiceBooting(svc.id)) {
      isStarting = true;
    }
    // Boot finished; drop the spawn timestamp so a later restart re-arms cleanly.
    if (running) spawnStartedAt.delete(svc.id);

    // Surface the real init phase while ComfyUI is still booting.
    const init = (svc.id === "comfyui" && isStarting && !running)
      ? getComfyInitProgress()
      : undefined;

    return {
      id: svc.id,
      name: svc.name,
      description: svc.description,
      port: svc.port,
      status: running ? ("running" as const) : ("stopped" as const),
      envAvailable,
      starting: isStarting,
      ...(init ? { init } : {}),
    };
  }));

  return NextResponse.json({ services: statuses });
}

/**
 * POST /api/services
 * Start, stop, or restart individual or all backend services.
 * Body: { action: "start"|"stop"|"restart", services?: ["comfyui"] }
 * If services array is omitted, applies to ALL services.
 */
export async function POST(req: Request) {
  const body = await req.json();
  const { action, services: serviceIds } = body as {
    action: "start" | "stop" | "restart";
    services?: string[];
  };

  const allDefs = getServiceDefs();
  const targets = serviceIds
    ? allDefs.filter((s) => serviceIds.includes(s.id))
    : allDefs;

  const results: { id: string; status: string }[] = [];

  // ── Stop phase ──
  if (action === "stop" || action === "restart") {
    for (const svc of targets) {
      await killByPort(svc.port);
      // Also kill by tracked PID; reaches an instance still BOOTING whose port
      // hasn't bound yet (killByPort alone would miss it).
      await killTrackedPid(svc.id);
      // Clear boot tracking so a stopped/restarted service isn't reported as
      // "starting" from a stale timestamp.
      spawnStartedAt.delete(svc.id);
      spawnLocks.delete(svc.id);
      // Mark as user-stopped so autostart doesn't re-trigger (stop only, not restart)
      if (action === "stop") markUserStopped(svc.id);
      results.push({ id: svc.id, status: "stopped" });
    }
    if (action === "restart") {
      // Brief pause so OS fully releases sockets
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ── Start phase (uses centralized startServiceById with spawn lock) ──
  if (action === "start" || action === "restart") {
    for (const svc of targets) {
      // Clear user-stopped flag; user explicitly wants this service running
      clearUserStopped(svc.id);
      // For restart, clear the spawn lock since we just killed it
      if (action === "restart") spawnLocks.delete(svc.id);
      const status = await startServiceById(svc.id);
      results.push({ id: svc.id, status });
    }
  }

  return NextResponse.json({ ok: true, results });
}
