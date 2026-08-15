"""
Vision Describe - Standalone script for Qwen2.5-VL image description.
Called by /api/vision-describe API route.

Usage (single):
  python vision-describe.py image_path model_path [--max-tokens 180] [--prompt "..."]

Usage (batch):
  python vision-describe.py --json-input batch.json
  JSON format: { "model_path": "...", "max_tokens": 120, "items": [{ "image_path": "...", "prompt": "..." }, ...] }

Single mode outputs: { "description": "..." }
Batch mode outputs: [{ "description": "..." }, ...]
Loads model once, runs all inferences, unloads, exits - keeping VRAM free for LTX-2.
"""

import argparse
import gc
import json
import os
import sys

import torch
import numpy as np
from PIL import Image
from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
from qwen_vl_utils import process_vision_info

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
if not os.environ.get("VEKSNAP_ALLOW_ONLINE"):
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"

DESCRIBE_PROMPT = (
    "Describe this image in one paragraph of plain sentences, around 100-130 words. "
    "Start with 'Style: photorealistic' or 'Style: anime' or 'Style: 3D animation' etc. "
    "Then describe the person - your FIRST sentence about the person MUST explicitly state "
    "their ethnicity and skin tone using plain terms such as 'a Black man', 'a white woman', "
    "'a South Asian man', 'an East Asian woman', 'a Latino man', 'a Middle Eastern woman' etc. "
    "Do not skip, soften, or omit this - it is mandatory. "
    "Then continue with their age, hair colour and style, body type, "
    "and what they are wearing or doing, described in neutral, non-explicit terms. "
    "All subjects must be adults aged 18 or older. If anyone in the image appears to be "
    "a minor (a child or adolescent), do NOT describe their body, clothing, or any exposed "
    "body parts in sexual or anatomical detail. "
    "Describe their pose, what they are on or interacting with, "
    "the camera framing and angle, the lighting and time of day, and the setting. "
    "Write it as one flowing paragraph. Do not use bullet points, lists, or labels. "
    "If there is no person in the image, describe the scene instead - "
    "the environment, setting, lighting, time of day, mood, and any notable objects or details."
)

# Build special token strings programmatically (avoids XML parse issues)
_P = "|"
_STOP_STRS = [f"<{_P}im_end{_P}>", f"<{_P}endoftext{_P}>"]


def get_stop_ids(tokenizer):
    """Collect stop token IDs for generation."""
    stop_ids = []
    if tokenizer.eos_token_id is not None:
        stop_ids.append(tokenizer.eos_token_id)
    for s in _STOP_STRS:
        ids = tokenizer.encode(s, add_special_tokens=False)
        if len(ids) == 1 and ids[0] not in stop_ids:
            stop_ids.append(ids[0])
    return stop_ids


def load_image(image_path, max_dim=1024):
    """Load and optionally resize an image."""
    pil_image = Image.open(image_path).convert("RGB")
    if max(pil_image.size) > max_dim:
        ratio = max_dim / max(pil_image.size)
        new_size = (int(pil_image.width * ratio), int(pil_image.height * ratio))
        pil_image = pil_image.resize(new_size, Image.LANCZOS)
    return pil_image


def describe_image(model, processor, pil_image, user_prompt, max_tokens):
    """Run inference on a single image and return the description string."""
    messages = [
        {
            "role": "system",
            "content": (
                "You are an image description tool for an AI video pipeline. "
                "Describe exactly what you see in plain factual prose. "
                "Be direct and accurate. Do not embellish or invent details. "
                "All subjects are adults aged 18 or older. If a person appears to be a minor "
                "(a child or adolescent), do not describe their body or clothing in sexual or "
                "anatomical detail; instead state: 'SUBJECT APPEARS TO BE A MINOR - DESCRIPTION WITHHELD.'"
            ),
        },
        {
            "role": "user",
            "content": [
                {"type": "image", "image": pil_image},
                {"type": "text", "text": user_prompt or DESCRIBE_PROMPT},
            ],
        },
    ]

    text_input = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    image_inputs, video_inputs = process_vision_info(messages)

    inputs = processor(
        text=[text_input],
        images=image_inputs,
        videos=video_inputs,
        padding=True,
        return_tensors="pt",
    ).to(model.device)

    input_len = inputs["input_ids"].shape[1]
    tok = processor.tokenizer
    stop_ids = get_stop_ids(tok)
    pad_id = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id

    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            temperature=0.3,
            do_sample=True,
            top_p=0.9,
            pad_token_id=pad_id,
            eos_token_id=stop_ids,
        )

    new_tokens = out[0][input_len:]
    description = tok.decode(new_tokens, skip_special_tokens=True).strip()
    del out, inputs
    return description


