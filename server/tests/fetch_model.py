r"""
下载识别模型（带实时速度显示）。

    .venv\Scripts\python.exe tests\fetch_model.py large-v3-turbo
    .venv\Scripts\python.exe tests\fetch_model.py medium small

为什么单独写一个：模型动辄 1.5GB，用服务端自己的加载路径下载时看不到进度，
卡住了也不知道。这里每 5 秒报一次速度和剩余量。

顺带说明「为什么下载会慢」：
  · 默认走 hf-mirror 镜像在国内直连时确实快，但**开着代理时反而比官方站慢一倍**
    （实测 0.50 vs 1.04 MB/s）—— 所以 config.ensure_hf_endpoint 现在用真正的
    HTTPS 请求探测（会走系统代理），而不是裸 TCP。
  · 设了 HF_HUB_ENABLE_HF_TRANSFER=1 且装了 hf_transfer 会启用并行分块下载。
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
sys.path.insert(0, str(SERVER))

MB = 1024 * 1024


def dir_size_mb(root: Path) -> float:
    total = 0
    for f in root.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total / MB


def main(argv: list[str]) -> int:
    names = argv[1:] or ["large-v3-turbo"]

    from config import MODELS_DIR, ensure_hf_endpoint

    endpoint = ensure_hf_endpoint()
    print(f"  下载源   : {endpoint}")
    print(f"  模型目录 : {MODELS_DIR}")
    transfer = os.environ.get("HF_HUB_ENABLE_HF_TRANSFER")
    try:
        import hf_transfer  # noqa: F401

        has_transfer = True
    except ImportError:
        has_transfer = False
    print(f"  并行下载 : hf_transfer {'已启用' if (has_transfer and transfer) else ('已安装但未启用（设 HF_HUB_ENABLE_HF_TRANSFER=1）' if has_transfer else '未安装')}")
    print()

    from faster_whisper import WhisperModel

    for name in names:
        # 先记下基线，只统计这次新增的量
        before = dir_size_mb(MODELS_DIR)
        stop = threading.Event()
        peak = [0.0]
        last = [before]

        def watch() -> None:
            while not stop.wait(5.0):
                cur = dir_size_mb(MODELS_DIR)
                rate = (cur - last[0]) / 5.0
                last[0] = cur
                peak[0] = max(peak[0], rate)
                print(f"    [{time.strftime('%H:%M:%S')}] 本次已下 {cur - before:8.1f} MB   {rate:5.2f} MB/s", flush=True)

        t = threading.Thread(target=watch, daemon=True)
        t.start()
        t0 = time.time()
        try:
            m = WhisperModel(name, device="cpu", compute_type="int8", num_workers=1, download_root=str(MODELS_DIR))
            del m
            ok = True
            err = ""
        except Exception as exc:  # noqa: BLE001
            ok = False
            err = f"{type(exc).__name__}: {exc}"
        stop.set()
        t.join(timeout=1)
        dt = time.time() - t0
        got = dir_size_mb(MODELS_DIR) - before

        if ok:
            avg = got / dt if dt > 0 else 0
            print(f"  ✅ {name}: {got:.0f} MB，用时 {dt:.0f}s，平均 {avg:.2f} MB/s（峰值 {peak[0]:.2f}）", flush=True)
        else:
            print(f"  ❌ {name}: 失败 {err}", flush=True)
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
