import { NextRequest } from "next/server";
import { getProgress, clearProgress } from "@/lib/timeline/export-progress";

// Server-Sent Events stream of timeline-export progress for a given jobId.
// The editor opens this right before POSTing /api/timeline-export and renders a
// live, accurate progress bar from the events. The POST render updates the
// shared in-memory store; this route just relays it.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId") || "";
  if (!jobId) return new Response("Missing jobId", { status: 400 });

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* stream already closed */ }
      };

      const stop = () => {
        if (timer) { clearInterval(timer); timer = null; }
        try { controller.close(); } catch { /* already closed */ }
        // Give the client a moment to read the terminal event, then drop state.
        setTimeout(() => clearProgress(jobId), 2000);
      };

      send("open", { jobId });

      let lastPercent = -1;
      let lastPhase = "";
      const tick = () => {
        const p = getProgress(jobId);
        if (!p) return;
        if (p.percent !== lastPercent || p.phase !== lastPhase) {
          lastPercent = p.percent;
          lastPhase = p.phase;
          send("progress", p);
        }
        if (p.phase === "done") { send("done", p); stop(); }
        else if (p.phase === "error") { send("failed", p); stop(); }
      };

      timer = setInterval(tick, 150);
      tick();

      // Client navigated away / closed the stream, stop polling.
      req.signal.addEventListener("abort", () => {
        if (timer) { clearInterval(timer); timer = null; }
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
