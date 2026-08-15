"use client";

// Reusable "this feature needs the internet" helper tip. Vek-Snap is offline-first,
// so any feature that reaches out (CivitAI lookups, etc.) is gated behind the
// user's explicit "Allow Online" setting. Render this where the gate is closed.

import { Lock } from "lucide-react";

export default function OnlineRequiredNote({
  feature = "This feature",
  className = "",
}: {
  feature?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[9px] leading-snug text-amber-300/90 flex items-start gap-1.5 ${className}`}
    >
      <Lock className="w-3 h-3 mt-0.5 shrink-0" />
      <span>
        {feature} needs an internet connection. Enable <strong>Allow Online</strong> in
        the Settings menu (top-right) to use it: Vek-Snap stays fully offline until you do.
      </span>
    </div>
  );
}
