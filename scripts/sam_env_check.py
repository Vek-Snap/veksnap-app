"""Probe transformers for SAM2 model class availability.

Run with: python sam_env_check.py
Outputs JSON-ish lines for easy capture in a spawned subprocess.
"""
import importlib.util
import json
import sys


def probe(mod_path: str) -> bool:
    try:
        return importlib.util.find_spec(mod_path) is not None
    except Exception:
        return False


def main():
    info: dict = {"python": sys.version.split()[0]}
    try:
        import transformers  # type: ignore
        info["transformers"] = transformers.__version__
    except Exception as e:  # pragma: no cover
        info["transformers"] = f"NOT INSTALLED ({e})"

    info["sam2_module"] = probe("transformers.models.sam2")
    info["sam2_video_module"] = probe("transformers.models.sam2_video")

    # Try class imports
    for cls_path in [
        "transformers.Sam2Model",
        "transformers.Sam2Processor",
        "transformers.Sam2VideoModel",
    ]:
        mod_name, _, cls_name = cls_path.rpartition(".")
        try:
            mod = importlib.import_module(mod_name)
            info[cls_name] = hasattr(mod, cls_name)
        except Exception as e:
            info[cls_name] = f"err: {e}"

    # Try torch
    try:
        import torch  # type: ignore
        info["torch"] = torch.__version__
        info["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            info["cuda_device"] = torch.cuda.get_device_name(0)
    except Exception as e:
        info["torch"] = f"NOT INSTALLED ({e})"

    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
