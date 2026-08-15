"use client";

import { useEffect } from "react";
import { applyThemeAdjustment } from "./PanelDarknessSlider";

/**
 * Invisible component that applies the saved panel adjustment on mount.
 * Works for both dark (darken) and light (dim) modes.
 * Must be rendered inside ThemeProvider so the .dark class is already present.
 */
export default function DarknessInitializer() {
  useEffect(() => {
    applyThemeAdjustment();
  }, []);
  return null;
}
