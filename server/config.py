"""
全局配置：默认值 <- config.json <- 环境变量，优先级依次升高。

环境变量都以 VST_ 开头。
"""

from __future__ import annotations

import json
import os
import socket
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

SERVER_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SERVER_DIR / "config.json"
MODELS_DIR = SERVER_DIR / "models"

# ---------------------------------------------------------------------------
# 可选的识别模型（faster-whisper 的模型名）
#   tiny  ~40MB 最快，准确率一般
#   base  ~75MB 速度快，够用
#   small ~250MB 推荐：速度与准确率平衡，多语言能力好
#   medium~750MB 更准，CPU 基本跟不上实时
#   large-v3 ~1.5GB 最准，建议有 N 卡再用
# ---------------------------------------------------------------------------
MODEL_CHOICES = ["auto", "tiny", "base", "small", "medium", "large-v3-turbo", "large-v3", "distil-large-v3"]

# 「auto」按设备选模型。
# 为什么需要 auto：显卡上一次解码只要 300ms 左右，而「等静音」固定要 400ms ——
# 也就是说模型再大一点**总延迟完全不变**，等于准确率白拿。
# 但没显卡时大模型会慢到没法看，所以必须分开：
#   显卡 → large-v3-turbo（比 medium 还快，却更强）
#   CPU  → small（CPU 上 medium 一次要 3 秒以上，直接废掉）
AUTO_MODEL_CUDA = "large-v3-turbo"
AUTO_MODEL_CPU = "small"

# 目标语言（扩展端下拉框与此保持一致）
TARGET_LANGUAGES = {
    "zh": "中文（简体）",
    "zh-TW": "中文（繁体）",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
    "ru": "Русский",
    "fr": "Français",
    "de": "Deutsch",
    "es": "Español",
    "pt": "Português",
    "it": "Italiano",
    "ar": "العربية",
    "th": "ไทย",
    "vi": "Tiếng Việt",
}

TRANSLATOR_CHOICES = [
    "auto",       # 所有可用服务一起竞速，谁先返回用谁，并记住赢家
    "bing",       # 微软 Edge 翻译免费接口（无需 Key）
    "google",     # Google 翻译免费接口（国内需自备网络环境）
    "youdao",     # 有道免费接口（无需 Key，国内直连）
    "tencent",    # 腾讯交互翻译免费接口（无需 Key，国内直连）
    "mymemory",   # MyMemory 免费接口（无需 Key，有每日额度）
    "deepl",      # 需要 API Key
    "openai",     # 任意 OpenAI 兼容接口（DeepSeek / 通义 / 硅基流动 / Ollama ...）
    "none",       # 不翻译，只显示识别原文
]


