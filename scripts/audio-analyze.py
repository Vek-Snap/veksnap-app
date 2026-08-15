"""
Audio feature extraction for audio-reactive video effects.
Uses scipy + numpy (no librosa dependency).

Extracts per-frame features at a given FPS:
  - amplitude_envelope: RMS amplitude per frame (0-1 normalized)
  - onset_strength: spectral flux onset detection (0-1 normalized)
  - spectral_centroid: brightness/frequency center (0-1 normalized to Nyquist)
  - beat_frames: list of frame indices where beats occur

Output: JSON to stdout
"""

import argparse
import json
import sys
import subprocess
import tempfile
import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft, find_peaks


def load_audio_as_mono_wav(audio_path: str, ffmpeg_path: str = "ffmpeg") -> tuple:
    """Load any audio file as mono float32 numpy array using FFmpeg fallback."""
    ext = os.path.splitext(audio_path)[1].lower()

    if ext == ".wav":
        try:
            sr, data = wavfile.read(audio_path)
            if data.dtype == np.int16:
                data = data.astype(np.float32) / 32768.0
            elif data.dtype == np.int32:
                data = data.astype(np.float32) / 2147483648.0
            elif data.dtype == np.float64:
                data = data.astype(np.float32)
            if data.ndim > 1:
                data = data.mean(axis=1)
            return sr, data
        except Exception:
            pass  # Fall through to FFmpeg

    # Use FFmpeg to convert to WAV
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        result = subprocess.run(
            [ffmpeg_path, "-y", "-i", audio_path, "-ac", "1", "-ar", "22050",
             "-sample_fmt", "s16", tmp.name],
            capture_output=True, check=True
        )
        sr, data = wavfile.read(tmp.name)
        data = data.astype(np.float32) / 32768.0
        return sr, data
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"FFmpeg conversion failed: {e.stderr.decode('utf-8', errors='replace')[:500]}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def compute_rms_envelope(audio: np.ndarray, sr: int, fps: float) -> np.ndarray:
    """Compute RMS amplitude envelope at given FPS."""
    hop = int(sr / fps)
    n_frames = int(np.ceil(len(audio) / hop))
    envelope = np.zeros(n_frames)
    for i in range(n_frames):
        start = i * hop
        end = min(start + hop, len(audio))
        frame = audio[start:end]
        envelope[i] = np.sqrt(np.mean(frame ** 2)) if len(frame) > 0 else 0.0
    # Normalize to 0-1
    mx = envelope.max()
    if mx > 0:
        envelope = envelope / mx
    return envelope


def compute_spectral_flux(audio: np.ndarray, sr: int, fps: float) -> np.ndarray:
    """Compute onset strength via spectral flux at given FPS."""
    hop = int(sr / fps)
    nperseg = max(hop * 2, 512)
    _, _, Zxx = stft(audio, fs=sr, nperseg=nperseg, noverlap=nperseg - hop)
    magnitude = np.abs(Zxx)

    # Spectral flux: half-wave rectified difference
    flux = np.zeros(magnitude.shape[1])
    for i in range(1, magnitude.shape[1]):
        diff = magnitude[:, i] - magnitude[:, i - 1]
        flux[i] = np.sum(np.maximum(diff, 0))

    # Normalize to 0-1
    mx = flux.max()
    if mx > 0:
        flux = flux / mx
    return flux


def compute_spectral_centroid(audio: np.ndarray, sr: int, fps: float) -> np.ndarray:
    """Compute spectral centroid (brightness) per frame, normalized to 0-1."""
    hop = int(sr / fps)
    nperseg = max(hop * 2, 512)
    freqs, _, Zxx = stft(audio, fs=sr, nperseg=nperseg, noverlap=nperseg - hop)
    magnitude = np.abs(Zxx)

    centroid = np.zeros(magnitude.shape[1])
    nyquist = sr / 2.0
    for i in range(magnitude.shape[1]):
        col = magnitude[:, i]
        total = col.sum()
        if total > 0:
            centroid[i] = np.sum(freqs * col) / total / nyquist
        else:
            centroid[i] = 0.0

    return np.clip(centroid, 0.0, 1.0)


def detect_beats(onset_strength: np.ndarray, fps: float) -> list:
    """Detect beat frames from onset strength using peak detection."""
    # Minimum distance between beats: ~200ms
    min_distance = max(1, int(fps * 0.2))

    # Adaptive threshold: mean + 0.5 * std
    threshold = onset_strength.mean() + 0.5 * onset_strength.std()

    peaks, _ = find_peaks(
        onset_strength,
        height=max(threshold, 0.15),
        distance=min_distance,
        prominence=0.1
    )
    return peaks.tolist()


def main():
    parser = argparse.ArgumentParser(description="Audio feature extraction for reactive video")
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--fps", type=float, default=24.0, help="Target FPS for per-frame features")
    parser.add_argument("--output", help="Output JSON file (default: stdout)")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="Path to ffmpeg binary")
    args = parser.parse_args()

    if not os.path.isfile(args.audio):
        print(f"Audio file not found: {args.audio}", file=sys.stderr)
        sys.exit(1)

    try:
        sr, audio = load_audio_as_mono_wav(args.audio, ffmpeg_path=args.ffmpeg)
    except Exception as e:
        print(f"Failed to load audio: {e}", file=sys.stderr)
        sys.exit(1)

    fps = args.fps
    duration = len(audio) / sr

    # Compute features
    amplitude = compute_rms_envelope(audio, sr, fps)
    onset = compute_spectral_flux(audio, sr, fps)
    centroid = compute_spectral_centroid(audio, sr, fps)

    # Align all arrays to same length (min of all)
    min_len = min(len(amplitude), len(onset), len(centroid))
    amplitude = amplitude[:min_len]
    onset = onset[:min_len]
    centroid = centroid[:min_len]

    # Detect beats
    beat_frames = detect_beats(onset, fps)

    result = {
        "sampleRate": sr,
        "duration": round(duration, 3),
        "fps": fps,
        "numFrames": min_len,
        "amplitude": [round(float(v), 4) for v in amplitude],
        "onsetStrength": [round(float(v), 4) for v in onset],
        "spectralCentroid": [round(float(v), 4) for v in centroid],
        "beatFrames": beat_frames,
    }

    output = json.dumps(result)
    if args.output:
        with open(args.output, "w") as f:
            f.write(output)
        print(json.dumps({"ok": True, "outputFile": args.output, "numFrames": min_len}))
    else:
        print(output)


if __name__ == "__main__":
    main()
