r"""
字幕延迟实测：从「这句话说完」到「字幕/译文出现」，究竟隔了多久。

    .venv\Scripts\python.exe tests\measure_latency.py
    .venv\Scripts\python.exe tests\measure_latency.py --port 8765 --external

按真实速度推音频，记录每条字幕两条消息的到达时刻：
  · 原文消息   → 用户看到原文的时间
  · 译文消息   → 用户看到译文的时间
基准是「这句话的音频播完」的时刻，所以这个数字就是用户实际感受到的延迟。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent
sys.path.insert(0, str(SERVER))
from selftest import read_wav_16k  # noqa: E402

SR = 16000
CHUNK = 1024


async def wait_health(url: str, timeout: float = 120.0) -> bool:
    import httpx

    deadline = time.time() + timeout
    async with httpx.AsyncClient() as c:
        while time.time() < deadline:
            try:
                if (await c.get(url, timeout=1.5)).status_code == 200:
                    return True
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.4)
    return False


async def run(url: str, wav_name: str = "sample_en.wav") -> list[dict]:
    import websockets

    audio = read_wav_16k(HERE / wav_name)
    total = audio.size / SR

    ready = asyncio.Event()
    drained = asyncio.Event()
    rows: list[dict] = []
    by_id: dict[int, dict] = {}
    # 每个音频块「真实发出」的墙上时间。
    # 不能用 t_send0 + t1 当基准 —— Windows 上 asyncio.sleep(0.064) 实际会睡 ~79ms，
    # 客户端自己就发得比实时慢，基准算早了，延迟会被严重高估。
    sent_at: list[float] = []

    def audio_wall_time(t1: float) -> float | None:
        if not sent_at:
            return None
        i = int(t1 * SR / CHUNK)
        i = max(0, min(i, len(sent_at) - 1))
        return sent_at[i]

    async with websockets.connect(url, max_size=8 << 20) as ws:
        await ws.recv()
        # 不指定 model：让服务端用它自己已经加载好的那个。
        # 以前这里硬编码 "small"，如果服务端起的是别的模型，就会触发
        # **运行中换模型**（要 1~5 秒），期间音频在队列里堆积，
        # 整段计时被推迟，测出来的延迟虚高一大截。
        # 同理不指定 translator：否则会把服务端配好的 DeepSeek 覆盖成免费接口，
        # 测出来的译文延迟就不是真实使用时的了。
        await ws.send(json.dumps({"type": "config", "target_lang": "zh",
                                  "translate": True, "translate_partials": True},
                                 ensure_ascii=False))

        async def reader() -> None:
            while True:
                msg = json.loads(await ws.recv())
                now = time.monotonic()
                if msg.get("type") == "status" and msg.get("state") == "ready":
                    ready.set()
                elif msg.get("type") == "drained":
                    drained.set()
                elif msg.get("type") == "line":
                    seg_id = msg.get("id")
                    t1 = msg.get("t1")
                    wall = audio_wall_time(float(t1)) if t1 is not None else None
                    if wall is None:
                        continue
                    rec = by_id.setdefault(seg_id, {"id": seg_id, "final": False, "source": None,
                                                    "translated": None, "t1": float(t1),
                                                    "t_audio_end": wall})
                    if msg.get("final"):
                        rec["final"] = True
                        rec["final_seen"] = True
                        # 基准必须用「最终字幕」的句尾。
                        # 用中间字幕的句尾当基准会把延迟算高一大截。
                        rec["t1"] = float(t1)
                        rec["t_audio_end"] = wall
                    elif float(t1) > rec.get("t1", 0):
                        rec["t1"] = float(t1)
                        rec["t_audio_end"] = wall
                    if msg.get("source"):
                        rec["source"] = msg["source"]
                        rec["t_source"] = now
                    if msg.get("translated"):
                        # 「先快稿、后准稿」会为最终字幕发两条译文消息：
                        #   第一条带 draft=True（免费接口的草稿），第二条是 DeepSeek 的准稿。
                        # 只认带 draft 标记的草稿 + 定稿之后到达的准稿；
                        # 别的都是中间字幕的译文（可能迟到），算进去会把「首见中文」测成负数。
                        if msg.get("draft"):
                            if rec.get("t_draft") is None:
                                rec["t_draft"] = now
                                rec["draft_text"] = msg["translated"]
                        elif rec.get("final_seen"):
                            rec["translated"] = msg["translated"]
                            rec["t_translated"] = now
                    rows.append(rec)

        rtask = asyncio.create_task(reader())
        print("  等待识别引擎就绪…")
        await asyncio.wait_for(ready.wait(), timeout=180)

        print(f"  开始推送音频（{total:.1f}s，严格按实时节奏）…")
        t0 = time.monotonic()
        idx = 0
        while idx < audio.size:
            block = audio[idx: idx + CHUNK]
            # 严格实时：这一块应该在 t0 + idx/SR 时刻发出，睡到那个时刻为止
            target = t0 + idx / SR
            lag = target - time.monotonic()
            if lag > 0:
                await asyncio.sleep(lag)
            sent_at.append(time.monotonic())
            pcm = np.clip(block * 32768.0, -32768, 32767).astype(np.int16)
            await ws.send(pcm.tobytes())
            idx += CHUNK
        drift = time.monotonic() - (t0 + total)
        print(f"  推完，实际用时 {time.monotonic() - t0:.1f}s（理想 {total:.1f}s，漂移 {drift:+.2f}s）")

        await ws.send(json.dumps({"type": "flush"}))
        try:
            await asyncio.wait_for(drained.wait(), timeout=180)
        except (asyncio.TimeoutError, TimeoutError):
            print("  [警告] 没等到 drained")
        rtask.cancel()
        try:
            await rtask
        except asyncio.CancelledError:
            pass

    # 只保留最终字幕
    finals = [r for r in rows if r.get("final") and r.get("source")]
    dedup: dict[int, dict] = {}
    for r in finals:
        d = dedup.setdefault(r["id"], {"id": r["id"], "source": r.get("source"), "translated": None,
                                       "t_source": None, "t_translated": None, "t_audio_end": r["t_audio_end"],
                                       # 「先快稿、后准稿」的两个时间点都要带上，
                                       # 少了这两个键就会在汇总时被丢掉，看起来像没发过快稿
                                       "t_draft": None, "draft_text": None})
        for k in ("source", "translated", "t_source", "t_translated", "t_draft", "draft_text"):
            if r.get(k) is not None:
                d[k] = r[k]
    return [d for d in dedup.values() if d["t_source"]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--external", action="store_true")
    ap.add_argument("--model", default="small")
    ap.add_argument("--wav", default="sample_en.wav")
    args = ap.parse_args()

    url = f"ws://127.0.0.1:{args.port}/ws"
    health = f"http://127.0.0.1:{args.port}/health"

    proc = None
    if not args.external:
        vpy = SERVER / ".venv" / "Scripts" / "python.exe"
        proc = subprocess.Popen(
            [str(vpy) if vpy.exists() else sys.executable, "app.py", "--port", str(args.port),
             "--model", args.model, "--log-level", "warning"],
            cwd=str(SERVER), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    try:
        print("=" * 70)
        print("  字幕延迟实测（基准 = 这句话的音频播完的时刻）")
        print("=" * 70)
        if not asyncio.run(wait_health(health)):
            print("  服务没起来")
            return 1
        rows = asyncio.run(run(url, args.wav))

        print("\n  逐条明细：")
        print(f"    {'#':>2} {'句尾':>7} {'原文延迟':>9} {'首见中文':>9} {'准稿':>8}  内容")
        src_lat, tr_lat, draft_lat = [], [], []
        base = rows[0]["t_audio_end"] if rows else 0.0
        for i, r in enumerate(rows, 1):
            ls = (r["t_source"] - r["t_audio_end"]) if r.get("t_source") else None
            lt = (r["t_translated"] - r["t_audio_end"]) if r.get("t_translated") else None
            ld = (r["t_draft"] - r["t_audio_end"]) if r.get("t_draft") else None
            if ls is not None:
                src_lat.append(ls)
            if lt is not None:
                tr_lat.append(lt)
            if ld is not None:
                draft_lat.append(ld)
            print(f"    {i:>2} {r['t_audio_end'] - base:>6.1f}s "
                  f"{(f'{ls:.2f}s' if ls is not None else '  -  '):>9} "
                  f"{(f'{ld:.2f}s' if ld is not None else '  -  '):>9} "
                  f"{(f'{lt:.2f}s' if lt is not None else '  -  '):>8}  {(r['source'] or '')[:40]}")
            if r.get("draft_text") and r["draft_text"] != r.get("translated"):
                print(f"       {'':>28} 快稿 → {r['draft_text'][:46]}")
            if r.get("translated"):
                tag = "准稿 → " if (r.get("draft_text") and r["draft_text"] != r["translated"]) else "     → "
                print(f"       {'':>28} {tag}{r['translated'][:46]}")

        print("\n  统计：")
        if src_lat:
            print(f"    原文延迟  中位 {statistics.median(src_lat):.2f}s   平均 {statistics.mean(src_lat):.2f}s   最差 {max(src_lat):.2f}s")
        if draft_lat:
            print(f"    首见中文  中位 {statistics.median(draft_lat):.2f}s   平均 {statistics.mean(draft_lat):.2f}s   最差 {max(draft_lat):.2f}s"
                  f"   ← 用户真正感知的等待")
        if tr_lat:
            print(f"    最终译文  中位 {statistics.median(tr_lat):.2f}s   平均 {statistics.mean(tr_lat):.2f}s   最差 {max(tr_lat):.2f}s")
        if src_lat and draft_lat:
            print(f"    首见中文比原文晚  中位 {statistics.median(draft_lat) - statistics.median(src_lat):.2f}s")
        print(f"    收到最终字幕 {len(rows)} 条，其中带译文 {len(tr_lat)} 条")
        return 0
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
