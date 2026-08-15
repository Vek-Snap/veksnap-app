"use client";

import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  Upload,
  X,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  Play,
  Check,
  AlertTriangle,
  RotateCcw,
  Trash2,
  Tag,
  Image as ImageIcon,
  Settings2,
  Loader2,
  Zap,
  FileText,
  Crop,
  HelpCircle,
  Camera,
  Info,
  Paintbrush,
  Scissors,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import DatasetImageEditor from "@/components/DatasetImageEditor";
import {
  TrainingImage,
  LoraFactoryStep,
  LoraTrainingConfig,
  LoraTrainingPreset,
  DEFAULT_TRAINING_CONFIG,
  LORA_TRAINING_PRESETS,
  LORA_RANK_OPTIONS,
  LORA_OPTIMIZER_OPTIONS,
  LORA_SCHEDULER_OPTIONS,
  TrainingProgress,
  CheckpointArch,
  getCheckpointArch,
} from "@/lib/types";
import { getCheckpoints, getCheckpointSizes, getDiffusionModels, getVAEs, getTextEncoders } from "@/lib/comfyui-api";

const STEPS: { key: LoraFactoryStep; label: string; icon: React.ReactNode }[] = [
  { key: "dataset", label: "Dataset", icon: <ImageIcon className="w-3.5 h-3.5" /> },
  { key: "caption", label: "Caption", icon: <Tag className="w-3.5 h-3.5" /> },
  { key: "configure", label: "Configure", icon: <Settings2 className="w-3.5 h-3.5" /> },
  { key: "train", label: "Train", icon: <Play className="w-3.5 h-3.5" /> },
  { key: "done", label: "Done", icon: <Check className="w-3.5 h-3.5" /> },
];

