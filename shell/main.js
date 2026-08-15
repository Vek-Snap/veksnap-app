// ── ELECTRON_RUN_AS_NODE self-heal (MUST run before any Electron API use) ──
// When this binary is started with ELECTRON_RUN_AS_NODE set in the environment,
// electron.exe behaves like plain Node.js: `require("electron")` returns a STRING
// (the path to the binary) instead of the API object, so the window never opens.
// That variable is commonly exported by some editor/dev-tool terminals and is
// INHERITED by the .lnk shortcut, which a shortcut cannot unset.
// Detect that state and relaunch the real Electron runtime with the variable
// cleared and the absolute shell-dir as the app path, forwarding our flags.
{
  const electronEntry = require("electron");
  if (typeof electronEntry === "string") {
    const { spawn: _spawn } = require("child_process");
    const _path = require("path");
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = _spawn(
      electronEntry,
      [_path.resolve(__dirname), ...process.argv.slice(2)],
      { env: childEnv, detached: true, stdio: "ignore" },
    );
    child.unref();
    process.exit(0);
  }
}

const { app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain, nativeImage, clipboard } = require("electron");
const { spawn, execSync, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

// ── Memory-conscious Chromium flags ──
// Limit V8 heap to 512MB (default is ~1.5GB), we're a thin UI shell, not a web app
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=512");
// NOTE: GPU compositing MUST stay enabled. Chromium presents decoded video frames
// through the GPU compositor (zero-copy overlay); disabling it forces SOFTWARE
// compositing, which stutters/drops frames on playback even when decode + CPU/GPU
// utilization are near-idle. The UI compositor costs only a small, constant amount
// of VRAM: negligible vs ComfyUI's generation footprint, and playback/generation
// rarely overlap. (Previously "disable-gpu-compositing" was set here to save VRAM;
// it was the cause of 720p playback stutter.)
// Disable GPU shader disk cache, prevents "Access denied" errors on locked cache files
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
// Do NOT calculate native window occlusion: when Chromium believes the window is
// occluded (e.g. another window layered on top), it throttles rendering and video
// stutters. Keep the renderer running at full frame rate.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// Reduce renderer process memory ceiling
app.commandLine.appendSwitch("renderer-process-limit", "1");
// Disable background tab throttling prevention (let OS reclaim)
app.commandLine.appendSwitch("disable-background-timer-throttling");

// ── Configuration ──
// Loopback-only UI port. Deliberately NOT the framework's well-known default
// (avoids the predictable dev port + collisions). The Next server binds to 127.0.0.1 only,
// so it is never reachable from the network; the Electron window is the only client.
// NOTE: named UI_PORT (not "dev") because this is the port in BOTH dev and
// production (`run start`) launches: it is the app's real UI port, not a
// dev-only artifact.
const UI_PORT = 41573;
const APP_DIR = path.resolve(__dirname, "..");
const INSTALL_ROOT = path.resolve(APP_DIR, "..");
// Expose the install/workspace root to every child (the Next server + ComfyUI)
// via the inherited environment. The log-export PII scrubber reads this to
// collapse absolute paths to "<install>" so a support export never leaks the
// user's drive letter or chosen folder names.
process.env.VEKSNAP_INSTALL_ROOT = INSTALL_ROOT;
// ── VLAP per-launch credential (Vek-Snap Local Access Protocol) ──
// A fresh 32-byte secret + short epoch id, regenerated every launch. Handed ONLY
// to (a) the Next server child via its inherited env (spawnServer passes
// process.env), so middleware.ts can verify signatures, and (b) the trusted
// renderer over IPC ("vlap:getCredential"). It is never sent over HTTP nor placed
// in any HTML, so no web page the user visits can forge a signed request to the
// local API even if it defeats the Host/Origin checks (DNS rebinding, etc.).
const VLAP_SECRET = crypto.randomBytes(32).toString("base64url");
const VLAP_EPOCH = crypto.randomBytes(8).toString("hex");
process.env.VEKSNAP_API_SECRET = VLAP_SECRET;
process.env.VEKSNAP_API_EPOCH = VLAP_EPOCH;
const APP_URL = `http://127.0.0.1:${UI_PORT}`;

// ── Master network gate (renderer + main-process net) ──
// Companion to getOfflineEnv() (veksnap-settings.ts), which gates spawned Python via
// proxy env. Electron/Chromium ignore HTTP_PROXY, so browser-side JS in the renderer
// is the one exfiltration class the env gate cannot stop. This cancels ANY
// http/https/ws/wss request whose host is not loopback, closing that gap and making
// the offline guarantee future-proof (auto-covers any pack/UI added later).
// Honors the SAME allowOnline setting as getOfflineEnv() so the two never disagree.
const SETTINGS_FILE = path.join(APP_DIR, "veksnap-settings.json");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
// Read once at launch (matches getOfflineEnv(), which is read at service-spawn time;
// changing the mode requires a relaunch either way). Fail-closed (offline) on error.
let NETWORK_GATE_ONLINE = false;
function readAllowOnline() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")).allowOnline === true; }
  catch { return false; }
}
function isLoopbackUrl(u) {
  try { return LOOPBACK_HOSTS.has(new URL(u).hostname.replace(/^\[|\]$/g, "")); }
  catch { return true; } // opaque/non-URL, not one of our gated schemes; allow
}
function installNetworkGate(sess) {
  if (!sess || sess.__vsNetGateInstalled) return;
  sess.__vsNetGateInstalled = true;
  sess.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, cb) => {
      if (NETWORK_GATE_ONLINE) return cb({}); // user explicitly enabled online mode
      const ok = isLoopbackUrl(details.url);
      if (!ok) { try { log(`[NetGate] blocked ${new URL(details.url).host}`); } catch { /* logging best-effort */ } }
      cb({ cancel: !ok });
    },
  );
}
// Default UI: the polished Studio v2 shell. The classic UI stays available at
// "/" (reachable via the in-app "Classic UI" button) and can be made the default
// again by launching with VEKSNAP_UI=classic. APP_URL (root) is still used for
// server liveness pings; START_URL is what the window actually navigates to.
const START_URL = process.env.VEKSNAP_UI === "classic" ? APP_URL : `${APP_URL}/studio-v2`;

// ── Self-bootstrap the bundled Node.js onto PATH ──
// The release is launched by a Windows shortcut (.lnk) pointing straight at
// electron.exe: there is NO .bat wrapper. So the shell itself must put the
// provisioned Node runtime (<install>/runtime/node) on PATH so the `npm`/`node`
// child processes spawned below resolve to OUR bundled Node, not a system one.
(() => {
  const bundledNodeDir = path.join(INSTALL_ROOT, "runtime", "node");
  if (fs.existsSync(path.join(bundledNodeDir, "node.exe"))) {
    process.env.PATH = `${bundledNodeDir}${path.delimiter}${process.env.PATH || ""}`;
  }
})();

const LOG_DIR = path.join(os.tmpdir(), "veksnap-logs");
const LOG_FILE = path.join(LOG_DIR, "veksnap.log");
const PID_FILE = path.join(LOG_DIR, "server.pid");
const SHUTDOWN_FLAG = path.join(os.tmpdir(), "veksnap-shutdown.flag");
const SERVICE_DEFS_PATH = path.join(os.tmpdir(), "veksnap-service-defs.json");
const WINDOW_STATE_FILE = path.join(APP_DIR, "window-state.json");
const NEXT_CACHE = path.join(APP_DIR, ".next");
// ── Temp-cleanup roots ──
const COMFY_DIR = path.join(INSTALL_ROOT, "ComfyUI");
const SHELL_PREFS_FILE = path.join(APP_DIR, "shell-prefs.json");     // main-process-owned prefs (clear-on-exit)
const MAX_LOAD_RETRIES = 5;       // Increased, OOM crashes need more retries
const HEALTH_CHECK_INTERVAL = 10000; // 10s
const MEMORY_CHECK_INTERVAL = 5000;  // 5s, check memory pressure
const LOW_MEMORY_MB = 500;           // Below 500MB available = danger zone

