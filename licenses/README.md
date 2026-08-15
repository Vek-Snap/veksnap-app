# Third-Party License Texts

This directory ships the full license texts required by the third-party
components distributed with Vek-Snap. See `../NOTICE.md` for the per-component
attribution and which license applies to what.

| File | License | Covers | How it's populated |
|------|---------|--------|--------------------|
| `GPL-3.0.txt` | GNU GPL v3 | FFmpeg (GPL build), RMBG node, ComfyUI | fetched verbatim by `scripts/fetch-licenses.mjs` |
| `GPL-2.0.txt` | GNU GPL v2 | Git for Windows / MinGit | fetched verbatim by `scripts/fetch-licenses.mjs` |
| `Apache-2.0.txt` | Apache 2.0 | Qwen / Qwen-VL; SAM 2 (Meta, download); SeedVR2-3B weights (ByteDance Seed) + `ComfyUI-SeedVR2_VideoUpscaler` node (numz); ACE-Step v1.5 + HeartMuLa (music); AnimateDiff v3 + `ComfyUI-AnimateDiff-Evolved` node; GFPGAN v1.4 (lip-sync face restore) | fetched verbatim by `scripts/fetch-licenses.mjs` |
| `MIT.txt` | MIT | INSPYRENET (RMBG model); Florence-2-base (Microsoft); 10S_Nodes; PowerPaint code; SVI LoRAs | reference MIT template; per-component copyright recorded in `../NOTICE.md` |
| `LTX-2_LICENSE.txt` | LTX-2 Community License + Attachment A | LTX-2 (download); DramaBox (Resemble AI LTX-2 fine-tune, download) | reference (weights not redistributed by us) |
| `REAL_ESRGAN_LICENSE.txt` | BSD 3-Clause | RealESRGAN_x4plus.pth (bundled upscaler) | verbatim BSD-3 + attribution |
| `NMKD_SUPERSCALE_LICENSE.txt` | WTFPL | 4x_NMKD-Superscale-SP_178000_G.pth (bundled upscaler) | verbatim WTFPL + attribution |

## Populating the GPL / Apache texts

These are reproduced **verbatim** from canonical sources to guarantee byte
accuracy (a legal requirement). Run, from the app root:

```bash
node scripts/fetch-licenses.mjs
```

This downloads:
- `GPL-3.0.txt`  <- https://www.gnu.org/licenses/gpl-3.0.txt
- `GPL-2.0.txt`  <- https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
- `Apache-2.0.txt` <- https://www.apache.org/licenses/LICENSE-2.0.txt

## Externally-licensed, user-downloaded models (no bundled text)

Some optional models are neither bundled nor downloaded by us; the user provisions them,
so their license runs user<->upstream and is referenced by URL in `../NOTICE.md` rather than
shipped here:

- **DramaBox** uses a **Gemma-3** text encoder -> Google **Gemma Terms of Use** (<https://ai.google.dev/gemma/terms>).
- **HunyuanVideo-Foley** (optional Foley, detect-only) -> **Tencent Hunyuan Community License**
  (<https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley>). Note its territory excludes the EU, UK,
  and South Korea. Vek-Snap does not bundle or download these weights.

## SAM 2 / LTX-2

Vek-Snap does **not** redistribute SAM 2 or LTX-2 model weights, the user (or the
installer, with consent) downloads them from the official source, where the
upstream license is presented and accepted. **SAM 2 (Meta) is Apache-2.0**, so it
is covered by the `Apache-2.0.txt` text above (Meta's non-permissive SAM 3 is not
shipped). LTX-2 ships under its own community license, recorded in the reference
file above. If a future build bundles any of these weights, replace the reference
file with the exact upstream license text.

## Bundled upscalers (RealESRGAN + NMKD Superscale)

Unlike the large generative checkpoints above, the two ESRGAN upscalers are
provisioned by default (installer Model Selection, pre-checked) because they are
small (~67 MB each) and required for the image Upscale + Enhance Details
features. Their licenses are fully permissive (BSD-3-Clause and WTFPL), so
bundling/redistribution is allowed; the verbatim texts + attribution are in the
files above.

This is consistent with our safety posture: the "we do not ship models whose
purpose is abuse" commitment (see `SAFETY.md`) targets **generative** content
models (face-swap, voice-cloning-for-impersonation, explicit fine-tunes). ESRGAN
upscalers are **non-generative**: they are deterministic super-resolution
filters that sharpen/enlarge an existing image and cannot synthesize new subject
content, so shipping them raises none of those concerns. Only permissively
licensed, non-generative upscalers belong here; non-commercial models
(4x-UltraSharp/UltraMix CC-BY-NC-SA, SUPIR) are intentionally excluded.
