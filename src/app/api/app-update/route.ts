/**
 * GET /api/app-update: Vek-Snap application update check (Phase 1).
 *
 * Two modes:
 *   • (default)      → returns { currentVersion } from the local package.json.
 *                      NO network egress. Used to display the version in About.
 *   • ?check=1       → the ONLY path that reaches the internet. Fetches the
 *                      public latest.json feed, compares SemVer, and reports
 *                      whether an update is available.
 *
 * Privacy/safety posture (must stay true):
 *   • User-initiated only (the About dialog's "Check for updates" button).
 *   • Gated on the offline-by-default "Network Access" setting, an air-gapped
 *     install never reaches out.
 *   • Fetch-only. Sends NO user content, prompts, telemetry, or identifiers,
 *     just a plain GET of a static JSON file.
 */
import { NextRequest, NextResponse } from "next/server";
import { readVekSnapSettings } from "@/lib/veksnap-settings";
import { getAppVersion, isNewerVersion, UPDATE_FEED_URL } from "@/lib/app-version";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const currentVersion = getAppVersion();
  const check = req.nextUrl.searchParams.get("check") === "1";

  // Local-only version info: no network.
  if (!check) {
    return NextResponse.json({ currentVersion, checked: false });
  }

  // Explicit online check. Respect the user's offline-by-default posture.
  const settings = readVekSnapSettings();
  if (!settings.allowOnline) {
    return NextResponse.json(
      {
        currentVersion,
        checked: false,
        offline: true,
        error:
          "Vek-Snap is in offline mode. Enable Network Access (Settings) to check for updates.",
      },
      { status: 403 }
    );
  }

  try {
    const resp = await fetch(UPDATE_FEED_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return NextResponse.json(
        { currentVersion, checked: false, error: `Update feed returned HTTP ${resp.status}.` },
        { status: 502 }
      );
    }
    const feed = await resp.json();
    const latestVersion = typeof feed?.version === "string" ? feed.version : null;
    const updateAvailable = !!latestVersion && isNewerVersion(latestVersion, currentVersion);
    const rawUrl = feed?.downloads?.installer?.url;
    const downloadUrl =
      typeof rawUrl === "string" && !rawUrl.startsWith("TBD-") ? rawUrl : null;

    return NextResponse.json({
      currentVersion,
      latestVersion,
      updateAvailable,
      checked: true,
      securityFix: !!feed?.securityFix,
      mandatory: !!feed?.mandatory,
      summary: typeof feed?.summary === "string" ? feed.summary : null,
      notesUrl: typeof feed?.notesUrl === "string" ? feed.notesUrl : null,
      downloadUrl,
    });
  } catch (e) {
    return NextResponse.json(
      {
        currentVersion,
        checked: false,
        error: `Could not reach the update feed: ${(e as Error).message}`,
      },
      { status: 502 }
    );
  }
}
