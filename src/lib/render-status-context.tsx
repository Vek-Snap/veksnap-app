"use client";

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

export interface RenderStatus {
  active: boolean;
  completed?: boolean; // true = render finished successfully (shows green banner)
  stage: string;
  progress: number;
  progressMax: number;
  stepTimestamps: number[];
  mode: string; // e.g. "LTX-2", "Director", "Voice Conv", etc.
  wallClockStart?: number; // Date.now() at render start for accurate elapsed time
}

interface RenderStatusContextValue {
  status: RenderStatus | null;
  setRenderStatus: (status: RenderStatus | null) => void;
  updateRenderProgress: (progress: number, progressMax: number, stage: string, timestamp?: number) => void;
  updateStage: (stage: string) => void;
  startRender: (mode: string, stage?: string) => void;
  endRender: () => void;
  completeRender: (totalTime?: string) => void;
}

const RenderStatusContext = createContext<RenderStatusContextValue>({
  status: null,
  setRenderStatus: () => {},
  updateRenderProgress: () => {},
  updateStage: () => {},
  startRender: () => {},
  endRender: () => {},
  completeRender: () => {},
});

export function RenderStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RenderStatus | null>(null);
  const timestampsRef = useRef<number[]>([]);

  const setRenderStatus = useCallback((s: RenderStatus | null) => {
    if (s) {
      timestampsRef.current = s.stepTimestamps;
    } else {
      timestampsRef.current = [];
    }
    setStatus(s);
  }, []);

  const completeDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startRender = useCallback((mode: string, stage = "Starting...") => {
    if (completeDismissRef.current) { clearTimeout(completeDismissRef.current); completeDismissRef.current = null; }
    timestampsRef.current = [];
    setStatus({ active: true, stage, progress: 0, progressMax: 0, stepTimestamps: [], mode, wallClockStart: Date.now() });
  }, []);

  const endRender = useCallback(() => {
    if (completeDismissRef.current) { clearTimeout(completeDismissRef.current); completeDismissRef.current = null; }
    timestampsRef.current = [];
    setStatus(null);
  }, []);

  // Show green "Complete" banner for 5 seconds, then auto-dismiss
  const completeRender = useCallback((totalTime?: string) => {
    if (completeDismissRef.current) clearTimeout(completeDismissRef.current);
    setStatus((prev) => prev ? {
      ...prev,
      active: true,
      completed: true,
      stage: totalTime ? `Complete! (${totalTime})` : "Complete!",
    } : null);
    completeDismissRef.current = setTimeout(() => {
      timestampsRef.current = [];
      setStatus(null);
      completeDismissRef.current = null;
    }, 5000);
  }, []);

  const updateRenderProgress = useCallback((progress: number, progressMax: number, stage: string, timestamp?: number) => {
    if (timestamp) {
      const next = [...timestampsRef.current, timestamp];
      timestampsRef.current = next.length > 50 ? next.slice(-50) : next;
    }
    setStatus((prev) => prev ? {
      ...prev,
      progress,
      progressMax,
      stage,
      stepTimestamps: timestampsRef.current,
    } : null);
  }, []);

  const updateStage = useCallback((stage: string) => {
    setStatus((prev) => prev ? { ...prev, stage } : null);
  }, []);

  return (
    <RenderStatusContext.Provider value={{ status, setRenderStatus, updateRenderProgress, updateStage, startRender, endRender, completeRender }}>
      {children}
    </RenderStatusContext.Provider>
  );
}

export function useRenderStatus() {
  return useContext(RenderStatusContext);
}
