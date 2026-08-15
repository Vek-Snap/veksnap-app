"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Upload, Scissors, Film, Clock, Loader2 } from "lucide-react";
import {
  VideoProbeResult,
  FrameExtractionResult,
  probeVideo,
  extractFrames,
  extractAudio,
  formatTimecode,
  planBatches,
} from "@/lib/video-pipeline";

interface Props {
  onSessionReady: (session: {
    sessionId: string;
    probe: VideoProbeResult;
    trimStart: number;
    trimEnd: number;
    extraction: FrameExtractionResult;
    audioPath: string | null;
    batchPlan: ReturnType<typeof planBatches>;
  }) => void;
}

export default function VideoTrimmer({ onSessionReady }: Props) {
  const [probe, setProbe] = useState<VideoProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [trimRange, setTrimRange] = useState<[number, number]>([0, 0]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".mp4") && !file.type.startsWith("video/")) {
      setError("Please upload an MP4 video file");
      return;
    }

    setLoading(true);
    setError(null);
    setStatus("Analyzing video...");

    try {
      // Create local URL for video preview
      const url = URL.createObjectURL(file);
      setVideoUrl(url);

      // Probe video with FFmpeg
      const result = await probeVideo(file);
      setProbe(result);
      setTrimRange([0, result.duration]);
      setStatus("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze video");
    }
    setLoading(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleExtract = useCallback(async () => {
    if (!probe) return;
    setLoading(true);
    setError(null);
    const sessionId = Date.now().toString();

    try {
      setStatus("Extracting frames...");
      const extraction = await extractFrames(
        probe.inputPath,
        trimRange[0],
        trimRange[1],
        sessionId
      );

      setStatus("Extracting audio...");
      let audioPath: string | null = null;
      if (probe.hasAudio) {
        try {
          const result = await extractAudio(
            probe.inputPath,
            trimRange[0],
            trimRange[1],
            sessionId
          );
          audioPath = result.audioPath;
        } catch {
          // Audio extraction can fail for some formats, not critical
          console.warn("Audio extraction failed, continuing without audio");
        }
      }

      const batchPlan = planBatches(extraction.frameCount);

      setStatus(`Ready: ${extraction.frameCount} frames, ${batchPlan.length} batches`);

      onSessionReady({
        sessionId,
        probe,
        trimStart: trimRange[0],
        trimEnd: trimRange[1],
        extraction,
        audioPath,
        batchPlan,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    }
    setLoading(false);
  }, [probe, trimRange, onSessionReady]);

  // Seek video preview when trim handles change
  const handleTrimChange = useCallback(
    (values: number[]) => {
      setTrimRange([values[0], values[1]]);
      if (videoRef.current) {
        videoRef.current.currentTime = values[0];
      }
    },
    []
  );

  const trimDuration = trimRange[1] - trimRange[0];
  const estimatedFrames = probe ? Math.round(trimDuration * probe.fps) : 0;
  const batchCount = estimatedFrames > 0 ? planBatches(estimatedFrames).length : 0;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold flex items-center gap-1.5">
        <Film className="w-3.5 h-3.5" /> Source Video
      </h3>

      {!probe ? (
        // Upload area
        <div
          className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileSelect(f);
            }}
          />
          {loading ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{status}</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-6 h-6 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                Drop MP4 here or click to browse
              </span>
            </div>
          )}
        </div>
      ) : (
        // Video preview + trim controls
        <div className="space-y-3">
          {/* Video preview */}
          {videoUrl && (
            <video
              ref={videoRef}
              src={videoUrl}
              className="w-full rounded-lg border border-border max-h-48 object-contain bg-black"
              muted
              playsInline
            />
          )}

          {/* Video info badges */}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="text-[10px] gap-1">
              <Clock className="w-3 h-3" />
              {formatTimecode(probe.duration)}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {probe.fps} FPS
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {probe.width}×{probe.height}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {probe.codec}
            </Badge>
            {probe.hasAudio && (
              <Badge variant="secondary" className="text-[10px]">Audio</Badge>
            )}
          </div>

          {/* Trim controls */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium flex items-center gap-1">
                <Scissors className="w-3 h-3" /> Trim
              </span>
              <span className="text-[10px] text-muted-foreground font-mono">
                {formatTimecode(trimRange[0])} to {formatTimecode(trimRange[1])}
              </span>
            </div>
            <Slider
              min={0}
              max={probe.duration}
              step={0.1}
              value={trimRange}
              onValueChange={handleTrimChange}
              className="w-full"
            />
            <div className="flex justify-between text-[9px] text-muted-foreground">
              <span>Duration: {formatTimecode(trimDuration)}</span>
              <span>~{estimatedFrames} frames → {batchCount} batches</span>
            </div>
          </div>

          {/* Extract button */}
          <div className="flex gap-2">
            <Button
              className="flex-1 gap-1 h-8 text-xs"
              onClick={handleExtract}
              disabled={loading || trimDuration <= 0}
            >
              {loading ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {status}
                </>
              ) : (
                <>
                  <Scissors className="w-3 h-3" />
                  Extract {estimatedFrames} Frames
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setProbe(null);
                if (videoUrl) URL.revokeObjectURL(videoUrl);
                setVideoUrl(null);
                setError(null);
              }}
            >
              Reset
            </Button>
          </div>

          {error && (
            <p className="text-[10px] text-destructive">{error}</p>
          )}
          {status && !loading && (
            <p className="text-[10px] text-green-400">{status}</p>
          )}
        </div>
      )}
    </div>
  );
}
