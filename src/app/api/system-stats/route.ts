import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";

const execAsync = (cmd: string, opts?: object) =>
  promisify(exec)(cmd, { windowsHide: true, ...opts });

// Cache the PyTorch CUDA check so we don't query ComfyUI on every 2s poll
let cachedCudaCheck: { torchCuda: string | null; checkedAt: number } | null = null;
const CUDA_CHECK_INTERVAL = 60_000; // re-check once per minute

// Cache the full stats response to deduplicate overlapping polls
// (ResourceMonitor 2s + GPU watchdog 5s = up to 35 nvidia-smi spawns/min without cache).
// Keyed by the requested monitor set so disabling GPU/Disk genuinely skips that spawn.
const cachedStatsResponses = new Map<string, { body: string; cachedAt: number }>();
const STATS_CACHE_TTL = 1500; // 1.5s, fresh enough for both poll intervals

// ── Disk usage (fixed drives) ──
// Heavier than CPU/RAM (spawns PowerShell), so cached longer and only computed when
// the caller asks for it (?disks=1), i.e. when the Disk monitor is enabled.
interface DiskStat { drive: string; totalMB: number; usedMB: number; freeMB: number; usagePct: number }
let cachedDisks: { disks: DiskStat[]; cachedAt: number } | null = null;
const DISK_CACHE_TTL = 5000; // disk capacity changes slowly, 5s is plenty

async function getDisks(): Promise<DiskStat[]> {
  const now = Date.now();
  if (cachedDisks && now - cachedDisks.cachedAt < DISK_CACHE_TTL) return cachedDisks.disks;
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"',
      { timeout: 6000 },
    );
    const raw = JSON.parse(stdout.trim() || "[]");
    const arr = Array.isArray(raw) ? raw : [raw];
    const disks: DiskStat[] = arr
      .filter((d) => d && d.Size)
      .map((d) => {
        const total = Number(d.Size) || 0;
        const free = Number(d.FreeSpace) || 0;
        const used = Math.max(0, total - free);
        return {
          drive: String(d.DeviceID || "").replace(/\\+$/, ""),
          totalMB: Math.round(total / 1048576),
          usedMB: Math.round(used / 1048576),
          freeMB: Math.round(free / 1048576),
          usagePct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
        };
      });
    cachedDisks = { disks, cachedAt: now };
    return disks;
  } catch {
    return cachedDisks?.disks ?? [];
  }
}

// Previous CPU times snapshot for delta-based usage calculation
// os.cpus().times are cumulative since boot, must diff two snapshots for real-time usage
interface CpuTimesSnapshot {
  idle: number;
  total: number;
}
let prevCpuTimes: CpuTimesSnapshot[] | null = null;

