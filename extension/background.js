/*
 * Service Worker：只管三件事
 *   1. 协调权限与生命周期（tabCapture 的 streamId、offscreen 文档、content script 注入）
 *   2. 在 offscreen（音频+字幕引擎）和 content（悬浮字幕）之间转发消息
 *   3. 维持一份可被 popup 读取的状态（存 storage.session，SW 被回收也不丢）
 *
 * 注意：MV3 的 SW 随时可能被回收，所以所有状态都必须落在 storage.session 里，
 * 所有 onMessage 监听必须在顶层同步注册。
 */
importScripts("common.js");

const OFFSCREEN_PATH = "offscreen.html";
const STATE_KEY = "vst_runtime";

/** @type {{status:string,message:string,tabId:number|null,tabTitle:string,startedAt:number,device:string,computeType:string,model:string,lastLine:object|null,stats:object|null,error:string}} */
const DEFAULT_STATE = {
  status: "idle",          // idle | starting | loading | running | error
  message: "",
  tabId: null,
  tabTitle: "",
  startedAt: 0,
  device: "",
  computeType: "",
  model: "",
  lastLine: null,
  stats: null,
  error: "",
  editMode: false,
  serverBoot: "",
  serverHint: "",
};

let state = Object.assign({}, DEFAULT_STATE);
let hydrating = null;

// ---------------------------------------------------------------------------
// 状态存取
// ---------------------------------------------------------------------------
async function hydrate() {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      const got = await chrome.storage.session.get(STATE_KEY);
      if (got && got[STATE_KEY]) state = Object.assign({}, DEFAULT_STATE, got[STATE_KEY]);
    } catch (e) {
      /* 忽略 */
    }
    return state;
  })();
  return hydrating;
}

async function setState(patch, broadcast = true) {
  await hydrate();
  state = Object.assign({}, state, patch);
  try {
    await chrome.storage.session.set({ [STATE_KEY]: state });
  } catch (e) {
    /* 忽略 */
  }
  if (broadcast) broadcastToUI();
  return state;
}

function broadcastToUI() {
  chrome.runtime.sendMessage({ to: "ui", type: "state", state }).catch(() => {});
  updateBadge();
}

function updateBadge() {
  const on = state.status === "running" || state.status === "loading" || state.status === "starting";
  chrome.action.setBadgeText({ text: on ? "●" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state.status === "running" ? "#e5484d" : "#f5a623" }).catch(() => {});
  chrome.action.setTitle({ title: on ? "视频实时字幕翻译 · 正在运行（点击停止）" : "视频实时字幕翻译" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// offscreen 文档
// ---------------------------------------------------------------------------
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  const justification = "捕获当前标签页的音频并在本机实时识别，用于生成字幕";
  try {
    // ★ 声明 AUDIO_PLAYBACK：标签页音频被 tabCapture 拿走之后必须由我们放回去，
    //   而用 <audio srcObject> 播放需要这个用途声明。
    //   为什么要用 <audio> 而不是接回 AudioContext：
    //   接回 Web Audio 图会让声音按 AudioContext 的采样率再渲染一遍（重采样后送设备），
    //   高频会发闷。走浏览器原生媒体管线能保持原始质量。
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification,
    });
  } catch (e) {
    // 老版本 Edge / 不允许组合用途时退回只声明 USER_MEDIA（播放会自动走 AudioContext 回退）
    console.warn("[offscreen] 组合用途创建失败，退回仅 USER_MEDIA：", e);
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification,
    });
  }
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch (e) {
    /* 忽略 */
  }
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage(Object.assign({ to: "offscreen" }, msg)).catch(() => null);
}

/** 刚创建 offscreen 文档时监听器可能还没注册好，重试几次 */
async function toOffscreenReady(msg, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const res = await toOffscreen(msg);
    if (res !== null) return res;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

// ---------------------------------------------------------------------------
// content script
// ---------------------------------------------------------------------------
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { to: "content", type: "ping" });
    if (res && res.ok) return true;
  } catch (e) {
    /* 没注入过，继续走下面的注入 */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["common.js", "content.js"],
    });
    return true;
  } catch (e) {
    console.warn("[vst] 注入 content script 失败：", e && e.message);
    return false;
  }
}

