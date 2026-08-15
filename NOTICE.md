# Vek-Snap™: Third-Party Notices & Attributions

Vek-Snap is a commercial product of **Squishy Code AI LLC**. The application
itself is proprietary. It is distributed **alongside** (and at install time
provisions) a number of independent open-source components and AI models, each
under its own license. This file enumerates those components and reproduces the
notices their licenses require.

> Nothing in this file grants you any rights in the Vek-Snap application itself.
> Your use of Vek-Snap is governed by the Vek-Snap End User License Agreement (EULA).
> The notices below apply **only** to the separately-licensed third-party
> components identified in each section.

Last updated: 2026-07-31.

---

## 1. FFmpeg

Vek-Snap uses **FFmpeg** for media processing. **Vek-Snap does not bundle or
redistribute FFmpeg.** Instead, during installation the installer downloads an
unmodified, pre-compiled Windows build **directly from the upstream
BtbN/FFmpeg-Builds project** (<https://github.com/BtbN/FFmpeg-Builds>) onto your
own machine: specifically the `ffmpeg-master-latest-win64-gpl` static build.

Because Squishy Code AI LLC does not convey the FFmpeg binary to you (your
machine obtains it directly from the upstream project), the FFmpeg license terms
apply to that upstream distribution. We provide this notice for transparency.

**License: the BtbN GPL build is licensed under the GNU General Public License,
version 3 or later (GPL-3.0-or-later).** It is configured with `--enable-gpl` /
`--enable-version3` and links GPL-licensed libraries (e.g. `libx264`, `libx265`);
FFmpeg's own core is primarily LGPL-2.1-or-later. The binary is obtained
unmodified from upstream.

**Complete corresponding source code** for FFmpeg and the build scripts is
available at no charge from upstream:

- FFmpeg source: <https://ffmpeg.org/download.html> and
  <https://git.ffmpeg.org/ffmpeg.git>
- Build configuration / scripts used to produce the binary:
  <https://github.com/BtbN/FFmpeg-Builds>
- The exact version provisioned onto your machine is recorded in
  `runtime/ffmpeg/` (see `ffmpeg -version`) and corresponds to a BtbN release.

A complete copy of the GNU GPL v3 license text is included with this product at
`licenses/GPL-3.0.txt` and is also available at
<https://www.gnu.org/licenses/gpl-3.0.txt>.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

---

## 2. ComfyUI-RMBG background-removal node

Background removal / subject isolation (used by the Content-Aware Compose
"Overlay" and "Combined" modes and the Enhance paths) is provided by the
**ComfyUI-RMBG** custom node by **1038lab**. The node is **cloned unmodified at
install time** from upstream (<https://github.com/1038lab/ComfyUI-RMBG>); Vek-Snap
does **not** bundle or fork it.

**Node license: GNU General Public License, version 3 (GPL-3.0-or-later).** The
GPL v3 text at `licenses/GPL-3.0.txt` applies. Upstream source and attribution are
preserved in the node's install directory.

**Model: INSPYRENET (MIT).** Vek-Snap drives the node with the **INSPYRENET**
model (plemeri/InSPyReNet, MIT License). The node auto-downloads the INSPYRENET
weights to `ComfyUI/models/RMBG/` on first use (user-obtained, **not** bundled or
redistributed by us); covered by `licenses/MIT.txt`. Vek-Snap does **not** use
BRIA's **RMBG-2.0** model, which is non-commercial (CC BY-NC 4.0).

---

## 3. SAM 2 (Segment Anything 2, Meta)

Vek-Snap can use **Segment Anything 2 (SAM 2 / 2.1)** by **Meta Platforms, Inc.**
to generate masks for the video mask workflows (the "SAM2 Text / Track" mask
sources). **Vek-Snap does not bundle or redistribute SAM 2**; its weights are
downloaded by the user from their original host, subject to the model's own
terms.

- **SAM 2 is licensed under the Apache License 2.0.** Source:
  <https://github.com/facebookresearch/sam2>. A copy of the Apache 2.0 license
  text is included at `licenses/Apache-2.0.txt`.

> Note: Meta's separate **SAM 3** model is **not** included in Vek-Snap. SAM 3
> ships under Meta's non-permissive "SAM License" (distinct from the Apache-2.0
> of SAM 1 / SAM 2); it is neither bundled nor downloaded by the product.

---

## 4. LTX-2 (Lightricks)

LTX-2 video models are provided by **Lightricks** under the **LTX-2 Community
License / EULA** (including its **Attachment A** acceptable-use terms). Vek-Snap
does not bundle LTX-2 weights; they are downloaded subject to Lightricks' terms.

- The LTX-2 Community License / EULA and Attachment A are included at
  `licenses/LTX-2_LICENSE.txt`.
- **Commercial-scale notice:** Lightricks' license requires a separate
  commercial arrangement for entities exceeding the stated revenue threshold
  (the **>= $10M annual revenue** clause). Vek-Snap end users at or above that
  threshold are responsible for obtaining the appropriate license from
  Lightricks. See `licenses/LTX-2_LICENSE.txt` for the controlling text.

---

## 5. Qwen models (Alibaba)

Qwen / Qwen-VL models used for prompt and vision tasks are licensed under the
**Apache License 2.0**. A copy is included at `licenses/Apache-2.0.txt`.
Weights are downloaded by the user subject to the model card terms.

---

## 6. WAN 2.x video models (Alibaba / Wan-AI) & Stable Video Infinity (SVI)

Vek-Snap can download (user opt-in) several **WAN 2.1 / 2.2** video models and the
**Stable Video Infinity (SVI) v2 Pro** continuity LoRAs. Vek-Snap does **not**
bundle these weights; they are fetched from their original hosts at the user's
request, each under its own license.

- **WAN 2.1 / 2.2 (T2V, I2V, S2V, GGUF repackages)**, **Apache License 2.0**
  (Alibaba / Wan-AI). Permissive; commercial use permitted. Covered by
  `licenses/Apache-2.0.txt`. Community GGUF repackages (e.g. QuantStack,
  Comfy-Org) redistribute the same Apache-2.0 weights.
- **Stable Video Infinity (SVI) v2 Pro LoRAs**, **MIT License**, by the
  **EPFL VITA Lab** (project: <https://github.com/vita-epfl/Stable-Video-Infinity>;
  weights: <https://huggingface.co/epfl-vita/svi-model>). SVI is a LoRA adapter
  trained over the Apache-2.0 WAN 2.2 base. The MIT license permits commercial
  use, distribution, and sublicensing provided the copyright notice and MIT
  permission notice are preserved. The MIT notice text is reproduced at
  `licenses/MIT.txt` and on the upstream repository.

> The installer also offers other optional, user-downloaded models (e.g.
> Z-Image, Stable Diffusion XL, ACE-Step). Each is governed by its own license,
> shown on that model's card in the installer and on its source model card.

---

## 6a. Image upscalers: RealESRGAN & NMKD Superscale (bundled)

Two **non-generative** ESRGAN super-resolution models are provisioned by default
(they power the image **Upscale** and **Enhance Details** features). Both carry
fully permissive licenses that allow bundling and commercial use:

- **RealESRGAN_x4plus**: © 2021 Xintao Wang et al. (Tencent ARC Lab), **BSD
  3-Clause**. Source: <https://github.com/xinntao/Real-ESRGAN>. Full text +
  required copyright notice at `licenses/REAL_ESRGAN_LICENSE.txt`.
- **4x_NMKD-Superscale-SP_178000_G**: by NMKD (Nicolay Mausz), **WTFPL**.
  Listing: <https://openmodeldb.info/models/4x-NMKD-Superscale>. Full text at
  `licenses/NMKD_SUPERSCALE_LICENSE.txt`.

> These are deterministic upscaling filters, they sharpen/enlarge an existing
> image and cannot synthesize new subject content, so they fall outside the
> "no abuse-purpose (generative) models" commitment in `SAFETY.md`.
> Non-commercial upscalers (4x-UltraSharp/UltraMix under CC-BY-NC-SA, SUPIR) are
> intentionally **not** shipped.

---

## 6b. Video restoration: SeedVR2 (optional, user-provided)

The optional **Video Restoration** feature can use **SeedVR2** (ByteDance Seed),
a one-step diffusion-transformer video restorer, via the **ComfyUI-SeedVR2_VideoUpscaler**
custom node (by numz). **Vek-Snap does not clone, download, bundle, or
redistribute the node or the SeedVR2 weights**, it only *detects* whether the
user has installed them and reports the feature as unavailable otherwise.

- **SeedVR2 weights** (ByteDance Seed): **Apache-2.0**. The model card declares
  `license: apache-2.0`. Reference: arXiv 2506.05301.
- **ComfyUI-SeedVR2_VideoUpscaler** node (numz): **Apache-2.0** (verbatim
  Apache 2.0 `LICENSE` in the node root). Source:
  <https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler>.
- Apache-2.0 is covered by `licenses/Apache-2.0.txt`.

---

## 6c. Music generation: ACE-Step & HeartMuLa (optional, user-provided)

Vek-Snap's music studios use two open, commercially-licensed music models. Vek-Snap
does **not** bundle or redistribute either; the weights are fetched from their original
hosts at the user's request.

- **ACE-Step v1.5 XL** (ACE Studio / StepFun): **Apache-2.0**. Primary music generator
  (the `acestep` mode); its text encoder is a Qwen model (Apache-2.0). Free commercial
  use, no revenue cap, no registration. Covered by `licenses/Apache-2.0.txt`.
- **HeartMuLa-oss-3B** (music/song): **Apache-2.0**. Secondary/alternative music engine
  (the `heartmula` mode), integrated via the third-party **ComfyUI_FL-HeartMuLa** nodes
  (filliptm); the weights' Hugging Face cards declare Apache-2.0. Covered by
  `licenses/Apache-2.0.txt`.

> Meta's MusicGen / AudioGen (CC BY-NC 4.0, non-commercial) are intentionally **not** shipped;
> music generation is covered entirely by the Apache-2.0 models above.

---

## 6d. Dialogue / text-to-speech: DramaBox (optional, user-provided)

The dialogue/voice studios (the `dramabox` mode and Movie Maker character dialogue) use
**DramaBox** by **Resemble AI**, an IC-LoRA fine-tune of LTX-2. Vek-Snap does **not** bundle
or redistribute the weights.

- **DramaBox weights**: governed by the **LTX-2 Community License** (the same license as the
  LTX-2 video weights in §4 — free commercial use until the licensee reaches US $10M annual
  revenue). Text: `licenses/LTX-2_LICENSE.txt`.
- **Gemma-3 text encoder**: DramaBox uses a **Gemma-3-12B** text encoder, subject to Google's
  **Gemma Terms of Use** and **Prohibited Use Policy** (<https://ai.google.dev/gemma/terms>).
  Commercial use is permitted; the use restrictions are passed through to end users via the EULA.
- **Provenance:** DramaBox output carries Resemble AI's inaudible **"Perth" watermark**, left
  enabled as a provenance signal. Vek-Snap's EULA prohibits impersonation / non-consensual voice use.

---

## 6e. Foley / sound-for-video: HunyuanVideo-Foley (optional, NOT bundled)

The optional **Foley** feature can generate sound effects locked to a video using Tencent's
**HunyuanVideo-Foley** via the `ComfyUI-HunyuanVideo-Foley` node. **Vek-Snap does not clone,
download, bundle, or redistribute the node or the weights** — it only *detects* whether the user
has installed them and reports the feature as unavailable otherwise (the same posture as SeedVR2
in §6b). The default synchronized-audio path is LTX-2's built-in joint audio (§4); HunyuanVideo-Foley
is a user-provided alternative.

- **HunyuanVideo-Foley** (Tencent): **Tencent Hunyuan Community License Agreement**
  (<https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley>). Commercial use is free below
  100 million monthly active users. **⚠ The license territory expressly EXCLUDES the European
  Union, the United Kingdom, and South Korea**, and it requires that Tencent's NOTICE and
  Acceptable Use Policy be passed through to downstream users. Because Vek-Snap neither bundles
  nor downloads these weights, acquisition and territorial / AUP compliance are the user's own
  action (user ↔ Tencent).

---

## 6f. Lip-sync face restoration, motion modules & captioning (optional)

- **GFPGAN v1.4** (Tencent ARC): **Apache-2.0**. Optional face restoration applied to lip-sync
  output frames (the `"gfpgan"` face-restore option). User-downloaded, not redistributed. Covered
  by `licenses/Apache-2.0.txt`. **CodeFormer (S-Lab License 1.0, non-commercial) is NOT used** in
  Vek-Snap — it was removed; GFPGAN is the only face restorer.
- **AnimateDiff v3 motion module** (`v3_sd15_mm`, guoyww): **Apache-2.0**, executed via the
  **ComfyUI-AnimateDiff-Evolved** node (Kosinkadink, **Apache-2.0**) for the SD1.5 `video`
  (AnimateDiff) mode. Cloned / downloaded only when the user selects that mode. Covered by
  `licenses/Apache-2.0.txt`.
- **Florence-2-base** (Microsoft): **MIT**. Used for phrase-grounding in the face-repair / ADetailer
  graphs and for optional dataset captioning in LoRA Factory, via ComfyUI-RMBG's `AILab_Florence2`
  node (the RMBG node itself is covered in §2). Weights auto-fetched by the node to `models/LLM`.
  Covered by `licenses/MIT.txt`.

---

## 7. ComfyUI and other components

- **ComfyUI** (<https://github.com/comfyanonymous/ComfyUI>) - GPL-3.0-or-later.
  Cloned at install time (unmodified). Covered by `licenses/GPL-3.0.txt`.
- **PyTorch**: BSD-3-Clause. Downloaded as official wheels at install time.
- **Python (python-build-standalone)**: PSF License Agreement.
- **Node.js**: MIT (plus its own bundled component licenses).
- **Content-Aware Fill/Removal Engine** (Re-Imagine / Expand inpaint, overlay, combined,
  and outpaint) offers three selectable engines:
  - **Standard (`DifferentialDiffusion`)**: ComfyUI's **built-in** node (part of ComfyUI core,
    covered above), driven by the latent noise mask. **No dedicated inpaint model, no bundled
    weights, no external custom node.** This is the **default** engine.
  - **BrushNet**: optional, user-downloaded weights (SD1.5 + SDXL). Weights **Apache-2.0**
    (TencentARC/BrushNet, ECCV 2024). Executed via the **ComfyUI-BrushNet** custom node
    (nullquant, **Apache-2.0**), git-cloned at install to a pinned commit with marked local
    compatibility patches (not redistributed as a fork).
  - **PowerPaint v2**: optional, user-downloaded object-removal weights (SD1.5 base only).
    PowerPaint code **MIT** (open-mmlab/PowerPaint); PowerPaint v2-1 weights **Apache-2.0**
    (`JunhaoZhuang/PowerPaint-v2-1`). Uses the same ComfyUI-BrushNet node loaders. Requires an
    SD1.5 text encoder (`ashllay/stable-diffusion-v1-5-archive`, **CreativeML OpenRAIL-M**:
    use-based restrictions per the model's Attachment A apply; see the EULA). The BrushNet and
    PowerPaint weight bundles are **off by default** and provisioned only if the user selects them
    in the installer's model card.
- **veksnap_bridge front-end glue** (`custom_nodes/veksnap_bridge/web/veksnap_open_workflow.js`):
  **GPL-3.0-or-later**. This small browser-side script is the only GPL-licensed piece of the
  "Open in ComfyUI" bridge; it fetches the staged workflow from the Vek-Snap app origin
  (`?veksnap_src=`) and calls ComfyUI's `app.loadApiJson()`. It carries an explicit GPL-3.0 header
  and a `LICENSE.md` preserved in `custom_nodes/veksnap_bridge/`. The Python side of the node is a
  zero-import shim (declares `WEB_DIRECTORY` only); the workflow relay itself lives in the
  proprietary app API route and is NOT GPL. Covered by `licenses/GPL-3.0.txt`.
- **ComfyUI-LTXVideo** (<https://github.com/Lightricks/ComfyUI-LTXVideo>):
  **LTX-2 Community License** (the SAME license as the LTX-2 weights in §4), by
  **Lightricks**. Provides the official LTX-2 helper nodes (`LTXVAddLatents`,
  `LTXVSetAudioVideoMaskByTime`, `LTXVAudioVAEEncode`, etc.) used by Vek-Snap's
  LTX-2 audio/video, Extend, and Retake workflows. **Cloned at install time**
  (only when an LTX model is selected); its upstream `LICENSE` is preserved in
  `custom_nodes/ComfyUI-LTXVideo/`. **Stated change:** Vek-Snap applies one
  minimal, clearly-marked local fix on your machine after cloning (a `None`
  guard in `latents.py` to prevent an Extend/Retake crash; mirrors the upstream
  `LTXVSelectLatents` idiom). We do not redistribute a modified fork.
- **ComfyUI-VideoHelperSuite** (<https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite>):
  **GPL-3.0**, by **Kosinkadink**. Provides video muxing (`VHS_VideoCombine`) and
  source-video loading (`VHS_LoadVideoPath` / `VHS_LoadVideo` / `VHS_LoadImagesPath`)
  used by every video pipeline (LTX-2 + WAN output and V2V/Extend/Retake source
  loading). **Cloned at install time, unmodified**; upstream `LICENSE` preserved in
  `custom_nodes/ComfyUI-VideoHelperSuite/`. Covered by `licenses/GPL-3.0.txt`.
- **ComfyUI-KJNodes** (<https://github.com/kijai/ComfyUI-KJNodes>) - **GPL-3.0**, by
  **kijai**. Mask/latent/sampling helper nodes used across the LTX-2 and image
  pipelines (e.g. `LTX2SamplingPreviewOverride`, `GrowMaskWithBlur`). **Cloned at
  install time, unmodified**; upstream `LICENSE` preserved in
  `custom_nodes/ComfyUI-KJNodes/`. Covered by `licenses/GPL-3.0.txt`.
- **ComfyUI-GGUF** (<https://github.com/city96/ComfyUI-GGUF>) - **Apache-2.0**, by
  **city96**. GGUF model loaders (`UnetLoaderGGUF` / `DualCLIPLoaderGGUF`) for the
  low-VRAM GGUF model variants in the catalog (LTX 2.3 GGUF + Gemma QAT encoder,
  WAN 2.2 GGUF). **Cloned at install time** (only when a GGUF model is selected),
  unmodified; upstream `LICENSE` preserved in `custom_nodes/ComfyUI-GGUF/`.
  Covered by `licenses/Apache-2.0.txt`.
- **10S_Nodes** (<https://github.com/TenStrip/10S-Comfy-nodes>) - **MIT License**, by
  **TenStrip**. Identity-stabilization nodes (`LTXLikenessGuide`, `LTXLikenessAnchor`) that
  power the **"Character Consistency (10S Method)"** option in the LTX-2 and Continuum studios.
  **Cloned at install time** (only when an LTX model is selected), unmodified; pinned to commit
  `fb6edfe`. MIT is declared in the project **README** (`## License` section); the upstream repo
  ships **no standalone LICENSE file**, so that README declaration is the license of record
  (archived in our licensing findings). No additional Python dependencies, face detection uses
  OpenCV Haar (already in ComfyUI); MediaPipe is optional. Covered by `licenses/MIT.txt`.
- **veksnap_utils** (`custom_nodes/veksnap_utils/`): **Vek-Snap-authored** ComfyUI
  node pack, **split-licensed by file** (see `custom_nodes/veksnap_utils/LICENSE.md`):
  - `__init__.py`: `VekSnapColorMatch` (per-channel histogram drift correction),
    `VekSnapAVNormSampler` (LTX AV sampler with live preview), and the
    `/api/reload-nodes` helper are original Vek-Snap work under **PolyForm
    Noncommercial 1.0.0**. Noncommercial use is free; commercial use requires a
    separate license from Squishy Code AI LLC. They interface with ComfyUI only via
    its public plugin API and are **not** distributed under GPL.
  - `veksnap_nodes_gpl.py`: `VekSnapCleanVRAM`, `VekSnapAppendGuideLatent`,
    `VekSnapReferenceComposer` are released under **GPL-3.0-or-later** (free for any
    use, including commercial). Covered by `licenses/GPL-3.0.txt`.
- Other ComfyUI custom nodes retain their upstream licenses, preserved in each
  node's directory under `custom_nodes/`.

---

## 7a. Git for Windows (MinGit)

The Vek-Snap installer bundles **MinGit**, the portable distribution of **Git
for Windows**, used at install time to clone ComfyUI. The bundled binary is
**unmodified**.

**License: GNU General Public License, version 2 (GPL-2.0-only).** Git is
licensed under GPLv2; the Git for Windows distribution additionally includes
components under other compatible licenses, whose notices are preserved inside
the bundled `git/` directory.

In compliance with the GPL we provide the following:

- **The binary is unmodified.** Vek-Snap distributes MinGit exactly as obtained
  from the Git for Windows project; we made no changes to it.
- **Complete corresponding source code** is available at no charge from the
  Git for Windows project: <https://github.com/git-for-windows/git> (releases at
  <https://github.com/git-for-windows/git/releases>) and the upstream Git source
  at <https://git-scm.com/downloads> / <https://github.com/git/git>. The exact
  release shipped is recorded in the bundled `git/` directory.
- **Written offer.** For a period of three (3) years, Squishy Code AI LLC will,
  on written request, provide the complete corresponding source code for the
  MinGit version distributed with your copy of Vek-Snap, on a physical medium,
  for a charge no more than our cost of physically performing the distribution.
  Send requests to: legal@squishycode.ai.

The GNU GPL v2 text is included at `licenses/GPL-2.0.txt` and is also available
at <https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt>.

---

## 7b. LoRA Factory trainers (kohya-ss)

The optional **LoRA Factory** component provisions two upstream training
repositories, **cloned onto your machine at install time** (into `lora-factory/`)
only if you select LoRA Factory. Vek-Snap does **not** bundle or redistribute
them; they are cloned unmodified from upstream, except one clearly-marked local
patch to `musubi-tuner` that makes the Z-Image tokenizer load from a local
directory offline.

- **musubi-tuner** (kohya-ss): **Apache-2.0**. Source:
  <https://github.com/kohya-ss/musubi-tuner>. Some subdirectories are modified
  from upstream projects (e.g. Wan2.1, FramePack), each Apache-2.0.
- **sd-scripts** (kohya-ss): **Apache-2.0**. Source:
  <https://github.com/kohya-ss/sd-scripts>. Small portions are under MIT /
  BSD-3-Clause per its README.

Both are covered by `licenses/Apache-2.0.txt`.

---

## 8. License files

Full license texts are shipped under the `licenses/` directory:

- `licenses/GPL-3.0.txt`: GNU GPL v3 (FFmpeg, RMBG node, ComfyUI, veksnap_bridge glue)
- `licenses/GPL-2.0.txt`: GNU GPL v2 (Git for Windows / MinGit)
- `licenses/Apache-2.0.txt`: Apache 2.0 (Qwen, WAN 2.x, SAM 2, SeedVR2, kohya-ss musubi-tuner + sd-scripts)
- `licenses/MIT.txt`: MIT License (Stable Video Infinity / SVI v2 Pro, EPFL VITA; INSPYRENET background-removal model)
- `licenses/LTX-2_LICENSE.txt`: LTX-2 Community License + Attachment A
- `licenses/REAL_ESRGAN_LICENSE.txt`: BSD 3-Clause (RealESRGAN_x4plus upscaler)
- `licenses/NMKD_SUPERSCALE_LICENSE.txt`: WTFPL (NMKD Superscale upscaler)

If any required license text is missing from your installation, contact
legal@squishycode.ai and we will provide it free of charge.
