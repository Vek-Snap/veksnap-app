"""
Prompt Expand - Standalone script for Qwen3.5-9B prompt expansion.
Called by /api/prompt-expand API route.

Usage:
  python prompt-expand.py "short prompt" model_path [--style "cinematic_drama"] [--scene-context "vision description"] [--max-tokens 600]

Outputs JSON to stdout: { "expanded": "...", "negative": "..." }
Loads model, runs inference, unloads, exits - keeping VRAM free for LTX-2.
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

# Build special token strings programmatically
_P = "|"
_STOP_STRS = [f"<{_P}im_end{_P}>", f"<{_P}endoftext{_P}>"]

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
SYSTEM_PROMPT_FILE = os.path.join(SCRIPTS_DIR, "llm-system-prompt.txt")
SYSTEM_PROMPT_IMAGE_FILE = os.path.join(SCRIPTS_DIR, "llm-system-prompt-image.txt")

# ── Output cleaning regexes (ported from LTX2EasyPromptQwen._clean_output) ──
_PREAMBLE_RE = re.compile(
    r"^(Sure!?|Certainly!?|Absolutely!?|Of course!?|Here(?:'s| is)[\s\S]*?:|"
    r"Great!?|LTX-?2(?:\.\d)?(?:\s+\w+)*\s*prompt\s*:|Prompt\s*:|Output\s*:|Scene\s*:)[^\n]*\n?",
    re.IGNORECASE,
)
_ROLE_BLEED_RE = re.compile(
    r"\s*(assistant|user|system)\s*$",
    re.IGNORECASE,
)


def clean_output(text):
    """Strip thinking tags, preambles, role bleed, and meta-commentary."""
    text = text.strip()
    # Strip <think>...</think> blocks (Qwen3 reasoning mode)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    # Strip preamble ("Sure! Here is...", "Prompt:", etc.)
    text = _PREAMBLE_RE.sub("", text).strip()
    # Strip trailing role bleed ("assistant", "user", etc.)
    text = _ROLE_BLEED_RE.sub("", text).strip()
    # Strip role bleed mid-text
    text = re.sub(r"\.(assistant|user|system)\s*\n", ".\n", text, flags=re.IGNORECASE).strip()
    # Strip trailing notes / meta-commentary
    text = re.sub(r"\s*\n+Note:.*$", "", text, flags=re.DOTALL).strip()
    text = re.sub(
        r"\s*\n+(Please let me know|Let me revise|No further revision|Confirmed\.|"
        r"Written to meet|The scene is now over|The output ends|The task is|The task was|"
        r"The goal was|Nothing more|No continuation|No additional|The response does not|"
        r"It does not continue|It ceases when|Any such statement|"
        r"Output length:|Action count:|Total time:|Last character:|I avoided|I wrote|"
        r"I adhered|I hope this|Thank you for your|Please confirm|I submitted|"
        r"I can revise|feel free to instruct).*$",
        "", text, flags=re.DOTALL | re.IGNORECASE,
    ).strip()
    text = re.sub(
        r"\s*(Ended\.\s*\d+\s*actions|"
        r"\d+\s+actions[\.,]\s*\d+\s+tokens|"
        r"\d+\s+tokens[\.,]\s*Done|"
        r"Done\.\s+\d+\s+seconds|"
        r"Finished\.\s+\d+|"
        r"Hard stop\..*$)",
        "", text, flags=re.DOTALL | re.IGNORECASE,
    ).strip()
    text = re.sub(r"\.?\s+The total duration.*$", ".", text, flags=re.DOTALL | re.IGNORECASE).strip()
    text = re.sub(r"\.?\s+The (scene'?s? )?total (duration|running time).*$", ".", text, flags=re.DOTALL | re.IGNORECASE).strip()
    text = re.sub(r"\s*\(\d+\s+seconds?\)\s*$", "", text).strip()
    return text


def load_system_prompt(mode="video"):
    """Load the full system prompt from the text file (video or image mode)."""
    prompt_file = SYSTEM_PROMPT_IMAGE_FILE if mode == "image" else SYSTEM_PROMPT_FILE
    if not os.path.isfile(prompt_file):
        # Fallback to video prompt if image prompt doesn't exist
        prompt_file = SYSTEM_PROMPT_FILE
    with open(prompt_file, "r", encoding="utf-8") as f:
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


def build_user_message(prompt, style_instruction="", scene_context=""):
    """Build the user message for the LLM."""
    parts = []

    if style_instruction:
        parts.append(f"STYLE INSTRUCTION:\n{style_instruction}")

    if scene_context:
        parts.append(f"SCENE CONTEXT (from vision model - use this as your primary visual reference):\n{scene_context}")

    parts.append(f"USER PROMPT:\n{prompt}")
    parts.append("DIALOGUE INSTRUCTION: No dialogue unless the user wrote spoken words.")

    return "\n\n".join(parts)


def main():
    parser = argparse.ArgumentParser(description="Expand a prompt using Qwen3.5-9B")
    parser.add_argument("prompt", nargs="?", default="", help="The short user prompt to expand")
    parser.add_argument("model_path", nargs="?", default="", help="Path to local Qwen3.5-9B model directory")
    parser.add_argument("--style", default="", help="Style instruction text")
    parser.add_argument("--scene-context", default="", help="Scene context from vision model")
    parser.add_argument("--max-tokens", type=int, default=600, help="Max new tokens")
    parser.add_argument("--json-input", default="", help="Path to JSON file with all parameters")
    args = parser.parse_args()

    # If --json-input is provided, read params from the JSON file
    if args.json_input:
        with open(args.json_input, "r", encoding="utf-8") as f:
            params = json.load(f)
        args.prompt = params.get("prompt", args.prompt)
        args.model_path = params.get("model_path", args.model_path)
        args.style = params.get("style", args.style)
        args.scene_context = params.get("scene_context", args.scene_context)
        args.max_tokens = params.get("max_tokens", args.max_tokens)
        args.mode = params.get("mode", "video")

    if not args.prompt:
        print(json.dumps({"error": "No prompt provided"}))
        sys.exit(1)

    if not args.model_path or not os.path.isdir(args.model_path):
        print(json.dumps({"error": f"Model directory not found: {args.model_path}"}))
        sys.exit(1)

    mode = getattr(args, "mode", "video") or "video"
    prompt_file = SYSTEM_PROMPT_IMAGE_FILE if mode == "image" else SYSTEM_PROMPT_FILE
    if not os.path.isfile(prompt_file) and not os.path.isfile(SYSTEM_PROMPT_FILE):
        print(json.dumps({"error": f"System prompt file not found: {prompt_file}"}))
        sys.exit(1)

    try:
        system_prompt = load_system_prompt(mode)
        user_message = build_user_message(args.prompt, args.style, args.scene_context)

        print(f"[prompt-expand] Loading model from {args.model_path} (4-bit NF4)...", file=sys.stderr)

        compute_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

        tokenizer = AutoTokenizer.from_pretrained(args.model_path, local_files_only=True)
        if torch.cuda.is_available():
            quant_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=compute_dtype,
                bnb_4bit_use_double_quant=True,
            )
            model = AutoModelForCausalLM.from_pretrained(
                args.model_path,
                device_map="auto",
                quantization_config=quant_config,
                local_files_only=True,
            )
        else:
            # CPU / AMD (no CUDA): bitsandbytes 4-bit is CUDA-only; load fp32 on CPU.
            print("[cpu-fallback] No CUDA - loading LLM on CPU in float32 (slower).", file=sys.stderr)
            model = AutoModelForCausalLM.from_pretrained(
                args.model_path, torch_dtype=torch.float32, local_files_only=True,
            )
        model.eval()

        vram_used = torch.cuda.memory_allocated() / 1024**3 if torch.cuda.is_available() else 0
        print(f"[prompt-expand] Model loaded. VRAM: {vram_used:.1f}GB", file=sys.stderr)

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
            # enable_thinking not supported: retry without it
            print("[prompt-expand] enable_thinking kwarg not supported, retrying without it", file=sys.stderr)
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

        with torch.no_grad():
            out = model.generate(
                input_ids,
                max_new_tokens=args.max_tokens,
                temperature=0.7,
                do_sample=True,
                top_k=20,
                top_p=0.82,
                min_p=0.0,
                repetition_penalty=1.05,
                use_cache=True,
                pad_token_id=tokenizer.eos_token_id,
                eos_token_id=stop_ids,
            )

        expanded = tokenizer.decode(out[0][input_len:], skip_special_tokens=True).strip()
        del out, input_ids

        # Clean output: strip think tags, preambles, role bleed, meta-commentary
        expanded = clean_output(expanded)

        if not expanded:
            print("[prompt-expand] Warning: empty output, returning user input as fallback", file=sys.stderr)
            expanded = args.prompt.strip()

        print(f"[prompt-expand] Output: {len(expanded.split())} words.", file=sys.stderr)

        # Unload model to free VRAM
        print("[prompt-expand] Unloading model...", file=sys.stderr)
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
        print(f"[prompt-expand] VRAM after free: {vram_alloc:.2f}GB", file=sys.stderr)

        # Output result as JSON on stdout
        print(json.dumps({"expanded": expanded}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
