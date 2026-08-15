import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync, linkSync, copyFileSync, unlinkSync } from "fs";
import { getScratchDir } from "@/lib/scratch-dir";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";
import { VideoRestorationConfig, DEFAULT_PARAMS, GenerationParams } from "@/lib/types";
import { buildWorkflow } from "@/lib/workflow-builder";
import { apiLog } from "@/lib/api-logger";
import { getOfflineEnv } from "@/lib/veksnap-settings";
import { registerGpuProcess, releaseGpuProcess, installGpuProcessExitHook } from "@/lib/gpu-process-registry";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";

// Ensure a hard server exit cannot leave a multi-gigabyte model subprocess resident.
installGpuProcessExitHook();

// In-memory job store (single job at a time for simplicity)
interface RestoreJob {
  id: string;
  status: "preprocessing" | "restoring" | "postprocessing" | "encoding" | "complete" | "error";
  progress: number;
  label: string;
  error: string | null;
  outputPath: string | null;
  pid: number | null;
  cancelled: boolean;
  config: VideoRestorationConfig;
  workDir: string;
  startedAt: number;
  stageStartedAt: number;
  framesProcessed: number;
  totalFrames: number;
  eta: string | null;
}

/** Throw if the job has been cancelled. Call between every pipeline step. */
function checkCancelled(job: RestoreJob) {
  if (job.cancelled) throw new Error("Cancelled by user");
}

/** Compute and update the ETA string on the job based on frames processed so far. */
function updateETA(job: RestoreJob, done: number, total: number) {
  job.framesProcessed = done;
  job.totalFrames = total;
  if (done <= 0 || total <= 0) { job.eta = null; return; }
  const elapsed = (Date.now() - job.stageStartedAt) / 1000; // seconds
  const perFrame = elapsed / done;
  const remaining = perFrame * (total - done);
  if (remaining < 60) {
    job.eta = `~${Math.ceil(remaining)}s remaining`;
  } else if (remaining < 3600) {
    const m = Math.floor(remaining / 60);
    const s = Math.ceil(remaining % 60);
    job.eta = `~${m}m ${s}s remaining`;
  } else {
    const h = Math.floor(remaining / 3600);
    const m = Math.ceil((remaining % 3600) / 60);
    job.eta = `~${h}h ${m}m remaining`;
  }
}

/**
 * Like execAsync but tracks the child PID on the job so the stop route
 * can kill it, and rejects immediately when the job is cancelled.
 */
