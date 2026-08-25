"""Regenerate BeatTick.aiff, played whenever a guided session changes frames.

Off-the-shelf system sounds are easily heard as a notification or an error, and a long tail
gets in the way of a continuous move, so this synthesizes an 80 ms mechanical-clock tick
instead: a 3 ms noise burst excites 950/1600 Hz resonators, with 150 Hz laid underneath. The
random seed is fixed, so the PCM is reproducible under the same NumPy and afconvert toolchain.

Usage: python3 make_beat_tick.py --output <target directory>. The script needs NumPy and
macOS afconvert; it creates the target directory, writes a 44.1 kHz mono 16-bit AIFF, and
deletes the temporary WAV once the conversion succeeds. It only produces the audio — adding
the file to the Xcode project or the app's resources is not its job.
"""
import argparse
import os
import wave
from pathlib import Path

import numpy as np

SR = 44100
PEAK = 0.85          # leave 15% of headroom at the peak, so it never sits at digital full scale
SEED = 5


def resonator(exc: np.ndarray, freq: float, r: float) -> np.ndarray:
    """Run the excitation through a second-order resonator at freq Hz, same length out.

    r controls the decay; the closer to 1, the longer the tail.
    """
    w = 2 * np.pi * freq / SR
    a1 = 2 * r * np.cos(w)
    a2 = -r * r
    out = np.zeros_like(exc)
    y1 = y2 = 0.0
    for i, v in enumerate(exc):
        cur = v + a1 * y1 + a2 * y2
        out[i] = cur
        y2 = y1
        y1 = cur
    return out


def beat_tick() -> np.ndarray:
    """Return the 80 ms mono float waveform from the fixed seed; not yet normalized."""
    rng = np.random.default_rng(SEED)
    dur, burst_ms = 0.08, 3.0
    n = int(SR * dur)
    b = int(SR * burst_ms / 1000)

    exc = np.zeros(n)
    exc[:b] = rng.normal(0, 1, b) * np.exp(-np.linspace(0, 4, b))

    x = resonator(exc, 950, 0.9968) + 0.20 * resonator(exc, 1600, 0.994)

    t = np.arange(n) / SR
    x += 0.25 * np.sin(2 * np.pi * 150 * t) * np.exp(-80 * t)   # fill in the low end so a short tick doesn't sound hollow

    return x * np.exp(-np.linspace(0, 6, n))


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the island guided-session beat tick")
    parser.add_argument("--output", type=Path, required=True, help="target directory")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    x = beat_tick()
    x = x / np.max(np.abs(x)) * PEAK
    pcm = np.int16(np.clip(x, -1, 1) * 32767)

    wav = args.output / "BeatTick.wav"
    with wave.open(str(wav), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())

    aiff = args.output / "BeatTick.aiff"
    if os.system(f'afconvert -f AIFF -d BEI16 "{wav}" "{aiff}"') != 0:
        raise SystemExit("afconvert failed")
    wav.unlink()
    print(f"wrote {aiff}")


if __name__ == "__main__":
    main()
