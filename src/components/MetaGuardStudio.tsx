"use client";

import React, { useState, useCallback, useRef } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Search,
  FolderOpen,
  Trash2,
  FileWarning,
  MapPin,
  Smartphone,
  User,
  Code,
  Clock,
  ImageIcon,
  Film,
  Music,
  FileText,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Info,
  Eye,
  Eraser,
  HardDrive,
} from "lucide-react";

// ── Types ──

interface PrivacyFlags {
  hasGPS: boolean;
  hasDevice: boolean;
  hasAuthor: boolean;
  hasSoftware: boolean;
  hasTimestamp: boolean;
  hasThumbnail: boolean;
}

interface MetaEntry {
  value: string;
  group: string;
}

interface ReadResult {
  ok: boolean;
  fileName: string;
  filePath: string;
  fileSize: number;
  category: string;
  metadataCount: number;
  metadata: Record<string, MetaEntry>;
  privacy: PrivacyFlags;
}

interface ForensicAnomalies {
  trailingData: number;
  unknownChunks: string[];
  nonStandardMarkers: string[];
  c2paDetected: boolean;
  paddingBytes: number;
  multipleEOF: boolean;
}

interface ScanFile {
  fileName: string;
  filePath: string;
  fileSize: number;
  category: string;
  metadataCount: number;
  privacy: PrivacyFlags;
  anomalies?: ForensicAnomalies;
}

interface ScanResult {
  ok: boolean;
  dirPath: string;
  fileCount: number;
  files: ScanFile[];
}

interface ScrubFileResult {
  filePath: string;
  outputPath?: string;
  ok: boolean;
  error?: string;
  originalSize?: number;
  cleanSize?: number;
  savedBytes?: number;
}

type Tab = "inspect" | "scan" | "scrub";

