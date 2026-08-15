import type { Metadata } from "next";
import localFont from "next/font/local";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import VlapInit from "@/components/VlapInit";
import DarknessInitializer from "@/components/DarknessInitializer";
import PointerEventsGuard from "@/components/PointerEventsGuard";
import ToastProvider from "@/components/ToastProvider";
import { ComfyOpenProvider } from "@/components/ComfyOpenProvider";
import CpuModeNotice from "@/components/CpuModeNotice";
import { MediaPlayerProvider } from "@/components/media/MediaPlayer";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Vek-Snap™",
  description: "AI Creative Studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Blocking script: apply saved theme + darkness/dim adjustments BEFORE first paint to prevent FOUC */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{
var t=localStorage.getItem("theme");
if(t==="light")document.documentElement.classList.remove("dark");
else if(t==="dark")document.documentElement.classList.add("dark");
else if(t==="system"){if(window.matchMedia("(prefers-color-scheme:dark)").matches)document.documentElement.classList.add("dark");else document.documentElement.classList.remove("dark")}
else document.documentElement.classList.add("dark"); // first run: default to DARK (light/system still selectable)
var isDark=document.documentElement.classList.contains("dark");
function mix(hex,amt){var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
var nr=Math.round(r-r*amt),ng=Math.round(g-g*amt),nb=Math.round(b-b*amt);
return"#"+(nr<16?"0":"")+nr.toString(16)+(ng<16?"0":"")+ng.toString(16)+(nb<16?"0":"")+nb.toString(16)}
function apply(base,amt){var s=document.documentElement.style;
s.setProperty("--background",mix(base[0],amt));s.setProperty("--card",mix(base[1],amt));
s.setProperty("--popover",mix(base[2],amt));s.setProperty("--secondary",mix(base[3],amt));
s.setProperty("--muted",mix(base[4],amt));s.setProperty("--accent",mix(base[5],amt));
s.setProperty("--border",mix(base[6],amt));s.setProperty("--input",mix(base[7],amt));
s.setProperty("--sidebar",mix(base[8],amt));s.setProperty("--sidebar-accent",mix(base[9],amt))}
var DB=["#1e1e2e","#1e1e2e","#1e1e2e","#313244","#313244","#313244","#45475a","#45475a","#181825","#1e1e2e"];
var LB=["#eff1f5","#eff1f5","#eff1f5","#ccd0da","#ccd0da","#ccd0da","#bcc0cc","#bcc0cc","#e6e9ef","#eff1f5"];
if(isDark){var v=localStorage.getItem("veksnap-panel-darkness");var a=v?parseFloat(v):0.5;apply(DB,a)}
else{var lv=localStorage.getItem("veksnap-panel-darkness-light");if(lv)apply(LB,parseFloat(lv))}
}catch(e){}})()` }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <VlapInit />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <DarknessInitializer />
          <PointerEventsGuard />
          <TooltipProvider delayDuration={300}>
            <ToastProvider>
              <ComfyOpenProvider>
                <MediaPlayerProvider>
                  <CpuModeNotice />
                  {children}
                </MediaPlayerProvider>
              </ComfyOpenProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
