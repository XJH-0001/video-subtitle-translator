r"""
生成「语音 + 持续背景噪音」的测试音频 —— 用来复现「背景音乐导致静音检测失效」的场景。

    .venv\Scripts\python.exe tests\make_noisy_sample.py

真实视频里经常有 BGM / 环境音，能量 VAD 会一直认为「有人在说话」，
于是句子永远不结束、字幕长时间不更新。这个样本专门用来测这种情况。
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


def main() -> int:
    speech = read_wav_16k(HERE / "sample_en.wav")

    rng = np.random.default_rng(20261001)

    # 1) 平稳的背景音乐感：几个低频正弦 + 带限噪声，音量恒定
    t = np.arange(speech.size) / SR
    bg = (
        0.055 * np.sin(2 * np.pi * 110.0 * t)
        + 0.040 * np.sin(2 * np.pi * 220.0 * t + 0.7)
        + 0.030 * np.sin(2 * np.pi * 330.0 * t + 1.9)
    )
    # 带限噪声（滑动平均一下，去掉刺耳的高频）
    noise = rng.normal(0, 0.035, speech.size)
    kernel = np.ones(12) / 12.0
    noise = np.convolve(noise, kernel, mode="same")
    bg = bg + noise

    # 2) 语音稍微压低一点，模拟「人声 + BGM」混音
    mixed = speech * 0.85 + bg

    # 归一化，避免削顶
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.98:
        mixed = mixed / peak * 0.98

    out = HERE / "sample_en_bgm.wav"
    write_wav(out, mixed.astype(np.float32))

    # 顺便报一下背景音的能量，便于判断 VAD 会不会被它带跑
    frame = 320
    n = mixed.size // frame
    rms = np.sqrt(np.mean(mixed[: n * frame].reshape(n, frame) ** 2, axis=1))
    print(f"  已生成 {out.name}  {mixed.size / SR:.1f}s")
    print(f"  背景噪音 RMS ≈ {np.sqrt(np.mean(bg ** 2)):.4f}")
    print(f"  整段 RMS 中位 ≈ {np.median(rms):.4f}  最大 ≈ {np.max(rms):.4f}")
    print(f"  （能量 VAD 的阈值上限是 0.030，背景音如果长期高于它，就永远检测不到静音）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
