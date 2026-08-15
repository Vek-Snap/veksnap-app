import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { readVekSnapSettings } from "@/lib/veksnap-settings";

/**
 * POST /api/lora-trigger-fetch
 *
 * Live CivitAI API lookup: computes SHA256 hash of a LoRA file,
 * queries CivitAI's public API, and returns the trained trigger words.
 *
 * Requires: allowOnline=true in Vek-Snap settings.
 *
 * Body: { loraPath: string }  (absolute path to .safetensors file)
 *   OR: { loraDir: string }   (scan entire directory recursively)
 *
 * Returns:
 *   Single: { loraFile, hash, modelName, trainedWords, url }
 *   Batch:  { results: [...], errors: [...], skipped: number }
 */

interface FetchResult {
  loraFile: string;
  hash: string;
  modelName: string;
  versionName: string;
  trainedWords: string[];
  url: string;
}

/** Compute SHA256 hash of a file using streaming (handles large files) */
async function computeSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

/** Query CivitAI API by hash */
async function queryCivitAI(hash: string): Promise<{
  modelName?: string;
  versionName?: string;
  trainedWords?: string[];
  modelUrl?: string;
} | null> {
  try {
    const url = `https://civitai.com/api/v1/model-versions/by-hash/${hash}`;
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000), // 15s timeout
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      modelName: data.model?.name || data.modelName || "Unknown",
      versionName: data.name || "",
      trainedWords: data.trainedWords || [],
      modelUrl: data.model?.name
        ? `https://civitai.com/models/${data.modelId}`
        : undefined,
    };
  } catch {
    return null;
  }
}

/** Recursively find all .safetensors files */
function findLoraFiles(dir: string, prefix = ""): { rel: string; abs: string }[] {
  const results: { rel: string; abs: string }[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the usage notes directory
      if (entry.name.startsWith("00_")) continue;
      results.push(...findLoraFiles(abs, rel));
    } else if (entry.name.endsWith(".safetensors")) {
      results.push({ rel, abs });
    }
  }
  return results;
}

export async function POST(req: Request) {
  // Check online permission
  const settings = readVekSnapSettings();
  if (!settings.allowOnline) {
    return NextResponse.json(
      { error: "Online access is disabled. Enable 'Allow Online' in Vek-Snap settings to use CivitAI API lookups." },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();

    // Single file mode
    if (body.loraPath) {
      const filePath = body.loraPath;
      if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: `File not found: ${filePath}` }, { status: 400 });
      }

      const hash = await computeSHA256(filePath);
      const result = await queryCivitAI(hash);

      if (!result || !result.trainedWords?.length) {
        return NextResponse.json({
          loraFile: path.basename(filePath),
          hash,
          modelName: result?.modelName || null,
          trainedWords: [],
          message: result ? "Model found but no trigger words defined" : "Model not found on CivitAI",
        });
      }

      return NextResponse.json({
        loraFile: path.basename(filePath),
        hash,
        modelName: result.modelName,
        versionName: result.versionName,
        trainedWords: result.trainedWords,
        url: result.modelUrl,
      });
    }

    // Batch mode: scan entire directory
    if (body.loraDir) {
      const loraDir = body.loraDir;
      if (!fs.existsSync(loraDir)) {
        return NextResponse.json({ error: `Directory not found: ${loraDir}` }, { status: 400 });
      }

      const files = findLoraFiles(loraDir);
      const results: FetchResult[] = [];
      const errors: { file: string; error: string }[] = [];
      let skipped = 0;

      // Process sequentially to be nice to CivitAI's API (no flooding)
      for (const file of files) {
        try {
          const hash = await computeSHA256(file.abs);
          const result = await queryCivitAI(hash);

          if (result && result.trainedWords && result.trainedWords.length > 0) {
            results.push({
              loraFile: file.rel,
              hash,
              modelName: result.modelName || "Unknown",
              versionName: result.versionName || "",
              trainedWords: result.trainedWords,
              url: result.modelUrl || "",
            });
          } else {
            skipped++;
          }

          // Rate limit: 200ms between requests
          await new Promise((r) => setTimeout(r, 200));
        } catch (e: unknown) {
          errors.push({ file: file.rel, error: e instanceof Error ? e.message : String(e) });
        }
      }

      return NextResponse.json({
        results,
        errors,
        skipped,
        totalFiles: files.length,
      });
    }

    return NextResponse.json({ error: "Provide either 'loraPath' (single file) or 'loraDir' (batch scan)" }, { status: 400 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
