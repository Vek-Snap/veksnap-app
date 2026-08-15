"use client";

import { useState, useEffect, useCallback } from "react";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Moon, Sun } from "lucide-react";

const DARK_STORAGE_KEY = "veksnap-panel-darkness";
const LIGHT_STORAGE_KEY = "veksnap-panel-darkness-light";
const DARK_DEFAULT = 0.50;  // Default darken level (~60% of max 0.85)

/**
 * Mixes a hex color toward a target (black or white) by a given amount.
 * @param hex - 6-digit hex color
 * @param amount - 0 = no change, 1 = fully target color
 * @param target - "black" or "white"
 */
function mixHex(hex: string, amount: number, target: "black" | "white"): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const t = target === "black" ? 0 : 255;
  const nr = Math.round(r + (t - r) * amount);
  const ng = Math.round(g + (t - g) * amount);
  const nb = Math.round(b + (t - b) * amount);
  return `#${nr.toString(16).padStart(2, "0")}${ng.toString(16).padStart(2, "0")}${nb.toString(16).padStart(2, "0")}`;
}

// Base Catppuccin Mocha values (globals.css .dark)
const DARK_BASE = {
  background: "#1e1e2e",
  card: "#1e1e2e",
  popover: "#1e1e2e",
  secondary: "#313244",
  muted: "#313244",
  accent: "#313244",
  border: "#45475a",
  input: "#45475a",
  sidebar: "#181825",
  sidebarAccent: "#1e1e2e",
};

// Base Catppuccin Latte values (globals.css :root)
const LIGHT_BASE = {
  background: "#eff1f5",
  card: "#eff1f5",
  popover: "#eff1f5",
  secondary: "#ccd0da",
  muted: "#ccd0da",
  accent: "#ccd0da",
  border: "#bcc0cc",
  input: "#bcc0cc",
  sidebar: "#e6e9ef",
  sidebarAccent: "#eff1f5",
};

function applyToVars(base: Record<string, string>, amount: number, target: "black" | "white") {
  const root = document.documentElement;
  root.style.setProperty("--background", mixHex(base.background, amount, target));
  root.style.setProperty("--card", mixHex(base.card, amount, target));
  root.style.setProperty("--popover", mixHex(base.popover, amount, target));
  root.style.setProperty("--secondary", mixHex(base.secondary, amount, target));
  root.style.setProperty("--muted", mixHex(base.muted, amount, target));
  root.style.setProperty("--accent", mixHex(base.accent, amount, target));
  root.style.setProperty("--border", mixHex(base.border, amount, target));
  root.style.setProperty("--input", mixHex(base.input, amount, target));
  root.style.setProperty("--sidebar", mixHex(base.sidebar, amount, target));
  root.style.setProperty("--sidebar-accent", mixHex(base.sidebarAccent, amount, target));
}

export function applyDarkness(amount: number) {
  if (!document.documentElement.classList.contains("dark")) return;
  applyToVars(DARK_BASE, amount, "black");
}

export function applyLightDim(amount: number) {
  if (document.documentElement.classList.contains("dark")) return;
  applyToVars(LIGHT_BASE, amount, "black");
}

export function applyThemeAdjustment() {
  const isDark = document.documentElement.classList.contains("dark");
  if (isDark) {
    const saved = localStorage.getItem(DARK_STORAGE_KEY);
    const val = saved ? parseFloat(saved) : DARK_DEFAULT;
    applyDarkness(val);
    // Persist the default so the slider reflects it
    if (!saved) localStorage.setItem(DARK_STORAGE_KEY, String(DARK_DEFAULT));
  } else {
    const saved = localStorage.getItem(LIGHT_STORAGE_KEY);
    if (saved) applyLightDim(parseFloat(saved));
    else clearAdjustment();
  }
}

export function clearAdjustment() {
  const root = document.documentElement;
  root.style.removeProperty("--background");
  root.style.removeProperty("--card");
  root.style.removeProperty("--popover");
  root.style.removeProperty("--secondary");
  root.style.removeProperty("--muted");
  root.style.removeProperty("--accent");
  root.style.removeProperty("--border");
  root.style.removeProperty("--input");
  root.style.removeProperty("--sidebar");
  root.style.removeProperty("--sidebar-accent");
}

export default function PanelDarknessSlider() {
  const [darkness, setDarkness] = useState(DARK_DEFAULT);
  const [lightDim, setLightDim] = useState(0);
  const [isDark, setIsDark] = useState(true);

  // Load saved values and detect initial theme
  useEffect(() => {
    const dark = document.documentElement.classList.contains("dark");
    setIsDark(dark);

    const savedDark = localStorage.getItem(DARK_STORAGE_KEY);
    if (savedDark) { setDarkness(parseFloat(savedDark)); }
    else { setDarkness(DARK_DEFAULT); }

    const savedLight = localStorage.getItem(LIGHT_STORAGE_KEY);
    if (savedLight) { setLightDim(parseFloat(savedLight)); }

    // Apply for current mode
    if (dark) applyDarkness(savedDark ? parseFloat(savedDark) : DARK_DEFAULT);
    if (!dark && savedLight) applyLightDim(parseFloat(savedLight));
  }, []);

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains("dark");
      setIsDark(dark);
      clearAdjustment();
      if (dark) applyDarkness(darkness);
      else applyLightDim(lightDim);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [darkness, lightDim]);

  const handleDarkChange = useCallback(([val]: number[]) => {
    setDarkness(val);
    localStorage.setItem(DARK_STORAGE_KEY, val.toString());
    applyDarkness(val);
  }, []);

  const handleLightChange = useCallback(([val]: number[]) => {
    setLightDim(val);
    localStorage.setItem(LIGHT_STORAGE_KEY, val.toString());
    applyLightDim(val);
  }, []);

  if (isDark) {
    return (
      <div className="flex items-center gap-2 px-2 py-1">
        <Moon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <Label className="text-[10px] text-muted-foreground whitespace-nowrap">Darken</Label>
        <Slider
          value={[darkness]}
          onValueChange={handleDarkChange}
          min={0}
          max={0.85}
          step={0.02}
          className="flex-1 min-w-[80px]"
        />
        <span className="text-[9px] text-muted-foreground font-mono w-7 text-right">
          {Math.round(darkness * 100)}%
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <Sun className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <Label className="text-[10px] text-muted-foreground whitespace-nowrap">Dim</Label>
      <Slider
        value={[lightDim]}
        onValueChange={handleLightChange}
        min={0}
        max={0.6}
        step={0.02}
        className="flex-1 min-w-[80px]"
      />
      <span className="text-[9px] text-muted-foreground font-mono w-7 text-right">
        {Math.round(lightDim * 100)}%
      </span>
    </div>
  );
}
