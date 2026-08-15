"""
Rewrite Scene Direction(s) to a Requested Camera Perspective.
Called by /api/movie-maker/rewrite-scene.

Given one or more scenes (their dialogue + current [DIR] text) and a requested
camera perspective per scene, rewrite each scene's stage direction to match that
perspective: faithful to the dialogue/action, but with the CAMERA changed.
Characters are referred to by brief physical description + frame position, never
by name. For first-person POV the chosen character is the camera and is NOT shown.

One model load handles all scenes in the batch (the load is the slow part).

Usage:
  python rewrite-scene.py --json-input <path_to_input.json>

Input JSON:
  {
    "scenes": [
      {
        "index": 1,
        "dialogue": "[1]: Hello...\n[2]: Hi...",
        "current_direction": "A dimly lit lounge...",
        "perspective_label": "First-person POV",
        "perspective_instruction": "Rewrite as a strict first-person POV from the 41-year-old husky man..."
      }
    ],
    "characters": [{"name": "Jason", "description": "husky build", "age": "41", "gender": "male"}],
    "setting": "",
    "style": "",
    "model_path": "...\\Qwen2.5-7B-Instruct"
  }

Outputs JSON to stdout:
  { "directions": [ { "index": 1, "direction": "..." }, ... ] }
  or { "error": "..." }
"""

import argparse
import gc
import json
import os
import re
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
if not os.environ.get("SABA_ALLOW_ONLINE") and not os.environ.get("VEKSNAP_ALLOW_ONLINE"):
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"


SYSTEM_PROMPT = """You are a visual director for film/video production. You REWRITE a single scene's visual stage direction so it matches a REQUESTED CAMERA PERSPECTIVE, while staying faithful to the dialogue and the events of the original direction.

Your output is used by an AI video generator (LTX2). Requirements:
- The REQUESTED PERSPECTIVE is the most important instruction. Obey it exactly.
- You are changing the CAMERA, not the story. Keep the same location, characters present, action, and mood as the original direction and dialogue.
- Describe ONLY what is visually happening: environment, character positions/actions, lighting, framing, expressions. Present tense, 1-3 sentences.
- Refer to every character by a BRIEF physical description plus WHERE they are in the frame and WHAT they are doing. NEVER use character names.
- First-person POV: the named POV character IS the camera and is NOT visible - never describe their face or body (only their hands/arms may enter frame, and only if they are acting). Describe only what they see: the other people (in brief physical detail), objects, and environment in front of them.
- Over-the-shoulder: place the back of the chosen character's head/shoulder soft in the near foreground at one edge; the person/focus they face is sharp beyond them.

Output ONLY the rewritten direction text. No "# [DIR]" prefix, no quotes, no commentary, no explanation."""


def build_user_message(scene, setting, style, characters):
    parts = []

    if setting:
        parts.append(f"BASE SETTING: {setting}")
    if style:
        parts.append(f"VISUAL STYLE: {style}")

    if characters:
        char_descs = []
        for i, c in enumerate(characters, 1):
            desc_bits = []
            age = (c.get("age") or "").strip()
            gender = (c.get("gender") or "").strip()
            desc = (c.get("description") or "").strip()
            if age:
                desc_bits.append(age)
            if gender:
                desc_bits.append(gender)
            if desc:
                desc_bits.append(desc)
            label = ", ".join(desc_bits) if desc_bits else "no description"
            # Names are given ONLY so the model can map them; output must stay name-free.
            char_descs.append(f"  Speaker {i} = \"{c.get('name', f'Character {i}')}\" ({label})")
        parts.append("CHARACTERS (use brief physical descriptions, NEVER names, in your output):\n" + "\n".join(char_descs))

    label = scene.get("perspective_label", "")
    instruction = scene.get("perspective_instruction", "")
    parts.append(f"REQUESTED PERSPECTIVE: {label}\n{instruction}".strip())

    current = (scene.get("current_direction") or "").strip()
    if current:
        parts.append("ORIGINAL DIRECTION (rewrite THIS to the requested perspective; keep its events):\n" + current)

    dialogue = (scene.get("dialogue") or "").strip()
    if dialogue:
        parts.append("SCENE DIALOGUE:\n" + dialogue)

    parts.append("Write ONE new visual stage direction for this scene from the requested perspective. Output only the direction text.")

    return "\n\n".join(parts)


