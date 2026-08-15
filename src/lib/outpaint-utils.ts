/**
 * Outpaint Utilities: Client-side Canvas operations for image expansion
 *
 * Implements the Vek-Snap outpainting technique:
 * 1. Edge-pad the source image in selected directions
 * 2. Create a binary mask (white = new area to generate)
 * 3. Apply vekSnapFill (progressive box blur preserving original pixels)
 * 4. Create a soft gradient mask for seamless post-composite blending
 */

import { OutpaintConfig } from "./types";

export interface OutpaintPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
  totalWidth: number;
  totalHeight: number;
}

/**
 * Calculate padding in pixels from outpaint config + source dimensions.
 * All values rounded to multiples of 8 for VAE compatibility.
 */
export function calculatePadding(
  srcW: number,
  srcH: number,
  config: OutpaintConfig
): OutpaintPadding {
  const dirs = config.directions;
  const pcts = config.percentages;

  const rawL = dirs.left ? Math.round(srcW * (pcts.left / 100)) : 0;
  const rawR = dirs.right ? Math.round(srcW * (pcts.right / 100)) : 0;
  const rawT = dirs.top ? Math.round(srcH * (pcts.top / 100)) : 0;
  const rawB = dirs.bottom ? Math.round(srcH * (pcts.bottom / 100)) : 0;

  // Round each to mult of 8
  const left = Math.ceil(rawL / 8) * 8;
  const right = Math.ceil(rawR / 8) * 8;
  const top = Math.ceil(rawT / 8) * 8;
  const bottom = Math.ceil(rawB / 8) * 8;

  const totalWidth = Math.ceil((srcW + left + right) / 8) * 8;
  const totalHeight = Math.ceil((srcH + top + bottom) / 8) * 8;

  return { left, right, top, bottom, totalWidth, totalHeight };
}

/** Load an image URL into an HTMLImageElement */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Convert canvas to Blob */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b!), "image/png");
  });
}

/**
 * Create the edge-padded image.
 * Uses CSS-like edge replication: stretches the outermost 1px strip into the padded area.
 */
function createPaddedCanvas(
  img: HTMLImageElement,
  pad: OutpaintPadding
): HTMLCanvasElement {
  const { left, right, top, bottom, totalWidth, totalHeight } = pad;
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = totalWidth;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d")!;

  // Draw original image at padded offset
  ctx.drawImage(img, left, top);

  // Edge-replicate: stretch 1px strips into padding areas

  // Left edge: stretch leftmost column
  if (left > 0) {
    ctx.drawImage(img, 0, 0, 1, srcH, 0, top, left, srcH);
  }
  // Right edge: stretch rightmost column
  if (right > 0) {
    ctx.drawImage(img, srcW - 1, 0, 1, srcH, left + srcW, top, right, srcH);
  }
  // Top edge: stretch topmost row (including already-filled left/right corners)
  if (top > 0) {
    ctx.drawImage(canvas, 0, top, totalWidth, 1, 0, 0, totalWidth, top);
  }
  // Bottom edge: stretch bottommost row (including left/right corners)
  if (bottom > 0) {
    ctx.drawImage(canvas, 0, top + srcH - 1, totalWidth, 1, 0, top + srcH, totalWidth, bottom);
  }

  return canvas;
}

/**
 * Create binary mask: white (255) for new areas, black (0) for original.
 */
function createMaskCanvas(
  srcW: number,
  srcH: number,
  pad: OutpaintPadding
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = pad.totalWidth;
  canvas.height = pad.totalHeight;
  const ctx = canvas.getContext("2d")!;

  // Fill entire canvas white (new area = to generate)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pad.totalWidth, pad.totalHeight);

  // Fill original image area black (keep original)
  ctx.fillStyle = "#000000";
  ctx.fillRect(pad.left, pad.top, srcW, srcH);

  return canvas;
}

/**
 * Vek-Snap fill: progressive box blur preserving original pixels.
 * Creates smooth color gradients extending from the original image edges
 * into the new padded areas, giving the model better color hints.
 *
 * Reimplements the content-aware fill algorithm using Canvas blur filter.
 */
