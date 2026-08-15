import { NextResponse } from "next/server";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/gpu-status
 *
 * Reports whether the ComfyUI backend is running WITHOUT a CUDA GPU (i.e. it
 * fell back to CPU mode). Used to surface a one-time warning to the user, since
 * CPU generation is 50-100x slower and can exhaust system RAM, behaviour that
 * otherwise reads as a hang or an error.
 *
 * Definitive signal (matches what the launcher logs): ComfyUI's own
 * /system_stats reports `pytorch_version` ending in "+cpu" and/or every device
 * of type "cpu". We never guess from nvidia-smi here, this is the ground truth
 * of how the backend actually launched.
 *
 * Response:
 *   { ready: boolean, cpuMode: boolean, pytorch: string|null, device: string|null }
 * `ready:false` means ComfyUI has not answered yet (still booting) - the caller
 * should retry rather than conclude anything.
 */
export async function GET() {
  try {
    const res = await fetch(`${COMFYUI_HTTP}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return NextResponse.json({ ready: false, cpuMode: false, pytorch: null, device: null });
    }
    const data = await res.json();
    const pytorch: string = data?.system?.pytorch_version ?? "";
    const devices: Array<{ type?: string; name?: string }> = Array.isArray(data?.devices)
      ? data.devices
      : [];

    const torchIsCpu = /\+cpu\b/i.test(pytorch);
    const hasCudaDevice = devices.some((d) => /cuda|xpu|rocm|mps/i.test(String(d?.type ?? "")));
    const allCpuDevices = devices.length > 0 && devices.every((d) => /cpu/i.test(String(d?.type ?? "")));

    const cpuMode = torchIsCpu || (!hasCudaDevice && allCpuDevices);

    return NextResponse.json({
      ready: true,
      cpuMode,
      pytorch: pytorch || null,
      device: devices[0]?.type ?? null,
    });
  } catch {
    // ComfyUI not up yet: tell the caller to retry, don't assert CPU mode.
    return NextResponse.json({ ready: false, cpuMode: false, pytorch: null, device: null });
  }
}
