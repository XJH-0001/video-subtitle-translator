r"""
语气词判定测试。

    .venv\Scripts\python.exe tests\test_filler.py

为什么要判语气词：
  视频里「啊」「呀」「嗯」「哈哈」出现得又密又快，还会被反复识别到。
  每一条都发翻译请求既费钱、又占住请求锁把真正要翻的句子挤到后面，
  而这些词翻出来和原文基本一样，翻不翻没区别。

判定必须**保守**：只有整句话全部由语气词组成才算。
「啊，原来是这样」这种有实义的句子绝不能被误判，否则会漏翻。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from translate import is_filler  # noqa: E402

# (文本, 期望是否语气词, 说明)
CASES = [
    # ---- 应该判为语气词 ----
    ("啊", True, "单个语气词"),
    ("呀", True, "单个语气词"),
    ("嗯", True, "单个语气词"),
    ("哦", True, "单个语气词"),
    ("呃", True, "单个语气词"),
    ("唉", True, "单个语气词"),
    ("哈", True, "笑声"),
    ("哈哈", True, "笑声"),
    ("哈哈哈", True, "笑声重复"),
    ("啊啊啊", True, "语气词重复"),
    ("啊呀", True, "用户举的例子"),
    ("嗯嗯", True, "重复"),
    ("呃……", True, "带省略号"),
    ("哎，", True, "带逗号"),
    ("哦？", True, "带问号"),
    ("哈哈哈！", True, "笑声带感叹号"),
    (" 啊 ", True, "带空白"),
    ("uh", True, "英文填充词"),
    ("Um.", True, "英文填充词带句点"),
    ("oh", True, "英文感叹"),
    ("haha", True, "英文笑声"),
    ("hmm", True, "英文沉吟"),
    ("Uh, um.", True, "多个英文填充词"),
    # ---- 绝不能误判为语气词 ----
    ("啊，原来是这样", False, "有实义，只是以语气词开头"),
    ("哈哈哈这个真好笑", False, "笑声后面有实义"),
    ("嗯，我明白了", False, "有实义"),
    ("You are watching the news.", False, "正常英文句子"),
    ("好", False, "单字但非语气词"),
    ("好，就这么办", False, "有实义"),
    ("OK", False, "应答词，但算实义"),
    ("Hello everyone.", False, "正常句子"),
    ("是的", False, "有实义"),
    ("这个视频讲的是实时字幕", False, "正常句子"),
    ("", False, "空字符串"),
    ("    ", False, "只有空白"),
    ("...", False, "只有标点"),
    ("啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊", False, "过长（超过上限，宁可翻也别误吞）"),
]


def main() -> int:
    print("=" * 74)
    print("  语气词判定测试")
    print("=" * 74)
    print()

    ok = 0
    bad = []
    for text, want, why in CASES:
        got = is_filler(text)
        if got == want:
            ok += 1
        else:
            bad.append((text, want, got, why))

    print(f"  {'文本':<34}{'期望':>6}{'实际':>6}   说明")
    print("  " + "-" * 70)
    for text, want, why in CASES:
        got = is_filler(text)
        mark = "✅" if got == want else "❌"
        shown = text if len(text) <= 30 else text[:28] + "…"
        print(f"  {mark} {shown!r:<32}{str(want):>6}{str(got):>6}   {why}")

    print()
    print("=" * 74)
    if not bad:
        print(f"  全部通过 ✅  ({ok}/{len(CASES)})")
        print("=" * 74)
        return 0
    print(f"  {len(bad)} 项不符 ❌  (通过 {ok}/{len(CASES)})")
    for text, want, got, why in bad:
        print(f"    {text!r}: 期望 {want}，实际 {got}  —— {why}")
    print("=" * 74)
    return 1


if __name__ == "__main__":
    sys.exit(main())
