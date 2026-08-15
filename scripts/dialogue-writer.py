"""
Dialogue Writer - Generates multi-character dialogue scripts for Movie Maker.
Called by /api/movie-maker/write-script API route.

Now supports:
- Dynamic max_tokens scaling based on target duration
- SSE-compatible streaming progress via stderr (JSON lines)
- Chunked generation for long scripts (>120s) with context recycling

Usage:
  python dialogue-writer.py --json-input <path_to_input.json>

Input JSON:
  {
    "characters": [{"name": "Sarah", "personality": "warm, nurturing"}, ...],
    "scenario": "Two old friends reconnect at a coffee shop",
    "tone": "bittersweet",
    "duration_seconds": 60,
    "notes": "Include a surprise revelation",
    "model_path": "<absolute path to the local LLM directory>",
    "max_tokens": 3000
  }

Progress (stderr, one JSON per line):
  {"type":"status","message":"Loading model...","phase":"load"}
  {"type":"progress","tokens":150,"max_tokens":8000,"elapsed":12.3,"phase":"generate","chunk":1,"total_chunks":1}
  {"type":"status","message":"Parsing output...","phase":"parse"}

Outputs JSON to stdout:
  {
    "script": "[MUS] ...\n[D:1] ...\n...",
    "lines": [{"type": "dialogue", "speaker": 1, "text": "..."}, ...],
    "stats": {"dialogue_lines": 12, "sfx_lines": 5, "music_cues": 2, "narrator_lines": 0}
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
SYSTEM_PROMPT_FILE = os.path.join(SCRIPTS_DIR, "llm-system-prompt-dialogue-writer.txt")

_P = "|"
_STOP_STRS = [f"<{_P}im_end{_P}>", f"<{_P}endoftext{_P}>"]

# Tokens-per-second of script content (empirically: ~30 tokens per second of output)
TOKENS_PER_SCRIPT_SECOND = 35
MIN_MAX_TOKENS = 4000
MAX_MAX_TOKENS = 16000

# Chunk settings: scripts longer than this get chunked
CHUNK_THRESHOLD_SECONDS = 120
CHUNK_TARGET_SECONDS = 90  # Each chunk covers ~90s of script


def emit_progress(msg_type, **kwargs):
    """Emit structured progress/status to stderr as JSON."""
    obj = {"type": msg_type, **kwargs}
    sys.stderr.write(json.dumps(obj) + "\n")
    sys.stderr.flush()


def calculate_max_tokens(duration_seconds, max_tokens_override=None):
    """Calculate appropriate max_tokens based on target duration."""
    if max_tokens_override and max_tokens_override > MIN_MAX_TOKENS:
        return min(max_tokens_override, MAX_MAX_TOKENS)
    estimated = int(duration_seconds * TOKENS_PER_SCRIPT_SECOND)
    return max(MIN_MAX_TOKENS, min(estimated, MAX_MAX_TOKENS))


def load_system_prompt():
    """Load the dialogue writer system prompt."""
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


def build_user_message(characters, scenario, tone, duration_seconds, notes,
                       max_segment_duration=25, speaking_pace=2.5, pov_character=None):
    """Build the user message for the dialogue writer LLM."""
    parts = []

    parts.append(f"TARGET DURATION: approximately {duration_seconds} seconds total")
    parts.append(f"SPEAKING PACE: {speaking_pace} words per second")
    parts.append(f"MAX SEGMENT DURATION: {max_segment_duration} seconds (each [DIR] block must not exceed this)")

    if pov_character:
        parts.append(f"POV CHARACTER: All [DIR] visual directions must be written from the FIRST-PERSON perspective of {pov_character}. This character is the camera: they are never seen, but their hands/body can enter frame. All other characters face toward/away from camera.")

    if characters:
        char_desc = []
        for i, char in enumerate(characters, 1):
            name = char.get("name", f"Character {i}")
            role = char.get("role", "")
            personality = char.get("personality", "")
            description = char.get("description", "")
            age = char.get("age", "")
            gender = char.get("gender", "")
            line = f"  Character {i}: {name}"
            if role:
                line += f" ({role})"
            if age or gender:
                line += f"\n    Physical: {age}{' ' if age and gender else ''}{gender}"
            if personality:
                line += f"\n    Personality: {personality}"
            if description:
                line += f"\n    Description: {description}"
            line += f"\n    [For SFX: describe this character's sounds as '{age + ' ' if age else ''}{gender + ' ' if gender else ''}character': NEVER use their name]"
            char_desc.append(line)
        parts.append("CHARACTERS:\n" + "\n".join(char_desc))

    if scenario:
        parts.append(f"SCENARIO:\n{scenario}")

    if tone:
        parts.append(f"TONE/MOOD: {tone}")

    if notes:
        parts.append(f"ADDITIONAL NOTES:\n{notes}")

    parts.append("Generate the timestamped tagged script now. Output ONLY the timestamped lines, no other text.")

    return "\n\n".join(parts)


# Regex for the new timestamped format: [MM:SS.ms - MM:SS.ms][TAG] text
_TS_PATTERN = re.compile(
    r'^\[(\d{2}:\d{2}\.\d{2})\s*-\s*(\d{2}:\d{2}\.\d{2})\]'
)


def parse_timestamp(ts_str):
    """Parse MM:SS.ms string to seconds float."""
    match = re.match(r'(\d{2}):(\d{2})\.(\d{2})', ts_str)
    if not match:
        return 0.0
    mins, secs, ms = int(match.group(1)), int(match.group(2)), int(match.group(3))
    return mins * 60 + secs + ms / 100.0


def parse_script_lines(raw_script):
    """Parse the tagged script into structured line objects (supports timestamped and legacy formats)."""
    lines = []
    for raw_line in raw_script.strip().split("\n"):
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        # Try timestamped format first: [MM:SS.ms - MM:SS.ms][TAG] text
        start_time = None
        end_time = None
        content_part = raw_line

        ts_match = _TS_PATTERN.match(raw_line)
        if ts_match:
            start_time = parse_timestamp(ts_match.group(1))
            end_time = parse_timestamp(ts_match.group(2))
            content_part = raw_line[ts_match.end():].strip()

        # Match [D:N], [SFX], [MUS], [NAR], [DIR] on the content part
        match = re.match(r'^\[D:(\d+)\]\s*(.+)$', content_part)
        if match:
            lines.append({
                "type": "dialogue",
                "speaker": int(match.group(1)),
                "text": match.group(2).strip(),
                "start": start_time,
                "end": end_time,
                "raw": raw_line,
            })
            continue

        match = re.match(r'^\[SFX\]\s*(.+)$', content_part, re.IGNORECASE)
        if match:
            lines.append({
                "type": "sfx",
                "speaker": 0,
                "text": match.group(1).strip(),
                "start": start_time,
                "end": end_time,
                "raw": raw_line,
            })
            continue

        match = re.match(r'^\[MUS\]\s*(.+)$', content_part, re.IGNORECASE)
        if match:
            lines.append({
                "type": "music",
                "speaker": 0,
                "text": match.group(1).strip(),
                "start": start_time,
                "end": end_time,
                "raw": raw_line,
            })
            continue

        match = re.match(r'^\[NAR\]\s*(.+)$', content_part, re.IGNORECASE)
        if match:
            lines.append({
                "type": "narrator",
                "speaker": 0,
                "text": match.group(1).strip(),
                "start": start_time,
                "end": end_time,
                "raw": raw_line,
            })
            continue

        match = re.match(r'^\[DIR\]\s*(.+)$', content_part, re.IGNORECASE)
        if match:
            lines.append({
                "type": "direction",
                "speaker": 0,
                "text": match.group(1).strip(),
                "start": start_time,
                "end": end_time,
                "raw": raw_line,
            })
            continue

        # Untagged line: treat as dialogue from speaker 1
        if raw_line and not raw_line.startswith("#"):
            lines.append({
                "type": "dialogue",
                "speaker": 1,
                "text": raw_line,
                "start": start_time,
                "end": end_time,
                "raw": f"[D:1] {raw_line}",
            })

    return lines


def compute_stats(lines):
    """Compute statistics about the generated script."""
    stats = {
        "dialogue_lines": sum(1 for l in lines if l["type"] == "dialogue"),
        "sfx_lines": sum(1 for l in lines if l["type"] == "sfx"),
        "music_cues": sum(1 for l in lines if l["type"] == "music"),
        "narrator_lines": sum(1 for l in lines if l["type"] == "narrator"),
        "direction_lines": sum(1 for l in lines if l["type"] == "direction"),
        "total_lines": len(lines),
        "speakers_used": sorted(set(l["speaker"] for l in lines if l["type"] == "dialogue")),
    }
    return stats


def clean_llm_output(text):
    """Clean LLM output: remove think blocks, markdown fences, preamble."""
    # Strip <think>...</think> blocks
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    # Strip markdown code fences
    text = re.sub(r"^```[a-zA-Z]*\s*\n?", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n?```\s*$", "", text, flags=re.MULTILINE)

    # Find the first tagged line and take everything from there
    # Supports both timestamped [MM:SS.ms - MM:SS.ms][TAG] and legacy [TAG] formats
    lines = text.split("\n")
    start_idx = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if re.match(r'^\[(D:\d+|SFX|MUS|NAR|DIR)\]', stripped, re.IGNORECASE):
            start_idx = i
            break
        if re.match(r'^\[\d{2}:\d{2}\.\d{2}\s*-\s*\d{2}:\d{2}\.\d{2}\]', stripped):
            start_idx = i
            break

    return "\n".join(lines[start_idx:]).strip()


def main():
    parser = argparse.ArgumentParser(description="Generate dialogue script using Qwen3.5-9B")
    parser.add_argument("--json-input", required=True, help="Path to JSON file with parameters")
    args = parser.parse_args()

    with open(args.json_input, "r", encoding="utf-8") as f:
        params = json.load(f)

    characters = params.get("characters", [])
    scenario = params.get("scenario", "")
    tone = params.get("tone", "")
    duration_seconds = params.get("duration_seconds", 60)
    notes = params.get("notes", "")
    model_path = params.get("model_path", "")
    max_tokens = params.get("max_tokens", 4000)
    max_segment_duration = params.get("max_segment_duration", 25)
    speaking_pace = params.get("speaking_pace", 2.5)
    pov_character = params.get("pov_character", None)

    if not model_path or not os.path.isdir(model_path):
        print(json.dumps({"error": f"Model directory not found: {model_path}"}))
        sys.exit(1)

    if not os.path.isfile(SYSTEM_PROMPT_FILE):
        print(json.dumps({"error": f"System prompt not found: {SYSTEM_PROMPT_FILE}"}))
        sys.exit(1)

    # Calculate dynamic max_tokens
    effective_max_tokens = calculate_max_tokens(duration_seconds, max_tokens)
    emit_progress("status", message=f"Target: {duration_seconds}s script, {effective_max_tokens} max tokens", phase="init")

    try:
        system_prompt = load_system_prompt()

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

        stop_ids = get_stop_ids(tokenizer)

        # Decide: single-pass or chunked generation
        if duration_seconds > CHUNK_THRESHOLD_SECONDS:
            output_text = generate_chunked(
                model, tokenizer, system_prompt, stop_ids,
                characters, scenario, tone, duration_seconds, notes,
                max_segment_duration, speaking_pace, pov_character,
                effective_max_tokens,
            )
        else:
            output_text = generate_single_pass(
                model, tokenizer, system_prompt, stop_ids,
                characters, scenario, tone, duration_seconds, notes,
                max_segment_duration, speaking_pace, pov_character,
                effective_max_tokens, chunk_num=1, total_chunks=1,
            )

        emit_progress("status", message="Parsing output...", phase="parse")

        # Clean and parse
        cleaned = clean_llm_output(output_text)
        if not cleaned:
            print(json.dumps({"error": "LLM produced empty output", "raw_output": output_text[:2000]}))
            sys.exit(0)

        lines = parse_script_lines(cleaned)
        if not lines:
            print(json.dumps({"error": "No valid tagged lines in output", "raw_output": output_text[:2000]}))
            sys.exit(0)

        stats = compute_stats(lines)
        emit_progress("status", message=f"Done: {stats['total_lines']} lines ({stats['dialogue_lines']} dialogue, {stats['sfx_lines']} SFX, {stats['music_cues']} music)", phase="done")

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

        vram_alloc = torch.cuda.memory_allocated() / 1024**3 if torch.cuda.is_available() else 0
        emit_progress("status", message=f"VRAM freed ({vram_alloc:.2f}GB remaining)", phase="cleanup")

        # Build the clean script text (only the raw tagged lines)
        script_text = "\n".join(l["raw"] for l in lines)

        # Output result
        print(json.dumps({
            "script": script_text,
            "lines": lines,
            "stats": stats,
        }))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def generate_single_pass(model, tokenizer, system_prompt, stop_ids,
                         characters, scenario, tone, duration_seconds, notes,
                         max_segment_duration, speaking_pace, pov_character,
                         max_tokens, chunk_num=1, total_chunks=1,
                         time_range_hint=None, prior_context=None):
    """Generate script in a single model.generate() call with streaming progress."""
    user_message = build_user_message(
        characters, scenario, tone, duration_seconds, notes,
        max_segment_duration=max_segment_duration,
        speaking_pace=speaking_pace,
        pov_character=pov_character,
    )

    # Add time range hint for chunked generation
    if time_range_hint:
        user_message += f"\n\nTIME RANGE: Generate script content from {time_range_hint[0]} to approximately {time_range_hint[1]}. Start timestamps at {time_range_hint[0]}."

    # Add prior context for continuation chunks
    if prior_context:
        user_message += f"\n\nPRIOR SCRIPT CONTEXT (continue from here, do NOT repeat these lines):\n{prior_context}"

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
        raw = tokenizer.apply_chat_template(
            messages, return_tensors="pt",
            add_generation_prompt=True,
        )

    # Handle various return types
    if hasattr(raw, "input_ids"):
        input_ids = raw.input_ids.to(model.device)
    elif isinstance(raw, dict):
        input_ids = raw["input_ids"].to(model.device)
    elif isinstance(raw, list):
        input_ids = torch.tensor([raw], dtype=torch.long).to(model.device)
    else:
        input_ids = raw.to(model.device)
    input_len = input_ids.shape[1]

    emit_progress("status", message=f"Generating chunk {chunk_num}/{total_chunks} ({max_tokens} tokens, input={input_len} tokens)...", phase="generate")

    # Use TextIteratorStreamer for streaming progress
    streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)

    gen_kwargs = dict(
        input_ids=input_ids,
        max_new_tokens=max_tokens,
        temperature=0.8,
        do_sample=True,
        top_k=40,
        top_p=0.9,
        min_p=0.0,
        repetition_penalty=1.05,
        use_cache=True,
        pad_token_id=tokenizer.eos_token_id,
        eos_token_id=stop_ids,
        streamer=streamer,
    )

    # Run generation in a background thread
    gen_thread = threading.Thread(target=_generate_thread, args=(model, gen_kwargs))
    gen_thread.start()

    # Collect output while reporting progress
    output_text = ""
    token_count = 0
    t_start = time.time()
    last_progress_time = 0

    for text_chunk in streamer:
        output_text += text_chunk
        token_count += len(tokenizer.encode(text_chunk, add_special_tokens=False))

        # Emit progress every 2 seconds
        now = time.time()
        if now - last_progress_time >= 2.0:
            elapsed = now - t_start
            # Estimate progress based on tokens vs max
            pct = min(95, int(100 * token_count / max_tokens))
            tokens_per_sec = token_count / elapsed if elapsed > 0 else 0
            remaining_tokens = max_tokens - token_count
            eta = remaining_tokens / tokens_per_sec if tokens_per_sec > 0 else 0
            emit_progress("progress",
                tokens=token_count,
                max_tokens=max_tokens,
                percent=pct,
                elapsed=round(elapsed, 1),
                eta=round(eta, 1),
                tokens_per_sec=round(tokens_per_sec, 1),
                phase="generate",
                chunk=chunk_num,
                total_chunks=total_chunks,
            )
            last_progress_time = now

    gen_thread.join()
    del input_ids

    elapsed = time.time() - t_start
    emit_progress("progress",
        tokens=token_count,
        max_tokens=max_tokens,
        percent=100,
        elapsed=round(elapsed, 1),
        eta=0,
        tokens_per_sec=round(token_count / elapsed if elapsed > 0 else 0, 1),
        phase="generate",
        chunk=chunk_num,
        total_chunks=total_chunks,
    )

    return output_text.strip()


def _generate_thread(model, gen_kwargs):
    """Run model.generate in a thread (for streaming)."""
    with torch.no_grad():
        model.generate(**gen_kwargs)


def generate_chunked(model, tokenizer, system_prompt, stop_ids,
                     characters, scenario, tone, duration_seconds, notes,
                     max_segment_duration, speaking_pace, pov_character,
                     total_max_tokens):
    """
    Generate a long script in chunks with context recycling.
    Each chunk covers ~CHUNK_TARGET_SECONDS of script time.
    Prior context is summarized (last 5 lines) to maintain continuity
    without exhausting the context window.
    """
    num_chunks = max(2, int(duration_seconds / CHUNK_TARGET_SECONDS + 0.5))
    chunk_duration = duration_seconds / num_chunks
    tokens_per_chunk = min(total_max_tokens, int(total_max_tokens / num_chunks * 1.3))  # 30% overhead per chunk
    tokens_per_chunk = max(MIN_MAX_TOKENS, tokens_per_chunk)

    emit_progress("status", message=f"Long script ({duration_seconds}s), splitting into {num_chunks} chunks of ~{chunk_duration:.0f}s each", phase="generate")

    all_output = []

    for i in range(num_chunks):
        chunk_start_sec = i * chunk_duration
        chunk_end_sec = min((i + 1) * chunk_duration, duration_seconds)

        # Format time range as MM:SS.ms
        start_ts = f"{int(chunk_start_sec // 60):02d}:{int(chunk_start_sec % 60):02d}.00"
        end_ts = f"{int(chunk_end_sec // 60):02d}:{int(chunk_end_sec % 60):02d}.00"

        # Build prior context from last chunk's output (last 5 lines)
        prior_context = None
        if i > 0 and all_output:
            prior_lines = all_output[-1].strip().split("\n")
            # Keep last 5 lines as context bridge
            context_lines = prior_lines[-5:] if len(prior_lines) > 5 else prior_lines
            prior_context = "\n".join(context_lines)

        # Adjust duration hint for this chunk
        chunk_output = generate_single_pass(
            model, tokenizer, system_prompt, stop_ids,
            characters, scenario, tone, int(chunk_duration), notes,
            max_segment_duration, speaking_pace, pov_character,
            tokens_per_chunk,
            chunk_num=i + 1,
            total_chunks=num_chunks,
            time_range_hint=(start_ts, end_ts),
            prior_context=prior_context,
        )

        all_output.append(chunk_output)

    # Combine all chunks
    return "\n".join(all_output)


if __name__ == "__main__":
    main()
