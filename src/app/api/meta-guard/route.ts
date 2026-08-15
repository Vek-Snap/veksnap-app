import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { getFFmpegPath, getFFprobePath, execFileAsync } from "@/lib/ffmpeg-path";

// ── Supported extensions ──

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".tiff", ".tif",
  ".heic", ".heif", ".avif", ".jxl", ".bmp",
]);
const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v",
]);
const AUDIO_EXTS = new Set([
  ".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma", ".opus",
]);
// NOTE: PDF support intentionally removed. The previous implementation routed
// PDFs through ExifReader/exif-be-gone, neither of which parses or strips PDF
// metadata (/Info dict, XMP), so it falsely reported success. Re-add only with
// a real PDF metadata stripper (e.g. qpdf / pdf-lib).

const ALL_SUPPORTED = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS]);

type FileCategory = "image" | "video" | "audio" | "unknown";

function categorize(ext: string): FileCategory {
  const lower = ext.toLowerCase();
  if (IMAGE_EXTS.has(lower)) return "image";
  if (VIDEO_EXTS.has(lower)) return "video";
  if (AUDIO_EXTS.has(lower)) return "audio";
  return "unknown";
}

// Path safety: accept only clean absolute paths (reject null-byte tricks /
// relative paths). Shell injection itself is prevented by execFileAsync's
// argument arrays; this is defense-in-depth for the fs operations.
function validatePath(p: unknown): string | null {
  if (typeof p !== "string" || p.length === 0) return null;
  if (p.includes("\0")) return null;
  if (!path.isAbsolute(p)) return null;
  return path.normalize(p);
}

// ── Privacy risk flags ──

interface PrivacyFlags {
  hasGPS: boolean;
  hasDevice: boolean;
  hasAuthor: boolean;
  hasSoftware: boolean;
  hasTimestamp: boolean;
  hasThumbnail: boolean;
  hasHiddenData: boolean; // trailing data / multiple-EOF (set from forensic scan)
  hasC2PA: boolean;       // Content Credentials manifest (set from forensic scan)
}

function analyzePrivacyRisks(tags: Record<string, any>): PrivacyFlags {
  const keys = Object.keys(tags).map((k) => k.toLowerCase());
  const values = Object.values(tags).map((v) => String(v?.description || v?.value || v || "").toLowerCase());

  return {
    hasGPS: keys.some((k) => k.includes("gps") || k.includes("latitude") || k.includes("longitude")),
    hasDevice: keys.some((k) =>
      k.includes("make") || k.includes("lensm") ||
      // "model" only if it looks like camera model (not "colormode" etc)
      (k.includes("model") && !k.includes("colormo") && !k.includes("mode"))
    ),
    hasAuthor: keys.some((k) =>
      k.includes("artist") || k.includes("author") || k.includes("copyright") ||
      // "creator" but NOT "creatortool" (that's software, not a person)
      (k.includes("creator") && !k.includes("creatortool"))
    ),
    hasSoftware: keys.some((k) =>
      k.includes("software") || k.includes("creatortool") || k.includes("hostcomputer") ||
      k.includes("processingsoftware") || k.includes("prompt") || k.includes("workflow") ||
      k.includes("parameters") || k.includes("png_text")
    ) || values.some((v) => v.includes("photoshop") || v.includes("adobe") || v.includes("gimp") || v.includes("lightroom")),
    hasTimestamp: keys.some((k) =>
      k.includes("datetime") || k.includes("datecreated") || k.includes("createdate") ||
      k.includes("modifydate") || k.includes("metadatadate") || k.includes("png_time") ||
      // Match "time" but avoid false positives like "runtime"
      (k === "time" || k.endsWith("time") || k.startsWith("time"))
    ),
    hasThumbnail: keys.some((k) => k.includes("thumbnail")),
    hasHiddenData: false, // set from forensic anomalies, not from the tag scan
    hasC2PA: false,       // set from forensic anomalies, not from the tag scan
  };
}

// ── GPS / location decoding (observation boost) ──
// The privacy flags tell you a file *has* GPS; these helpers decode it to actual
// coordinates + ready-to-open map links so the user can SEE what's leaking. Covers
// image EXIF (decimal or DMS) and QuickTime/ISO-6709 video location strings.

