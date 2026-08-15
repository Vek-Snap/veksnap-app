/**
 * VLAP: Vek-Snap Local Access Protocol (v1).
 *
 * A bespoke request-authentication layer for the app's own local API surface
 * (the Next server on the fixed loopback port). It is NOT a new cipher, it is a
 * proprietary *framing* on top of proven primitives (HMAC-SHA256, per-launch
 * random secret, timestamp + single-use nonce). The point is defence-in-depth
 * for a predictable-port loopback server:
 *
 *   Layer 1  Host header must be loopback        -> defeats DNS rebinding
 *   Layer 2  Origin (on writes) must be loopback -> defeats classic CSRF
 *   Layer 3  per-launch secret + HMAC signature  -> defeats cross-process /
 *            rebinding bypasses (a web page can never learn the secret, which is
 *            delivered to the trusted renderer over Electron IPC, never HTTP)
 *
 * This module is deliberately isomorphic (Web Crypto only, no node:crypto) so
 * the exact same code verifies in `middleware.ts` and signs in the browser
 * fetch wrapper. Keep the two ends byte-identical.
 */

/** Protocol version tag: first line of every signed payload. */
export const VLAP_VERSION = "VLAP1";

/** Custom, non-standard header names, no generic web tool speaks these. */
export const VLAP = {
  epoch: "x-vek-epoch",
  seq: "x-vek-seq",
  ts: "x-vek-ts",
  nonce: "x-vek-nonce",
  sig: "x-vek-sig",
} as const;

/** HTTP methods that carry a side effect and therefore require a signature. */
export function isStateChangingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Extract the hostname from a raw `Host` header value and test it against the
 * loopback allowlist. Anchored exact match, NOT `startsWith("127.")`, which is
 * the classic bypass (e.g. `127.0.0.1.evil.com`).
 */
export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  let hostname: string;
  if (h.startsWith("[")) {
    // IPv6 literal, e.g. "[::1]" or "[::1]:41573"
    const end = h.indexOf("]");
    hostname = end > 0 ? h.slice(0, end + 1) : h;
  } else {
    const colon = h.lastIndexOf(":");
    hostname = colon > -1 ? h.slice(0, colon) : h;
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Test an `Origin` header value. An absent Origin returns `false` here; callers
 * decide whether "no Origin" (native/server-side clients) is acceptable.
 */
export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return LOOPBACK_HOSTNAMES.has(hostname) || LOOPBACK_HOSTNAMES.has(`[${hostname}]`);
  } catch {
    return false;
  }
}

export interface VlapClaims {
  epoch: string;
  seq: string;
  method: string;
  path: string;
  ts: string;
  nonce: string;
}

/**
 * The canonical string that gets signed. Newline-joined, no trailing newline.
 * Both the signer and the verifier MUST build it identically.
 */
export function buildCanonical(c: VlapClaims): string {
  return [
    VLAP_VERSION,
    c.epoch,
    c.seq,
    c.method.toUpperCase(),
    c.path,
    c.ts,
    c.nonce,
  ].join("\n");
}

const encoder = new TextEncoder();

/**
 * Encode to a fresh ArrayBuffer-backed Uint8Array. `TextEncoder.encode` is typed
 * `Uint8Array<ArrayBufferLike>` under the current TS lib, which the Web Crypto
 * `BufferSource` params reject; copying via `Uint8Array.from` pins it to a plain
 * ArrayBuffer.
 */
function enc(s: string): Uint8Array<ArrayBuffer> {
  const src = encoder.encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}

function subtleCrypto(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) throw new Error("Web Crypto unavailable");
  return c.subtle;
}

async function importKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return subtleCrypto().importKey(
    "raw",
    enc(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) return new Uint8Array(new ArrayBuffer(0));
  const out = new Uint8Array(new ArrayBuffer(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Sign a canonical message with the per-launch secret; returns lowercase hex. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await importKey(secret, "sign");
  const sig = await subtleCrypto().sign("HMAC", key, enc(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Constant-time verification via `SubtleCrypto.verify` (the comparison happens
 * inside the crypto engine). Returns false on any malformed input.
 */
export async function verifyHmac(secret: string, message: string, sigHex: string): Promise<boolean> {
  try {
    const sig = hexToBytes(sigHex);
    if (sig.length === 0) return false;
    const key = await importKey(secret, "verify");
    return await subtleCrypto().verify("HMAC", key, sig, enc(message));
  } catch {
    return false;
  }
}

/** Cryptographically-random per-request nonce (hex). */
export function newNonce(): string {
  const b = new Uint8Array(16);
  (globalThis as { crypto: Crypto }).crypto.getRandomValues(b);
  return bytesToHex(b);
}
