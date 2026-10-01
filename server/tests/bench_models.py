r"""
在显卡上对比各识别模型的速度、显存和识别质量。

    .venv\Scripts\python.exe tests\bench_models.py
    .venv\Scripts\python.exe tests\bench_models.py --models small,large-v3-turbo

判断依据不是「谁快」，而是「解码耗时有没有超过等静音的那 400ms」——
只要没超过，总延迟就不变，等于准确率白拿。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
sys.path.insert(0, str(SERVER))

from selftest import read_wav_16k  # noqa: E402

# 实测：判定一句话结束要等的静音
HANGOVER_MS = 400
# 参考：CPU 上 small 的速度
CPU_REF_MS = 1170


def vram_used_mb() -> float:
    """当前进程占用的显存（MB）。用 nvml 不好拿，改用 cuda 的显存信息。"""
    try:
        import ctypes

        cudart = ctypes.CDLL("cudart64_12.dll")
        free = ctypes.c_size_t()
        total = ctypes.c_size_t()
        if cudart.cudaMemGetInfo(ctypes.byref(free), ctypes.byref(total)) == 0:
            return (total.value - free.value)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="tiny,base,small,medium,large-v3-turbo")
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args()

    sys.path.insert(0, str(SERVER))
    from asr import _add_nvidia_dll_dirs

    _add_nvidia_dll_dirs()
    from config import MODELS_DIR, ensure_hf_endpoint

    ensure_hf_endpoint()
    from faster_whisper import WhisperModel

    audio = read_wav_16k(HERE / "sample_en.wav")
    # 一句典型的字幕长度（约 3.5 秒），加上一段长句
    clips = [("3.5s 短句", audio[5 * 16000 : int(8.5 * 16000)])]
    clips.append(("6.5s 长句", audio[int(3.2 * 16000) : int(9.7 * 16000)]))

    truth = {
        "3.5s 短句": "The first one is how real-time subtitles actually work under the hood",
        "6.5s 长句": "Today we are going to talk about three things",
    }

    print("=" * 78)
    print("  识别模型对比（显卡）")
    print("=" * 78)
    print(f"  参考：CPU 上 small 一次解码约 {CPU_REF_MS} ms；等静音固定要 {HANGOVER_MS} ms")
    print(f"  结论标准：解码耗时 < {HANGOVER_MS}ms 的话，换这个模型**总延迟不变**")
    print()

    rows = []
    for name in args.models.split(","):
        name = name.strip()
        if not name:
            continue
        try:
            t0 = time.time()
            m = WhisperModel(name, device=args.device, compute_type="float16",
                             num_workers=1, download_root=str(MODELS_DIR))
            load_s = time.time() - t0
        except Exception as exc:  # noqa: BLE001
            print(f"  ❌ {name}: 加载失败 {type(exc).__name__}: {str(exc)[:120]}")
            continue

        vram = vram_used_mb()
        times = {}
        texts = {}
        for label, clip in clips:
            # 预热
            list(m.transcribe(clip, language="en", beam_size=1, without_timestamps=True,
                              condition_on_previous_text=False, temperature=0.0, vad_filter=False)[0])
            ts = []
            txt = ""
            for _ in range(3):
                t0 = time.time()
                segs, _ = m.transcribe(clip, language="en", beam_size=1, without_timestamps=True,
                                       condition_on_previous_text=False, temperature=0.0, vad_filter=False)
                txt = "".join(s.text for s in segs).strip()
                ts.append((time.time() - t0) * 1000)
            times[label] = sum(ts) / len(ts)
            texts[label] = txt

        rows.append({"name": name, "times": times, "texts": texts, "vram": vram, "load": load_s})
        del m
        # 清一次显存
        try:
            import gc

            gc.collect()
        except Exception:  # noqa: BLE001
            pass

    print()
    print(f"  {'模型':<18}{'加载':>7}{'3.5s':>9}{'6.5s':>9}{'显存':>10}   总延迟影响")
    print("  " + "-" * 74)
    for r in rows:
        t35 = r["times"]["3.5s 短句"]
        t65 = r["times"]["6.5s 长句"]
        worst = max(t35, t65)
        if worst < HANGOVER_MS:
            impact = f"✅ 不变（仍被 {HANGOVER_MS}ms 盖住）"
        else:
            impact = f"⚠ 增加约 {worst - HANGOVER_MS:.0f}ms"
        print(f"  {r['name']:<18}{r['load']:>6.1f}s{t35:>8.0f}ms{t65:>8.0f}ms{r['vram']/1024/1024:>9.2f}G   {impact}")

    print()
    print("  ── 识别结果对比 ──")
    for label, _ in clips:
        print(f"    [{label}]  期望：{truth.get(label, '')}")
        for r in rows:
            print(f"      {r['name']:<18}{r['texts'][label]}")
        print()

    print("  说明：显存是「进程占用」的估算，包含 CUDA 上下文（约几百 MB 固定开销）。")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
