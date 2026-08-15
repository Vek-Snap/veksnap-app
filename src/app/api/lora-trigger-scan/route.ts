import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * POST /api/lora-trigger-scan
 *
 * Scans a directory of saved CivitAI HTML pages (SingleFile format),
 * extracts trigger words from each, matches them to existing LoRA files,
 * and returns the mapping. The frontend persists matches to the trigger registry.
 *
 * Body: { htmlDir: string, loraDir: string }
 * Returns: { results: { loraFile: string, modelName: string, triggers: string[], source: string }[], unmatched: { modelName: string, triggers: string[], source: string }[] }
 */

interface ScanResult {
  loraFile: string;       // matched LoRA filename (relative path within lora dir)
  modelName: string;      // name from CivitAI JSON-LD
  triggers: string[];     // extracted trigger words
  source: string;         // HTML filename it came from
}

interface UnmatchedResult {
  modelName: string;
  triggers: string[];
  source: string;
}

/** Extract model name from JSON-LD in CivitAI SingleFile HTML */
function extractModelName(html: string): string | null {
  const ldIdx = html.indexOf("application/ld+json");
  if (ldIdx < 0) return null;
  try {
    const start = html.indexOf("{", ldIdx);
    const end = html.indexOf("</script>", start);
    if (start < 0 || end < 0) return null;
    const obj = JSON.parse(html.substring(start, end));
    return obj.name || null;
  } catch {
    return null;
  }
}

/** Extract trigger words from CivitAI HTML (Mantine Badge pattern) */
function extractTriggerWords(html: string): string[] {
  // Look for "Trigger Words" section header, then grab badge labels
  const idx = html.indexOf("Trigger Words</p>");
  if (idx < 0) {
    // Also try other variants
    const idx2 = html.indexOf("Trigger Words</span>");
    if (idx2 < 0) return [];
    const section = html.substring(idx2, idx2 + 8000);
    return extractBadgesFromSection(section);
  }
  const section = html.substring(idx, idx + 8000);
  return extractBadgesFromSection(section);
}

function extractBadgesFromSection(section: string): string[] {
  // CivitAI renders trigger words as Mantine Badge components
  // Pattern: mantine-Badge-label > div/span > text content
  const re = /mantine-Badge-label[^>]*>(?:<[^>]*>)*([^<]+)/g;
  const words: string[] = [];
  let m;
  while ((m = re.exec(section)) !== null) {
    const word = m[1].trim();
    // Filter out copy icon SVG artifacts, empty strings, AutoV2 hashes, and CivitAI metadata
    if (
      word &&
      !word.startsWith("<") &&
      word.length > 1 &&
      !/^AutoV[0-9]/i.test(word) &&   // AutoV2, AutoV1 = hash metadata
      !/^[A-F0-9]{8,}$/i.test(word) && // hex hashes
      !/^v\d+\.\d+$/i.test(word)       // version tags like v1.0
    ) {
      words.push(word);
    }
  }
  return words;
}

/** Also try extracting from description text (sometimes trigger words are mentioned but not in badges) */
function extractFromDescription(html: string, modelName: string): string[] {
  // Fallback: look for patterns like "trigger word: XXX" or "use the word XXX" in description
  const ldIdx = html.indexOf("application/ld+json");
  if (ldIdx < 0) return [];
  try {
    const start = html.indexOf("{", ldIdx);
    const end = html.indexOf("</script>", start);
    const obj = JSON.parse(html.substring(start, end));
    const desc: string = obj.description || "";
    // Look for explicit trigger word mentions
    const patterns = [
      /trigger\s*(?:word|phrase)s?\s*(?:is|are|:)\s*["""]?([^"""\n<]+)/gi,
      /use\s+(?:the\s+)?(?:word|phrase|tag)s?\s*["""]([^"""]+)/gi,
      /activation\s*(?:word|tag)s?\s*(?:is|are|:)\s*["""]?([^"""\n<]+)/gi,
    ];
    const found: string[] = [];
    for (const p of patterns) {
      let match;
      while ((match = p.exec(desc)) !== null) {
        const words = match[1].split(/[,;]/).map((w) => w.trim()).filter(Boolean);
        found.push(...words);
      }
    }
    return found;
  } catch {
    return [];
  }
}