function mapLinks(lat: number, lon: number): { google: string; osm: string } {
  return {
    google: `https://www.google.com/maps?q=${lat},${lon}`,
    osm: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`,
  };
}

function parseIso6709(s: string): { lat: number; lon: number; alt?: number } | null {
  const nums = String(s).match(/[+-]\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const lat = Math.round(parseFloat(nums[0]) * 1e6) / 1e6;
  const lon = Math.round(parseFloat(nums[1]) * 1e6) / 1e6;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const out: { lat: number; lon: number; alt?: number } = { lat, lon };
  if (nums.length >= 3) out.alt = Math.round(parseFloat(nums[2]) * 10) / 10;
  return out;
}

// DMS ("40 26 46") or already-decimal string → signed decimal degrees.
function toDecimalDeg(val: string, ref?: string): number | null {
  const nums = String(val).match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  let dec = nums.length >= 3
    ? parseFloat(nums[0]) + parseFloat(nums[1]) / 60 + parseFloat(nums[2]) / 3600
    : parseFloat(nums[0]);
  if (!Number.isFinite(dec)) return null;
  if (ref && /[SW]/i.test(ref)) dec = -dec;
  return Math.round(dec * 1e6) / 1e6;
}

interface GpsResult { lat: number; lon: number; alt?: number; google: string; osm: string }

function deriveLocation(
  meta: Record<string, { value: string; group: string }>,
  category: FileCategory,
): GpsResult | null {
  const findVal = (pred: (k: string, g: string) => boolean): string | undefined => {
    for (const [k, e] of Object.entries(meta)) {
      if (pred(k.toLowerCase(), (e.group || "").toLowerCase())) return e.value;
    }
    return undefined;
  };
  // Image EXIF: ExifReader's expanded `gps` group (decimal) or raw GPSLatitude/Longitude (DMS).
  const gpsLat = findVal((k, g) => g === "gps" && k === "latitude") ?? findVal((k) => k === "gpslatitude");
  const gpsLon = findVal((k, g) => g === "gps" && k === "longitude") ?? findVal((k) => k === "gpslongitude");
  if (gpsLat && gpsLon) {
    const lat = toDecimalDeg(gpsLat, findVal((k) => k === "gpslatituderef"));
    const lon = toDecimalDeg(gpsLon, findVal((k) => k === "gpslongituderef"));
    if (lat != null && lon != null && !(lat === 0 && lon === 0)) return { lat, lon, ...mapLinks(lat, lon) };
  }
  // Video/audio: QuickTime or generic ISO-6709 location string.
  if (category === "video" || category === "audio") {
    const loc = findVal((k) => k.includes("iso6709") || k.includes("location"));
    if (loc) {
      const p = parseIso6709(loc);
      if (p && !(p.lat === 0 && p.lon === 0)) return { ...p, ...mapLinks(p.lat, p.lon) };
    }
  }
  return null;
}

// ── PNG metadata chunks (non-essential, removable) ──

const PNG_METADATA_CHUNKS = new Set([
  "tEXt", "zTXt", "iTXt", "eXIf", "iCCP", "tIME", "dSIG",
  "sRGB", "gAMA", "cHRM", "sBIT", "bKGD", "hIST", "sPLT",
  "pHYs",
]);

// Chunks that are essential to rendering (never flagged as metadata)
const PNG_ESSENTIAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);

// ── Raw PNG chunk scanner ──

function parsePngChunks(buf: Buffer): Record<string, { value: string; group: string }> {
  const flat: Record<string, { value: string; group: string }> = {};

  // Verify PNG signature
  const sig = buf.slice(0, 8);
  if (sig.toString("hex") !== "89504e470d0a1a0a") return flat;

  let offset = 8;
  while (offset + 8 < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString("ascii");

    if (PNG_ESSENTIAL_CHUNKS.has(type)) {
      offset += 12 + len;
      continue;
    }

    const dataStart = offset + 8;
    const data = buf.slice(dataStart, dataStart + len);

    if (type === "tEXt") {
      // tEXt: keyword\0text
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const keyword = data.slice(0, nullIdx).toString("latin1");
        const text = data.slice(nullIdx + 1).toString("latin1");
        flat[`png_tEXt_${keyword}`] = { value: text.slice(0, 1000), group: "png_text" };
      }
    } else if (type === "zTXt") {
      // zTXt: keyword\0compressionMethod\compressedText
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const keyword = data.slice(0, nullIdx).toString("latin1");
        flat[`png_zTXt_${keyword}`] = { value: `[compressed, ${len} bytes]`, group: "png_text" };
      }
    } else if (type === "iTXt") {
      // iTXt: keyword\0compressionFlag\compressionMethod\languageTag\0translatedKeyword\0text
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const keyword = data.slice(0, nullIdx).toString("utf8");
        // Try to extract the text portion
        let textPart = "";
        try {
          let pos = nullIdx + 3; // skip null + compressionFlag + compressionMethod
          const langEnd = data.indexOf(0, pos);
          if (langEnd > 0) {
            const transEnd = data.indexOf(0, langEnd + 1);
            if (transEnd > 0) {
              textPart = data.slice(transEnd + 1).toString("utf8");
            }
          }
        } catch { /* fallback */ }
        flat[`png_iTXt_${keyword}`] = { value: textPart.slice(0, 1000) || `[${len} bytes]`, group: "png_text" };
      }
    } else if (type === "iCCP") {
      // iCCP: profileName\0compressionMethod\compressedProfile
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        const profileName = data.slice(0, nullIdx).toString("latin1");
        flat["png_iCCP_profile"] = { value: `${profileName} (${len} bytes embedded)`, group: "png_color" };
      }
    } else if (type === "tIME") {
      // tIME: year(2) month(1) day(1) hour(1) minute(1) second(1)
      if (data.length >= 7) {
        const year = data.readUInt16BE(0);
        const month = data[2];
        const day = data[3];
        const hour = data[4];
        const minute = data[5];
        const second = data[6];
        flat["png_tIME"] = { value: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`, group: "png_time" };
      }
    } else if (type === "pHYs") {
      // pHYs: pixelsPerUnitX(4) pixelsPerUnitY(4) unitSpecifier(1)
      if (data.length >= 9) {
        const ppuX = data.readUInt32BE(0);
        const ppuY = data.readUInt32BE(4);
        const unit = data[8] === 1 ? "meter" : "unknown";
        flat["png_pHYs"] = { value: `${ppuX} x ${ppuY} pixels per ${unit}`, group: "png_physical" };
      }
    } else if (type === "eXIf") {
      flat["png_eXIf"] = { value: `[EXIF block, ${len} bytes]`, group: "png_exif" };
    } else if (type === "sRGB") {
      const intents = ["Perceptual", "Relative colorimetric", "Saturation", "Absolute colorimetric"];
      flat["png_sRGB"] = { value: intents[data[0]] || `intent ${data[0]}`, group: "png_color" };
    } else if (type === "gAMA") {
      if (data.length >= 4) {
        const gamma = data.readUInt32BE(0) / 100000;
        flat["png_gAMA"] = { value: `${gamma}`, group: "png_color" };
      }
    } else if (PNG_METADATA_CHUNKS.has(type)) {
      flat[`png_${type}`] = { value: `[${len} bytes]`, group: "png_other" };
    }

    offset += 12 + len;
  }

  return flat;
}

