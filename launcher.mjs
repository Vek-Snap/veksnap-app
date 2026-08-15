#!/usr/bin/env node
/**
 * Vek-Snap Launcher (v2, on-demand services)
 *
 * Starts ONLY the Next.js web UI. Backend services (ComfyUI) are started
 * on-demand from the Service Manager panel in the UI.
 *
 * The launcher detects conda environments and writes service definitions
 * to a temp file so the /api/services route can spawn services with the
 * correct paths, args, and environment variables.
 *
 * Usage:
 *   node launcher.mjs           (development: uses `npm run dev`)
 *   node launcher.mjs --prod    (production: uses `npm run start`, requires build first)
 */

import { spawn, execSync } from "child_process";
import { mkdirSync, createWriteStream, writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { tmpdir, homedir } from "os";
import { fileURLToPath } from "url";
import http from "http";

// Keep the process alive: stdin prevents Node from exiting when all children are piped
process.stdin.resume();

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = join(__dirname, "..");
const LOG_DIR = join(tmpdir(), "veksnap-logs");
const SERVICE_DEFS_PATH = join(tmpdir(), "veksnap-service-defs.json");
const isProd = process.argv.includes("--prod");
const LOCK_FILE = join(tmpdir(), "veksnap-launcher.lock");
// Loopback-only UI server on a non-standard high port (NEVER the predictable framework default).
// Mirrors the packaged Electron shell (shell/main.js UI_PORT) and binds to 127.0.0.1
// so the dev server is never reachable from the network.
const UI_HOST = "127.0.0.1";
const UI_PORT = 41573;

// ── Instance detection helpers ──

function isProcessRunning(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
      encoding: "utf-8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

function askUser(question) {
  if (!process.stdin.isTTY) return Promise.resolve("y");
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => resolve(data.toString().trim().toLowerCase()));
  });
}

async function checkExistingInstance() {
  if (!existsSync(LOCK_FILE)) return;
  try {
    const oldPid = readFileSync(LOCK_FILE, "utf-8").trim();
    if (!oldPid || !/^\d+$/.test(oldPid)) return;
    if (parseInt(oldPid) === process.pid) return;
    if (!isProcessRunning(parseInt(oldPid))) return;

    console.log("");
    console.log("  WARNING: A previous Vek-Snap launcher is still running (PID " + oldPid + ").");
    console.log("  Running multiple instances causes orphaned processes and memory leaks.");
    console.log("");
    const answer = await askUser("  Terminate previous instance and continue? [Y/n]: ");
    if (answer === "" || answer === "y" || answer === "yes") {
      console.log("  Terminating previous launcher (PID " + oldPid + ") and its children...");
      try {
        execSync(`taskkill /PID ${oldPid} /T /F`, { windowsHide: true, stdio: "ignore" });
        console.log("  Previous instance terminated.");
      } catch {
        console.log("  Previous instance already exited.");
      }
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.log("  Launch aborted. Close the existing instance first.");
      process.exit(0);
    }
  } catch { /* lock file unreadable, proceed */ }
}

// ── Console window management ──

function hideConsoleWindow() {
  try {
    const psScript = join(tmpdir(), "veksnap-hide-console.ps1");
    writeFileSync(psScript, [
      'Add-Type -Name VekSnapWin -Namespace VekSnap -Member @"',
      '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int s);',
      '"@ -ErrorAction SilentlyContinue',
      '[VekSnap.VekSnapWin]::ShowWindow([VekSnap.VekSnapWin]::GetConsoleWindow(), 0)',
    ].join("\n"));
    // windowsHide must NOT be set here: PowerShell needs to inherit the
    // parent's console so GetConsoleWindow() returns the correct HWND.
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, {
      stdio: "pipe", timeout: 10000,
    });
  } catch { /* not critical */ }
}

async function countdownAndHide(seconds) {
  const isTTY = process.stdin.isTTY;
  if (!isTTY) return; // non-interactive, don't hide

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf-8");

  let cancelled = false;
  const onKey = () => { cancelled = true; };
  process.stdin.on("data", onKey);

  for (let i = seconds; i > 0 && !cancelled; i--) {
    process.stdout.write(`\r  Console will hide in ${String(i).padStart(2)}s, press any key to keep visible  `);
    await new Promise((r) => setTimeout(r, 1000));
  }

  process.stdin.removeListener("data", onKey);
  process.stdin.setRawMode(false);

  if (cancelled) {
    console.log("\n  Console will stay visible. Press Ctrl+C to stop.\n");
  } else {
    console.log("\n  Hiding console window. Use Stop_All.bat or Task Manager to stop.\n");
    hideConsoleWindow();
  }
}