function toContent(tabId, msg) {
  if (!tabId) return Promise.resolve(null);
  return chrome.tabs.sendMessage(tabId, Object.assign({ to: "content" }, msg)).catch(() => null);
}

// ---------------------------------------------------------------------------
// 开始 / 停止
// ---------------------------------------------------------------------------
async function startCapture(tabId, presetStreamId) {
  await hydrate();
  if (state.status === "running" || state.status === "loading" || state.status === "starting") {
    await stopCapture("重新开始");
  }

  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab) throw new Error("找不到这个标签页，请重新打开页面再试。");

  await setState({
    status: "starting",
    message: "正在获取标签页音频…",
    tabId: tab.id,
    tabTitle: tab.title || tab.url || "",
    startedAt: Date.now(),
    error: "",
    lastLine: null,
    stats: null,
  });
  await toContent(tab.id, { type: "state", state: snapshot() });

  const settings = await self.VST.loadSettings();

  // streamId 最好在 popup（有用户手势）里取；这里兜底再取一次。
  let streamId = presetStreamId;
  if (!streamId) {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  }

  await ensureOffscreen();
  await ensureContentScript(tab.id);

  // 先让本地启动器把服务拉起来（不阻塞 —— 服务要几秒才能监听端口，
  // offscreen 那边的 WebSocket 本来就会带退避重连）
  ensureLocalServer().then((r) => {
    if (r && r.ok === false && r.hint) {
      setState({ serverHint: r.hint }, false);
    }
  });

  const res = await toOffscreenReady({
    type: "start",
    streamId,
    tabId: tab.id,
    config: self.VST.serverConfig(settings),
  });
  if (!res) {
    await setState({ status: "error", error: "音频采集模块没有响应，请重新加载扩展后再试。" });
    throw new Error("音频采集模块没有响应，请重新加载扩展后再试。");
  }
  if (res.ok === false) {
    await setState({ status: "error", message: "", error: res.error || "启动失败" });
    throw new Error(res.error || "启动失败");
  }

  await setState({ status: "loading", message: "正在连接本地识别服务…" });
  await toContent(tab.id, { type: "state", state: snapshot() });
  await applyAppearance(settings);
  return snapshot();
}

async function stopCapture(reason) {
  await hydrate();
  const tabId = state.tabId;
  await toOffscreen({ type: "stop" }).catch(() => {});
  await closeOffscreen();
  await toContent(tabId, { type: "state", state: { status: "idle" } }).catch(() => {});
  await setState({
    status: "idle",
    message: reason || "",
    tabId: null,
    tabTitle: "",
    lastLine: null,
    stats: null,
    error: "",
  });
  return snapshot();
}

async function applyAppearance(settings) {
  await hydrate();
  const s = settings || (await self.VST.loadSettings());
  await toContent(state.tabId, { type: "settings", settings: s });
}

function snapshot() {
  return Object.assign({}, state, { serverUrl: undefined });
}

/** ws://127.0.0.1:8765/ws → http://127.0.0.1:8765 */
function httpBase(wsUrl) {
  let u = String(wsUrl || self.VST.DEFAULTS.serverUrl).trim();
  u = u.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  u = u.replace(/\/ws\/?$/i, "");
  u = u.replace(/\/+$/, "");
  return u;
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({ signal: ctrl.signal, cache: "no-store" }, options));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 自动启动本地服务
//
// 浏览器扩展**不能**直接启动进程，这是 Chromium 的安全边界。
// 官方的唯一通道是 Native Messaging：扩展调一个注册在注册表里的本地程序，
// 由它去把 server\app.py 拉起来。安装脚本（scripts\install.ps1）负责注册。
// ---------------------------------------------------------------------------
const NATIVE_HOST = "com.vst.server_launcher";
let lastEnsureAt = 0;
let nativeHostState = "unknown"; // unknown | ok | missing

function portFromServerUrl(url) {
  try {
    const u = new URL(url || self.VST.DEFAULTS.serverUrl);
    return Number(u.port) || 8765;
  } catch (e) {
    return 8765;
  }
}

