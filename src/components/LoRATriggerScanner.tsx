"use client";

import { useEffect, useState } from "react";
import { Search, CheckCircle2, AlertCircle, Download, Globe, HardDrive, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { setTriggerForLora } from "@/lib/lora-trigger-registry";
import { useAllowOnline } from "@/hooks/useAllowOnline";
import OnlineRequiredNote from "@/components/OnlineRequiredNote";

interface ScanResult {
  loraFile: string;
  modelName: string;
  triggers: string[];
  source: string;
}

interface UnmatchedResult {
  modelName: string;
  triggers: string[];
  source: string;
}

interface ScanResponse {
  results: ScanResult[];
  unmatched: UnmatchedResult[];
  totalHtml: number;
  totalLoras: number;
  error?: string;
}

interface FetchResult {
  loraFile: string;
  hash: string;
  modelName: string;
  versionName: string;
  trainedWords: string[];
  url: string;
}

interface FetchResponse {
  results: FetchResult[];
  errors: { file: string; error: string }[];
  skipped: number;
  totalFiles: number;
  error?: string;
}

type ScanMode = "offline" | "live";

export default function LoRATriggerScanner() {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<ScanMode>("offline");
  // Prefilled at runtime from /api/model-dirs (no hardcoded drive letters / paths);
  // both remain user-editable. htmlDir has no universal default, so it starts empty.
  const [htmlDir, setHtmlDir] = useState("");
  const [loraDir, setLoraDir] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<ScanResponse | null>(null);
  const [fetchResults, setFetchResults] = useState<FetchResponse | null>(null);
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const { allowOnline } = useAllowOnline();
  const liveGated = mode === "live" && !allowOnline;

  // Prefill the LoRA directory from the app's resolved model paths. Users with a
  // custom loras folder (via extra_model_paths.yaml) get that; otherwise the
  // bundled ComfyUI models/loras. The HTML "usage notes" folder is user-specific,
  // so we default it to a sensible sibling of the loras dir when we learn it.
  useEffect(() => {
    let alive = true;
    fetch("/api/model-dirs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.lorasDir) return;
        setLoraDir((prev) => prev || d.lorasDir);
        setHtmlDir((prev) => prev || `${d.lorasDir}\\00_Usage Notes`);
      })
      .catch(() => { /* offline / unresolved → fields stay empty & editable */ });
    return () => { alive = false; };
  }, []);

  const runOfflineScan = async () => {
    setScanning(true);
    setError(null);
    setScanResults(null);
    setFetchResults(null);
    setImported(new Set());
    try {
      const res = await fetch("/api/lora-trigger-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ htmlDir, loraDir }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setScanResults(data);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const runLiveFetch = async () => {
    setScanning(true);
    setError(null);
    setScanResults(null);
    setFetchResults(null);
    setImported(new Set());
    try {
      const res = await fetch("/api/lora-trigger-fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loraDir }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setFetchResults(data);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setScanning(false);
    }
  };

  const importScanResult = (r: ScanResult) => {
    const primaryTrigger = r.triggers[0];
    setTriggerForLora(r.loraFile, primaryTrigger);
    const basename = r.loraFile.split(/[/\\]/).pop() ?? r.loraFile;
    setTriggerForLora(basename, primaryTrigger);
    setImported((prev) => new Set([...prev, r.loraFile]));
  };

  const importFetchResult = (r: FetchResult) => {
    const primaryTrigger = r.trainedWords[0];
    setTriggerForLora(r.loraFile, primaryTrigger);
    const basename = r.loraFile.split(/[/\\]/).pop() ?? r.loraFile;
    setTriggerForLora(basename, primaryTrigger);
    setImported((prev) => new Set([...prev, r.loraFile]));
  };

  const importAllScan = () => {
    if (!scanResults) return;
    for (const r of scanResults.results) importScanResult(r);
  };

  const importAllFetch = () => {
    if (!fetchResults) return;
    for (const r of fetchResults.results) importFetchResult(r);
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full rounded border border-dashed border-indigo-500/20 py-1.5 text-[10px] text-muted-foreground hover:text-indigo-300 hover:border-indigo-500/40 transition-colors"
      >
        <Search className="w-3 h-3 inline mr-1" />
        Scan for LoRA Trigger Words
      </button>
    );
  }

  return (
    <div className="rounded border border-indigo-500/20 bg-indigo-500/5 p-2 space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] text-indigo-400 font-medium">
          <Search className="w-3 h-3 inline mr-1" />
          LoRA Trigger Scanner
        </Label>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[9px] text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setMode("offline")}
          className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-[9px] border transition-colors ${
            mode === "offline"
              ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
              : "border-border/30 text-muted-foreground hover:text-foreground"
          }`}
        >
          <HardDrive className="w-3 h-3" /> Offline (HTML)
        </button>
        <button
          type="button"
          onClick={() => setMode("live")}
          className={`flex-1 flex items-center justify-center gap-1 py-1 rounded text-[9px] border transition-colors ${
            mode === "live"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : "border-border/30 text-muted-foreground hover:text-foreground"
          }`}
        >
          <Globe className="w-3 h-3" /> Live API {!allowOnline && <Lock className="w-2.5 h-2.5 opacity-70" />}
        </button>
      </div>

      {/* Offline mode inputs */}
      {mode === "offline" && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">HTML Dir</Label>
            <input
              type="text"
              value={htmlDir}
              onChange={(e) => setHtmlDir(e.target.value)}
              className="flex-1 h-5 rounded border border-input bg-background px-1.5 text-[9px] font-mono"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">LoRA Dir</Label>
            <input
              type="text"
              value={loraDir}
              onChange={(e) => setLoraDir(e.target.value)}
              className="flex-1 h-5 rounded border border-input bg-background px-1.5 text-[9px] font-mono"
            />
          </div>
        </div>
      )}

      {/* Live mode inputs */}
      {mode === "live" && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">LoRA Dir</Label>
            <input
              type="text"
              value={loraDir}
              onChange={(e) => setLoraDir(e.target.value)}
              className="flex-1 h-5 rounded border border-input bg-background px-1.5 text-[9px] font-mono"
            />
          </div>
          {allowOnline ? (
            <p className="text-[8px] text-emerald-400/70 italic pl-[4.25rem]">
              Hashes each LoRA file and queries the CivitAI API for trigger words.
            </p>
          ) : (
            <OnlineRequiredNote feature="Fetching trigger words from CivitAI" />
          )}
        </div>
      )}

      <Button
        size="sm"
        onClick={mode === "offline" ? runOfflineScan : runLiveFetch}
        disabled={scanning || liveGated}
        className="w-full h-7 text-[10px] gap-1"
      >
        {scanning
          ? mode === "live" ? "Hashing & Fetching..." : "Scanning..."
          : mode === "live" ? (liveGated ? "Online required" : "Fetch from CivitAI") : "Scan HTML Pages"}
      </Button>

      {error && (
        <p className="text-[9px] text-red-400 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </p>
      )}

      {/* Offline scan results */}
      {scanResults && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-muted-foreground">
              Found {scanResults.results.length} matches from {scanResults.totalHtml} pages → {scanResults.totalLoras} LoRAs
            </p>
            {scanResults.results.length > 0 && (
              <Button size="sm" variant="outline" onClick={importAllScan} className="h-5 text-[8px] gap-1 px-1.5">
                <Download className="w-2.5 h-2.5" /> Import All
              </Button>
            )}
          </div>
          <ResultsList
            results={scanResults.results.map((r) => ({ loraFile: r.loraFile, modelName: r.modelName, triggers: r.triggers }))}
            imported={imported}
            onImport={(r) => importScanResult(scanResults.results.find((sr) => sr.loraFile === r.loraFile)!)}
          />
          {scanResults.unmatched.length > 0 && (
            <details className="text-[9px]">
              <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
                {scanResults.unmatched.length} unmatched (triggers found, no LoRA file matched)
              </summary>
              <div className="mt-1 space-y-0.5 pl-2 border-l border-border/30">
                {scanResults.unmatched.map((u, i) => (
                  <div key={i} className="text-muted-foreground">
                    <span className="font-medium">{u.modelName}</span>: {u.triggers.join(", ")}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Live fetch results */}
      {fetchResults && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-muted-foreground">
              Found {fetchResults.results.length} with triggers / {fetchResults.totalFiles} files ({fetchResults.skipped} no triggers)
            </p>
            {fetchResults.results.length > 0 && (
              <Button size="sm" variant="outline" onClick={importAllFetch} className="h-5 text-[8px] gap-1 px-1.5">
                <Download className="w-2.5 h-2.5" /> Import All
              </Button>
            )}
          </div>
          <ResultsList
            results={fetchResults.results.map((r) => ({ loraFile: r.loraFile, modelName: `${r.modelName} (${r.versionName})`, triggers: r.trainedWords }))}
            imported={imported}
            onImport={(r) => importFetchResult(fetchResults.results.find((fr) => fr.loraFile === r.loraFile)!)}
          />
          {fetchResults.errors.length > 0 && (
            <details className="text-[9px]">
              <summary className="text-red-400/70 cursor-pointer hover:text-red-300">
                {fetchResults.errors.length} errors
              </summary>
              <div className="mt-1 space-y-0.5 pl-2 border-l border-red-500/30">
                {fetchResults.errors.map((e, i) => (
                  <div key={i} className="text-muted-foreground">
                    <span className="font-medium">{e.file}</span>: {e.error}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <p className="text-[8px] text-muted-foreground/60 italic">
        {mode === "offline"
          ? "Scans saved CivitAI SingleFile HTML pages, extracts trigger words, and matches them to your LoRA files."
          : "Computes SHA256 hash of each LoRA and queries CivitAI API for trigger words. Large files may take time to hash."}
        {" "}Imported triggers are saved to your global registry permanently.
      </p>
    </div>
  );
}

/** Shared results list component */
function ResultsList({
  results,
  imported,
  onImport,
}: {
  results: { loraFile: string; modelName: string; triggers: string[] }[];
  imported: Set<string>;
  onImport: (r: { loraFile: string; modelName: string; triggers: string[] }) => void;
}) {
  return (
    <div className="max-h-[200px] overflow-y-auto space-y-1">
      {results.map((r, i) => (
        <div
          key={i}
          className={`flex items-start gap-1.5 rounded border p-1.5 text-[9px] ${
            imported.has(r.loraFile)
              ? "border-green-500/30 bg-green-500/5"
              : "border-border/30 bg-background"
          }`}
        >
          <div className="flex-1 min-w-0">
            <p className="font-medium text-foreground truncate">{r.loraFile}</p>
            <p className="text-muted-foreground truncate">← {r.modelName}</p>
            <div className="flex flex-wrap gap-0.5 mt-0.5">
              {r.triggers.map((t, j) => (
                <span key={j} className="px-1 py-0 rounded bg-purple-500/15 text-purple-300 text-[8px]">
                  {t}
                </span>
              ))}
            </div>
          </div>
          {imported.has(r.loraFile) ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0 mt-0.5" />
          ) : (
            <button
              type="button"
              onClick={() => onImport(r)}
              className="text-[8px] px-1.5 py-0.5 rounded border border-indigo-500/30 text-indigo-300 hover:bg-indigo-500/10 flex-shrink-0"
            >
              Import
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
