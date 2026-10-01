r"""
复现「说话声小 + 背景音正常」—— 真实视频里最常见的情况。

    .venv\Scripts\python.exe tests\make_weak_speech.py

为什么前面那些「整体调小音量」的样本复现不出来：
  整体缩小只是把信噪比原样搬过去，Whisper 照样认得。
  真正出问题的是**人声小、背景音却没小** —— 信噪比被压掉，
  能量 VAD 的阈值被背景音抬高，小声说话根本压不过阈值，
  于是一个句子都切不出来，或者切出来但 Whisper 判成「没有说话」。
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from selftest import read_wav_16k  # noqa: E402

SR = 16000


def write_wav(path: Path, x: np.ndarray) -> None:
    pcm = np.clip(x * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def make_bgm(n: int, seed: int = 20261001) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(n) / SR
    bg = (
        0.055 * np.sin(2 * np.pi * 110.0 * t)
        + 0.040 * np.sin(2 * np.pi * 220.0 * t + 0.7)
        + 0.030 * np.sin(2 * np.pi * 330.0 * t + 1.9)
    )
    noise = rng.normal(0, 0.035, n)
    kernel = np.ones(12) / 12.0
    return bg + np.convolve(noise, kernel, mode="same")


def frame_rms(x: np.ndarray, frame: int = 320) -> np.ndarray:
    n = x.size // frame
    return np.sqrt(np.mean(x[: n * frame].reshape(n, frame) ** 2, axis=1))


def main() -> int:
    speech = read_wav_16k(HERE / "sample_en.wav")
    bgm = make_bgm(speech.size)

    # 人声逐档压低，背景音保持正常音量
    cases = [
        (1.00, "人声正常 + 背景音"),
        (0.50, "人声 1/2 + 背景音"),
        (0.25, "人声 1/4 + 背景音"),
        (0.12, "人声 1/8 + 背景音"),
        (0.06, "人声 1/16 + 背景音"),
    ]

    print(f"  源文件：sample_en.wav  {speech.size / SR:.1f}s")
    print()
    print(f"  {'档位':<22}{'文件':<28}{'人声段RMS':>10}{'背景RMS':>10}{'信噪比':>9}")
    print("  " + "-" * 80)

    for gain, label in cases:
        mixed = speech * gain + bgm
        peak = float(np.max(np.abs(mixed)))
        if peak > 0.98:
            mixed = mixed / peak * 0.98
        name = f"sample_weak_{int(round(gain * 1000)):04d}.wav"
        write_wav(HERE / name, mixed.astype(np.float32))

        sr = frame_rms(mixed)
        # 人声段：取能量最高的 25% 帧；背景：最低的 25% 帧
        hi = float(np.percentile(sr, 75))
        lo = float(np.percentile(sr, 25))
        snr = 20 * np.log10(hi / max(lo, 1e-9))
        print(f"  {label:<22}{name:<28}{hi:>10.4f}{lo:>10.4f}{snr:>8.1f}dB")

    print()
    print("  说明：信噪比越低越难。真实影视里「小声说话 + 背景音乐」大概 3~8dB，")
    print("        也就是文件 sample_weak_0250.wav 那一档左右。")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
