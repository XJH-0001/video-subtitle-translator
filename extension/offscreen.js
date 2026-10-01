/*
 * offscreen 文档：真正干活的地方。
 *
 *   标签页音频 --getUserMedia(tab)--> AudioContext
 *        ├── 直接接到扬声器（不接回去的话，捕获开始后用户就听不到声音了）
 *        └── → AudioWorklet → 16kHz 单声道 PCM → WebSocket → 本地识别服务
 *
 * 本地服务把识别 / 翻译结果推回来，这里转交给 Service Worker，再转给页面上的字幕层。
 */

const TARGET_RATE = 16000;

const DEFAULT_CONFIG = {
  serverUrl: "ws://127.0.0.1:8765/ws",
  model: "small",
  sourceLang: null,
  targetLang: "zh",
  translate: true,
  translatePartials: true,
  translator: "auto",
  deepl_api_key: "",
  openai_api_key: "",
  openai_base_url: "",
  openai_model: "",
};

let ctx = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let sinkNode = null;
// 播放回原声用的 <audio> 元素（走原生媒体管线，避免 Web Audio 重采样）
let playbackEl = null;
// 实际生效的播放路径：audio-element（原生管线）或 webaudio（回退）
let playbackPath = null;
// 音频链路参数（轨道/上下文采样率、延迟），用于排查「声音变闷」这类问题
let audioDiag = null;

let ws = null;
let running = false;
let serverReady = false;
let config = Object.assign({}, DEFAULT_CONFIG);

let reconnectTimer = null;
let reconnectDelay = 500;
let pingTimer = null;
let sentChunks = 0;
let droppedChunks = 0;

// ---------------------------------------------------------------------------
// 与 Service Worker 通信
// ---------------------------------------------------------------------------
function relay(type, payload) {
  try {
    chrome.runtime.sendMessage(Object.assign({ to: "bg-relay", type }, payload)).catch(() => {});
  } catch (e) {
    /* SW 可能正在重启，忽略 */
  }
}

function log(...args) {
  console.log("[vst/offscreen]", ...args);
}

