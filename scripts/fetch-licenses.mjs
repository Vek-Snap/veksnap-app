#!/usr/bin/env node
// Fetch the canonical, verbatim full texts of the open-source licenses that
// Vek-Snap must ship (GPL-3.0, GPL-2.0, Apache-2.0). Downloading guarantees
// byte-exact text, a legal requirement, instead of risking hand-transcription
// errors.
//
// Usage:  node scripts/fetch-licenses.mjs
// Output: licenses/GPL-3.0.txt, licenses/GPL-2.0.txt, licenses/Apache-2.0.txt

import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LICENSES_DIR = path.join(__dirname, "..", "licenses");

const SOURCES = [
  { file: "GPL-3.0.txt", url: "https://www.gnu.org/licenses/gpl-3.0.txt" },
  // GPL-2.0 covers the bundled Git for Windows (MinGit), which is GPLv2-only.
  { file: "GPL-2.0.txt", url: "https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt" },
  { file: "Apache-2.0.txt", url: "https://www.apache.org/licenses/LICENSE-2.0.txt" },
];

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "VekSnap-LicenseFetcher" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(LICENSES_DIR, { recursive: true });
  for (const { file, url } of SOURCES) {
    process.stdout.write(`Fetching ${file} <- ${url} ... `);
    const text = await get(url);
    if (!text || text.length < 1000) throw new Error(`Suspiciously short content for ${file}`);
    fs.writeFileSync(path.join(LICENSES_DIR, file), text, "utf8");
    console.log(`ok (${text.length} bytes)`);
  }
  console.log("Done. License texts written to licenses/.");
}

main().catch((err) => {
  console.error("License fetch failed:", err.message);
  process.exit(1);
});
