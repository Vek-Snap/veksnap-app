import { NextResponse } from "next/server";
import { readdirSync } from "fs";
import path from "path";

const BANNER_DIR = path.join(process.cwd(), "public", "banners");
const VALID_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]);

/**
 * GET /api/banner
 * Returns a random banner image path from public/banners/.
 * Response: { banner: "/banners/filename.png" } or { banner: null }
 */
export async function GET() {
  try {
    const files = readdirSync(BANNER_DIR).filter((f) =>
      VALID_EXT.has(path.extname(f).toLowerCase())
    );
    if (files.length === 0) {
      return NextResponse.json({ banner: null });
    }
    const pick = files[Math.floor(Math.random() * files.length)];
    return NextResponse.json({ banner: `/banners/${pick}` });
  } catch {
    return NextResponse.json({ banner: null });
  }
}
