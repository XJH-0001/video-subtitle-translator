r"""
一键自检：验证「依赖 → 模型下载 → 语音识别 → 翻译」整条链路是否正常。

    .venv\Scripts\python.exe selftest.py                    # 默认用 tests/sample_en.wav
    .venv\Scripts\python.exe selftest.py --wav 你的音频.wav
    .venv\Scripts\python.exe selftest.py --no-translate
    .venv\Scripts\python.exe selftest.py --realtime         # 按真实速度喂音频，能看到中间字幕

第一次运行会下载识别模型（small 约 250MB），耐心等一会儿。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asr import SAMPLE_RATE, StreamSession, WhisperEngine  # noqa: E402
from config import load_settings  # noqa: E402
from translate import Translator  # noqa: E402

CHUNK = 1024  # 64ms


def ok(msg: str) -> None:
    print(f"  \033[32m[通过]\033[0m {msg}")


def bad(msg: str) -> None:
    print(f"  \033[31m[失败]\033[0m {msg}")


def info(msg: str) -> None:
    print(f"  \033[36m[信息]\033[0m {msg}")


def read_wav_16k(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise SystemExit(f"只支持 16-bit PCM 的 wav，当前是 {width * 8} bit")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        n_out = int(round(x.size * SAMPLE_RATE / rate))
        src_t = np.arange(x.size, dtype=np.float64) / rate
        dst_t = np.arange(n_out, dtype=np.float64) / SAMPLE_RATE
        x = np.interp(dst_t, src_t, x).astype(np.float32)
    return x


def step_deps() -> bool:
    print("\n[1/4] 检查依赖")
    try:
        import ctranslate2  # noqa: F401
        import faster_whisper  # noqa: F401
        import fastapi  # noqa: F401
        import httpx  # noqa: F401
        import uvicorn  # noqa: F401

        import faster_whisper as fw

        ok(f"faster-whisper {fw.__version__} / ctranslate2 {ctranslate2.__version__} / "
           f"numpy {np.__version__} / httpx {httpx.__version__}")
        return True
    except Exception as exc:  # noqa: BLE001
        bad(f"依赖缺失：{exc}")
        print("       请先执行：.venv\\Scripts\\python.exe -m pip install -r requirements.txt "
              "-i https://pypi.tuna.tsinghua.edu.cn/simple")
        return False


def step_model(settings) -> WhisperEngine | None:
    print(f"\n[2/4] 加载识别模型「{settings.model}」（首次需要下载，可能几分钟）")
    engine = WhisperEngine(settings)
    t0 = time.time()
    try:
        engine.load()
    except Exception as exc:  # noqa: BLE001
        bad(f"模型加载失败：{exc}")
        return None
    ok(f"模型就绪：{engine.device} / {engine.compute_type}，耗时 {time.time() - t0:.1f}s")
    return engine


def step_asr(engine, wav: Path, realtime: bool) -> list[dict]:
    print(f"\n[3/4] 流式识别测试：{wav.name}" + ("（按真实速度）" if realtime else "（尽快）"))
    audio = read_wav_16k(wav)
    duration = audio.size / SAMPLE_RATE
    info(f"音频时长 {duration:.1f}s，切成 {CHUNK} 采样点 / 包")

    settings = load_settings()
    session = StreamSession(engine, settings)
    finals: list[dict] = []
    partials = 0

    t0 = time.time()
    idx = 0
    while idx < audio.size:
        block = audio[idx: idx + CHUNK]
        idx += CHUNK
        pcm = np.clip(block * 32768.0, -32768, 32767).astype(np.int16)
        session.feed(pcm)
        for ev in session.poll_events():
            if ev.get("type", "line") != "line":
                continue        # speech 之类的非字幕事件，只统计字幕
            if ev["final"]:
                finals.append(ev)
                print(f"      \033[1m▶ [{ev['t0']:6.2f}s] {ev['source']}\033[0m")
            else:
                partials += 1
                print(f"        · [{ev['t0']:6.2f}s] {ev['source']}")
        if realtime:
            time.sleep(CHUNK / SAMPLE_RATE)

    # 等后台解码线程把剩下的任务做完
    session.flush()
    session.wait_idle(timeout=120)
    for ev in session.poll_events():
        if ev.get("type", "line") != "line":
            continue        # speech 之类的非字幕事件，只统计字幕
        if ev["final"]:
            finals.append(ev)
            print(f"      \033[1m▶ [{ev['t0']:6.2f}s] {ev['source']}\033[0m")
        else:
            partials += 1
            print(f"        · [{ev['t0']:6.2f}s] {ev['source']}")
    session.close()

    wall = time.time() - t0
    info(f"喂完音频用时 {wall:.1f}s；识别实时率 RTF={session.stats['rtf']}（<1 表示比视频快）")
    if session.locked_language:
        info(f"自动检测语言：{session.locked_language}")

    if finals:
        ok(f"识别出 {len(finals)} 句完整字幕")
    else:
        bad("一句都没识别出来，检查音频是否有声音、VAD 阈值是否过高")
    return finals


async def step_translate(settings, finals: list[dict]) -> bool:
    print(f"\n[4/4] 翻译测试（{settings.translator} → {settings.target_lang}）")
    if not finals:
        bad("没有可翻译的文本，跳过")
        return False
    translator = Translator(settings)
    try:
        good = 0
        for ev in finals[:3]:
            out = await translator.translate(ev["source"], ev.get("lang"))
            if out:
                good += 1
                print(f"      {ev['source']}")
                print(f"   →  \033[1m{out}\033[0m")
            else:
                print(f"      {ev['source']}")
                print("   →  （未翻译）")
        st = translator.status()
        if good:
            ok(f"翻译正常，生效服务商：{st['active']}")
            return True
        bad(f"翻译全部失败：{st['last_error']}")
        return False
    finally:
        await translator.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", default=str(HERE / "tests" / "sample_en.wav"))
    parser.add_argument("--model", default="")
    parser.add_argument("--language", default=None)
    parser.add_argument("--target", default="zh")
    parser.add_argument("--realtime", action="store_true")
    parser.add_argument("--no-translate", action="store_true")
    parser.add_argument("--skip-model", action="store_true")
    args = parser.parse_args()

    settings = load_settings()
    if args.model:
        settings.model = args.model
    if args.language is not None:
        settings.language = args.language or None
    settings.target_lang = args.target
    if args.no_translate:
        settings.translator = "none"

    print("=" * 66)
    print("  视频实时字幕翻译 · 环境自检")
    print("=" * 66)

    if not step_deps():
        return 1

    wav = Path(args.wav)
    if not wav.exists():
        bad(f"找不到测试音频 {wav}")
        return 1

    if args.skip_model:
        print("\n[2/4] 跳过模型加载")
        print("\n[3/4] 跳过识别")
        print("\n[4/4] 跳过翻译")
        return 0

    engine = step_model(settings)
    if engine is None:
        return 1
    finals = step_asr(engine, wav, args.realtime)
    translate_ok = True
    if not args.no_translate:
        translate_ok = asyncio.run(step_translate(settings, finals))

    print("\n" + "=" * 66)
    if finals and translate_ok:
        print("  \033[32m全部通过 ✅  可以启动服务并在 Edge 里使用了。\033[0m")
        return 0
    print("  \033[33m部分环节未通过，请看上面的日志 ⚠\033[0m")
    return 1


if __name__ == "__main__":
    sys.exit(main())