console.log("============================================");
console.log("  Vek-Snap: AI Video Generation");
console.log("  On-Demand Services (v2)");
console.log("============================================");
console.log(`  Launcher dir : ${__dirname}`);
console.log(`  Install root : ${INSTALL_ROOT}`);
console.log(`  Mode         : ${isProd ? "Production" : "Development"}`);
console.log(`  Log dir      : ${LOG_DIR}`);
console.log("");

for (const sub of ["ComfyUI", "veksnap-app"]) {
  const p = join(INSTALL_ROOT, sub);
  if (!existsSync(p)) {
    console.error(`  ERROR: Expected directory not found: ${p}`);
    console.error("  Make sure launcher.mjs is inside the veksnap-app folder.");
    process.exit(1);
  }
}

mkdirSync(LOG_DIR, { recursive: true });

// Write log directory path so the API route can find it
writeFileSync(join(tmpdir(), "veksnap-log-dir.txt"), LOG_DIR);

// ── Auto-detect conda environment paths (no conda on PATH required) ──
// Searches known Miniconda/Anaconda install locations for named environments.
// Uses the script's own drive letter first, then checks common user locations.
function findCondaEnv(envName) {
  const drive = INSTALL_ROOT.slice(0, 2); // e.g. "F:"
  const home = homedir();              // e.g. "C:\\Users\\MediaMan"

  // Candidate conda roots, checked in order
  const condaRoots = [
    join(INSTALL_ROOT, "miniconda"),
    join(home, "miniconda3"),
    join(home, "anaconda3"),
    join(home, "Miniconda3"),
    join(home, "Anaconda3"),
    join(home, "AppData", "Local", "miniconda3"),
    join(home, "AppData", "Local", "anaconda3"),
    "C:\\ProgramData\\miniconda3",
    "C:\\ProgramData\\anaconda3",
    "C:\\Miniconda3",
    "C:\\Anaconda3",
  ];

  // 1) Check envs/<name>/python.exe under each conda root
  for (const root of condaRoots) {
    const candidate = join(root, "envs", envName, "python.exe");
    if (existsSync(candidate)) {
      return join(root, "envs", envName);
    }
  }

  // 2) Fallback: parse ~/.conda/environments.txt (lists all env paths)
  try {
    const envFile = join(home, ".conda", "environments.txt");
    if (existsSync(envFile)) {
      const lines = readFileSync(envFile, "utf-8").split("\n");
      for (const line of lines) {
        const p = line.trim();
        if (p && p.endsWith(envName) && existsSync(join(p, "python.exe"))) {
          return p;
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

const COMFYUI_ENV = findCondaEnv("comfyui");

// Non-fatal warning: backends are on-demand now
if (!COMFYUI_ENV) console.warn("  WARNING: conda env 'comfyui' not found. ComfyUI will not be startable.");

console.log(`  ComfyUI env   : ${COMFYUI_ENV || "NOT FOUND"}`);
console.log("");

// ── Write service definitions for the API ──
// The /api/services route reads this file to spawn backends with correct paths/args.
const serviceDefs = {
  installRoot: INSTALL_ROOT,
  logDir: LOG_DIR,
  envs: {
    comfyui: COMFYUI_ENV,
  },
};
writeFileSync(SERVICE_DEFS_PATH, JSON.stringify(serviceDefs, null, 2));
console.log(`  Service defs  : ${SERVICE_DEFS_PATH}`);
console.log("");

// ── Next.js process handle ──
let nextChild = null;

function spawnNextJs() {
  const logFile = join(LOG_DIR, "veksnap.log");
  const logStream = createWriteStream(logFile, { flags: "w" });
  const ts = () => new Date().toISOString().slice(11, 23);
  const command = isProd
    ? `npm run start -- -H ${UI_HOST} -p ${UI_PORT}`
    : `npm run dev -- -H ${UI_HOST} -p ${UI_PORT}`;

  logStream.write(`[${ts()}] Starting Vek-Snap (Next.js)...\n`);
  logStream.write(`[${ts()}] cwd: ${join(INSTALL_ROOT, "veksnap-app")}\n`);
  logStream.write(`[${ts()}] cmd: ${command}\n\n`);

  const child = spawn(command, {
    cwd: join(INSTALL_ROOT, "veksnap-app"),
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) logStream.write(`[${ts()}] ${line}\n`);
    }
  });

  child.stderr.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) logStream.write(`[${ts()}] [INFO] ${line}\n`);
    }
  });

  child.on("exit", (code) => {
    logStream.write(`[${ts()}] Next.js exited with code ${code}\n`);
    logStream.end();
    console.log(`  [x] Next.js exited with code ${code}`);
    // If Next.js exits, the launcher has nothing left to manage; exit too
    setTimeout(() => process.exit(code ?? 1), 1000);
  });

  child.on("error", (err) => {
    logStream.write(`[${ts()}] [ERR] Next.js error: ${err.message}\n`);
    console.error(`  [!] Next.js error: ${err.message}`);
  });

  nextChild = child;
  console.log(`  [+] Next.js started (PID ${child.pid}), log: ${logFile}`);
}

