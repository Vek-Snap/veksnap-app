/**
 * POST /api/component-backup: full file-level "Verified Restore Point" backups.
 *
 * Actions:
 *   { action: "scopes" }                       → available backup scopes
 *   { action: "estimate", scopes }             → size / time / free-space estimate
 *   { action: "create", label, scopes }        → starts a background job → { jobId }
 *   { action: "job", jobId }                   → progress of a running/finished job
 *   { action: "list" }                         → existing restore points
 *   { action: "restore", id }                  → verify seal + checksum, then restore
 *   { action: "delete", id }                   → remove a restore point
 *
 * Fully offline: creating and restoring touch only the local filesystem - no
 * network of any kind, so no allowOnline gate is required.
 */
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  listScopes, estimateBackup, createBackup, listBackups, restoreBackup, deleteBackup,
  type BackupScopeId, type CreateProgress, type BackupIndexEntry,
} from "@/lib/component-backup";

export const dynamic = "force-dynamic";

interface Job {
  id: string;
  status: "running" | "done" | "error";
  progress: CreateProgress;
  result?: BackupIndexEntry;
  error?: string;
  startedAt: number;
}

// In-memory job registry (single-process node server). Pruned after a TTL.
const jobs = new Map<string, Job>();
const JOB_TTL_MS = 30 * 60 * 1000;
function pruneJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status !== "running" && now - j.startedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
}

export async function POST(req: Request) {
  let body: { action?: string; scopes?: BackupScopeId[]; label?: string; id?: string; jobId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const action = body.action;

  try {
    if (action === "scopes") {
      return NextResponse.json({ scopes: listScopes() });
    }

    if (action === "estimate") {
      if (!body.scopes?.length) return NextResponse.json({ error: "No scopes selected" }, { status: 400 });
      return NextResponse.json(estimateBackup(body.scopes));
    }

    if (action === "create") {
      if (!body.scopes?.length) return NextResponse.json({ error: "No scopes selected" }, { status: 400 });
      pruneJobs();
      const jobId = `job-${Date.now()}`;
      const job: Job = {
        id: jobId,
        status: "running",
        progress: { phase: "scanning", processedBytes: 0, totalBytes: 0 },
        startedAt: Date.now(),
      };
      jobs.set(jobId, job);
      const label = (body.label || "").trim() || `Restore point ${new Date().toLocaleString()}`;
      const scopes = body.scopes;
      // Fire and forget: progress is polled via { action: "job" }.
      createBackup(label, scopes, appVersion(), (p) => { job.progress = p; })
        .then((entry) => { job.status = "done"; job.result = entry; })
        .catch((e: Error) => { job.status = "error"; job.error = e.message; job.progress = { ...job.progress, phase: "error", message: e.message }; });
      return NextResponse.json({ jobId });
    }

    if (action === "job") {
      if (!body.jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
      const job = jobs.get(body.jobId);
      if (!job) return NextResponse.json({ error: "Job not found (may have expired)" }, { status: 404 });
      return NextResponse.json({
        status: job.status, progress: job.progress, result: job.result, error: job.error,
      });
    }

    if (action === "list") {
      return NextResponse.json({ backups: listBackups() });
    }

    if (action === "restore") {
      if (!body.id) return NextResponse.json({ error: "Missing backup id" }, { status: 400 });
      const result = await restoreBackup(body.id);
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    }

    if (action === "delete") {
      if (!body.id) return NextResponse.json({ error: "Missing backup id" }, { status: 400 });
      return NextResponse.json(deleteBackup(body.id));
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