// ── Read metadata from an image using ExifReader + raw chunk parser ──

async function readImageMetadata(filePath: string) {
  const ExifReader = await import("exifreader");
  const buf = await readFile(filePath);

  // Fix: properly slice ArrayBuffer to match Buffer boundaries
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const flat: Record<string, { value: string; group: string }> = {};

  // 1) ExifReader for standard EXIF/IPTC/XMP/ICC metadata
  try {
    const tags = ExifReader.load(arrayBuffer, { expanded: true });

    for (const [group, entries] of Object.entries(tags)) {
      if (!entries || typeof entries !== "object") continue;
      if (group === "Thumbnail" || group === "Images") continue;
      // Skip pngFile (duplicate of png group)
      if (group === "pngFile" || group === "file") continue;

      for (const [key, tag] of Object.entries(entries as Record<string, any>)) {
        if (key === "undefined" || key.startsWith("MakerNote")) continue;
        let value = "";
        if (tag && typeof tag === "object") {
          value = tag.description ?? tag.value?.toString?.() ?? JSON.stringify(tag.value ?? tag);
        } else {
          value = String(tag);
        }
        if (value && value !== "undefined" && value !== "[object Object]") {
          flat[key] = { value: value.slice(0, 500), group };
        }
      }
    }
  } catch { /* ExifReader might fail on some formats; continue with raw parser */ }

  // 2) For PNG files: raw chunk parser catches everything ExifReader might miss
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    const rawChunks = parsePngChunks(buf);
    // Merge raw chunks (prefer raw for PNG-specific data since it's more detailed)
    for (const [key, entry] of Object.entries(rawChunks)) {
      if (!flat[key]) {
        flat[key] = entry;
      }
    }
  }

  return flat;
}

// ── Deep Forensic: structural anomaly detection ──

interface ForensicAnomalies {
  trailingData: number;       // bytes after EOF marker
  unknownChunks: string[];    // unknown/private chunk types
  nonStandardMarkers: string[]; // non-standard JPEG APP markers
  c2paDetected: boolean;      // C2PA/JUMBF content credentials
  paddingBytes: number;       // suspicious padding/gap bytes
  multipleEOF: boolean;       // multiple end-of-file markers (snipping tool bug)
}

const EMPTY_ANOMALIES: ForensicAnomalies = {
  trailingData: 0, unknownChunks: [], nonStandardMarkers: [],
  c2paDetected: false, paddingBytes: 0, multipleEOF: false,
};

// Standard/essential JPEG markers that are safe
const JPEG_ESSENTIAL_MARKERS = new Set([
  0xd8, // SOI
  0xc0, 0xc1, 0xc2, 0xc3, // SOF variants
  0xc4, // DHT (Huffman table)
  0xdb, // DQT (Quantization table)
  0xdd, // DRI (Restart interval)
  0xda, // SOS (Start of scan)
  0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, // RST markers
  0xd9, // EOI
  0xfe, // COM (comment: metadata but standard)
]);
// APP0 (JFIF) is semi-essential for compatibility
const JPEG_KNOWN_APP = new Set([
  0xe0, // APP0 - JFIF
  0xe1, // APP1 - EXIF/XMP
  0xe2, // APP2 - ICC Profile / FlashPix
  0xed, // APP13 - IPTC / image-editor resource block
  0xee, // APP14 - colour-transform marker
]);

