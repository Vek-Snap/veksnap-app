"""
Enrich Script with Visual Directions, Adds # [DIR] stage directions to an existing script.

APPROACH: Process the script in scene-groups (chunks of ~5 dialogue lines).
For each chunk, give the LLM the preceding context + current chunk and ask it to
generate ONE specific visual description. This ensures:
  - The LLM understands scene transitions, room changes, emotional shifts
  - Each direction is UNIQUE and contextual (not copy-pasted)
  - No context-window overflow (one short generation per chunk)

Usage:
  python enrich-directions.py --json-input <path_to_input.json>

Input JSON:
  {
    "script": "[1]: Hello there...\n[2]: Hi...",
    "setting": "Noir detective office, 1940s",
    "style": "cinematic, dark moody lighting",
    "characters": [{"name": "Sarah", "description": "tall woman with red hair"}],
    "model_path": "<absolute path to the local LLM directory>",
    "max_tokens": 4000
  }

Outputs JSON to stdout:
  { "enrichedScript": "# [DIR] A dimly lit office...\n[1]: Hello there...\n..." }
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
if not os.environ.get("VEKSNAP_ALLOW_ONLINE"):
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"


SYSTEM_PROMPT = """You are a visual director for film/video production. Given a section of dialogue, you write ONE concise visual stage direction describing what the camera sees.

Your output is used by an AI video generator (LTX2) to create visuals. Requirements:
- Describe ONLY what is visually happening: environment, character positions/actions, lighting, camera angle, expressions.
- Be SPECIFIC to the dialogue context. Infer location changes, emotional states, and physical actions from what characters say.
- Write in present tense. 1-3 sentences maximum.
- If dialogue implies a location change ("Let's go outside", "Welcome to my office"), describe the NEW location.
- If dialogue implies physical action ("Hand me that", "I can't even look at you"), describe the action.
- If mood shifts (friendly to threatening, calm to panicked), reflect it in lighting/framing.
- NEVER repeat a previous direction. Each must be unique and specific to THIS moment.
- Include camera distance: close-up, medium shot, wide shot, over-the-shoulder, etc.

