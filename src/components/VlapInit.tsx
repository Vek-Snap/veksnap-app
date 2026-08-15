"use client";

import { installVlapFetch } from "@/lib/vlap-client";

// Install the VLAP fetch wrapper as early as possible on the client. Running it
// at module-eval time (not inside an effect) means the patched `window.fetch` is
// in place before any child component fires its first request.
if (typeof window !== "undefined") {
  installVlapFetch();
}

export default function VlapInit(): null {
  return null;
}
