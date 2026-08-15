"use client";

// Global "Open in ComfyUI" coordination.
//
// Each ComfyUI-driven studio registers a `getWorkflow()` callback via
// `useRegisterComfyWorkflow(...)`. A single global button (in the MenuBar)
// reads this context: it's enabled only while a workflow is registered, and
// clicking it stages that workflow and opens ComfyUI with it loaded directly.

import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
} from "react";
import {
  openWorkflowInComfyUI,
  type ComfyWorkflowPayload,
} from "@/lib/open-in-comfyui";

export type WorkflowGetter = () => ComfyWorkflowPayload | null;

type OpenStatus = "idle" | "opening" | "error";

interface ComfyOpenContextValue {
  /** Register the active page's workflow builder. Returns an unregister fn. */
  register: (getter: WorkflowGetter) => () => void;
  /** True when a ComfyUI-compatible page has registered a workflow. */
  hasWorkflow: boolean;
  /** Stage the registered workflow and open ComfyUI with it loaded. */
  openInComfyUI: () => Promise<void>;
  status: OpenStatus;
  error: string | null;
  clearError: () => void;
}

const ComfyOpenContext = createContext<ComfyOpenContextValue | null>(null);

export function ComfyOpenProvider({ children }: { children: React.ReactNode }) {
  // Only the most-recently-registered getter (the visible page) is active.
  const stackRef = useRef<WorkflowGetter[]>([]);
  const [hasWorkflow, setHasWorkflow] = useState(false);
  const [status, setStatus] = useState<OpenStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const register = useCallback((getter: WorkflowGetter) => {
    stackRef.current.push(getter);
    setHasWorkflow(true);
    return () => {
      stackRef.current = stackRef.current.filter((g) => g !== getter);
      setHasWorkflow(stackRef.current.length > 0);
    };
  }, []);

  const openInComfyUI = useCallback(async () => {
    const getter = stackRef.current[stackRef.current.length - 1];
    if (!getter) return;

    let payload: ComfyWorkflowPayload | null;
    try {
      payload = getter();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!payload || !payload.workflow) {
      setStatus("error");
      setError("This page has no workflow to open yet: add a prompt / settings first.");
      return;
    }

    setStatus("opening");
    setError(null);
    try {
      await openWorkflowInComfyUI(payload.workflow, payload.name);
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setStatus("idle");
  }, []);

  return (
    <ComfyOpenContext.Provider
      value={{ register, hasWorkflow, openInComfyUI, status, error, clearError }}
    >
      {children}
    </ComfyOpenContext.Provider>
  );
}

/** Read the global Open-in-ComfyUI controller (null outside the provider). */
export function useComfyOpen(): ComfyOpenContextValue | null {
  return useContext(ComfyOpenContext);
}

/**
 * Register the current page's workflow builder with the global button.
 * `getter` may change every render (it usually closes over `config`); we keep
 * the latest in a ref so registration stays stable across renders.
 *
 * Pass `enabled = false` to skip registration (e.g. while a config is invalid).
 */
export function useRegisterComfyWorkflow(getter: WorkflowGetter, enabled = true): void {
  const ctx = useContext(ComfyOpenContext);
  const getterRef = useRef(getter);
  getterRef.current = getter;

  useEffect(() => {
    if (!ctx || !enabled) return;
    const stable: WorkflowGetter = () => getterRef.current();
    const unregister = ctx.register(stable);
    return unregister;
  }, [ctx, enabled]);
}
