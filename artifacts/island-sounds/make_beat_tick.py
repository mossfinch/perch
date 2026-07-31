"""Generate BeatTick.aiff, the island's frame-change tick for guided sessions.

Why synthesize instead of picking a stock sound: system sounds all carry
error/notification semantics (Tink too hard, Bottle too thumpy), and
bell/chime synths are bright but trail a long tail. What's wanted here is the
DRY tick of a mechanical clock.

How: a 3 ms noise burst excites two resonators (950/1600 Hz), plus a touch of
150 Hz for a low "thock", the whole thing over within 80 ms. The key is NO
trailing tail — "bright and piercing" is really brightness plus long decay; a
dry, short sound is bright without piercing.

The random seed is fixed, so this script produces the identical file whenever
it runs (the audio is committed; it must be reproducible).

    python3 make_beat_tick.py --output <target directory>
"""
import argparse
import os
import wave
from pathlib import Path

import numpy as np

SR = 44100
PEAK = 0.85          # normalize to 0.85 full scale: loud enough, with a little headroom
SEED = 5


def resonator(exc: np.ndarray, freq: float, r: float) -> np.ndarray:
    """Second-order resonator: gives the noise burst a "body" that shapes the
    tick's timbre. The closer r is to 1, the longer the tail."""
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
    rng = np.random.default_rng(SEED)
    dur, burst_ms = 0.08, 3.0
    n = int(SR * dur)
    b = int(SR * burst_ms / 1000)

    exc = np.zeros(n)
    exc[:b] = rng.normal(0, 1, b) * np.exp(-np.linspace(0, 4, b))

    x = resonator(exc, 950, 0.9968) + 0.20 * resonator(exc, 1600, 0.994)

    t = np.arange(n) / SR
    x += 0.25 * np.sin(2 * np.pi * 150 * t) * np.exp(-80 * t)   # the low "thock"; keeps it from sounding hollow

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