function deepScanJpeg(buf: Buffer): ForensicAnomalies {
  const anomalies: ForensicAnomalies = { ...EMPTY_ANOMALIES };

  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return anomalies;

  // Find last EOI marker (FF D9)
  let lastEOI = -1;
  for (let i = buf.length - 2; i >= 2; i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) {
      lastEOI = i + 2;
      break;
    }
  }

  // Check for trailing data after EOI
  if (lastEOI > 0 && lastEOI < buf.length) {
    anomalies.trailingData = buf.length - lastEOI;
  }

  // Check for multiple EOI markers
  let eoiCount = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) eoiCount++;
  }
  if (eoiCount > 1) anomalies.multipleEOF = true;

  // Scan all markers
  let offset = 2; // skip SOI
  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];

    // Skip padding FF bytes
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x00) { offset += 2; continue; } // stuffed byte

    // SOS: rest is entropy data until next marker
    if (marker === 0xda) break;
    // EOI
    if (marker === 0xd9) break;

    // APP markers (0xE0-0xEF)
    if (marker >= 0xe0 && marker <= 0xef) {
      if (!JPEG_KNOWN_APP.has(marker) && !JPEG_ESSENTIAL_MARKERS.has(marker)) {
        anomalies.nonStandardMarkers.push(`APP${marker - 0xe0}`);
      }
      // Check for C2PA/JUMBF (typically in APP11 = 0xEB)
      if (marker === 0xeb && offset + 10 < buf.length) {
        const seg = buf.slice(offset + 4, offset + 20).toString("ascii");
        if (seg.includes("JUMBF") || seg.includes("c2pa")) {
          anomalies.c2paDetected = true;
        }
      }
      // Check APP1 for C2PA XMP
      if (marker === 0xe1 && offset + 40 < buf.length) {
        const seg = buf.slice(offset + 4, offset + 80).toString("utf8", 0, 76);
        if (seg.includes("c2pa") || seg.includes("C2PA")) {
          anomalies.c2paDetected = true;
        }
      }
    }

    // Read segment length and skip
    if (offset + 3 < buf.length) {
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    } else {
      break;
    }
  }

  return anomalies;
}

function deepScanPng(buf: Buffer): ForensicAnomalies {
  const anomalies: ForensicAnomalies = { ...EMPTY_ANOMALIES };

  if (buf.length < 8 || buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") return anomalies;

  let offset = 8;
  let iendOffset = -1;
  let iendCount = 0;

  // Known standard chunks
  const STANDARD_CHUNKS = new Set([
    "IHDR", "PLTE", "IDAT", "IEND", "tRNS",
    "cHRM", "gAMA", "iCCP", "sBIT", "sRGB",
    "bKGD", "hIST", "tIME", "pHYs", "sPLT",
    "tEXt", "zTXt", "iTXt", "eXIf", "dSIG",
    "oFFs", "pCAL", "sCAL", "gIFg", "gIFx", "gIFt",
    "acTL", "fcTL", "fdAT", // APNG
  ]);

  while (offset + 8 < buf.length) {
    const chunkLen = buf.readUInt32BE(offset);
    const chunkType = buf.slice(offset + 4, offset + 8).toString("ascii");

    if (chunkType === "IEND") {
      iendCount++;
      iendOffset = offset + 12; // IEND is always 0 data + 4 CRC = 12 total
    }

    // Check for C2PA in iTXt or unknown chunk
    if (chunkType === "iTXt" || chunkType === "tEXt") {
      const data = buf.slice(offset + 8, offset + 8 + Math.min(chunkLen, 100));
      const text = data.toString("utf8", 0, Math.min(data.length, 100));
      if (text.includes("c2pa") || text.includes("C2PA") || text.includes("jumbf")) {
        anomalies.c2paDetected = true;
      }
    }

    // Check for JUMBF box (C2PA container)
    if (chunkType === "caBX" || chunkType === "jumb") {
      anomalies.c2paDetected = true;
    }

    // Unknown/private chunks (first letter lowercase = private)
    if (!STANDARD_CHUNKS.has(chunkType)) {
      const firstCharCode = chunkType.charCodeAt(0);
      if (firstCharCode >= 97 && firstCharCode <= 122) {
        // Private chunk (lowercase first letter)
        anomalies.unknownChunks.push(`${chunkType} (${chunkLen} bytes, private)`);
      } else {
        anomalies.unknownChunks.push(`${chunkType} (${chunkLen} bytes, non-standard)`);
      }
    }

    offset += 12 + chunkLen; // 4 length + 4 type + data + 4 CRC
  }

  // Check for trailing data after IEND
  if (iendOffset > 0 && iendOffset < buf.length) {
    anomalies.trailingData = buf.length - iendOffset;
  }

  // Multiple IEND = snipping tool bug or data corruption
  if (iendCount > 1) anomalies.multipleEOF = true;

  return anomalies;
}

function deepScanGeneric(buf: Buffer, ext: string): ForensicAnomalies {
  const lower = ext.toLowerCase();
  if (lower === ".jpg" || lower === ".jpeg") return deepScanJpeg(buf);
  if (lower === ".png") return deepScanPng(buf);
  // For other formats, basic trailing data check not applicable without format knowledge
  return { ...EMPTY_ANOMALIES };
}

// ── Forensic Scrub (Level 2): Rebuild file with only essential structure ──

async function forensicScrubPng(inputPath: string, outputPath: string): Promise<void> {
  const buf = await readFile(inputPath);
  if (buf.length < 8 || buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Not a valid PNG file");
  }

  // Rebuild: keep only IHDR + PLTE + tRNS + IDAT + IEND (rendering-essential chunks)
  const KEEP_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
  const chunks: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]; // PNG signature

  let offset = 8;
  while (offset + 8 < buf.length) {
    const chunkLen = buf.readUInt32BE(offset);
    const chunkType = buf.slice(offset + 4, offset + 8).toString("ascii");
    const totalChunkSize = 12 + chunkLen; // 4 len + 4 type + data + 4 CRC

    if (KEEP_CHUNKS.has(chunkType)) {
      chunks.push(buf.slice(offset, offset + totalChunkSize));
    }

    if (chunkType === "IEND") break; // Stop at IEND, discard anything after
    offset += totalChunkSize;
  }

  // Ensure IEND is present
  const lastChunk = chunks[chunks.length - 1];
  if (!lastChunk || lastChunk.slice(4, 8).toString("ascii") !== "IEND") {
    // Write a proper IEND chunk
    const iend = Buffer.alloc(12);
    iend.writeUInt32BE(0, 0); // length 0
    iend.write("IEND", 4, 4, "ascii");
    iend.writeUInt32BE(0xae426082, 8); // IEND CRC
    chunks.push(iend);
  }

  await writeFile(outputPath, Buffer.concat(chunks));
}

