/**
 * GPU Temperature Watchdog
 *
 * Polls GPU temperature during generation and auto-interrupts
 * if the temperature exceeds a configurable safety threshold.
 * Protects hardware during sustained AI workloads.
 */

const POLL_INTERVAL_MS = 5000; // Check every 5 seconds

export interface WatchdogConfig {
  /** Temperature in °C at which to auto-interrupt (default 83) */
  tempThresholdC: number;
  /** Power draw in watts at which to warn (0 = disabled) */
  powerThresholdW: number;
  /** Seconds GPU must stay above threshold before triggering (avoids false positives) */
  sustainedSeconds: number;
  /** Whether the watchdog is enabled */
  enabled: boolean;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  tempThresholdC: 90,
  powerThresholdW: 0,
  sustainedSeconds: 10,
  enabled: true,
};

export interface WatchdogReading {
  tempC: number;
  powerW: number;
  powerLimitW: number;
  timestamp: number;
}

export type WatchdogTriggerReason = "temperature" | "power";

export interface WatchdogCallbacks {
  onTriggered: (reason: WatchdogTriggerReason, reading: WatchdogReading) => void;
  onWarning: (reason: WatchdogTriggerReason, reading: WatchdogReading) => void;
  onReading: (reading: WatchdogReading) => void;
}

/**
 * Start the GPU watchdog. Returns a stop function.
 */
export function startWatchdog(
  config: WatchdogConfig,
  callbacks: WatchdogCallbacks
): () => void {
  if (!config.enabled) return () => {};

  let aborted = false;
  let firstOverTempAt: number | null = null;
  let firstOverPowerAt: number | null = null;
  let warned = { temp: false, power: false };

  const poll = async () => {
    if (aborted) return;

    try {
      const res = await fetch("/api/system-stats", {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok || aborted) return;
      const data = await res.json();

      if (!data.gpu) return;

      const reading: WatchdogReading = {
        tempC: data.gpu.tempC,
        powerW: data.gpu.powerW,
        powerLimitW: data.gpu.powerLimitW,
        timestamp: Date.now(),
      };

      callbacks.onReading(reading);

      const now = Date.now();

      // --- Temperature check ---
      if (reading.tempC >= config.tempThresholdC) {
        if (firstOverTempAt === null) {
          firstOverTempAt = now;
        }

        // Warn at first detection
        if (!warned.temp) {
          warned.temp = true;
          callbacks.onWarning("temperature", reading);
        }

        // Trigger after sustained period
        const overFor = (now - firstOverTempAt) / 1000;
        if (overFor >= config.sustainedSeconds) {
          callbacks.onTriggered("temperature", reading);
          aborted = true;
          return;
        }
      } else {
        firstOverTempAt = null;
        warned.temp = false;
      }

      // --- Power check ---
      if (config.powerThresholdW > 0 && reading.powerW >= config.powerThresholdW) {
        if (firstOverPowerAt === null) {
          firstOverPowerAt = now;
        }

        if (!warned.power) {
          warned.power = true;
          callbacks.onWarning("power", reading);
        }

        const overFor = (now - firstOverPowerAt) / 1000;
        if (overFor >= config.sustainedSeconds) {
          callbacks.onTriggered("power", reading);
          aborted = true;
          return;
        }
      } else {
        firstOverPowerAt = null;
        warned.power = false;
      }
    } catch {
      // Network error during poll: don't crash the watchdog
    }
  };

  // Initial poll
  poll();
  const intervalId = setInterval(poll, POLL_INTERVAL_MS);

  return () => {
    aborted = true;
    clearInterval(intervalId);
  };
}

/**
 * One-shot pre-render temperature check.
 * Returns null if OK, or a warning message string.
 */
export async function preRenderTempCheck(
  thresholdC: number
): Promise<{ ok: boolean; tempC: number; message: string }> {
  try {
    const res = await fetch("/api/system-stats", {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: true, tempC: 0, message: "" }; // can't check, allow

    const data = await res.json();
    if (!data.gpu) return { ok: true, tempC: 0, message: "" };

    const tempC = data.gpu.tempC;
    const warningTemp = thresholdC - 5; // warn 5° below threshold

    if (tempC >= thresholdC) {
      return {
        ok: false,
        tempC,
        message: `GPU is at ${tempC}°C (safety threshold: ${thresholdC}°C). Let it cool down before starting a render.`,
      };
    }

    if (tempC >= warningTemp) {
      return {
        ok: true,
        tempC,
        message: `GPU is at ${tempC}°C, close to the ${thresholdC}°C safety threshold. The watchdog will auto-interrupt if it gets too hot.`,
      };
    }

    return { ok: true, tempC, message: "" };
  } catch {
    return { ok: true, tempC: 0, message: "" }; // can't check, allow
  }
}
