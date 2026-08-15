"""
Script Writer - Generates multi-segment video scripts for LTX-2.3.
Called by /api/script-writer API route.

Usage:
  python script-writer.py --json-input <path_to_input.json>

Input JSON:
  {
    "characters": "description of characters",
    "scene": "scene/setting description",
    "mood": "mood/tone",
    "duration": 20,  (target total seconds)
    "notes": "any additional notes",
    "model_path": "<absolute path to the local LLM directory>",
    "max_tokens": 2000
  }

Outputs JSON to stdout: { "segments": [...] } or { "error": "..." }
"""

import argparse
import gc
import json
import os
import re
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
if not os.environ.get("VEKSNAP_ALLOW_ONLINE"):
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
SYSTEM_PROMPT_FILE = os.path.join(SCRIPTS_DIR, "llm-system-prompt-scriptwriter.txt")

# Build special token strings programmatically
_P = "|"
_STOP_STRS = [f"<{_P}im_end{_P}>", f"<{_P}endoftext{_P}>"]


def load_system_prompt():
    """Load the script writer system prompt."""
    with open(SYSTEM_PROMPT_FILE, "r", encoding="utf-8") as f:
        return f.read().strip()


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


def build_user_message(characters, scene, mood, duration, notes):
    """Build the user message for the script writer LLM."""
    parts = []

    # Duration
    parts.append(f"TARGET DURATION: {duration} seconds at 24fps ({int(duration * 24)} total frames)")

    # Characters
    if characters.strip():
        parts.append(f"CHARACTERS:\n{characters.strip()}")

    # Scene
    if scene.strip():
        parts.append(f"SCENE/SETTING:\n{scene.strip()}")

    # Mood
    if mood.strip():
        parts.append(f"MOOD/TONE: {mood.strip()}")

    # Notes
    if notes.strip():
        parts.append(f"ADDITIONAL NOTES:\n{notes.strip()}")

    parts.append("Generate the script now. Output ONLY the JSON array.")

    return "\n\n".join(parts)


def extract_json_array(text):
    """Extract a JSON array from LLM output, handling markdown fences and preamble."""
    # Strip <think>...</think> blocks
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    # Try to find JSON array directly
    # Look for the first [ and last ]
    start = text.find("[")
    end = text.rfind("]")

    if start == -1 or end == -1 or end <= start:
        return None

    json_str = text[start:end + 1]

    try:
        parsed = json.loads(json_str)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    # Try fixing common issues: trailing commas
    json_str_fixed = re.sub(r",\s*]", "]", json_str)
    json_str_fixed = re.sub(r",\s*}", "}", json_str_fixed)
    try:
        parsed = json.loads(json_str_fixed)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    return None


def validate_segments(segments):
    """Validate and normalize segment data."""
    valid_frames = {97, 121, 161, 201, 257}
    validated = []

    for seg in segments:
        if not isinstance(seg, dict):
            continue

        frames = seg.get("frames", 161)
        if frames not in valid_frames:
            # Snap to nearest valid frame count
            frames = min(valid_frames, key=lambda x: abs(x - frames))

        prompt = seg.get("prompt", "").strip()
        if not prompt:
            continue

        validated.append({
            "frames": frames,
            "prompt": prompt,
            "dialogue": seg.get("dialogue", "").strip(),
            "shot_description": seg.get("shot_description", "").strip() or "Scene",
            "recommended_duration": seg.get("recommended_duration"),
        })

    return validated