async function ensureLocalServer(force) {
  const settings = await self.VST.loadSettings();
  if (settings.autoStartServer === false) {
    nativeHostState = "disabled";
    return { ok: false, skipped: "disabled" };
  }
  const now = Date.now();
  if (!force && now - lastEnsureAt < 10000) return { ok: true, skipped: "throttled" };
  lastEnsureAt = now;

  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      action: "ensure",
      port: portFromServerUrl(settings.serverUrl),
    });
    nativeHostState = "ok";
    console.log("[vst] 本地服务启动器返回：", JSON.stringify(res));
    if (res && res.status) await setState({ serverBoot: res.status }, false);
    return res || { ok: true };
  } catch (e) {
    nativeHostState = "missing";
    const msg = (e && e.message) || String(e);
    console.warn("[vst] 本地启动器不可用：", msg);
    return {
      ok: false,
      error: msg,
      hint: "自动启动组件没注册。请重新运行 scripts\\install.ps1。",
    };
  }
}

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // ---- 来自 popup / options ----
  if (msg.to === "bg") {
    (async () => {
      await hydrate();
      try {
        switch (msg.type) {
          case "getState":
            sendResponse({ ok: true, state: snapshot() });
            break;
          case "start":
            sendResponse({ ok: true, state: await startCapture(msg.tabId, msg.streamId) });
            break;
          case "stop":
            sendResponse({ ok: true, state: await stopCapture() });
            break;
          case "toggle":
            if (state.status === "running" || state.status === "loading" || state.status === "starting") {
              sendResponse({ ok: true, state: await stopCapture() });
            } else {
              sendResponse({ ok: true, state: await startCapture(msg.tabId, msg.streamId) });
            }
            break;
          case "settings":
            await applyAppearance(msg.settings);
            await toOffscreen({ type: "config", config: self.VST.serverConfig(msg.settings) });
            sendResponse({ ok: true });
            break;
          case "editMode": {
            // 编辑模式是临时状态，只发给页面，不落盘
            if (!state.tabId) {
              sendResponse({ ok: false, error: "字幕还没开始运行" });
              break;
            }
            const r = await toContent(state.tabId, { type: "editmode", enabled: !!msg.enabled });
            await setState({ editMode: !!(r && r.editMode) });
            sendResponse({ ok: true, editMode: !!(r && r.editMode) });
            break;
          }
          case "getEditMode": {
            if (!state.tabId) {
              sendResponse({ ok: true, editMode: false });
              break;
            }
            const r = await toContent(state.tabId, { type: "editstate" });
            sendResponse({ ok: true, editMode: !!(r && r.editMode) });
            break;
          }
          case "clear": {
            const tid = state.tabId || msg.tabId;
            await toContent(tid, { type: "clear" });
            sendResponse({ ok: true });
            break;
          }
          case "getCapturedTab": {
            if (!state.tabId) return sendResponse({ ok: true, tab: null });
            const tab = await chrome.tabs.get(state.tabId).catch(() => null);
            sendResponse({ ok: true, tab: tab ? { id: tab.id, title: tab.title, url: tab.url } : null });
            break;
          }
          case "ensureServer": {
            const r = await ensureLocalServer(true);
            sendResponse({ ok: !!(r && r.ok), result: r, nativeState: nativeHostState });
            break;
          }
          case "testServer": {
            const url = httpBase(msg.url);
            try {
              const r = await fetchWithTimeout(url + "/health", {}, 6000);
              sendResponse({ ok: true, health: await r.json(), url: url + "/health" });
            } catch (e) {
              sendResponse({ ok: false, error: (e && e.message) || String(e), url: url + "/health" });
            }
            break;
          }
          case "testTranslate": {
            const s = msg.settings || (await self.VST.loadSettings());
            const url = httpBase(s.serverUrl);
            const body = {
              mode: s.translator || "auto",
              target: s.targetLang || "zh",
              lang: s.sourceLang || "en",
              text: msg.text || "Hello, this is a real time subtitle test.",
              deepl_api_key: s.deeplApiKey || "",
              openai_api_key: s.openaiApiKey || "",
              openai_base_url: s.openaiBaseUrl || "",
              openai_model: s.openaiModel || "",
            };
            try {
              const r = await fetchWithTimeout(
                url + "/api/translate/probe",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                },
                20000
              );
              if (!r.ok) throw new Error("HTTP " + r.status);
              sendResponse({ ok: true, data: await r.json() });
            } catch (e) {
              sendResponse({ ok: false, error: (e && e.message) || String(e) });
            }
            break;
          }
          default:
            sendResponse({ ok: false, error: "未知指令 " + msg.type });
        }
      } catch (e) {
        await setState({ status: "error", error: (e && e.message) || String(e) });
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true; // 异步响应
  }

  // ---- 来自 offscreen：字幕 / 状态 ----
  if (msg.to === "bg-relay") {
    (async () => {
      await hydrate();
      const tabId = state.tabId;
      switch (msg.type) {
        case "status": {
          const map = {
            connecting: "正在连接本地服务…",
            connected: "已连接，等待字幕引擎就绪…",
            ready: "字幕运行中",
            disconnected: "与本地服务的连接断开，正在重连…",
            error: "",
          };
          const patch = {
            status: msg.state === "ready" ? "running" : msg.state === "error" ? "error" : "loading",
            message: msg.message || map[msg.state] || "",
          };
          if (msg.model) patch.model = msg.model;
          if (msg.device) patch.device = msg.device;
          if (msg.computeType) patch.computeType = msg.computeType;
          if (msg.translator) patch.translator = msg.translator;
          if (msg.translatorActive) patch.translatorActive = msg.translatorActive;
          if (msg.state === "error") patch.error = msg.message || "识别服务出错";
          await setState(patch);
          await toContent(tabId, { type: "state", state: snapshot() });
          // 连不上就试着把服务拉起来（内部有 10 秒节流，不会反复触发）
          if (msg.state === "disconnected") ensureLocalServer();
          if (msg.state === "ready" && nativeHostState === "ok") {
            setState({ serverHint: "" }, false);
          }
          break;
        }
        case "line": {
          state.lastLine = msg.line;
          try {
            await chrome.storage.session.set({ [STATE_KEY]: state });
          } catch (e) {
            /* 忽略 */
          }
          await toContent(tabId, { type: "line", line: msg.line });
          broadcastToUI();
          break;
        }
        case "speech": {
          // 「有人开始说新一句了」→ 让页面立刻把上一句淡掉。
          // 不等新字幕出来：识别要半秒到一秒，等它出来时说话的人常常已经换了。
          await toContent(tabId, { type: "speech", state: msg.state || "start" });
          break;
        }
        case "stats": {
          state.stats = msg.stats;
          await toContent(tabId, { type: "stats", stats: msg.stats });
          broadcastToUI();
          break;
        }
        case "editstate": {
          await setState({ editMode: !!msg.enabled });
          break;
        }
        case "cleared":
          await toContent(tabId, { type: "clear" });
          break;
        default:
          break;
      }
    })();
    return true;
  }

  return undefined;
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await hydrate();
  if (state.tabId === tabId && state.status !== "idle") {
    await stopCapture("标签页已关闭");
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await hydrate();
  if (changeInfo.status !== "complete" || state.tabId !== tabId) return;
  if (state.status === "idle") return;
  // 页面刷新后 content script 没了，重新注入并恢复字幕
  await ensureContentScript(tabId);
  await toContent(tabId, { type: "state", state: snapshot() });
  const s = await self.VST.loadSettings();
  await toContent(tabId, { type: "settings", settings: s });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-capture") return;
  await hydrate();
  if (state.status === "running" || state.status === "loading" || state.status === "starting") {
    await stopCapture();
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      try {
        await startCapture(tab.id);
      } catch (e) {
        await setState({ status: "error", error: (e && e.message) || String(e) });
      }
    }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await hydrate();
  await setState({}, false);
  updateBadge();
  // 首次安装时把默认设置写进去，方便设置页展示
  const cur = await chrome.storage.sync.get("vst_settings").catch(() => ({}));
  if (!cur || !cur.vst_settings) {
    await chrome.storage.sync.set({ vst_settings: self.VST.DEFAULTS }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await hydrate();
  if (state.status !== "idle") await stopCapture("浏览器已重启");
  updateBadge();
});

hydrate().then(updateBadge);
