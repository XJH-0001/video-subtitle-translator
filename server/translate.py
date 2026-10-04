"""
翻译层：多服务商链式回退。

为什么做成一串而不是单一服务：
  * 免费接口都有各自的毛病（被墙 / 限流 / 偶尔抽风），
    串起来用才可能做到「打开就能用」。
  * 想用更好的质量（DeepL / DeepSeek / 通义）随时可以在设置里填 Key 切换。

默认顺序（auto）：bing → google → mymemory
任何一个失败会自动冷却并切下一个，成功一次就继续用它。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections import OrderedDict
from typing import Any, Optional

import httpx

from config import Settings

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
)

# Whisper 用的是 ISO-639-1，各翻译服务对「中文」的叫法不一样
_TO_BING = {"zh": "zh-Hans", "zh-TW": "zh-Hant", "zh-HK": "zh-Hant", "he": "he", "no": "nb"}
_TO_GOOGLE = {"zh": "zh-CN", "zh-TW": "zh-TW"}
_TO_MYMEMORY = {"zh": "zh-CN", "zh-TW": "zh-TW"}
_TO_DEEPL = {"zh": "ZH-HANS", "zh-TW": "ZH-HANT", "en": "EN-US", "pt": "PT-BR"}
_TO_YOUDAO = {"zh": "zh-CHS", "zh-TW": "zh-CHT"}
_TO_TENCENT = {"zh": "zh", "zh-TW": "zh-TW"}

AUTO_ORDER = ["bing", "google", "youdao", "tencent", "mymemory"]
ALL_PROVIDERS = ["bing", "google", "youdao", "tencent", "mymemory", "deepl", "openai", "none"]

# 被限流时冷却短一点（让别的服务商顶上来，很快还能再试），
# 真正的硬故障（404、连不上）才长冷却。
COOLDOWN_RATE_LIMITED = 12.0
COOLDOWN_HARD = 180.0
# 同一个服务商两次请求之间的最小间隔，避免把免费接口打爆。
# ★ 付费接口（DeepSeek / DeepL）不适用：它们本来就有高并发额度，
#   再卡 0.35 秒纯粹是给自己加延迟 —— 实测翻译要连发（中间字幕 + 最终字幕）时，
#   每一条都要多等 0.35 秒。所以按服务商分别设。
MIN_REQUEST_INTERVAL = 0.35
# 付费接口的最小间隔（0 = 不限速）
PAID_REQUEST_INTERVAL = 0.0
PAID_PROVIDERS = {"openai", "deepl"}
CACHE_MAX = 800


def _map(code: Optional[str], table: dict[str, str], default: str = "auto") -> str:
    if not code:
        return default
    c = code.strip()
    if c.lower() in ("auto", "none", "null", ""):
        return default
    return table.get(c, c)


def _split_chunks(text: str, limit: int) -> list[str]:
    """按句子边界把长文本切块（免费接口普遍有单次长度限制）。"""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    cur = ""
    for piece in re.split(r"(?<=[\.\!\?\u3002\uff01\uff1f;\uff1b\n])\s*", text):
        if not piece:
            continue
        if len(cur) + len(piece) <= limit:
            cur += piece
        else:
            if cur:
                parts.append(cur)
            while len(piece) > limit:
                parts.append(piece[:limit])
                piece = piece[limit:]
            cur = piece
    if cur:
        parts.append(cur)
    return parts or [text[:limit]]


class ProviderError(RuntimeError):
    pass


class RateLimited(ProviderError):
    """被限流了 —— 冷却时间要短，好让别的服务商顶上来。"""
    pass


RETRY_STATUS = (429, 500, 502, 503, 504)


def cooldown_for(exc: Exception) -> float:
    return COOLDOWN_RATE_LIMITED if isinstance(exc, RateLimited) else COOLDOWN_HARD


async def _get(client: httpx.AsyncClient, url: str, *, params=None, headers=None,
               timeout: float = 10.0, retries: int = 2) -> httpx.Response:
    """带退避重试的 GET —— 免费接口 429 基本是常态，重试一两次往往就过了。"""
    resp = None
    for attempt in range(retries + 1):
        resp = await client.get(url, params=params, headers=headers, timeout=timeout)
        if resp.status_code in RETRY_STATUS and attempt < retries:
            await asyncio.sleep(0.5 * (attempt + 1) + 0.15 * attempt)
            continue
        return resp
    return resp


# ---------------------------------------------------------------------------
# 各家实现
# ---------------------------------------------------------------------------
class BingProvider:
    """微软 Edge 浏览器「翻译」功能用的免费接口，无需 Key，国内可直连。"""

    name = "bing"
    _token = ""
    _token_at = 0.0

    async def _auth(self, client: httpx.AsyncClient) -> str:
        now = time.time()
        if self._token and now - self._token_at < 8 * 60:
            return self._token
        r = await client.get(
            "https://edge.microsoft.com/translate/auth",
            headers={"User-Agent": UA},
            timeout=8.0,
        )
        if r.status_code != 200 or len(r.text) < 40:
            raise ProviderError(f"bing auth HTTP {r.status_code}")
        BingProvider._token = r.text.strip()
        BingProvider._token_at = now
        return BingProvider._token

    async def translate(self, client: httpx.AsyncClient, text: str, src: Optional[str], tgt: str) -> str:
        token = await self._auth(client)
        params = {
            "api-version": "3.0",
            "to": _map(tgt, _TO_BING, "zh-Hans"),
            "includeSentenceLength": "true",
        }
        if src:
            params["from"] = _map(src, _TO_BING)
        r = await client.post(
            "https://api-edge.cognitive.microsofttranslator.com/translate",
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": UA,
            },
            json=[{"Text": text}],
            timeout=10.0,
        )
        if r.status_code == 401:
            BingProvider._token = ""
            raise ProviderError("bing token 失效")
        if r.status_code != 200:
            raise ProviderError(f"bing HTTP {r.status_code}: {r.text[:120]}")
        data = r.json()
        out = "".join(t.get("text", "") for item in data for t in item.get("translations", []))
        if not out:
            raise ProviderError("bing 返回空结果")
        return out


class GoogleProvider:
    """translate.googleapis.com 的免费 gtx 接口。国内需要自备网络环境。"""

    name = "google"

    async def translate(self, client: httpx.AsyncClient, text: str, src: Optional[str], tgt: str) -> str:
        out: list[str] = []
        for chunk in _split_chunks(text, 4500):
            r = await _get(
                client,
                "https://translate.googleapis.com/translate_a/single",
                params={
                    "client": "gtx",
                    "sl": _map(src, {}, "auto"),
                    "tl": _map(tgt, _TO_GOOGLE, "zh-CN"),
                    "dt": "t",
                    "q": chunk,
                },
                headers={"User-Agent": UA},
                timeout=8.0,
            )
            if r.status_code != 200:
                raise ProviderError(f"google HTTP {r.status_code}")
            data = r.json()
            out.append("".join(seg[0] for seg in data[0] if seg and seg[0]))
        result = "".join(out)
        if not result:
            raise ProviderError("google 返回空结果")
        return result


class YoudaoProvider:
    """有道「智云」演示接口，无需 Key，国内直连很快，中英互译质量不错。

    网上流传的老接口 fanyi.youdao.com/translate 已经只会返回网页了，
    现在还能用的是 aidemo.youdao.com/trans。
    """

    name = "youdao"

    async def translate(self, client: httpx.AsyncClient, text: str, src: Optional[str], tgt: str) -> str:
        params = {
            "q": text,
            "from": _map(src, _TO_YOUDAO, "auto") if src else "auto",
            "to": _map(tgt, _TO_YOUDAO, "zh-CHS"),
        }
        r = await _get(
            client,
            "https://aidemo.youdao.com/trans",
            params=params,
            headers={"User-Agent": UA, "Referer": "https://ai.youdao.com/"},
            timeout=8.0,
            retries=1,
        )
        if r.status_code != 200:
            raise ProviderError(f"youdao HTTP {r.status_code}")
        data = r.json()
        code = str(data.get("errorCode"))
        if code in ("411", "401", "429"):
            # 411 = 访问频率受限
            raise RateLimited(f"youdao 被限流 errorCode={code}")
        if code not in ("0", "None"):
            raise ProviderError(f"youdao errorCode={code}")
        parts = data.get("translation") or []
        out = "".join(str(p) for p in parts).strip()
        if not out:
            raise ProviderError("youdao 返回空结果")
        return out


class TencentProvider:
    """腾讯交互翻译（transmart）的网页接口，无需 Key，国内直连快。"""

    name = "tencent"

    async def translate(self, client: httpx.AsyncClient, text: str, src: Optional[str], tgt: str) -> str:
        body = {
            "header": {"fn": "auto_translation", "client_key": "browser-chrome-110.0.0", "user": ""},
            "type": "plain",
            "model_category": "normal",
            "text_domain": "",
            "source": {"lang": _map(src, _TO_TENCENT, "auto") if src else "auto", "text_list": [text]},
            "target": {"lang": _map(tgt, _TO_TENCENT, "zh")},
        }
        r = await client.post(
            "https://transmart.qq.com/api/imt",
            headers={
                "Content-Type": "application/json",
                "User-Agent": UA,
                "Referer": "https://transmart.qq.com/zh-CN/index",
            },
            json=body,
            timeout=8.0,
        )
        if r.status_code == 429:
            raise RateLimited("tencent HTTP 429")
        if r.status_code != 200:
            raise ProviderError(f"tencent HTTP {r.status_code}")
        data = r.json()
        code = str((data.get("header") or {}).get("ret_code", ""))
        if code and code != "succ":
            if "limit" in code.lower() or "freq" in code.lower():
                raise RateLimited(f"tencent ret_code={code}")
            raise ProviderError(f"tencent ret_code={code}")
        parts = data.get("auto_translation") or []
        out = "".join(str(p) for p in parts).strip()
        if not out:
            raise ProviderError("tencent 返回空结果")
        return out


class MyMemoryProvider:
    """MyMemory 免费接口，无需 Key；匿名有每日字数额度。"""

    name = "mymemory"

    async def translate(self, client: httpx.AsyncClient, text: str, src: Optional[str], tgt: str) -> str:
        # MyMemory 不支持自动检测，源语言未知时退回英文最常见
        s = _map(src, _TO_MYMEMORY, "en") if src else "en"
        t = _map(tgt, _TO_MYMEMORY, "zh-CN")
        out: list[str] = []
        for chunk in _split_chunks(text, 480):
            r = await _get(
                client,
                "https://api.mymemory.translated.net/get",
                params={"q": chunk, "langpair": f"{s}|{t}"},
                headers={"User-Agent": UA},
                timeout=8.0,
            )
            if r.status_code != 200:
                raise RateLimited(f"mymemory HTTP {r.status_code}") if r.status_code == 429 else ProviderError(f"mymemory HTTP {r.status_code}")
            data = r.json()
            if int(data.get("responseStatus", 200)) >= 400:
                detail = str(data.get("responseDetails") or "")
                if "quota" in detail.lower() or "limit" in detail.lower():
                    raise RateLimited(f"mymemory: {detail}")
                raise ProviderError(f"mymemory: {detail}")
            piece = (data.get("responseData") or {}).get("translatedText") or ""
            if not piece:
                raise ProviderError("mymemory 返回空结果")
            out.append(piece)
        return "".join(out)


class DeepLProvider:
    name = "deepl"

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.host = "https://api-free.deepl.com" if api_key.endswith(":fx") else "https://api.deepl.com"

    async def translate(self, client: httpx.AsyncClient, text: str, src: Optional[str], tgt: str) -> str:
        payload = {
            "text": text,
            "target_lang": _map(tgt, _TO_DEEPL, "ZH-HANS"),
        }
        if src:
            payload["source_lang"] = _map(src, _TO_DEEPL).split("-")[0].upper()
        r = await client.post(
            f"{self.host}/v2/translate",
            headers={"Authorization": f"DeepL-Auth-Key {self.api_key}"},
            data=payload,
            timeout=10.0,
        )
        if r.status_code != 200:
            raise ProviderError(f"deepl HTTP {r.status_code}: {r.text[:120]}")
        data = r.json()
        return "".join(t["text"] for t in data.get("translations", []))


SYSTEM_PROMPT = (
    "You are a professional subtitle translator. Translate the user's text into {target}. "
    "Output ONLY the translation, no explanations, no quotes, no pinyin. "
    "Keep it natural and concise, suitable for on-screen subtitles. "
    "Preserve names, numbers and technical terms. If the text is already in {target}, "
    "output it unchanged. "
    "The text may be a fragment of a longer sentence cut off mid-way; translate what is there, "
    "do not invent an ending. "
    "**If previous context is provided, you MUST use it to resolve pronouns and references.** "
    "For example if the context mentions a car and the text says \"she loves it\", "
    "translate \"it\" as the car, not as the generic word for \"it\". "
    "Make the sentence read naturally on its own, but never contradict the context."
)

CONTEXT_HEADER = (
    "接下来是同一段视频里紧接着的前几句原文（按时间顺序）。"
    "**只用来帮你理解上下文**，特别是代词和指代到底指向什么；不要翻译它们："
)
CONTEXT_ACK = "明白，我会结合上文把代词和指代翻准，只翻译最后一句。"


# ---------------------------------------------------------------------------
# 语气词 / 填充词：不值得翻译，原样显示就行
# ---------------------------------------------------------------------------
# 为什么单独判这个：
#   视频里「啊」「呀」「嗯」「哈哈」这类语气词非常频繁，而且会被反复识别到。
#   每条都发去翻译有两个坏处：一是白花钱，二是占住请求锁，
#   把真正需要翻译的句子挤到后面。而这些词翻出来和原文基本一样，翻不翻没区别。
#
# 判定故意保守：**只有整句话全部由语气词组成**才算（而不是「包含」）。
# 像「啊，原来是这样」这种有实义的句子不会被误判。
_FILLER_CHARS = set(
    "啊呀哦嗯呃唉哎喔噢呜嘿哈嘻咦嘛吧呢呐哟欸诶嗨呼嘶啧呵哼哪啦哇呗咯喽嘞嗷啾"
)
_EN_FILLERS = {
    "uh", "um", "umm", "uhh", "oh", "ooh", "ah", "ahh", "hmm", "hm", "mm", "mhm",
    "er", "erm", "eh", "hey", "hi", "wow", "huh", "ha", "haha", "hah", "hehe",
    "yep", "nope", "yo", "oops", "shh", "tsk", "phew", "ugh", "meh", "duh",
    "hooray", "yay", "gah",
}
# 语气词重复几次也还是语气词。
# ★ 这里限制的是「**不同**字符的个数」，不是总长度。
#   「啊，啊，啊，啊……」重复三十遍仍然是语气词；用总长度限制会把它漏掉，
#   结果就是一长串「啊，啊，啊…」原样显示、折行铺满整个画面（实测踩到的 bug）。
#   为什么会有这种输入：Whisper 在长静音/音乐上会陷进循环吐语气词，
#   而重复之间夹着标点时，asr 里那两条「相邻重复」「周期重复」的折叠规则都匹配不上。
_FILLER_MAX_UNIQUE = 4
# 判定前先扒掉的标点和空白
_FILLER_STRIP = "。，、！？…~～!?.,;:· 　\t\"'“”‘’()（）[]【】—－-"


def _filler_core(text: str) -> str:
    """去掉标点和空白，只留实义字符。"""
    return "".join(c for c in (text or "") if c not in _FILLER_STRIP)


def _strip_periodic(s: str) -> str:
    """整段是某个短片的整数倍重复时，只留一份。

    「hahaha」→「ha」、「yoyoyo」→「yo」。
    英文笑声/感叹常写成这样，不折叠的话一个词都认不出来。
    """
    n = len(s)
    for p in range(1, n // 2 + 1):
        if n % p == 0 and s == s[:p] * (n // p):
            return s[:p]
    return s


def _en_filler_word(w: str) -> bool:
    """英文单词是不是填充词。

    要处理三种写法，光查表覆盖不到：
      · 原词就在表里                 hehe
      · 尾部字母拖长                 ummmm → umm、uhhhh → uhh
      · 整个词是某个填充词的重复      hahaha → ha×3、hehehe → hehe+he
    """
    if w in _EN_FILLERS:
        return True
    # 连续重复的字母压到 2 个，以及压到 1 个，两种都试：
    # ummmm → umm（表里有）；ohhh → ohh（表里没有），但压成 oh 就对了
    w2 = re.sub(r"([A-Za-z])\1+", r"\1\1", w)
    w3 = re.sub(r"([A-Za-z])\1+", r"\1", w)
    if w2 in _EN_FILLERS or w3 in _EN_FILLERS:
        return True
    # 词首就是某个填充词，剩下的还是它的重复（允许末尾残缺）
    for f in _EN_FILLERS:
        if len(f) < 2 or not w2.startswith(f):
            continue
        rest = w2[len(f):]
        if not rest:
            return True
        if rest == (f * ((len(rest) // len(f)) + 1))[:len(rest)]:
            return True
    return False


def is_filler(text: str) -> bool:
    """整句话是不是单纯语气词 / 笑声 —— 是的话没有翻译的必要，原样显示即可。

    判定看的是「**不同字符**是否都属于语气词」，而不是总长度。
    这样「啊，啊，啊，…」重复三十遍也能正确判为语气词。

    >>> is_filler("啊")
    True
    >>> is_filler("哈哈哈")
    True
    >>> is_filler("啊，啊，啊")        # 重复 + 标点
    True
    >>> is_filler("啊，原来是这样")    # 有实义，不算语气词
    False
    """
    core = _filler_core(text)
    if not core:
        return False

    raw = (text or "").strip()

    # 英文：按**原文本**拆词。
    # 不能先去标点 —— 「Uh, um.」会被粘成 "Uhum"，一个词都不认识。
    if raw.isascii():
        words = [w for w in re.split(r"[^A-Za-z']+", raw.lower()) if w]
        if not words:
            return False
        return all(_en_filler_word(w) for w in words)

    # 中文：不同字符的种类有限，且全部是语气词。
    # 这里要先去掉标点，否则「啊，啊，啊」会因为夹着逗号而判不出来。
    uniq = set(core)
    if len(uniq) > _FILLER_MAX_UNIQUE:
        return False
    return uniq <= _FILLER_CHARS


def filler_display(text: str) -> str:
    """把一串语气词压成一个短形式。

    「啊，啊，啊，啊……」×15 → 「啊啊」；「哈哈哈」→「哈哈」。
    不压的话那串东西会折行铺满画面。
    """
    raw = (text or "").strip()
    # 英文填充词本来就很短：压掉字母拖长和周期重复（hahaha→ha、ummmm→umm）
    if raw.isascii():
        parts = re.split(r"([^A-Za-z']+)", raw.lower())
        out = "".join(
            _strip_periodic(re.sub(r"([A-Za-z])\1+", r"\1\1", p)) if p.isalpha() else p
            for p in parts
        )
        return out[:20]

    core = _filler_core(raw)
    if not core:
        return raw
    out: list[str] = []
    for ch in core:
        # 同一个字符最多留两遍（「哈哈哈」→「哈哈」）
        if len(out) >= 2 and out[-1] == ch and out[-2] == ch:
            continue
        out.append(ch)
        if len(out) >= 4:
            break
    return "".join(out)


class OpenAICompatProvider:
    """任何 OpenAI 兼容的 /chat/completions 接口：DeepSeek、通义、硅基流动、Ollama...

    这个provider**支持上下文**：把前几句原文一起发过去，代词和指代会准很多。
    机器翻译接口（Google/Bing/有道/腾讯）没法传上下文，只有这条链路能享受。
    """

    name = "openai"
    supports_context = True

    def __init__(self, api_key: str, base_url: str, model: str, thinking: bool = False):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.thinking = thinking

    async def translate(
        self,
        client: httpx.AsyncClient,
        text: str,
        src: Optional[str],
        tgt: str,
        context: Optional[list[str]] = None,
    ) -> str:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT.format(target=tgt)}]
        ctx = [c for c in (context or []) if c and c.strip()]
        if ctx:
            messages.append({"role": "user", "content": CONTEXT_HEADER + "\n" + "\n".join(ctx)})
            messages.append({"role": "assistant", "content": CONTEXT_ACK})

        body: dict = {
            "model": self.model,
            "stream": False,
            "messages": messages + [{"role": "user", "content": text}],
        }
        if self.thinking:
            body["reasoning_effort"] = "low"
        else:
            # ★ 把「思考模式」关掉。
            #   DeepSeek 默认开着思考模式且 effort=high，对翻译纯属浪费：
            #   实测延迟 1.3s → 3.2s，而思维链也是按输出 token 计费的（等于多花钱）。
            #   关闭后 temperature 才生效（思考模式下 temperature 会被忽略）。
            body["thinking"] = {"type": "disabled"}
            body["temperature"] = 0.0

        r = await client.post(f"{self.base_url}/chat/completions", headers=headers, json=body, timeout=25.0)
        if r.status_code != 200:
            raise ProviderError(f"openai HTTP {r.status_code}: {r.text[:160]}")
        data = r.json()
        out = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        out = (out or "").strip().strip('"').strip()
        if not out:
            raise ProviderError("openai 返回空结果")
        return out


# ---------------------------------------------------------------------------
# 统一入口
# ---------------------------------------------------------------------------
class Translator:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()
        self._cache: "OrderedDict[tuple, str]" = OrderedDict()
        self._cooldown: dict[str, float] = {}
        self._providers: dict[str, object] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_at: dict[str, float] = {}
        self.preferred: Optional[str] = None
        # 只提示一次「配置的服务商不可用，已退回免费接口」
        self._warned_missing_provider = False
        self.last_provider: Optional[str] = None
        self.last_error: Optional[str] = None
        self._build()

    def _build(self) -> None:
        s = self.settings
        self._providers = {
            "bing": BingProvider(),
            "google": GoogleProvider(),
            "youdao": YoudaoProvider(),
            "tencent": TencentProvider(),
            "mymemory": MyMemoryProvider(),
        }
        if s.deepl_api_key:
            self._providers["deepl"] = DeepLProvider(s.deepl_api_key)
        if s.openai_api_key or ("localhost" in s.openai_base_url or "127.0.0.1" in s.openai_base_url):
            self._providers["openai"] = OpenAICompatProvider(
                s.openai_api_key, s.openai_base_url, s.openai_model,
                thinking=bool(getattr(s, "openai_thinking", False)),
            )
        self._locks = {name: asyncio.Lock() for name in self._providers}

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            async with self._client_lock:
                if self._client is None or self._client.is_closed:
                    self._client = httpx.AsyncClient(
                        follow_redirects=True,
                        limits=httpx.Limits(max_connections=16, max_keepalive_connections=8),
                    )
        return self._client

    def _fail(self, name: str, exc: Exception) -> None:
        """记录失败并按错误类型决定冷却时长。"""
        wait = cooldown_for(exc)
        self._cooldown[name] = time.time() + wait
        print(f"[translate] {name} 失败（冷却 {wait:.0f}s）—— {exc}", flush=True)

    def order(self) -> list[str]:
        mode = (self.settings.translator or "auto").lower()
        if mode == "none":
            return []
        free = [name for name in AUTO_ORDER if name in self._providers]
        if mode != "auto":
            if mode in self._providers:
                return [mode]
            # ★ 指定的服务商不可用（最典型：没填 API Key），不能直接返回空。
            #   否则新克隆下来的人会看到「只有原文、一个字都不翻」，以为坏了。
            #   退回免费竞速链，先把字幕翻出来再说。
            if not self._warned_missing_provider:
                self._warned_missing_provider = True
                print(f"[translate] 配置的服务商 '{mode}' 不可用（没填 Key？），"
                      f"自动退回免费接口：{free}", flush=True)
            return free
        return free

    def update_settings(self, new_settings: Settings) -> None:
        """扩展端改了翻译服务 / Key 时热更新，不用重启服务。"""
        old = (self.settings.translator, self.settings.deepl_api_key, self.settings.openai_api_key,
               self.settings.openai_base_url, self.settings.openai_model)
        self.settings = new_settings
        new = (new_settings.translator, new_settings.deepl_api_key, new_settings.openai_api_key,
               new_settings.openai_base_url, new_settings.openai_model)
        if old != new:
            self._build()
            self.preferred = None
            self._cooldown.clear()
            self.last_error = None
            print(f"[translate] 服务商切换为 {self.settings.translator}，候选 {self.order()}", flush=True)

    def _alive(self, name: str, now: float) -> bool:
        return self._cooldown.get(name, 0.0) <= now

    def _remember(self, key: tuple, value: str) -> str:
        self._cache[key] = value
        if len(self._cache) > CACHE_MAX:
            self._cache.popitem(last=False)
        return value

    async def _run_one(
        self,
        name: str,
        text: str,
        src: Optional[str],
        tgt: str,
        context: Optional[list[str]] = None,
    ) -> Optional[str]:
        provider = self._providers.get(name)
        if provider is None:
            return None
        lock = self._locks.setdefault(name, asyncio.Lock())
        async with lock:
            # 同一个服务商两次请求之间留点间隔，免费接口最怕的就是被连打。
            # 付费接口不限速：它们有正经的并发额度，卡 0.35 秒只是白白增加字幕延迟。
            interval = PAID_REQUEST_INTERVAL if name in PAID_PROVIDERS else MIN_REQUEST_INTERVAL
            if interval > 0:
                wait = self._last_at.get(name, 0.0) + interval - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
            try:
                client = await self._get_client()
                # 只有支持上下文的服务商才收这个参数（机器翻译接口没法用）
                if getattr(provider, "supports_context", False) and context:
                    return await provider.translate(client, text, src, tgt, context=context)  # type: ignore[call-arg]
                return await provider.translate(client, text, src, tgt)  # type: ignore[attr-defined]
            finally:
                self._last_at[name] = time.monotonic()

    async def translate(
        self,
        text: str,
        src: Optional[str] = None,
        *,
        allow_wait: bool = False,
        context: Optional[list[str]] = None,
    ) -> Optional[str]:
        """返回译文；返回 None 表示「不翻译 / 翻译失败」，此时调用方只显示原文。

        allow_wait=True 时，如果所有服务商都在冷却中，会等最短的那个冷却结束再试一次
        （只给最终字幕用；中间字幕不值得为它等待）。

        context 是同一段视频里**前面几句原文**。带上它，代词和指代会准很多
        （"it" / "this" 到底指什么，只看一句是猜不出来的）。
        目前只有 LLM 那类服务商用得上，机器翻译接口没有这个能力。
        """
        if not text:
            return None
        tgt = self.settings.target_lang or "zh"
        if src and src == tgt:
            return None
        ctx = [c for c in (context or []) if c and c.strip()]
        # 缓存键要带上「上一句」——同一句话在不同上下文里译法可能不同，
        # 只按文本缓存会串味。
        ctx_key = ctx[-1][:60] if ctx else ""
        key = (text, src or "", tgt, ctx_key)
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            return hit

        chain = self.order()
        if not chain:
            return None
        now = time.time()
        errors: list[str] = []

        # 1) 先用上次成功的服务商，正常情况一次请求就完事
        if self.preferred and self.preferred in chain and self._alive(self.preferred, now):
            try:
                out = await self._run_one(self.preferred, text, src, tgt, ctx)
                if out:
                    self.last_provider = self.preferred
                    self.last_error = None
                    return self._remember(key, out)
            except Exception as exc:  # noqa: BLE001
                self._fail(self.preferred, exc)
                errors.append(f"{self.preferred}: {exc}")
                self.preferred = None

        # 2) 还没定下来（或刚才挂了）：所有服务商一起发，谁先给出译文就用谁。
        #    这样即使某个接口要等到超时才失败，也不会拖慢第一条字幕。
        candidates = [n for n in chain if self._alive(n, now) and n != self.preferred]
        if not candidates:
            # 都在冷却中：最终字幕可以等最短的那个冷却结束再试一次，比直接放弃强
            soonest = min((self._cooldown.get(n, 0.0) for n in chain), default=0.0)
            wait = soonest - time.time()
            if allow_wait and 0 < wait <= COOLDOWN_RATE_LIMITED:
                await asyncio.sleep(wait + 0.05)
                candidates = [n for n in chain if self._alive(n, time.time())]
            if not candidates:
                if errors:
                    self.last_error = "; ".join(errors)[:400]
                    print(f"[translate] 全部服务商都在冷却中：{self.last_error}", flush=True)
                return None

        tasks: dict[asyncio.Task, str] = {}
        for name in candidates:
            tasks[asyncio.create_task(self._run_one(name, text, src, tgt, ctx))] = name

        winner: Optional[tuple[str, str]] = None
        pending = set(tasks)
        try:
            while pending:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    name = tasks[task]
                    try:
                        out = task.result()
                    except Exception as exc:  # noqa: BLE001
                        self._fail(name, exc)
                        errors.append(f"{name}: {exc}")
                        continue
                    if out:
                        winner = (name, out)
                        break
                if winner:
                    break
        finally:
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

        if winner:
            name, out = winner
            self.preferred = name
            self.last_provider = name
            self.last_error = None
            print(f"[translate] 选用服务商：{name}", flush=True)
            return self._remember(key, out)

        self.last_error = "; ".join(errors)[:400]
        if self.last_error:
            print(f"[translate] 全部服务商失败：{self.last_error}", flush=True)

        # ★ 兜底：配置的是单一付费服务商（比如 DeepSeek）却失败了 ——
        #   最常见的原因是余额用完 / key 失效 / 网络不通。
        #   这时候不能整部片子都没有译文，退回免费接口至少能看。
        #   注意是「退回」而不是「竞速」：竞速的话免费接口更快，会反过来把
        #   DeepSeek 挤掉，那就白配了。
        mode = (self.settings.translator or "auto").lower()
        if mode not in ("auto", "none", ""):
            free = [n for n in AUTO_ORDER if n in self._providers and n != mode and self._alive(n, time.time())]
            if free:
                print(f"[translate] {mode} 失败，退回免费接口兜底：{free}", flush=True)
                tasks2: dict[asyncio.Task, str] = {}
                for n in free:
                    tasks2[asyncio.create_task(self._run_one(n, text, src, tgt, ctx))] = n
                pending2 = set(tasks2)
                try:
                    while pending2:
                        done2, pending2 = await asyncio.wait(pending2, return_when=asyncio.FIRST_COMPLETED)
                        for task in done2:
                            n = tasks2[task]
                            try:
                                out = task.result()
                            except Exception:  # noqa: BLE001
                                continue
                            if out:
                                self.last_provider = f"{n}(兜底)"
                                print(f"[translate] 兜底成功：{n}", flush=True)
                                return self._remember(key, out)
                finally:
                    for task in pending2:
                        task.cancel()
                    if pending2:
                        await asyncio.gather(*pending2, return_exceptions=True)
        return None

    async def probe(self, text: str = "Hello, this is a translation test.", src: Optional[str] = None) -> dict:
        """设置页「测试翻译」用：逐个试，返回每个服务商的结果。"""
        tgt = self.settings.target_lang or "zh"
        results: dict[str, Any] = {}
        for name in self.order():
            t0 = time.time()
            try:
                out = await self._run_one(name, text, src, tgt)
                results[name] = {"ok": bool(out), "ms": int((time.time() - t0) * 1000), "text": out or ""}
            except Exception as exc:  # noqa: BLE001
                results[name] = {"ok": False, "ms": int((time.time() - t0) * 1000), "error": str(exc)[:200]}
        return {"source": text, "target": tgt, "results": results}

    def status(self) -> dict:
        now = time.time()
        return {
            "mode": self.settings.translator,
            "target": self.settings.target_lang,
            "chain": self.order(),
            "preferred": self.preferred,
            "active": self.last_provider,
            "cooldown": sorted(n for n, t in self._cooldown.items() if t > now),
            "cache": len(self._cache),
            "last_error": self.last_error,
        }

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()


__all__ = ["Translator", "ALL_PROVIDERS", "AUTO_ORDER"]