let mainWindow = null;
let serverProcess = null;
let lastServerPid = null; // retained even after serverProcess is nulled, so cleanup can still kill the npm/cmd wrapper tree
let logStream = null;
let isQuitting = false;
let loadRetryCount = 0;
let healthTimer = null;
let memoryTimer = null;
let serverReady = false;
let appLoaded = false;  // True only after page.tsx finishes compiling and the window loads
let memoryWarningShown = false;
let tray = null;
const isProd = process.argv.includes("--prod");
let minimizeToTray = false; // Toggled by IPC from renderer

// ── Window control IPC handlers (registered once, used by custom title bar) ──
ipcMain.on("window-minimize", () => {
  if (minimizeToTray && tray) {
    mainWindow?.hide();
  } else {
    mainWindow?.minimize();
  }
});
ipcMain.on("window-maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on("window-close", () => mainWindow?.close());
ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() ?? false);

// VLAP: hand the per-launch API credential to the trusted renderer only. The
// preload exposes this as electronAPI.getApiCredential(); the renderer's fetch
// wrapper uses it to sign state-changing /api calls.
ipcMain.handle("vlap:getCredential", () => ({ secret: VLAP_SECRET, epoch: VLAP_EPOCH }));

// Native folder picker (used by the Model Paths editor's "Browse" button so the
// user can navigate to a model folder in Explorer instead of typing a path).
// Returns the selected absolute directory, or null if cancelled.
ipcMain.handle("dialog:pickFolder", async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: "Select a model folder",
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths?.length) return null;
    return res.filePaths[0];
  } catch {
    return null;
  }
});

