"""从浏览器扩展的 leveldb 存储里读出 vst_settings，确认实际生效的翻译配置。

    .venv\\Scripts\\python.exe tools\\read_ext_settings.py

为什么要直接读存储：扩展的设置会**覆盖**服务端配置 ——
即使 server/config.json 写的是 DeepSeek，扩展里存着 "auto" 的话，
发到服务端的还是 "auto"，实际用的就是免费接口。必须看扩展里真正存了什么。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

EXT_ID = "cklgbajekihboflmllhodmndoemkgpmj"
BASE = Path.home() / "AppData/Local/Microsoft/Edge/User Data"


def ascii_runs(data: bytes, min_len: int = 3) -> list[str]:
    """把字节流里可读的片段抠出来。leveldb 的 .log 里字符串基本是明文。"""
    out: list[str] = []
    buf = bytearray()
    for b in data:
        if 32 <= b < 127 or b in (9, 10, 13):
            buf.append(b)
        else:
            if len(buf) >= min_len:
                out.append(buf.decode("ascii", "replace"))
            buf.clear()
    if len(buf) >= min_len:
        out.append(buf.decode("ascii", "replace"))
    return out


def find_settings(folder: Path) -> dict | None:
    for f in sorted(folder.rglob("*")):
        if not f.is_file():
            continue
        try:
            raw = f.read_bytes()
        except OSError:
            continue
        text = "\n".join(ascii_runs(raw, 2))
        if "vst_settings" not in text:
            continue
        # vst_settings 后面跟着的就是那段 JSON
        for m in re.finditer(r"vst_settings", text):
            tail = text[m.end() : m.end() + 4000]
            start = tail.find("{")
            if start < 0:
                continue
            # 花括号配对，抠出完整 JSON
            depth = 0
            for i in range(start, len(tail)):
                if tail[i] == "{":
                    depth += 1
                elif tail[i] == "}":
                    depth -= 1
                    if depth == 0:
                        blob = tail[start : i + 1]
                        try:
                            return json.loads(blob)
                        except json.JSONDecodeError:
                            # 可能有转义残留，粗修一下再试
                            try:
                                return json.loads(blob.replace('\\"', '"'))
                            except json.JSONDecodeError:
                                pass
                        break
    return None


def main() -> int:
    print("=" * 62)
    print("  扩展里实际存着的设置")
    print("=" * 62)
    print()
    found = False
    for profile in sorted(BASE.glob("*")):
        if not profile.is_dir():
            continue
        for sub in ("Sync Extension Settings", "Local Extension Settings"):
            folder = profile / sub / EXT_ID
            if not folder.is_dir():
                continue
            s = find_settings(folder)
            if not s:
                print(f"  {profile.name}/{sub}: 没读到设置")
                continue
            found = True
            print(f"  ── {profile.name} / {sub} ──")
            keys = [
                "translator", "openaiModel", "openaiBaseUrl", "model",
                "targetLang", "settingsVersion", "translate", "translatePartials",
            ]
            for k in keys:
                v = s.get(k, "<未设置>")
                if k == "openaiApiKey":
                    v = "(已设)" if v else "(空)"
                print(f"     {k:20} = {v}")
            print()

    if not found:
        print("  没找到扩展设置 —— 说明你还没在扩展里保存过任何设置，")
        print("  那样的话用的就是 common.js 里的默认值（translator = openai）")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
