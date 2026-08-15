"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Film, Download, Loader2 } from "lucide-react";
import { GenerationResult } from "@/lib/types";

interface Props {
  result: GenerationResult | null;
  fps: number;
}

type VideoFormat = "mp4" | "gif" | "webm";

export default function VideoCompiler({ result, fps: defaultFps }: Props) {
  const [format, setFormat] = useState<VideoFormat>("mp4");
  const [fps, setFps] = useState(defaultFps);
  const [compiling, setCompiling] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const frames = result?.images ?? [];
  const hasFrames = frames.length > 1;

  const formatInfo: Record<VideoFormat, { label: string; desc: string }> = {
    mp4: { label: "MP4 (H.264)", desc: "Best quality, universal playback" },
    webm: { label: "WebM (VP9)", desc: "Good quality, smaller file" },
    gif: { label: "GIF", desc: "Animated, large file, web-friendly" },
  };

  const handleCompile = async () => {
    if (!result || frames.length < 2) return;

    setCompiling(true);
    setError(null);
    setProgress("Compiling frames...");

    try {
      const res = await fetch("/api/compile-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: frames,
          fps: fps,
          format: format,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Compilation failed");
      }

      setProgress("Downloading...");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `veksnap_output.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setProgress("Done!");
      setTimeout(() => setProgress(""), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compilation failed");
    } finally {
      setCompiling(false);
    }
  };

  if (!hasFrames) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Film className="w-4 h-4" />
          Export Video
          <Badge variant="secondary" className="text-[10px]">
            {frames.length} frames
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Format Selector */}
        <div className="space-y-1.5">
          <Label className="text-xs">Format</Label>
          <Select value={format} onValueChange={(v) => setFormat(v as VideoFormat)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(formatInfo) as VideoFormat[]).map((f) => (
                <SelectItem key={f} value={f} className="text-xs">
                  <div>
                    <span className="font-medium">{formatInfo[f].label}</span>
                    <span className="text-muted-foreground ml-2">{formatInfo[f].desc}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* FPS Control */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Frame Rate</Label>
            <span className="text-xs font-mono text-muted-foreground">{fps} FPS</span>
          </div>
          <Slider
            value={[fps]}
            onValueChange={([v]) => setFps(v)}
            min={1}
            max={30}
            step={1}
          />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>1</span>
            <span>Duration: {(frames.length / fps).toFixed(1)}s</span>
            <span>30</span>
          </div>
        </div>

        {/* Compile Button */}
        <Button
          className="w-full gap-2"
          onClick={handleCompile}
          disabled={compiling}
        >
          {compiling ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {progress}
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Export as {formatInfo[format].label}
            </>
          )}
        </Button>

        {/* Status */}
        {!compiling && progress && (
          <p className="text-xs text-green-500 text-center">{progress}</p>
        )}
        {error && (
          <p className="text-xs text-destructive bg-destructive/10 rounded-md p-2">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
