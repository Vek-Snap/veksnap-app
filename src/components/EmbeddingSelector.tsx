"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Sparkles, RefreshCw } from "lucide-react";
import { EmbeddingEntry } from "@/lib/types";

interface Props {
  embeddings: EmbeddingEntry[];
  onChange: (embeddings: EmbeddingEntry[]) => void;
}

export default function EmbeddingSelector({ embeddings, onChange }: Props) {
  const [availableEmbeddings, setAvailableEmbeddings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  const loadEmbeddings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/embedding-files");
      if (!res.ok) throw new Error(`${res.status}`);
      const list: string[] = await res.json();
      setAvailableEmbeddings(list);
    } catch {
      // Embedding loading is non-critical
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEmbeddings();
  }, [loadEmbeddings]);

  // Toggle an embedding on/off: add if missing, toggle enabled if present
  const toggleEmbedding = (name: string) => {
    const existing = embeddings.find((e) => e.name === name);
    if (existing) {
      // Toggle enabled state
      onChange(
        embeddings.map((e) =>
          e.name === name ? { ...e, enabled: !e.enabled } : e
        )
      );
    } else {
      // Add new embedding: auto-assign to negative if name suggests it
      const isNeg = /neg|bad|worst|ugly|deform/i.test(name);
      onChange([...embeddings, { enabled: true, name, target: isNeg ? "negative" : "positive" }]);
    }
  };

  // Toggle target between positive and negative
  const toggleTarget = (name: string) => {
    onChange(
      embeddings.map((e) =>
        e.name === name
          ? { ...e, target: e.target === "positive" ? "negative" : "positive" }
          : e
      )
    );
  };

  const enabledCount = embeddings.filter((e) => e.enabled).length;

  // Build lookup for quick status check
  const entryMap = new Map(embeddings.map((e) => [e.name, e]));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-2 flex-1 text-left"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Sparkles className="w-4 h-4" />
            Embeddings
            {enabledCount > 0 && (
              <span className="text-[10px] text-cyan-400 font-normal">
                ({enabledCount} active)
              </span>
            )}
          </button>
          {expanded && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
              onClick={loadEmbeddings}
              disabled={loading}
              title="Refresh embedding list"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-1.5">
          {loading && availableEmbeddings.length === 0 && (
            <p className="text-[10px] text-muted-foreground">Loading embeddings...</p>
          )}
          {!loading && availableEmbeddings.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              No embeddings found in ComfyUI/models/embeddings/
            </p>
          )}

          {availableEmbeddings.map((name) => {
            const entry = entryMap.get(name);
            const isEnabled = entry?.enabled ?? false;
            const target = entry?.target ?? "positive";

            return (
              <div
                key={name}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
                  isEnabled
                    ? "border-border bg-background"
                    : "border-border/50 bg-muted/20 opacity-60"
                }`}
              >
                {/* Enable/disable toggle */}
                <Switch
                  checked={isEnabled}
                  onCheckedChange={() => toggleEmbedding(name)}
                  className="scale-75"
                />

                {/* Embedding name */}
                <span className="flex-1 text-[11px] truncate" title={name}>
                  {name}
                </span>

                {/* Positive/Negative target toggle */}
                {isEnabled && (
                  <button
                    type="button"
                    onClick={() => toggleTarget(name)}
                    className={`text-[9px] font-medium px-2 py-0.5 rounded-full transition-colors ${
                      target === "positive"
                        ? "bg-green-500/15 text-green-400 hover:bg-green-500/25"
                        : "bg-red-500/15 text-red-400 hover:bg-red-500/25"
                    }`}
                    title={`Click to switch to ${target === "positive" ? "negative" : "positive"} prompt`}
                  >
                    {target === "positive" ? "POS" : "NEG"}
                  </button>
                )}
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}
