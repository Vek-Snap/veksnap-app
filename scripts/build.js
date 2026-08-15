#!/usr/bin/env node
/**
 * Production build wrapper.
 * Sets NODE_OPTIONS to load the readlink fix before spawning `next build`,
 * ensuring all webpack worker processes inherit the patch.
 *
 * Node 24 on Windows returns EISDIR instead of EINVAL when readlinkSync
 * is called on a regular file. Webpack doesn't handle EISDIR, so we shim it.
 */
const { execSync } = require("child_process");
const path = require("path");

const fixPath = path.resolve(__dirname, "fix-readlink.js").replace(/\\/g, "/");
const existing = process.env.NODE_OPTIONS || "";
process.env.NODE_OPTIONS = `--require "${fixPath}" ${existing}`.trim();
process.env.NEXT_TELEMETRY_DISABLED = "1";

try {
  const nextBin = path.resolve(__dirname, "..", "node_modules", ".bin", "next.cmd");
  execSync(`"${nextBin}" build --webpack`, {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    windowsHide: true,
  });
} catch (e) {
  process.exit(e.status || 1);
}
