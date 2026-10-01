"""
流式语音识别：faster-whisper + 能量 VAD。

设计要点
--------
1. **不依赖整段音频**：扩展端把标签页音频重采样成 16kHz 单声道 PCM，
   以 64ms 一包持续推过来；这里边收边判断「有没有人在说话」。
2. **两级输出**：一句话说完之前不断发"中间字幕"（partial，会被不断修正），
   检测到 700ms 静音后发"最终字幕"（final，不再变化）。
3. **滑窗重解码**：中间字幕每次都对「当前这句话到目前为止」的音频重新解码，
   所以文字会自我修正，和 YouTube 自动字幕的观感一致；
   单句超过 max_window_s 就强制切段，避免延迟无限增长。
4. **幻觉过滤**：Whisper 在静音/音乐上会凭空编字幕，这里用
   能量检测 + 常见幻觉模板 + 重复折叠 三道过滤挡掉。

本模块是纯同步代码，由 app.py 放到线程池里跑，不阻塞事件循环。
"""

from __future__ import annotations

import os
import re
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Iterable, Optional

import numpy as np

from config import AUTO_MODEL_CPU, AUTO_MODEL_CUDA, MODELS_DIR, Settings, ensure_hf_endpoint

SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_LEN = SAMPLE_RATE * FRAME_MS // 1000      # 320 采样点
PREROLL_S = 0.50                                # 触发说话时回补的前置音频
SPEECH_TRIGGER_MS = 100                         # 连续多少毫秒有声音才算「开始说话」

# 设 VST_DEBUG_TIMING=1 可以把流式解码的时间线打出来，用来定位延迟。
TIMING = os.environ.get("VST_DEBUG_TIMING", "") not in ("", "0", "false")


def _ts() -> str:
    return f"{time.monotonic() % 1000:8.3f}"


# ---------------------------------------------------------------------------
# 能量 VAD
# ---------------------------------------------------------------------------
class EnergyVAD:
    """极轻量的 RMS 语音活动检测，噪声底用滑动窗口分位数估计。

    比 Silero VAD 精度低，但零额外依赖、几乎不耗 CPU，配合 Whisper 自身的
    no_speech_threshold 已经够用。

    噪声底取最近约 3 秒帧能量的低分位数：
      * 说话有停顿 → 低分位数就是环境底噪，说话声远高于它，能检出；
      * 持续音乐/风扇 → 低分位数被抬起来，稳态噪声不再被误判成说话。
    阈值再套一个上限 max_thr，宁可多识别一点也不要漏掉轻声说话——
    漏掉的字幕是找不回来的，多出来的幻觉还有后面几道过滤挡着。
    """

    def __init__(self, abs_floor: float = 0.005, rel: float = 2.5,
                 max_thr: float = 0.030, window_frames: int = 150, percentile: float = 15.0):
        self.abs_floor = abs_floor
        self.rel = rel
        self.max_thr = max_thr
        self.percentile = percentile
        self.window: deque[float] = deque(maxlen=window_frames)
        self.noise = abs_floor

    def frame_rms(self, x: np.ndarray) -> np.ndarray:
        n = x.size // FRAME_LEN
        if n == 0:
            return np.empty(0, dtype=np.float32)
        y = x[: n * FRAME_LEN].reshape(n, FRAME_LEN)
        return np.sqrt(np.mean(y * y, axis=1) + 1e-12)

    def threshold(self) -> float:
        return max(self.abs_floor, min(self.noise * self.rel, self.max_thr))

    def speech_flags(self, x: np.ndarray, *, adapt: bool = True) -> np.ndarray:
        """返回逐帧「是否说话」的布尔数组。

        adapt=True 时噪声底会跟随输入更新（每段新流入的音频只调用一次）；
        adapt=False 是纯只读分析，用于对同一段音频反复判断，不会污染估计值。
        """
        rms = self.frame_rms(x)
        flags = np.zeros(rms.size, dtype=bool)
        if not adapt:
            thr = self.threshold()
            return rms > thr

        for i in range(rms.size):
            r = float(rms[i])
            if len(self.window) >= 25:
                self.noise = float(np.percentile(self.window, self.percentile))
            flags[i] = r > self.threshold()
            self.window.append(r)
        return flags


# ---------------------------------------------------------------------------
# 文本清洗 / 幻觉过滤
# ---------------------------------------------------------------------------
_HALLUCINATION_PATTERNS = [
    re.compile(r"^[\s\.\,\!\?\-\u2026\u3002\uff0c\uff01\uff1f\u3001]*$"),
    re.compile(r"字幕由.{0,16}(提供|制作|上传|组)"),
    re.compile(r"请不吝?(点赞|订阅)"),
    re.compile(r"(订阅|关注).{0,8}(频道|转发|点赞)"),
    re.compile(r"感谢(大家)?(的)?(观看|收看|收听)"),
    re.compile(r"(谢谢|多谢)(大家)?(观看|收看|收听)"),
    re.compile(r"^\s*(Thanks?|Thank you)[,\.]?\s*(for watching|for view)", re.I),
    re.compile(r"^\s*(Subtitles?|Captions?|Transcri\w+)\s+by\b", re.I),
    re.compile(r"amara\.org", re.I),
    re.compile(r"^\s*www\.[a-z0-9\-\.]+\s*$", re.I),
    re.compile(r"^\s*(字幕|字幕组|翻訳|字幕制作)\s*$"),
]

