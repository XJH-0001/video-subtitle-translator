r"""
测 DeepSeek 的「首字延迟」和「整句耗时」差多少。

    .venv\Scripts\python.exe tests\test_stream_ttft.py

为什么关心这个：
  非流式调用要等模型把整句写完才返回（600~900ms），
  而流式可以**首字一到就先显示**。
  如果首字只要两三百毫秒，那用户感知的「慢」是可以消掉的 ——
  中文先冒出来，再自然长完，配合前端的逐字显现动画，观感就是实时字幕。
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from config import load_settings  # noqa: E402

SAMPLES = [
    ("短句", "Hello and welcome back to the channel."),
    ("含上下文", "The first one is how real-time subtitles actually work under the hood."),
    ("长句", "And finally, how to make the whole thing fast enough to keep up with a video, "
             "even when there is background music playing."),
]


async def main() -> int:
    import httpx

    from translate import SYSTEM_PROMPT

    s = load_settings()
    if not s.openai_api_key:
        print("  没配 API Key，跳过")
        return 1

    url = f"{s.openai_base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {s.openai_api_key}"}

    print("=" * 70)
    print("  DeepSeek 首字延迟 vs 整句耗时")
    print("=" * 70)
    print()
    print(f"  {'样本':<10}{'首字':>10}{'整句':>10}{'差值':>10}   译文")
    print("  " + "-" * 66)

    async with httpx.AsyncClient(timeout=30.0) as client:
        for label, text in SAMPLES:
            body = {
                "model": s.openai_model,
                "stream": True,
                "thinking": {"type": "disabled"},
                "temperature": 0.0,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT.format(target="zh")},
                    {"role": "user", "content": text},
                ],
            }
            t0 = time.monotonic()
            ttft = None
            chunks: list[str] = []
            async with client.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code != 200:
                    body_text = (await r.aread()).decode("utf-8", "replace")[:200]
                    print(f"  {label:<10} 失败 HTTP {r.status_code}: {body_text}")
                    continue
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        obj = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    delta = (obj.get("choices") or [{}])[0].get("delta", {})
                    piece = delta.get("content") or ""
                    if piece:
                        if ttft is None:
                            ttft = time.monotonic() - t0
                        chunks.append(piece)
            total = time.monotonic() - t0
            out = "".join(chunks).strip()
            print(f"  {label:<10}{(ttft or 0) * 1000:>8.0f}ms{total * 1000:>9.0f}ms"
                  f"{(total - (ttft or 0)) * 1000:>9.0f}ms   {out}")

    print()
    print("  结论：『首字』就是流式能省下的时间 —— 用户看到中文的等待从『整句』缩短到『首字』。")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
