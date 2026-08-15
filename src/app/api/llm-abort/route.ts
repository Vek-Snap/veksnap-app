/**
 * LLM Abort API: kills any running LLM child processes (vision-describe, prompt-expand).
 * POST /api/llm-abort
 * Returns: { killed: string[] }
 */

import { NextResponse } from "next/server";
import { abortAllLlmProcesses, getActiveLlmProcesses } from "@/lib/llm-process";

export async function POST() {
  const active = getActiveLlmProcesses();
  console.log(`[llm-abort] Killing ${active.length} active LLM process(es):`, active.map(a => `${a.label} (${a.elapsed}s)`));
  const { killed } = abortAllLlmProcesses();
  return NextResponse.json({ killed, message: killed.length ? `Killed: ${killed.join(", ")}` : "No active LLM processes" });
}

export async function GET() {
  const active = getActiveLlmProcesses();
  return NextResponse.json({ active });
}