def _env_str(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v == "" else v


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on", "y")


@dataclass
class Settings:
    # ---- 服务 ----
    host: str = "127.0.0.1"
    port: int = 8765

    # ---- 识别 ----
    # auto = 按设备自动选（显卡用 large-v3-turbo，CPU 用 small），见 AUTO_MODEL_*
    model: str = "auto"
    device: str = "auto"            # auto / cpu / cuda
    compute_type: str = "auto"      # auto / int8 / int8_float16 / float16 / float32
    cpu_threads: int = 0            # 0 = 自动（物理核心数的一半）
    beam_size: int = 1              # 1 = 贪心，最快；3~5 更准但更慢
    language: Optional[str] = None  # None = 自动检测
    # 单次送入 Whisper 的最长音频（秒），超长会强制切段
    max_window_s: float = 25.0
    # 「软切段」：一句话超过这个秒数还没等到静音，就主动切一刀。
    # 为什么必须有：视频里有持续 BGM / 环境音时，能量 VAD 永远检测不到静音，
    # 句子就一直不结束 —— 实测 21 秒的音频只出 1 条字幕，用户感觉就是「半天不出翻译」。
    # 切在句子中间最多影响一个词，比整段卡死好得多。
    # 配合「按解码预算放行中间字幕」，长段也会每隔几秒更新一次。
    soft_cut_s: float = 6.5
    # 两次「中间字幕」之间的最小间隔（秒）。
    # 实际间隔会按上次解码耗时自适应放大，见 adaptive_interval_factor。
    # 这个下限要设得小：上了显卡之后一次解码只要几十毫秒，
    # 间隔被固定在 1.5 秒的话字幕就白白「一顿一顿」了。
    # CPU 上不会因此变密 —— 自适应系数会把间隔拉到 ~1.8 秒。
    partial_interval_s: float = 0.4
    # 自适应系数：实际间隔 >= 上次解码耗时 × 这个数
    adaptive_interval_factor: float = 1.5
    # 解码快于这个秒数就认为「解码器还宽裕」
    fast_decode_s: float = 0.6
    # 每句话允许多少次中间解码，按「解码预算」算而不是数次数：
    #   允许次数 ≈ 这句话时长 × budget / 上次解码耗时（**允许为 0**）
    # 为什么允许 0：解码器只有一个线程，中间解码一旦在跑，「预终稿」就得排队等它，
    # 最终字幕反而被拖慢两倍（实测 1.9s → 3.4s）。
    # 短句根本不需要中间字幕 —— 真实字幕本来就是一整行出现的，
    # 所以短句直接把全部解码预算留给最终字幕；长句（尤其有 BGM、迟迟等不到静音那种）
    # 才做中间解码，保证字幕不会长时间不更新。
    partial_budget_ratio: float = 0.35
    # 句子至少持续这么久才考虑做中间解码（秒）。
    # 放得比较小是因为真正的闸门是上面那条「解码预算」：
    # 显卡上解码几十毫秒，短句也能轻松放行；CPU 上解码一秒多，短句自然算出 0 次。
    partial_min_seg_s: float = 1.2
    # 送去做中间字幕的最短音频（秒）。太短不值得付那一次固定开销。
    partial_min_audio_s: float = 1.0
    # 判定一句话结束所需的静音时长（毫秒）。
    # 调小能更早出字幕，但太短会把一句话切碎。
    hangover_ms: int = 400
    # 一进入静音就抢先解一次「预终稿」的时机（毫秒）。
    # 它的音频覆盖已经越过说话结束点，静音一旦确认就能直接升格成最终字幕，
    # 相当于把「解码」和「等静音确认」重叠起来，省掉一次完整解码。
    # 设 0 可以关掉这个优化。
    prefinal_ms: int = 200
    # 第一段够长的语音就去探测语言（之后所有解码都显式传语言）。
    # 为什么尽早做：language=None 会让每次解码都要多跑一遍语言检测，
    # 单次开销直接翻倍（实测 1.17s → 2.27s）。越早锁定越划算。
    lang_probe_s: float = 1.2
    lang_probe_min_prob: float = 0.55
    # 复用中间结果时允许的「新鲜度」上限（秒），太旧的结果不敢用
    promote_max_age_s: float = 3.0
    # 能量 VAD
    vad_enabled: bool = True
    vad_abs_floor: float = 0.005   # 绝对静音阈值（归一化幅度）
    vad_rel: float = 2.5           # 需高出噪声底多少倍才算说话
    # 阈值上限。这个值**不能**为了「过滤背景音乐」而调高：
    # 调高之后正常语音的能量也掉到阈值以下，VAD 直接失明，
    # 「预终稿」被拦掉，最终字幕就要多等一次完整解码（实测 1.4s → 3.5s）。
    # 背景音乐那种「永远等不到静音」的情况，由 soft_cut_s 兜底，别在这里动刀。
    vad_max_thr: float = 0.030
    # 送进 Whisper 前最短的音频（秒），太短会瞎猜
    min_audio_s: float = 0.35

    # ---- 翻译 ----
    translator: str = "auto"
    target_lang: str = "zh"
    translate_partials: bool = True
    translate_timeout_s: float = 6.0
    deepl_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: str = "https://api.deepseek.com/v1"
    openai_model: str = "deepseek-flash"
    # 翻译不需要「思考模式」：DeepSeek 默认开着且 effort=high，
    # 实测延迟 1.3s → 3.2s，思维链还按输出 token 计费。默认关掉。
    # 除非你要翻译特别绕的文本，否则没有理由打开。
    openai_thinking: bool = False

    # ---- 杂项 ----
    preload: bool = False           # 启动时立刻加载模型
    log_level: str = "info"
    hf_endpoint: str = ""           # 留空则自动探测（国内自动切 hf-mirror.com）

    def to_dict(self) -> dict:
        return asdict(self)


def _load_file() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"[config] 读取 {CONFIG_FILE} 失败，忽略：{exc}")
        return {}


