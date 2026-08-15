"""
Scene Prompt Writer: Generates Flux.2 Klein 9B image prompts from [DIR] blocks.
Called by /api/movie-maker/generate-scene-prompts API route.

Takes visual directions from a film script and character descriptions,
produces photorealistic image prompts optimized for Klein 9B as LTX2.3 I2V starter frames.

Usage:
  python scene-prompt-writer.py --json-input <path_to_input.json>

Input JSON:
  {
    "directions": [
      {"index": 1, "text": "Over-the-shoulder shot...", "timestamp": "00:00.00 - 00:19.50"},
      ...
    ],
    "characters": [
      {"name": "Sarah", "age": "28", "gender": "female", "description": "auburn hair, green eyes"},
      ...
    ],
    "model_path": "<absolute path to the local LLM directory>",
    "output_file": "path/to/output.txt"
  }

Progress (stderr, one JSON per line):
  {"type":"status","message":"Loading model...","phase":"load"}
  {"type":"progress","tokens":150,"max_tokens":4000,"elapsed":12.3,"phase":"generate"}

Outputs JSON to stdout:
  {
    "prompts": [
      {"index": 1, "timestamp": "00:00.00 - 00:19.50", "direction": "...", "prompt": "A cinematic..."},
      ...
    ],
    "output_file": "path/to/saved/file.txt"
  }
  or { "error": "..." }
"""

import argparse
import gc
import json
import os
import re
import sys
import time
import threading

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TextIteratorStreamer

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
if not os.environ.get("VEKSNAP_ALLOW_ONLINE"):
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
SYSTEM_PROMPT_FILE = os.path.join(SCRIPTS_DIR, "llm-system-prompt-scene-prompts.txt")

_P = "|"
_STOP_STRS = [f"<{_P}im_end{_P}>", f"<{_P}endoftext{_P}>"]


def emit_progress(msg_type, **kwargs):
    """Emit structured progress/status to stderr as JSON."""
    obj = {"type": msg_type, **kwargs}
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def load_system_prompt():
    with open(SYSTEM_PROMPT_FILE, "r", encoding="utf-8") as f:
        return f.read().strip()


def get_stop_ids(tokenizer):
    stop_ids = []
    if tokenizer.eos_token_id is not None:
        stop_ids.append(tokenizer.eos_token_id)
    for s in _STOP_STRS:
        ids = tokenizer.encode(s, add_special_tokens=False)
        if len(ids) == 1 and ids[0] not in stop_ids:
            stop_ids.append(ids[0])
    return stop_ids


def build_user_message(directions, characters):
    """Build the user message listing characters and selected DIR blocks."""
    parts = []

    if characters:
        char_lines = []
        for i, c in enumerate(characters, 1):
            name = c.get("name", f"Character {i}")
            age = c.get("age", "")
            gender = c.get("gender", "")
            desc = c.get("description", "")
            role = c.get("role", "")
            personality = c.get("personality", "")
            line = f"  Character {i}: \"{name}\""
            if age or gender:
                line += f", {age}{' ' if age and gender else ''}{gender}"
            if desc:
                line += f", {desc}"
            if role:
                line += f" (Role: {role})"
            char_lines.append(line)
        parts.append("CHARACTERS (translate names to physical descriptions in prompts):\n" + "\n".join(char_lines))

    parts.append("SCENE DIRECTIONS TO CONVERT:")
    for d in directions:
        idx = d.get("index", 0)
        ts = d.get("timestamp", "")
        text = d.get("text", "")
        ts_label = f" [{ts}]" if ts else ""
        parts.append(f"\n---SCENE {idx}---{ts_label}\n{text}")

    parts.append("\nGenerate a Klein 9B image prompt for each scene above. Output ONLY the prompts in the specified format.")

    return "\n\n".join(parts)


def parse_prompts(raw_output, directions):
    """Parse the LLM output into individual scene prompts."""
    # Clean output
    raw_output = re.sub(r"<think>.*?</think>", "", raw_output, flags=re.DOTALL).strip()
    raw_output = re.sub(r"^```[a-zA-Z]*\s*\n?", "", raw_output, flags=re.MULTILINE)
    raw_output = re.sub(r"\n?```\s*$", "", raw_output, flags=re.MULTILINE)

    prompts = []
    # Split by ---SCENE N--- markers
    pattern = re.compile(r'---SCENE\s+(\d+)---\s*', re.IGNORECASE)
    parts = pattern.split(raw_output)

    # parts = [pre-text, "1", prompt1, "2", prompt2, ...]
    dir_lookup = {d["index"]: d for d in directions}

    i = 1
    while i < len(parts) - 1:
        try:
            scene_num = int(parts[i])
        except ValueError:
            i += 2
            continue
        prompt_text = parts[i + 1].strip()
        # Clean up any trailing markers or whitespace
        prompt_text = re.sub(r'\n---SCENE.*$', '', prompt_text, flags=re.DOTALL).strip()

        if prompt_text and scene_num in dir_lookup:
            d = dir_lookup[scene_num]
            prompts.append({
                "index": scene_num,
                "timestamp": d.get("timestamp", ""),
                "direction": d.get("text", ""),
                "prompt": prompt_text,
            })
        i += 2

    return prompts


