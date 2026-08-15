/**
 * Continuum (DirectorStudio): centralized palette driver.
 * ============================================================================
 * SCOPE: this file themes ONLY the Continuum tab (`DirectorStudio.tsx`). It does
 * NOT touch the program-wide palette, other studios, `ltx-theme.ts` (LTX-2),
 * `theme-classes.ts` (form controls), or `globals.css`.
 */
export const COMMERCIAL = {
  // Header
  headerBar: "flex items-center justify-between px-4 py-3 border-b border-blue-500/30 bg-blue-500/5",
  headerIcon: "w-5 h-5 text-blue-400",
  toggleActive: "bg-blue-500/20 text-blue-400 shadow-sm",
  toggleInactive: "text-muted-foreground hover:text-foreground",
  pipelineOfficialActive: "bg-emerald-500/20 text-emerald-400 shadow-sm",
  pipelineAltActive: "bg-blue-500/20 text-blue-400 shadow-sm",
  advancedBadge: "-mt-0.5 text-[8px] font-semibold uppercase tracking-wide text-orange-400 leading-none",
  // Status pills
  statusOnline: "text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-1",
  statusOnlineDot: "w-1.5 h-1.5 rounded-full bg-emerald-400",
  statusOffline: "text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center gap-1",
  statusOfflineDot: "w-1.5 h-1.5 rounded-full bg-amber-400",
  segmentsBadge: "text-[9px] text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded",
  // Sub-tabs
  subtabActive: "border-blue-500 text-blue-400 bg-blue-500/5",
  subtabActiveAlt: "border-teal-500 text-teal-400 bg-teal-500/5",
  subtabInactive: "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10",

  // ── Section cards & labels (reused across many main-pipeline sections) ──
  card: "rounded-lg border border-blue-500/30 bg-blue-500/5 p-3 space-y-3",
  sectionLabel: "text-[11px] text-blue-400 font-medium flex items-center gap-1",
  fieldLabel: "text-[9px] text-blue-400/70",
  fieldLabelRow: "text-[9px] text-blue-400/70 flex items-center gap-1",

  // ── Storyboard / keyframe pool ──
  sbImg: "w-full h-full object-cover rounded border border-blue-500/30 cursor-zoom-in",
  sbImgEmpty: "w-full h-full rounded border border-blue-500/20 bg-blue-500/5 flex items-center justify-center text-blue-400/40 text-[9px]",
  sbTag: "absolute bottom-0.5 left-0.5 text-[8px] bg-black/60 text-blue-300 px-0.5 rounded",
  sbAddTile: "w-16 h-16 rounded border border-dashed border-blue-500/20 flex flex-col items-center justify-center cursor-pointer hover:border-blue-500/40 transition-colors",
  sbAddIcon: "w-3 h-3 text-blue-400/40",
  sbAddText: "text-[8px] text-blue-400/40",
  thumbActive: "bg-blue-500/25 text-blue-300",
  dragRing: "ring-2 ring-blue-400",

  // ── Buttons (accent + destructive) ──
  outlineBtnXs: "h-6 text-[9px] px-2 border-blue-500/30 text-blue-400 hover:bg-blue-500/10",
  dangerBtnXs: "h-6 text-[9px] px-2 border-red-500/30 text-red-400 hover:bg-red-500/10",
  dangerIconMuted: "text-red-400/60 hover:text-red-400",

  // ── Master audio upload ──
  uploadTile: "flex items-center gap-2 cursor-pointer text-[9px] text-blue-400/50 hover:text-blue-400 border border-dashed border-blue-500/20 rounded px-2 py-1.5",

  // ── Recurring accent roles (used across many main-pipeline sections) ──
  iconBlue: "w-3.5 h-3.5 text-blue-400",
  outlineBtn: "h-7 text-[10px] px-3 border-blue-500/30 text-blue-400 hover:bg-blue-500/10",
  outlineBtnSm: "h-6 text-[10px] px-2 border-blue-500/30 text-blue-400 hover:bg-blue-500/10",
  selectAccent: "w-full h-7 rounded border border-blue-500/30 bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500/50",
  cardSoft2: "rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2",
  cardSoft3: "rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-3",
  collapseHeader: "flex items-center gap-1 text-[11px] text-blue-400 font-medium hover:text-blue-300 transition-colors",
  chipRow: "flex items-center flex-wrap gap-x-3 gap-y-1.5 rounded-md border border-blue-500/25 bg-blue-500/5 px-3 py-2",
  strongLabel: "text-[11px] font-semibold text-blue-300/90",
  sectionLabelPlain: "text-[11px] text-blue-400 font-medium",
  spinnerBlue: "w-3 h-3 text-blue-400 animate-spin",
  accentText50sm: "text-[10px] text-blue-400/50",
  hint50Ml: "text-[9px] text-blue-400/50 ml-1",
};

/**
 * Active Continuum theme. Point this at another theme object to re-skin the whole
 * tab (future: customer-selectable). Kept as `cc` for terse consumption in
 * DirectorStudio.tsx, e.g. className={cc.headerIcon}.
 */
export const cc = COMMERCIAL;
export type ContinuumTheme = typeof COMMERCIAL;
