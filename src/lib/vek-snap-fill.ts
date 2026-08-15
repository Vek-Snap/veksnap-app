/**
 * Vek-Snap Fill: Content-aware inpaint preprocessing
 *
 * Iteratively blurs the image at decreasing radii while restoring
 * unmasked pixels after each pass. This fills the masked area with
 * a smooth color gradient interpolated from surrounding content,
 * giving the diffusion model a coherent starting point instead of
 * noise or the original content that would just get noised away.
 *
 * Also includes `morphologicalOpen`: a soft-mask
 * generator used for seamless post-composite blending (color_correction).
 */

// Blur passes: [radius, repeats] - from coarse to fine
const BLUR_PASSES: [number, number][] = [
  [512, 2],
  [256, 2],
  [128, 4],
  [64, 4],
  [33, 8],
  [15, 8],
  [5, 16],
  [3, 16],
];

/**
 * Build a boolean keep-mask from the exported mask canvas.
 * Returns a Uint8Array where 1 = keep (unmasked), 0 = fill (masked/white).
 * Uses the red channel with threshold 127, mask < 127 = keep area.
 */
function buildKeepFlags(maskCanvas: HTMLCanvasElement): Uint8Array {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const ctx = maskCanvas.getContext("2d")!;
  const data = ctx.getImageData(0, 0, w, h).data;
  const flags = new Uint8Array(w * h);
  for (let i = 0; i < flags.length; i++) {
    // red channel < 127 → keep (convention: mask < 127 = keep area)
    flags[i] = data[i * 4] < 127 ? 1 : 0;
  }
  return flags;
}

/**
 * Apply Vek-Snap content-aware fill to an image.
 * Iteratively blurs, then restores unmasked pixels via pixel data.
 *
 * @param imageCanvas - The original image on a canvas
 * @param maskCanvas  - The mask canvas (white = area to fill, black = keep)
 * @returns A new canvas with the masked area filled with smooth surrounding colors
 */
export function vekSnapFill(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
): HTMLCanvasElement {
  const w = imageCanvas.width;
  const h = imageCanvas.height;

  // Build keep flags and store original pixel values for keep area
  const keepFlags = buildKeepFlags(maskCanvas);
  const origCtx = imageCanvas.getContext("2d")!;
  const origData = origCtx.getImageData(0, 0, w, h).data; // immutable reference copy

  // Working canvas: starts as a copy of the original
  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const wCtx = work.getContext("2d")!;
  wCtx.drawImage(imageCanvas, 0, 0);

  // Temp canvas for applying blur filter (reused each iteration)
  const temp = document.createElement("canvas");
  temp.width = w;
  temp.height = h;
  const tCtx = temp.getContext("2d")!;

  for (const [radius, repeats] of BLUR_PASSES) {
    if (radius > Math.max(w, h)) continue;

    for (let r = 0; r < repeats; r++) {
      // 1. Blur the current working image
      tCtx.clearRect(0, 0, w, h);
      tCtx.filter = `blur(${radius}px)`;
      tCtx.drawImage(work, 0, 0);
      tCtx.filter = "none";

      // 2. Copy blurred result to working canvas
      wCtx.clearRect(0, 0, w, h);
      wCtx.drawImage(temp, 0, 0);

      // 3. Restore unmasked (keep) pixels from original via pixel data
      const blurred = wCtx.getImageData(0, 0, w, h);
      const bd = blurred.data;
      for (let i = 0; i < keepFlags.length; i++) {
        if (keepFlags[i]) {
          const p = i * 4;
          bd[p] = origData[p];
          bd[p + 1] = origData[p + 1];
          bd[p + 2] = origData[p + 2];
          bd[p + 3] = origData[p + 3];
        }
      }
      wCtx.putImageData(blurred, 0, 0);
    }
  }

  return work;
}

/**
 * Morphological open: creates a soft gradient mask
 * for seamless post-composite blending (color_correction).
 *
 * Starts with binary mask (256 where white, 0 where black), then for 32
 * iterations: dilate by 1px (3×3 max filter), subtract 8, take max with
 * current. Result: ~32px gradient transition from mask boundary outward.
 *
 * @param maskCanvas - The binary mask (white = inpaint, black = keep)
 * @returns A new canvas containing the softened grayscale mask
 */
export function morphologicalOpen(maskCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const ctx = maskCanvas.getContext("2d")!;
  const data = ctx.getImageData(0, 0, w, h).data;

  // Initialize int16 buffer: 256 where mask > 127, else 0
  const buf = new Int16Array(w * h);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = data[i * 4] > 127 ? 256 : 0;
  }

  // 32 iterations of: dilate (3×3 max) − 8, then max with current
  const tmp = new Int16Array(w * h);
  for (let iter = 0; iter < 32; iter++) {
    // 3×3 max filter (dilate)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mx = -32768;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const v = buf[ny * w + nx];
            if (v > mx) mx = v;
          }
        }
        tmp[y * w + x] = mx - 8; // dilate − 8
      }
    }
    // max(dilated, current)
    for (let i = 0; i < buf.length; i++) {
      buf[i] = tmp[i] > buf[i] ? tmp[i] : buf[i];
    }
  }

  // Convert to uint8 canvas
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const oCtx = out.getContext("2d")!;
  const oData = oCtx.createImageData(w, h);
  const od = oData.data;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(0, Math.min(255, buf[i]));
    const p = i * 4;
    od[p] = v;
    od[p + 1] = v;
    od[p + 2] = v;
    od[p + 3] = 255;
  }
  oCtx.putImageData(oData, 0, 0);
  return out;
}
