"use client";

// Modern-UI hardware dock: the collapsible right-side panel for studio-v2.
// Hosts the SAME feedback + control systems as the classic UI (ResourceMonitor,
// ThrottleControls, SystemLogs), grouped into collapsible sections and themed to
// the v2 look. The parent (studio-v2 page) owns whether the dock is open; this
// component only renders its contents, so when the dock is closed it is unmounted
// and nothing inside polls (zero background cost).

import { useState } from "react";
import { ChevronDown, ChevronRight, Activity, Gauge, ScrollText, SlidersHorizontal } from "lucide-react";
import ResourceMonitor from "@/components/ResourceMonitor";
import VirtualMemoryPanel from "@/components/VirtualMemoryPanel";
import ThrottleControls from "@/components/ThrottleControls";
import SystemLogs from "@/components/SystemLogs";
import { usePanelSettings } from "@/lib/panel-settings";

function Section({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold tracking-tight text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
        {icon}
        <span>{title}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export default function HardwareDock() {
  // Which panels the user has enabled (managed from Settings → System Panels…).
  const panels = usePanelSettings();

  // A section only renders when at least one of its child panels is enabled, so
  // hiding everything inside collapses the whole section (and stops its polling).
  const showResourceMonitor = panels.monitors || panels.memoryReserve || panels.flushActions;
  const showHardware = showResourceMonitor || panels.virtualMemory;
  const showControls = panels.gpuPowerLimit || panels.safetyWatchdog;

  const anyVisible = showHardware || showControls || panels.systemLogs;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {showHardware && (
        <Section title="Hardware Monitors" icon={<Activity className="w-3.5 h-3.5 text-violet-400" />} defaultOpen>
          {showResourceMonitor && (
            <ResourceMonitor
              show={{ monitors: panels.monitors, memoryReserve: panels.memoryReserve, flushActions: panels.flushActions }}
            />
          )}
          {panels.virtualMemory && (
            <div className={showResourceMonitor ? "mt-3" : undefined}>
              <VirtualMemoryPanel />
            </div>
          )}
        </Section>
      )}
      {showControls && (
        <Section title="GPU Controls" icon={<Gauge className="w-3.5 h-3.5 text-amber-400" />} defaultOpen={false}>
          {/* ThrottleControls renders nothing when nvidia-smi is unavailable. */}
          <ThrottleControls show={{ powerLimit: panels.gpuPowerLimit, watchdog: panels.safetyWatchdog }} />
        </Section>
      )}
      {panels.systemLogs && (
        <Section title="System Logs" icon={<ScrollText className="w-3.5 h-3.5 text-sky-400" />} defaultOpen={false}>
          <SystemLogs />
        </Section>
      )}
      {!anyVisible && (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-muted-foreground">
          <SlidersHorizontal className="w-5 h-5 opacity-60" />
          <p className="text-[11px] leading-relaxed">
            All system panels are hidden. Enable them from
            <br />
            <span className="text-foreground">Settings → System Panels…</span>
          </p>
        </div>
      )}
    </div>
  );
}