Output ONLY the direction text. No prefix like "# [DIR]". No quotes. No commentary. Just the visual description."""


def split_into_scene_groups(script_lines, group_size=5):
    """
    Split script into scene groups. A new group starts when:
      - We accumulate group_size dialogue lines
      - Dialogue implies a scene change (location keywords)
      - SFX/MUS annotations suggest a scene beat
    """
    groups = []
    current_group = []
    dialogue_count = 0

    scene_change_patterns = [
        r"let'?s go", r"come with me", r"follow me", r"welcome to",
        r"we'?re here", r"this is (my|the|our)", r"step into",
        r"(walk|step|move|head|go) (to|into|outside|inside|over|back)",
        r"(open|close|slam)s? the door", r"(arrive|enter|leave|exit)",
        r"(later|next day|morning|evening|night|hours later)",
    ]

    for line in script_lines:
        stripped = line.strip()
        if not stripped:
            current_group.append(line)
            continue

        is_dialogue = bool(re.match(r"^\[\d+\]:", stripped))

        # Check for scene-change cues in dialogue
        force_split = False
        if is_dialogue and dialogue_count > 0:
            text_part = re.sub(r"^\[\d+\]:\s*", "", stripped).lower()
            for pat in scene_change_patterns:
                if re.search(pat, text_part):
                    force_split = True
                    break

        # SFX/MUS can indicate scene beats (only if we have some dialogue already)
        if stripped.startswith("#") and dialogue_count >= 2:
            if any(tag in stripped.upper() for tag in ["[SFX]", "[MUS]"]):
                force_split = True

        # Split condition
        if force_split or (is_dialogue and dialogue_count >= group_size):
            if current_group:
                groups.append(current_group)
            current_group = [line]
            dialogue_count = 1 if is_dialogue else 0
        else:
            current_group.append(line)
            if is_dialogue:
                dialogue_count += 1

    if current_group:
        groups.append(current_group)

    return groups


def generate_direction(model, tokenizer, chunk_lines, preceding_lines, setting, style, characters, prev_directions):
    """Generate ONE visual direction for a chunk of dialogue lines."""
    parts = []

    # World context
    if setting:
        parts.append(f"BASE SETTING: {setting}")
    if style:
        parts.append(f"VISUAL STYLE: {style}")
    if characters:
        char_descs = []
        for i, c in enumerate(characters, 1):
            name = c.get("name", f"Character {i}")
            desc = c.get("description", "")
            char_descs.append(f"  Speaker {i} = {name}" + (f" ({desc})" if desc else ""))
        parts.append("CHARACTERS:\n" + "\n".join(char_descs))

    # Show previous directions so the LLM doesn't repeat itself
    if prev_directions:
        recent = prev_directions[-3:]  # Last 3 directions for context
        parts.append("PREVIOUS DIRECTIONS (do NOT repeat these):\n" + "\n".join(f"  - {d}" for d in recent))

    # Preceding dialogue context (what came before this chunk)
    if preceding_lines:
        # Show last ~10 lines of preceding context
        context_lines = preceding_lines[-10:]
        parts.append("PRECEDING CONTEXT:\n" + "\n".join(context_lines))

    # The current chunk to describe
    parts.append("CURRENT SCENE DIALOGUE:\n" + "\n".join(chunk_lines))

    parts.append("Write ONE visual direction for the scene above. Describe what the camera sees as this dialogue plays. Be specific to the content: what are the characters doing, where are they, what's the mood?")

    user_message = "\n\n".join(parts)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    # Use enable_thinking=False for Qwen3 (disables reasoning/think blocks)
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

    # Handle various return types from apply_chat_template
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
            max_new_tokens=150,  # Short: just 1-3 sentences
            temperature=0.8,
            top_p=0.9,
            do_sample=True,
            repetition_penalty=1.1,
            use_cache=True,
            pad_token_id=tokenizer.eos_token_id,
        )

    text = tokenizer.decode(output_ids[0][input_len:], skip_special_tokens=True).strip()

    # Strip <think>...</think> reasoning blocks (Qwen3 quirk)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    # Clean up: remove any prefix the model might add
    text = re.sub(r"^(#\s*\[DIR\]\s*|Direction:\s*|Scene:\s*|Visual:\s*)", "", text, flags=re.IGNORECASE)
    # Take only the first paragraph (prevent runaway generation)
    text = text.split("\n")[0].strip()
    # Remove quotes if the model wrapped it
    text = text.strip('"').strip("'")

    del input_ids, output_ids
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-input", required=True)
    args = parser.parse_args()

    with open(args.json_input, "r", encoding="utf-8") as f:
        config = json.load(f)

    script = config.get("script", "")
    setting = config.get("setting", "")
    style = config.get("style", "")
    characters = config.get("characters", [])
    model_path = config.get("model_path", "")

    if not script.strip():
        print(json.dumps({"error": "Empty script provided"}))
        sys.exit(1)

    if not os.path.isdir(model_path):
        print(json.dumps({"error": f"Model not found: {model_path}"}))
        sys.exit(1)

    # Split script into lines and groups
    all_lines = script.split("\n")
    non_empty_lines = [l for l in all_lines if l.strip()]
    groups = split_into_scene_groups(non_empty_lines, group_size=5)

    sys.stderr.write(f"[enrich-directions] Script: {len(non_empty_lines)} lines -> {len(groups)} scene groups\n")
    sys.stderr.flush()

    # Load model with 4-bit quantization (same as dialogue-writer.py)
    # 9B model in bf16 = ~18GB, too large for 16GB VRAM
    # 4-bit NF4 = ~5GB VRAM, fits comfortably
    sys.stderr.write(f"[enrich-directions] Loading model: {model_path} (4-bit NF4)\n")
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
    sys.stderr.write(f"[enrich-directions] Model loaded in {time.time() - t0:.1f}s. VRAM: {vram_used:.1f}GB\n")
    sys.stderr.flush()

    # Generate one direction per scene group
    directions = []  # List of generated direction strings
    preceding_lines = []  # Accumulated lines for context

    for i, group in enumerate(groups):
        sys.stderr.write(f"[enrich-directions] Generating direction {i+1}/{len(groups)}...\n")
        sys.stderr.flush()

        direction = generate_direction(
            model, tokenizer,
            chunk_lines=group,
            preceding_lines=preceding_lines,
            setting=setting,
            style=style,
            characters=characters,
            prev_directions=directions,
        )

        directions.append(direction)
        preceding_lines.extend(group)

    # Cleanup model (thorough: same as dialogue-writer)
    sys.stderr.write("[enrich-directions] Unloading model...\n")
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

    # Reconstruct the enriched script: insert # [DIR] before each group
    enriched_lines = []
    for i, group in enumerate(groups):
        if i < len(directions) and directions[i]:
            enriched_lines.append(f"# [DIR] {directions[i]}")
        enriched_lines.extend(group)

    enriched_script = "\n".join(enriched_lines)

    sys.stderr.write(f"[enrich-directions] Done. Generated {len(directions)} unique directions.\n")
    sys.stderr.flush()

    print(json.dumps({"enrichedScript": enriched_script}))


if __name__ == "__main__":
    main()
