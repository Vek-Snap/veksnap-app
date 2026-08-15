"use client";

import { useState, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";

interface Props {
  positivePrompt: string;
  negativePrompt: string;
  onPositiveChange: (v: string) => void;
  onNegativeChange: (v: string) => void;
}

export default function PromptEditor({
  positivePrompt,
  negativePrompt,
  onPositiveChange,
  onNegativeChange,
}: Props) {
  const [activePreset, setActivePreset] = useState<number | null>(null);
  const presetsRef = useRef<string[] | null>(null);

  const loadPreset = useCallback(async (index: number) => {
    // Lazy-load presets on first use
    if (!presetsRef.current) {
      try {
        const res = await fetch("/prompt-presets.txt");
        const text = await res.text();
        presetsRef.current = text.split("---").map((s) => s.trim()).filter(Boolean);
      } catch {
        console.warn("Could not load prompt presets");
        presetsRef.current = [];
      }
    }
    const prompt = presetsRef.current[index];
    if (prompt) {
      onPositiveChange(prompt);
      setActivePreset(index);
    }
  }, [onPositiveChange]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <MessageSquare className="w-4 h-4" /> Prompt
          <div className="ml-auto flex gap-1">
            {[0, 1, 2, 3].map((i) => (
              <Button
                key={i}
                variant={activePreset === i ? "default" : "outline"}
                size="sm"
                className="h-5 w-5 p-0 text-[10px]"
                onClick={() => loadPreset(i)}
                title={`Load preset prompt ${i + 1}`}
              >
                {i + 1}
              </Button>
            ))}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            Positive Prompt
          </Label>
          <Textarea
            persistId="prompt-editor-positive"
            value={positivePrompt}
            onChange={(e) => { onPositiveChange(e.target.value); setActivePreset(null); }}
            placeholder="Describe the scene you want to generate... e.g. 'a woman walking through a sunlit garden, cinematic lighting, 4k quality'"
            className="min-h-[100px] text-sm resize-y"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">
            Negative Prompt
          </Label>
          <Textarea
            persistId="prompt-editor-negative"
            value={negativePrompt}
            onChange={(e) => onNegativeChange(e.target.value)}
            placeholder="What to avoid..."
            className="min-h-[60px] text-xs resize-y text-muted-foreground"
          />
        </div>
      </CardContent>
    </Card>
  );
}
