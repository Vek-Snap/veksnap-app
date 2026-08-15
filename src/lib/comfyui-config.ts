// ── Central ComfyUI backend address (single source of truth) ────────────────
//
// SECURITY POSTURE: ComfyUI is deliberately NOT exposed on its common default
// port (8188). It runs on a FIXED, non-standard, loopback-only port. Benefits:
//   • Smaller attack surface: malware / drive-by localhost probing / naive
//     port scanners that target the well-known ComfyUI port (8188) find nothing.
//   • No collision with a SEPARATE ComfyUI the customer may already run on 8188
//     (which previously could make Vek-Snap silently drive the wrong instance).
//   • Consistent with the UI server, which was likewise moved off its well-known
//     framework default onto a fixed non-standard high port bound to 127.0.0.1.
//
// FIXED (not per-launch random) on purpose: a stable port keeps crash-recovery,
// stale-port cleanup, and warmup pings reliable. Everything that talks to
// ComfyUI: API routes, WebSocket proxy, client uploads, shutdown/scan logic,
// and the service spawner: MUST import from here so the port can never drift.
export const COMFYUI_HOST = "127.0.0.1";
export const COMFYUI_PORT = 41931;
export const COMFYUI_HTTP = `http://${COMFYUI_HOST}:${COMFYUI_PORT}`;
export const COMFYUI_WS = `ws://${COMFYUI_HOST}:${COMFYUI_PORT}/ws`;
export const COMFYUI_ORIGIN = COMFYUI_HTTP;
