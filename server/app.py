"""
视频实时字幕翻译 —— 本地后端服务

    python app.py                 # 默认 127.0.0.1:8765
    python app.py --port 9000     # 换端口
    python app.py --preload       # 启动时就加载模型（第一次用建议加，省得点开视频再等）

浏览器扩展通过 WebSocket 把标签页音频（16kHz 单声道 PCM）推过来，
这里流式识别 + 翻译，再把字幕一行行推回去。
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import concurrent.futures
import json
import sys
import threading
import time
from dataclasses import replace
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel

from asr import SAMPLE_RATE, StreamSession, WhisperEngine
from config import MODEL_CHOICES, TARGET_LANGUAGES, TRANSLATOR_CHOICES, Settings, load_settings
from translate import Translator

VERSION = "1.0.0"

settings: Settings = load_settings()

app = FastAPI(title="视频实时字幕翻译", version=VERSION)

# 本地服务，只监听 127.0.0.1；放开 CORS 方便扩展页面 / 浏览器标签直接调试。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.state.settings = settings
app.state.translator = Translator(settings)


def _make_fast_translator(s: Settings):
    """「快接口」翻译器：无视用户配的付费服务商，只走免费竞速链。

    用途是「先快稿、后准稿」里的快稿 —— 免费接口 100ms 就能出中文，
    让用户几乎不用等；随后 DeepSeek 的准稿再替换上去。
    用户本来就选的就是免费接口时，这个实例跟主实例一样，没有额外开销。
    """
    from dataclasses import replace as _replace

    quick = _replace(s, translator="auto")
    return Translator(quick)


app.state.fast_translator = _make_fast_translator(settings)
app.state.engines = {}
app.state.engine_lock = threading.Lock()
app.state.asr_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")
app.state.sessions = 0


def get_engine(model_name: str) -> WhisperEngine:
    name = model_name or settings.model
    with app.state.engine_lock:
        engine = app.state.engines.get(name)
        if engine is None:
            engine = WhisperEngine(replace(settings, model=name))
            app.state.engines[name] = engine
        return engine


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> JSONResponse:
    engines = {name: {"loaded": e.loaded, "loading": e.loading, "error": e.load_error,
                      "device": e.device, "compute_type": e.compute_type}
               for name, e in app.state.engines.items()}
    return JSONResponse({
        "ok": True,
        "version": VERSION,
        "sessions": app.state.sessions,
        "model": settings.model,
        "engines": engines,
        "translate": app.state.translator.status(),
        "target_lang": settings.target_lang,
    })


@app.get("/api/options")
async def api_options() -> JSONResponse:
    return JSONResponse({
        "models": MODEL_CHOICES,
        "targets": TARGET_LANGUAGES,
        "translators": TRANSLATOR_CHOICES,
        "defaults": {
            "model": settings.model,
            "language": settings.language,
            "target_lang": settings.target_lang,
            "translator": settings.translator,
            "device": settings.device,
            "compute_type": settings.compute_type,
        },
    })


class ProbeRequest(BaseModel):
    mode: str = "auto"
    target: str = "zh"
    lang: Optional[str] = "en"
    text: str = "Hello, this is a real time subtitle test."
    deepl_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: str = ""
    openai_model: str = ""


@app.get("/api/translate/probe")
async def api_translate_probe(text: str = "Hello, this is a real time subtitle test.",
                              lang: str = "en") -> JSONResponse:
    """逐个测试翻译服务商（用服务端自己的配置）。"""
    data = await app.state.translator.probe(text, lang or None)
    return JSONResponse(data)


@app.post("/api/translate/probe")
async def api_translate_probe_post(req: ProbeRequest) -> JSONResponse:
    """扩展设置页的「测试翻译」：带上扩展里填的服务商 / Key 临时试一遍。"""
    s = replace(
        app.state.settings,
        translator=req.mode or "auto",
        target_lang=req.target or "zh",
        deepl_api_key=req.deepl_api_key or app.state.settings.deepl_api_key,
        openai_api_key=req.openai_api_key or app.state.settings.openai_api_key,
        openai_base_url=req.openai_base_url or app.state.settings.openai_base_url,
        openai_model=req.openai_model or app.state.settings.openai_model,
    )
    probe_translator = Translator(s)
    try:
        data = await probe_translator.probe(req.text, req.lang or None)
    finally:
        await probe_translator.close()
    return JSONResponse(data)


@app.get("/", response_class=HTMLResponse)
async def index() -> str:
    t = app.state.translator.status()
    engines = {n: e for n, e in app.state.engines.items()}
    rows = "".join(
        f"<tr><td>{n}</td><td>{'✅ 已加载' if e.loaded else ('⏳ 加载中' if e.loading else '💤 未加载')}</td>"
        f"<td>{e.device}/{e.compute_type}</td></tr>"
        for n, e in engines.items()
    ) or "<tr><td colspan=3>（还没有连接过，识别模型会按需加载）</td></tr>"
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>视频实时字幕翻译 · 本地服务</title>
<style>
 body{{font-family:"Segoe UI","Microsoft YaHei",sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1f2430;line-height:1.7}}
 h1{{font-size:22px;margin-bottom:4px}}
 .ok{{color:#0a7d3f;font-weight:600}}
 code,td,th{{font-size:14px}}
 table{{border-collapse:collapse;width:100%;margin:12px 0}}
 td,th{{border:1px solid #dfe3ea;padding:8px 10px;text-align:left}}
 th{{background:#f5f7fa}}
 .badge{{display:inline-block;background:#eef6ff;color:#1259b8;border-radius:6px;padding:2px 8px;font-size:13px}}
</style></head><body>
<h1>视频实时字幕翻译 · 本地服务</h1>
<p class="ok">✅ 服务正在运行（v{VERSION}）</p>
<p>扩展连接地址：<code>ws://{settings.host}:{settings.port}/ws</code> <span class="badge">保持一致即可</span></p>
<h3>识别模型</h3>
<table><tr><th>模型</th><th>状态</th><th>设备 / 精度</th></tr>{rows}</table>
<h3>翻译</h3>
<p>模式 <code>{t['mode']}</code> ｜ 目标语言 <code>{t['target']}</code> ｜ 回退链 <code>{' → '.join(t['chain']) or '未启用'}</code>
{f"<br>当前生效：<code>{t['active']}</code>" if t.get('active') else ""}
{f"<br>冷却中：<code>{', '.join(t['cooldown'])}</code>" if t.get('cooldown') else ""}</p>
<h3>当前连接数</h3><p>{app.state.sessions}</p>
<p style="color:#68707f;font-size:13px">这个页面只是状态页，关掉不影响使用。字幕会直接显示在视频上。</p>
</body></html>"""


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    app.state.sessions += 1
    base: Settings = app.state.settings
    translator: Translator = app.state.translator
    fast_translator: Translator = app.state.fast_translator
    loop = asyncio.get_running_loop()
    send_lock = asyncio.Lock()
    closed = False

    async def send(payload: dict) -> None:
        nonlocal closed
        if closed:
            return
        async with send_lock:
            try:
                await ws.send_json(payload)
            except Exception:  # noqa: BLE001
                closed = True

    # 会话级配置（可被客户端的 config 消息覆盖）
    session_cfg: dict[str, Any] = {
        "model": base.model,
        "language": base.language,
        "target_lang": base.target_lang,
        "translate": base.translator != "none",
        "translate_partials": base.translate_partials,
    }

    await send({
        "type": "hello",
        "version": VERSION,
        "model": session_cfg["model"],
        "sample_rate": SAMPLE_RATE,
        "device": base.device,
        "translate": translator.status(),
    })

    queue: asyncio.Queue = asyncio.Queue(maxsize=400)   # 400 * 64ms ≈ 25s 缓冲
    stop = asyncio.Event()
    translation_tasks: dict[int, asyncio.Task] = {}

    def build_settings() -> Settings:
        return replace(
            base,
            model=session_cfg["model"],
            language=session_cfg["language"],
            target_lang=session_cfg["target_lang"],
        )

    # ---- 从 WS 读数据 ----------------------------------------------------
    async def reader() -> None:
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                data = msg.get("bytes")
                if data:
                    pcm = np.frombuffer(data, dtype=np.int16)
                    try:
                        queue.put_nowait(pcm)
                    except asyncio.QueueFull:
                        try:
                            queue.get_nowait()      # 丢最旧的，保证实时性
                        except asyncio.QueueEmpty:
                            pass
                        try:
                            queue.put_nowait(pcm)
                        except asyncio.QueueFull:
                            pass
                    continue
                text = msg.get("text")
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                kind = payload.get("type")
                if kind == "config":
                    if "model" in payload and payload["model"]:
                        session_cfg["model"] = payload["model"]
                    if "target_lang" in payload and payload["target_lang"]:
                        session_cfg["target_lang"] = payload["target_lang"]
                    if "language" in payload:
                        session_cfg["language"] = payload["language"] or None
                    if "translate" in payload:
                        session_cfg["translate"] = bool(payload["translate"])
                    if "translate_partials" in payload:
                        session_cfg["translate_partials"] = bool(payload["translate_partials"])

                    # 扩展端可以热切换翻译服务商 / Key，不用改服务端配置
                    if any(k in payload for k in
                           ("translator", "deepl_api_key", "openai_api_key", "openai_base_url", "openai_model")):
                        translator.update_settings(replace(
                            app.state.settings,
                            translator=payload.get("translator") or app.state.settings.translator,
                            target_lang=session_cfg["target_lang"],
                            deepl_api_key=payload.get("deepl_api_key") or app.state.settings.deepl_api_key,
                            openai_api_key=payload.get("openai_api_key") or app.state.settings.openai_api_key,
                            openai_base_url=payload.get("openai_base_url") or app.state.settings.openai_base_url,
                            openai_model=payload.get("openai_model") or app.state.settings.openai_model,
                        ))
                    else:
                        translator.settings = replace(translator.settings, target_lang=session_cfg["target_lang"])

                    await send({"type": "status", "state": "config", "message": "配置已更新",
                                "config": dict(session_cfg), "translate": translator.status()})
                elif kind == "ping":
                    await send({"type": "pong", "t": time.time()})
                elif kind == "flush":
                    await send({"type": "status", "state": "flush", "message": "正在收尾当前这句…"})
                    try:
                        queue.put_nowait(None)   # 交给 worker 处理 flush
                    except asyncio.QueueFull:
                        pass
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            print(f"[ws] reader 异常：{exc}", flush=True)
        finally:
            stop.set()

    # ---- 处理音频 / 输出字幕 ---------------------------------------------
    last_partial_source: dict[int, str] = {}
    # 前面几句**已定稿**的原文，作为翻译的上下文。
    # 只看一句是猜不出 "it" / "this" 指什么的，带上前文代词和术语会准很多。
    # 只收 final，免得把还在变的中间结果塞进去污染上下文。
    recent_sources: collections.deque[str] = collections.deque(maxlen=2)
    # 已经定稿的句子 id。中间字幕的翻译跑得慢，可能在定稿之后才回来，
    # 那时候发出去会把准稿盖成半截话 —— 发送前先查这个集合。
    finalized_ids: set[int] = set()

    async def emit_line(ev: dict) -> None:
        source = ev.get("source")
        if source:
            await send(ev)
        if not session_cfg["translate"] or not source:
            return

        if not ev["final"]:
            if not session_cfg["translate_partials"]:
                return
            # 中间字幕：文字几乎没变就别重复翻译。
            # 免费接口最怕的就是这种一秒一次的连打，省下来额度留给最终字幕。
            prev = last_partial_source.get(ev["id"], "")
            grew = len(source) - len(prev)
            ends_well = source.endswith(("。", "！", "？", ".", "!", "?", "…"))
            if grew < 6 and not ends_well:
                return
            last_partial_source[ev["id"]] = source
        else:
            last_partial_source.pop(ev["id"], None)
            # 定稿了才进上下文；去重，避免重复句把窗口挤满
            if not recent_sources or recent_sources[-1] != source:
                recent_sources.append(source)

        seg_id = ev["id"]
        prev_task = translation_tasks.get(seg_id)
        if prev_task and not prev_task.done():
            # ★ 最终字幕到了，**也要**把上一句中间字幕的翻译任务掐掉。
            #   以前只在中间字幕时取消，于是最终字幕定稿后，
            #   那句中间字幕的翻译还会姗姗来迟地发出来，把准稿盖成半截话
            #   （实测出现过「二」「第一个是」这种被截断的译文）。
            prev_task.cancel()
        if ev["final"]:
            # 打上「这句已定稿」的标记：正在跑的中间字幕翻译即使已经拿到结果，
            # 发送前也会再检查一次，过期的直接丢掉。
            finalized_ids.add(seg_id)
        task = asyncio.create_task(translate_line(ev))
        translation_tasks[seg_id] = task

        def _cleanup(t: asyncio.Task, key: int = seg_id) -> None:
            if translation_tasks.get(key) is t:
                translation_tasks.pop(key, None)

        task.add_done_callback(_cleanup)

    async def _emit_translation(ev: dict, text: str, draft: bool = False) -> None:
        await send({
            "type": "line",
            "id": ev["id"],
            "final": ev["final"],
            "source": None,          # None = 客户端保留已有原文
            "translated": text,
            "draft": draft,          # True = 先用快接口出的草稿，后面会被准稿替换
            "lang": ev.get("lang"),
            "t0": ev.get("t0"),
            "t1": ev.get("t1"),
        })

    async def translate_line(ev: dict) -> None:
        """翻译一条字幕。

        ★ 「先快稿、后准稿」：
          实测 DeepSeek 首字要 600ms 左右（瓶颈是模型开始回话的时间，不是写完整句，
          所以流式几乎省不下来）。而免费接口 100ms 就能出结果。
          于是最终字幕会**同时**发两条路：
            · 免费接口先出一版中文立刻显示（用户几乎不用等）
            · DeepSeek 的准稿到了再替换（代词、指代更准）
          中间字幕只走免费接口 —— 它本来就是给「正在说话时」看的，会被最终结果顶掉，
          花 600ms 去调 DeepSeek 既浪费钱又占住请求锁，反而拖慢最终字幕。

        注意 final=False 时 fast_translator 与主 translator 的链不同，
        不会被 self.preferred 记住，所以不会污染最终字幕的服务商选择。
        """
        # 传前文当上下文。注意要排除自己（自己可能已经进 deque 了，
        # 因为 emit_line 是先把 final 收进 recent_sources 再排翻译任务的）。
        context = [s for s in recent_sources if s != ev["source"]][-2:]
        is_final = bool(ev["final"])

        # ---- 中间字幕：只走快接口 ----
        if not is_final:
            out = await fast_translator.translate(ev["source"], ev.get("lang"), context=context)
            # 这句在这期间已经定稿了 → 这个中间译文已经过期，发出去会盖掉准稿
            if ev["id"] in finalized_ids:
                return
            if out:
                await _emit_translation(ev, out)
            return

        # ---- 最终字幕：快稿 + 准稿并行 ----
        fast_task = asyncio.create_task(
            fast_translator.translate(ev["source"], ev.get("lang"), context=context)
        )
        accurate_task = asyncio.create_task(
            translator.translate(ev["source"], ev.get("lang"), allow_wait=True, context=context)
        )

        sent_draft = False
        try:
            # 谁先回来先处理谁：快接口通常 100ms 就回，DeepSeek 要 600ms+
            done, _pending = await asyncio.wait(
                {fast_task, accurate_task}, return_when=asyncio.FIRST_COMPLETED
            )
            if fast_task in done and accurate_task not in done:
                try:
                    quick = fast_task.result()
                except Exception:  # noqa: BLE001
                    quick = None
                if quick:
                    sent_draft = True
                    await _emit_translation(ev, quick, draft=True)

            # 等准稿（DeepSeek）。失败就退避重试，免费接口被限流是常态。
            delay = 2.0
            out = None
            for attempt in range(3):
                try:
                    out = await asyncio.shield(accurate_task)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    print(f"[translate] 准稿失败：{exc}", flush=True)
                    out = None
                if out:
                    break
                if attempt == 2:
                    break
                await asyncio.sleep(delay)
                delay *= 2.5
                accurate_task = asyncio.create_task(
                    translator.translate(ev["source"], ev.get("lang"),
                                         allow_wait=True, context=context)
                )

            if out:
                await _emit_translation(ev, out)
            elif sent_draft:
                # 准稿没出来，但草稿已经显示了 —— 别再发空的把草稿盖掉
                pass
            else:
                # 两条路都没结果：等快稿兜底
                try:
                    quick = await fast_task
                except Exception:  # noqa: BLE001
                    quick = None
                if quick:
                    await _emit_translation(ev, quick)
        finally:
            for t in (fast_task, accurate_task):
                if not t.done():
                    t.cancel()
            await asyncio.gather(fast_task, accurate_task, return_exceptions=True)

    async def worker() -> None:
        session: Optional[StreamSession] = None
        engine: Optional[WhisperEngine] = None
        stats_task: Optional[asyncio.Task] = None

        async def emit_ev(ev: dict) -> None:
            """事件分发。

            「speech / start」是个不带文字的轻量信号（有人开始说话了），直接透传给客户端，
            让它立刻把上一句字幕淡掉 —— 这样就不会出现「上一个人的字幕挂在
            下一个人说话的时候」。字幕事件才走 emit_line（那才会触发翻译）。
            """
            if ev.get("type") == "speech":
                await send(ev)
                return
            await emit_line(ev)

        async def _drain_events(sess: StreamSession, emit, timeout: float = 60.0) -> None:
            """等解码线程把剩下的任务做完，并把事件发出去。"""
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                for ev in sess.poll_events():
                    await emit(ev)
                if sess.is_idle():
                    break
                await asyncio.sleep(0.02)
            for ev in sess.poll_events():
                await emit(ev)

        async def stats_loop() -> None:
            while not stop.is_set():
                await asyncio.sleep(5.0)
                if session is not None:
                    await send({"type": "stats", **session.stats})
        try:
            while not stop.is_set():
                want = session_cfg["model"]
                if engine is None or engine.model_name != want:
                    engine = get_engine(want)
                    if not engine.loaded:
                        await send({"type": "status", "state": "loading",
                                    "message": f"正在加载识别模型「{want}」，首次使用需要下载，请稍候…"})
                    try:
                        await loop.run_in_executor(app.state.asr_pool, engine.load)
                    except Exception as exc:  # noqa: BLE001
                        await send({"type": "error", "code": "model_load_failed", "message": str(exc)})
                        return

                    # 加载期间积压的音频早就过期了，丢掉，从「现在」开始
                    dropped = 0
                    while True:
                        try:
                            stale = queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                        if stale is None:
                            queue.put_nowait(None)
                            break
                        dropped += 1
                    if dropped:
                        print(f"[ws] 丢弃加载期间积压的 {dropped} 个音频包", flush=True)

                    # 换模型时先把旧会话的解码线程停掉，别让两个解码线程抢 CPU
                    if session is not None:
                        await loop.run_in_executor(None, session.close)
                    session = StreamSession(engine, build_settings())
                    # 把「正在用哪个翻译服务商」也报给扩展，弹窗里直接显示出来。
                    # 为什么值得单独报：扩展里存的 translator 会**覆盖**服务端配置，
                    # 存的是 "auto" 还是 "openai" 直接决定走 DeepSeek 还是免费接口，
                    # 而这个值在界面上以前完全看不见，很容易以为配了却没生效。
                    tstat = translator.status()
                    await send({"type": "status", "state": "ready",
                                "message": f"已就绪（{engine.device}/{engine.compute_type}）",
                                "device": engine.device, "compute_type": engine.compute_type,
                                "model": want,
                                "translator": tstat.get("mode"),
                                "translatorActive": tstat.get("active"),
                                "translatorChain": tstat.get("chain")})
                    if stats_task:
                        stats_task.cancel()
                    stats_task = asyncio.create_task(stats_loop())

                    # 预热翻译服务商：第一次翻译要同时试好几个接口比较慢，
                    # 提前烤一次，用户的第一句字幕就不会等这一下。
                    asyncio.create_task(translator.translate("Hello.", "en"))

                    # 预热翻译服务商：第一次翻译要同时试好几个接口比较慢，
                    # 提前烤一次，用户的第一句字幕就不会等这一下。
                    asyncio.create_task(translator.translate("Hello.", "en"))

                try:
                    item = await asyncio.wait_for(queue.get(), timeout=0.25)
                except (asyncio.TimeoutError, TimeoutError):
                    # 没新音频也要把解码线程产出的字幕捞出来
                    for ev in session.poll_events():
                        await emit_ev(ev)
                    continue

                if item is None:
                    # flush：先把积压的音频喂完，再让 session 收尾
                    await loop.run_in_executor(app.state.asr_pool, session.flush)
                    await _drain_events(session, emit_ev, timeout=120.0)
                    # 队列里的音频已经全部处理完，再等未完成的翻译收尾，
                    # 然后明确告诉客户端「吐完了」。
                    # 客户端（尤其是测试脚本）靠这个信号判断结束，
                    # 而不是靠「多久没消息」—— 解码一个长句可能就要好几秒。
                    pending = [t for t in translation_tasks.values() if not t.done()]
                    if pending:
                        await asyncio.gather(*pending, return_exceptions=True)
                    for ev in session.poll_events():
                        await emit_ev(ev)
                    await send({"type": "drained", **session.stats})
                    continue

                # ★ feed 现在只做 VAD + 分句，不做解码，所以可以放心连续喂。
                #   一次多喂几包，把「收音频」和「解码」彻底错开。
                await loop.run_in_executor(app.state.asr_pool, session.feed, item)
                fed = 1
                while fed < 32:
                    try:
                        nxt = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if nxt is None:
                        queue.put_nowait(None)
                        break
                    await loop.run_in_executor(app.state.asr_pool, session.feed, nxt)
                    fed += 1
                for ev in session.poll_events():
                    await emit_ev(ev)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"[ws] worker 异常：{exc}", flush=True)
            await send({"type": "error", "code": "asr_failed", "message": str(exc)})
        finally:
            if stats_task:
                stats_task.cancel()
            if session is not None:
                # 一定要停掉解码线程，否则连接断开后它还在后台啃音频
                try:
                    await asyncio.shield(loop.run_in_executor(None, session.close))
                except Exception:  # noqa: BLE001
                    pass

    reader_task = asyncio.create_task(reader())
    worker_task = asyncio.create_task(worker())

    try:
        await asyncio.wait({reader_task, worker_task}, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        stop.set()
        tasks = [reader_task, worker_task, *translation_tasks.values()]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        app.state.sessions -= 1
        closed = True
        print("[ws] 连接已断开", flush=True)


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="视频实时字幕翻译 · 本地后端")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    parser.add_argument("--model", default=settings.model, choices=MODEL_CHOICES)
    parser.add_argument("--language", default=settings.language, help="源语言，留空=自动检测")
    parser.add_argument("--target", default=settings.target_lang, help="目标语言")
    parser.add_argument("--translator", default=settings.translator, choices=TRANSLATOR_CHOICES)
    parser.add_argument("--device", default=settings.device, choices=["auto", "cpu", "cuda"])
    parser.add_argument("--compute-type", dest="compute_type", default=settings.compute_type,
                        choices=["auto", "int8", "int8_float16", "float16", "float32"])
    parser.add_argument("--log-level", dest="log_level", default=settings.log_level,
                        choices=["critical", "error", "warning", "info", "debug", "trace"])
    parser.add_argument("--preload", action="store_true", help="启动时立即加载模型")
    args = parser.parse_args()

    settings.host = args.host
    settings.port = args.port
    settings.model = args.model
    settings.language = args.language or None
    settings.target_lang = args.target
    settings.translator = args.translator
    settings.device = args.device
    settings.compute_type = args.compute_type
    settings.log_level = args.log_level
    if args.preload:
        settings.preload = True
    app.state.settings = settings
    app.state.translator = Translator(settings)

    if settings.preload:
        def _preload() -> None:
            try:
                get_engine(settings.model).load()
            except Exception as exc:  # noqa: BLE001
                print(f"[preload] 失败：{exc}", flush=True)
        threading.Thread(target=_preload, daemon=True).start()

    print("=" * 68)
    print("  视频实时字幕翻译 · 本地服务")
    print(f"  地址：http://{settings.host}:{settings.port}/    （扩展里填 ws://{settings.host}:{settings.port}/ws）")
    print(f"  模型：{settings.model}   源语言：{settings.language or '自动检测'}   目标语言：{settings.target_lang}")
    print(f"  翻译：{settings.translator}   设备：{settings.device}")
    print("=" * 68)

    import uvicorn
    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level, ws_ping_interval=20, ws_ping_timeout=20)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