function createFilledCanvas(
  paddedCanvas: HTMLCanvasElement,
  origImg: HTMLImageElement,
  pad: OutpaintPadding
): HTMLCanvasElement {
  const { totalWidth: w, totalHeight: h, left, top } = pad;

  // Working canvas: starts as copy of padded image
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(paddedCanvas, 0, 0);

  // Temp canvas for blur operations
  const temp = document.createElement("canvas");
  temp.width = w;
  temp.height = h;
  const tCtx = temp.getContext("2d")!;

  // Progressive blur passes (large kernels first, shrinking)
  // Canvas blur() uses Gaussian-like blur; approximate box_blur kernel sizes
  const passes: [number, number][] = [
    [256, 2], [128, 2], [64, 4], [32, 4], [16, 8], [8, 8], [4, 16], [2, 16],
  ];

  for (const [k, repeats] of passes) {
    for (let i = 0; i < repeats; i++) {
      // Blur entire working canvas onto temp
      tCtx.filter = `blur(${k}px)`;
      tCtx.drawImage(canvas, 0, 0);
      tCtx.filter = "none";

      // Restore original pixels by stamping the original image back
      tCtx.drawImage(origImg, left, top);

      // Copy result back to working canvas
      ctx.drawImage(temp, 0, 0);
    }
  }

  return canvas;
}

/**
 * Create soft gradient mask for seamless post-composite blending.
 * Approximates morphological_open by blurring the binary mask
 * to create a smooth transition zone at the original/new boundary.
 */
function createSoftMaskCanvas(
  maskCanvas: HTMLCanvasElement,
  pad: OutpaintPadding
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = pad.totalWidth;
  canvas.height = pad.totalHeight;
  const ctx = canvas.getContext("2d")!;

  // Apply progressive blur to create gradient transition (~32px zone)
  ctx.filter = "blur(24px)";
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.filter = "none";

  // Reinforce: ensure edges are fully white, center is fully black
  // Draw a slightly smaller black rect to keep original area sharp
  const inset = 24; // matches blur radius
  const origX = pad.left + inset;
  const origY = pad.top + inset;
  const origW = pad.totalWidth - pad.left - pad.right - inset * 2;
  const origH = pad.totalHeight - pad.top - pad.bottom - inset * 2;

  if (origW > 0 && origH > 0) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(origX, origY, origW, origH);
  }

  // Re-blur to smooth the reinforced edges
  const temp = document.createElement("canvas");
  temp.width = pad.totalWidth;
  temp.height = pad.totalHeight;
  const tCtx = temp.getContext("2d")!;
  tCtx.filter = "blur(16px)";
  tCtx.drawImage(canvas, 0, 0);

  return temp;
}

/**
 * Main outpaint preparation function.
 * Takes a source image URL and outpaint config, produces 4 Canvas blobs ready for upload.
 */
export async function prepareOutpaintImages(
  sourceImageUrl: string,
  config: OutpaintConfig
): Promise<{
  paddedBlob: Blob;
  filledBlob: Blob;
  maskBlob: Blob;
  softMaskBlob: Blob;
  padding: OutpaintPadding;
}> {
  const img = await loadImage(sourceImageUrl);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  const padding = calculatePadding(srcW, srcH, config);

  // 1. Edge-padded original
  const paddedCanvas = createPaddedCanvas(img, padding);

  // 2. Binary mask
  const maskCanvas = createMaskCanvas(srcW, srcH, padding);

  // 3. Vek-Snap fill (progressive blur preserving original)
  const filledCanvas = createFilledCanvas(paddedCanvas, img, padding);

  // 4. Soft gradient mask for post-composite
  const softMaskCanvas = createSoftMaskCanvas(maskCanvas, padding);

  // Convert to blobs
  const [paddedBlob, filledBlob, maskBlob, softMaskBlob] = await Promise.all([
    canvasToBlob(paddedCanvas),
    canvasToBlob(filledCanvas),
    canvasToBlob(maskCanvas),
    canvasToBlob(softMaskCanvas),
  ]);

  return { paddedBlob, filledBlob, maskBlob, softMaskBlob, padding };
}