# 整句重复： "ok ok ok ok"（正则版，处理带标点的紧密重复）
_REPEAT_WHOLE = re.compile(r"^(.{2,24}?)\1{2,}$")
_REPEAT_CHAR = re.compile(r"(.)\1{4,}")


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return 0x3040 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF


def _collapse_periodic(t: str) -> str:
    """整段文字是同一个片段的整数倍重复时，只保留一份。

    Whisper 在短音频上偶尔会陷进循环，吐出
    "the first one is the first one is the first one is ..." 这种，
    不折叠的话字幕会一直刷同一句，非常难看。

    用「最小周期」判断而不是正则回溯：按空格切成词元，找到能整除总数的
    最小周期 p 并且所有词元都满足 tokens[i] == tokens[i % p]（忽略大小写）。
    """
    tokens = t.split(" ")
    n = len(tokens)
    if n >= 3 and t:
        for p in range(1, n // 3 + 1):
            if n % p == 0 and all(tokens[i].lower() == tokens[i % p].lower() for i in range(n)):
                return " ".join(tokens[:p])
    # 没有空格的语言（中文/日文）按字符找周期
    if " " not in t and len(t) >= 3:
        for p in range(1, len(t) // 3 + 1):
            if len(t) % p == 0 and all(t[i] == t[i % p] for i in range(len(t))):
                return t[:p]
    return t


def normalize_text(text: str) -> str:
    t = (text or "").strip()
    t = re.sub(r"\s+", " ", t)
    t = _REPEAT_CHAR.sub(r"\1\1", t)
    t = _collapse_periodic(t)
    t = _REPEAT_WHOLE.sub(r"\1", t)
    return t.strip()


def is_noise(text: str, *, min_chars: int = 2) -> bool:
    """判断一段识别结果是不是垃圾/幻觉，是则返回 True 应当丢弃。"""
    if not text:
        return True
    stripped = text.strip()
    if len(stripped) < min_chars:
        return True
    for pat in _HALLUCINATION_PATTERNS:
        if pat.search(stripped):
            return True
    # 全是标点 / 单字符重复
    alnum = [c for c in stripped if c.isalnum() or _is_cjk(c)]
    if len(alnum) < min_chars:
        return True
    return False


def join_segments(segments: Iterable[Any]) -> str:
    """faster-whisper 分段时间戳文本拼接：拉丁文自带前导空格，中文不需要。"""
    return "".join(seg.text for seg in segments)


# ---------------------------------------------------------------------------
# GPU 可用性
# ---------------------------------------------------------------------------
_CUDA_DLLS = ("cublas64_12.dll", "cudnn64_9.dll")
_dll_dirs_added: Optional[list] = None


def _candidate_cuda_dirs() -> list:
    """列出所有可能藏着 cublas64_12.dll / cudnn64_9.dll 的目录。

    两条路都支持，谁有用谁 —— 不是只能用 pip 版：
      A. pip 装的运行库（nvidia-cublas-cu12 / nvidia-cudnn-cu12 …）
         → site-packages\\nvidia\\*\\bin
      B. 系统级 CUDA 工具包 / cuDNN
         → CUDA_PATH\\bin、CUDA_PATH\\lib\\x64，以及常见的默认安装位置
    推荐 pip 版只是因为它更省事（见下面说明），但如果你已经装过工具包，
    这里会自动认出来，不会重复下载。
    """
    dirs: list = []
    if os.name != "nt":
        return dirs

    # --- A. pip 版 ---
    try:
        import site
        import sysconfig

        roots = [Path(p) / "nvidia" for p in site.getsitepackages()]
        try:
            roots.append(Path(site.getusersitepackages()) / "nvidia")
        except Exception:  # noqa: BLE001
            pass
        try:
            roots.append(Path(sysconfig.get_paths()["purelib"]) / "nvidia")
        except Exception:  # noqa: BLE001
            pass
        for root in roots:
            if root.is_dir():
                for sub in sorted(root.iterdir()):
                    dirs.append(sub / "bin")
    except Exception:  # noqa: BLE001
        pass

    # --- B. 系统级工具包 ---
    import glob

    for env in ("CUDA_PATH", "CUDA_HOME", "CUDNN_PATH"):
        base = os.environ.get(env)
        if base:
            dirs.append(Path(base) / "bin")
            dirs.append(Path(base) / "lib" / "x64")
            dirs.append(Path(base) / "lib")
    for pat in (
        r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\*\bin",
        r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\*\lib\x64",
        r"C:\Program Files\NVIDIA\CUDNN\*\bin",
        r"C:\Program Files\NVIDIA\CUDNN\*\lib\x64",
        r"C:\Program Files\NVIDIA\CUDNN\*\bin\12*",
        r"C:\tools\cuda\bin",
    ):
        for hit in glob.glob(pat):
            dirs.append(Path(hit))

    # 去重 + 只保留真实存在的目录
    out: list = []
    seen = set()
    for d in dirs:
        try:
            if not d.is_dir():
                continue
            key = str(d).lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(d)
        except OSError:
            continue
    return out


def _preload_cuda_dlls() -> list:
    """用 ctypes 按**全路径**把 CUDA 库预加载进进程。

    ★ 为什么光 os.add_dll_directory 不够：
      ctranslate2 内部是用 LoadLibrary 按**裸名字**找 cublas64_12.dll 的，
      它并不总是走我们注册的目录 —— 实测会报
      "Library cublas64_12.dll is not found or cannot be loaded"，
      即使目录确实已经加进去了。
      先按全路径自己加载一次，模块就留在进程里了，
      之后再按名字找就能命中（Windows 的模块表是全进程共享的）。

    这一步对**所有入口**都重要：只要有人先 import 了 faster_whisper/ctranslate2，
    事后再加目录就来不及了。
    """
    if os.name != "nt":
        return []
    import ctypes

    loaded: list = []
    for d in _candidate_cuda_dirs():
        for dll in _CUDA_DLLS:
            p = os.path.join(str(d), dll)
            if not os.path.exists(p):
                continue
            try:
                ctypes.WinDLL(p)
                loaded.append(p)
            except OSError:
                pass
    return loaded


def _add_nvidia_dll_dirs() -> list:
    """把所有能找到 CUDA 库的目录加进进程的 DLL 搜索路径，并预加载一次。

    为什么需要这一步：Windows 上 ctranslate2 是靠 LoadLibrary 去找
    cublas64_12.dll / cudnn64_9.dll 的。这些库要么来自 pip 包
    （躺在 site-packages\\nvidia\\*\\bin，默认不在搜索路径），
    要么来自系统级 CUDA 工具包（装在 Program Files，默认也不在 PATH 里）。
    os.add_dll_directory 会同时设置 SetDefaultDllDirectories，
    之后的 LoadLibrary 就能找到它们。

    必须在 import ctranslate2 / 创建模型之前调用。
    """
    global _dll_dirs_added
    if _dll_dirs_added is not None:
        return _dll_dirs_added

    added: list = []
    if os.name == "nt":
        for d in _candidate_cuda_dirs():
            try:
                os.add_dll_directory(str(d))
                added.append(str(d))
            except OSError:
                pass
        # 加完目录立刻按全路径预加载一次，见 _preload_cuda_dlls 的说明
        pre = _preload_cuda_dlls()
        if added:
            print(f"[asr] CUDA 库搜索路径：{len(added)} 个目录，已预加载 {len(pre)} 个库", flush=True)
            if TIMING:
                for d in added:
                    print(f"[asr]   + {d}", flush=True)
    _dll_dirs_added = added
    return added


def _cuda_libs_present() -> bool:
    """确认 CUDA 12 的 cuBLAS / cuDNN 9 真的能加载。

    CTranslate2 要等到第一次推理才报「Library cublas64_12.dll is not found」，
    提前用 ctypes 试加载一次，免得白等一场再回退。
    也把环境变量 CUDA_PATH 下的 bin 和 ctranslate2 自带的目录一起试。
    """
    _add_nvidia_dll_dirs()
    if os.name != "nt":
        return True

    import ctypes

    search_dirs = list(_dll_dirs_added or [])
    for env in ("CUDA_PATH", "CUDA_HOME"):
        base = os.environ.get(env)
        if base:
            search_dirs.append(os.path.join(base, "bin"))

    for dll in _CUDA_DLLS:
        if _try_load(ctypes, dll):
            continue
        # 默认路径没找到 → 挨个目录直接按全路径加载试试
        ok = False
        for d in search_dirs:
            p = os.path.join(d, dll)
            if os.path.exists(p) and _try_load(ctypes, p):
                ok = True
                break
        if not ok:
            print(f"[asr] 未找到 {dll}，改用 CPU 识别", flush=True)
            print("[asr] 想用显卡就装这两个包（不用装 CUDA 工具包）：", flush=True)
            print("[asr]   pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12", flush=True)
            return False
    return True


def _try_load(ctypes_mod, path: str) -> bool:
    try:
        ctypes_mod.WinDLL(path)
        return True
    except OSError:
        return False


def _warmup(model: Any) -> None:
    """用 0.5 秒静音跑一次真实推理，确认设备真的能用（而不是只加载成功）。"""
    probe = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
    segments, _info = model.transcribe(
        probe, language="en", beam_size=1, without_timestamps=True, vad_filter=False
    )
    for _seg in segments:  # 必须真正迭代，否则计算不会发生
        pass


# ---------------------------------------------------------------------------
# Whisper 引擎（懒加载，可被多个会话共享）
# ---------------------------------------------------------------------------
class WhisperEngine:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._model = None
        self._lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self.loaded = False
        self.loading = False
        self.load_error: Optional[str] = None
        self.device = "?"
        self.compute_type = "?"
        self.model_name = settings.model
        self.fallback_reason: Optional[str] = None

    # -- 加载 ---------------------------------------------------------------
    def load(self):
        with self._lock:
            if self._model is not None:
                return self._model
            if self.load_error:
                raise RuntimeError(self.load_error)
            self.loading = True
            try:
                ensure_hf_endpoint(self.settings.hf_endpoint)
                # 必须在 import ctranslate2 之前把 pip 版 CUDA 库目录加进搜索路径，
                # 否则它 LoadLibrary 找不到 cublas64_12.dll
                _add_nvidia_dll_dirs()
                import ctranslate2
                from faster_whisper import WhisperModel
            except Exception as exc:  # noqa: BLE001
                self.loading = False
                self.load_error = f"依赖导入失败：{exc}"
                raise RuntimeError(self.load_error) from exc

            device = self.settings.device
            if device == "auto":
                try:
                    cuda_count = ctranslate2.get_cuda_device_count()
                except Exception:  # noqa: BLE001
                    cuda_count = 0
                if cuda_count > 0 and _cuda_libs_present():
                    device = "cuda"
                else:
                    device = "cpu"

            compute = self.settings.compute_type
            if compute == "auto":
                compute = "float16" if device == "cuda" else "int8"

            # 「auto」按设备挑模型。
            # 依据：显卡上一次解码 300ms 左右，而「等静音」固定 400ms ——
            # 大模型再慢一点也还是被那 400ms 盖住，等于准确率白拿。
            # 但 CPU 上一次要一秒多，大模型会直接拖垮，所以两边必须分开。
            model_name = self.settings.model
            if model_name == "auto":
                model_name = AUTO_MODEL_CUDA if device == "cuda" else AUTO_MODEL_CPU
                print(f"[asr] 模型=auto → {model_name}（device={device}）", flush=True)

            threads = self.settings.cpu_threads or max(1, (os.cpu_count() or 4) // 2)
            MODELS_DIR.mkdir(parents=True, exist_ok=True)

            def _build(dev: str, ct: str):
                return WhisperModel(
                    model_name,
                    device=dev,
                    compute_type=ct,
                    cpu_threads=threads,
                    num_workers=1,
                    download_root=str(MODELS_DIR),
                )

            print(
                f"[asr] 加载模型 {model_name} (device={device}, compute={compute}, "
                f"threads={threads}, 首次运行会自动下载模型)...",
                flush=True,
            )
            t0 = time.time()
            try:
                self._model = _build(device, compute)
                if device == "cuda":
                    _warmup(self._model)
            except Exception as exc:  # noqa: BLE001
                if device == "cuda":
                    print(f"[asr] CUDA 不可用（{exc}），自动改用 CPU/int8", flush=True)
                    self.fallback_reason = str(exc)[:200]
                    device, compute = "cpu", "int8"
                    try:
                        self._model = _build(device, compute)
                    except Exception as exc2:  # noqa: BLE001
                        self.loading = False
                        self.load_error = f"模型加载失败：{exc2}"
                        raise RuntimeError(self.load_error) from exc2
                else:
                    self.loading = False
                    self.load_error = f"模型加载失败：{exc}"
                    raise RuntimeError(self.load_error) from exc

            self.device, self.compute_type = device, compute
            self.loaded = True
            self.loading = False
            print(f"[asr] 模型就绪，用时 {time.time() - t0:.1f}s", flush=True)
            return self._model

    # -- 推理 ---------------------------------------------------------------
    def detect_language(self, audio: np.ndarray) -> tuple[Optional[str], float]:
        """单独做一次语言检测。

        为什么值得单独抽出来：Whisper 的编码器**无论输入多长都要跑满一个 30 秒窗口**，
        所以一次解码的耗时几乎和音频长度无关（实测 small/int8 稳定在 ~1.1s）。
        而 language=None 会让 faster-whisper 每次都额外跑一遍语言检测，
        把单次开销直接翻倍到 ~2.3s —— 对实时字幕来说这是致命的。
        所以在收到第一段足够长的语音时检测一次，之后所有解码都显式传语言。
        """
        model = self.load()
        with self._infer_lock:
            lang, prob, _all_probs = model.detect_language(audio)
        return lang, float(prob)

    def transcribe(
        self,
        audio: np.ndarray,
        *,
        language: Optional[str] = None,
        initial_prompt: Optional[str] = None,
        beam_size: int = 1,
    ):
        model = self.load()
        with self._infer_lock:
            segments, info = model.transcribe(
                audio,
                language=language,
                task="transcribe",
                beam_size=beam_size,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                initial_prompt=initial_prompt or None,
                vad_filter=False,
                without_timestamps=True,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                word_timestamps=False,
            )
            text = join_segments(segments)
        return normalize_text(text), info


# ---------------------------------------------------------------------------
# 一个连接 = 一个 StreamSession
# ---------------------------------------------------------------------------
class StreamSession:
    """把连续的 PCM 喂进来，吐出 partial / final 字幕事件。

    ★ 核心设计：**收音频和解码必须解耦**。

    Whisper 解一次码要一秒多（编码器固定跑满一个 30 秒窗口，与音频长短无关）。
    如果解码和收音频挤在同一个线程里，每解一次码就有「一秒多完全不收音频」，
    音频位置与真实时间的差距会一次次累加 —— 实测 21 秒的音频能累积将近 6 秒延迟，
    也就是字幕永远慢一大截。

    所以这里分成两条线程：
      · feed() 只做「加缓冲 + VAD + 判断句子边界」，微秒级返回，音频永远咬得住实时；
      · 解码线程在后台按顺序处理任务，解完把事件写进队列。
    中间字幕「后来的顶掉先来的」（过时的结果没意义），最终字幕一个都不丢。
    """

    def __init__(self, engine: WhisperEngine, settings: Settings, on_event=None):
        self.engine = engine
        self.settings = settings
        self.vad = EnergyVAD(
            abs_floor=settings.vad_abs_floor,
            rel=settings.vad_rel,
            max_thr=settings.vad_max_thr,
        )
        self._on_event = on_event

        # ---- 解码任务队列（跨线程）----
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._pending_partial: Optional[dict] = None
        self._pending_finals: deque = deque()
        self._inflight: Optional[dict] = None
        self._closed = False
        self._decoder_busy = False
        self._events: deque = deque()

        # ---- 音频 / 分句状态 ----
        self.buf = np.empty(0, dtype=np.float32)
        self.buf_start = 0
        self.abs_samples = 0
        self.speaking = False
        self.open_seg = False
        self.speech_run_ms = 0
        self.silence_run_ms = 0
        self.seg_id = 0
        self.seg_start_sample = 0

        # ---- 中间字幕结果（解出来之后回填）----
        self.partial_text = ""
        self.partial_seg = -1
        self.partial_covered = 0
        self.partial_at = 0.0
        self.partial_enqueued_at = 0.0
        self.prefinal_seg = -1
        self.partials_this_seg = 0

        self.locked_language = settings.language
        self._lang_probe_done = bool(settings.language)
        self.context_prompt = ""
        self.last_final_text = ""

        self.audio_seconds_total = 0.0
        self.infer_seconds_total = 0.0
        self.last_decode_seconds = 0.0
        self.started_at: Optional[float] = None
        self.decodes = 0
        self.promoted = 0          # 被「升格」成最终字幕的中间结果数
        self.dropped = 0           # 因为过时被丢弃的解码结果数

        self._decoder = threading.Thread(target=self._decode_loop, name="vst-decode", daemon=True)
        self._decoder.start()

    # -- 对外接口 -----------------------------------------------------------
    def feed(self, pcm_i16: np.ndarray) -> None:
        """把一包音频喂进来。**不做解码**，微秒级返回。"""
        if pcm_i16.size == 0:
            return
        x = pcm_i16.astype(np.float32) / 32768.0
        self._consume(x)

    def flush(self) -> None:
        """主动结束当前句（用户点了停止 / 切换标签页）。"""
        if self.open_seg:
            self._finalize(cut=True)

    def poll_events(self) -> list[dict]:
        """取走解码线程产生的所有字幕事件（非阻塞）。"""
        out: list[dict] = []
        while True:
            try:
                out.append(self._events.popleft())
            except IndexError:
                break
        return out

    def is_idle(self) -> bool:
        with self._lock:
            return self._pending_partial is None and not self._pending_finals and self._inflight is None

    def wait_idle(self, timeout: float = 30.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.is_idle():
                return True
            time.sleep(0.05)
        return self.is_idle()

    def close(self) -> None:
        with self._cv:
            self._closed = True
            self._cv.notify_all()
        self._decoder.join(timeout=3.0)

    @property
    def stats(self) -> dict:
        # rtf  = 解码耗时 / 音频时长。小于 1 表示比视频播放快。
        # lag  = 当前「音频已经喂到哪」和「解码到哪」的差距，用来判断有没有积压。
        rtf = (self.infer_seconds_total / self.audio_seconds_total) if self.audio_seconds_total else 0.0
        elapsed = (time.monotonic() - self.started_at) if self.started_at else 0.0
        load = (self.infer_seconds_total / elapsed) if elapsed > 0 else 0.0
        return {
            "audio_s": round(self.audio_seconds_total, 1),
            "infer_s": round(self.infer_seconds_total, 1),
            "rtf": round(rtf, 3),
            "load": round(load, 3),
            "decodes": self.decodes,
            "promoted": self.promoted,
            "language": self.locked_language,
        }

    # -- 收音频（快路径，绝不在这里解码）--------------------------------------
    def _consume(self, x: np.ndarray) -> None:
        if self.started_at is None:
            self.started_at = time.monotonic()
        if self.buf.size:
            self.buf = np.concatenate((self.buf, x))
        else:
            self.buf = x
            self.buf_start = self.abs_samples
        self.abs_samples += x.size

        if self.settings.vad_enabled:
            flags = self.vad.speech_flags(x)
        else:
            flags = np.ones(x.size // FRAME_LEN, dtype=bool)

        for flag in flags:
            if flag:
                self.speech_run_ms += FRAME_MS
                self.silence_run_ms = 0
            else:
                self.silence_run_ms += FRAME_MS
                self.speech_run_ms = 0

        if not self.open_seg and self.speech_run_ms >= SPEECH_TRIGGER_MS:
            self._open_segment()

        if not self.open_seg:
            self._trim_idle()
            return

        # 软切段：有 BGM 时 VAD 永远等不到静音，句子会一直不结束。
        # 宁可切在句子中间（最多影响一个词），也不能让字幕卡住不动。
        if self._segment_size() >= int(self.settings.soft_cut_s * SAMPLE_RATE):
            end = self.abs_samples
            self._finalize(cut=True)
            self._open_segment_at(end, notify=False)
            return

        # 单句过长 → 强制切段（硬上限，兜底）
        if self._segment_size() >= int(self.settings.max_window_s * SAMPLE_RATE):
            end = self.abs_samples
            self._finalize(cut=True)
            self._open_segment_at(end, notify=False)
            return

        if self.silence_run_ms >= self.settings.hangover_ms:
            self._finalize(cut=False)
            return

        # 一进入静音就抢一次解码：「预终稿」。
        # 它覆盖到的音频位置已经越过了「说话结束点」，所以等静音确认之后
        # 可以直接把它升格成最终字幕 —— 等于把解码和静音等待重叠起来，
        # 省掉整整一次一千多毫秒的解码。
        if (self.settings.prefinal_ms
                and self.silence_run_ms >= self.settings.prefinal_ms
                and self.prefinal_seg != self.seg_id):
            self._enqueue_partial(force=True)
            return

        self._maybe_partial()

    def _trim_idle(self) -> None:
        keep = int(PREROLL_S * SAMPLE_RATE)
        if self.buf.size > keep:
            drop = self.buf.size - keep
            self.buf = self.buf[drop:]
            self.buf_start += drop

    def _open_segment(self) -> None:
        back = int((self.speech_run_ms / 1000.0 + PREROLL_S) * SAMPLE_RATE)
        self.seg_start_sample = max(self.buf_start, self.abs_samples - back)
        self._open_segment_at(self.seg_start_sample)

    def _open_segment_at(self, sample: int, notify: bool = True) -> None:
        """从指定的绝对采样位置开一段新句子。

        软切段时用 _open_segment_at(切点)，不能走 _open_segment ——
        连续说话时 speech_run_ms 很大，回补算法会把已经用过的音频又圈进来。

        notify=False 用于「软切段」：那是一个人还在连续说话，只是被硬切了一刀，
        旧字幕本来就该被新内容顶掉，不需要额外发「换人说话了」的信号
        （发了会让刚显示的字幕闪一下）。
        注意这里**不能**自增 seg_id —— _finalize 已经为下一段加过了。
        """
        self.seg_start_sample = max(0, min(int(sample), self.abs_samples))
        self.open_seg = True
        self.partial_text = ""
        self.partial_seg = -1
        self.partial_at = 0.0
        self.prefinal_seg = -1
        self.partials_this_seg = 0
        if notify:
            # 新句子开始 → 立刻通知客户端把上一句淡掉。
            # 此时还没有任何文字可发，但「有人开始说话了 / 换人说话了」这件事
            # 我们是**马上就知道**的 —— 这正是原生字幕「新 cue 一到旧 cue 就消失」的感觉。
            self._emit_speech_start()

    def _segment_size(self) -> int:
        return self.abs_samples - self.seg_start_sample

    def _segment_audio(self) -> np.ndarray:
        off = max(0, self.seg_start_sample - self.buf_start)
        return self.buf[off:]

    def _has_speech(self, audio: np.ndarray) -> bool:
        """这段音频里到底有没有人声 —— 只是个「别把纯静音送进解码器」的兜底检查。

        注意这里故意宽松：它**不是**分句依据，判错了代价却很大
        （会把本来能复用的「预终稿」拦掉，最终字幕就得多等一次完整解码）。
        所以除了 VAD 帧占比，再给一个绝对能量兜底，宁可多解一次也不漏。
        """
        if audio.size < FRAME_LEN:
            return False
        # 绝对能量兜底：只要不是近乎纯静音就放行
        rms = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
        if rms > self.vad.abs_floor * 4:
            return True
        if not self.settings.vad_enabled:
            return True
        flags = self.vad.speech_flags(audio, adapt=False)
        if flags.size == 0:
            return False
        return bool(flags.mean() >= 0.12)

    def _language_for_decode(self) -> Optional[str]:
        return self.locked_language or self.settings.language

    def _partial_interval(self) -> float:
        """自适应节流：中间字幕的间隔不能小于「上次解码耗时 × 系数」。

        Whisper 一次解码的耗时基本恒定，所以真正的约束是「多久解一次」。
        用实测耗时反推间隔，小模型跟得紧，大模型自动放慢，永远不会把队列拖垮。
        """
        return max(self.settings.partial_interval_s,
                   self.last_decode_seconds * self.settings.adaptive_interval_factor)

    def _maybe_partial(self) -> None:
        seg_s = self._segment_size() / SAMPLE_RATE
        if seg_s < max(self.settings.partial_min_audio_s, self.settings.partial_min_seg_s):
            return
        # ★ 每句话允许多少次中间解码，按「解码预算」算，而且**允许为 0**。
        #   解码器只有一个线程：中间解码一旦在跑，「预终稿」就得排队等它跑完，
        #   最终字幕反而被拖慢近两倍（实测 1.9s → 3.4s）。
        #   短句干脆一次都不做 —— 真实字幕本来就是一整行出现的；
        #   长句才做中间解码，保证有 BGM、迟迟等不到静音时字幕不会长时间不动。
        cost = max(0.08, self.last_decode_seconds or self.settings.fast_decode_s)
        allowed = int(seg_s * self.settings.partial_budget_ratio / cost)
        if self.partials_this_seg >= allowed:
            return
        now = time.monotonic()
        if self.partial_at and now - self.partial_at < self._partial_interval():
            return
        self._enqueue_partial(force=False)

    def _enqueue_partial(self, *, force: bool) -> None:
        """排一个中间字幕解码任务。

        force=True 是「预终稿」：进入静音后抢着解一次，覆盖范围已经越过说话结束点，
        静音一旦确认就能直接升格成最终字幕，把解码时间和静音等待重叠掉。
        """
        size = self._segment_size()
        if size < int(self.settings.partial_min_audio_s * SAMPLE_RATE):
            return
        with self._cv:
            # 同一个句子里已经有任务在排/在跑，就不要再塞了 ——
            # 中间结果本来就是「后来的顶掉先来的」，多塞只会白占解码线程，
            # 反而把随后到来的最终字幕堵在后面。
            busy = self._pending_partial is not None or (
                self._inflight is not None
                and self._inflight["seg_id"] == self.seg_id
                and self._inflight["kind"] != "final")
        if busy and not force:
            return

        audio = self._segment_audio()
        if not self._has_speech(audio):
            return
        now = time.monotonic()
        self.partial_at = now
        self.partial_enqueued_at = now
        if not force:
            self.partials_this_seg += 1
        seg_id = self.seg_id
        job = {
            "kind": "partial",
            "seg_id": seg_id,
            "audio": audio.copy(),          # 必须拷贝：缓冲区之后会被裁剪
            "beam": 1,
            "t0": self.seg_start_sample,
            "t1": self.abs_samples,
            "prefinal": bool(force),
        }
        with self._cv:
            self._pending_partial = job
            self._cv.notify_all()
        if force:
            self.prefinal_seg = seg_id

    # -- 分句 / 最终字幕 ----------------------------------------------------
    def _finalize(self, *, cut: bool) -> None:
        seg_id = self.seg_id
        end_sample = self.abs_samples
        if not cut:
            end_sample = max(self.seg_start_sample,
                             self.abs_samples - int(self.silence_run_ms * SAMPLE_RATE / 1000))
        t0 = self.seg_start_sample
        size = self._segment_size()

        self.seg_id += 1
        self.open_seg = False
        self.speech_run_ms = 0

        if size < int(self.settings.min_audio_s * SAMPLE_RATE):
            self._trim_idle()
            return

        if TIMING and self.started_at:
            wall = time.monotonic() - self.started_at
            print(f"[timing {_ts()}] FINALIZE seg={seg_id} 句尾={end_sample/SAMPLE_RATE:7.2f}s "
                  f"墙上={wall:7.2f}s 音频位置={self.abs_samples/SAMPLE_RATE:7.2f}s "
                  f"→ 音频滞后={wall - self.abs_samples/SAMPLE_RATE:5.2f}s", flush=True)

        # ---- 能不能直接复用已经解出来的中间结果？----
        # 中间解码和最终解码用的是同一段音频、同样的 beam_size，结果几乎一样。
        # 判断「够不够完整」只认一件事：它的音频**覆盖到了说话结束点**。
        # 少了这个检查就会把句子尾巴切掉。
        reusable = (
            self.partial_text
            and self.partial_seg == seg_id
            and self.partial_covered >= end_sample
            and (time.monotonic() - self.partial_at) < self.settings.promote_max_age_s
        )
        if reusable:
            self.promoted += 1
            if TIMING:
                print(f"[timing {_ts()}] PROMOTE 复用中间结果 seg={seg_id} "
                      f"覆盖={self.partial_covered/SAMPLE_RATE:.2f}s ≥ 句尾={end_sample/SAMPLE_RATE:.2f}s", flush=True)
            self._emit_final(self.partial_text, seg_id, t0, end_sample)
            self._trim_idle()
            return

        # ---- 排队中 / 正在跑的中间任务，能不能就地改成最终任务？----
        # 同样必须确认它覆盖到了说话结束点，否则宁可多解一次也不能缺字。
        with self._cv:
            job = self._pending_partial
            if job is not None and job["seg_id"] == seg_id and job["t1"] >= end_sample:
                self._pending_partial = None
                job["kind"] = "final"
                job["t1"] = end_sample
                self._pending_finals.append(job)
                self._cv.notify_all()
                self.promoted += 1
                self._trim_idle()
                return
            inflight = self._inflight
            if (inflight is not None and inflight["seg_id"] == seg_id
                    and inflight["kind"] != "final" and inflight["t1"] >= end_sample):
                # 正在解这一句，且音频已经覆盖到句尾 → 让它直接以最终字幕收尾
                inflight["kind"] = "final"
                inflight["t1"] = end_sample
                self.promoted += 1
                if TIMING:
                    print(f"[timing {_ts()}] PROMOTE 在跑的中间解码直接收尾 seg={seg_id}", flush=True)
                self._trim_idle()
                return
            if TIMING and inflight is not None and inflight["seg_id"] == seg_id:
                print(f"[timing {_ts()}] !! 无法升格 seg={seg_id}："
                      f"覆盖={inflight['t1']/SAMPLE_RATE:.2f}s < 句尾={end_sample/SAMPLE_RATE:.2f}s"
                      f" → 只能再解一次", flush=True)
            self._pending_finals.append({
                "kind": "final",
                "seg_id": seg_id,
                "audio": self._segment_audio().copy(),
                "beam": 1,
                "t0": t0,
                "t1": end_sample,
            })
            self._cv.notify_all()
        self._trim_idle()

    # -- 解码线程 -----------------------------------------------------------
    def _decode_loop(self) -> None:
        while True:
            with self._cv:
                while (not self._closed and self._pending_partial is None
                       and not self._pending_finals and self._inflight is None):
                    self._cv.wait(timeout=0.25)
                if self._closed:
                    return
                if self._pending_finals:
                    job = self._pending_finals.popleft()
                elif self._pending_partial is not None:
                    job = self._pending_partial
                    self._pending_partial = None
                else:
                    job = None
                self._inflight = job
                self._decoder_busy = job is not None
                inflight = job is not None
            if TIMING and inflight:
                print(f"[timing {_ts()}] JOB  start {job['kind']:7s} seg={job['seg_id']} "
                      f"audio={job['audio'].size/SAMPLE_RATE:5.2f}s "
                      f"音频位置={job['t1']/SAMPLE_RATE:7.2f}s", flush=True)

            if job is None:
                continue
            t_job = time.time()
            try:
                self._run_job(job)
            except Exception as exc:  # noqa: BLE001
                print(f"[asr] 解码任务出错：{exc}", flush=True)
            finally:
                if TIMING:
                    print(f"[timing {_ts()}] JOB  done  {job['kind']:7s} seg={job['seg_id']} "
                          f"耗时={time.time()-t_job:.2f}s", flush=True)
                with self._cv:
                    self._inflight = None
                    self._decoder_busy = False
                    self._cv.notify_all()

    def _run_job(self, job: dict) -> None:
        text, info = self._decode(job["audio"], beam_size=job["beam"])
        self._update_language(info, job["audio"].size)
        text = (text or "").strip()

        if job["kind"] == "final":
            text = self._guard(text)
            if text:
                self._emit_final(text, job["seg_id"], job["t0"], job["t1"])
            return

        # 中间字幕：句子已经翻篇了就丢掉，别去覆盖新句子
        if not self.open_seg or job["seg_id"] != self.seg_id:
            self.dropped += 1
            return
        text = self._guard(text)
        if not text or text == self.partial_text or text == self.last_final_text:
            return
        self.partial_text = text
        self.partial_seg = job["seg_id"]
        self.partial_covered = job["t1"]
        self.partial_at = time.monotonic()
        self._events.append(self._line(final=False, source=text,
                                       t0=job["t0"] / SAMPLE_RATE, t1=job["t1"] / SAMPLE_RATE))

    def _emit_final(self, text: str, seg_id: int, t0: int, end_sample: int) -> None:
        if TIMING and self.started_at:
            wall = time.monotonic() - self.started_at
            print(f"[timing {_ts()}] EMIT final seg={seg_id} "
                  f"句尾={end_sample/SAMPLE_RATE:7.2f}s 墙上={wall:7.2f}s "
                  f"→ 延迟={wall - end_sample/SAMPLE_RATE:5.2f}s | {text[:40]}", flush=True)
        if not text or text == self.last_final_text:
            return
        self.last_final_text = text
        self.context_prompt = (self.context_prompt + " " + text).strip()[-220:]
        self.partial_text = ""
        self._events.append(self._line(final=True, source=text,
                                       t0=t0 / SAMPLE_RATE, t1=end_sample / SAMPLE_RATE,
                                       seg_id=seg_id))
        if self._on_event is not None:
            try:
                self._on_event(self._events[-1])
            except Exception:  # noqa: BLE001
                pass

    # -- 解码（在解码线程里跑）----------------------------------------------
    def _decode(self, audio: np.ndarray, beam_size: int) -> tuple[str, Any]:
        self._maybe_detect_language(audio)
        t0 = time.time()
        try:
            text, info = self.engine.transcribe(
                audio,
                language=self._language_for_decode(),
                initial_prompt=self.context_prompt or None,
                beam_size=beam_size,
            )
        finally:
            cost = time.time() - t0
            self.infer_seconds_total += cost
            self.audio_seconds_total += audio.size / SAMPLE_RATE
            self.last_decode_seconds = cost
            self.decodes += 1
        return normalize_text(text), info

    def _maybe_detect_language(self, audio: np.ndarray) -> None:
        """第一段够长的语音到达时，做一次（且只做一次）语言检测。

        检测到之后所有解码都显式传语言，单次开销直接减半。
        """
        if self._lang_probe_done or self.locked_language:
            return
        if audio.size < int(self.settings.lang_probe_s * SAMPLE_RATE):
            return
        self._lang_probe_done = True
        try:
            lang, prob = self.engine.detect_language(audio)
        except Exception as exc:  # noqa: BLE001
            print(f"[asr] 语言检测失败，先按自动处理：{exc}", flush=True)
            return
        if lang and prob >= self.settings.lang_probe_min_prob:
            self.locked_language = lang
            print(f"[asr] 语言检测：{lang}（置信度 {prob:.2f}），后续解码锁定该语言", flush=True)
        else:
            print(f"[asr] 语言检测不确定（{lang} {prob:.2f}），继续自动判断", flush=True)

    def _update_language(self, info: Any, samples: int) -> None:
        """兜底：语言检测那一步没定下来时，从解码结果里补一次判断。"""
        if self.locked_language or info is None or not self._lang_probe_done:
            return
        lang = getattr(info, "language", None)
        prob = float(getattr(info, "language_probability", 0.0) or 0.0)
        if lang and samples >= int(2.0 * SAMPLE_RATE) and prob >= 0.80:
            self.locked_language = lang
            print(f"[asr] 从解码结果锁定语言 {lang} (prob={prob:.2f})", flush=True)

    def _guard(self, text: str) -> str:
        """幻觉过滤 + 与上一最终结果去重。"""
        if is_noise(text):
            return ""
        if text == self.last_final_text:
            return ""
        # Whisper 有时会把 initial_prompt 原样吐回来
        if self.context_prompt and text and text in self.context_prompt:
            return ""
        return text

    def _line(self, *, final: bool, source: str, t0: float, t1: float, seg_id: Optional[int] = None) -> dict:
        return {
            "type": "line",
            "id": self.seg_id if seg_id is None else seg_id,
            "final": final,
            "source": source,
            "translated": None,
            "lang": self.locked_language,
            "t0": round(t0, 2),
            "t1": round(t1, 2),
        }

    def _emit_speech_start(self) -> None:
        """「有人开始说新一句了」—— 一个不带文字的轻量信号。

        为什么需要它：
          识别天生有半秒到一秒的延迟。等新字幕出来时，说话的人往往已经换了一个，
          于是上一句的字幕还挂在画面上，看起来像是「下一个人在说的内容」。
          原生字幕不会这样，是因为它有精确时间轴，新 cue 一到旧 cue 立刻消失。
          我们没有时间轴，但「VAD 刚开了一段新语音」这个时刻我们是**立刻就知道**的，
          把这个信号发出去，客户端就能马上把旧字幕淡掉 —— 观感立刻同步。
        """
        self._events.append({
            "type": "speech",
            "state": "start",
            "id": self.seg_id,
            "t": round(self.abs_samples / SAMPLE_RATE, 2),
        })


__all__ = [
    "EnergyVAD",
    "StreamSession",
    "WhisperEngine",
    "is_noise",
    "normalize_text",
    "SAMPLE_RATE",
]