def save_prompts_file(prompts, output_file):
    """Save prompts to a formatted text file."""
    lines = []
    lines.append("=" * 60)
    lines.append("  MOVIE MAKER: Scene Image Prompts (Klein 9B)")
    lines.append(f"  Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"  Scenes: {len(prompts)}")
    lines.append("=" * 60)
    lines.append("")

    for p in prompts:
        ts_label = f" [{p['timestamp']}]" if p.get("timestamp") else ""
        lines.append(f"{'=' * 50}")
        lines.append(f"  SCENE {p['index']}{ts_label}")
        lines.append(f"{'=' * 50}")
        lines.append("")
        lines.append(f"DIRECTION: {p['direction']}")
        lines.append("")
        lines.append(f"PROMPT:")
        lines.append(p["prompt"])
        lines.append("")
        lines.append("")

    content = "\n".join(lines)
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(content)


def _generate_thread(model, gen_kwargs):
    with torch.no_grad():
        model.generate(**gen_kwargs)


def main():
    parser = argparse.ArgumentParser(description="Generate Klein 9B scene prompts")
    parser.add_argument("--json-input", required=True, help="Path to JSON input file")
    args = parser.parse_args()

    with open(args.json_input, "r", encoding="utf-8") as f:
        params = json.load(f)

    directions = params.get("directions", [])
    characters = params.get("characters", [])
    model_path = params.get("model_path", "")
    output_file = params.get("output_file", "")

    if not directions:
        print(json.dumps({"error": "No directions provided"}))
        sys.exit(1)

    if not model_path or not os.path.isdir(model_path):
        print(json.dumps({"error": f"Model directory not found: {model_path}"}))
        sys.exit(1)

    if not os.path.isfile(SYSTEM_PROMPT_FILE):
        print(json.dumps({"error": f"System prompt not found: {SYSTEM_PROMPT_FILE}"}))
        sys.exit(1)

    # Calculate max tokens: ~200 tokens per scene prompt
    max_tokens = max(2000, len(directions) * 250)
    emit_progress("status", message=f"Generating prompts for {len(directions)} scenes ({max_tokens} max tokens)", phase="init")

    try:
        system_prompt = load_system_prompt()
        user_message = build_user_message(directions, characters)

        emit_progress("status", message="Loading model (4-bit NF4)...", phase="load")
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
        load_time = time.time() - t0
        emit_progress("status", message=f"Model loaded in {load_time:.1f}s (VRAM: {vram_used:.1f}GB)", phase="load")

        messages = [
            {"role": "system", "content": system_prompt},
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

        stop_ids = get_stop_ids(tokenizer)

        emit_progress("status", message=f"Generating {len(directions)} scene prompts (input={input_len} tokens)...", phase="generate")

        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
        gen_kwargs = dict(
            input_ids=input_ids,
            max_new_tokens=max_tokens,
            temperature=0.7,
            do_sample=True,
            top_k=30,
            top_p=0.85,
            min_p=0.0,
            repetition_penalty=1.08,
            use_cache=True,
            pad_token_id=tokenizer.eos_token_id,
            eos_token_id=stop_ids,
            streamer=streamer,
        )

        gen_thread = threading.Thread(target=_generate_thread, args=(model, gen_kwargs))
        gen_thread.start()

        output_text = ""
        token_count = 0
        t_start = time.time()
        last_progress_time = 0

        for text_chunk in streamer:
            output_text += text_chunk
            token_count += len(tokenizer.encode(text_chunk, add_special_tokens=False))

            now = time.time()
            if now - last_progress_time >= 2.0:
                elapsed = now - t_start
                pct = min(95, int(100 * token_count / max_tokens))
                tokens_per_sec = token_count / elapsed if elapsed > 0 else 0
                remaining = max_tokens - token_count
                eta = remaining / tokens_per_sec if tokens_per_sec > 0 else 0
                emit_progress("progress",
                    tokens=token_count,
                    max_tokens=max_tokens,
                    percent=pct,
                    elapsed=round(elapsed, 1),
                    eta=round(eta, 1),
                    tokens_per_sec=round(tokens_per_sec, 1),
                    phase="generate",
                )
                last_progress_time = now

        gen_thread.join()
        del input_ids

        elapsed = time.time() - t_start
        emit_progress("progress",
            tokens=token_count, max_tokens=max_tokens, percent=100,
            elapsed=round(elapsed, 1), eta=0,
            tokens_per_sec=round(token_count / elapsed if elapsed > 0 else 0, 1),
            phase="generate",
        )

        emit_progress("status", message="Parsing prompts...", phase="parse")

        prompts = parse_prompts(output_text, directions)
        if not prompts:
            print(json.dumps({"error": "Failed to parse any scene prompts from LLM output", "raw_output": output_text[:3000]}))
            sys.exit(0)

        # Save to file
        if output_file:
            save_prompts_file(prompts, output_file)
            emit_progress("status", message=f"Saved {len(prompts)} prompts to {os.path.basename(output_file)}", phase="done")

        # Unload model
        emit_progress("status", message="Freeing VRAM...", phase="cleanup")
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

        emit_progress("status", message=f"Done: {len(prompts)} scene prompts generated", phase="done")

        print(json.dumps({
            "prompts": prompts,
            "output_file": output_file,
        }))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
