r"""
算一笔账：用 DeepSeek API 翻译一部电影大概多少钱。

    .venv\Scripts\python.exe tests\cost_estimate.py

价格取自 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
（deepseek-flash 与 deepseek-v4-pro，空闲/高峰两档）。

字幕条数按「每句字幕平均显示 3.5 秒」估，这是本系统实测的断句节奏，
和真实影片字幕的密度是一个量级。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from translate import CONTEXT_ACK, CONTEXT_HEADER, SYSTEM_PROMPT  # noqa: E402

# --- 实测样本：21.3 秒 6 条字幕 -------------------------------------------
SAMPLE_LINES = [
    "Hello and welcome back to the channel.",
    "Today we are going to talk about three things.",
    "The first one is how real time subtitles actually work under the hood.",
    "Second, why the audio never leaves your computer.",
    "And finally, how to make the whole thing fast enough to keep up with a video.",
    "Let us get started.",
]

# --- token 换算经验值 ------------------------------------------------------
# 英文：约 4 字符 / token；中文：约 1.6 字符 / token（DeepSeek 分词器）
EN_CHARS_PER_TOKEN = 4.0
ZH_CHARS_PER_TOKEN = 1.6

SRC_CHARS_PER_LINE = sum(len(x) for x in SAMPLE_LINES) / len(SAMPLE_LINES)
SRC_TOK_PER_LINE = SRC_CHARS_PER_LINE / EN_CHARS_PER_TOKEN

# 译文：50 字符英文约译成 20 个汉字
ZH_CHARS_PER_LINE = 20.0
OUT_TOK_PER_LINE = ZH_CHARS_PER_LINE / ZH_CHARS_PER_TOKEN

# 固定前缀（每次请求都一样 → 可被 DeepSeek 前缀缓存命中）
PREFIX_TOK = len(SYSTEM_PROMPT) / EN_CHARS_PER_TOKEN + (
    len(CONTEXT_HEADER) + len(CONTEXT_ACK)
) / ZH_CHARS_PER_TOKEN
# 每次都变的部分（上文 + 本句 → 缓存必然未命中）
CTX_SENTENCES = 2
MISS_TOK = SRC_TOK_PER_LINE * (1 + CTX_SENTENCES)


def main() -> int:
    print("=" * 66)
    print("  用 DeepSeek 翻译一部电影要多少钱")
    print("=" * 66)
    print()
    print(f"  样本实测：每条字幕 {SRC_CHARS_PER_LINE:.0f} 字符 → 约 {SRC_TOK_PER_LINE:.0f} tokens")
    print(f"  每次请求固定前缀 ≈ {PREFIX_TOK:.0f} tokens（system prompt + 上下文说明 → 可缓存）")
    print(f"  每次请求变化部分 ≈ {MISS_TOK:.0f} tokens（前 {CTX_SENTENCES} 句上文 + 本句 → 不可缓存）")
    print(f"  译文输出 ≈ {OUT_TOK_PER_LINE:.0f} tokens/条")
    print()

    # 价格：元 / 百万 tokens
    pricing = {
        "deepseek-flash": {"hit": (0.02, 0.04), "miss": (1.0, 2.0), "out": (4.0, 8.0)},
        "deepseek-v4-pro": {"hit": (0.15, 0.30), "miss": (4.5, 9.0), "out": (13.5, 27.0)},
    }
    periods = ("空闲", "高峰")   # 空闲=周末/节假日全天+工作日20点后；高峰=工作日 9-12/14-18

    for hours in (1.0, 2.0):
        lines = int(hours * 3600 / 3.5)      # 每 3.5 秒一条
        print(f"  ── {hours:g} 小时电影，约 {lines} 条字幕 ──")
        for model, p in pricing.items():
            for pi, period in enumerate(periods):
                hit = lines * PREFIX_TOK / 1e6 * p["hit"][pi]
                miss = lines * MISS_TOK / 1e6 * p["miss"][pi]
                out = lines * OUT_TOK_PER_LINE / 1e6 * p["out"][pi]
                total = hit + miss + out
                print(f"     {model:16s} {period}  "
                      f"输入命中 {hit:5.3f} + 输入未命中 {miss:5.3f} + 输出 {out:5.3f}"
                      f"  =  **{total:5.2f} 元**")
        print()

    # ---- 几种实际使用方式的差别 ----
    print("  ── 不同用法的差别（2 小时电影，deepseek-flash 高峰价）──")
    lines = int(2.0 * 3600 / 3.5)
    scenarios = [
        ("只翻最终字幕，1 句上文", lines * 1.0, 1),
        ("只翻最终字幕，2 句上文（默认）", lines * 1.0, 2),
        ("中间字幕也翻（约 3 倍请求）", lines * 3.0, 2),
    ]
    for label, reqs, ctxn in scenarios:
        miss = (SRC_TOK_PER_LINE * (1 + ctxn)) * reqs / 1e6 * pricing["deepseek-flash"]["miss"][1]
        hit = PREFIX_TOK * reqs / 1e6 * pricing["deepseek-flash"]["hit"][1]
        out = OUT_TOK_PER_LINE * reqs / 1e6 * pricing["deepseek-flash"]["out"][1]
        print(f"     {label:32s} {reqs:6.0f} 次请求 → {hit+miss+out:5.2f} 元")
    print()

    print("  结论：一部 2 小时电影大约 **0.2 ~ 1 元**，把中间字幕也翻也只有几块钱。")
    print("        价格随时段浮动：空闲时段（周末/节假日全天、工作日 20 点后）是高峰价的一半。")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
