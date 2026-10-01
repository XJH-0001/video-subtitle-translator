"""验证 DeepSeek 翻译链路是否真的能用（不打印 API Key）。"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from config import Settings, load_settings  # noqa: E402


def mask(k: str) -> str:
    if not k:
        return "(空)"
    return f"{k[:6]}…{k[-4:]}（{len(k)} 位）"


async def main() -> int:
    print("=" * 62)
    print("  DeepSeek 翻译链路自检")
    print("=" * 62)
    s: Settings = load_settings()
    print(f"  translator      : {s.translator}")
    print(f"  base_url        : {s.openai_base_url}")
    print(f"  model           : {s.openai_model}")
    print(f"  api_key         : {mask(s.openai_api_key)}")
    print(f"  target_lang     : {s.target_lang}")
    print()

    from translate import Translator

    t = Translator(s)
    print(f"  可用服务商      : {t.order()}")
    if "openai" not in (t.order() or []):
        print("  ❌ openai 没被启用 —— 检查 api_key 是否为空")
        return 1
    print()

    # 1) 单句
    print("  [1] 单句翻译")
    t0 = time.time()
    out = await t.translate("Hello and welcome back to the channel.", "en")
    ms = int((time.time() - t0) * 1000)
    print(f"      {ms}ms  via {t.last_provider}")
    print(f"      → {out}")
    print()

    # 2) 带上下文（考验代词/指代）
    print("  [2] 上下文感知（同一句话，有无上文对比）")
    ctx = [
        "My brother bought a new car last week.",
        "He said it was a gift for his wife.",
    ]
    for label, context in (("无上文", None), ("有上文", ctx)):
        t0 = time.time()
        out = await t.translate("She really loves it.", "en", context=context)
        ms = int((time.time() - t0) * 1000)
        print(f"      {label}: {ms}ms → {out}")
    print()

    # 3) 长句 + 专业词
    print("  [3] 长句 / 术语")
    long_src = ("The first one is how real-time subtitles actually work under the hood, "
                "using a streaming VAD plus a fixed-window encoder.")
    t0 = time.time()
    out = await t.translate(long_src, "en")
    ms = int((time.time() - t0) * 1000)
    print(f"      {ms}ms → {out}")
    print()

    print("  status:", t.status())
    await t.close()
    print()
    print("  ✅ 链路通了")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
