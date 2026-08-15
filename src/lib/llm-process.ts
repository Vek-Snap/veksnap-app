/**
 * Shared LLM process tracker: allows aborting long-running LLM child processes.
 * Uses a global variable so it persists across API route invocations in dev mode.
 */

import { ChildProcess } from "child_process";

interface LlmProcess {
  proc: ChildProcess;
  label: string;
  startedAt: number;
}

const globalKey = "__veksnap_llm_process__" as const;

function getStore(): Map<string, LlmProcess> {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    g[globalKey] = new Map<string, LlmProcess>();
  }
  return g[globalKey] as Map<string, LlmProcess>;
}

export function registerLlmProcess(id: string, proc: ChildProcess, label: string) {
  const store = getStore();
  store.set(id, { proc, label, startedAt: Date.now() });
  proc.on("exit", () => store.delete(id));
  proc.on("error", () => store.delete(id));
}

export function abortAllLlmProcesses(): { killed: string[] } {
  const store = getStore();
  const killed: string[] = [];

  for (const [key, entry] of store.entries()) {
    if (!entry.proc.killed) {
      try {
        // On Windows, SIGTERM doesn't work reliably, use taskkill for the process tree
        if (process.platform === "win32" && entry.proc.pid) {
          const { execSync } = require("child_process");
          try {
            execSync(`taskkill /PID ${entry.proc.pid} /T /F`, { windowsHide: true, timeout: 5000 });
          } catch {
            entry.proc.kill("SIGKILL");
          }
        } else {
          entry.proc.kill("SIGTERM");
          setTimeout(() => {
            try { if (!entry.proc.killed) entry.proc.kill("SIGKILL"); } catch { /* gone */ }
          }, 2000);
        }
        killed.push(entry.label);
      } catch { /* already dead */ }
    }
    store.delete(key);
  }

  return { killed };
}

export function getActiveLlmProcesses(): { id: string; label: string; elapsed: number }[] {
  const store = getStore();
  const now = Date.now();
  return Array.from(store.entries()).map(([id, e]) => ({
    id,
    label: e.label,
    elapsed: Math.round((now - e.startedAt) / 1000),
  }));
}
