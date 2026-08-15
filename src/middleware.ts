import { NextRequest, NextResponse } from "next/server";
import {
  VLAP,
  isLoopbackHost,
  isLoopbackOrigin,
  isStateChangingMethod,
  buildCanonical,
  verifyHmac,
} from "@/lib/vlap";

/**
 * Local-API access guard for the Vek-Snap Next server (fixed loopback port).
 *
 * The server binds 127.0.0.1 only, but a fixed/predictable loopback port is
 * still reachable from any web page the user visits (cross-origin CSRF writes
 * execute even though the response is unreadable) and via DNS rebinding. This
 * middleware layers three defences on every /api request:
 *
 *   1. Host allowlist: the Host header must be loopback (anchored exact
 *      match). A DNS-rebound `evil.com` still stamps Host: evil.com -> 403. This
 *      protects reads AND writes.
 *   2. Origin allowlist: on state-changing methods, a present Origin must
 *      be loopback -> blocks classic cross-site CSRF.
 *   3. VLAP signature: on state-changing methods, when the Electron shell
 *      has provisioned a per-launch secret (packaged app), require a valid
 *      Vek-Snap Local Access Protocol signature. The secret reaches only the
 *      trusted renderer (over Electron IPC, never HTTP), so no external page can
 *      forge it even if 1-2 were bypassed. In dev (no secret) 1-2 are the guard.
 *
 * The ComfyUI "Open in ComfyUI" bridge is the one intentional cross-origin
 * loopback relay (ComfyUI's own front-end GETs/POSTs it from a different loopback
 * port and cannot speak VLAP); it is exempted from 2-3 after the Host check and
 * enforces its own loopback-origin CORS.
 */

export const config = {
  matcher: "/api/:path*",
};

/** Intentional cross-origin loopback relay, see route file. */
const BRIDGE_PATH = "/api/veksnap-bridge/open-workflow";

/** Signature freshness window. */
const SKEW_MS = 5 * 60 * 1000;

/** Single-use nonce cache (per server process; the server is a single local process). */
const NONCE_CAP = 100_000;
const seenNonces = new Map<string, number>();

function rememberNonce(nonce: string, now: number): void {
  seenNonces.set(nonce, now);
  if (seenNonces.size > NONCE_CAP) {
    // Drop anything already outside the skew window, then, if still over, the oldest.
    for (const [k, v] of seenNonces) {
      if (now - v > SKEW_MS) seenNonces.delete(k);
      if (seenNonces.size <= NONCE_CAP) break;
    }
    if (seenNonces.size > NONCE_CAP) {
      const oldest = seenNonces.keys().next().value;
      if (oldest !== undefined) seenNonces.delete(oldest);
    }
  }
}

function forbid(reason: string): NextResponse {
  return new NextResponse(`Forbidden: ${reason}`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // 1) Host allowlist: kills DNS rebinding for reads and writes.
  if (!isLoopbackHost(req.headers.get("host"))) {
    return forbid("host");
  }

  // Bridge relay: allowed after the Host check; it manages its own CORS.
  if (pathname === BRIDGE_PATH) {
    return NextResponse.next();
  }

  // Safe methods: the Host check above already blocks rebinding reads.
  if (!isStateChangingMethod(req.method)) {
    return NextResponse.next();
  }

  // 2) Origin allowlist for browser-shaped writes, kills classic CSRF.
  const origin = req.headers.get("origin");
  if (origin && !isLoopbackOrigin(origin)) {
    return forbid("origin");
  }

  // 3) VLAP: only enforced when the shell provisioned a per-launch secret.
  const secret = process.env.VEKSNAP_API_SECRET;
  const epoch = process.env.VEKSNAP_API_EPOCH;
  if (!secret || !epoch) {
    // Dev / non-packaged run: Host + Origin are the guard.
    return NextResponse.next();
  }

  const hEpoch = req.headers.get(VLAP.epoch);
  const hSeq = req.headers.get(VLAP.seq);
  const hTs = req.headers.get(VLAP.ts);
  const hNonce = req.headers.get(VLAP.nonce);
  const hSig = req.headers.get(VLAP.sig);
  if (!hEpoch || !hSeq || !hTs || !hNonce || !hSig) {
    return forbid("vlap-missing");
  }

  // Bind to THIS launch: a signature minted for a previous run is worthless.
  if (hEpoch !== epoch) {
    return forbid("vlap-epoch");
  }

  const tsNum = Number(hTs);
  const now = Date.now();
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > SKEW_MS) {
    return forbid("vlap-skew");
  }

  // Replay: reject a nonce we have already accepted within the window.
  if (seenNonces.has(hNonce)) {
    return forbid("vlap-replay");
  }

  const message = buildCanonical({
    epoch: hEpoch,
    seq: hSeq,
    method: req.method,
    path: pathname,
    ts: hTs,
    nonce: hNonce,
  });

  const ok = await verifyHmac(secret, message, hSig);
  if (!ok) {
    return forbid("vlap-sig");
  }

  rememberNonce(hNonce, now);
  return NextResponse.next();
}
