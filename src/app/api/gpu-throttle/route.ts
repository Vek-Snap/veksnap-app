import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = (cmd: string, opts?: object) =>
  promisify(exec)(cmd, { windowsHide: true, ...opts });

export async function GET() {
  try {
    // Get current power limit and default limit
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=power.limit,power.default_limit,power.min_limit,power.max_limit --format=csv,noheader,nounits",
      { timeout: 5000 }
    );
    const parts = stdout.trim().split(",").map((s) => parseFloat(s.trim()));
    return NextResponse.json({
      currentLimitW: parts[0],
      defaultLimitW: parts[1],
      minLimitW: parts[2],
      maxLimitW: parts[3],
    });
  } catch {
    return NextResponse.json({ error: "nvidia-smi not available" }, { status: 500 });
  }
}

/** Read the card's real power envelope so we can clamp requests to it. */
async function readPowerLimits(): Promise<{ min: number; max: number } | null> {
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=power.min_limit,power.max_limit --format=csv,noheader,nounits",
      { timeout: 5000 }
    );
    const [min, max] = stdout.trim().split(",").map((s) => parseFloat(s.trim()));
    if (Number.isFinite(min) && Number.isFinite(max) && max > 0) return { min, max };
  } catch { /* nvidia-smi unavailable */ }
  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { powerLimitW, gpuClockMHz } = body as {
    powerLimitW?: number;
    gpuClockMHz?: number;
  };

  const results: string[] = [];

  try {
    // Set GPU power limit (requires admin on Windows).
    // SAFETY: never trust the caller's raw value - clamp it to the card's own
    // reported [min, max] envelope so a bad/out-of-range request can never be
    // handed to nvidia-smi. If we can't read the envelope, reject rather than
    // guess, so we never apply an unvalidated limit to someone's GPU.
    if (powerLimitW !== undefined) {
      if (!Number.isFinite(powerLimitW)) {
        results.push("Power limit skipped: value was not a finite number");
      } else {
        const envelope = await readPowerLimits();
        if (!envelope) {
          results.push("Power limit skipped: could not read the GPU's supported range");
        } else {
          const safe = Math.round(Math.min(envelope.max, Math.max(envelope.min, powerLimitW)));
          try {
            await execAsync(`nvidia-smi -pl ${safe}`, { timeout: 5000 });
            results.push(
              safe === Math.round(powerLimitW)
                ? `Power limit set to ${safe}W`
                : `Power limit clamped to ${safe}W (requested ${Math.round(powerLimitW)}W is outside the ${envelope.min}-${envelope.max}W range)`
            );
          } catch (err) {
            results.push(`Power limit failed (may need admin): ${err instanceof Error ? err.message : "unknown"}`);
          }
        }
      }
    }

    // Set GPU clock limit. SAFETY: only accept 0 (reset) or a sane positive
    // integer; anything else is ignored rather than passed to nvidia-smi.
    if (gpuClockMHz !== undefined) {
      if (!Number.isFinite(gpuClockMHz) || gpuClockMHz < 0 || gpuClockMHz > 5000) {
        results.push(`GPU clock skipped: ${gpuClockMHz} MHz is out of the accepted 0-5000 range`);
      } else try {
        if (gpuClockMHz === 0) {
          // Reset to default
          await execAsync("nvidia-smi -rgc", { timeout: 5000 });
          results.push("GPU clock reset to default");
        } else {
          await execAsync(
            `nvidia-smi -lgc 0,${gpuClockMHz}`,
            { timeout: 5000 }
          );
          results.push(`GPU clock limited to ${gpuClockMHz} MHz`);
        }
      } catch (err) {
        results.push(`GPU clock failed (may need admin): ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Throttle failed" },
      { status: 500 }
    );
  }
}
