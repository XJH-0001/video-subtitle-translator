r"""
在「有背景音乐」的难样本上对比识别质量。

    .venv\Scripts\python.exe tests\bench_accuracy.py

为什么用这个样本：干净语音上 small 和 large-v3-turbo 结果几乎一样，
分不出差别。加上持续 BGM 之后，小模型的劣势才会暴露 ——
这正是真实视频（B站/抖音/YouTube）的常见情况。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
sys.path.insert(0, str(SERVER))


def main() -> int:
    from asr import _add_nvidia_dll_dirs

    _add_nvidia_dll_dirs()
    from config import MODELS_DIR, ensure_hf_endpoint

    ensure_hf_endpoint()
    from faster_whisper import WhisperModel
    from selftest import read_wav_16k

    wav = HERE / "sample_en_bgm.wav"
    audio = read_wav_16k(wav)

    # 三段，分别对应「干净 / 中等 / 被音乐盖住」
    clips = [
        ("0.0-5.0s", audio[0 : 5 * 16000]),
        ("5.0-11.0s", audio[5 * 16000 : 11 * 16000]),
        ("11.0-18.0s", audio[11 * 16000 : 18 * 16000]),
    ]
    # 这是原始干净音频的正确答案（人工听写）
    TRUTH = {
        "0.0-5.0s": "Hello and welcome back to the channel. Today we are going to talk about three things.",
        "5.0-11.0s": "The first one is how real-time subtitles actually work under the hood.",
        "11.0-18.0s": "Second, why the audio never leaves your computer. And finally, how to make the whole thing fast enough.",
    }

    print("=" * 78)
    print("  难样本（语音 + 持续背景音乐）识别质量对比")
    print("=" * 78)
    print()

    models = ["small", "medium", "large-v3-turbo"]
    results: dict[str, dict[str, str]] = {}
    times: dict[str, dict[str, float]] = {}

    for name in models:
        try:
            m = WhisperModel(name, device="cuda", compute_type="float16",
                             num_workers=1, download_root=str(MODELS_DIR))
        except Exception as exc:  # noqa: BLE001
            print(f"  ❌ {name}: {exc}")
            continue
        results[name] = {}
        times[name] = {}
        for label, clip in clips:
            list(m.transcribe(clip, language="en", beam_size=1, without_timestamps=True,
                              condition_on_previous_text=False, temperature=0.0, vad_filter=False)[0])
            ts = []
            txt = ""
            for _ in range(2):
                t0 = time.time()
                segs, _ = m.transcribe(clip, language="en", beam_size=1, without_timestamps=True,
                                       condition_on_previous_text=False, temperature=0.0, vad_filter=False)
                txt = "".join(s.text for s in segs).strip()
                ts.append((time.time() - t0) * 1000)
            results[name][label] = txt
            times[name][label] = sum(ts) / len(ts)
        del m
        print(f"  {name} 完成")
    print()

    def score(text: str, ref: str) -> float:
        """词级命中率，粗略但够用来比较。"""
        import re

        norm = lambda s: [w for w in re.findall(r"[a-z0-9']+", s.lower())]  # noqa: E731
        a, b = norm(text), norm(ref)
        if not b:
            return 0.0
        # 最长公共子序列长度 / 参考答案长度
        dp = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
        for i in range(1, len(a) + 1):
            for j in range(1, len(b) + 1):
                dp[i][j] = dp[i - 1][j - 1] + 1 if a[i - 1] == b[j - 1] else max(dp[i - 1][j], dp[i][j - 1])
        return dp[len(a)][len(b)] / len(b)

    print(f"  {'模型':<18}{'平均词准确率':>14}{'平均解码':>12}")
    print("  " + "-" * 46)
    summary = []
    for name in models:
        if name not in results:
            continue
        sc = [score(results[name][lb], TRUTH[lb]) for lb, _ in clips]
        tm = [times[name][lb] for lb, _ in clips]
        avg_s = sum(sc) / len(sc)
        avg_t = sum(tm) / len(tm)
        summary.append((name, avg_s, avg_t))
        print(f"  {name:<18}{avg_s * 100:>13.1f}%{avg_t:>10.0f}ms")

    print()
    print("  ── 逐段原文 ──")
    for label, _ in clips:
        print(f"\n    【{label}】 参考：{TRUTH[label]}")
        for name in models:
            if name in results:
                mark = "  " if score(results[name][label], TRUTH[label]) >= 0.9 else "⚠ "
                print(f"      {mark}{name:<18}{results[name][label]}")

    # 结论
    if summary:
        print()
        print("  ── 结论 ──")
        best = max(summary, key=lambda x: x[1])
        base = next((s for s in summary if s[0] == "small"), None)
        if base and best[0] != "small":
            print(f"    {best[0]} 比 small 准确率高 {(best[1] - base[1]) * 100:.1f} 个百分点，"
                  f"解码多 {best[2] - base[2]:.0f}ms（仍远低于 400ms 的静音等待）")
        else:
            print(f"    small 已经是最准的（或并列），没必要换更大的模型")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