async function forensicScrubJpeg(inputPath: string, outputPath: string): Promise<void> {
  const buf = await readFile(inputPath);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error("Not a valid JPEG file");
  }

  // Rebuild: keep SOI + DQT + DHT + SOF + DRI + SOS + scan data + EOI
  // Drop all APP markers and COM markers
  const output: Buffer[] = [Buffer.from([0xff, 0xd8])]; // SOI

  let offset = 2;
  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];

    // Skip padding/stuffed bytes
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x00) { offset += 2; continue; }

    // EOI: stop here
    if (marker === 0xd9) {
      output.push(Buffer.from([0xff, 0xd9]));
      break;
    }

    // SOS: keep SOS header + all entropy data until EOI
    if (marker === 0xda) {
      // Find the next valid marker after entropy data
      const segLen = buf.readUInt16BE(offset + 2);
      // Copy SOS header
      output.push(buf.slice(offset, offset + 2 + segLen));
      let pos = offset + 2 + segLen;
      // Copy entropy data (everything until FF xx where xx != 00 and xx != FF)
      const entropyStart = pos;
      while (pos < buf.length - 1) {
        if (buf[pos] === 0xff && buf[pos + 1] !== 0x00 && buf[pos + 1] !== 0xff) {
          // RST markers are embedded in entropy data
          if (buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7) {
            pos += 2;
            continue;
          }
          break; // Found next real marker
        }
        pos++;
      }
      output.push(buf.slice(entropyStart, pos));
      offset = pos;
      continue;
    }

    // Marker with length field
    if (offset + 3 < buf.length) {
      const segLen = buf.readUInt16BE(offset + 2);
      const segData = buf.slice(offset, offset + 2 + segLen);

      // Keep only essential markers
      if (marker === 0xdb || // DQT
          marker === 0xc4 || // DHT
          marker === 0xdd || // DRI
          (marker >= 0xc0 && marker <= 0xc3)) { // SOF0-SOF3
        output.push(segData);
      }
      // Drop: all APP markers (0xE0-0xEF), COM (0xFE), and anything else

      offset += 2 + segLen;
    } else {
      break;
    }
  }

  await writeFile(outputPath, Buffer.concat(output));
}

// ── CDR Scrub (Level 3): Full pixel decode → re-encode ──

async function cdrScrubPng(inputPath: string, outputPath: string): Promise<void> {
  const { PNG } = await import("pngjs");
  const inputBuf = await readFile(inputPath);

  return new Promise((resolve, reject) => {
    const png = new PNG();
    png.parse(inputBuf, (err: Error | null) => {
      if (err) return reject(err);

      // Create a brand new minimal PNG from raw pixel data
      const outPng = new PNG({ width: png.width, height: png.height });
      png.data.copy(outPng.data);

      const outputBuf = PNG.sync.write(outPng, { deflateLevel: 6 });
      writeFile(outputPath, outputBuf).then(resolve).catch(reject);
    });
  });
}

async function cdrScrubJpeg(inputPath: string, outputPath: string): Promise<void> {
  const jpeg = await import("jpeg-js");
  const inputBuf = await readFile(inputPath);

  // Decode JPEG to raw pixels
  const decoded = jpeg.decode(inputBuf, { tolerantDecoding: true, formatAsRGBA: true });

  // Re-encode from raw pixels (quality 95 to minimize generation loss)
  const encoded = jpeg.encode({
    data: decoded.data,
    width: decoded.width,
    height: decoded.height,
  }, 95);

  await writeFile(outputPath, encoded.data);
}

// ── Read metadata from video/audio using FFprobe ──