// ---------------------------------------------------------------------------
// 音频采集
// ---------------------------------------------------------------------------
async function start(msg) {
  await stop();
  config = Object.assign({}, DEFAULT_CONFIG, msg.config || {});

  log("开始采集，标签页", msg.tabId);

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: msg.streamId,
      },
    },
    video: false,
  });

  // ★ 按音频轨道的原生采样率来建 AudioContext，别让它用默认值。
  //
  // 为什么这条很关键：标签页音频被 tabCapture 拿走之后，必须经 Web Audio 再送回扬声器
  // （sourceNode → ctx.destination）。而 Web Audio 是**按 AudioContext 的采样率**渲染的，
  // 再送到设备时又要转一次。如果 AudioContext 的采样率和轨道原生采样率不一致，
  // 音频会被**重采样两次**（48k → ctx率 → 设备率），高频会明显发闷。
  // 实测常见的坑：耳机是 44.1kHz、而视频是 48kHz。
  //
  // latencyHint 保持 "interactive"：播放延迟直接决定字幕和声音的唇音同步，
  // 不能为了「稳」把它调大 —— 那会让声音比画面慢，得不偿失。
  const track0 = mediaStream.getAudioTracks()[0];
  let nativeRate = 0;
  try {
    const st = track0 && track0.getSettings ? track0.getSettings() : null;
    nativeRate = (st && Number(st.sampleRate)) || 0;
  } catch (e) {
    /* 忽略 */
  }
  const ctxOpts = { latencyHint: "interactive" };
  if (nativeRate >= 8000 && nativeRate <= 192000) {
    ctxOpts.sampleRate = nativeRate;
  }
  ctx = new AudioContext(ctxOpts);

  // 记下实际生效的采样率，方便排查「声音变闷」这类问题
  try {
    const st = track0 && track0.getSettings ? track0.getSettings() : {};
    audioDiag = {
      trackRate: nativeRate || null,
      ctxRate: ctx.sampleRate,
      channels: (st && Number(st.channelCount)) || null,
      // 两个不一致就意味着多了一次重采样，是音质变差最常见的来源
      mismatch: !!(nativeRate && nativeRate !== ctx.sampleRate),
      // 播放走的是原生 <audio> 管线还是 Web Audio 图 —— 直接决定音质
      playback: playbackPath,
      baseLatency: Math.round((ctx.baseLatency || 0) * 1000),
      outputLatency: Math.round((ctx.outputLatency || 0) * 1000),
    };
    log("音频参数", JSON.stringify(audioDiag));
    if (audioDiag.mismatch) {
      log(`⚠ 轨道 ${nativeRate}Hz 与 AudioContext ${ctx.sampleRate}Hz 不一致，会有额外重采样`);
    }
  } catch (e) {
    /* 忽略 */
  }
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (e) {
      /* 忽略 */
    }
  }

  sourceNode = ctx.createMediaStreamSource(mediaStream);

  // 关键一步：把捕获到的音频接回扬声器。
  // 标签页音频一旦被 tabCapture 拿走，页面自己就听不到了，
  // 不接回来的话用户会以为「字幕一开就没声音了」。
  //
  // ★ 优先用 <audio srcObject> 播放，而不是 sourceNode.connect(ctx.destination)。
  //
  // 为什么：接回 Web Audio 图，声音会**按 AudioContext 的采样率重新渲染一遍**
  // 再送到设备；设备率 / 上下文率 / 轨道原生率三者不一致时就是重采样两次，
  // 高频发闷、听起来「糊」。<audio srcObject> 走浏览器原生媒体管线，保持原始质量。
  // 万一失败（例如自动播放策略拦截）就退回接 AudioContext，功能不受影响。
  playbackPath = "audio-element";
  try {
    playbackEl = new Audio();
    playbackEl.srcObject = mediaStream;
    playbackEl.autoplay = true;
    playbackEl.muted = false;
    playbackEl.volume = 1;
    await playbackEl.play();
  } catch (e) {
    playbackPath = "webaudio";
    log("用 <audio> 播放失败，退回接 AudioContext：", e && e.message);
    try {
      if (playbackEl) {
        playbackEl.srcObject = null;
        playbackEl = null;
      }
    } catch (e2) {
      /* 忽略 */
    }
    sourceNode.connect(ctx.destination);
  }

  await ctx.audioWorklet.addModule("pcm-worklet.js");
  workletNode = new AudioWorkletNode(ctx, "vst-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: "explicit",
  });
  workletNode.port.onmessage = (ev) => onPcm(ev.data);

  // 工作节点必须连到一个终点才会被持续调用；用一个 0 增益的 GainNode 静音接入。
  sinkNode = ctx.createGain();
  sinkNode.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(sinkNode);
  sinkNode.connect(ctx.destination);

  if (mediaStream.getAudioTracks().length === 0) {
    throw new Error("这个标签页没有音频轨道，请先播放视频再开启字幕。");
  }
  const track = mediaStream.getAudioTracks()[0];
  track.addEventListener("ended", () => {
    log("音频轨道结束");
    relay("status", { state: "disconnected", message: "标签页音频已结束（视频停了吗？）" });
  });

  running = true;
  sentChunks = 0;
  droppedChunks = 0;
  connectWS();
  relay("status", { state: "connecting", message: "正在连接本地识别服务…" });

  // 保险：音频上下文可能因为自动播放策略处于挂起状态，那样用户就听不到原声了。
  // 挂起时再试一次 resume，还不行就明确告诉用户点一下页面。
  setTimeout(async () => {
    if (!running || !ctx) return;
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch (e) {
        /* 忽略 */
      }
    }
    if (ctx && ctx.state !== "running") {
      log("音频上下文状态：", ctx.state);
      relay("status", {
        state: "connected",
        message: "浏览器暂停了音频输出，在页面上点一下即可恢复原声",
      });
    }
  }, 1200);

  return { ok: true };
}

function onPcm(buffer) {
  if (!running) return;
  if (!serverReady || !ws || ws.readyState !== WebSocket.OPEN) {
    droppedChunks++;
    return;
  }
  try {
    ws.send(buffer);
    sentChunks++;
  } catch (e) {
    droppedChunks++;
  }
}

