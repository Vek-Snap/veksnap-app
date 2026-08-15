/**
 * VLAP client: transparently signs the app's own state-changing /api calls.
 *
 * Installed once at renderer bootstrap, it monkey-patches `window.fetch` so the
 * ~100 existing call sites need no changes. Only same-origin, state-changing
 * `/api/*` requests are signed; safe GETs, cross-origin requests, and the
 * ComfyUI bridge are passed straight through (the server guards those by Host/
 * Origin instead).
 *
 * The per-launch secret is fetched once from the Electron main process over IPC
 * (`electronAPI.getApiCredential`) and cached. Outside Electron (browser dev),
 * no credential is available and requests go unsigned, the server falls back to
 * its Host + Origin guard in that mode.
 */
import { VLAP, buildCanonical, hmacHex, newNonce } from "@/lib/vlap";

interface VlapCredential {
  secret: string;
  epoch: string;
}

interface ElectronApiBridge {
  getApiCredential?: () => Promise<VlapCredential | null>;
}

let installed = false;
let seq = 0;
let credentialPromise: Promise<VlapCredential | null> | null = null;

function getCredential(): Promise<VlapCredential | null> {
  if (!credentialPromise) {
    const api = (window as unknown as { electronAPI?: ElectronApiBridge }).electronAPI;
    credentialPromise = api?.getApiCredential
      ? api.getApiCredential().catch(() => null)
      : Promise.resolve(null);
  }
  return credentialPromise;
}

const BRIDGE_PATH = "/api/veksnap-bridge/open-workflow";

function shouldSign(url: URL, method: string): boolean {
  if (url.origin !== window.location.origin) return false;
  if (!url.pathname.startsWith("/api/")) return false;
  if (url.pathname === BRIDGE_PATH) return false;
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

function resolveUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin);
    if (input instanceof URL) return input;
    if (input instanceof Request) return new URL(input.url, window.location.origin);
  } catch {
    return null;
  }
  return null;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (input instanceof Request && input.method) return input.method;
  return "GET";
}

export function installVlapFetch(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = resolveUrl(input);
    const method = methodOf(input, init);

    if (!url || !shouldSign(url, method)) {
      return originalFetch(input, init);
    }

    const cred = await getCredential();
    if (!cred) {
      // No credential (dev/browser): let the server's Host+Origin guard decide.
      return originalFetch(input, init);
    }

    const ts = Date.now().toString();
    const nonce = newNonce();
    const thisSeq = (++seq).toString();
    const signature = await hmacHex(
      cred.secret,
      buildCanonical({
        epoch: cred.epoch,
        seq: thisSeq,
        method,
        path: url.pathname,
        ts,
        nonce,
      })
    );

    // Merge headers without dropping caller-supplied ones. When `input` is a
    // Request, its headers ride along automatically; we only need to inject ours
    // via `init`, so build a fresh Headers seeded from whichever the caller set.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    headers.set(VLAP.epoch, cred.epoch);
    headers.set(VLAP.seq, thisSeq);
    headers.set(VLAP.ts, ts);
    headers.set(VLAP.nonce, nonce);
    headers.set(VLAP.sig, signature);

    return originalFetch(input, { ...init, headers });
  };
}
