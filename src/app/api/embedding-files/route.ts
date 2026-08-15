import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const COMFYUI_ROOT = path.join(process.cwd(), "..", "ComfyUI");
const EMBEDDINGS_DIR = path.join(COMFYUI_ROOT, "models", "embeddings");

const EMBEDDING_EXTENSIONS = new Set([".safetensors", ".pt", ".bin"]);

function scanEmbeddings(dir: string, base: string = ""): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...scanEmbeddings(path.join(dir, entry.name), relPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (EMBEDDING_EXTENSIONS.has(ext)) {
          // Return filename without extension: ComfyUI references embeddings by stem only
          const stem = entry.name.slice(0, -ext.length);
          const fullStem = base ? `${base}/${stem}` : stem;
          results.push(fullStem.replace(/\//g, "\\"));
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }
  return results;
}

export async function GET() {
  const all = scanEmbeddings(EMBEDDINGS_DIR);

  // Deduplicate and sort
  const unique = [...new Set(all)].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  return NextResponse.json(unique);
}