async function stop() {
  running = false;
  serverReady = false;
  stopPing();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelay = 500;

  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "flush" }));
      ws.close();
    } catch (e) {
      /* 忽略 */
    }
    ws = null;
  }
  if (workletNode) {
    try {
      workletNode.port.onmessage = null;
      workletNode.disconnect();
    } catch (e) {
      /* 忽略 */
    }
    workletNode = null;
  }
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (e) {
      /* 忽略 */
    }
    sourceNode = null;
  }
  if (sinkNode) {
    try {
      sinkNode.disconnect();
    } catch (e) {
      /* 忽略 */
    }
    sinkNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (e) {
        /* 忽略 */
      }
    });
    mediaStream = null;
  }
  if (playbackEl) {
    try {
      playbackEl.pause();
      playbackEl.srcObject = null;
    } catch (e) {
      /* 忽略 */
    }
    playbackEl = null;
  }
  playbackPath = null;
  if (ctx) {
    try {
      await ctx.close();
    } catch (e) {
      /* 忽略 */
    }
    ctx = null;
  }
  return { ok: true, sent: sentChunks, dropped: droppedChunks };
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function sendConfig() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "config",
      model: config.model,
      language: config.sourceLang || null,
      target_lang: config.targetLang,
      translate: !!config.translate,
      translate_partials: !!config.translatePartials,
      translator: config.translator || "auto",
      deepl_api_key: config.deepl_api_key || "",
      openai_api_key: config.openai_api_key || "",
      openai_base_url: config.openai_base_url || "",
      openai_model: config.openai_model || "",
    })
  );
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function connectWS() {
  if (!running) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.onclose = null;
      ws.close();
    } catch (e) {
      /* 忽略 */
    }
    ws = null;
  }

  const url = config.serverUrl || DEFAULT_CONFIG.serverUrl;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectDelay = 500;
    serverReady = false;
    log("已连接", url);
    sendConfig();
    relay("status", { state: "connected", message: "已连接本地服务，正在等待识别引擎…" });
    stopPing();
    pingTimer = setInterval(() => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      } catch (e) {
        /* 忽略 */
      }
    }, 15000);
  };

  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    handleServerMessage(msg);
  };

  socket.onerror = () => {
    /* onclose 会紧跟着触发，统一在那里处理 */
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    serverReady = false;
    stopPing();
    if (!running) return;
    relay("status", {
      state: "disconnected",
      message: "和本地服务的连接断了，正在重连。请确认 start-server 窗口还开着。",
    });
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 8000);
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "hello":
      serverReady = false;
      log("服务端就绪", msg.version, "模型参数", msg.model);
      break;

    case "status":
      if (msg.state === "ready") {
        serverReady = true;
        relay("status", {
          state: "ready",
          message: msg.message || "字幕运行中",
          audio: audioDiag,
          model: msg.model,
          device: msg.device,
          computeType: msg.compute_type,
          // 当前翻译服务商 —— 扩展里存的 translator 会覆盖服务端配置，
          // 界面上显示出来才能一眼确认到底走的是 DeepSeek 还是免费接口
          translator: msg.translator,
          translatorActive: msg.translatorActive,
        });
      } else if (msg.state === "loading") {
        serverReady = false;
        relay("status", { state: "loading", message: msg.message || "正在加载识别模型…" });
      }
      break;

    case "line":
      relay("line", {
        line: {
          id: msg.id,
          final: !!msg.final,
          source: msg.source == null ? null : msg.source,
          translated: msg.translated == null ? null : msg.translated,
          // draft=True 表示这是免费接口先出的快稿，稍后会被准稿替换
          draft: !!msg.draft,
          lang: msg.lang || null,
          t0: msg.t0,
          t1: msg.t1,
        },
      });
      break;

    case "speech":
      // 「有人开始说新一句了」—— 立刻把上一句字幕淡掉。
      // 识别天生有半秒到一秒延迟，等新字幕出来时说话的人往往已经换了，
      // 旧字幕挂在画面上就会被误当成下一个人的话。
      relay("speech", { state: msg.state || "start" });
      break;

    case "stats":
      relay("stats", {
        stats: {
          rtf: msg.rtf,
          load: msg.load,
          audioS: msg.audio_s,
          inferS: msg.infer_s,
          decodes: msg.decodes,
          language: msg.language,
        },
      });
      break;

    case "error":
      relay("status", { state: "error", message: msg.message || "识别服务出错" });
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 消息入口
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to !== "offscreen") return undefined;

  (async () => {
    try {
      switch (msg.type) {
        case "start":
          sendResponse(await start(msg));
          break;
        case "stop":
          sendResponse(await stop());
          break;
        case "config":
          config = Object.assign({}, config, msg.config || {});
          sendConfig();
          sendResponse({ ok: true });
          break;
        case "getStatus":
          sendResponse({
            ok: true,
            running,
            serverReady,
            sent: sentChunks,
            dropped: droppedChunks,
            sampleRate: ctx ? ctx.sampleRate : null,
          });
          break;
        default:
          sendResponse({ ok: false, error: "未知指令 " + msg.type });
      }
    } catch (e) {
      const message = (e && e.message) || String(e);
      log("出错", message);
      sendResponse({ ok: false, error: message });
    }
  })();

  return true;
});

log("offscreen 已加载，采样目标", TARGET_RATE, "Hz");
