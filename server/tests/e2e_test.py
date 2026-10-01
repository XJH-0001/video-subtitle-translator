r"""
端到端联调：自己拉起服务 → 用真实 WebSocket 按实时速度推音频 → 检查能不能收到字幕。

    .venv\Scripts\python.exe tests\e2e_test.py
    .venv\Scripts\python.exe tests\e2e_test.py --realtime       # 按真实速度推（能测出中间字幕）
    .venv\Scripts\python.exe tests\e2e_test.py --model small

这个脚本走的是和浏览器扩展完全一样的协议（WS 二进制推 PCM + JSON 控制消息），
所以它通过 = 扩展的通信链路没问题。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
sys.path.insert(0, str(SERVER))

PORT = 8799
URL = f"ws://127.0.0.1:{PORT}/ws"
HEALTH = f"http://127.0.0.1:{PORT}/health"
CHUNK = 1024  # 64ms @16k


def green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


def read_wav_16k(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(w.getnframes())
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        n_out = int(round(x.size * 16000 / rate))
        x = np.interp(
            np.arange(n_out) / 16000.0, np.arange(x.size) / rate, x
        ).astype(np.float32)
    return x


async def wait_health(timeout: float = 40.0) -> bool:
    import httpx

    deadline = time.time() + timeout
    async with httpx.AsyncClient() as c:
        while time.time() < deadline:
            try:
                r = await c.get(HEALTH, timeout=1.5)
                if r.status_code == 200:
                    return True
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.4)
    return False


async def run_client(wav: Path, realtime: bool, model: str, source_lang, target: str) -> dict:
    import websockets

    audio = read_wav_16k(wav)
    duration = audio.size / 16000
    print(f"  测试音频 {wav.name}：{duration:.1f}s")

    partials: list[dict] = []
    finals: dict[int, dict] = {}          # 按 id 合并：原文先到、翻译后到，是同一条字幕
    statuses: list[str] = []
    errors: list[str] = []
    t_start = None
    first_line_at = None
    ready = asyncio.Event()
    drained = asyncio.Event()

    async with websockets.connect(URL, max_size=8 * 1024 * 1024) as ws:
        hello = json.loads(await ws.recv())
        assert hello.get("type") == "hello", f"第一条消息应该是 hello，实际是 {hello}"
        print(f"  收到 hello：服务版本 {hello.get('version')}，默认模型 {hello.get('model')}")

        await ws.send(json.dumps({
            "type": "config",
            "model": model,
            "language": source_lang,
            "target_lang": target,
            "translate": True,
            "translate_partials": True,
            "translator": "auto",
        }, ensure_ascii=False))

        async def pump() -> None:
            nonlocal t_start, first_line_at
            # 和扩展端行为一致：服务端说 ready 之前不推音频。
            # 否则模型加载期间推的音频会被服务端当作过期数据丢掉（这是有意的）。
            print("  等待识别引擎就绪…")
            await asyncio.wait_for(ready.wait(), timeout=300)
            t0 = time.time()
            t_start = t0
            idx = 0
            while idx < audio.size:
                block = audio[idx: idx + CHUNK]
                idx += CHUNK
                pcm = np.clip(block * 32768.0, -32768, 32767).astype(np.int16)
                await ws.send(pcm.tobytes())
                if realtime:
                    await asyncio.sleep(CHUNK / 16000)
                else:
                    await asyncio.sleep(0)  # 让出事件循环，尽量快推
            await ws.send(json.dumps({"type": "flush"}))

        async def reader() -> None:
            nonlocal first_line_at
            while True:
                raw = await ws.recv()
                msg = json.loads(raw)
                mtype = msg.get("type")
                if mtype == "status":
                    state = msg.get("state")
                    statuses.append(state)
                    if state in ("loading", "ready"):
                        print(f"  [服务状态] {state}: {msg.get('message')}")
                    if state == "ready":
                        ready.set()
                elif mtype == "line":
                    if first_line_at is None:
                        first_line_at = time.time() - (t_start or time.time())
                    t0 = msg.get("t0")
                    stamp = f"[{t0:6.2f}s] " if isinstance(t0, (int, float)) else ""
                    if msg.get("final"):
                        rec = finals.setdefault(msg["id"], {})
                        for key in ("source", "translated", "t0", "t1", "lang"):
                            if msg.get(key) is not None:
                                rec[key] = msg[key]
                        if msg.get("source"):
                            print(f"  {green('▶ 最终')} {stamp}{msg['source']}")
                        if msg.get("translated"):
                            print(f"          → {green(msg['translated'])}")
                    else:
                        partials.append(msg)
                        if realtime and msg.get("source"):
                            print(f"    · 中间 {stamp}{msg['source']}")
                elif mtype == "stats":
                    print(f"  [性能] 实时率 RTF={msg.get('rtf')} 负载={msg.get('load')} 语言={msg.get('language')}")
                elif mtype == "drained":
                    drained.set()
                    print(f"  [服务端] 已处理完全部音频（解码 {msg.get('decodes')} 次，RTF={msg.get('rtf')}）")
                elif mtype == "error":
                    errors.append(msg.get("message", ""))
                    print(f"  {red('[错误]')} {msg.get('message')}")

        reader_task = asyncio.create_task(reader())
        await pump()

        # 等服务端明确说「吐完了」。
        # 不能靠「多久没消息」来判断 —— 解码一个长句可能就要好几秒，
        # 那种情况下「安静」和「忙」根本分不出来。
        t_wait = time.time()
        try:
            await asyncio.wait_for(drained.wait(), timeout=300)
            print(f"  [等待] 服务端收尾完成，用时 {time.time() - t_wait:.1f}s")
        except (asyncio.TimeoutError, TimeoutError):
            print(f"  [等待] 300s 内没收到 drained 信号（模型可能太慢）")

        reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass

    return {
        "duration": duration,
        "partials": partials,
        "finals": finals,
        "statuses": statuses,
        "errors": errors,
        "first_line_at": first_line_at,
    }


def main() -> int:
    global PORT, URL, HEALTH

    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", default=str(HERE / "sample_en.wav"))
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--language", default=None)
    ap.add_argument("--target", default="zh")
    ap.add_argument("--realtime", action="store_true")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--keep-server", action="store_true")
    ap.add_argument("--external", action="store_true", help="服务已经在跑，不要再拉一个")
    args = ap.parse_args()

    PORT = args.port
    URL = f"ws://127.0.0.1:{PORT}/ws"
    HEALTH = f"http://127.0.0.1:{PORT}/health"

    wav = Path(args.wav)
    if not wav.exists():
        print(red(f"找不到 {wav}"))
        return 1

    print("=" * 66)
    print("  端到端联调（走和扩展完全一样的协议）")
    print("=" * 66)

    vpy = SERVER / ".venv" / "Scripts" / "python.exe"
    python = str(vpy) if vpy.exists() else sys.executable

    proc = None
    if args.external:
        print(f"\n[1/3] 使用已在运行的本地服务 (端口 {PORT})")
    else:
        print(f"\n[1/3] 启动本地服务 (端口 {PORT}) …")
        proc = subprocess.Popen(
            [python, "app.py", "--port", str(PORT), "--model", args.model, "--log-level", "warning"],
            cwd=str(SERVER),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    async def go() -> int:
        ok = await wait_health()
        if not ok:
            print(red("  服务 40 秒内没起来"))
            return 1
        print(green("  服务已就绪"))
        print("\n[2/3] 连接 WebSocket 并推送音频 …")
        result = await run_client(wav, args.realtime, args.model, args.language, args.target)

        print("\n[3/3] 结果")
        finals = list(result["finals"].values())
        translated = [f for f in finals if f.get("translated")]
        fails = 0
        if finals:
            print(green(f"  ✓ 收到 {len(finals)} 条最终字幕（不同 id）"))
        else:
            print(red("  ✗ 一条最终字幕都没有"))
            fails += 1
        if args.realtime:
            if result["partials"]:
                print(green(f"  ✓ 收到 {len(result['partials'])} 条中间字幕（实时性 OK）"))
            else:
                print(red("  ✗ 没有中间字幕，实时链路可能有问题"))
                fails += 1
        if translated:
            print(green(f"  ✓ 其中 {len(translated)} 条带翻译"))
        else:
            print(red("  ✗ 没有任何翻译结果（检查翻译服务 / 网络）"))
            fails += 1
        if result["errors"]:
            print(red(f"  ✗ 服务端报错：{result['errors']}"))
            fails += 1
        if result["first_line_at"] is not None:
            print(f"  · 第一条字幕延迟：{result['first_line_at']:.1f}s（含模型加载）")
        return 1 if fails else 0

    code = 1
    try:
        code = asyncio.run(go())
    finally:
        if proc is not None and not args.keep_server:
            proc.terminate()
            try:
                out, _ = proc.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
                out, _ = proc.communicate()
            if out and code != 0:
                print("\n--- 服务端输出 ---")
                print(out[-3000:])

    print("\n" + "=" * 66)
    if code == 0:
        print(green("  端到端联调通过 ✅"))
    else:
        print(red("  端到端联调未通过 ❌"))
    return code


if __name__ == "__main__":
    sys.exit(main())