// ── Helpers ──

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function riskLevel(p: PrivacyFlags): "clean" | "low" | "medium" | "high" {
  const risks = [p.hasGPS, p.hasDevice, p.hasAuthor, p.hasSoftware, p.hasTimestamp, p.hasThumbnail];
  const count = risks.filter(Boolean).length;
  if (count === 0) return "clean";
  if (p.hasGPS) return "high";
  if (count >= 3) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function riskColor(level: string) {
  switch (level) {
    case "clean": return "text-emerald-400";
    case "low": return "text-amber-400";
    case "medium": return "text-orange-400";
    case "high": return "text-red-400";
    default: return "text-muted-foreground";
  }
}

function riskBg(level: string) {
  switch (level) {
    case "clean": return "bg-emerald-500/10 border-emerald-500/30";
    case "low": return "bg-amber-500/10 border-amber-500/30";
    case "medium": return "bg-orange-500/10 border-orange-500/30";
    case "high": return "bg-red-500/10 border-red-500/30";
    default: return "bg-muted/10 border-border";
  }
}

function categoryIcon(cat: string) {
  switch (cat) {
    case "image": return <ImageIcon className="w-3.5 h-3.5" />;
    case "video": return <Film className="w-3.5 h-3.5" />;
    case "audio": return <Music className="w-3.5 h-3.5" />;
    case "pdf": return <FileText className="w-3.5 h-3.5" />;
    default: return <FileWarning className="w-3.5 h-3.5" />;
  }
}

// ── Component ──

export default function MetaGuardStudio() {
  const [activeTab, setActiveTab] = useState<Tab>("inspect");

  // Inspect state
  const [inspectPath, setInspectPath] = useState("");
  const [inspectResult, setInspectResult] = useState<ReadResult | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Scan state
  const [scanPath, setScanPath] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [selectedScanFiles, setSelectedScanFiles] = useState<Set<string>>(new Set());
  const [expandedScanFile, setExpandedScanFile] = useState<string | null>(null);
  const [expandedScanMeta, setExpandedScanMeta] = useState<Record<string, MetaEntry> | null>(null);
  const [expandedScanLoading, setExpandedScanLoading] = useState(false);

  // Scrub state
  const [scrubFiles, setScrubFiles] = useState<string[]>([]);
  const [scrubOutputDir, setScrubOutputDir] = useState("");
  const [scrubLevel, setScrubLevel] = useState<"standard" | "forensic" | "maximum">("forensic");
  const [scrubResults, setScrubResults] = useState<ScrubFileResult[]>([]);
  const [scrubLoading, setScrubLoading] = useState(false);
  const [scrubError, setScrubError] = useState("");
  const scrubInputRef = useRef<HTMLTextAreaElement>(null);

  // ── Inspect ──
  const handleInspect = useCallback(async () => {
    if (!inspectPath.trim()) return;
    setInspectLoading(true);
    setInspectError("");
    setInspectResult(null);
    setExpandedGroups(new Set());

    try {
      const res = await fetch("/api/meta-guard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", filePath: inspectPath.trim() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setInspectResult(data);
      // Auto-expand all groups
      const groups = new Set<string>();
      for (const entry of Object.values(data.metadata as Record<string, MetaEntry>)) {
        groups.add(entry.group);
      }
      setExpandedGroups(groups);
    } catch (e: any) {
      setInspectError(e.message);
    } finally {
      setInspectLoading(false);
    }
  }, [inspectPath]);

  // ── Scan ──
  const handleScan = useCallback(async () => {
    if (!scanPath.trim()) return;
    setScanLoading(true);
    setScanError("");
    setScanResult(null);
    setSelectedScanFiles(new Set());

    try {
      const res = await fetch("/api/meta-guard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan", dirPath: scanPath.trim() }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setScanResult(data);
    } catch (e: any) {
      setScanError(e.message);
    } finally {
      setScanLoading(false);
    }
  }, [scanPath]);

  // ── Scrub ──
  const handleScrub = useCallback(async (filesToScrub?: string[]) => {
    const files = filesToScrub || scrubFiles;
    if (files.length === 0) return;
    setScrubLoading(true);
    setScrubError("");
    setScrubResults([]);

    try {
      const res = await fetch("/api/meta-guard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "scrub",
          files,
          outputDir: scrubOutputDir.trim() || undefined,
          level: scrubLevel,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setScrubResults(data.results);
    } catch (e: any) {
      setScrubError(e.message);
    } finally {
      setScrubLoading(false);
    }
  }, [scrubFiles, scrubOutputDir, scrubLevel]);

  // ── Scrub from scan selection ──
  const handleScrubSelected = useCallback(() => {
    const files = Array.from(selectedScanFiles);
    if (files.length === 0) return;
    setScrubFiles(files);
    setActiveTab("scrub");
    // Auto-trigger scrub
    setTimeout(() => handleScrub(files), 100);
  }, [selectedScanFiles, handleScrub]);

  // ── Expand scan file inline (fetch full metadata) ──
  const handleExpandScanFile = useCallback(async (filePath: string) => {
    if (expandedScanFile === filePath) {
      setExpandedScanFile(null);
      setExpandedScanMeta(null);
      return;
    }
    setExpandedScanFile(filePath);
    setExpandedScanMeta(null);
    setExpandedScanLoading(true);
    try {
      const res = await fetch("/api/meta-guard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", filePath }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setExpandedScanMeta(data.metadata);
    } catch {
      setExpandedScanMeta({});
    } finally {
      setExpandedScanLoading(false);
    }
  }, [expandedScanFile]);

  // ── Toggle group expansion ──
  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  // ── Toggle scan file selection ──
  const toggleScanFile = useCallback((filePath: string) => {
    setSelectedScanFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const selectAllScanFiles = useCallback(() => {
    if (!scanResult) return;
    const withMeta = scanResult.files.filter((f) => f.metadataCount > 0);
    setSelectedScanFiles(new Set(withMeta.map((f) => f.filePath)));
  }, [scanResult]);

  // ── Privacy flag pills ──
  const PrivacyPills = ({ privacy, anomalies }: { privacy: PrivacyFlags; anomalies?: ForensicAnomalies }) => {
    const flags = [
      { key: "hasGPS", label: "GPS", icon: <MapPin className="w-3 h-3" />, color: "text-red-400 bg-red-500/15" },
      { key: "hasDevice", label: "Device", icon: <Smartphone className="w-3 h-3" />, color: "text-orange-400 bg-orange-500/15" },
      { key: "hasAuthor", label: "Author", icon: <User className="w-3 h-3" />, color: "text-amber-400 bg-amber-500/15" },
      { key: "hasSoftware", label: "Software", icon: <Code className="w-3 h-3" />, color: "text-sky-400 bg-sky-500/15" },
      { key: "hasTimestamp", label: "Timestamp", icon: <Clock className="w-3 h-3" />, color: "text-violet-400 bg-violet-500/15" },
      { key: "hasThumbnail", label: "Thumbnail", icon: <ImageIcon className="w-3 h-3" />, color: "text-teal-400 bg-teal-500/15" },
    ];

    // Add anomaly-based flags
    const extraFlags: { label: string; icon: React.ReactNode; color: string }[] = [];
    if (anomalies) {
      if (anomalies.trailingData > 0 || anomalies.multipleEOF) {
        extraFlags.push({ label: "Hidden Data", icon: <AlertTriangle className="w-3 h-3" />, color: "text-red-400 bg-red-500/20" });
      }
      if (anomalies.c2paDetected) {
        extraFlags.push({ label: "C2PA", icon: <ShieldAlert className="w-3 h-3" />, color: "text-pink-400 bg-pink-500/15" });
      }
      if (anomalies.unknownChunks.length > 0 || anomalies.nonStandardMarkers.length > 0) {
        extraFlags.push({ label: "Unknown", icon: <FileWarning className="w-3 h-3" />, color: "text-orange-400 bg-orange-500/15" });
      }
    }

    const active = flags.filter((f) => (privacy as any)[f.key]);
    if (active.length === 0 && extraFlags.length === 0) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium text-emerald-400 bg-emerald-500/15">
          <CheckCircle2 className="w-3 h-3" /> Clean
        </span>
      );
    }

    return (
      <div className="flex flex-wrap gap-1">
        {active.map((f) => (
          <span key={f.key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium ${f.color}`}>
            {f.icon} {f.label}
          </span>
        ))}
        {extraFlags.map((f) => (
          <span key={f.label} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-medium ${f.color}`}>
            {f.icon} {f.label}
          </span>
        ))}
      </div>
    );
  };

  // ── Tab buttons ──
  const tabs: { id: Tab; label: string; icon: React.ReactNode; desc: string }[] = [
    { id: "inspect", label: "Inspect", icon: <Eye className="w-3.5 h-3.5" />, desc: "View metadata of a single file" },
    { id: "scan", label: "Scan Directory", icon: <Search className="w-3.5 h-3.5" />, desc: "Find files with metadata" },
    { id: "scrub", label: "Scrub Files", icon: <Eraser className="w-3.5 h-3.5" />, desc: "Remove metadata losslessly" },
  ];

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 pb-2 border-b border-teal-500/20">
        <div className="p-2 rounded-lg bg-teal-500/10">
          <ShieldCheck className="w-5 h-5 text-teal-400" />
        </div>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-teal-300 flex items-center gap-2">
            Meta-Guard
            <span className="text-[9px] font-normal text-teal-400/60 bg-teal-500/10 px-1.5 py-0.5 rounded">Privacy Toolkit</span>
          </h2>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
            Inspect, scan, and strip metadata from your files before sharing. Lossless: original pixel data is never altered.
          </p>
        </div>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-teal-500/5 border border-teal-500/15 text-[10px] text-teal-300/80">
        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-teal-400" />
        <div className="space-y-1">
          <p>
            <strong>Why this matters:</strong> Photos and videos often contain hidden data: GPS coordinates, device model, author name,
            timestamps, and software signatures. This data can reveal your identity and location when files are shared publicly.
          </p>
          <p className="text-teal-300/60">
            <strong>How it works:</strong> Images are scrubbed at the byte level: metadata chunks are surgically removed while
            image data (IDAT/scan data) stays <em>byte-for-byte identical</em>. No re-encoding, no quality loss. Video and audio
            files use stream-copy mode (no re-encode).
          </p>
          <p className="text-teal-300/50">
            Supports JPEG, PNG, WebP, GIF, TIFF, HEIC, AVIF, JXL, PDF, MP4, MOV, MKV, MP3, WAV, FLAC, and more.
          </p>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 p-1 rounded-lg bg-muted/40 border border-teal-500/20">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-[11px] font-medium transition-all ${
              activeTab === t.id
                ? "bg-teal-500/20 text-teal-300 shadow-sm"
                : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-teal-500/5"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══════════════════════ INSPECT TAB ═══════════════════════ */}
      {activeTab === "inspect" && (
        <div className="space-y-3">
          <p className="text-[10px] text-muted-foreground/60">
            Paste a file path below to view all embedded metadata. Flags privacy-sensitive fields like GPS, device info, and author data.
          </p>

          <div className="flex gap-2">
            <input
              type="text"
              value={inspectPath}
              onChange={(e) => setInspectPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleInspect()}
              placeholder="Full path to file, e.g. C:\Photos\IMG_1234.jpg"
              className="flex-1 h-8 rounded-md border border-teal-500/30 bg-background px-3 text-[11px] ring-offset-background placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-teal-500/50"
            />
            <button
              onClick={handleInspect}
              disabled={inspectLoading || !inspectPath.trim()}
              className="h-8 px-4 rounded-md bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-medium text-white flex items-center gap-1.5 transition-colors"
            >
              {inspectLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
              Inspect
            </button>
          </div>

          {inspectError && (
            <div className="p-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-[10px] text-red-400 flex items-center gap-2">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> {inspectError}
            </div>
          )}

          {inspectResult && (
            <div className="space-y-3">
              {/* File summary card */}
              <div className={`p-3 rounded-lg border ${riskBg(riskLevel(inspectResult.privacy))}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {categoryIcon(inspectResult.category)}
                    <span className="text-[11px] font-medium text-foreground">{inspectResult.fileName}</span>
                    <span className="text-[9px] text-muted-foreground/60">{formatBytes(inspectResult.fileSize)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {riskLevel(inspectResult.privacy) === "clean" ? (
                      <ShieldCheck className={`w-4 h-4 ${riskColor("clean")}`} />
                    ) : (
                      <ShieldAlert className={`w-4 h-4 ${riskColor(riskLevel(inspectResult.privacy))}`} />
                    )}
                    <span className={`text-[10px] font-medium ${riskColor(riskLevel(inspectResult.privacy))}`}>
                      {riskLevel(inspectResult.privacy) === "clean" ? "No metadata found" : `${inspectResult.metadataCount} metadata fields`}
                    </span>
                  </div>
                </div>

                <PrivacyPills privacy={inspectResult.privacy} />

                {inspectResult.metadataCount > 0 && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => {
                        setScrubFiles([inspectResult.filePath]);
                        setActiveTab("scrub");
                        setTimeout(() => handleScrub([inspectResult.filePath]), 100);
                      }}
                      className="h-7 px-3 rounded-md bg-teal-600 hover:bg-teal-500 text-[10px] font-medium text-white flex items-center gap-1.5 transition-colors"
                    >
                      <Eraser className="w-3 h-3" /> Scrub This File
                    </button>
                  </div>
                )}
              </div>

              {/* Metadata table grouped */}
              {inspectResult.metadataCount > 0 && (() => {
                const grouped: Record<string, Record<string, string>> = {};
                for (const [key, entry] of Object.entries(inspectResult.metadata)) {
                  const g = entry.group || "other";
                  if (!grouped[g]) grouped[g] = {};
                  grouped[g][key] = entry.value;
                }

                return (
                  <div className="space-y-1">
                    {Object.entries(grouped).map(([group, entries]) => (
                      <div key={group} className="rounded-md border border-border/50 overflow-hidden">
                        <button
                          onClick={() => toggleGroup(group)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 bg-muted/30 hover:bg-muted/50 text-[10px] font-medium text-muted-foreground transition-colors"
                        >
                          {expandedGroups.has(group) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <span className="capitalize">{group.replace(/_/g, " ")}</span>
                          <span className="text-[9px] text-muted-foreground/50 ml-1">{Object.keys(entries).length}</span>
                        </button>
                        {expandedGroups.has(group) && (
                          <div className="divide-y divide-border/30">
                            {Object.entries(entries).map(([key, value]) => {
                              const isRisky = /gps|latitude|longitude|make|model|artist|author|creator|copyright/i.test(key);
                              return (
                                <div key={key} className={`flex px-3 py-1 text-[10px] ${isRisky ? "bg-red-500/5" : ""}`}>
                                  <span className={`w-1/3 flex-shrink-0 font-mono ${isRisky ? "text-red-400" : "text-muted-foreground/70"}`}>
                                    {isRisky && <AlertTriangle className="w-2.5 h-2.5 inline mr-1" />}
                                    {key}
                                  </span>
                                  <span className="text-foreground/80 break-all">{value}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════ SCAN TAB ═══════════════════════ */}
      {activeTab === "scan" && (
        <div className="space-y-3">
          <p className="text-[10px] text-muted-foreground/60">
            Point to a directory and Meta-Guard will scan every supported file for embedded metadata. Select files with metadata to scrub them in batch.
          </p>

          <div className="flex gap-2">
            <input
              type="text"
              value={scanPath}
              onChange={(e) => setScanPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleScan()}
              placeholder="Directory path, e.g. C:\Users\You\Pictures"
              className="flex-1 h-8 rounded-md border border-teal-500/30 bg-background px-3 text-[11px] ring-offset-background placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-teal-500/50"
            />
            <button
              onClick={handleScan}
              disabled={scanLoading || !scanPath.trim()}
              className="h-8 px-4 rounded-md bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-medium text-white flex items-center gap-1.5 transition-colors"
            >
              {scanLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Scan
            </button>
          </div>

          {scanError && (
            <div className="p-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-[10px] text-red-400 flex items-center gap-2">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> {scanError}
            </div>
          )}

          {scanResult && (
            <div className="space-y-3">
              {/* Summary */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-teal-400" />
                  <span className="text-[11px] font-medium text-foreground">{scanResult.fileCount} files scanned</span>
                  {(() => {
                    const withMeta = scanResult.files.filter((f) => f.metadataCount > 0).length;
                    const clean = scanResult.fileCount - withMeta;
                    return (
                      <span className="text-[9px] text-muted-foreground/60">
                        {withMeta > 0 && <span className="text-amber-400">{withMeta} with metadata</span>}
                        {withMeta > 0 && clean > 0 && " · "}
                        {clean > 0 && <span className="text-emerald-400">{clean} clean</span>}
                      </span>
                    );
                  })()}
                </div>
                <div className="flex gap-2">
                  {scanResult.files.some((f) => f.metadataCount > 0) && (
                    <>
                      <button
                        onClick={selectAllScanFiles}
                        className="h-6 px-2.5 rounded text-[9px] font-medium text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 transition-colors"
                      >
                        Select All with Metadata
                      </button>
                      {selectedScanFiles.size > 0 && (
                        <button
                          onClick={handleScrubSelected}
                          className="h-6 px-2.5 rounded text-[9px] font-medium text-white bg-teal-600 hover:bg-teal-500 transition-colors flex items-center gap-1"
                        >
                          <Eraser className="w-3 h-3" /> Scrub {selectedScanFiles.size} File{selectedScanFiles.size > 1 ? "s" : ""}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* File list */}
              <div className="rounded-lg border border-border/50 overflow-hidden max-h-[500px] overflow-y-auto">
                {scanResult.files.map((f) => {
                  const level = riskLevel(f.privacy);
                  const selected = selectedScanFiles.has(f.filePath);
                  const isExpanded = expandedScanFile === f.filePath;
                  return (
                    <div key={f.filePath} className="border-b border-border/30 last:border-b-0">
                      <div
                        className={`flex items-center gap-3 px-3 py-2 text-[10px] transition-colors ${
                          f.metadataCount > 0 ? "cursor-pointer hover:bg-teal-500/5" : ""
                        } ${selected ? "bg-teal-500/10" : ""} ${isExpanded ? "bg-teal-500/8 border-b border-teal-500/20" : ""}`}
                      >
                        {/* Checkbox area */}
                        <div
                          onClick={(e) => { e.stopPropagation(); f.metadataCount > 0 && toggleScanFile(f.filePath); }}
                          className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 cursor-pointer ${
                            f.metadataCount === 0
                              ? "border-border/30 opacity-30 cursor-default"
                              : selected
                                ? "border-teal-500 bg-teal-500 text-white"
                                : "border-border/50 hover:border-teal-500/50"
                          }`}
                        >
                          {selected && <CheckCircle2 className="w-3 h-3" />}
                        </div>

                        {/* Icon + name */}
                        <div
                          className="flex items-center gap-1.5 flex-1 min-w-0"
                          onClick={() => f.metadataCount > 0 && handleExpandScanFile(f.filePath)}
                        >
                          {categoryIcon(f.category)}
                          <span className="truncate text-foreground/80 font-mono">{f.fileName}</span>
                        </div>

                        {/* Size */}
                        <span className="text-[9px] text-muted-foreground/50 flex-shrink-0">{formatBytes(f.fileSize)}</span>

                        {/* Privacy flags */}
                        <div className="flex-shrink-0 w-[180px]">
                          <PrivacyPills privacy={f.privacy} anomalies={f.anomalies} />
                        </div>

                        {/* Risk level: clickable to expand */}
                        <div className="flex-shrink-0 w-20 text-right">
                          {level === "clean" ? (
                            <span className="text-[9px] text-emerald-400/70">clean</span>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleExpandScanFile(f.filePath); }}
                              className={`text-[9px] font-medium ${riskColor(level)} hover:underline flex items-center gap-1 ml-auto`}
                              title="Click to view metadata fields"
                            >
                              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              {f.metadataCount} fields
                            </button>
                          )}
                        </div>

                        {/* Full inspect button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setInspectPath(f.filePath);
                            setActiveTab("inspect");
                            setTimeout(() => {
                              setInspectResult(null);
                              handleInspect();
                            }, 50);
                          }}
                          className="flex-shrink-0 h-5 w-5 rounded flex items-center justify-center text-muted-foreground/40 hover:text-teal-400 hover:bg-teal-500/10 transition-colors"
                          title="Open in Inspect tab"
                        >
                          <Eye className="w-3 h-3" />
                        </button>
                      </div>

                      {/* Inline metadata expansion */}
                      {isExpanded && (
                        <div className="px-4 py-2 bg-muted/20 border-b border-teal-500/10">
                          {expandedScanLoading && (
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 py-2">
                              <Loader2 className="w-3 h-3 animate-spin" /> Loading metadata...
                            </div>
                          )}
                          {expandedScanMeta && Object.keys(expandedScanMeta).length > 0 && (
                            <div className="space-y-0.5 max-h-[300px] overflow-y-auto">
                              {Object.entries(expandedScanMeta).map(([key, entry]) => {
                                const isRisky = /gps|latitude|longitude|make|model|artist|author|creator|copyright|prompt|workflow/i.test(key);
                                return (
                                  <div key={key} className={`flex text-[10px] py-0.5 px-2 rounded ${isRisky ? "bg-red-500/5" : ""}`}>
                                    <span className={`w-2/5 flex-shrink-0 font-mono truncate ${isRisky ? "text-red-400" : "text-muted-foreground/60"}`}>
                                      {isRisky && <AlertTriangle className="w-2.5 h-2.5 inline mr-1" />}
                                      {key}
                                    </span>
                                    <span className="text-foreground/70 break-all text-[9px]">{entry.value.slice(0, 200)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {expandedScanMeta && Object.keys(expandedScanMeta).length === 0 && (
                            <p className="text-[10px] text-muted-foreground/50 py-1">No readable metadata fields.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {scanResult.fileCount === 0 && (
                  <div className="p-6 text-center text-[11px] text-muted-foreground/50">
                    No supported media files found in this directory.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════ SCRUB TAB ═══════════════════════ */}
      {activeTab === "scrub" && (
        <div className="space-y-3">
          <p className="text-[10px] text-muted-foreground/60">
            Paste file paths below (one per line) to strip metadata. Clean copies are saved alongside originals:
            <strong className="text-teal-300"> originals are never modified</strong>.
          </p>

          {/* Scrub Level Selector */}
          <div className="rounded-lg border border-teal-500/20 overflow-hidden">
            <div className="grid grid-cols-3 divide-x divide-teal-500/20">
              <button
                onClick={() => setScrubLevel("standard")}
                className={`px-3 py-2.5 text-left transition-colors ${
                  scrubLevel === "standard" ? "bg-teal-500/15 border-b-2 border-teal-400" : "hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className={`w-3.5 h-3.5 ${scrubLevel === "standard" ? "text-teal-400" : "text-muted-foreground/50"}`} />
                  <span className={`text-[10px] font-medium ${scrubLevel === "standard" ? "text-teal-300" : "text-foreground/70"}`}>Standard</span>
                </div>
                <p className="text-[9px] text-muted-foreground/50 mt-0.5">Strip known metadata. Pixel data byte-identical.</p>
              </button>
              <button
                onClick={() => setScrubLevel("forensic")}
                className={`px-3 py-2.5 text-left transition-colors ${
                  scrubLevel === "forensic" ? "bg-amber-500/10 border-b-2 border-amber-400" : "hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <ShieldAlert className={`w-3.5 h-3.5 ${scrubLevel === "forensic" ? "text-amber-400" : "text-muted-foreground/50"}`} />
                  <span className={`text-[10px] font-medium ${scrubLevel === "forensic" ? "text-amber-300" : "text-foreground/70"}`}>Deep Forensic</span>
                </div>
                <p className="text-[9px] text-muted-foreground/50 mt-0.5">Rebuild structure. Remove trailing data, unknown chunks, all non-essential bytes.</p>
              </button>
              <button
                onClick={() => setScrubLevel("maximum")}
                className={`px-3 py-2.5 text-left transition-colors ${
                  scrubLevel === "maximum" ? "bg-red-500/10 border-b-2 border-red-400" : "hover:bg-muted/30"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className={`w-3.5 h-3.5 ${scrubLevel === "maximum" ? "text-red-400" : "text-muted-foreground/50"}`} />
                  <span className={`text-[10px] font-medium ${scrubLevel === "maximum" ? "text-red-300" : "text-foreground/70"}`}>Maximum (CDR)</span>
                </div>
                <p className="text-[9px] text-muted-foreground/50 mt-0.5">Full pixel reconstruction. Destroys steganography. JPEG loses a generation.</p>
              </button>
            </div>
          </div>

          {/* Level-specific warnings */}
          {scrubLevel === "forensic" && (
            <div className="p-2 rounded-md bg-amber-500/5 border border-amber-500/20 text-[9px] text-amber-300/80 flex items-start gap-2">
              <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div>
                <strong>Deep Forensic</strong> rebuilds the file structure from scratch, keeping ONLY rendering-essential data (PNG: IHDR+PLTE+tRNS+IDAT+IEND; JPEG: SOI+DQT+DHT+SOF+SOS+scan+EOI). Removes trailing data, unknown chunks, C2PA credentials, non-standard markers, ICC profiles, and anything not strictly needed to display the image. Image pixel data remains byte-identical.
              </div>
            </div>
          )}
          {scrubLevel === "maximum" && (
            <div className="p-2 rounded-md bg-red-500/5 border border-red-500/20 text-[9px] text-red-300/80 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div>
                <strong>Maximum (Content Disarm & Reconstruction)</strong> decodes the image to raw pixels, destroys the original container entirely, and builds a brand new minimal file from those pixels. This eliminates ALL hidden data including LSB steganography and polyglot payloads.<br/>
                <strong className="text-red-400">PNG</strong>: Pixel values are preserved exactly (lossless round-trip). File size may change (different compression).<br/>
                <strong className="text-red-400">JPEG</strong>: Introduces one generation of quality loss (re-encoded at Q95). Only use if you suspect steganography.
              </div>
            </div>
          )}

          <textarea
            ref={scrubInputRef}
            value={scrubFiles.join("\n")}
            onChange={(e) => setScrubFiles(e.target.value.split("\n").filter((l) => l.trim()))}
            placeholder={"Paste file paths here, one per line:\nC:\\Photos\\vacation.jpg\nC:\\Videos\\clip.mp4"}
            rows={4}
            className="w-full rounded-md border border-teal-500/30 bg-background px-3 py-2 text-[11px] font-mono ring-offset-background placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-teal-500/50 resize-none"
          />

          {/* Optional output directory */}
          <div className="flex items-center gap-2">
            <HardDrive className="w-3.5 h-3.5 text-muted-foreground/50" />
            <input
              type="text"
              value={scrubOutputDir}
              onChange={(e) => setScrubOutputDir(e.target.value)}
              placeholder="Output directory (optional, defaults to same folder as original)"
              className="flex-1 h-7 rounded-md border border-border/50 bg-background px-3 text-[10px] ring-offset-background placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-teal-500/50"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => handleScrub()}
              disabled={scrubLoading || scrubFiles.length === 0}
              className={`h-8 px-5 rounded-md disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-medium text-white flex items-center gap-1.5 transition-colors ${
                scrubLevel === "maximum" ? "bg-red-600 hover:bg-red-500" : scrubLevel === "forensic" ? "bg-amber-600 hover:bg-amber-500" : "bg-teal-600 hover:bg-teal-500"
              }`}
            >
              {scrubLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />}
              Scrub {scrubFiles.length} File{scrubFiles.length !== 1 ? "s" : ""} ({scrubLevel})
            </button>
            <span className="text-[9px] text-muted-foreground/50 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" />
              {scrubLevel === "standard" && "Lossless: pixel data byte-for-byte identical"}
              {scrubLevel === "forensic" && "Lossless: structural rebuild, same pixels"}
              {scrubLevel === "maximum" && "CDR: PNG lossless, JPEG Q95 re-encode"}
            </span>
          </div>

          {scrubError && (
            <div className="p-2.5 rounded-md bg-red-500/10 border border-red-500/30 text-[10px] text-red-400 flex items-center gap-2">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> {scrubError}
            </div>
          )}

          {/* Results */}
          {scrubResults.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                {scrubResults.filter((r) => r.ok).length} of {scrubResults.length} files scrubbed successfully
              </div>

              <div className="rounded-lg border border-border/50 overflow-hidden divide-y divide-border/30">
                {scrubResults.map((r, i) => (
                  <div key={i} className={`flex items-center gap-3 px-3 py-2 text-[10px] ${r.ok ? "" : "bg-red-500/5"}`}>
                    {r.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                    )}
                    <span className="font-mono truncate flex-1 text-foreground/70">
                      {r.filePath.split(/[/\\]/).pop()}
                    </span>
                    {r.ok && r.savedBytes !== undefined && (
                      <span className={`text-[9px] flex-shrink-0 ${r.savedBytes > 0 ? "text-emerald-400/70" : "text-muted-foreground/50"}`}>
                        {r.savedBytes > 0 ? `-${formatBytes(r.savedBytes)}` : r.savedBytes < 0 ? `+${formatBytes(-r.savedBytes)}` : "same size"}
                      </span>
                    )}
                    {r.ok && r.outputPath && (
                      <span className="text-[9px] text-teal-400/60 truncate max-w-[250px] flex-shrink-0" title={r.outputPath}>
                        → {r.outputPath.split(/[/\\]/).pop()}
                      </span>
                    )}
                    {!r.ok && <span className="text-[9px] text-red-400/70">{r.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