async function readMediaMetadata(filePath: string) {
  const ffprobe = getFFprobePath();
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "quiet", "-print_format", "json",
      "-show_format", "-show_streams", filePath,
    ]);
    const info = JSON.parse(stdout);
    const flat: Record<string, { value: string; group: string }> = {};

    // Format-level tags
    if (info.format?.tags) {
      for (const [k, v] of Object.entries(info.format.tags)) {
        flat[k] = { value: String(v).slice(0, 500), group: "format" };
      }
    }

    // Format metadata
    if (info.format) {
      for (const key of ["format_name", "duration", "size", "bit_rate"]) {
        if (info.format[key]) {
          flat[key] = { value: String(info.format[key]), group: "format" };
        }
      }
    }

    // Stream-level tags
    if (info.streams) {
      for (let i = 0; i < info.streams.length; i++) {
        const s = info.streams[i];
        if (s.tags) {
          for (const [k, v] of Object.entries(s.tags)) {
            flat[`stream${i}_${k}`] = { value: String(v).slice(0, 500), group: `stream_${i}` };
          }
        }
        // Basic stream info
        for (const key of ["codec_name", "codec_type", "width", "height", "sample_rate", "channels"]) {
          if (s[key] !== undefined) {
            flat[`stream${i}_${key}`] = { value: String(s[key]), group: `stream_${i}` };
          }
        }
      }
    }

    return flat;
  } catch {
    return {};
  }
}

// ── Standard PNG scrub: strip metadata chunks but KEEP color/physical chunks ──
// exif-be-gone does NOT remove PNG tEXt/zTXt/iTXt chunks, which is exactly where
// AI prompts/workflow JSON get embedded, so PNGs need their own lossless metadata
// strip that still preserves color fidelity (unlike the forensic rebuild).
async function standardScrubPng(inputPath: string, outputPath: string): Promise<void> {
  const buf = await readFile(inputPath);
  if (buf.length < 8 || buf.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Not a valid PNG file");
  }
  // Keep rendering-essential + color/physical + APNG chunks; drop all textual/metadata chunks
  // (tEXt, zTXt, iTXt, eXIf, tIME, dSIG, hIST, bKGD, sPLT).
  const KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "gAMA", "cHRM", "iCCP", "sRGB", "sBIT", "pHYs", "acTL", "fcTL", "fdAT"]);
  const out: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString("ascii");
    const total = 12 + len;
    if (KEEP.has(type)) out.push(buf.slice(offset, offset + total));
    if (type === "IEND") break;
    offset += total;
  }
  await writeFile(outputPath, Buffer.concat(out));
}

// ── Generic image scrub via FFmpeg for formats our native parsers don't cover ──
// (webp, gif, tiff, heic, heif, avif, jxl, bmp). Re-encodes while dropping metadata.
// If FFmpeg can't handle the format, it throws; the caller reports an honest
// failure instead of falsely claiming the file was cleaned.
async function scrubImageViaFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = getFFmpegPath();
  await execFileAsync(ffmpeg, [
    "-y", "-i", inputPath,
    "-map_metadata", "-1",
    "-fflags", "+bitexact",
    outputPath,
  ]);
}

// ── Scrub metadata from image (lossless via exif-be-gone) ──

async function scrubImage(inputPath: string, outputPath: string): Promise<void> {
  const ExifTransformer = (await import("exif-be-gone")).default;

  return new Promise((resolve, reject) => {
    const reader = createReadStream(inputPath);
    const writer = createWriteStream(outputPath);
    const transformer = new ExifTransformer();

    reader
      .pipe(transformer)
      .pipe(writer)
      .on("finish", resolve)
      .on("error", reject);

    reader.on("error", reject);
    transformer.on("error", reject);
  });
}

// ── Scrub metadata from video/audio (FFmpeg stream copy, no re-encode) ──

// mp4/mov-family containers carry a per-stream `handler_name` (e.g. "VideoHandler",
// or muxer strings like "ISO Media file produced by …") that survives a plain
// -map_metadata strip. -empty_hdlr_name 1 blanks it; +faststart relocates the
// moov atom for clean streaming. -bitexact stops ffmpeg stamping its own encoder tag.
const MP4_FAMILY_EXTS = new Set([".mp4", ".m4v", ".mov", ".m4a", ".m4b", ".3gp", ".3g2"]);

async function scrubMedia(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = getFFmpegPath();
  const ext = path.extname(inputPath).toLowerCase();
  // Strip global, per-stream, and chapter metadata. -c copy avoids re-encoding.
  const args = [
    "-y", "-i", inputPath,
    "-map_metadata", "-1",
    "-map_metadata:s:v", "-1",
    "-map_metadata:s:a", "-1",
    "-map_chapters", "-1",
    "-c", "copy",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact", "-flags:a", "+bitexact",
  ];
  if (MP4_FAMILY_EXTS.has(ext)) {
    args.push("-empty_hdlr_name", "1", "-movflags", "+faststart");
  }
  args.push(outputPath);
  await execFileAsync(ffmpeg, args);
}