export default function LoraFactory() {
  const [step, setStep] = useState<LoraFactoryStep>("dataset");
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [checkpointSizes, setCheckpointSizes] = useState<Record<string, number>>({});
  // Z-Image trains from separate DiT / VAE / text-encoder files rather than a checkpoint.
  const [diffusionModels, setDiffusionModels] = useState<string[]>([]);
  const [vaes, setVaes] = useState<string[]>([]);
  const [textEncoders, setTextEncoders] = useState<string[]>([]);
  const [datasetName, setDatasetName] = useState("my_character");
  const [images, setImages] = useState<TrainingImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [config, setConfig] = useState<LoraTrainingConfig>(DEFAULT_TRAINING_CONFIG);
  const [captioning, setCaptioning] = useState(false);
  const [captioningSingle, setCaptioningSingle] = useState(false);
  const [writingMetadata, setWritingMetadata] = useState(false);
  const [captionProgress, setCaptionProgress] = useState({ current: 0, total: 0 });
  const [training, setTraining] = useState<TrainingProgress>({
    status: "idle", epoch: 0, totalEpochs: 0, step: 0, totalSteps: 0,
    loss: 0, lossHistory: [], sampleImages: [], elapsedSec: 0, estimatedRemainingSec: 0,
  });
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smartCropping, setSmartCropping] = useState(false);
  const [showGuide, setShowGuide] = useState(true);
  const [editingImage, setEditingImage] = useState<TrainingImage | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load checkpoints on mount
  useEffect(() => {
    (async () => {
      try {
        const [ckpts, sizes] = await Promise.all([getCheckpoints(), getCheckpointSizes()]);
        setCheckpoints(ckpts);
        setCheckpointSizes(sizes);
      } catch { /* ComfyUI may not be running */ }
      // Z-Image lists are best-effort: each helper already swallows a missing node.
      try {
        const [dits, vaeList, teList] = await Promise.all([getDiffusionModels(), getVAEs(), getTextEncoders()]);
        setDiffusionModels(dits);
        setVaes(vaeList);
        setTextEncoders(teList);
      } catch { /* optional */ }
    })();
  }, []);

  // Build a dropdown option list that always includes the current value (even if the
  // ComfyUI node hasn't been refreshed / the file isn't mapped yet).
  const withCurrent = useCallback((list: string[], current?: string) =>
    Array.from(new Set([current, ...list].filter(Boolean))) as string[], []);

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const selectedImage = images.find((img) => img.id === selectedImageId) ?? null;

  // ── Dataset step: Upload images ──

  // RAW extensions we accept alongside standard images
  const RAW_EXTS = new Set([".cr2",".cr3",".nef",".arw",".orf",".rw2",".dng",".raf",".pef",".srw"]);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const accepted = Array.from(files).filter((f) => {
      if (f.type.startsWith("image/")) return true;
      const ext = "." + f.name.split(".").pop()?.toLowerCase();
      return RAW_EXTS.has(ext);
    });
    if (accepted.length === 0) return;
    setError(null);

    const formData = new FormData();
    formData.append("datasetName", datasetName);
    for (const f of accepted) formData.append("images", f);

    try {
      const resp = await fetch("/api/lora-factory/upload", { method: "POST", body: formData });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Upload failed");
      setImages((prev) => [...prev, ...data.images]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }, [datasetName]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleRemoveImage = useCallback(async (id: string) => {
    const img = images.find((i) => i.id === id);
    if (!img) return;
    try {
      await fetch("/api/lora-factory/remove-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetName, filename: img.filename }),
      });
      setImages((prev) => prev.filter((i) => i.id !== id));
      if (selectedImageId === id) setSelectedImageId(null);
    } catch { /* ignore */ }
  }, [images, datasetName, selectedImageId]);

  const handleClearDataset = useCallback(async () => {
    try {
      await fetch("/api/lora-factory/clear-dataset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetName }),
      });
      setImages([]);
      setSelectedImageId(null);
    } catch { /* ignore */ }
  }, [datasetName]);

  // ── Smart crop: face detection + child crops + RAW conversion ──

  const handleSmartCrop = useCallback(async () => {
    if (images.length === 0) return;
    setSmartCropping(true);
    setError(null);

    try {
      const resp = await fetch("/api/lora-factory/smart-crop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetName }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Smart crop failed");

      // Add newly created crop images to the dataset
      const newImages: TrainingImage[] = [];
      for (const crop of (data.crops || [])) {
        newImages.push({
          id: `crop_${crop.filename}_${Date.now()}`,
          filename: crop.filename,
          serverPath: "",
          caption: "",
          tags: [],
          width: crop.width,
          height: crop.height,
          sizeBytes: 0,
        });
      }
      // Add converted RAW images
      for (const raw of (data.rawConverted || [])) {
        newImages.push({
          id: `raw_${raw.filename}_${Date.now()}`,
          filename: raw.filename,
          serverPath: "",
          caption: "",
          tags: [],
          width: raw.width,
          height: raw.height,
          sizeBytes: 0,
        });
      }

      if (newImages.length > 0) {
        setImages((prev) => [...prev, ...newImages]);
      }

      const cropCount = data.crops?.length || 0;
      const rawCount = data.rawConverted?.length || 0;
      if (cropCount === 0 && rawCount === 0) {
        setError("No faces detected and no RAW files to convert. Try images with visible faces.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smart crop failed");
    } finally {
      setSmartCropping(false);
    }
  }, [images, datasetName]);

  // ── Caption step: Auto-tag ──

  const handleAutoCaption = useCallback(async () => {
    if (images.length === 0) return;
    setCaptioning(true);
    setCaptionProgress({ current: 0, total: images.length });
    setError(null);

    try {
      const resp = await fetch("/api/lora-factory/auto-tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetName, mode: "florence" }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Auto-captioning failed");

      // Update images with captions from server
      setImages((prev) =>
        prev.map((img) => {
          const match = data.captions?.find((c: { filename: string; caption: string }) => c.filename === img.filename);
          if (match) {
            const tags = match.caption.split(",").map((t: string) => t.trim()).filter(Boolean);
            return { ...img, caption: match.caption, tags };
          }
          return img;
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto-captioning failed");
    } finally {
      setCaptioning(false);
    }
  }, [images, datasetName]);

  const handleSingleCaption = useCallback(async (imageId: string) => {
    const img = images.find((i) => i.id === imageId);
    if (!img) return;
    setCaptioningSingle(true);
    setError(null);

    try {
      const resp = await fetch("/api/lora-factory/auto-tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetName, mode: "florence", singleFile: img.filename }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Auto-captioning failed");

      const match = data.captions?.[0];
      if (match?.caption) {
        const tags = match.caption.split(",").map((t: string) => t.trim()).filter(Boolean);
        setImages((prev) =>
          prev.map((i) => i.id === imageId ? { ...i, caption: match.caption, tags } : i)
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Single image captioning failed");
    } finally {
      setCaptioningSingle(false);
    }
  }, [images, datasetName]);

  const handleCaptionChange = useCallback((id: string, newCaption: string) => {
    setImages((prev) =>
      prev.map((img) => {
        if (img.id !== id) return img;
        const tags = newCaption.split(",").map((t) => t.trim()).filter(Boolean);
        return { ...img, caption: newCaption, tags };
      })
    );
  }, []);

  const handleSaveCaptions = useCallback(async () => {
    try {
      await fetch("/api/lora-factory/save-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetName,
          captions: images.map((img) => ({ filename: img.filename, caption: img.caption })),
        }),
      });
    } catch { /* ignore */ }
  }, [datasetName, images]);

  const handleRemoveTag = useCallback((imageId: string, tagIndex: number) => {
    setImages((prev) =>
      prev.map((img) => {
        if (img.id !== imageId) return img;
        const newTags = img.tags.filter((_, i) => i !== tagIndex);
        return { ...img, tags: newTags, caption: newTags.join(", ") };
      })
    );
  }, []);

  const handleWriteMetadata = useCallback(async () => {
    setWritingMetadata(true);
    setError(null);
    try {
      // Save captions to .txt first
      await fetch("/api/lora-factory/save-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetName,
          captions: images.map((img) => ({ filename: img.filename, caption: img.caption })),
        }),
      });
      // Then write to image metadata
      const resp = await fetch("/api/lora-factory/metadata-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetName, action: "write" }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to write metadata");
      const written = data.results?.filter((r: { written: boolean }) => r.written).length ?? 0;
      setError(`Captions embedded into ${written}/${images.length} image(s) metadata`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to write metadata");
    } finally {
      setWritingMetadata(false);
    }
  }, [datasetName, images]);

  const handleReadMetadata = useCallback(async () => {
    setWritingMetadata(true);
    setError(null);
    try {
      const resp = await fetch("/api/lora-factory/metadata-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetName, action: "read" }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to read metadata");
      let restored = 0;
      setImages((prev) =>
        prev.map((img) => {
          const match = data.results?.find((r: { filename: string; caption: string }) => r.filename === img.filename);
          if (match?.caption) {
            restored++;
            const tags = match.caption.split(",").map((t: string) => t.trim()).filter(Boolean);
            return { ...img, caption: match.caption, tags };
          }
          return img;
        })
      );
      setError(`Restored captions from metadata for ${restored} image(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read metadata");
    } finally {
      setWritingMetadata(false);
    }
  }, [datasetName]);

  // ── Configure step ──

  const updateConfig = useCallback(<K extends keyof LoraTrainingConfig>(key: K, value: LoraTrainingConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const applyPreset = useCallback((preset: LoraTrainingPreset) => {
    const presetConfig = LORA_TRAINING_PRESETS[preset];
    setConfig((prev) => ({ ...prev, ...presetConfig, preset }));
  }, []);

  // ── Train step ──

  const handleStartTraining = useCallback(async () => {
    const isZImage = config.baseModelArch === "zimage";
    if (isZImage) {
      if (!config.ditModel) {
        setError("Select a Z-Image DiT model");
        return;
      }
    } else if (!config.baseModel) {
      setError("Select a base checkpoint model");
      return;
    }
    if (images.length === 0) {
      setError("No training images");
      return;
    }
    setError(null);

    // Save captions first
    await handleSaveCaptions();

    setTraining((prev) => ({ ...prev, status: "preparing" }));

    try {
      const resp = await fetch("/api/lora-factory/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, datasetName }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to start training");

      setTraining((prev) => ({ ...prev, status: "training" }));

      // Poll for progress
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const statusResp = await fetch(`/api/lora-factory/train-status?dataset=${datasetName}`);
          const status = await statusResp.json();
          setTraining(status);
          if (status.status === "complete" || status.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            if (status.status === "complete") setStep("done");
          }
        } catch { /* ignore polling errors */ }
      }, 2000);
    } catch (err) {
      setTraining((prev) => ({ ...prev, status: "error", error: err instanceof Error ? err.message : "Training failed" }));
    }
  }, [config, datasetName, images, handleSaveCaptions]);

  // ── Computed helpers ──

  const captionedCount = images.filter((img) => img.caption.trim().length > 0).length;
  const allCaptioned = images.length > 0 && captionedCount === images.length;

  const canAdvance = useMemo(() => {
    switch (step) {
      case "dataset": return images.length >= 3;
      case "caption": return allCaptioned;
      case "configure": return (config.baseModelArch === "zimage" ? !!config.ditModel : !!config.baseModel) && !!config.outputName;
      case "train": return training.status === "complete";
      default: return false;
    }
  }, [step, images, allCaptioned, config, training]);

  // ── Render ──

  return (
    <div className="flex flex-col h-full">
      {/* Step Progress Bar */}
      <div className="flex items-center gap-1 px-3 py-2 bg-muted/20 border-b border-border">
        {STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1">
            <button
              onClick={() => i <= stepIndex && setStep(s.key)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                s.key === step
                  ? "bg-orange-500/20 text-orange-400 border border-orange-500/40"
                  : i < stepIndex
                  ? "text-orange-400/70 hover:bg-orange-500/10 cursor-pointer"
                  : "text-muted-foreground/50 cursor-default"
              }`}
              disabled={i > stepIndex}
            >
              {i < stepIndex ? <Check className="w-3 h-3" /> : s.icon}
              {s.label}
            </button>
            {i < STEPS.length - 1 && (
              <ChevronRight className="w-3 h-3 text-muted-foreground/30" />
            )}
          </div>
        ))}
      </div>

      {/* Error display */}
      {error && (
        <div className="mx-3 mt-2 px-3 py-1.5 rounded bg-destructive/10 border border-destructive/30 text-[11px] text-destructive flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="w-3 h-3" /></button>
        </div>
      )}

      {/* Step Content */}
      <div className="flex-1 overflow-auto px-3 py-3 space-y-3">
        {/* ═══════════════ DATASET STEP ═══════════════ */}
        {step === "dataset" && (
          <>
            {/* Guidance Panel */}
            {showGuide && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2.5">
                <div className="flex items-start justify-between">
                  <p className="text-[11px] text-amber-400 font-medium flex items-center gap-1.5">
                    <HelpCircle className="w-3.5 h-3.5" /> Getting Started: Image Dataset
                  </p>
                  <button onClick={() => setShowGuide(false)} className="text-amber-400/50 hover:text-amber-400">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="text-[10px] leading-relaxed text-amber-300/80 space-y-2">
                  <p><strong>What is a LoRA?</strong> A LoRA (Low-Rank Adaptation) teaches an AI model to recognize a specific person, character, art style, or concept by training on example images.</p>
                  <p><strong>How many images?</strong> 10-20 images is the sweet spot. As few as 5 can work, but 15+ gives the best results. More variety = better generalization.</p>
                  <p><strong>What makes a good dataset?</strong></p>
                  <ul className="list-disc list-inside ml-1 space-y-1 text-amber-300/70">
                    <li>Multiple angles: front, 3/4 view, profile, slightly above/below</li>
                    <li>Varied expressions: neutral, smiling, serious, etc.</li>
                    <li>Different lighting conditions: indoor, outdoor, studio</li>
                    <li>Mix of close-ups and full body shots</li>
                    <li>Clean, well-lit, in-focus images (avoid blurry or heavily filtered photos)</li>
                    <li>Consistent subject: same person/character across all images</li>
                  </ul>
                  <p><strong>Close-up body part images?</strong> Yes! Hands, tattoos, distinctive accessories, hair details, or any unique features, these help the model learn fine details often lost in full-body shots.</p>
                  <p><strong>Multiple people in a photo?</strong> Isolate your subject first. Use the <Scissors className="w-3 h-3 inline" /> edit button on any image to crop or mask-extract just your character. Multi-subject images confuse training.</p>
                  <p className="flex items-center gap-1"><Camera className="w-3 h-3" /> <strong>Camera RAW files</strong> (CR2, NEF, ARW, DNG, etc.) are fully supported: they&apos;ll be auto-converted to PNG on upload.</p>
                  <p className="flex items-center gap-1"><Crop className="w-3 h-3" /> <strong>Smart Crop</strong> will automatically detect faces and create useful close-up and head-and-shoulders crops to augment your dataset.</p>
                  <p className="flex items-center gap-1"><Scissors className="w-3 h-3" /> <strong>Manual Crop & Mask</strong>: Hover any image and click the <Scissors className="w-2.5 h-2.5 inline" /> button to open the editor. Use <strong>Crop</strong> for simple rectangular selection, or <strong>Mask &amp; Extract</strong> to paint a precise selection around your subject (removes cluttered backgrounds).</p>
                </div>
              </div>
            )}
            {!showGuide && (
              <button onClick={() => setShowGuide(true)} className="text-[9px] text-amber-400/50 hover:text-amber-400 flex items-center gap-1">
                <HelpCircle className="w-3 h-3" /> Show guide
              </button>
            )}

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-orange-400">Training Dataset</h3>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Drop images of your subject. 10-20 diverse images recommended. Min 3.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={datasetName}
                  onChange={(e) => setDatasetName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_"))}
                  className="h-7 w-40 rounded border border-border bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                  placeholder="Dataset name"
                />
                {images.length > 0 && (
                  <Button size="sm" variant="ghost" className="h-7 text-[10px] text-destructive" onClick={handleClearDataset}>
                    <Trash2 className="w-3 h-3 mr-1" /> Clear All
                  </Button>
                )}
              </div>
            </div>

            {/* Drop Zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                dragOver
                  ? "border-orange-500 bg-orange-500/10"
                  : "border-border hover:border-orange-500/50 hover:bg-orange-500/5"
              }`}
            >
              <Upload className="w-8 h-8 mx-auto text-muted-foreground/50 mb-2" />
              <p className="text-[11px] text-muted-foreground">
                Drag & drop images here, or click to browse
              </p>
              <p className="text-[9px] text-muted-foreground/70 mt-1">
                JPG, PNG, WEBP + Camera RAW (CR2, NEF, ARW, DNG, etc.), any resolution
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.cr2,.CR2,.cr3,.CR3,.nef,.NEF,.arw,.ARW,.orf,.ORF,.rw2,.RW2,.dng,.DNG,.raf,.RAF,.pef,.PEF,.srw,.SRW"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && handleFiles(e.target.files)}
              />
            </div>

            {/* Smart Crop + Image Grid */}
            {images.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[10px] text-muted-foreground">
                    {images.length} image{images.length !== 1 ? "s" : ""} in dataset
                    {images.length < 5 && (
                      <span className="text-amber-400 ml-2">
                        (consider adding more for better results)
                      </span>
                    )}
                    {images.length >= 10 && images.length <= 20 && (
                      <span className="text-green-400 ml-2">
                        (ideal range)
                      </span>
                    )}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px] border-orange-500/30 text-orange-400 hover:bg-orange-500/10"
                    onClick={handleSmartCrop}
                    disabled={smartCropping}
                  >
                    {smartCropping ? (
                      <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Analyzing...</>
                    ) : (
                      <><Crop className="w-3 h-3 mr-1" /> Smart Crop + RAW Convert</>
                    )}
                  </Button>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {images.map((img) => {
                    const isCrop = img.filename.includes("_face_closeup") || img.filename.includes("_head_shoulders") || img.filename.includes("_upper_body") || img.filename.includes("_manual_crop") || img.filename.includes("_mask_extract");
                    const isRaw = img.filename.endsWith("_raw.png");
                    const cropLabel = img.filename.includes("_face_closeup") ? "Face" : img.filename.includes("_head_shoulders") ? "H&S" : img.filename.includes("_upper_body") ? "Upper" : img.filename.includes("_manual_crop") ? "Crop" : img.filename.includes("_mask_extract") ? "Extract" : null;
                    return (
                      <div
                        key={img.id}
                        className={`relative group rounded-lg overflow-hidden border bg-black/20 aspect-square ${
                          isCrop ? "border-cyan-500/40" : isRaw ? "border-amber-500/40" : "border-border"
                        }`}
                      >
                        <img
                          src={`/api/lora-factory/image?dataset=${datasetName}&file=${img.filename}`}
                          alt={img.filename}
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors" />
                        {/* Action buttons on hover */}
                        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingImage(img); }}
                            className="p-1 rounded-full bg-black/60 text-white hover:bg-orange-600"
                            title="Crop / Mask & Extract"
                          >
                            <Scissors className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRemoveImage(img.id); }}
                            className="p-1 rounded-full bg-black/60 text-white hover:bg-destructive"
                            title="Remove from dataset"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                        {/* Crop type badge */}
                        {cropLabel && (
                          <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded-full bg-cyan-500/80 text-[7px] font-medium text-white">
                            <Crop className="w-2 h-2 inline mr-0.5" />{cropLabel}
                          </div>
                        )}
                        {isRaw && (
                          <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded-full bg-amber-500/80 text-[7px] font-medium text-white">
                            <Camera className="w-2 h-2 inline mr-0.5" />RAW
                          </div>
                        )}
                        <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-gradient-to-t from-black/70 to-transparent">
                          <p className="text-[8px] text-white/80 truncate">{img.filename}</p>
                          <p className="text-[7px] text-white/50">{img.width > 0 ? `${img.width}×${img.height}` : "..."}</p>
                        </div>
                        {img.caption && (
                          <div className="absolute top-1 left-1">
                            {!cropLabel && !isRaw && <Tag className="w-3 h-3 text-green-400" />}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {/* ═══════════════ CAPTION STEP ═══════════════ */}
        {step === "caption" && (
          <div className="flex flex-col h-[calc(100vh-160px)] min-h-0">
            {/* Caption Guidance (collapsible) */}
            {showGuide && (
              <div className="flex-shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 mb-2">
                <div className="flex items-start justify-between">
                  <p className="text-[11px] text-amber-400 font-medium flex items-center gap-1.5">
                    <HelpCircle className="w-3.5 h-3.5" /> Captioning Guide
                  </p>
                  <button onClick={() => setShowGuide(false)} className="text-amber-400/50 hover:text-amber-400">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <p className="text-[9px] text-amber-300/70 mt-1">Start each caption with your trigger word. Use comma-separated tags describing what varies (clothing, expression, setting). Click Auto-Caption for an AI starting point, then refine.</p>
              </div>
            )}
            {!showGuide && (
              <button onClick={() => setShowGuide(true)} className="flex-shrink-0 text-[9px] text-amber-400/50 hover:text-amber-400 flex items-center gap-1 mb-2">
                <HelpCircle className="w-3 h-3" /> Show guide
              </button>
            )}

            {/* Header with action buttons */}
            <div className="flex-shrink-0 flex items-center justify-between mb-2">
              <div>
                <h3 className="text-sm font-medium text-orange-400">Auto-Caption & Review</h3>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {captionedCount}/{images.length} captioned.
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                <Button
                  size="sm"
                  className="h-6 text-[9px] bg-orange-600 hover:bg-orange-700"
                  onClick={handleAutoCaption}
                  disabled={captioning || images.length === 0}
                >
                  {captioning ? (
                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Captioning...</>
                  ) : (
                    <><Sparkles className="w-3 h-3 mr-1" /> Auto-Caption All</>
                  )}
                </Button>
                <Button size="sm" variant="outline" className="h-6 text-[9px]" onClick={handleSaveCaptions}>
                  <FileText className="w-3 h-3 mr-1" /> Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[9px] border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                  onClick={handleWriteMetadata}
                  disabled={writingMetadata || captioning || images.length === 0}
                >
                  {writingMetadata ? (
                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Writing...</>
                  ) : (
                    <><Camera className="w-3 h-3 mr-1" /> Embed in Images</>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[9px] border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                  onClick={handleReadMetadata}
                  disabled={writingMetadata || captioning || images.length === 0}
                >
                  <Camera className="w-3 h-3 mr-1" /> Read from Images
                </Button>
              </div>
            </div>

            {/* Caption editor (fixed height) */}
            <div className="flex-shrink-0 border border-border rounded-lg overflow-hidden mb-2">
              {selectedImage ? (
                <div className="flex gap-3 p-2">
                  {/* Image preview */}
                  <div className="flex-shrink-0 bg-black/20 rounded-lg flex items-center justify-center p-1">
                    <img
                      src={`/api/lora-factory/image?dataset=${datasetName}&file=${selectedImage.filename}`}
                      alt={selectedImage.filename}
                      className="max-w-[160px] max-h-[140px] object-contain rounded"
                    />
                  </div>
                  {/* Caption fields */}
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium truncate">{selectedImage.filename}</span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-5 text-[9px] border-orange-500/30 text-orange-400 hover:bg-orange-500/10"
                          onClick={() => handleSingleCaption(selectedImage.id)}
                          disabled={captioningSingle || captioning}
                        >
                          {captioningSingle ? (
                            <><Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" /> Captioning...</>
                          ) : (
                            <><Sparkles className="w-2.5 h-2.5 mr-1" /> Auto-Caption This</>
                          )}
                        </Button>
                        <span className="text-[9px] text-muted-foreground">
                          {selectedImage.width}×{selectedImage.height}
                        </span>
                      </div>
                    </div>
                    <textarea
                      value={selectedImage.caption}
                      onChange={(e) => handleCaptionChange(selectedImage.id, e.target.value)}
                      placeholder="Enter comma-separated tags or a natural language caption..."
                      className="w-full h-16 rounded border border-border bg-background px-2 py-1 text-[11px] resize-none focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                    />
                    {/* Tag chips */}
                    {selectedImage.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 max-h-12 overflow-y-auto">
                        {selectedImage.tags.map((tag, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-orange-500/10 border border-orange-500/30 text-[9px] text-orange-300"
                          >
                            {tag}
                            <button
                              onClick={() => handleRemoveTag(selectedImage.id, i)}
                              className="hover:text-destructive"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-16 text-muted-foreground/50 text-[11px]">
                  Select an image below to edit its caption
                </div>
              )}
            </div>

            {/* Horizontal thumbnail strip (fills remaining space) */}
            <div className="flex-1 min-h-0 border border-border rounded-lg p-2">
              <div className="flex gap-1.5 overflow-x-auto h-full items-start pb-1">
                {images.map((img) => (
                  <button
                    key={img.id}
                    onClick={() => setSelectedImageId(img.id)}
                    className={`relative flex-shrink-0 rounded-md overflow-hidden transition-all ${
                      selectedImageId === img.id
                        ? "ring-2 ring-orange-500 ring-offset-1 ring-offset-background"
                        : "opacity-70 hover:opacity-100"
                    }`}
                    title={img.filename}
                  >
                    <img
                      src={`/api/lora-factory/image?dataset=${datasetName}&file=${img.filename}`}
                      alt={img.filename}
                      className="w-16 h-16 object-cover"
                    />
                    {/* Caption status indicator */}
                    <div className={`absolute bottom-0 left-0 right-0 h-1 ${img.caption ? "bg-green-500" : "bg-amber-500"}`} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ CONFIGURE STEP ═══════════════ */}
        {step === "configure" && (
          <>
            {/* Configure Guidance */}
            {showGuide && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2.5">
                <div className="flex items-start justify-between">
                  <p className="text-[11px] text-amber-400 font-medium flex items-center gap-1.5">
                    <HelpCircle className="w-3.5 h-3.5" /> Configuration Guide
                  </p>
                  <button onClick={() => setShowGuide(false)} className="text-amber-400/50 hover:text-amber-400">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="text-[10px] leading-relaxed text-amber-300/80 space-y-2">
                  <p><strong>Presets</strong> give you battle-tested defaults. Start with a preset and only adjust if needed:</p>
                  <ul className="list-disc list-inside ml-1 space-y-1 text-amber-300/70">
                    <li><strong>Character</strong>: For a specific person or character&apos;s face/body. Rank 32, 20 epochs.</li>
                    <li><strong>Style</strong>: For an art style (e.g., watercolor, anime). Higher rank (64), more epochs (30).</li>
                    <li><strong>Concept</strong>: For an object or concept (e.g., a car model, a building). Lower rank (16), fewer epochs.</li>
                  </ul>
                  <p><strong>Key settings explained:</strong></p>
                  <ul className="list-disc list-inside ml-1 space-y-1 text-amber-300/70">
                    <li><strong>Base Model</strong>: The checkpoint your LoRA trains on; it works best with that model and close relatives. Trainable + commercially clean: <strong>SD 1.5</strong>, <strong>SDXL</strong>, and <strong>Pony</strong> (Pony is SDXL-based, so it trains through the SDXL path).</li>
                    <li><strong>Trigger Word</strong>: A unique token (like &quot;ohwx&quot;) that activates your LoRA in prompts. Must be in your captions.</li>
                    <li><strong>Rank</strong>: How much the LoRA can learn. Higher = more detail but larger file and risk of overfitting. 16-32 is usually ideal.</li>
                    <li><strong>Epochs</strong>: How many times training loops through your dataset. Too few = underfitting, too many = overfitting.</li>
                    <li><strong>Learning Rate</strong>: How fast the model learns. Too high = unstable, too low = slow. The presets have good defaults.</li>
                  </ul>
                  <p className="flex items-center gap-1"><Info className="w-3 h-3" /> <strong>Batch size 2</strong> is the default: your 16GB VRAM handles SD1.5, SDXL, and Pony comfortably. You can push to batch 3–4 for SD1.5 if you want faster training.</p>
                  <p className="flex items-center gap-1"><Info className="w-3 h-3" /> <strong>Licensing:</strong> SD1.5 &amp; SDXL are OpenRAIL (commercial OK); Pony is under the Fair AI Public License 1.0-SD (commercial OK). Your trained LoRA is yours.</p>
                </div>
              </div>
            )}
            {!showGuide && (
              <button onClick={() => setShowGuide(true)} className="text-[9px] text-amber-400/50 hover:text-amber-400 flex items-center gap-1">
                <HelpCircle className="w-3 h-3" /> Show guide
              </button>
            )}

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-orange-400">Training Configuration</h3>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Select a preset and fine-tune parameters. {images.length} images, ~{images.length * config.epochs} total steps.
                </p>
              </div>
            </div>

            {/* Preset selector */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">Preset:</span>
              {(["character", "style", "concept", "custom"] as LoraTrainingPreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => applyPreset(p)}
                  className={`px-3 py-1 rounded-md text-[10px] font-medium border transition-colors capitalize ${
                    config.preset === p
                      ? "bg-orange-500/20 border-orange-500/50 text-orange-400"
                      : "border-border text-muted-foreground hover:border-orange-500/30"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Left column: Model & Identity */}
              <div className="space-y-3">
                <div className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-medium text-orange-400">Base Model</p>
                    {/* Model family: checkpoint-based (sd-scripts) vs Z-Image (musubi-tuner) */}
                    <div className="flex gap-1">
                      {([["checkpoint", "Checkpoint"], ["zimage", "Z-Image"]] as const).map(([fam, label]) => {
                        const active = fam === "zimage" ? config.baseModelArch === "zimage" : config.baseModelArch !== "zimage";
                        return (
                          <button
                            key={fam}
                            onClick={() => {
                              if (fam === "zimage") {
                                updateConfig("baseModelArch", "zimage");
                                updateConfig("resolution", 1024);
                                updateConfig("mixedPrecision", "bf16");
                                // Z-Image DiT @1024px is VRAM-heavy on 16GB even with fp8,
                                // default to batch 1 (user can raise if it fits).
                                updateConfig("batchSize", 1);
                              } else {
                                const arch = config.baseModel ? getCheckpointArch(checkpointSizes[config.baseModel], config.baseModel) : "sd15";
                                updateConfig("baseModelArch", arch);
                                updateConfig("resolution", arch === "sdxl" ? 1024 : 512);
                              }
                            }}
                            className={`px-2 py-0.5 rounded text-[9px] border transition-colors ${
                              active
                                ? "bg-orange-500/20 border-orange-500/50 text-orange-400"
                                : "border-border text-muted-foreground hover:border-orange-500/30"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {config.baseModelArch !== "zimage" ? (
                    <>
                      <select
                        value={config.baseModel}
                        onChange={(e) => {
                          updateConfig("baseModel", e.target.value);
                          const arch = getCheckpointArch(checkpointSizes[e.target.value], e.target.value);
                          updateConfig("baseModelArch", arch);
                          updateConfig("resolution", arch === "sdxl" ? 1024 : 512);
                        }}
                        className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                      >
                        <option value="">Select checkpoint...</option>
                        {checkpoints.map((ckpt) => (
                          <option key={ckpt} value={ckpt}>{ckpt}</option>
                        ))}
                      </select>
                      {config.baseModel ? (
                        <p className="text-[9px] text-muted-foreground">
                          Architecture: {config.baseModelArch.toUpperCase()} · Resolution: {config.resolution}px
                        </p>
                      ) : (
                        <p className="text-[9px] text-muted-foreground">
                          Trainable architectures: <strong>SD 1.5</strong>, <strong>SDXL</strong>, <strong>Pony</strong> (SDXL-based). Architecture is auto-detected from the checkpoint.
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[9px] text-muted-foreground">
                        Z-Image trains from three files. Defaults match the <span className="font-mono">Comfy-Org/z_image</span> pack: override if your filenames differ.
                      </p>
                      {/* DiT (base recommended) */}
                      <div className="space-y-0.5">
                        <span className="text-[9px] text-muted-foreground">DiT (transformer): use the Base model</span>
                        <select
                          value={config.ditModel ?? ""}
                          onChange={(e) => updateConfig("ditModel", e.target.value)}
                          className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                        >
                          {withCurrent(diffusionModels, config.ditModel).map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      {/* VAE */}
                      <div className="space-y-0.5">
                        <span className="text-[9px] text-muted-foreground">VAE</span>
                        <select
                          value={config.vaeModel ?? ""}
                          onChange={(e) => updateConfig("vaeModel", e.target.value)}
                          className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                        >
                          {withCurrent(vaes, config.vaeModel).map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      {/* Text encoder (Qwen3) */}
                      <div className="space-y-0.5">
                        <span className="text-[9px] text-muted-foreground">Text encoder (Qwen3)</span>
                        <select
                          value={config.textEncoder ?? ""}
                          onChange={(e) => updateConfig("textEncoder", e.target.value)}
                          className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                        >
                          {withCurrent(textEncoders, config.textEncoder).map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>

                      {/* Turbo-drift / memory options */}
                      <div className="rounded border border-border/60 bg-muted/10 p-2 space-y-1.5">
                        <p className="text-[9px] font-medium text-orange-400/90 flex items-center gap-1">
                          <Zap className="w-3 h-3" /> Turbo-drift &amp; VRAM
                        </p>
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-muted-foreground">fp8 DiT (fits 16GB, slight quality cost)</span>
                          <Switch checked={config.fp8Base ?? true} onCheckedChange={(v) => updateConfig("fp8Base", v)} />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-muted-foreground">fp8 text encoder</span>
                          <Switch checked={config.fp8Llm ?? true} onCheckedChange={(v) => updateConfig("fp8Llm", v)} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[9px] text-muted-foreground">Blocks to swap to CPU (0–28)</span>
                          <input
                            type="number"
                            min={0}
                            max={28}
                            value={config.blocksToSwap ?? 0}
                            onChange={(e) => updateConfig("blocksToSwap", Math.max(0, Math.min(28, parseInt(e.target.value) || 0)))}
                            className="w-14 h-6 rounded border border-border bg-background px-2 text-[10px] text-center focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[9px] text-muted-foreground">Turbo training adapter (optional, for Turbo DiT)</span>
                          <input
                            type="text"
                            value={config.turboAdapter ?? ""}
                            onChange={(e) => updateConfig("turboAdapter", e.target.value)}
                            placeholder="e.g. zimage_turbo_training_adapter_v2.safetensors"
                            className="w-full h-6 rounded border border-border bg-background px-2 text-[9px] font-mono focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                          />
                        </div>
                        <p className="text-[8px] text-muted-foreground/70 leading-relaxed">
                          Leave the adapter empty when training the <strong>Base</strong> DiT (recommended). Only set it if you point DiT at the distilled <strong>Turbo</strong> weights.
                        </p>
                      </div>
                      <p className="text-[9px] text-muted-foreground">Route: musubi-tuner · Resolution: {config.resolution}px</p>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-[10px] font-medium text-orange-400">Identity</p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">Trigger word:</span>
                    <input
                      type="text"
                      value={config.triggerWord}
                      onChange={(e) => updateConfig("triggerWord", e.target.value)}
                      className="flex-1 h-7 rounded border border-border bg-background px-2 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                    />
                  </div>
                  <p className="text-[9px] text-muted-foreground">
                    This word will identify your subject in prompts. Use something unique like &quot;ohwx&quot; or &quot;sks&quot;.
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">Output name:</span>
                    <input
                      type="text"
                      value={config.outputName}
                      onChange={(e) => updateConfig("outputName", e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_"))}
                      className="flex-1 h-7 rounded border border-border bg-background px-2 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                    />
                    <span className="text-[9px] text-muted-foreground">.safetensors</span>
                  </div>
                </div>

                <div className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-[10px] font-medium text-orange-400">Network Architecture</p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Rank (dim):</span>
                    <div className="flex gap-1">
                      {LORA_RANK_OPTIONS.map((r) => (
                        <button
                          key={r}
                          onClick={() => { updateConfig("networkRank", r); updateConfig("networkAlpha", Math.floor(r / 2)); }}
                          className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                            config.networkRank === r
                              ? "bg-orange-500/20 border-orange-500/50 text-orange-400"
                              : "border-border text-muted-foreground hover:border-orange-500/30"
                          }`}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Alpha:</span>
                    <input
                      type="number"
                      value={config.networkAlpha}
                      onChange={(e) => updateConfig("networkAlpha", parseInt(e.target.value) || 1)}
                      className="w-16 h-6 rounded border border-border bg-background px-2 text-[10px] text-center focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                    />
                    <span className="text-[9px] text-muted-foreground">
                      (rank/2 = {Math.floor(config.networkRank / 2)} recommended)
                    </span>
                  </div>
                </div>
              </div>

              {/* Right column: Training params */}
              <div className="space-y-3">
                <div className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-[10px] font-medium text-orange-400">Training Parameters</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-[9px] text-muted-foreground">Epochs</span>
                        <span className="text-[9px] font-mono text-muted-foreground">{config.epochs}</span>
                      </div>
                      <input type="range" min={1} max={100} step={1} value={config.epochs}
                        onChange={(e) => updateConfig("epochs", parseInt(e.target.value))}
                        className="w-full h-1.5 accent-orange-500" />
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-[9px] text-muted-foreground">Batch Size</span>
                        <span className="text-[9px] font-mono text-muted-foreground">{config.batchSize}</span>
                      </div>
                      <input type="range" min={1} max={4} step={1} value={config.batchSize}
                        onChange={(e) => updateConfig("batchSize", parseInt(e.target.value))}
                        className="w-full h-1.5 accent-orange-500" />
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex justify-between">
                      <span className="text-[9px] text-muted-foreground">Save Checkpoint Every N Epochs</span>
                      <span className="text-[9px] font-mono text-muted-foreground">{config.saveEveryNEpochs}</span>
                    </div>
                    <input type="range" min={1} max={20} step={1} value={config.saveEveryNEpochs}
                      onChange={(e) => updateConfig("saveEveryNEpochs", parseInt(e.target.value))}
                      className="w-full h-1.5 accent-orange-500" />
                  </div>
                </div>

                <div className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-[10px] font-medium text-orange-400">Optimizer & Scheduler</p>
                  <select
                    value={config.optimizerType}
                    onChange={(e) => updateConfig("optimizerType", e.target.value)}
                    className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                  >
                    {LORA_OPTIMIZER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <select
                    value={config.lrScheduler}
                    onChange={(e) => updateConfig("lrScheduler", e.target.value)}
                    className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                  >
                    {LORA_SCHEDULER_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                  <div className={config.baseModelArch === "zimage" ? "grid grid-cols-1 gap-2" : "grid grid-cols-3 gap-2"}>
                    <div className="space-y-0.5">
                      <span className="text-[9px] text-muted-foreground">Learning Rate</span>
                      <input type="text" value={config.learningRate}
                        onChange={(e) => updateConfig("learningRate", parseFloat(e.target.value) || 1e-4)}
                        className="w-full h-6 rounded border border-border bg-background px-2 text-[9px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-orange-500/50" />
                    </div>
                    {config.baseModelArch !== "zimage" && (
                      <>
                        <div className="space-y-0.5">
                          <span className="text-[9px] text-muted-foreground">UNet LR</span>
                          <input type="text" value={config.unetLr}
                            onChange={(e) => updateConfig("unetLr", parseFloat(e.target.value) || 1e-4)}
                            className="w-full h-6 rounded border border-border bg-background px-2 text-[9px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-orange-500/50" />
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[9px] text-muted-foreground">TE LR</span>
                          <input type="text" value={config.textEncoderLr}
                            onChange={(e) => updateConfig("textEncoderLr", parseFloat(e.target.value) || 5e-5)}
                            className="w-full h-6 rounded border border-border bg-background px-2 text-[9px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-orange-500/50" />
                        </div>
                      </>
                    )}
                  </div>
                  {config.baseModelArch === "zimage" && (
                    <p className="text-[9px] text-muted-foreground">Z-Image trains the DiT only: a single learning rate applies. The Qwen3 text encoder is frozen and its outputs are pre-cached, so there is no separate UNet/text-encoder LR.</p>
                  )}
                </div>

                <div className="rounded-lg border border-border p-3 space-y-2">
                  <p className="text-[10px] font-medium text-orange-400">Augmentation & Options</p>
                  {config.baseModelArch !== "zimage" && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">Shuffle captions (randomize tag order)</span>
                        <Switch checked={config.shuffleCaptions} onCheckedChange={(v) => updateConfig("shuffleCaptions", v)} />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground">Horizontal flip augmentation</span>
                        <Switch checked={config.flipAugmentation} onCheckedChange={(v) => updateConfig("flipAugmentation", v)} />
                      </div>
                    </>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">Gradient checkpointing (saves VRAM)</span>
                    <Switch checked={config.gradientCheckpointing} onCheckedChange={(v) => updateConfig("gradientCheckpointing", v)} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">Mixed precision:</span>
                    {(["fp16", "bf16", "no"] as const).map((mp) => (
                      <button
                        key={mp}
                        onClick={() => updateConfig("mixedPrecision", mp)}
                        className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                          config.mixedPrecision === mp
                            ? "bg-orange-500/20 border-orange-500/50 text-orange-400"
                            : "border-border text-muted-foreground hover:border-orange-500/30"
                        }`}
                      >
                        {mp}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ═══════════════ TRAIN STEP ═══════════════ */}
        {step === "train" && (
          <>
            {/* Train Guidance */}
            {showGuide && training.status === "idle" && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5">
                <div className="flex items-start justify-between">
                  <p className="text-[11px] text-amber-400 font-medium flex items-center gap-1.5">
                    <HelpCircle className="w-3.5 h-3.5" /> Training Guide
                  </p>
                  <button onClick={() => setShowGuide(false)} className="text-amber-400/50 hover:text-amber-400">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="text-[10px] text-amber-300/80 space-y-1">
                  <p><strong>What happens during training?</strong> The AI model looks at each of your captioned images many times (epochs), gradually learning to associate your trigger word with your subject&apos;s appearance.</p>
                  <p><strong>How long?</strong> Typically 20-60 minutes on your GPU, depending on dataset size and epoch count. The progress bar and ETA will keep you updated.</p>
                  <p><strong>Understanding the loss graph:</strong></p>
                  <ul className="list-disc list-inside ml-1 space-y-0.5 text-amber-300/70">
                    <li><strong>Loss should decrease</strong>: This means the model is learning. A gradual downward trend is ideal.</li>
                    <li><strong>Loss plateaus</strong>: Normal! The model has learned most of what it can. Training beyond this point risks overfitting.</li>
                    <li><strong>Loss spikes up</strong>: Learning rate may be too high, or there&apos;s a problematic image in your dataset.</li>
                    <li><strong>Typical good loss range</strong>: Between 0.05-0.15 for character LoRAs.</li>
                  </ul>
                  <p><strong>Checkpoints</strong> are saved periodically (every N epochs). If the final result is overfit, you can use an earlier checkpoint from <span className="font-mono text-[9px]">lora-factory/output/</span>.</p>
                  <p className="flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> <strong>Important:</strong> Close ComfyUI and other GPU-heavy apps before training to free VRAM. Training needs as much GPU memory as possible.</p>
                </div>
              </div>
            )}
            {!showGuide && training.status === "idle" && (
              <button onClick={() => setShowGuide(true)} className="text-[9px] text-amber-400/50 hover:text-amber-400 flex items-center gap-1">
                <HelpCircle className="w-3 h-3" /> Show guide
              </button>
            )}

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-orange-400">Training</h3>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {training.status === "idle" && "Ready to start training. This may take 20-60 minutes."}
                  {training.status === "preparing" && "Preparing dataset and model..."}
                  {training.status === "training" && `Epoch ${training.epoch}/${training.totalEpochs} · Step ${training.step}/${training.totalSteps}`}
                  {training.status === "complete" && "Training complete!"}
                  {training.status === "error" && `Error: ${training.error}`}
                </p>
              </div>
              {training.status === "idle" && (
                <Button
                  size="sm"
                  className="h-7 text-[10px] bg-orange-600 hover:bg-orange-700"
                  onClick={handleStartTraining}
                >
                  <Zap className="w-3 h-3 mr-1" /> Start Training
                </Button>
              )}
            </div>

            {/* Progress bar */}
            {(training.status === "training" || training.status === "preparing") && (
              <div className="space-y-2">
                <div className="w-full h-2 bg-muted/30 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-orange-500 transition-all duration-300"
                    style={{ width: training.totalSteps > 0 ? `${(training.step / training.totalSteps) * 100}%` : "0%" }}
                  />
                </div>
                <div className="flex justify-between text-[9px] text-muted-foreground">
                  <span>Loss: {training.loss.toFixed(4)}</span>
                  <span>
                    {training.elapsedSec > 0 && `${Math.floor(training.elapsedSec / 60)}m elapsed`}
                    {training.estimatedRemainingSec > 0 && ` · ~${Math.floor(training.estimatedRemainingSec / 60)}m remaining`}
                  </span>
                </div>
              </div>
            )}

            {/* Loss graph (simple ASCII-style for now, can upgrade later) */}
            {(training.lossHistory?.length ?? 0) > 1 && (
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] font-medium text-orange-400 mb-2">Loss History</p>
                <div className="h-32 flex items-end gap-px">
                  {training.lossHistory.slice(-100).map((loss, i) => {
                    const max = Math.max(...training.lossHistory.slice(-100));
                    const h = max > 0 ? (loss / max) * 100 : 0;
                    return (
                      <div
                        key={i}
                        className="flex-1 bg-orange-500/60 rounded-t-sm min-w-[2px]"
                        style={{ height: `${h}%` }}
                        title={`Step ${i}: ${loss.toFixed(4)}`}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sample images */}
            {training.sampleImages.length > 0 && (
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] font-medium text-orange-400 mb-2">Sample Outputs</p>
                <div className="grid grid-cols-4 gap-2">
                  {training.sampleImages.map((url, i) => (
                    <img key={i} src={url} alt={`Sample ${i}`} className="rounded border border-border" />
                  ))}
                </div>
              </div>
            )}

            {training.status === "error" && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
                <p className="text-[11px] text-destructive">{training.error}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px] mt-2"
                  onClick={() => setTraining((prev) => ({ ...prev, status: "idle", error: undefined }))}
                >
                  <RotateCcw className="w-3 h-3 mr-1" /> Retry
                </Button>
              </div>
            )}
          </>
        )}

        {/* ═══════════════ DONE STEP ═══════════════ */}
        {step === "done" && (
          <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
              <Check className="w-8 h-8 text-green-400" />
            </div>
            <h3 className="text-lg font-medium text-green-400">LoRA Training Complete!</h3>
            <p className="text-[11px] text-muted-foreground text-center max-w-md">
              Your LoRA <span className="font-mono text-orange-400">{config.outputName}.safetensors</span> has been saved to{" "}
              <span className="font-mono text-muted-foreground/80">ComfyUI/models/loras/</span> and is ready to use.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-8 bg-orange-600 hover:bg-orange-700"
                onClick={() => {
                  setStep("dataset");
                  setImages([]);
                  setConfig(DEFAULT_TRAINING_CONFIG);
                  setTraining({ status: "idle", epoch: 0, totalEpochs: 0, step: 0, totalSteps: 0, loss: 0, lossHistory: [], sampleImages: [], elapsedSec: 0, estimatedRemainingSec: 0 });
                }}
              >
                Train Another LoRA
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Dataset Image Editor Modal */}
      {editingImage && (
        <DatasetImageEditor
          imageUrl={`/api/lora-factory/image?dataset=${datasetName}&file=${editingImage.filename}`}
          filename={editingImage.filename}
          datasetName={datasetName}
          onSave={(newFilename, width, height) => {
            setImages((prev) => [...prev, {
              id: `edit_${newFilename}_${Date.now()}`,
              filename: newFilename,
              serverPath: "",
              caption: "",
              tags: [],
              width,
              height,
              sizeBytes: 0,
            }]);
            setEditingImage(null);
          }}
          onClose={() => setEditingImage(null)}
        />
      )}

      {/* Navigation footer */}
      {step !== "done" && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/10">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[10px]"
            onClick={() => setStep(STEPS[stepIndex - 1]?.key || "dataset")}
            disabled={stepIndex === 0}
          >
            <ChevronLeft className="w-3 h-3 mr-1" /> Back
          </Button>
          <div className="text-[9px] text-muted-foreground">
            Step {stepIndex + 1} of {STEPS.length}
          </div>
          {step !== "train" ? (
            <Button
              size="sm"
              className="h-7 text-[10px] bg-orange-600 hover:bg-orange-700"
              onClick={() => {
                if (step === "caption") handleSaveCaptions();
                setStep(STEPS[stepIndex + 1]?.key || "done");
              }}
              disabled={!canAdvance}
            >
              Next <ChevronRight className="w-3 h-3 ml-1" />
            </Button>
          ) : (
            <div />
          )}
        </div>
      )}
    </div>
  );
}