/** Fuzzy match: compute overlap score between model name and LoRA filename */
function matchScore(modelName: string, loraFile: string): number {
  // Normalize both to lowercase for comparison
  const mNorm = modelName.toLowerCase();
  const fNorm = loraFile.toLowerCase();

  // Strong match: model name contains a distinctive token that appears in filename
  const mTokens = mNorm.replace(/[^a-z0-9_]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  const fTokens = fNorm.replace(/[^a-z0-9_]/g, " ").split(/\s+/).filter((w) => w.length >= 3);

  // Skip common non-distinctive words
  const stopWords = new Set(["ltx", "lora", "nsfw", "wan", "v1", "v2", "v3", "v4", "video", "model", "the", "and", "for"]);

  let score = 0;
  for (const word of mTokens) {
    if (stopWords.has(word)) continue;
    // Check if this distinctive word appears in the filename
    if (fTokens.some((fw) => fw === word || (word.length >= 4 && (fw.includes(word) || word.includes(fw))))) {
      score += word.length >= 5 ? 2 : 1; // Longer distinctive words get extra weight
    }
  }

  // Bonus: check if model name substring directly appears in filename (handles things like "DR34ML4Y")
  const nameCore = mNorm.replace(/[^a-z0-9]/g, "");
  const fileCore = fNorm.replace(/[^a-z0-9]/g, "");
  if (nameCore.length >= 6 && fileCore.includes(nameCore.substring(0, Math.min(10, nameCore.length)))) {
    score += 5;
  }

  return score;
}

/** Recursively find all .safetensors files */
function findLoraFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...findLoraFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".safetensors")) {
      results.push(rel);
    }
  }
  return results;
}

export async function POST(req: Request) {
  try {
    const { htmlDir, loraDir } = await req.json();

    if (!htmlDir || !fs.existsSync(htmlDir)) {
      return NextResponse.json({ error: `HTML directory not found: ${htmlDir}` }, { status: 400 });
    }
    if (!loraDir || !fs.existsSync(loraDir)) {
      return NextResponse.json({ error: `LoRA directory not found: ${loraDir}` }, { status: 400 });
    }

    // Find all HTML files
    const htmlFiles = fs.readdirSync(htmlDir).filter((f) => f.endsWith(".html"));

    // Find all LoRA files
    const loraFiles = findLoraFiles(loraDir);

    const results: ScanResult[] = [];
    const unmatched: UnmatchedResult[] = [];

    for (const htmlFile of htmlFiles) {
      // Skip video showcase pages (these embed triggers from the model page but aren't model pages themselves)
      if (htmlFile.startsWith("Video posted by")) continue;

      const fullPath = path.join(htmlDir, htmlFile);
      const html = fs.readFileSync(fullPath, "utf8");

      const modelName = extractModelName(html) || htmlFile.split(" ｜")[0].split(" |")[0].trim();
      let triggers = extractTriggerWords(html);

      // Fallback to description parsing if no badges found
      if (triggers.length === 0) {
        triggers = extractFromDescription(html, modelName);
      }

      if (triggers.length === 0) continue; // No triggers found, skip

      // Find best matching LoRA file
      let bestMatch = "";
      let bestScore = 0;

      for (const lora of loraFiles) {
        const score = matchScore(modelName, lora);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = lora;
        }
      }

      if (bestScore >= 2) {
        // Good enough match (at least 2 score points from distinctive word overlap)
        results.push({
          loraFile: bestMatch,
          modelName,
          triggers,
          source: htmlFile,
        });
      } else {
        unmatched.push({ modelName, triggers, source: htmlFile });
      }
    }

    return NextResponse.json({ results, unmatched, totalHtml: htmlFiles.length, totalLoras: loraFiles.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
