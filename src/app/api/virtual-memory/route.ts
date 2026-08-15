import { NextResponse } from "next/server";
import { execSync, spawnSync } from "child_process";
import { join } from "path";
import os from "os";

// ── GET: Read current page file configuration and usage ──

interface PageFileInfo {
  drive: string;
  path: string;
  allocatedMB: number;
  usedMB: number;
  peakMB: number;
  isSystemManaged: boolean;
  initialSizeMB: number;
  maxSizeMB: number;
}

interface VirtualMemoryStats {
  physicalRAM_MB: number;
  commitTotalMB: number;
  commitLimitMB: number;
  commitPeakMB: number;
  pageFiles: PageFileInfo[];
  drives: DriveInfo[];
}

interface DriveInfo {
  letter: string;
  freeSpaceMB: number;
  totalSpaceMB: number;
  hasPageFile: boolean;
}

// Cache to avoid hammering WMI on rapid polls
let cachedResponse: { body: string; at: number } | null = null;
const CACHE_TTL = 3000; // 3 seconds

export async function GET() {
  const now = Date.now();
  if (cachedResponse && now - cachedResponse.at < CACHE_TTL) {
    return new Response(cachedResponse.body, {
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Gather all data in a single PowerShell invocation for speed
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'

# Page file usage (currently active)
$usage = Get-CimInstance Win32_PageFileUsage | Select-Object Name, AllocatedBaseSize, CurrentUsage, PeakUsage

# Page file settings (configured, may be empty if system-managed)
$settings = Get-CimInstance Win32_PageFileSetting | Select-Object Name, InitialSize, MaximumSize

# OS commit charge
$osInfo = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVirtualMemorySize, FreeVirtualMemory, TotalVisibleMemorySize, FreePhysicalMemory, SizeStoredInPagingFiles

# Check if system-managed (auto)
$autoManaged = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management' -Name PagingFiles -ErrorAction SilentlyContinue).PagingFiles

# Fixed drives with free space
$drives = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, FreeSpace, Size

$result = @{
  usage = @($usage | ForEach-Object { @{ Name=$_.Name; AllocatedBaseSize=$_.AllocatedBaseSize; CurrentUsage=$_.CurrentUsage; PeakUsage=$_.PeakUsage } })
  settings = @($settings | ForEach-Object { @{ Name=$_.Name; InitialSize=$_.InitialSize; MaximumSize=$_.MaximumSize } })
  osInfo = @{ TotalVirtualMemorySize=$osInfo.TotalVirtualMemorySize; FreeVirtualMemory=$osInfo.FreeVirtualMemory; TotalVisibleMemorySize=$osInfo.TotalVisibleMemorySize; FreePhysicalMemory=$osInfo.FreePhysicalMemory; SizeStoredInPagingFiles=$osInfo.SizeStoredInPagingFiles }
  autoManaged = $autoManaged
  drives = @($drives | ForEach-Object { @{ DeviceID=$_.DeviceID; FreeSpace=$_.FreeSpace; Size=$_.Size } })
}

ConvertTo-Json $result -Depth 3 -Compress
`;

    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      { encoding: "utf-8", timeout: 15000, windowsHide: true }
    );
    if (ps.status !== 0 || !ps.stdout?.trim()) {
      throw new Error(ps.stderr?.trim() || "PowerShell returned no output");
    }
    const raw = ps.stdout.trim();

    const data = JSON.parse(raw);

    // Parse page file entries
    const usageArr = Array.isArray(data.usage) ? data.usage : [data.usage].filter(Boolean);
    const settingsArr = Array.isArray(data.settings) ? data.settings : [data.settings].filter(Boolean);
    const drivesArr = Array.isArray(data.drives) ? data.drives : [data.drives].filter(Boolean);

    // Build settings lookup by path
    const settingsMap: Record<string, { InitialSize: number; MaximumSize: number }> = {};
    for (const s of settingsArr) {
      if (s?.Name) settingsMap[s.Name.toLowerCase()] = s;
    }

    // Determine if system-managed
    const autoManaged = data.autoManaged;
    const isSystemManaged =
      !autoManaged ||
      (Array.isArray(autoManaged)
        ? autoManaged.some((s: string) => s.includes("?:\\pagefile.sys") || s.trim() === "")
        : String(autoManaged).includes("?:\\pagefile.sys") || String(autoManaged).trim() === "");

    const pageFiles: PageFileInfo[] = usageArr
      .filter((u: any) => u?.Name)
      .map((u: any) => {
        const name = u.Name as string;
        const drive = name.charAt(0).toUpperCase();
        const setting = settingsMap[name.toLowerCase()];
        return {
          drive,
          path: name,
          allocatedMB: u.AllocatedBaseSize ?? 0,
          usedMB: u.CurrentUsage ?? 0,
          peakMB: u.PeakUsage ?? 0,
          isSystemManaged: !setting || (setting.InitialSize === 0 && setting.MaximumSize === 0),
          initialSizeMB: setting?.InitialSize ?? 0,
          maxSizeMB: setting?.MaximumSize ?? 0,
        };
      });

    const osInfo = data.osInfo || {};
    // Win32_OperatingSystem sizes are in KB
    const commitTotalKB = (osInfo.TotalVirtualMemorySize ?? 0) - (osInfo.FreeVirtualMemory ?? 0);
    const commitLimitKB = osInfo.TotalVirtualMemorySize ?? 0;

    // Build drive info
    const pageFileDrives = new Set(pageFiles.map((pf) => pf.drive));
    const drives: DriveInfo[] = drivesArr
      .filter((d: any) => d?.DeviceID)
      .map((d: any) => ({
        letter: (d.DeviceID as string).charAt(0).toUpperCase(),
        freeSpaceMB: Math.round((d.FreeSpace ?? 0) / 1048576),
        totalSpaceMB: Math.round((d.Size ?? 0) / 1048576),
        hasPageFile: pageFileDrives.has((d.DeviceID as string).charAt(0).toUpperCase()),
      }));

    const physRAM = Math.round(os.totalmem() / 1048576);

    const stats: VirtualMemoryStats = {
      physicalRAM_MB: physRAM,
      commitTotalMB: Math.round(commitTotalKB / 1024),
      commitLimitMB: Math.round(commitLimitKB / 1024),
      commitPeakMB: 0, // not directly available from WMI
      pageFiles,
      drives,
    };

    const body = JSON.stringify(stats);
    cachedResponse = { body, at: Date.now() };
    return new Response(body, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read virtual memory stats" },
      { status: 500 }
    );
  }
}

// ── POST: Create or extend a page file at runtime ──

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { action, driveLetter, minSizeMB, maxSizeMB } = body as {
      action: string;
      driveLetter?: string;
      minSizeMB?: number;
      maxSizeMB?: number;
    };

    if (action === "create" || action === "extend") {
      if (!driveLetter || !minSizeMB || !maxSizeMB) {
        return NextResponse.json(
          { error: "Missing required fields: driveLetter, minSizeMB, maxSizeMB" },
          { status: 400 }
        );
      }

      // ── Guardrails ──
      const physRAM_MB = Math.round(os.totalmem() / 1048576);
      const hardFloorMB = Math.max(physRAM_MB, 8192); // max(physical RAM, 8GB)
      const hardCeilingMB = physRAM_MB * 3; // 3x physical RAM

      if (minSizeMB < 1024) {
        return NextResponse.json(
          { error: "Minimum page file size must be at least 1 GB (1024 MB)" },
          { status: 400 }
        );
      }

      if (maxSizeMB > hardCeilingMB) {
        return NextResponse.json(
          { error: `Maximum size (${maxSizeMB} MB) exceeds the safety ceiling of ${hardCeilingMB} MB (3× physical RAM)` },
          { status: 400 }
        );
      }

      if (maxSizeMB < minSizeMB) {
        return NextResponse.json(
          { error: "Maximum size must be >= minimum size" },
          { status: 400 }
        );
      }

      // Call the PowerShell script
      const scriptPath = join(process.cwd(), "scripts", "pagefile-create.ps1");
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -DriveLetter "${driveLetter}" -MinSizeMB ${minSizeMB} -MaxSizeMB ${maxSizeMB}`;

      try {
        const output = execSync(cmd, {
          encoding: "utf-8",
          timeout: 30000,
          windowsHide: true,
        }).trim();

        const result = JSON.parse(output);

        // Invalidate cache so next GET reflects changes
        cachedResponse = null;

        if (result.success) {
          return NextResponse.json(result);
        } else {
          return NextResponse.json(result, { status: 500 });
        }
      } catch (execErr: any) {
        // Try to parse JSON from stderr/stdout
        const output = execErr?.stdout || execErr?.stderr || "";
        try {
          const result = JSON.parse(output.trim());
          return NextResponse.json(result, { status: 500 });
        } catch {
          return NextResponse.json(
            { error: `Page file operation failed: ${execErr.message || output}` },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Request failed" },
      { status: 500 }
    );
  }
}
