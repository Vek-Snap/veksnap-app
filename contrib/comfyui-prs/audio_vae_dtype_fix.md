# Upstream PR Draft: AudioVAE.encode dtype alignment

**Target repo:** `comfyanonymous/ComfyUI`
**File touched:** `comfy/ldm/lightricks/vae/audio_vae.py`
**Author account:** Squishy Code AI LLC (fill GitHub handle + commit name/email below)
**Status:** READY - technical items verified (Jul 6 2026). Remaining before opening: fill your GitHub handle, and do the final clean-`master` reproduction (framing note below).

---

## Pre-submit checklist (do these first, protects our credibility)

- [ ] **Reproduce on a clean, current upstream `master` with default settings.**
  - If it crashes with defaults → submit as a *fix* (confident framing).
  - If it only crashes when the audio VAE is loaded in `bf16`/`fp16` → keep the *robustness hardening* framing below (do NOT claim "crash for everyone").
- [ ] Confirm the crash signature: `RuntimeError: Input type (c10::Float) and weight type (c10::BFloat16) should be the same`.
- [x] Read `CONTRIBUTING.md`; check for a **CLA / DCO sign-off** requirement. **Verified Jul 6 2026: no DCO/CLA sign-off requirement found in upstream `CONTRIBUTING.md`** - `git commit -s` is optional (kept below; harmless).
- [x] Diff is pure: zero SABA/Vek-Snap branding, only the 3 added lines. (Confirmed against `audio_vae_dtype_fix.patch`.)
- [x] Branch from latest `master`, not from our pinned commit. **Verified Jul 6 2026: the `AudioVAE.encode` context (lines 153-157) is byte-identical on current `master` and `v0.27.0`, so the patch applies cleanly to `master`.**

---

## Proposed PR title

```
Fix dtype mismatch in AudioVAE.encode when the audio VAE is loaded in bf16/fp16
```

## Proposed PR description (humble / new-contributor tone)

> Hi! First-time contributor here: happy to adjust anything to match your conventions.
>
> ### What this does
> `AudioVAE.encode()` can raise a dtype mismatch when the audio VAE's weights are not
> `float32`. The mel spectrogram produced by `AudioPreprocessor.waveform_to_mel()` is
> always `float32` (it comes from torchaudio's `MelSpectrogram` + `log`), but if the
> encoder is loaded in `bf16`/`fp16`, feeding the `float32` mel into the encoder throws:
>
> ```
> RuntimeError: Input type (c10::Float) and weight type (c10::BFloat16) should be the same
> ```
>
> ### Fix
> Cast the mel to the encoder's actual parameter dtype right before encoding. This is a
> no-op when the VAE is `float32`, and resolves the mismatch when it isn't:
>
> ```python
> encoder_dtype = next(self.autoencoder.encoder.parameters()).dtype
> mel_spec = mel_spec.to(dtype=encoder_dtype)
> ```
>
> ### Why `encode()` specifically (and not `decode()`)
> `decode()`'s input (`latents`) originates inside the model, so it already carries the
> model dtype. `encode()`'s input (`mel`) originates *outside* the model from torchaudio
> DSP, which is fixed at `float32`, so `encode()` is the only path exposed to the mismatch.
>
> ### How I hit it
> Running the LTX-2.3 audio VAE in `bf16` (for VRAM headroom on a 16 GB card).
>
> ### Open question
> If you'd prefer the cast handled at the VAE dtype-loading layer rather than inside
> `encode()`, I'm glad to move it there, just let me know what fits the codebase best.

---

## The change (exact diff)

```diff
@@ class AudioVAE(torch.nn.Module):
         mel_spec = self.preprocessor.waveform_to_mel(
             waveform, waveform_sample_rate, device=waveform.device
         )

+        # Cast mel spectrogram to match encoder weight dtype (bf16 VAE + float32 audio input)
+        encoder_dtype = next(self.autoencoder.encoder.parameters()).dtype
+        mel_spec = mel_spec.to(dtype=encoder_dtype)
+
         latents = self.autoencoder.encode(mel_spec)
```

An isolated patch file is saved alongside this doc: `audio_vae_dtype_fix.patch`

---

## Command sequence (fill in the >>> placeholders)

```bash
# 0) Set the org identity for these commits (run once in the cloned fork)
git config user.name  ">>> Squishy Code AI"        # public commit name
git config user.email ">>> dev@squishycode.ai"     # public commit email

# 1) Fork comfyanonymous/ComfyUI on GitHub (web), then clone YOUR fork:
git clone https://github.com/>>>SQUISHY_HANDLE/ComfyUI.git
cd ComfyUI
git remote add upstream https://github.com/comfyanonymous/ComfyUI.git
git fetch upstream
git checkout -b fix/audiovae-encode-dtype upstream/master

# 2) Apply our isolated patch (path to the .patch saved next to this doc)
git apply "Y:/VEK-SNAP Dev/VEK-SNAP/veksnap-app/contrib/comfyui-prs/audio_vae_dtype_fix.patch"   # production root is now Y: (was G:)

# 3) Sanity check, then commit (use -s if DCO is required)
git diff
git add comfy/ldm/lightricks/vae/audio_vae.py
git commit -s -m "Fix dtype mismatch in AudioVAE.encode for non-float32 audio VAE

Cast the float32 mel spectrogram to the encoder's parameter dtype before
encoding so a bf16/fp16-loaded audio VAE does not raise a dtype mismatch.
No-op when the VAE is float32."

# 4) Push and open the PR
git push origin fix/audiovae-encode-dtype
# then open the PR on GitHub against comfyanonymous/ComfyUI:master
```
