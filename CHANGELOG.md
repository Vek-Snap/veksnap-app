# Changelog

Notable changes to Vek-Snap that affect you, the user. This project follows
[Semantic Versioning](https://semver.org).

## [1.1.2] - 2026-08-15

First public release of Vek-Snap.

### Highlights

- **Local and offline.** A complete creative AI suite for Windows, video, image, music,
  sound effects, narration, voice, and restoration, running entirely on your own PC. No
  account, no cloud, no telemetry.
- **Guided Installer.** A signed, one-click Windows installer that scans your PC, sets up a
  configured ComfyUI and Python runtime, and downloads the models you choose.
- **LTX-2.5 video.** Text-to-video, image-to-video, and First-to-Last-Frame generation with
  synchronized audio, plus an optional prompt enhancer and auto duration.
- **Continuum long-form video.** Multi-segment videos with character consistency, an
  experimental autoregressive long-form mode, and per-segment re-timing that keeps a master
  song in sync.
- **Timeline Editor.** Real WAV/MP3 voice recording, a standalone audio mixdown/export
  (WAV/FLAC/MP3/AAC/Opus/OGG with loudness normalization), and adjustment layers.
- **Library.** Custom categories with colors, privacy masking, per-category disk-usage totals,
  expanded sorting, and the ability to assign your own preview media.
- **Runs without an NVIDIA GPU for the writing tools.** Prompt Expand, Script Writer, and the
  other text tools have a CPU/AMD fallback.
- **Gated model support.** Optional "Sign in with Hugging Face" for one-click access to gated
  downloads (your account, your license acceptance).

### Security

- Updated the bundled image library (**sharp** 0.34 to 0.35) to pick up upstream libvips
  fixes, hardening how the app processes image files you open.

### Notes

- A single purchase activates up to **5 devices**. After a one-time online activation, the app
  runs **100% offline**.
- Works on NVIDIA GPUs with **8 GB VRAM and up** (16 GB recommended for the full suite,
  including video with synced audio).
