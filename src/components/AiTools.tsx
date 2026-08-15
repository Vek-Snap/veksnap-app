"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Wand2,
  Eye,
  Loader2,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  ImageIcon,
  X,
  Trash2,
} from "lucide-react";

// ── Prompt Expander ──

function PromptExpander() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [style, setStyle] = useState("");
  const [mode, setMode] = useState<"video" | "image">("video");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleExpand = useCallback(async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    setOutput("");
    try {
      const res = await fetch("/api/prompt-expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: input.trim(),
          style: style.trim() || undefined,
          maxTokens: 600,
          mode,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.expanded) setOutput(data.expanded);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Expansion failed");
    } finally {
      setBusy(false);
    }
  }, [input, style, mode, busy]);

  const handleAbort = useCallback(async () => {
    try {
      await fetch("/api/llm-abort", { method: "POST" });
    } catch { /* ignore */ }
  }, []);

  const handleCopy = useCallback(() => {
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [output]);

  return (
    <div className="space-y-2">
      {/* Input */}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Enter a short prompt to expand..."
        className="w-full h-16 rounded-md border border-border bg-background px-2 py-1.5 text-[11px] resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500/50 placeholder:text-muted-foreground/40"
        disabled={busy}
      />

      {/* Mode toggle + Style hint */}
      <div className="flex gap-1.5 items-center">
        <div className="flex rounded-md border border-border overflow-hidden">
          <button
            onClick={() => setMode("image")}
            className={`px-2 py-0.5 text-[9px] font-medium transition-colors ${mode === "image" ? "bg-emerald-500/20 text-emerald-300" : "text-muted-foreground/60 hover:bg-muted/30"}`}
          >
            Image
          </button>
          <button
            onClick={() => setMode("video")}
            className={`px-2 py-0.5 text-[9px] font-medium transition-colors ${mode === "video" ? "bg-emerald-500/20 text-emerald-300" : "text-muted-foreground/60 hover:bg-muted/30"}`}
          >
            Video
          </button>
        </div>
        <input
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="Style hint (optional)"
          className="flex-1 h-6 rounded-md border border-border bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-emerald-500/50 placeholder:text-muted-foreground/40"
          disabled={busy}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 h-7 text-[10px] border-emerald-500/30 text-emerald-400/80 hover:text-emerald-400 hover:border-emerald-500/50 hover:bg-emerald-500/5"
          onClick={handleExpand}
          disabled={busy || !input.trim()}
        >
          {busy ? (
            <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Expanding...</>
          ) : (
            <><Wand2 className="w-3 h-3 mr-1" /> Expand Prompt</>
          )}
        </Button>
        {busy && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px] px-2 border-red-500/30 text-red-400/80 hover:text-red-400 hover:border-red-500/50"
            onClick={handleAbort}
          >
            <X className="w-3 h-3" />
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-[9px] text-red-400/80 break-words">{error}</p>
      )}

      {/* Output */}
      {output && (
        <div className="relative">
          <textarea
            value={output}
            readOnly
            className="w-full h-24 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-[10px] text-emerald-100/90 resize-none focus:outline-none"
          />
          <button
            onClick={handleCopy}
            className="absolute top-1 right-1 p-1 rounded hover:bg-emerald-500/20 transition-colors"
            title="Copy to clipboard"
          >
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3 text-emerald-400/60" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Image Describer ──

function ImageDescriber() {
  const [imageData, setImageData] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageSelect = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImageData(reader.result as string);
      setOutput("");
      setError(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleImageSelect(file);
  }, [handleImageSelect]);

  const handleDescribe = useCallback(async () => {
    if (!imageData || busy) return;
    setBusy(true);
    setError(null);
    setOutput("");
    try {
      const res = await fetch("/api/vision-describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imagePath: imageData,
          maxTokens: 300,
          prompt: customPrompt.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.description) setOutput(data.description);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Description failed");
    } finally {
      setBusy(false);
    }
  }, [imageData, customPrompt, busy]);

  const handleAbort = useCallback(async () => {
    try {
      await fetch("/api/llm-abort", { method: "POST" });
    } catch { /* ignore */ }
  }, []);

  const handleCopy = useCallback(() => {
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [output]);

  const handleClear = useCallback(() => {
    setImageData(null);
    setOutput("");
    setError(null);
  }, []);

  return (
    <div className="space-y-2">
      {/* Drop zone / preview */}
      {!imageData ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className="w-full h-20 rounded-md border-2 border-dashed border-sky-500/20 bg-sky-500/5 flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-sky-500/40 hover:bg-sky-500/10 transition-colors"
        >
          <ImageIcon className="w-5 h-5 text-sky-400/40" />
          <span className="text-[9px] text-sky-400/50">Drop image or click to browse</span>
        </div>
      ) : (
        <div className="relative">
          <img
            src={imageData}
            alt="Preview"
            className="w-full h-20 object-cover rounded-md border border-sky-500/20"
          />
          <button
            onClick={handleClear}
            className="absolute top-1 right-1 p-0.5 rounded bg-black/60 hover:bg-black/80 transition-colors"
            title="Remove image"
          >
            <Trash2 className="w-3 h-3 text-red-400/80" />
          </button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImageSelect(file);
          e.target.value = "";
        }}
      />

      {/* Custom prompt (optional) */}
      <input
        value={customPrompt}
        onChange={(e) => setCustomPrompt(e.target.value)}
        placeholder="Custom question (optional, e.g. 'Describe the mood')"
        className="w-full h-6 rounded-md border border-border bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-sky-500/50 placeholder:text-muted-foreground/40"
        disabled={busy}
      />

      {/* Actions */}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 h-7 text-[10px] border-sky-500/30 text-sky-400/80 hover:text-sky-400 hover:border-sky-500/50 hover:bg-sky-500/5"
          onClick={handleDescribe}
          disabled={busy || !imageData}
        >
          {busy ? (
            <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Describing...</>
          ) : (
            <><Eye className="w-3 h-3 mr-1" /> Describe Image</>
          )}
        </Button>
        {busy && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px] px-2 border-red-500/30 text-red-400/80 hover:text-red-400 hover:border-red-500/50"
            onClick={handleAbort}
          >
            <X className="w-3 h-3" />
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-[9px] text-red-400/80 break-words">{error}</p>
      )}

      {/* Output */}
      {output && (
        <div className="relative">
          <textarea
            value={output}
            readOnly
            className="w-full h-24 rounded-md border border-sky-500/20 bg-sky-500/5 px-2 py-1.5 text-[10px] text-sky-100/90 resize-none focus:outline-none"
          />
          <button
            onClick={handleCopy}
            className="absolute top-1 right-1 p-1 rounded hover:bg-sky-500/20 transition-colors"
            title="Copy to clipboard"
          >
            {copied ? (
              <Check className="w-3 h-3 text-sky-400" />
            ) : (
              <Copy className="w-3 h-3 text-sky-400/60" />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Combined AI Tools Panel ──

export default function AiTools() {
  const [expanderOpen, setExpanderOpen] = useState(false);
  const [describerOpen, setDescriberOpen] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Separator className="flex-1" />
        <span className="text-[8px] font-semibold tracking-widest text-muted-foreground/50 uppercase">AI Tools</span>
        <Separator className="flex-1" />
      </div>

      {/* Prompt Expander */}
      <Card className="border-emerald-500/15 bg-emerald-500/[0.02]">
        <CardHeader className="p-2 cursor-pointer select-none" onClick={() => setExpanderOpen(!expanderOpen)}>
          <CardTitle className="text-[10px] font-medium text-emerald-400/80 flex items-center gap-1.5">
            {expanderOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Wand2 className="w-3 h-3" />
            Prompt Expander
            <span className="text-[8px] text-muted-foreground/40 ml-auto">Qwen3.5-9B</span>
          </CardTitle>
        </CardHeader>
        {expanderOpen && (
          <CardContent className="p-2 pt-0">
            <PromptExpander />
          </CardContent>
        )}
      </Card>

      {/* Image Describer */}
      <Card className="border-sky-500/15 bg-sky-500/[0.02]">
        <CardHeader className="p-2 cursor-pointer select-none" onClick={() => setDescriberOpen(!describerOpen)}>
          <CardTitle className="text-[10px] font-medium text-sky-400/80 flex items-center gap-1.5">
            {describerOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Eye className="w-3 h-3" />
            Image Describer
            <span className="text-[8px] text-muted-foreground/40 ml-auto">Qwen2.5-VL</span>
          </CardTitle>
        </CardHeader>
        {describerOpen && (
          <CardContent className="p-2 pt-0">
            <ImageDescriber />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