def main():
    parser = argparse.ArgumentParser(description="Generate video script using Qwen3.5-9B")
    parser.add_argument("--json-input", required=True, help="Path to JSON file with parameters")
    args = parser.parse_args()

    with open(args.json_input, "r", encoding="utf-8") as f:
        params = json.load(f)

    characters = params.get("characters", "")
    scene = params.get("scene", "")
    mood = params.get("mood", "")
    duration = params.get("duration", 10)
    notes = params.get("notes", "")
    model_path = params.get("model_path", "")
    max_tokens = params.get("max_tokens", 2000)

    if not model_path or not os.path.isdir(model_path):
        print(json.dumps({"error": f"Model directory not found: {model_path}"}))
        sys.exit(1)

    if not os.path.isfile(SYSTEM_PROMPT_FILE):
        print(json.dumps({"error": f"System prompt not found: {SYSTEM_PROMPT_FILE}"}))
        sys.exit(1)

    try:
        system_prompt = load_system_prompt()
        user_message = build_user_message(characters, scene, mood, duration, notes)

        print(f"[script-writer] Loading model from {model_path} (4-bit NF4)...", file=sys.stderr)

        compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

        tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
        if torch.cuda.is_available():
            # NVIDIA: 4-bit NF4 (bitsandbytes) on the GPU.
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
            # CPU / AMD (no CUDA): bitsandbytes 4-bit is CUDA-only, so load
            # unquantized on CPU in float32 (more stable/faster than fp16 on CPU).
            print("[cpu-fallback] No CUDA detected - loading LLM on CPU in float32 (slower).", file=sys.stderr)
            model = AutoModelForCausalLM.from_pretrained(
                model_path,
                torch_dtype=torch.float32,
                local_files_only=True,
            )
        model.eval()

        vram_used = torch.cuda.memory_allocated() / 1024**3 if torch.cuda.is_available() else 0
        print(f"[script-writer] Model loaded. VRAM: {vram_used:.1f}GB", file=sys.stderr)

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ]

        # Use enable_thinking=False to disable Qwen3 reasoning mode
        try:
            raw = tokenizer.apply_chat_template(
                messages, return_tensors="pt",
                add_generation_prompt=True, enable_thinking=False,
            )
        except TypeError:
            print("[script-writer] enable_thinking kwarg not supported, retrying without it", file=sys.stderr)
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

        stop_ids = get_stop_ids(tokenizer)

        print(f"[script-writer] Generating script ({max_tokens} max tokens)...", file=sys.stderr)

        with torch.no_grad():
            out = model.generate(
                input_ids,
                max_new_tokens=max_tokens,
                temperature=0.7,
                do_sample=True,
                top_k=30,
                top_p=0.85,
                min_p=0.0,
                repetition_penalty=1.03,
                use_cache=True,
                pad_token_id=tokenizer.eos_token_id,
                eos_token_id=stop_ids,
            )

        output_text = tokenizer.decode(out[0][input_len:], skip_special_tokens=True).strip()
        del out, input_ids

        print(f"[script-writer] Raw output: {len(output_text)} chars", file=sys.stderr)

        # Parse JSON array from output
        segments = extract_json_array(output_text)

        if segments is None:
            # If parsing failed, return the raw text so the frontend can display it
            print(f"[script-writer] WARNING: Failed to parse JSON from output", file=sys.stderr)
            print(f"[script-writer] Raw: {output_text[:500]}", file=sys.stderr)
            print(json.dumps({"error": "Failed to parse script output as JSON", "raw_output": output_text[:2000]}))
            sys.exit(0)

        validated = validate_segments(segments)

        if not validated:
            print(json.dumps({"error": "No valid segments in output", "raw_output": output_text[:2000]}))
            sys.exit(0)

        total_frames = sum(s["frames"] for s in validated)
        total_seconds = total_frames / 24.0
        print(f"[script-writer] Generated {len(validated)} segments, {total_frames} frames ({total_seconds:.1f}s)", file=sys.stderr)

        # Unload model to free VRAM
        print("[script-writer] Unloading model...", file=sys.stderr)
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

        vram_alloc = torch.cuda.memory_allocated() / 1024**3 if torch.cuda.is_available() else 0
        print(f"[script-writer] VRAM after free: {vram_alloc:.2f}GB", file=sys.stderr)

        # Output result
        print(json.dumps({"segments": validated, "total_seconds": round(total_seconds, 1)}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