async function getTorchCudaVersion(): Promise<string | null> {
  const now = Date.now();
  if (cachedCudaCheck && now - cachedCudaCheck.checkedAt < CUDA_CHECK_INTERVAL) {
    return cachedCudaCheck.torchCuda;
  }
  try {
    const res = await fetch(`${COMFYUI_HTTP}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      // ComfyUI returns { system: { ..., pytorch_version: "2.10.0+cu128", ... } }
      const ver: string = data?.system?.pytorch_version ?? "";
      // Extract cuda build tag: "2.10.0+cu128" → "cu128"
      const match = ver.match(/\+cu(\d+)/);
      const tag = match ? match[1] : null;
      cachedCudaCheck = { torchCuda: tag, checkedAt: now };
      return tag;
    }
  } catch { /* ComfyUI not ready yet */ }
  return null;
}

interface GpuStats {
  name: string;
  tempC: number;
  utilizationPct: number;
  memUsedMB: number;
  memTotalMB: number;
  memPct: number;
  powerW: number;
  powerLimitW: number;
  fanPct: number;
  computeCap: string;
  cudaWarning: string | null;
}

interface SystemStats {
  cpu: {
    model: string;
    cores: number;
    usagePct: number;
  };
  ram: {
    totalMB: number;
    usedMB: number;
    usagePct: number;
  };
  gpu: GpuStats | null;
  disks?: DiskStat[];
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const includeGpu = sp.get("gpu") !== "0";    // default ON (back-compat with classic UI)
  const includeDisks = sp.get("disks") === "1"; // default OFF unless explicitly requested
  const cacheKey = `${includeGpu}|${includeDisks}`;

  // Return cached response if still fresh (deduplicates overlapping polls)
  const now = Date.now();
  const cached = cachedStatsResponses.get(cacheKey);
  if (cached && now - cached.cachedAt < STATS_CACHE_TTL) {
    return new Response(cached.body, { headers: { "Content-Type": "application/json" } });
  }

  try {
    // CPU info
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model ?? "Unknown";
    const cpuCores = cpus.length;

    // CPU usage: delta between current and previous snapshot
    // os.cpus().times are cumulative since boot; single-snapshot ratio ≈ constant
    const currentTimes: CpuTimesSnapshot[] = cpus.map((cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return { idle: cpu.times.idle, total };
    });
    let cpuUsage = 0;
    if (prevCpuTimes && prevCpuTimes.length === currentTimes.length) {
      cpuUsage = currentTimes.reduce((sum, cur, i) => {
        const prev = prevCpuTimes![i];
        const dTotal = cur.total - prev.total;
        const dIdle = cur.idle - prev.idle;
        return sum + (dTotal > 0 ? ((dTotal - dIdle) / dTotal) * 100 : 0);
      }, 0) / cpuCores;
    }
    prevCpuTimes = currentTimes;

    // RAM info
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const stats: SystemStats = {
      cpu: {
        model: cpuModel.trim(),
        cores: cpuCores,
        usagePct: Math.round(cpuUsage * 10) / 10,
      },
      ram: {
        totalMB: Math.round(totalMem / 1048576),
        usedMB: Math.round(usedMem / 1048576),
        usagePct: Math.round((usedMem / totalMem) * 1000) / 10,
      },
      gpu: null,
    };

    // GPU info via nvidia-smi (skipped when the caller disables the GPU monitor)
    if (includeGpu) try {
      const { stdout } = await execAsync(
        'nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed,compute_cap --format=csv,noheader,nounits',
        { timeout: 5000 }
      );
      const parts = stdout.trim().split(",").map((s) => s.trim());
      if (parts.length >= 9) {
        const memUsed = parseFloat(parts[3]);
        const memTotal = parseFloat(parts[4]);
        const computeCap = parts[8] || "";
        const majorCap = parseInt(computeCap.split(".")[0] || "0");
        // Blackwell (sm_120, compute 12.0+) needs a PyTorch built with CUDA 12.8+.
        // cu128 wheels (torch 2.7+) carry BOTH the sm_120 kernels AND the
        // float4_e2m1fn_x2 FP4 dtype + block-scaled _scaled_mm used by NVFP4 models.
        // Verified on RTX 5070 Ti (torch 2.11.0+cu128): sm_120 kernels run and a
        // block-scaled NVFP4 GEMM executes. cu130 is NOT required, that was only
        // true for older cu128 wheels that predated FP4 support. Only warn for a
        // genuinely older toolkit (< cu128), which would lack Blackwell/FP4 support.
        let cudaWarning: string | null = null;
        if (majorCap >= 12) {
          const torchCuda = await getTorchCudaVersion();
          // torchCuda is e.g. "128" for cu128, "126" for cu126, null if ComfyUI not ready
          if (torchCuda !== null && parseInt(torchCuda) < 128) {
            cudaWarning = `${parts[0]} (compute ${computeCap}) needs PyTorch with CUDA 12.8+ (cu128) for Blackwell/FP4 support but has cu${torchCuda}. Run: pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128`;
          }
        }
        stats.gpu = {
          name: parts[0],
          tempC: parseFloat(parts[1]),
          utilizationPct: parseFloat(parts[2]),
          memUsedMB: memUsed,
          memTotalMB: memTotal,
          memPct: Math.round((memUsed / memTotal) * 1000) / 10,
          powerW: parseFloat(parts[5]),
          powerLimitW: parseFloat(parts[6]),
          fanPct: parseFloat(parts[7]),
          computeCap,
          cudaWarning,
        };
      }
    } catch {
      // nvidia-smi not available or failed
    }

    if (includeDisks) {
      stats.disks = await getDisks();
    }

    const body = JSON.stringify(stats);
    cachedStatsResponses.set(cacheKey, { body, cachedAt: Date.now() });
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get stats" },
      { status: 500 }
    );
  }
}