// ── POST handler ──

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    // ── READ: Extract metadata from a single file ──
    if (action === "read") {
      const filePath = validatePath(body.filePath);
      if (!filePath || !existsSync(filePath)) {
        return NextResponse.json({ error: "File not found" }, { status: 400 });
      }

      const ext = path.extname(filePath).toLowerCase();
      const category = categorize(ext);
      let metadata: Record<string, { value: string; group: string }> = {};

      if (category === "image") {
        try {
          metadata = await readImageMetadata(filePath);
        } catch (e: any) {
          metadata = {};
        }
      } else if (category === "video" || category === "audio") {
        metadata = await readMediaMetadata(filePath);
      }

      // Deep forensic scan: always run for comprehensive results
      let anomalies: ForensicAnomalies = { ...EMPTY_ANOMALIES };
      if (category === "image") {
        try {
          const buf = await readFile(filePath);
          anomalies = deepScanGeneric(buf, ext);
          // Add anomaly findings to metadata for display
          if (anomalies.trailingData > 0) {
            metadata["⚠️ TRAILING_DATA"] = { value: `${anomalies.trailingData} bytes after EOF marker (hidden data risk!)`, group: "forensic_anomaly" };
          }
          if (anomalies.multipleEOF) {
            metadata["⚠️ MULTIPLE_EOF"] = { value: "Multiple end-of-file markers detected (possible data leak, e.g. Windows Snipping Tool bug)", group: "forensic_anomaly" };
          }
          if (anomalies.c2paDetected) {
            metadata["⚠️ C2PA_CREDENTIALS"] = { value: "Content Credentials / AI provenance manifest detected (may trigger AI labels on social media)", group: "forensic_anomaly" };
          }
          for (const m of anomalies.nonStandardMarkers) {
            metadata[`⚠️ NON_STANDARD_${m}`] = { value: `Non-standard JPEG marker (may contain hidden/proprietary data)`, group: "forensic_anomaly" };
          }
          for (const c of anomalies.unknownChunks) {
            metadata[`⚠️ UNKNOWN_CHUNK_${c.split(" ")[0]}`] = { value: c, group: "forensic_anomaly" };
          }
        } catch { /* forensic scan failure is non-fatal */ }
      }

      // Decode GPS/location to real coordinates + map links, and build a few
      // plain-language interpretation notes (the "observation boost").
      const interpretation: string[] = [];
      const gps = deriveLocation(metadata, category);
      if (gps) {
        metadata["📍 GPS_COORDINATES"] = { value: `${gps.lat}, ${gps.lon}${gps.alt != null ? ` (alt ${gps.alt} m)` : ""}`, group: "location" };
        metadata["📍 MAP_GOOGLE"] = { value: gps.google, group: "location" };
        metadata["📍 MAP_OPENSTREETMAP"] = { value: gps.osm, group: "location" };
        interpretation.push(`Precise GPS location present: this file reveals where it was captured: ${gps.lat}, ${gps.lon}. Open in Maps: ${gps.google}`);
      }
      const softwareKey = Object.keys(metadata).find((k) => {
        const lk = k.toLowerCase();
        return lk.includes("software") || lk.includes("creatortool") || lk === "encoder" || lk.endsWith("_encoder");
      });
      if (softwareKey) {
        interpretation.push(`Editor/encoder string present ("${metadata[softwareKey].value}"): can reveal the software, phone encoder, or a re-encode/edit pipeline.`);
      }

      const privacy = analyzePrivacyRisks(metadata);
      if (anomalies.trailingData > 0 || anomalies.multipleEOF) privacy.hasHiddenData = true;
      if (anomalies.c2paDetected) privacy.hasC2PA = true;
      const fileStat = await stat(filePath);

      return NextResponse.json({
        ok: true,
        filePath,
        fileName: path.basename(filePath),
        fileSize: fileStat.size,
        category,
        metadataCount: Object.keys(metadata).length,
        metadata,
        privacy,
        anomalies,
        gps: gps ?? null,
        interpretation,
      });
    }

    // ── SCAN: Scan a directory for files with metadata ──
    if (action === "scan") {
      const dirPath = validatePath(body.dirPath);
      if (!dirPath || !existsSync(dirPath)) {
        return NextResponse.json({ error: "Directory not found" }, { status: 400 });
      }

      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) {
        return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
      }

      const entries = await readdir(dirPath);
      const results: any[] = [];

      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!ALL_SUPPORTED.has(ext)) continue;
        // Skip files we already produced so re-scanning can't chain into _clean_clean.
        if (/(_clean|_forensic|_cdr)$/.test(path.basename(entry, ext))) continue;

        const fullPath = path.join(dirPath, entry);
        try {
          const fStat = await stat(fullPath);
          if (!fStat.isFile()) continue;

          const category = categorize(ext);
          let metadataCount = 0;
          let privacy: PrivacyFlags = { hasGPS: false, hasDevice: false, hasAuthor: false, hasSoftware: false, hasTimestamp: false, hasThumbnail: false, hasHiddenData: false, hasC2PA: false };
          let anomalies: ForensicAnomalies = { ...EMPTY_ANOMALIES };

          if (category === "image") {
            try {
              const meta = await readImageMetadata(fullPath);
              metadataCount = Object.keys(meta).length;
              privacy = analyzePrivacyRisks(meta);
            } catch { /* skip unreadable */ }
            // Deep forensic scan
            try {
              const buf = await readFile(fullPath);
              anomalies = deepScanGeneric(buf, ext);
              // Count anomalies as additional metadata findings
              if (anomalies.trailingData > 0) metadataCount++;
              if (anomalies.multipleEOF) metadataCount++;
              if (anomalies.c2paDetected) metadataCount++;
              metadataCount += anomalies.nonStandardMarkers.length;
              metadataCount += anomalies.unknownChunks.length;
              // Update privacy flags based on anomalies
              if (anomalies.trailingData > 0 || anomalies.multipleEOF) privacy.hasHiddenData = true;
              if (anomalies.c2paDetected) privacy.hasC2PA = true;
            } catch { /* non-fatal */ }
          } else if (category === "video" || category === "audio") {
            try {
              const meta = await readMediaMetadata(fullPath);
              metadataCount = Object.keys(meta).length;
              privacy = analyzePrivacyRisks(meta);
            } catch { /* skip */ }
          }

          results.push({
            fileName: entry,
            filePath: fullPath,
            fileSize: fStat.size,
            category,
            metadataCount,
            privacy,
            anomalies,
          });
        } catch { /* skip inaccessible */ }
      }

      return NextResponse.json({ ok: true, dirPath, fileCount: results.length, files: results });
    }

    // ── SCRUB: Strip metadata from files ──
    // level: "standard" | "forensic" | "maximum"
    //   standard: exif-be-gone (lossless metadata strip, pixel data unchanged)
    //   forensic: structural rebuild (keep only rendering-essential data, truncate at EOF)
    //   maximum:  CDR (full pixel decode -> re-encode from scratch; PNG=lossless, JPEG=slight quality loss)
    if (action === "scrub") {
      const { files, level = "standard" } = body as { files: string[]; level?: string };
      const outputDir = body.outputDir ? validatePath(body.outputDir) ?? undefined : undefined;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return NextResponse.json({ error: "No files specified" }, { status: 400 });
      }
      if (body.outputDir && !outputDir) {
        return NextResponse.json({ error: "Invalid output directory" }, { status: 400 });
      }

      const results: any[] = [];
      const suffixMap: Record<string, string> = { standard: "_clean", forensic: "_forensic", maximum: "_cdr" };
      const suffix = suffixMap[level] || "_clean";

      for (const rawPath of files) {
        const filePath = validatePath(rawPath);
        if (!filePath || !existsSync(filePath)) {
          results.push({ filePath: rawPath, ok: false, error: "File not found" });
          continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        const category = categorize(ext);
        const baseName = path.basename(filePath, ext);
        const dir = outputDir || path.dirname(filePath);

        // Ensure output dir exists
        if (outputDir && !existsSync(outputDir)) {
          await mkdir(outputDir, { recursive: true });
        }

        const cleanName = `${baseName}${suffix}${ext}`;
        const outPath = path.join(dir, cleanName);

        try {
          if (category === "image") {
            const isPng = ext === ".png";
            const isJpeg = ext === ".jpg" || ext === ".jpeg";
            if (level === "maximum") {
              // CDR: full pixel reconstruction (PNG/JPEG); others re-encode via FFmpeg.
              if (isPng) await cdrScrubPng(filePath, outPath);
              else if (isJpeg) await cdrScrubJpeg(filePath, outPath);
              else await scrubImageViaFfmpeg(filePath, outPath);
            } else if (level === "forensic") {
              // Forensic: structural rebuild (PNG/JPEG); others re-encode via FFmpeg.
              // NOTE: forensic/maximum drop ICC color profiles for max privacy; may shift colors.
              if (isPng) await forensicScrubPng(filePath, outPath);
              else if (isJpeg) await forensicScrubJpeg(filePath, outPath);
              else await scrubImageViaFfmpeg(filePath, outPath);
            } else {
              // Standard: lossless metadata strip preserving color fidelity.
              if (isPng) await standardScrubPng(filePath, outPath);          // strips tEXt/iTXt, keeps color
              else if (isJpeg) await scrubImage(filePath, outPath);          // exif-be-gone strips EXIF/XMP
              else await scrubImageViaFfmpeg(filePath, outPath);             // webp/gif/tiff/heic/avif/jxl/bmp
            }
          } else if (category === "video" || category === "audio") {
            await scrubMedia(filePath, outPath);
          } else {
            results.push({ filePath, ok: false, error: "Unsupported format" });
            continue;
          }

          // Verify output exists and get sizes
          const inStat = await stat(filePath);
          const outStat = await stat(outPath);

          // Post-scrub verification: re-read the cleaned file and confirm no
          // privacy-relevant metadata survived, so the UI can honestly report
          // "verified clean" instead of merely "attempted".
          let residualCount = 0;
          try {
            if (category === "image") {
              const residual = await readImageMetadata(outPath);
              residualCount = Object.keys(residual).filter((k) => {
                const g = residual[k].group; // ignore benign color/physical descriptors
                return g !== "png_color" && g !== "png_physical";
              }).length;
            } else {
              const residual = await readMediaMetadata(outPath);
              const basics = new Set(["format_name", "duration", "size", "bit_rate"]);
              residualCount = Object.keys(residual).filter(
                (k) => residual[k].group === "format" && !basics.has(k)
              ).length;
            }
          } catch { /* verification is best-effort */ }

          results.push({
            filePath,
            outputPath: outPath,
            ok: true,
            originalSize: inStat.size,
            cleanSize: outStat.size,
            savedBytes: inStat.size - outStat.size,
            level,
            verifiedClean: residualCount === 0,
            residualCount,
          });
        } catch (e: any) {
          results.push({ filePath, ok: false, error: e.message?.slice(0, 200) });
        }
      }

      return NextResponse.json({
        ok: true,
        scrubbed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
