import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import type { LibraryCategory } from "@/lib/library-categories-types";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// App-global store for user-created Library categories (name + colour).
//
// Persisted to `library-categories.json` next to veksnap-settings.json (the Next
// server's cwd is the app dir). Fully offline. A model joins a category by
// writing that category's name into its `<model>.model-meta.json` sidecar via
// the model-meta route: this store only owns the taxonomy + colours.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_PATH = path.resolve(process.cwd(), "library-categories.json");
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_CATEGORIES = 100;
const MAX_NAME_LEN = 40;

function readStore(): LibraryCategory[] {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c): c is LibraryCategory =>
        !!c && typeof c === "object" &&
        typeof (c as LibraryCategory).name === "string" &&
        typeof (c as LibraryCategory).color === "string")
      .map((c) => ({ name: c.name.trim().slice(0, MAX_NAME_LEN), color: c.color }))
      .filter((c) => c.name && HEX_RE.test(c.color));
  } catch {
    return [];
  }
}

function writeStore(cats: LibraryCategory[]): boolean {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(cats, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, categories: readStore() });
}

export async function POST(req: NextRequest) {
  let body: { action?: string; name?: string; color?: string; rename?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const action = body.action;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_LEN) : "";
  const cats = readStore();

  if (action === "upsert") {
    if (!name) return NextResponse.json({ ok: false, error: "A category name is required." }, { status: 400 });
    const color = typeof body.color === "string" && HEX_RE.test(body.color) ? body.color : "";
    if (!color) return NextResponse.json({ ok: false, error: "A valid #RRGGBB colour is required." }, { status: 400 });
    const idx = cats.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) {
      cats[idx] = { name, color };
    } else {
      if (cats.length >= MAX_CATEGORIES) {
        return NextResponse.json({ ok: false, error: `Category limit (${MAX_CATEGORIES}) reached.` }, { status: 400 });
      }
      cats.push({ name, color });
    }
  } else if (action === "delete") {
    if (!name) return NextResponse.json({ ok: false, error: "A category name is required." }, { status: 400 });
    const next = cats.filter((c) => c.name.toLowerCase() !== name.toLowerCase());
    if (next.length === cats.length) {
      return NextResponse.json({ ok: false, error: "Category not found." }, { status: 404 });
    }
    cats.length = 0;
    cats.push(...next);
  } else {
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  }

  if (!writeStore(cats)) {
    return NextResponse.json({ ok: false, error: "Failed to write category store." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, categories: cats });
}
