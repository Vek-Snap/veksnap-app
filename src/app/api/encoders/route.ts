import { exec } from "child_process";
import { getFFmpegPath, execFileAsync } from "@/lib/ffmpeg-path";

// Reports which hardware encoders are USABLE on this machine. NVENC is "usable"
// only when the ffmpeg build exposes the encoder AND an NVIDIA GPU is present
// (the BtbN build always lists *_nvenc even without a GPU, so we also probe
// nvidia-smi). The Timeline Editor uses this to offer the GPU-encode option.
export const dynamic = "force-dynamic";

let cached: { body: string; at: number } | null = null;
const TTL = 60_000; // hardware doesn't change mid-session

function hasNvidiaGpu(): Promise<boolean> {
  return new Promise((resolve) => {
    exec("nvidia-smi -L", { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(!err && /GPU\s+\d+/.test(stdout || ""));
    });
  });
}

export async function GET() {
  if (cached && Date.now() - cached.at < TTL) {
    return new Response(cached.body, { headers: { "Content-Type": "application/json" } });
  }

  let buildH264 = false;
  let buildHevc = false;
  try {
    const { stdout } = await execFileAsync(getFFmpegPath(), ["-hide_banner", "-encoders"]);
    buildH264 = /h264_nvenc/.test(stdout);
    buildHevc = /hevc_nvenc/.test(stdout);
  } catch { /* ffmpeg missing, no hardware encoders */ }

  const gpu = (buildH264 || buildHevc) ? await hasNvidiaGpu() : false;
  const body = JSON.stringify({
    nvenc: gpu && (buildH264 || buildHevc),
    h264_nvenc: gpu && buildH264,
    hevc_nvenc: gpu && buildHevc,
  });
  cached = { body, at: Date.now() };
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}