function jobExec(job: RestoreJob, cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error("Cancelled by user"));

    const child = spawn(cmd, {
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    job.pid = child.pid ?? null;
    // Generic helper runner (ffmpeg etc). Registered too: these are not model processes, but an
    // orphaned ffmpeg on a hard exit still pins files and NVENC sessions.
    registerGpuProcess(child.pid, "restore helper (ffmpeg)");

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      for (const line of s.split("\n")) { if (line.trim()) apiLog("video_restore", line); }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      for (const line of s.split("\n")) { if (line.trim()) apiLog("video_restore", line); }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      releaseGpuProcess(child.pid);
      job.pid = null;
      if (job.cancelled) return reject(new Error("Cancelled by user"));
      if (code === 0 || code === null) resolve({ stdout, stderr });
      else {
        const err: any = new Error(`Command failed (exit ${code}): ${stderr.slice(0, 500)}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });
  });
}

// ── ComfyUI dispatch for the Z-Image repair pre-pass (Phase 2b) ──
// Mirrors the established server-side pattern: upload frame → POST /prompt → poll /history →
// GET /view. Kept local to the restore route so the pre-pass adds zero new shared surface.
// Single source of truth: the fixed, loopback-only ComfyUI address. NEVER hardcode
// :8188 here - a customer may run their OWN ComfyUI on that default, and we must never
// dispatch their frames/prompts to a foreign instance.
const COMFYUI = COMFYUI_HTTP;

async function comfyPing(): Promise<boolean> {
  try {
    const r = await fetch(`${COMFYUI}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function comfyUploadFrame(filePath: string, uploadName: string): Promise<string> {
  const buf = readFileSync(filePath);
  const fd = new FormData();
  fd.append("image", new Blob([buf], { type: "image/png" }), uploadName);
  fd.append("overwrite", "true");
  const res = await fetch(`${COMFYUI}/upload/image`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`ComfyUI /upload/image failed (${res.status})`);
  const data = (await res.json()) as { name: string; subfolder?: string };
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function comfyQueue(workflow: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${COMFYUI}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!res.ok) {
    throw new Error(
      `ComfyUI rejected the Z-Image repair graph (HTTP ${res.status}). This usually means a ` +
      `required custom node (FaceDetailer / Ultralytics for face mode) is missing.\n${(await res.text()).slice(0, 400)}`
    );
  }
  const { prompt_id } = (await res.json()) as { prompt_id: string };
  return prompt_id;
}

async function comfyWait(
  promptId: string,
  timeoutMs: number,
): Promise<{ filename: string; subfolder: string; type: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    const res = await fetch(`${COMFYUI}/history/${promptId}`);
    if (!res.ok) continue;
    const data = (await res.json()) as Record<string, unknown>;
    const entry = data[promptId] as
      | { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }
      | undefined;
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw new Error("ComfyUI reported an execution error during Z-Image repair: check the ComfyUI console for the node trace.");
    }
    if (entry.status?.completed) {
      for (const nodeOut of Object.values(entry.outputs || {})) {
        if (nodeOut.images?.length) {
          const img = nodeOut.images[0];
          return { filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" };
        }
      }
      throw new Error("ComfyUI completed the repair prompt but produced no image output.");
    }
  }
  throw new Error(`Z-Image repair timed out after ${Math.round(timeoutMs / 1000)}s on a frame.`);
}

async function comfyFetchPng(filename: string, subfolder: string, type: string): Promise<Buffer> {
  const qs = new URLSearchParams({ filename, subfolder, type });
  const res = await fetch(`${COMFYUI}/view?${qs.toString()}`);
  if (!res.ok) throw new Error(`ComfyUI /view failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Free ComfyUI's resident models before the SeedVR2 CLI launches, both want the GPU. */
async function comfyFreeVram(): Promise<void> {
  try {
    await fetch(`${COMFYUI}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* best-effort, SeedVR2 still runs, just with less VRAM headroom */ }
}

/**
 * Build the Z-Image repair workflow for a single frame already uploaded to ComfyUI's input dir.
 * Reuses the SAME graph builders as the Image Studio (buildWorkflow → face-repair / enhance-details)
 * so the video pre-pass and the single-image tools produce identical repairs. A FIXED seed is used
 * for every frame on purpose: per-frame random seeds would MAXIMISE the flicker that the following
 * SeedVR2 temporal pass then has to remove.
 */
function buildFrameRepairWorkflow(imageName: string, config: VideoRestorationConfig): Record<string, unknown> {
  const hasPrompt = !!(config.zimageRepairPrompt || "").trim();
  const denoise = config.zimageRepairDenoise > 0 ? config.zimageRepairDenoise : 0;
  const params: GenerationParams = {
    ...DEFAULT_PARAMS,
    loras: [],
    sourceImage: imageName,
    positivePrompt: config.zimageRepairPrompt || "",
    negativePrompt: "",
    randomSeed: false,
    seed: 1234567,
    cfg: 0,      // 0 → builder resolves its own clamped safe default
    denoise,     // 0 → builder default; enhance mode reads this directly
  };
  if (config.zimageRepairMode === "face") {
    params.zimageFaceRepair = true;
    params.zimageFaceAppendPrompt = hasPrompt;
    if (denoise > 0) params.zimageFaceDenoise = denoise;
  } else {
    params.zimageEnhanceDetails = true;
    params.zimageEnhanceAppendPrompt = hasPrompt;
  }
  return buildWorkflow(params, "zimage") as Record<string, unknown>;
}

// Global job reference: only one restore job at a time
declare global {
  // eslint-disable-next-line no-var
  var __restoreJob: RestoreJob | undefined;
}

export async function POST(req: NextRequest) {
  try {
    const config: VideoRestorationConfig = await req.json();

    if (!config.inputVideoPath || !existsSync(config.inputVideoPath)) {
      return NextResponse.json({ error: "Input video not found" }, { status: 400 });
    }

    // Create deterministic working directory based on video identity
    // so re-runs of the same file can reuse extracted frames
    const videoStat = statSync(config.inputVideoPath);
    const targetFps = config.targetFps > 0 ? config.targetFps : 0;
    const videoIdentity = `${config.inputVideoPath}|${videoStat.size}|${videoStat.mtimeMs}|fps=${targetFps}`;
    const videoHash = createHash("md5").update(videoIdentity).digest("hex").slice(0, 12);
    const jobId = `restore_${videoHash}`;
    // Install-local scratch, NOT os.tmpdir(): see src/lib/scratch-dir.ts. The OS temp dir
    // is world-readable and shared by every app on the machine, and user video frames are
    // private content. Living under <install>/Temp also means the "Clear Temporary Files"
    // cleaner already sweeps this (the `appScratch` category in shell/main.js).
    const workDir = path.join(getScratchDir("restore"), jobId);
    mkdirSync(path.join(workDir, "frames_in"), { recursive: true });
    mkdirSync(path.join(workDir, "frames_preprocessed"), { recursive: true });
    mkdirSync(path.join(workDir, "frames_restored"), { recursive: true });

    const job: RestoreJob = {
      id: jobId,
      status: "preprocessing",
      progress: 0,
      label: "Starting...",
      error: null,
      outputPath: null,
      pid: null,
      cancelled: false,
      config,
      workDir,
      startedAt: Date.now(),
      stageStartedAt: Date.now(),
      framesProcessed: 0,
      totalFrames: 0,
      eta: null,
    };
    global.__restoreJob = job;

    // Run the pipeline asynchronously
    apiLog("video_restore", `Restoration started: job ${job.id}, input: ${config.inputVideoPath}`);
    apiLog("video_restore", `Config: esrgan=${config.esrganModel}, scale=${config.esrganScale}, denoise=${config.denoiseEnabled}`);
    runPipeline(job)
      .then(() => apiLog("video_restore", `Restoration complete: job ${job.id}`))
      .catch((err) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
        apiLog("video_restore", `[ERR] Restoration failed: ${job.error}`);
      });

    return NextResponse.json({ jobId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start restoration" },
      { status: 500 }
    );
  }
}

async function runPipeline(job: RestoreJob) {
  const { config, workDir } = job;
  const ffmpeg = getFFmpegPath();
  const ffprobe = getFFprobePath();
  const framesIn = path.join(workDir, "frames_in");
  const framesPreprocessed = path.join(workDir, "frames_preprocessed");
  const framesRestored = path.join(workDir, "frames_restored");

  // ── Step 1: Extract frames (with smart caching) ──
  job.status = "preprocessing";

  // Determine effective FPS: use targetFps if set, otherwise use input FPS
  const effectiveFps = config.targetFps > 0 ? config.targetFps : config.inputFps;

  const existingFrames = readdirSync(framesIn).filter((f) => f.endsWith(".png"));
  if (existingFrames.length > 0) {
    // Frames already extracted from a previous run of the same video, reuse them
    job.label = `Reusing ${existingFrames.length} cached frames (skipping extraction)`;
    job.progress = 10;
  } else {
    const fpsLabel = config.targetFps > 0 ? ` at ${config.targetFps} fps` : "";
    job.label = `Extracting frames${fpsLabel}...`;
    job.progress = 5;

    // When targetFps is set, use -r to decimate during extraction (e.g. 60→30fps halves frame count)
    const fpsFlag = config.targetFps > 0 ? `-r ${config.targetFps} ` : "";
    await jobExec(job,
      `"${ffmpeg}" -i "${config.inputVideoPath}" ${fpsFlag}-qscale:v 1 -qmin 1 -qmax 1 -fps_mode passthrough "${path.join(framesIn, "frame%08d.png")}" -y`
    );
  }

  const frameFiles = readdirSync(framesIn).filter((f) => f.endsWith(".png")).sort();
  const totalFrames = frameFiles.length;
  if (totalFrames === 0) throw new Error("No frames extracted from video");

  if (existingFrames.length === 0) {
    job.label = `Extracted ${totalFrames} frames`;
  }
  job.progress = 10;
  checkCancelled(job);

  // ── Step 2: Pre-processing (ffmpeg filters) ──
  const needsPreprocessing = config.denoiseEnabled || config.brightnessAdjust !== 0 || config.contrastAdjust !== 1.0;
  if (needsPreprocessing) {
    const existingPreprocessed = readdirSync(framesPreprocessed).filter((f) => f.endsWith(".png"));

    if (existingPreprocessed.length >= totalFrames) {
      // Already preprocessed from a previous run, skip
      job.label = `Reusing ${existingPreprocessed.length} pre-processed frames`;
      job.progress = 20;
    } else {
      job.label = "Pre-processing frames (denoise/brightness/contrast)...";
      job.progress = 12;

      const filters: string[] = [];
      if (config.denoiseEnabled) {
        filters.push(`nlmeans=s=${config.denoiseStrength}:p=7:r=15`);
      }
      if (config.brightnessAdjust !== 0 || config.contrastAdjust !== 1.0) {
        filters.push(`eq=brightness=${config.brightnessAdjust}:contrast=${config.contrastAdjust}`);
      }

      const filterStr = filters.join(",");
      await jobExec(job,
        `"${ffmpeg}" -i "${path.join(framesIn, "frame%08d.png")}" -vf "${filterStr}" "${path.join(framesPreprocessed, "frame%08d.png")}" -y`
      );

      job.progress = 20;
    }
  }

  let sourceFramesDir = (config.denoiseEnabled || config.brightnessAdjust !== 0 || config.contrastAdjust !== 1.0)
    ? framesPreprocessed
    : framesIn;

  checkCancelled(job);

  // ── Step 2.5: Z-Image Turbo repair PRE-PASS (Phase 2b) ──
  // Region-targeted (face) or whole-frame (enhance) semantic repair of every frame via ComfyUI,
  // BEFORE the temporal SeedVR2 pass. Independent per-frame repairs necessarily flicker; SeedVR2's
  // cross-frame attention then removes that flicker, which is exactly why the order is fixed as
  // repair→SeedVR2. Gated to the SeedVR2 engine: Real-ESRGAN has no temporal pass to absorb the
  // flicker, so a repair pre-pass there would leave it visible. Fully resumable and cancellable.
  if (config.engine === "seedvr2" && config.zimageRepairEnabled) {
    job.status = "preprocessing";
    job.stageStartedAt = Date.now();
    job.eta = null;
    job.label = "Z-Image repair: checking ComfyUI...";
    if (!(await comfyPing())) {
      throw new Error(
        `Z-Image repair is enabled but ComfyUI is not reachable at ${COMFYUI}. ` +
        `Start ComfyUI from the Services panel and retry (or disable the repair pre-pass).`
      );
    }

    const framesZRepaired = path.join(workDir, "frames_zrepaired");
    mkdirSync(framesZRepaired, { recursive: true });

    const repairSrc = readdirSync(sourceFramesDir).filter((f) => f.endsWith(".png")).sort();
    const alreadyRepaired = new Set(readdirSync(framesZRepaired).filter((f) => f.endsWith(".png")));
    const pendingRepair = repairSrc.filter((f) => !alreadyRepaired.has(f));
    const repairDone0 = repairSrc.length - pendingRepair.length;

    apiLog("video_restore",
      `Z-Image repair pre-pass: mode=${config.zimageRepairMode}, denoise=${config.zimageRepairDenoise || "default"}, ` +
      `frames=${repairSrc.length} (${repairDone0} already repaired, ${pendingRepair.length} pending)`
    );

    let repaired = repairDone0;
    for (const f of pendingRepair) {
      checkCancelled(job);
      // Upload the source frame to ComfyUI, repair it with the SAME graph the Image Studio uses,
      // then write the result to the repaired-frames dir.
      const uploadName = await comfyUploadFrame(path.join(sourceFramesDir, f), `zrepair_${job.id}_${f}`);
      const workflow = buildFrameRepairWorkflow(uploadName, config);
      const promptId = await comfyQueue(workflow);
      const out = await comfyWait(promptId, 180_000);
      const png = await comfyFetchPng(out.filename, out.subfolder, out.type);
      writeFileSync(path.join(framesZRepaired, f), png);
      repaired++;
      job.progress = Math.min(24, 12 + (repaired / repairSrc.length) * 12);
      job.label = `Z-Image ${config.zimageRepairMode} repair: ${repaired}/${repairSrc.length} frames`;
      updateETA(job, repaired - repairDone0, pendingRepair.length);
    }

    // Free ComfyUI's VRAM before the SeedVR2 CLI launches, they both want the GPU and SeedVR2 is
    // the larger consumer. Best-effort; a stale resident model only costs headroom.
    job.label = "Z-Image repair complete: freeing ComfyUI VRAM before SeedVR2...";
    await comfyFreeVram();

    // Repaired frames become the input for every downstream stage (SeedVR2 clip build, resume
    // detection, final encode).
    sourceFramesDir = framesZRepaired;
    apiLog("video_restore", `Z-Image repair pre-pass complete: SeedVR2 will consume ${framesZRepaired}`);
    checkCancelled(job);
  }

  // ── Step 3: AI Restoration (with resume support) ──
  job.status = "restoring";
  job.stageStartedAt = Date.now();
  job.eta = null;

  // Check which frames have already been restored (resume support)
  const sourceFiles = readdirSync(sourceFramesDir).filter((f) => f.endsWith(".png")).sort();
  const alreadyRestored = new Set(readdirSync(framesRestored).filter((f) => f.endsWith(".png")));
  const pendingFiles = sourceFiles.filter((f) => !alreadyRestored.has(f));
  const alreadyDoneCount = sourceFiles.length - pendingFiles.length;

  if (pendingFiles.length === 0) {
    // All frames already restored from a previous run, skip entirely
    job.label = `All ${sourceFiles.length} frames already restored (resuming)`;
    job.progress = 75;
  } else {
    // Determine which directory to feed to the AI engine
    let inputDir = sourceFramesDir;

    if (alreadyDoneCount > 0) {
      // Partial resume: create a "pending" directory with only remaining frames
      job.label = `Resuming: ${alreadyDoneCount}/${totalFrames} already done, ${pendingFiles.length} remaining`;
      job.progress = 25 + (alreadyDoneCount / totalFrames) * 50;

      const pendingDir = path.join(workDir, "frames_pending");
      mkdirSync(pendingDir, { recursive: true });
      // Clean any stale links from prior aborted resume
      for (const f of readdirSync(pendingDir)) {
        try { unlinkSync(path.join(pendingDir, f)); } catch { /* ok */ }
      }
      // Hard-link pending frames (instant, no disk copy needed on same volume)
      for (const f of pendingFiles) {
        const src = path.join(sourceFramesDir, f);
        const dst = path.join(pendingDir, f);
        try { linkSync(src, dst); } catch { copyFileSync(src, dst); }
      }
      inputDir = pendingDir;
    } else {
      job.label = `Restoring with ${config.engine === "seedvr2" ? "SeedVR2" : "Real-ESRGAN"}...`;
      job.progress = 25;
    }

    const pendingCount = pendingFiles.length;

    if (config.engine === "realesrgan") {
      const veksnapRoot = path.resolve(process.cwd(), "..");
      const esrganExe = path.join(veksnapRoot, "..", "Real-ESRGAN-NCNN-Vulkan Project", "Real-ESRGAN-Portable-v3", "realesrgan-ncnn-vulkan.exe");

      if (!existsSync(esrganExe)) {
        throw new Error("Real-ESRGAN executable not found. Run test_setup.bat in the portable directory.");
      }

      const esrganCmd = `"${esrganExe}" -i "${inputDir}" -o "${framesRestored}" -n ${config.esrganModel} -s ${config.esrganScale} -f png${config.esrganTileSize > 0 ? ` -t ${config.esrganTileSize}` : ""}`;

      await new Promise<void>((resolve, reject) => {
        const child = spawn(esrganCmd, {
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        job.pid = child.pid ?? null;
        registerGpuProcess(child.pid, "Real-ESRGAN restore");
        let processedCount = 0;

        child.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          const matches = text.match(/(\d+\.\d+)%/g);
          if (matches) {
            processedCount++;
            const overallDone = alreadyDoneCount + processedCount;
            const pct = 25 + (overallDone / totalFrames) * 50;
            job.progress = Math.min(75, pct);
            job.label = `Real-ESRGAN: ${overallDone}/${totalFrames} frames${alreadyDoneCount > 0 ? ` (${alreadyDoneCount} resumed)` : ""}`;
            updateETA(job, processedCount, pendingCount);
          }
        });

        child.on("close", (code) => {
          releaseGpuProcess(child.pid);
          job.pid = null;
          if (job.cancelled) return reject(new Error("Cancelled by user"));
          if (code === 0) resolve();
          else reject(new Error(`Real-ESRGAN exited with code ${code}`));
        });

        child.on("error", reject);
      });

    } else if (config.engine === "seedvr2") {
      const veksnapRoot = path.resolve(process.cwd(), "..");
      const comfyRoot = path.join(veksnapRoot, "ComfyUI");
      const seedvrNode = path.join(comfyRoot, "custom_nodes", "ComfyUI-SeedVR2_VideoUpscaler");

      if (!existsSync(seedvrNode)) {
        throw new Error("SeedVR2 ComfyUI node not installed. Run Download_SeedVR2.bat first.");
      }

      const cliScript = path.join(seedvrNode, "inference_cli.py");
      if (!existsSync(cliScript)) {
        throw new Error("SeedVR2 CLI (inference_cli.py) not found. Run Download_SeedVR2.bat to install the SeedVR2 node.");
      }

      const comfyEnvPython = findComfyPython(veksnapRoot);
      if (!comfyEnvPython) throw new Error("ComfyUI Python environment not found");

      const seed = config.seedvrRandomSeed ? Math.floor(Math.random() * 2147483647) : config.seedvrSeed;

      // Always process as directory of frames with model caching.
      const cliArgs = [
        `"${inputDir}"`,
        `--output "${framesRestored}"`,
        `--output_format png`,
        `--resolution ${config.seedvrOutputHeight > 0 ? config.seedvrOutputHeight : config.inputHeight}`,
        `--seed ${seed}`,
        `--color_correction ${config.seedvrColorFix ? "lab" : "none"}`,
        // VAE tiling prevents OOM in VAE attention layers (critical for 4K frames)
        `--vae_encode_tiled`,
        `--vae_decode_tiled`,
        // Model caching: keep DiT + VAE loaded between frames
        `--cache_dit`,
        `--cache_vae`,
        `--dit_offload_device cpu`,
        `--vae_offload_device cpu`,
        // Tensor offloading: moves intermediate activations to CPU between layers.
        // Essential for 4K frames where activations exceed remaining VRAM headroom.
        `--tensor_offload_device cpu`,
      ];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          `"${comfyEnvPython}" "${cliScript}" ${cliArgs.join(" ")}`,
          {
            shell: true,
            windowsHide: true,
            cwd: seedvrNode,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PYTHONIOENCODING: "utf-8", ...getOfflineEnv() },
          }
        );

        job.pid = child.pid ?? null;
        // Register the SeedVR2 worker so Flush VRAM / process teardown can actually see and
        // reclaim it. Without this the SeedVR2 worker, the single largest VRAM consumer in the
        // app: is invisible to every memory control, because ComfyUI's /free only knows about
        // models inside its own process.
        registerGpuProcess(child.pid, "SeedVR2 restore");

        const parseProgress = (text: string) => {
          // Parse "Processing file N/M" from SeedVR2 directory mode
          const fileMatch = text.match(/file\s+(\d+)\/(\d+)/i);
          if (fileMatch) {
            const done = parseInt(fileMatch[1]);
            const cliTotal = parseInt(fileMatch[2]);
            const overallDone = alreadyDoneCount + done;
            const pct = 25 + (overallDone / totalFrames) * 50;
            job.progress = Math.min(75, pct);
            job.label = `SeedVR2: ${overallDone}/${totalFrames} frames${alreadyDoneCount > 0 ? ` (${alreadyDoneCount} resumed)` : ""}`;
            updateETA(job, done, cliTotal);
            return;
          }
          // Fallback: any N/M pattern
          const match = text.match(/(\d+)\/(\d+)/);
          if (match) {
            const done = parseInt(match[1]);
            const total = parseInt(match[2]);
            if (total > 1 && total >= done) {
              const overallDone = alreadyDoneCount + done;
              const pct = 25 + (overallDone / totalFrames) * 50;
              job.progress = Math.min(75, pct);
              job.label = `SeedVR2: ${overallDone}/${totalFrames} frames${alreadyDoneCount > 0 ? ` (${alreadyDoneCount} resumed)` : ""}`;
              updateETA(job, done, total);
            }
          }
        };

        child.stdout.on("data", (data: Buffer) => parseProgress(data.toString()));

        child.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          parseProgress(text);
          if (text.includes("Error") || text.includes("CUDA out of memory") || text.includes("Traceback")) {
            // Keep last 2000 chars of error output for diagnostics
            job.error = ((job.error || "") + text).slice(-2000);
          }
        });

        child.on("close", (code) => {
          releaseGpuProcess(child.pid);
          job.pid = null;
          if (job.cancelled) return reject(new Error("Cancelled by user"));
          if (code === 0) resolve();
          else reject(new Error(`SeedVR2 exited with code ${code}. ${job.error || ""}`));
        });

        child.on("error", reject);
      });
    }
  }

  job.progress = 75;
  checkCancelled(job);

  // ── Step 5: Reassemble video ──
  job.status = "encoding";
  job.label = "Encoding output video...";
  job.progress = 86;

  const finalFramesDir = framesRestored;
  const finalFrameFiles = readdirSync(finalFramesDir).filter((f) => f.endsWith(".png")).sort();
  if (finalFrameFiles.length === 0) throw new Error("No restored frames found");

  const srcName = path.basename(config.inputVideoPath, path.extname(config.inputVideoPath));
  const suffix = config.engine === "seedvr2" ? "seedvr2" : `esrgan_x${config.esrganScale}`;

  // ── Output location ──
  // Previously this wrote alongside the SOURCE video, which scattered restored files across
  // whatever folder the input happened to live in. Restored output now lands in a dedicated
  // "Restore" subfolder of the standard output directory, matching the existing convention for
  // other workflows (e.g. output/MovieMaker). This also means temp-cleanup rules never have to
  // distinguish keepers from scratch files: nothing of value is left in Temp.
  // `config.outputDir` is the user's override from Settings; empty means use the default.
  const outputRoot = config.outputDir && config.outputDir.trim()
    ? path.resolve(config.outputDir.trim())
    : path.resolve(process.cwd(), "..", "ComfyUI", "output");
  const restoreDir = path.join(outputRoot, "Restore");
  mkdirSync(restoreDir, { recursive: true });
  const outputPath = path.join(restoreDir, `${srcName}_restored_${suffix}.${config.outputFormat}`);

  // Map codec to ffmpeg encoder name
  const codecMap: Record<string, string> = {
    h264: "libx264",
    h265: "libx265",
    h264_nvenc: "h264_nvenc",
    hevc_nvenc: "hevc_nvenc",
  };
  const encoder = codecMap[config.outputCodec] || "libx264";

  // Quality flags
  const isNvenc = config.outputCodec.includes("nvenc");
  const qualityFlag = isNvenc
    ? `-cq ${config.outputCrf} -preset p7 -rc vbr`
    : `-crf ${config.outputCrf}`;

  // Encode
  let encodeCmd = `"${ffmpeg}" -framerate ${effectiveFps} -i "${path.join(finalFramesDir, "frame%08d.png")}"`;

  // Add audio from source if requested
  if (config.preserveAudio) {
    encodeCmd += ` -i "${config.inputVideoPath}" -map 0:v:0 -map 1:a:0? -c:a copy`;
  }

  encodeCmd += ` -c:v ${encoder} ${qualityFlag} -pix_fmt yuv420p -r ${effectiveFps} "${outputPath}" -y`;

  await jobExec(job, encodeCmd);

  job.progress = 100;
  job.status = "complete";
  job.label = "Complete!";
  job.outputPath = outputPath;
  job.pid = null;
}

function findComfyPython(veksnapRoot: string): string | null {
  const candidates = [
    process.env.VEKSNAP_PYTHON,
    // Installer-provisioned venv (new layout): preferred.
    path.join(veksnapRoot, "runtime", "venv", "Scripts", "python.exe"),
    // Legacy conda env (dev machines).
    path.join(veksnapRoot, "miniconda", "envs", "comfyui", "python.exe"),
    path.join(veksnapRoot, "miniconda", "python.exe"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