async function waitForPort(port, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

function cleanup() {
  try { unlinkSync(LOCK_FILE); } catch {}
  console.log("\nStopping Vek-Snap...");
  if (nextChild && nextChild.pid) {
    try {
      spawn("taskkill", ["/PID", String(nextChild.pid), "/T", "/F"], {
        shell: true,
        windowsHide: true,
        stdio: "ignore",
      });
      console.log("  [-] Next.js stopped");
    } catch { /* already dead */ }
  }
  // Note: backend services started via /api/services are detached processes.
  // They persist until explicitly stopped from the Service Manager UI or
  // by calling POST /api/services { action: "stop" }.
  console.log("  Note: Backend services (if started) are still running.");
  console.log("  Use the Service Manager in the UI to stop them, or they will");
  console.log("  be cleaned up next time the launcher kills stale port processes.");
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("exit", () => { try { unlinkSync(LOCK_FILE); } catch {} });

// ── Kill stale processes on service ports for a clean start ──
function killPortProcesses() {
  // ComfyUI (COMFYUI_PORT in src/lib/comfyui-config.ts) + our loopback UI port. NOT 8188:
  // never kill a customer's own ComfyUI that may be on that default.
  const ports = [41931, UI_PORT];
  console.log("Checking for stale processes on ports:", ports.join(", "));
  for (const port of ports) {
    try {
      const output = execSync(
        `netstat -ano | findstr ":${port} "`,
        { encoding: "utf-8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      );
      const pids = new Set();
      for (const line of output.split("\n")) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0" && /^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: "ignore" });
          console.log(`  Killed PID ${pid} on port ${port}`);
        } catch { /* already dead */ }
      }
    } catch {
      // netstat found nothing: port is free
    }
  }
  console.log("");
}

await checkExistingInstance();

killPortProcesses();

// Brief pause to let the OS fully release killed sockets
await new Promise((r) => setTimeout(r, 2000));

// Write our PID to the lock file so future launches can detect us
writeFileSync(LOCK_FILE, String(process.pid));

// ── Start Next.js only ──
console.log("Starting Vek-Snap UI...\n");
spawnNextJs();

// ── Pre-warm API routes to prevent dev-mode HMR loops ──
// In dev mode, each API route compiles on first access. Warming up key routes
// from Node.js (not the browser) prevents the HMR cascade that causes loops.
async function warmupRoutes() {
  const routes = [
    "/api/settings",
    "/api/services",
  ];

  console.log("  Warming up API routes (pre-compiling for dev mode)...");

  // First, hit the main page to trigger full page + CSS compilation
  try {
    await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${UI_PORT}/`, (res) => { res.resume(); resolve(); });
      req.on("error", resolve);
      req.setTimeout(30000, () => { req.destroy(); resolve(); });
    });
  } catch { /* ignore */ }

  // Small pause between page compilation and API route compilation
  await new Promise((r) => setTimeout(r, 2000));

  // Then hit each API route to compile them
  for (const route of routes) {
    try {
      await new Promise((resolve) => {
        const req = http.get(`http://${UI_HOST}:${UI_PORT}${route}`, (res) => {
          res.resume();
          resolve();
        });
        req.on("error", resolve);
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
      });
    } catch { /* ignore */ }
  }
  // Pause to let webpack finish any final HMR flushes before the browser connects
  await new Promise((r) => setTimeout(r, 3000));
  console.log("  API routes warmed up.");
}

// Wait for Next.js to respond, open browser, then warm up routes in the background.
console.log(`\nWaiting for Vek-Snap (port ${UI_PORT})...`);
waitForPort(UI_PORT, 300000).then(async (ready) => {
  if (ready) {
    console.log("\n  Vek-Snap is ready! Opening browser...");
    console.log("  Use the Service Manager panel to start backends (ComfyUI, etc.)");
    spawn(`start http://${UI_HOST}:${UI_PORT}`, { shell: true, windowsHide: true, stdio: "ignore" });
    // Warm up API routes (pre-compile for dev mode)
    try { await warmupRoutes(); } catch {}
    // Countdown then hide the console window
    await countdownAndHide(20);
  } else {
    console.warn("\n  Vek-Snap did not respond within 5 minutes.");
    console.warn(`  You can try opening http://${UI_HOST}:${UI_PORT} manually.`);
    console.warn("  Check logs at:", LOG_DIR);
  }
});
