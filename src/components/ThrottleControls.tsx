"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Gauge, RotateCcw, ShieldAlert, Thermometer } from "lucide-react";
import { WatchdogConfig, DEFAULT_WATCHDOG_CONFIG } from "@/lib/gpu-watchdog";

interface ThrottleInfo {
  currentLimitW: number;
  defaultLimitW: number;
  minLimitW: number;
  maxLimitW: number;
}

interface Props {
  watchdogConfig?: WatchdogConfig;
  onWatchdogConfigChange?: (config: WatchdogConfig) => void;
  /** Restore ALL system/performance/safety preferences to their defaults. */
  onResetDefaults?: () => void;
  /** Optional per-card visibility. Omitted (classic UI) => both cards shown. */
  show?: { powerLimit?: boolean; watchdog?: boolean };
}

export default function ThrottleControls({ watchdogConfig, onWatchdogConfigChange, onResetDefaults, show }: Props = {}) {
  const showPowerLimit = show?.powerLimit !== false;
  const showWatchdog = show?.watchdog !== false;
  const [info, setInfo] = useState<ThrottleInfo | null>(null);
  const [powerLimit, setPowerLimit] = useState(0);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const fetchInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/gpu-throttle", { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error();
      const data: ThrottleInfo = await res.json();
      setInfo(data);
      setPowerLimit(data.maxLimitW);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  const applyThrottle = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const res = await fetch("/api/gpu-throttle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ powerLimitW: powerLimit }),
      });
      const data = await res.json();
      if (data.results) {
        setMessage(data.results.join("; "));
      }
      // Refresh current state
      await fetchInfo();
    } catch {
      setMessage("Failed to apply throttle");
    } finally {
      setApplying(false);
    }
  };

  const resetDefaults = async () => {
    if (!info) return;
    setApplying(true);
    setMessage(null);
    try {
      await fetch("/api/gpu-throttle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          powerLimitW: info.defaultLimitW,
          gpuClockMHz: 0,
        }),
      });
      setMessage("Reset to defaults");
      await fetchInfo();
    } catch {
      setMessage("Failed to reset");
    } finally {
      setApplying(false);
    }
  };

  const wdConfig = watchdogConfig ?? DEFAULT_WATCHDOG_CONFIG;
  const updateWd = (partial: Partial<WatchdogConfig>) => {
    onWatchdogConfigChange?.({ ...wdConfig, ...partial });
  };

  if (error || !info) {
    return null; // Hide if nvidia-smi unavailable
  }

  const pctOfMax = Math.round((powerLimit / info.maxLimitW) * 100);
  const isThrottled = powerLimit < info.defaultLimitW;

  return (
    <>
    {showPowerLimit && (
    <Card className="overflow-hidden">
      <CardHeader className="pb-1 pt-3 px-3">
        <CardTitle className="text-[11px] font-medium flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-orange-400" />
            GPU Power Limit
          </span>
          {isThrottled && (
            <Badge variant="secondary" className="text-[9px] bg-orange-500/20 text-orange-400 border-orange-500/30">
              Throttled
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-[10px]">Power Limit</Label>
            <span className="text-[10px] font-mono text-muted-foreground">
              {powerLimit.toFixed(0)}W ({pctOfMax}%)
            </span>
          </div>
          <Slider
            value={[powerLimit]}
            onValueChange={([v]) => setPowerLimit(v)}
            min={info.minLimitW}
            max={info.maxLimitW}
            step={5}
          />
          <div className="flex justify-between text-[9px] text-muted-foreground">
            <span>{info.minLimitW}W min</span>
            <span>{info.defaultLimitW}W default</span>
            <span>{info.maxLimitW}W max</span>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1 text-[10px] h-7 gap-1"
            onClick={applyThrottle}
            disabled={applying}
          >
            <ShieldAlert className="w-3 h-3" />
            {applying ? "Applying..." : "Apply"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-[10px] h-7 gap-1"
            onClick={resetDefaults}
            disabled={applying}
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </Button>
        </div>

        {message && (
          <p className="text-[10px] text-muted-foreground bg-muted/50 rounded p-1.5">
            {message}
          </p>
        )}

        <p className="text-[9px] text-muted-foreground/60">
          Note: Power limit changes require running as Administrator.
          Lower limits reduce heat and allow multitasking during renders.
        </p>
      </CardContent>
    </Card>
    )}

    {/* GPU Safety Watchdog */}
    {showWatchdog && (
    <Card className="overflow-hidden border-orange-500/20">
      <CardHeader className="pb-1 pt-3 px-3">
        <CardTitle className="text-[11px] font-medium flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Thermometer className="w-3.5 h-3.5 text-red-400" />
            Safety Watchdog
          </span>
          <span className="flex items-center gap-1.5">
            {onResetDefaults && (
              <Button
                size="sm"
                variant="ghost"
                className="text-[9px] h-6 gap-1 px-1.5 text-muted-foreground hover:text-foreground"
                onClick={onResetDefaults}
                title="Restore system performance & safety preferences to defaults (does not affect render settings)"
              >
                <RotateCcw className="w-3 h-3" />
                Defaults
              </Button>
            )}
            <Switch
              checked={wdConfig.enabled}
              onCheckedChange={(enabled) => updateWd({ enabled })}
              className="scale-75"
            />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 space-y-3">
        <p className="text-[9px] text-muted-foreground/70">
          Auto-interrupts renders if GPU temperature stays above the threshold, protecting against thermal crashes and PSU overload.
        </p>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-[10px]">Temp Threshold</Label>
            <span className="text-[10px] font-mono text-red-400">
              {wdConfig.tempThresholdC}°C
            </span>
          </div>
          <Slider
            value={[wdConfig.tempThresholdC]}
            onValueChange={([v]) => updateWd({ tempThresholdC: v })}
            min={65}
            max={95}
            step={1}
            disabled={!wdConfig.enabled}
          />
          <div className="flex justify-between text-[9px] text-muted-foreground">
            <span>65°C safe</span>
            <span>83°C default</span>
            <span>95°C max</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-[10px]">Grace Period</Label>
            <span className="text-[10px] font-mono text-muted-foreground">
              {wdConfig.sustainedSeconds}s
            </span>
          </div>
          <Slider
            value={[wdConfig.sustainedSeconds]}
            onValueChange={([v]) => updateWd({ sustainedSeconds: v })}
            min={5}
            max={60}
            step={5}
            disabled={!wdConfig.enabled}
          />
          <p className="text-[9px] text-muted-foreground/60">
            GPU must stay above threshold for this many seconds before auto-interrupting. Avoids false triggers from brief spikes.
          </p>
        </div>
      </CardContent>
    </Card>
    )}
    </>
  );
}