def load_model(model_path):
    """Load Qwen2.5-VL model and processor."""
    print(f"[vision-describe] Loading model from {model_path}...", file=sys.stderr)
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        model_path,
        device_map="auto",
        torch_dtype=dtype,
        local_files_only=True,
    )
    model.eval()
    print("[vision-describe] Model loaded.", file=sys.stderr)
    return model, processor


def unload_model(model, processor):
    """Unload model and free VRAM."""
    print("[vision-describe] Unloading model...", file=sys.stderr)
    del model, processor
    gc.collect()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass
    vram_alloc = torch.cuda.memory_allocated() / 1024**3 if torch.cuda.is_available() else 0
    print(f"[vision-describe] VRAM after free: {vram_alloc:.2f}GB", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Describe an image using Qwen2.5-VL")
    parser.add_argument("image_path", nargs="?", default=None, help="Path to the image file")
    parser.add_argument("model_path", nargs="?", default=None, help="Path to local Qwen2.5-VL model directory")
    parser.add_argument("--max-tokens", type=int, default=180, help="Max new tokens")
    parser.add_argument("--prompt", type=str, default=None, help="Custom user prompt (overrides default DESCRIBE_PROMPT)")
    parser.add_argument("--json-input", type=str, default=None, help="Path to JSON file for batch mode")
    args = parser.parse_args()

    # ── Batch mode ──
    if args.json_input:
        if not os.path.isfile(args.json_input):
            print(json.dumps({"error": f"JSON input file not found: {args.json_input}"}))
            sys.exit(1)
        try:
            with open(args.json_input, "r", encoding="utf-8") as f:
                batch = json.load(f)

            model_path = batch.get("model_path", "")
            max_tokens = batch.get("max_tokens", 120)
            items = batch.get("items", [])

            if not os.path.isdir(model_path):
                print(json.dumps({"error": f"Model directory not found: {model_path}"}))
                sys.exit(1)
            if not items:
                print(json.dumps([]))
                return

            model, processor = load_model(model_path)

            results = []
            for idx, item in enumerate(items):
                img_path = item.get("image_path", "")
                user_prompt = item.get("prompt", None)
                try:
                    if not os.path.isfile(img_path):
                        results.append({"error": f"Image not found: {img_path}"})
                        continue
                    pil_image = load_image(img_path)
                    print(f"[vision-describe] Batch {idx + 1}/{len(items)}: {pil_image.size}", file=sys.stderr)
                    desc = describe_image(model, processor, pil_image, user_prompt, max_tokens)
                    print(f"[vision-describe] Batch {idx + 1}/{len(items)}: {len(desc.split())} words.", file=sys.stderr)
                    results.append({"description": desc})
                except Exception as e:
                    print(f"[vision-describe] Batch {idx + 1}/{len(items)} error: {e}", file=sys.stderr)
                    results.append({"error": str(e)})

            unload_model(model, processor)
            print(json.dumps(results))

        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
        return

    # ── Single-image mode ──
    if not args.image_path or not args.model_path:
        print(json.dumps({"error": "Provide image_path and model_path, or use --json-input for batch mode"}))
        sys.exit(1)

    if not os.path.isfile(args.image_path):
        print(json.dumps({"error": f"Image not found: {args.image_path}"}))
        sys.exit(1)
    if not os.path.isdir(args.model_path):
        print(json.dumps({"error": f"Model directory not found: {args.model_path}"}))
        sys.exit(1)

    try:
        pil_image = load_image(args.image_path)
        print(f"[vision-describe] Image: {pil_image.size}", file=sys.stderr)

        model, processor = load_model(args.model_path)
        description = describe_image(model, processor, pil_image, args.prompt, args.max_tokens)
        print(f"[vision-describe] Output: {len(description.split())} words.", file=sys.stderr)
        unload_model(model, processor)

        # Output result as JSON on stdout
        print(json.dumps({"description": description}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
