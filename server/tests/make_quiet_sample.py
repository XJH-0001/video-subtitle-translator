r"""
生成不同音量档位的测试音频，用来复现「说话声音小就识别不到」。

    .venv\Scripts\python.exe tests\make_quiet_sample.py

真实场景：视频本身音量小、或者麦克风增益低，人声 RMS 掉到 VAD 的绝对阈值以下，
VAD 就永远认为「没人在说话」→ 一句话都切不出来 → 一条字幕都没有。
"""

from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from selftest import read_wav_16k  # noqa: E402

MB = 1024 * 1024
SR = 16000

# 各档增益（倍数）与对应的分贝
LEVELS = [
    (1.00, "原始音量"),
    (0.32, "-10 dB"),
    (0.18, "-15 dB"),
    (0.10, "-20 dB"),
    (0.05, "-26 dB"),
]


def write_wav(path: Path, x: np.ndarray) -> None:
    pcm = np.clip(x * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def speech_rms(x: np.ndarray) -> tuple[float, float]:
    """返回（整段 RMS，说话段 RMS 估算）。用 90 分位帧 RMS 粗略代表说话段。"""
    frame = 320
    n = x.size // frame
    if n == 0:
        return 0.0, 0.0
    rms = np.sqrt(np.mean(x[: n * frame].reshape(n, frame) ** 2, axis=1))
    return float(np.sqrt(np.mean(x ** 2))), float(np.percentile(rms, 90))


def main() -> int:
    base = read_wav_16k(HERE / "sample_en.wav")
    print(f"  源文件：sample_en.wav  {base.size / SR:.1f}s")
    print()
    print(f"  {'档位':<12}{'生成文件':<26}{'整体RMS':>10}{'说话段RMS':>12}")
    print("  " + "-" * 62)

    made = []
    for gain, label in LEVELS:
        y = (base * gain).astype(np.float32)
        name = f"sample_quiet_{int(round(gain * 100)):03d}.wav"
        out = HERE / name
        write_wav(out, y)
        overall, speech = speech_rms(y)
        print(f"  {label:<12}{name:<26}{overall:>10.4f}{speech:>12.4f}")
        made.append((out, label, speech))

    print()
    print("  参考阈值（config.py 里的 vad_abs_floor）当前是 0.0050：")
    for _path, label, speech in made:
        flag = "❌ 说话段都低于阈值 → 一句话都切不出来" if speech < 0.005 else "✅ 能触发"
        print(f"    {label:<12} 说话段 RMS {speech:.4f}  {flag}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