def clean_direction(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"^(#\s*\[DIR\]\s*|Direction:\s*|Scene:\s*|Visual:\s*)", "", text, flags=re.IGNORECASE)
    text = text.split("\n")[0].strip()
    text = text.strip('"').strip("'")
    return text


def generate_one(model, tokenizer, user_message):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]
    try:
        raw = tokenizer.apply_chat_template(
            messages, return_tensors="pt",
            add_generation_prompt=True, enable_thinking=False,
        )
    except TypeError:
        raw = tokenizer.apply_chat_template(
            messages, return_tensors="pt",
            add_generation_prompt=True,
        )

    if hasattr(raw, "input_ids"):
        input_ids = raw.input_ids.to(model.device)
    elif isinstance(raw, dict):
        input_ids = raw["input_ids"].to(model.device)
    elif isinstance(raw, list):
        input_ids = torch.tensor([raw], dtype=torch.long).to(model.device)
    else:
        input_ids = raw.to(model.device)
    input_len = input_ids.shape[1]

    with torch.no_grad():
        output_ids = model.generate(
            input_ids,
            max_new_tokens=180,
            temperature=0.8,
            top_p=0.9,
            do_sample=True,
            repetition_penalty=1.1,
            use_cache=True,
            pad_token_id=tokenizer.eos_token_id,
        )

    text = tokenizer.decode(output_ids[0][input_len:], skip_special_tokens=True).strip()
    del input_ids, output_ids
    return clean_direction(text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-input", required=True)
    args = parser.parse_args()

    with open(args.json_input, "r", encoding="utf-8") as f:
        config = json.load(f)

    scenes = config.get("scenes", [])
    setting = config.get("setting", "")
    style = config.get("style", "")
    characters = config.get("characters", [])
    model_path = config.get("model_path", "")

    if not scenes:
        print(json.dumps({"error": "No scenes provided"}))
        sys.exit(1)

    if not os.path.isdir(model_path):
        print(json.dumps({"error": f"Model not found: {model_path}"}))
        sys.exit(1)

    sys.stderr.write(f"[rewrite-scene] Rewriting {len(scenes)} scene(s) (4-bit NF4)\n")
    sys.stderr.flush()
    t0 = time.time()

    compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
    if torch.cuda.is_available():
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=compute_dtype,
            bnb_4bit_use_double_quant=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            device_map="auto",
            quantization_config=quant_config,
            local_files_only=True,
        )
    else:
        # CPU / AMD (no CUDA): bitsandbytes 4-bit is CUDA-only; load fp32 on CPU.
        print("[cpu-fallback] No CUDA - loading LLM on CPU in float32 (slower).", file=sys.stderr)
        model = AutoModelForCausalLM.from_pretrained(
            model_path, torch_dtype=torch.float32, local_files_only=True,
        )
    model.eval()

    vram_used = torch.cuda.memory_allocated() / 1024**3 if torch.cuda.is_available() else 0
    sys.stderr.write(f"[rewrite-scene] Model loaded in {time.time() - t0:.1f}s. VRAM: {vram_used:.1f}GB\n")
    sys.stderr.flush()

    directions = []
    for i, scene in enumerate(scenes):
        idx = scene.get("index", i + 1)
        sys.stderr.write(f"[rewrite-scene] Rewriting scene {idx} ({i+1}/{len(scenes)})...\n")
        sys.stderr.flush()
        try:
            user_message = build_user_message(scene, setting, style, characters)
            direction = generate_one(model, tokenizer, user_message)
        except Exception as e:
            direction = ""
            sys.stderr.write(f"[rewrite-scene] Scene {idx} failed: {e}\n")
            sys.stderr.flush()
        directions.append({"index": idx, "direction": direction})

    sys.stderr.write("[rewrite-scene] Unloading model...\n")
    sys.stderr.flush()
    del model, tokenizer
    gc.collect()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass

    sys.stderr.write(f"[rewrite-scene] Done. Rewrote {len(directions)} scene(s).\n")
    sys.stderr.flush()

    print(json.dumps({"directions": directions}))


if __name__ == "__main__":
    main()