// Native Save dialog + synchronous file write. Used by Save / Save & Quit so the
// renderer can AWAIT true completion (dialog shown → file written) before it
// begins the app-terminate cycle: fixes the bug where the app quit while the
// Save dialog was still open, losing the file. Returns { path } on success or
// { canceled: true } if the user dismissed the dialog.
ipcMain.handle("dialog:saveFile", async (_event, opts) => {
  try {
    const defaultName = (opts && opts.defaultName) || "veksnap_export.json";
    const contents = (opts && opts.contents) || "";
    const res = await dialog.showSaveDialog(mainWindow, {
      title: "Save",
      defaultPath: defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }, { name: "All Files", extensions: ["*"] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fs.promises.writeFile(res.filePath, contents, "utf8");
    return { path: res.filePath };
  } catch (err) {
    return { canceled: true, error: String(err && err.message ? err.message : err) };
  }
});

// Renderer tells us whether it has unsaved changes
let hasUnsavedChanges = false;
ipcMain.on("unsaved-changes", (_event, value) => { hasUnsavedChanges = !!value; });

// Close confirmation: renderer sends back the user's decision
// NOTE: Set closeConfirmed (not isQuitting) so the close handler lets the window
// close, but cleanup() still runs when window-all-closed fires.
let closeConfirmed = false;
// Safety-net timer (see the window 'close' handler): armed when we ask the
// renderer to confirm, and cancelled the instant the renderer acknowledges it
// can show the dialog. If it never acks (crashed/hung/splash) we force-close.
let forceCloseTimer = null;
function clearForceCloseTimer() {
  if (forceCloseTimer) { clearTimeout(forceCloseTimer); forceCloseTimer = null; }
}
ipcMain.on("confirm-close-ack", clearForceCloseTimer);
ipcMain.on("close-confirmed", () => {
  clearForceCloseTimer();
  closeConfirmed = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// Minimize-to-tray toggle from renderer
ipcMain.on("set-minimize-to-tray", (_event, value) => { minimizeToTray = !!value; });

// Spellcheck toggle: uses Windows native spellchecker (fully offline, no internet needed).
// Dictionaries come from Windows language settings, zero extra RAM in the Electron process.
ipcMain.on("set-spellcheck", (_event, enabled) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.session.setSpellCheckerEnabled(!!enabled);
  }
});

// ── Logging: write to veksnap-logs/veksnap.log (visible in System Logs UI) ──
function initLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, ""); // truncate previous run's log
  } catch { /* can't log, proceed anyway */ }
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}\n`;
  // Synchronous append so EVERY line is durably on disk the instant it is
  // written. A buffered stream would lose its tail if the process stalls
  // mid-teardown: exactly the case we need the log for (shutdown-hang post-
  // mortem). Log volume is low enough that the sync cost is irrelevant.
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* logging is best-effort */ }
}

// ── Update splash status text + progress via JS injection ──
function updateSplash(msg, progress) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const escaped = msg.replace(/'/g, "\\'");
  const pct = typeof progress === "number" ? progress : -1;
  mainWindow.webContents.executeJavaScript(
    `try {
      document.getElementById('status').textContent = '${escaped}';
      var bar = document.getElementById('progress-fill');
      if (bar && ${pct} >= 0) { bar.style.width = '${pct}%'; }
    } catch {}`
  ).catch(() => {});
}

// ── Hide the console window (Windows only) ──
function hideConsoleWindow() {
  try {
    const psScript = path.join(os.tmpdir(), "veksnap-hide-console.ps1");
    fs.writeFileSync(psScript, [
      'Add-Type -Name VekWin -Namespace VekSnap -Member @"',
      '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int s);',
      '"@ -ErrorAction SilentlyContinue',
      '[VekSnap.VekWin]::ShowWindow([VekSnap.VekWin]::GetConsoleWindow(), 0)',
    ].join("\n"));
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, {
      stdio: "pipe", timeout: 10000,
    });
  } catch { /* not critical */ }
}

// ── PID file management: survive crashes ──
function writePidFile(pid) {
  try { fs.writeFileSync(PID_FILE, String(pid), "utf8"); } catch {}
}

function readPidFile() {
  try { return parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10); } catch { return null; }
}

function clearPidFile() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ── Kill any stale processes on a port ──
function killByPort(port) {
  try {
    const result = execSync(
      `cmd /c "netstat -aon | findstr ":${port}" | findstr LISTENING"`,
      { windowsHide: true, stdio: "pipe", timeout: 5000 }
    ).toString();
    const pids = new Set();
    for (const line of result.split("\n")) {
      const match = line.trim().match(/LISTENING\s+(\d+)/);
      if (match) pids.add(match[1]);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore", timeout: 5000 });
        log(`[Shell] Killed stale PID ${pid} on port ${port}`);
      } catch {}
    }
  } catch { /* nothing listening, fine */ }
}

// ── Verify a port is free (no LISTENING process), polls until free or timeout ──
function waitForPortFree(port, maxWaitMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      try {
        execSync(
          `cmd /c "netstat -aon | findstr ":${port}" | findstr LISTENING"`,
          { windowsHide: true, stdio: "pipe", timeout: 3000 }
        );
        // Still listening: wait and retry
        if (Date.now() - start > maxWaitMs) {
          log(`[Shell] Port ${port} still occupied after ${maxWaitMs}ms, proceeding anyway`);
          resolve(false);
        } else {
          setTimeout(check, 300);
        }
      } catch {
        // netstat found nothing = port is free
        resolve(true);
      }
    };
    check();
  });
}

// ── Verify the dev server is actually responding before navigating ──
function ensureServerResponding(maxWaitMs = 60000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (isQuitting) { resolve(false); return; }
      const req = http.get(APP_URL, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() - start > maxWaitMs) {
          log("[Shell] Server did not respond within timeout");
          resolve(false);
        } else {
          setTimeout(check, 1000);
        }
      });
      req.setTimeout(5000, () => { req.destroy(); });
    };
    check();
  });
}

// ── Kill a process tree by PID ──
function killTree(pid) {
  if (!pid) return;
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore", timeout: 10000 });
  } catch { /* already dead */ }
}

// ── Clean up any orphaned server from a previous crash ──
function cleanupOrphans() {
  // 1. Try PID file first (most reliable)
  const stalePid = readPidFile();
  if (stalePid) {
    log(`[Shell] Found stale PID file (${stalePid}), killing orphan`);
    killTree(stalePid);
    clearPidFile();
  }
  // 2. Also kill anything listening on our port as a safety net
  killByPort(UI_PORT);
  // 3. Clear server-side autostart flag so it fires fresh this session
  const autostartFlag = path.join(os.tmpdir(), "veksnap-autostart-done.flag");
  try { fs.unlinkSync(autostartFlag); } catch {}
  // 4. Clear any stale service PID files from a previous crash, otherwise a
  //    reused OS PID could be killed on a later exit. Fresh ones are written on spawn.
  for (const id of BACKEND_SVC_IDS) {
    try { fs.unlinkSync(path.join(os.tmpdir(), `veksnap-${id}.pid`)); } catch {}
  }
}

// ── Clear .next cache and stale locks to prevent startup failures ──
function clearNextCache() {
  try {
    // Remove stale dev lock file (prevents "Unable to acquire lock" after crash)
    const lockFile = path.join(NEXT_CACHE, "dev", "lock");
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      log("[Shell] Removed stale .next/dev/lock");
    }
    // Only clear the cache subdirectory, not the full .next (preserves static assets during dev)
    const cacheDir = path.join(NEXT_CACHE, "cache");
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      log("[Shell] Cleared .next/cache");
    }
  } catch (err) {
    log(`[Shell] Could not clear cache: ${err.message}`);
  }
}

// ── Backend service ports to kill on shutdown ──
// ComfyUI's fixed loopback port (COMFYUI_PORT in src/lib/comfyui-config.ts). Keep in sync.
// Do NOT list 8188 here: a customer may run their own ComfyUI on that default and we must
// never kill a foreign instance on shutdown (and ours no longer uses it).
const BACKEND_PORTS = [41931]; // ComfyUI
// Service ids whose PID files (veksnap-<id>.pid, written by the Next server on spawn)
// are checked on shutdown to kill any instance still BOOTING before its port bound.
const BACKEND_SVC_IDS = ["comfyui"];

// ── Master cleanup: called from multiple exit hooks ──
function cleanup() {
  if (isQuitting) return;
  isQuitting = true;
  log("[Shell] Cleanup running...");

  // Stop monitors
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (memoryTimer) { clearInterval(memoryTimer); memoryTimer = null; }

  // Use lastServerPid as a fallback: the server's 'exit' handler nulls
  // serverProcess, but the npm/cmd wrapper tree (spawned with shell:true) can
  // outlive it and become the stray node.exe that survives a quit.
  const serverPid = (serverProcess && serverProcess.pid) || lastServerPid;
  if (serverPid) {
    log(`[Shell] Killing dev server tree (PID ${serverPid})...`);
    killTree(serverPid);
  }
  killByPort(UI_PORT);

  // Kill backend services (ComfyUI)
  for (const port of BACKEND_PORTS) {
    killByPort(port);
  }
  // Also kill any service still BOOTING, its port hasn't bound yet, so killByPort
  // misses it, and it was spawned detached so the dev-server tree kill won't reach
  // it. The Next server writes each spawned PID to veksnap-<id>.pid; kill + clear them.
  for (const id of BACKEND_SVC_IDS) {
    try {
      const pf = path.join(os.tmpdir(), `veksnap-${id}.pid`);
      if (fs.existsSync(pf)) {
        const pid = parseInt(fs.readFileSync(pf, "utf-8").trim(), 10);
        if (pid) { log(`[Shell] Killing booting service ${id} (PID ${pid})`); killTree(pid); }
        fs.unlinkSync(pf);
      }
    } catch { /* ignore */ }
  }
  log("[Shell] Killed backend services");

  clearPidFile();
  log("[Shell] Vek-Snap closed.");
}

// ── Hard shutdown watchdog ──
// Guarantees the process ALWAYS terminates even if a teardown step (the on-exit
// sweep, a taskkill, a stuck async handle) hangs. Without this, a stalled step
// in the exit path leaves Electron running with no window, the "won't close on
// its own" bug. The last log line before "FIRED" pinpoints exactly what hung.
let shutdownWatchdog = null;
function armShutdownWatchdog(label, ms = 8000) {
  if (shutdownWatchdog) return;
  log(`[Shell] Shutdown watchdog armed (${label}, ${ms}ms budget).`);
  shutdownWatchdog = setTimeout(() => {
    log("[Shell] Shutdown watchdog FIRED, teardown exceeded its budget; forcing process exit.");
    app.exit(0); // hard terminate: bypasses any remaining/stuck hooks
  }, ms);
  if (shutdownWatchdog.unref) shutdownWatchdog.unref();
}

// Await a promise but never let it block teardown beyond `ms`.
function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => {
      log(`[Shell] ${label} exceeded ${ms}ms, continuing teardown without waiting.`);
      resolve();
    }, ms)),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════
// TEMP-FILE CLEANUP: "Clear Temporary Files" feature
// ────────────────────────────────────────────────────────────────────────────
// Single source of truth for everywhere Vek-Snap writes ephemeral data. The
// renderer dialog calls these over IPC (scan → sizes, clear → delete). The same
// engine runs the optional "clear on exit" sweep. SAFETY RULES:
//   • ComfyUI/output (the user's renders) is a PROTECTED category, never part
//     of "Clear All" or the on-exit sweep; only a dedicated, confirmed button.
//   • OS temp is NEVER blanket-wiped, only Vek-Snap's own files are matched by
//     name prefix (it is a folder shared by every app on the machine).
//   • Directory CONTENTS are cleared but the directories themselves are kept
//     (ComfyUI expects input/ and temp/ to exist).
// ════════════════════════════════════════════════════════════════════════════
const fsp = fs.promises;

// Persisted, main-process-owned preferences (so the on-exit hook can read it).
function readShellPrefs() {
  try { return JSON.parse(fs.readFileSync(SHELL_PREFS_FILE, "utf8")) || {}; } catch { return {}; }
}
function writeShellPrefs(prefs) {
  try { fs.writeFileSync(SHELL_PREFS_FILE, JSON.stringify(prefs, null, 2) + "\n", "utf8"); } catch { /* best effort */ }
}
function clearTempOnExitEnabled() { return readShellPrefs().clearTempOnExit === true; }

// User-visible categories. `protected` ones are excluded from Clear All + on-exit.
const TEMP_CATEGORIES = [
  { id: "appCache",   label: "App caches (Chromium)",      desc: "GPU/web caches and the HTTP media cache that can retain played-back render previews." },
  { id: "comfyInput", label: "ComfyUI source & staging",   desc: "Uploaded images/audio, masks, extracted frames and per-workflow staging folders." },
  { id: "comfyTemp",  label: "ComfyUI intermediates",      desc: "Temporary frames, latents and scratch files produced mid-render." },
  { id: "computeCache", label: "GPU compute caches",       desc: "Regenerable Torch/Triton compile & kernel caches from model runs and LoRA training. Safe to clear; rebuilt automatically. (Provisioned tokenizers/models in .hf_cache are NOT touched.)" },
  { id: "osScratch",  label: "Logs, flags & build cache",  desc: "App logs, inter-process status flags and the Next.js build cache." },
  { id: "appScratch", label: "App working files",           desc: "Vek-Snap's own scratch under <install>/Temp: timeline frame previews & exports, segmentation staging, audio analysis and video-restore staging." },
  { id: "output",     label: "Rendered output (your work)", desc: "Everything in ComfyUI/output: your finished renders. Deleted only on explicit request.", protected: true },
];
// Categories cleared by "Clear All" and the on-exit sweep (output is excluded).
const CLEAR_ALL_IDS = TEMP_CATEGORIES.filter((c) => !c.protected).map((c) => c.id);

// Chromium/Electron cache directories inside userData (the leaked-render cache
// lives in Cache/Cache_Data). Local Storage / IndexedDB are intentionally NOT
// listed: they hold the user's prefs and autosave.
function userDataCacheDirs() {
  const ud = app.getPath("userData");
  return [
    path.join(ud, "Cache"),
    path.join(ud, "Code Cache"),
    path.join(ud, "GPUCache"),
    path.join(ud, "DawnGraphiteCache"),
    path.join(ud, "DawnWebGPUCache"),
    path.join(ud, "ShaderCache"),
    path.join(ud, "GrShaderCache"),
    path.join(ud, "blob_storage"),
    path.join(ud, "Service Worker", "CacheStorage"),
    path.join(ud, "Service Worker", "ScriptCache"),
  ];
}

// Resolve a category to concrete filesystem targets.
//   contents : directories whose CHILDREN are deleted (dir kept)
//   prefix   : { dir, prefixes, exts, exclude } - only name-matching entries deleted
function categoryFsTargets(id) {
  switch (id) {
    case "appCache":
      return { contents: userDataCacheDirs(), prefix: [] };
    case "comfyInput":
      return { contents: [path.join(COMFY_DIR, "input")], prefix: [] };
    case "comfyTemp":
      return { contents: [path.join(COMFY_DIR, "temp")], prefix: [] };
    case "computeCache":
      // Regenerable Torch/Triton/XDG caches (see veksnap-settings.getHfCacheEnv).
      // Contents cleared, dir kept. Deliberately excludes <install>/.hf_cache,
      // which holds installer-provisioned tokenizers/models required offline.
      return { contents: [path.join(INSTALL_ROOT, ".cache")], prefix: [] };
    case "osScratch":
      return {
        contents: [LOG_DIR, path.join(NEXT_CACHE, "cache")],
        prefix: [
          // veksnap-* flag/scratch files in OS temp, but NOT the veksnap-logs
          // directory (its CONTENTS are handled above; the dir is kept).
          { dir: os.tmpdir(), prefixes: ["veksnap-", "veksnap_"], exts: null, exclude: ["veksnap-logs"] },
          { dir: APP_DIR, prefixes: ["_enrich_directions_", "_scene_prompts_", "_rewrite_scene_", "_script_writer_", "temp_"], exts: [".json"] },
        ],
      };
    case "appScratch":
      // Install-local content scratch (see src/lib/scratch-dir.ts). Contents
      // cleared, dir kept. Never holds finished renders (those are in output).
      return { contents: [path.join(INSTALL_ROOT, "Temp")], prefix: [] };
    case "output":
      return { contents: [path.join(COMFY_DIR, "output")], prefix: [] };
    default:
      return { contents: [], prefix: [] };
  }
}

function matchesPrefix(name, prefixes, exts, exclude) {
  if (exclude && exclude.includes(name)) return false;
  if (!prefixes.some((pre) => name.startsWith(pre))) return false;
  if (exts && !exts.some((e) => name.toLowerCase().endsWith(e))) return false;
  return true;
}

// ── Size helpers (async, symlink-safe, never throw) ──
async function pathSize(p) {
  let st;
  try { st = await fsp.lstat(p); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let names;
  try { names = await fsp.readdir(p); } catch { return 0; }
  let total = 0;
  for (const name of names) total += await pathSize(path.join(p, name));
  return total;
}
async function prefixSize(dir, prefixes, exts, exclude) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return 0; }
  let total = 0;
  for (const name of names) {
    if (!matchesPrefix(name, prefixes, exts, exclude)) continue;
    total += await pathSize(path.join(dir, name));
  }
  return total;
}
async function scanCategory(id) {
  const t = categoryFsTargets(id);
  let bytes = 0;
  for (const d of t.contents) bytes += await pathSize(d);
  for (const pm of t.prefix) bytes += await prefixSize(pm.dir, pm.prefixes, pm.exts, pm.exclude);
  return bytes;
}

// ── Delete helpers (best-effort: locked files are skipped, never fatal) ──
async function clearDirContents(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return; }
  for (const name of names) {
    try { await fsp.rm(path.join(dir, name), { recursive: true, force: true }); } catch { /* locked - skip */ }
  }
}
async function removeByPrefix(dir, prefixes, exts, exclude) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return; }
  for (const name of names) {
    if (!matchesPrefix(name, prefixes, exts, exclude)) continue;
    try { await fsp.rm(path.join(dir, name), { recursive: true, force: true }); } catch { /* locked - skip */ }
  }
}
async function clearCategory(id) {
  // The Chromium HTTP cache (leaked render previews) is held open by the live
  // session while running: evict it via the session API first, which works
  // without a restart. Local Storage is preserved (clearCache only).
  if (id === "appCache") {
    try {
      const { session } = require("electron");
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({ storages: ["cachestorage", "serviceworkers", "shadercache"] });
    } catch { /* best effort */ }
  }
  const t = categoryFsTargets(id);
  for (const d of t.contents) await clearDirContents(d);
  for (const pm of t.prefix) await removeByPrefix(pm.dir, pm.prefixes, pm.exts, pm.exclude);
}

// ── IPC surface for the renderer's "Clear Temporary Files" dialog ──
ipcMain.handle("temp:scan", async () => {
  const categories = await Promise.all(TEMP_CATEGORIES.map(async (c) => ({
    id: c.id,
    label: c.label,
    description: c.desc,
    protected: !!c.protected,
    bytes: await scanCategory(c.id),
  })));
  return { categories, clearAllIds: CLEAR_ALL_IDS };
});
ipcMain.handle("temp:clear", async (_event, ids) => {
  const list = Array.isArray(ids) ? ids : [];
  const cleared = [];
  for (const id of list) {
    if (!TEMP_CATEGORIES.some((c) => c.id === id)) continue;
    const before = await scanCategory(id);
    await clearCategory(id);
    const after = await scanCategory(id);
    cleared.push({ id, freedBytes: Math.max(0, before - after) });
    log(`[Shell] Cleared temp category '${id}', freed ${Math.max(0, before - after)} bytes`);
  }
  return { cleared };
});
ipcMain.handle("temp:getClearOnExit", () => clearTempOnExitEnabled());
ipcMain.handle("temp:setClearOnExit", (_event, value) => {
  const prefs = readShellPrefs();
  prefs.clearTempOnExit = !!value;
  writeShellPrefs(prefs);
  log(`[Shell] Clear-temp-on-exit set to ${!!value}`);
  return !!value;
});

// ── App icon ────────────────────────────────────────────────────────────────
// The app uses the single canonical icon.ico shipped by the installer (Light
// theme). The former in-app Light/Dark icon switcher was removed: it depended on
// retargeting .lnk shortcuts at runtime, which was unreliable across Windows
// shell-cache states. The window icon is set at BrowserWindow creation below.

// ── On-exit sweep: wipes caches + ComfyUI input/temp + OS scratch when enabled ──
let exitMaintenanceDone = false;
async function runExitMaintenance() {
  if (exitMaintenanceDone) return;
  exitMaintenanceDone = true;
  if (!clearTempOnExitEnabled()) return;
  log("[Shell] Clear-on-exit enabled, wiping caches & working files...");
  for (const id of CLEAR_ALL_IDS) {
    try { await clearCategory(id); } catch { /* best effort */ }
  }
  log("[Shell] Clear-on-exit sweep complete.");
}

// ── Wait for a single HTTP response (used to check if server is already running) ──
function httpPing(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// ── Server health watchdog: restart if server dies while app is running ──
// IMPORTANT: Only active after appLoaded=true (initial compilation done).
// Only reacts to ECONNREFUSED (server dead), NOT timeouts (server busy).
function startHealthCheck() {
  healthTimer = setInterval(() => {
    if (isQuitting || !serverReady || !appLoaded) return;
    const req = http.get(APP_URL, (res) => {
      // Server is alive
      res.resume();
    });
    req.on("error", (err) => {
      // Only treat connection refused as a real crash.
      // Timeouts just mean the server is busy (compiling routes, GC, etc.)
      if (err.code !== "ECONNREFUSED") return;
      // Check if this was an intentional shutdown
      if (fs.existsSync(SHUTDOWN_FLAG)) {
        log("[Shell] Shutdown flag detected, intentional shutdown");
        try { fs.unlinkSync(SHUTDOWN_FLAG); } catch {}
        cleanup();
        app.quit();
        return;
      }
      log(`[Shell] Health check: connection refused, server is dead`);
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        // Show recovery splash and attempt restart
        serverReady = false;
        appLoaded = false;
        mainWindow.loadURL(LOADING_HTML);
        updateSplash("Orchestration layer crashed, restarting...");
        restartServer();
      }
    });
    req.setTimeout(15000, () => { req.destroy(); });
  }, HEALTH_CHECK_INTERVAL);
}

// ── Memory pressure watchdog ──
// Monitors system RAM and takes protective action before Windows OOM-kills us.
function startMemoryWatch() {
  memoryTimer = setInterval(() => {
    if (isQuitting) return;
    const freeMB = os.freemem() / (1024 * 1024);
    const totalMB = os.totalmem() / (1024 * 1024);
    const usedPct = Math.round(((totalMB - freeMB) / totalMB) * 100);

    if (freeMB < LOW_MEMORY_MB) {
      log(`[Shell] LOW MEMORY: ${Math.round(freeMB)}MB free (${usedPct}% used)`);

      // 1. Force garbage collection in our renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(
          "try { if(window.gc) window.gc(); } catch{}"
        ).catch(() => {});
      }

      // 2. Clear renderer caches (back-forward cache, HTTP cache)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.session.clearCache().catch(() => {});
      }

      // 3. Trim working set (only once per low-memory episode, not every 5s)
      if (!memoryWarningShown) {
        memoryWarningShown = true;
        log("[Shell] Trimming working set to reduce memory pressure");
        try {
          execSync(
            'powershell -NoProfile -Command "[System.Diagnostics.Process]::GetCurrentProcess().MinWorkingSet = [IntPtr]::new(204800)"',
            { windowsHide: true, stdio: "ignore", timeout: 3000 }
          );
        } catch {}
      }

      // 4. If critically low (<100MB), log but don't alter window title
      if (freeMB < 100) {
        log("[Shell] CRITICAL: <100MB free, system under heavy memory pressure");
      }
    } else if (freeMB > LOW_MEMORY_MB * 2 && memoryWarningShown) {
      // Memory recovered
      memoryWarningShown = false;
      log(`[Shell] Memory recovered: ${Math.round(freeMB)}MB free`);
    }
  }, MEMORY_CHECK_INTERVAL);
}

// ── Restart the dev server after a crash ──
async function restartServer() {
  log("[Shell] Attempting server restart...");
  // Kill anything left
  if (serverProcess && serverProcess.pid) killTree(serverProcess.pid);
  killByPort(UI_PORT);
  // Wait for the port to actually be released (not an arbitrary delay)
  await waitForPortFree(UI_PORT, 10000);

  try {
    // spawnServer() is event-driven: resolves when "Ready" signal appears
    serverProcess = await spawnServer();
    serverReady = true;
    loadRetryCount = 0;
    loadApp();
  } catch (err) {
    log(`[Shell] Restart failed: ${err.message}`);
    showError("Server restart failed", err.message);
  }
}

// ── Start the Next.js dev server (event-driven, no polling) ──
// Returns { child, ready } where ready is a Promise that resolves
// when the server reports it is listening (via stdout signal).
async function startDevServer() {
  // Clean orphans from previous crashes
  cleanupOrphans();
  // Wait for the port to actually be released (not an arbitrary delay)
  await waitForPortFree(UI_PORT, 10000);

  // Check if server is already running (e.g. started manually)
  const alreadyUp = await httpPing(APP_URL);
  if (alreadyUp) {
    log("[Shell] Server already running, attaching");
    return null;
  }

  // In production mode, build first (skip if .next/BUILD_ID already exists)
  if (isProd) {
    const buildId = path.join(APP_DIR, ".next", "BUILD_ID");
    if (!fs.existsSync(buildId)) {
      await runProductionBuild();
    } else {
      log("[Shell] Production build already exists, skipping rebuild");
      updateSplash("Using cached production build...", 30);
    }
  }

  return spawnServer();
}

// In production mode, run `node scripts/build.js` first, then start the server.
function runProductionBuild() {
  return new Promise((resolve, reject) => {
    log("[Shell] Building production bundle...");
    updateSplash("Building production bundle...", 20);
    const fixPath = path.resolve(APP_DIR, "scripts", "fix-readlink.js").replace(/\\/g, "/");
    const buildEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: `--require "${fixPath}"` };
    const build = spawn("node", ["scripts/build.js"], {
      cwd: APP_DIR, shell: true, stdio: "pipe", windowsHide: true, env: buildEnv,
    });
    build.stdout.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const t = line.trim();
        if (t) log(t);
        if (t.includes("Compiled")) updateSplash(t, 45);
        if (t.includes("Generating")) updateSplash(t, 55);
      }
    });
    build.stderr.on("data", (d) => { for (const l of d.toString().split("\n")) { if (l.trim()) log(`[INFO] ${l.trim()}`); } });
    build.on("exit", (code) => {
      if (code === 0) { log("[Shell] Production build complete"); resolve(); }
      else { reject(new Error(`Build failed with code ${code}`)); }
    });
  });
}

// Spawns Next.js and returns a Promise that resolves when the server
// signals readiness via stdout ("Ready" or "Local:" pattern).
// No arbitrary timeout: just event-driven signal detection.
function spawnServer() {
  const mode = isProd ? "production" : "dev";
  // Bind to 127.0.0.1 (loopback only), never 0.0.0.0, so the UI server is
  // not reachable from the network.
  const cmd = isProd
    ? ["run", "start", "--", "-H", "127.0.0.1", "-p", String(UI_PORT)]
    : ["run", "dev", "--", "-H", "127.0.0.1", "-p", String(UI_PORT)];
  log(`[Shell] Starting Next.js ${mode} server...`);
  return new Promise((resolve, reject) => {
    const child = spawn("npm", cmd, {
      cwd: APP_DIR,
      shell: true,
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, BROWSER: "none", NEXT_TELEMETRY_DISABLED: "1" },
    });

    // Write PID immediately so we can clean up even if Electron crashes
    if (child.pid) {
      lastServerPid = child.pid;
      writePidFile(child.pid);
      log(`[Shell] Server PID: ${child.pid}`);
    }

    let resolved = false;
    const startTime = Date.now();

    // ── SIGNAL: Watch stdout for the "Ready" or "Local: http://" line ──
    // Next.js prints "✓ Ready in Xs" when the server is listening.
    child.stdout.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) log(trimmed);

        // Detect Next.js readiness signals
        if (!resolved && (trimmed.includes("Ready in") || (trimmed.includes("Local:") && (trimmed.includes("localhost") || trimmed.includes("127.0.0.1"))))) {
          resolved = true;
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          log(`[Shell] ✓ Server READY signal received (${elapsed}s)`);
          updateSplash(`System ready (${elapsed}s), loading app...`, 65);
          resolve(child);
        }

        // Update splash with compilation progress
        if (!resolved && trimmed.includes("Compiling")) {
          updateSplash(`${trimmed}`, 40);
        }
      }
    });

    child.stderr.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) log(`[INFO] ${line.trim()}`);
      }
    });

    child.on("exit", (code) => {
      log(`[Shell] ${isProd ? "Production" : "Dev"} server exited with code ${code}`);
      clearPidFile();
      serverProcess = null;

      // Intentional shutdown (flag written by /api/shutdown-all), honor it FIRST,
      // regardless of serverReady/recovery state, so the app reliably quits even
      // when the server is killed mid-recovery (fixes "shutdown doesn't close").
      if (!isQuitting && fs.existsSync(SHUTDOWN_FLAG)) {
        log("[Shell] Shutdown flag detected, intentional shutdown, quitting.");
        try { fs.unlinkSync(SHUTDOWN_FLAG); } catch {}
        cleanup();
        app.quit();
        return;
      }

      if (!resolved) {
        // Server died before becoming ready
        resolved = true;
        reject(new Error(`Server exited with code ${code} before becoming ready`));
      } else if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
        // Server died after being ready, attempt recovery
        log("[Shell] Unexpected server exit, triggering restart");
        serverReady = false;
        appLoaded = false;
        mainWindow.loadURL(LOADING_HTML);
        // Use immediate async restart: waitForPortFree inside handles timing
        setTimeout(() => updateSplash("Orchestration layer stopped, restarting..."), 100);
        restartServer();
      }
    });

    // Safety: if no signal after 10 minutes, something is very wrong
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Server never reported ready (10 min). Check logs."));
      }
    }, 600000);
  });
}

// ── Loading splash: file-based HTML with video animation ──
const SPLASH_HTML = path.join(__dirname, "splash.html");
// Prefer the loading video bundled WITH the app (ships in shell/, so it is always
// present regardless of install layout). Fall back to the legacy install-root
// location for older install layouts, then to the inline spinner.
const LOADING_VIDEO = [
  path.join(__dirname, "Ve-Snap_Loading.mp4"),
  path.join(INSTALL_ROOT, "8_Loading_Animations", "Loading_Compact.mov"),
].find((p) => fs.existsSync(p)) || path.join(__dirname, "Ve-Snap_Loading.mp4");

// Determine splash URL: prefer file-based with video, fallback to inline spinner
const HAS_SPLASH_VIDEO = fs.existsSync(SPLASH_HTML) && fs.existsSync(LOADING_VIDEO);
const LOADING_HTML = HAS_SPLASH_VIDEO
  ? `file:///${SPLASH_HTML.replace(/\\/g, "/")}`
  : `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  body { margin:0; background:#000000; display:flex; align-items:center; justify-content:center; height:100vh; font-family:system-ui,-apple-system,sans-serif; -webkit-app-region:drag; }
  .wrap { text-align:center; }
  h1 { color:#89b4fa; font-size:1.5rem; margin-bottom:0.5rem; }
  p { color:#6c7086; font-size:0.85rem; margin:0.25rem 0; }
  #status { color:#9399b2; font-size:0.8rem; margin-top:0.5rem; }
  .spinner { width:32px; height:32px; border:3px solid #313244; border-top-color:#89b4fa; border-radius:50%; animation:spin 0.8s linear infinite; margin:1.5rem auto; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .progress-track { width:200px; height:3px; background:#313244; border-radius:2px; margin:1rem auto 0; overflow:hidden; }
  .progress-fill { height:100%; width:0%; background:linear-gradient(90deg,#89b4fa,#74c7ec); border-radius:2px; transition:width 0.4s ease; }
  .hint { color:#45475a; font-size:0.7rem; margin-top:1rem; }
</style></head><body>
  <div class="wrap">
    <h1>Vek-Snap</h1>
    <div class="spinner"></div>
    <p id="status">Starting orchestration layer...</p>
    <div class="progress-track"><div id="progress-fill" class="progress-fill"></div></div>
    <p class="hint">First launch compiles all pages (~15–30s)</p>
  </div>
</body></html>`)}`;

// ── Window state persistence ──
function loadWindowState() {
  try {
    if (fs.existsSync(WINDOW_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, "utf-8"));
    }
  } catch { /* corrupt or missing, use defaults */ }
  return null;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const maximized = mainWindow.isMaximized();
    // Save normal (non-maximized) bounds so restore position works correctly
    const bounds = maximized ? (mainWindow._lastNormalBounds || mainWindow.getNormalBounds()) : mainWindow.getBounds();
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized,
    }), "utf-8");
  } catch { /* best effort */ }
}

function isWindowOnScreen(state) {
  // Verify saved position is on an active display (handles disconnected monitors)
  const { screen } = require("electron");
  const displays = screen.getAllDisplays();
  const centerX = state.x + state.width / 2;
  const centerY = state.y + state.height / 2;
  return displays.some((d) => {
    const b = d.bounds;
    return centerX >= b.x && centerX < b.x + b.width &&
           centerY >= b.y && centerY < b.y + b.height;
  });
}

// ── Create the main application window (shows immediately with loading splash) ──
function createWindow() {
  const saved = loadWindowState();
  const usePosition = saved && isWindowOnScreen(saved);

  mainWindow = new BrowserWindow({
    width: usePosition ? saved.width : 1600,
    height: usePosition ? saved.height : 1000,
    ...(usePosition ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1200,
    minHeight: 700,
    title: "Vek-Snap",
    icon: path.join(__dirname, "icon.ico"),
    backgroundColor: "#000000", // Pitch black - clean canvas for logo splash
    frame: false,                // Frameless - custom title bar rendered by React
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      devTools: true,
      backgroundThrottling: true,  // Allow OS to throttle when not focused
      // Enable the spellcheck machinery at frame-creation time. Creating the
      // frame with this false disables Chromium's spellchecker entirely, so a
      // later session.setSpellCheckerEnabled(true) never underlines until a
      // reload: the bug users saw. We keep it feature-enabled here and instead
      // hold the *session* checker OFF by default (below), which the Settings
      // toggle can flip live via the "set-spellcheck" IPC.
      spellcheck: true,
    },
  });

  // Privacy-first default: feature is compiled-in (above) but the session
  // spellchecker starts OFF; the UI's useSpellcheck() hook flips it on demand.
  try { mainWindow.webContents.session.setSpellCheckerEnabled(false); } catch { /* older Electron */ }

  // ── Window control IPC (for custom title bar) ──, listeners on mainWindow events
  mainWindow.on("maximize", () => mainWindow?.webContents.send("window-maximized-changed", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window-maximized-changed", false));

  // Hidden menu: restores Ctrl+C/V/X/A/Z accelerators (Electron removes them
  // when setApplicationMenu(null) is called). Menu is invisible because frame:false.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  }]));

  // ── Right-click context menu (Cut / Copy / Paste / Select All) ──
  // Context-sensitive: editable fields get the full edit set (+ spellcheck
  // suggestions when enabled); selected/standard content gets copy/select-all;
  // links and images get copy helpers. Built natively so it works offline and
  // matches the OS look.
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const wc = mainWindow.webContents;
    const template = [];
    const { isEditable, editFlags = {}, selectionText, misspelledWord, dictionarySuggestions = [], linkURL, mediaType, srcURL } = params;
    const hasSelection = !!(selectionText && selectionText.trim().length > 0);

    // Spellcheck suggestions for a misspelled word in an editable field.
    if (isEditable && misspelledWord) {
      if (dictionarySuggestions.length > 0) {
        for (const suggestion of dictionarySuggestions) {
          template.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
        }
      } else {
        template.push({ label: "No spelling suggestions", enabled: false });
      }
      template.push({
        label: "Add to dictionary",
        click: () => wc.session.addWordToSpellCheckerDictionary(misspelledWord),
      });
      template.push({ type: "separator" });
    }

    if (isEditable) {
      template.push(
        { role: "undo", enabled: editFlags.canUndo !== false },
        { role: "redo", enabled: editFlags.canRedo !== false },
        { type: "separator" },
        { role: "cut", enabled: editFlags.canCut !== false },
        { role: "copy", enabled: editFlags.canCopy !== false },
        { role: "paste", enabled: editFlags.canPaste !== false },
        { role: "selectAll" },
      );
    } else {
      if (hasSelection) {
        template.push({ role: "copy", enabled: editFlags.canCopy !== false });
      }
      // Image helpers (non-editable context).
      if (mediaType === "image" && srcURL) {
        if (template.length > 0) template.push({ type: "separator" });
        template.push({ label: "Copy image", click: () => wc.copyImageAt(params.x, params.y) });
      }
      // Link helpers.
      if (linkURL) {
        if (template.length > 0) template.push({ type: "separator" });
        template.push({
          label: "Copy link address",
          click: () => { try { clipboard.writeText(linkURL); } catch { /* ignore */ } },
        });
      }
      // NOTE: no "Select All" for non-editable content. Selecting the entire
      // document/window is never useful and looked broken (it highlighted the
      // whole app). Text fields still get Select All via the isEditable branch,
      // and the Timeline handles Ctrl+A itself (selects all clips). With nothing
      // to offer here (e.g. a right-click on empty chrome), no menu is shown.
    }

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // Load the splash immediately: swap to real app later
  mainWindow.loadURL(LOADING_HTML);

  // Inject video source whenever the splash HTML is loaded (including recovery reloads)
  if (HAS_SPLASH_VIDEO) {
    mainWindow.webContents.on("did-finish-load", () => {
      const currentURL = mainWindow.webContents.getURL();
      if (currentURL.includes("splash.html")) {
        const videoUrl = `file:///${LOADING_VIDEO.replace(/\\/g, "/")}`;
        mainWindow.webContents.executeJavaScript(
          `if(window.setVideoSrc) window.setVideoSrc('${videoUrl.replace(/'/g, "\\'")}');`
        ).catch(() => {});
      }
    });
  }

  // Show window as soon as the splash renders (nearly instant)
  let windowShown = false;
  const showAndRestore = () => {
    mainWindow.show();
    mainWindow.focus();
    // Restore maximized state after show (must be after show or it's ignored)
    if (usePosition && saved.maximized) {
      mainWindow.maximize();
    }
  };
  mainWindow.once("ready-to-show", () => {
    if (!windowShown) {
      windowShown = true;
      log("[Shell] ready-to-show fired, showing window");
      showAndRestore();
    }
  });
  // Safety: force-show after 5s if ready-to-show never fires
  setTimeout(() => {
    if (!windowShown && mainWindow && !mainWindow.isDestroyed()) {
      windowShown = true;
      log("[Shell] WARNING: ready-to-show did not fire, force-showing window");
      showAndRestore();
    }
  }, 5000);

  // ── Save window state on move/resize (debounced) ──
  let saveTimeout = null;
  const debouncedSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveWindowState, 500);
  };
  mainWindow.on("resize", () => {
    if (!mainWindow.isMaximized()) mainWindow._lastNormalBounds = mainWindow.getBounds();
    debouncedSave();
  });
  mainWindow.on("move", () => {
    if (!mainWindow.isMaximized()) mainWindow._lastNormalBounds = mainWindow.getBounds();
    debouncedSave();
  });
  mainWindow.on("maximize", debouncedSave);
  mainWindow.on("unmaximize", debouncedSave);

  // ── Handle page load failures (ChunkLoadError, timeout, etc.) ──
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    // Ignore cancelled navigations (e.g. user clicked away during load)
    if (errorCode === -3) return;
    log(`[Shell] Page load failed: ${errorDescription} (code ${errorCode}), ${validatedURL}`);

    if (loadRetryCount < MAX_LOAD_RETRIES) {
      loadRetryCount++;
      log(`[Shell] Retrying load (${loadRetryCount}/${MAX_LOAD_RETRIES})...`);
      mainWindow.loadURL(LOADING_HTML);
      updateSplash(`Load failed, verifying system (${loadRetryCount}/${MAX_LOAD_RETRIES})...`);
      // Verify server is actually responding before retrying navigation
      ensureServerResponding(30000).then((ok) => {
        if (ok && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(START_URL);
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          showError("Server not responding", "The development server is not responding.\nCheck logs for details.");
        }
      });
    } else {
      showError("Failed to load application", `${errorDescription}\n\nExhausted ${MAX_LOAD_RETRIES} retries. The server may still be compiling.`);
    }
  });

  // ── Handle renderer crashes (OOM kill, GPU crash, etc.) ──
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    const isOOM = details.reason === "oom" || details.reason === "crashed";
    log(`[Shell] Renderer gone: reason=${details.reason}, exitCode=${details.exitCode}`);

    if (!isQuitting && loadRetryCount < MAX_LOAD_RETRIES) {
      loadRetryCount++;
      // The React app is gone, mark it not-loaded so the window 'close' handler
      // won't try to round-trip a confirm dialog to the listener-less splash
      // (otherwise the window gets stuck open and needs a taskkill).
      appLoaded = false;
      mainWindow.loadURL(LOADING_HTML);

      if (isOOM) {
        // OOM crash, wait for memory to stabilize, then verify server before reloading
        log("[Shell] OOM detected, waiting for memory pressure to ease...");
        updateSplash("Out of memory, waiting for RAM to free up...");
        mainWindow.webContents.session.clearCache().catch(() => {});
        // Poll until memory recovers, then verify server before loading
        const waitForMem = setInterval(() => {
          if (isQuitting) { clearInterval(waitForMem); return; }
          const freeMB = os.freemem() / (1024 * 1024);
          if (freeMB > 200) {
            clearInterval(waitForMem);
            log(`[Shell] Memory recovered (${Math.round(freeMB)}MB free), verifying server...`);
            updateSplash("Memory recovered, verifying system...");
            ensureServerResponding(15000).then((ok) => {
              if (ok && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.loadURL(START_URL);
              }
            });
          } else {
            updateSplash(`Waiting for RAM... (${Math.round(freeMB)}MB free, need 200MB+)`);
          }
        }, 3000);
      } else {
        // Non-OOM crash, verify server is responding, then reload
        updateSplash("Renderer crashed, verifying system...");
        ensureServerResponding(15000).then((ok) => {
          if (ok && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(START_URL);
          }
        });
      }
    }
  });

  // ── Intercept console errors for ChunkLoadError (JS-level timeouts) ──
  mainWindow.webContents.on("console-message", (event, level, message) => {
    if (level === 3 && message.includes("ChunkLoadError")) {
      log(`[Shell] ChunkLoadError detected, verifying server before reload`);
      if (loadRetryCount < MAX_LOAD_RETRIES) {
        loadRetryCount++;
        // Verify server is alive before reloading (don't blindly retry)
        ensureServerResponding(10000).then((ok) => {
          if (ok && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.reload();
          }
        });
      }
    }
  });

  // ── Track when the real app page finishes loading (compilation done) ──
  mainWindow.webContents.on("did-finish-load", () => {
    const currentURL = mainWindow.webContents.getURL();
    if (currentURL.startsWith(APP_URL)) {
      if (!appLoaded) {
        appLoaded = true;
        loadRetryCount = 0;
        log("[Shell] ✓ App page loaded successfully, health checks now active");
      }
    }
  });

  // ── Fix drag-and-drop: prevent Electron from navigating to dropped files ──
  // Modern Electron can intercept file drops as navigation events at the process
  // level before renderer JavaScript handlers fire. Block all file:// navigations.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://") || url.startsWith("blob:")) {
      event.preventDefault();
    }
  });

  // Open external links in the OS browser, not in our window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // ── Close confirmation ──
  // Sends IPC to renderer to show a themed confirmation dialog.
  mainWindow.on("close", (event) => {
    // Always save window state before closing
    saveWindowState();

    // If we're already quitting, the user already confirmed, or the React app
    // isn't actually loaded (splash / crash-recovery / OOM screen is showing,
    // nothing there can render the confirm dialog), just let the window close.
    if (isQuitting || closeConfirmed || !appLoaded) return;

    event.preventDefault();

    // Ask the renderer to show the themed confirm dialog.
    mainWindow.webContents.send("confirm-close", hasUnsavedChanges);

    // Safety net for the "window won't close / must taskkill" bug: the renderer
    // ACKs this message synchronously (see preload). If no ack arrives the
    // renderer is dead, hung, or a non-app page is showing, force the close so
    // the window can never get permanently stuck open.
    clearForceCloseTimer();
    forceCloseTimer = setTimeout(() => {
      forceCloseTimer = null;
      log("[Shell] confirm-close not acknowledged by renderer, forcing close.");
      closeConfirmed = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, 3000);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Navigate window to real app once server is ready ──
function loadApp() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log("[Shell] Server ready, loading app");
    loadRetryCount = 0;
    mainWindow.loadURL(START_URL);
  }
}

// ── Show error in the window with retry button ──
function showError(title, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  body{margin:0;background:#1e1e2e;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;}
  .wrap{text-align:center;max-width:500px;padding:2rem;}
  h1{color:#f43f5e;font-size:1.3rem;margin-bottom:0.5rem;}
  p{color:#71717a;font-size:0.85rem;white-space:pre-wrap;margin:0.5rem 0;}
  button{margin-top:1.5rem;padding:0.5rem 1.5rem;background:#f43f5e;color:white;border:none;border-radius:6px;font-size:0.9rem;cursor:pointer;}
  button:hover{background:#e11d48;}
  .log{color:#3f3f46;font-size:0.7rem;margin-top:1rem;}
</style></head><body>
<div class="wrap">
  <h1>${title}</h1>
  <p>${detail}</p>
  <button onclick="location.href='${START_URL}'">Retry</button>
  <p class="log">Logs: ${LOG_FILE.replace(/\\/g, "/")}</p>
</div></body></html>`)}`;
  mainWindow.loadURL(html);
}

// ── Conda environment detection (same logic as launcher.mjs) ──
function findCondaEnv(envName) {
  // Prefer the installer-provisioned venv for the core "comfyui" environment.
  // The venv keeps python.exe under Scripts/, so we return that dir (the
  // /api/services resolver appends python.exe / pythonw.exe to it).
  if (envName === "comfyui") {
    const venvScripts = path.join(INSTALL_ROOT, "runtime", "venv", "Scripts");
    if (fs.existsSync(path.join(venvScripts, "python.exe"))) return venvScripts;
  }
  const home = os.homedir();
  const condaRoots = [
    path.join(INSTALL_ROOT, "miniconda"),
    path.join(home, "miniconda3"),
    path.join(home, "anaconda3"),
    path.join(home, "Miniconda3"),
    path.join(home, "Anaconda3"),
    path.join(home, "AppData", "Local", "miniconda3"),
    path.join(home, "AppData", "Local", "anaconda3"),
    "C:\\ProgramData\\miniconda3",
    "C:\\ProgramData\\anaconda3",
    "C:\\Miniconda3",
    "C:\\Anaconda3",
  ];
  for (const root of condaRoots) {
    const candidate = path.join(root, "envs", envName, "python.exe");
    if (fs.existsSync(candidate)) return path.join(root, "envs", envName);
  }
  // Fallback: ~/.conda/environments.txt
  try {
    const envFile = path.join(home, ".conda", "environments.txt");
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
        const p = line.trim();
        if (p && p.endsWith(envName) && fs.existsSync(path.join(p, "python.exe"))) return p;
      }
    }
  } catch {}
  return null;
}

// ── Write service definitions so /api/services can spawn backends ──
function writeServiceDefs() {
  const comfyui = findCondaEnv("comfyui");

  const defs = {
    installRoot: INSTALL_ROOT,
    logDir: LOG_DIR,
    envs: { comfyui },
  };
  fs.writeFileSync(SERVICE_DEFS_PATH, JSON.stringify(defs, null, 2));
  // Also write log dir path for API route
  fs.writeFileSync(path.join(os.tmpdir(), "veksnap-log-dir.txt"), LOG_DIR);

  log(`[Shell] Service defs written: comfyui=${comfyui ? "OK" : "N/A"}`);
  return defs;
}

// ── Check pagefile size on startup, warn if too small for AI workloads ──
function checkPagefile() {
  try {
    const totalRAM_MB = Math.round(os.totalmem() / (1024 * 1024));
    const result = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).SizeStoredInPagingFiles"',
      { windowsHide: true, stdio: "pipe", timeout: 5000, encoding: "utf-8" }
    ).trim();
    const pagefileMB = Math.round(parseInt(result, 10) / 1024) || 0;
    const recommended = Math.max(totalRAM_MB, 48000); // At least 48GB or match RAM

    log(`[Shell] System RAM: ${totalRAM_MB}MB, Pagefile: ${pagefileMB}MB`);
    if (pagefileMB < 1024) {
      log(`[Shell] ⚠ WARNING: No pagefile detected! AI renders WILL crash when RAM fills up.`);
      log(`[Shell] ⚠ Run shell\\setup-pagefile.cmd to create a ${Math.round(recommended / 1024)}GB pagefile.`);
    } else if (pagefileMB < recommended) {
      log(`[Shell] TIP: Pagefile is ${pagefileMB}MB, recommend ${Math.round(recommended / 1024)}GB+ for AI workloads.`);
    }
  } catch {
    log("[Shell] Could not check pagefile configuration");
  }
}

// ── Single instance lock, prevent duplicate launches ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance is already running, quit immediately
  app.quit();
} else {
  app.on("second-instance", () => {
    // User tried to launch again, focus existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ── App lifecycle ──
app.on("ready", async () => {
  initLog();
  hideConsoleWindow();
  // Install the loopback-only network gate on the default session AND every session
  // created later (any ComfyUI partition / BrowserView) BEFORE any content loads.
  NETWORK_GATE_ONLINE = readAllowOnline();
  try {
    const { session } = require("electron");
    installNetworkGate(session.defaultSession);
    app.on("session-created", (sess) => installNetworkGate(sess));
    log(`[NetGate] loopback-only network gate ${NETWORK_GATE_ONLINE ? "DISABLED (allowOnline=true)" : "ACTIVE"}`);
  } catch (err) {
    log(`[NetGate] install failed: ${err.message}`);
  }
  log(`Vek-Snap Electron shell starting... (${isProd ? "Production" : "Development"} mode)`);
  log(`[Shell] App dir: ${APP_DIR}`);
  log(`[Shell] Workspace root: ${INSTALL_ROOT}`);
  log(`[Shell] Log file: ${LOG_FILE}`);

  // Check system configuration
  checkPagefile();

  // Write service definitions (conda envs, paths) for the API
  writeServiceDefs();

  // Clear stale webpack cache on startup to prevent ChunkLoadErrors
  clearNextCache();

  // Create system tray icon
  try {
    const iconPath = path.join(__dirname, "icon.ico");
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
      tray.setToolTip("Vek-Snap");
      const trayMenu = Menu.buildFromTemplate([
        { label: "Show Vek-Snap", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: "separator" },
        { label: "Quit", click: async () => { await runExitMaintenance(); cleanup(); app.quit(); } },
      ]);
      tray.setContextMenu(trayMenu);
      tray.on("double-click", () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    }
  } catch (err) {
    log(`[Shell] Tray icon failed: ${err.message}`);
  }

  // Show window immediately with loading splash
  createWindow();
  updateSplash("Checking system configuration...", 5);

  try {
    updateSplash("Cleaning up previous sessions...", 15);
    updateSplash("Starting orchestration layer...", 25);
    serverProcess = await startDevServer();
    // startDevServer resolves only AFTER the server signals ready.
    // No polling, no timeout guessing; the server told us it's listening.

    // Mark ready and start monitoring
    serverReady = true;
    updateSplash("Server ready, starting health monitors...", 70);
    startHealthCheck();
    startMemoryWatch();

    // Navigate to the real app, Next.js will hold the response
    // until page compilation is done (event-driven by HTTP itself).
    updateSplash("Loading application...", 85);
    loadApp();
  } catch (err) {
    log(`[Shell] Failed to start: ${err}`);
    showError("Startup Failed", err.message || String(err));
  }
});

// ── Multiple cleanup hooks, ensure we never orphan processes ──
app.on("before-quit", () => {
  log("[Shell] before-quit, arming watchdog + running cleanup.");
  armShutdownWatchdog("before-quit");
  cleanup();
});
app.on("window-all-closed", async () => {
  // All windows are gone, the Chromium session has released its cache files,
  // so the optional on-exit sweep can delete them cleanly before we quit.
  log("[Shell] window-all-closed, beginning shutdown sequence.");
  armShutdownWatchdog("window-all-closed");
  // Timeout-guarded: a sweep that stalls on a file still locked by a not-yet-
  // killed backend (ComfyUI input/temp) can NEVER block the quit.
  await withTimeout(runExitMaintenance(), 5000, "On-exit maintenance sweep");
  cleanup();
  log("[Shell] Shutdown sequence complete, calling app.quit().");
  app.quit();
});
app.on("will-quit", () => log("[Shell] will-quit."));
app.on("quit", () => log("[Shell] quit, process exiting."));

// Safety nets for unexpected exits
process.on("exit", cleanup);
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("uncaughtException", (err) => {
  log(`[Shell] Uncaught exception: ${err.message}`);
  cleanup();
  process.exit(1);
});

app.on("activate", () => {
  if (mainWindow === null) createWindow();
});
