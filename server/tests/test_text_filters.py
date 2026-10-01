r"""
文本过滤的单元测试 —— 这些规则决定了「什么该丢、什么该留」，
写错一个字符就可能把正常字幕吃掉，所以单独测一遍。

    .venv\Scripts\python.exe tests\test_text_filters.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from asr import is_noise, normalize_text  # noqa: E402

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
fails = 0


def check(label: str, got, want) -> None:
    global fails
    if got == want:
        print(f"  {PASS} {label}")
    else:
        fails += 1
        print(f"  {FAIL} {label}\n      得到: {got!r}\n      期望: {want!r}")


def main() -> int:
    print("\nnormalize_text —— 重复折叠")
    check("短语循环（英）",
          normalize_text("The first one is the first one is the first one is the first one is"),
          "The first one is")
    check("短语循环后接真实内容时不动它",
          normalize_text("the first one is the first one is how it works"),
          "the first one is the first one is how it works")
    check("整句重复",
          normalize_text("ok ok ok"),
          "ok")
    check("字符重复",
          normalize_text("哈哈哈哈哈哈"),
          "哈哈")
    check("多余空白",
          normalize_text("  hello   world  "),
          "hello world")
    check("正常句子保持原样",
          normalize_text("Hello and welcome back to the channel."),
          "Hello and welcome back to the channel.")
    check("正常重复词不误伤（two次）",
          normalize_text("very very good"),
          "very very good")
    check("中文正常句",
          normalize_text("今天我们要讲三件事。"),
          "今天我们要讲三件事。")

    print("\nis_noise —— 该丢弃的垃圾/幻觉")
    for junk in [
        "",
        "  ",
        ".",
        "。。。",
        "字幕由 Amara.org 提供",
        "请不吝点赞订阅",
        "感谢观看",
        "Thanks for watching!",
        "Subtitles by someone",
        "www.example.com",
        "字幕",
    ]:
        check(f"丢弃 {junk!r}", is_noise(junk), True)

    print("\nis_noise —— 该保留的正常内容")
    for good in [
        "Hello",
        "你好",
        "OK",
        "The first one is how real time subtitles work.",
        "第二，为什么音频永远不会离开你的电脑。",
        "これはテストです",
        "안녕하세요",
    ]:
        check(f"保留 {good!r}", is_noise(good), False)

    print()
    if fails:
        print(f"\033[31m{fails} 项未通过\033[0m")
    else:
        print("\033[32m全部通过 ✅\033[0m")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