def load_settings() -> Settings:
    s = Settings()
    raw = _load_file()
    for key, value in raw.items():
        if hasattr(s, key) and value is not None:
            setattr(s, key, value)

    s.host = _env_str("VST_HOST", s.host)
    s.port = _env_int("VST_PORT", s.port)
    s.model = _env_str("VST_MODEL", s.model)
    s.device = _env_str("VST_DEVICE", s.device)
    s.compute_type = _env_str("VST_COMPUTE_TYPE", s.compute_type)
    s.cpu_threads = _env_int("VST_CPU_THREADS", s.cpu_threads)
    s.beam_size = _env_int("VST_BEAM_SIZE", s.beam_size)
    s.hangover_ms = _env_int("VST_HANGOVER_MS", s.hangover_ms)
    s.translator = _env_str("VST_TRANSLATOR", s.translator)
    s.target_lang = _env_str("VST_TARGET_LANG", s.target_lang)
    s.log_level = _env_str("VST_LOG_LEVEL", s.log_level)
    s.hf_endpoint = _env_str("VST_HF_ENDPOINT", s.hf_endpoint)
    s.preload = _env_bool("VST_PRELOAD", s.preload)
    s.vad_enabled = _env_bool("VST_VAD", s.vad_enabled)

    lang = os.environ.get("VST_LANGUAGE")
    if lang is not None:
        s.language = lang or None
    if isinstance(s.language, str) and s.language.strip().lower() in ("", "auto", "none", "null"):
        s.language = None

    s.deepl_api_key = _env_str("VST_DEEPL_API_KEY", s.deepl_api_key)
    s.openai_api_key = _env_str("VST_OPENAI_API_KEY", s.openai_api_key)
    s.openai_base_url = _env_str("VST_OPENAI_BASE_URL", s.openai_base_url)
    s.openai_model = _env_str("VST_OPENAI_MODEL", s.openai_model)
    return s


# ---------------------------------------------------------------------------
# HuggingFace 下载端点：国内 huggingface.co 不通，自动改用 hf-mirror.com。
# 必须在 import huggingface_hub / faster_whisper 之前调用。
# ---------------------------------------------------------------------------
_hf_endpoint_resolved: Optional[str] = None


def _probe_endpoint(url: str, timeout: float = 6.0) -> bool:
    """用真正的 HTTPS 请求探测一个源通不通。

    ★ 这里**不能**用裸 TCP 连接来判断。
    开着代理（比如 v2rayN 的系统代理）时，裸 socket 连接不走代理，
    会把「其实完全能通、而且比镜像快一倍」的官方站判成不可达，
    于是错误地退回慢镜像 —— 实测就是这样把下载拖成龟速的。
    urllib 会自动读系统代理设置（Windows 上读注册表），才符合真实下载路径。
    """
    import urllib.request

    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            return int(getattr(resp, "status", 200)) < 500
    except Exception:  # noqa: BLE001
        return False


def ensure_hf_endpoint(explicit: str = "") -> str:
    global _hf_endpoint_resolved
    if _hf_endpoint_resolved:
        return _hf_endpoint_resolved

    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    # hf-mirror 不支持 Xet 加速协议，关掉更稳
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    # ★ 把 HuggingFace 的家目录也钉在项目里。
    #   模型本体走 download_root 参数，但 huggingface_hub 还会往 HF_HOME
    #   写日志、锁文件、临时下载文件 —— 默认位置是 C:\Users\<你>\.cache\huggingface。
    #   实测那个目录会写失败（os error 5 拒绝访问），下载直接中断；
    #   顺便也避免了往系统盘堆东西。
    if not os.environ.get("HF_HOME"):
        hf_home = MODELS_DIR.parent / ".hf"
        try:
            hf_home.mkdir(parents=True, exist_ok=True)
            os.environ["HF_HOME"] = str(hf_home)
            os.environ["HF_HUB_CACHE"] = str(hf_home / "hub")
            os.environ.setdefault("XDG_CACHE_HOME", str(hf_home / "xdg"))
        except OSError as exc:  # 实在写不了就退回默认位置，别因为缓存路径把服务搞挂
            print(f"[config] 无法把 HuggingFace 缓存放到项目目录（{exc}），沿用默认位置")

    endpoint = explicit or os.environ.get("HF_ENDPOINT") or ""
    if not endpoint:
        # 优先官方站：实测开着代理时它比 hf-mirror 快一倍（1.04 vs 0.50 MB/s）。
        # 官方站不通（没代理的国内直连）才退到镜像。
        if _probe_endpoint("https://huggingface.co"):
            endpoint = "https://huggingface.co"
            print("[config] HuggingFace 官方站可达（走系统代理），直接使用官方源")
        elif _probe_endpoint("https://hf-mirror.com"):
            endpoint = "https://hf-mirror.com"
            print("[config] 官方站不可达，自动切换镜像 https://hf-mirror.com")
        else:
            endpoint = "https://hf-mirror.com"
            print("[config] 两个源都探测失败，仍尝试镜像 https://hf-mirror.com")

    os.environ["HF_ENDPOINT"] = endpoint
    _hf_endpoint_resolved = endpoint
    return endpoint
