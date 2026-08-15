import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

// Bake the app version at BUILD time so the running server never depends on
// process.cwd() to locate package.json. During `next build`/`next dev` the
// working directory is always this app root (see launcher.mjs, engine.js),
// so reading package.json here is reliable; the value is then exposed to the
// server-only version resolver via VEKSNAP_APP_VERSION.
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const nextConfig: NextConfig = {
  env: {
    VEKSNAP_APP_VERSION: APP_VERSION,
    // Client-readable copy for UI surfaces such as the About dialog.
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  devIndicators: false,
  images: {
    remotePatterns: [
      // ComfyUI's fixed loopback port (COMFYUI_PORT in src/lib/comfyui-config.ts). Keep in sync.
      { protocol: "http", hostname: "127.0.0.1", port: "41931" },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "500mb",
    },
  },
  // Keep compiled pages/routes in memory longer to prevent re-compilation loops
  onDemandEntries: {
    maxInactiveAge: 1000 * 60 * 60,   // 1 hour before eviction
    pagesBufferLength: 100,            // keep many routes in memory
  },
  // Allow Turbopack builds to proceed even though we have a webpack config
  turbopack: {},
  // Reduce file-watcher sensitivity in dev mode
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        aggregateTimeout: 1000,   // wait 1s after changes before recompiling
        poll: false,              // don't use polling (reduces CPU)
        ignored: ["**/node_modules/**", "**/.next/**", "**/scripts/seed-vc/**"],
      };
    }
    return config;
  },
};

export default nextConfig;
