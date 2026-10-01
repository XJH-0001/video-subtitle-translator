/* 弹窗：开关字幕 + 几个最常用的设置。 */

const $ = (id) => document.getElementById(id);

let tab = null;
let runtime = { status: "idle" };
let settings = Object.assign({}, VST.DEFAULTS);

const BLOCKED = /^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source|brave):/i;

function setStatusText(text, tone) {
  const el = $("status");
  el.textContent = text || "";
  el.setAttribute("data-tone", tone || "");
}

function render() {
  const s = runtime.status || "idle";
  $("dot").setAttribute("data-s", s);
  const on = s === "running" || s === "loading" || s === "starting";
  const btn = $("toggle");
  btn.setAttribute("data-on", on ? "1" : "0");
  btn.textContent = on ? "停止实时字幕" : "开启实时字幕";
  btn.disabled = false;

  if (runtime.error) setStatusText("出错了：" + runtime.error, "error");
  else if (runtime.message) setStatusText(runtime.message, s === "error" ? "error" : "");
  else if (s === "running") setStatusText(runtime.tabTitle ? "正在为「" + shorten(runtime.tabTitle) + "」生成字幕" : "字幕运行中");
  else if (s === "idle") setStatusText("已停止");
  else setStatusText("准备中…");

  // 识别跑在哪 + 翻译走哪个服务商
  // —— 扩展里存的 translator 会覆盖服务端配置，不显示出来根本没法确认配的 DeepSeek 有没有生效。
  const dev = $("device");
  if (dev) {
    const parts = [];
    if (runtime.device === "cuda") {
      parts.push("🚀 " + (runtime.model || "") + " · 显卡加速");
    } else if (runtime.device === "cpu") {
      parts.push("🖥 " + (runtime.model || "") + " · CPU 识别");
    }
    const tr = runtime.translatorActive || runtime.translator;
    if (tr) {
      const isPaid = tr === "openai" || tr === "deepl";
      const name = tr === "openai" ? "DeepSeek" : tr === "deepl" ? "DeepL" : tr;
      parts.push((isPaid ? "🤖 " : "🆓 ") + "翻译：" + name);
    }
    if (parts.length) {
      dev.textContent = parts.join("　|　");
      const paid = tr === "openai" || tr === "deepl";
      dev.setAttribute("data-kind", runtime.device === "cuda" && paid ? "gpu" : "cpu");
      dev.hidden = false;
    } else {
      dev.hidden = true;
    }
  }

  const line = runtime.lastLine;
  const box = $("preview-box");
  if (line && (line.source || line.translated)) {
    box.innerHTML = "";
    if (line.source) {
      const a = document.createElement("div");
      a.className = "preview-source";
      a.textContent = line.source;
      box.appendChild(a);
    }
    if (line.translated) {
      const b = document.createElement("div");
      b.className = "preview-target";
      b.textContent = line.translated;
      box.appendChild(b);
    } else {
      const b = document.createElement("div");
      b.className = "preview-empty";
      b.textContent = "（翻译中…）";
      box.appendChild(b);
    }
  } else if (s === "running") {
    box.innerHTML = '<div class="preview-empty">在等第一句话…</div>';
  } else {
    box.innerHTML = '<div class="preview-empty">还没有字幕</div>';
  }
}

function shorten(t, n) {
  n = n || 22;
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function renderSettings() {
  $("serverUrl").textContent = settings.serverUrl;
  $("showSource").checked = !!settings.showSource;
  $("fontSize").value = settings.fontSize;
  $("fontSizeVal").textContent = settings.fontSize;
  $("targetLang").value = settings.targetLang;
  $("attachMode").value = settings.attachMode || "auto";
  $("model").value = settings.model;
  $("editPos").setAttribute("data-on", runtime.editMode ? "1" : "0");
  $("editPos").textContent = runtime.editMode ? "完成调整" : "调整位置";
}

async function pushSettings(patch) {
  settings = await VST.saveSettings(patch);
  renderSettings();
  try {
    await chrome.runtime.sendMessage({ to: "bg", type: "settings", settings });
  } catch (e) {
    /* 没有活动标签页也无所谓 */
  }
}

// ---------------------------------------------------------------------------
async function refreshState() {
  const res = await chrome.runtime.sendMessage({ to: "bg", type: "getState" }).catch(() => null);
  if (res && res.ok) runtime = res.state;
  // 编辑模式是临时的，以页面里的实际状态为准（比如用户刚在页面上按了 Esc）
  if (runtime.tabId) {
    const em = await chrome.runtime.sendMessage({ to: "bg", type: "getEditMode" }).catch(() => null);
    if (em && em.ok) runtime.editMode = em.editMode;
  } else {
    runtime.editMode = false;
  }
  render();
}

async function toggle() {
  const btn = $("toggle");
  btn.disabled = true;
  const on = runtime.status === "running" || runtime.status === "loading" || runtime.status === "starting";

  if (on) {
    const res = await chrome.runtime.sendMessage({ to: "bg", type: "stop" }).catch((e) => ({ ok: false, error: String(e) }));
    if (res && res.ok) runtime = res.state;
    render();
    btn.disabled = false;
    return;
  }

  if (!tab) {
    setStatusText("找不到当前标签页", "error");
    btn.disabled = false;
    return;
  }
  if (BLOCKED.test(tab.url || "")) {
    setStatusText("浏览器内置页面无法捕获音频，请切到普通网页再试", "error");
    btn.disabled = false;
    return;
  }

  // 在弹窗里取 streamId：这里带用户手势，比在 Service Worker 里取更稳。
  let streamId = null;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    streamId = null; // 交给后台再试一次
  }

  setStatusText("正在启动…");
  const res = await chrome.runtime
    .sendMessage({ to: "bg", type: "start", tabId: tab.id, streamId })
    .catch((e) => ({ ok: false, error: String(e) }));

  if (res && res.ok) runtime = res.state;
  else runtime = Object.assign({}, runtime, { status: "error", error: (res && res.error) || "启动失败" });
  render();
  btn.disabled = false;
}

// ---------------------------------------------------------------------------
function initTargets() {
  const sel = $("targetLang");
  sel.innerHTML = "";
  VST.TARGETS.forEach((t) => {
    const o = document.createElement("option");
    o.value = t.value;
    o.textContent = t.label;
    sel.appendChild(o);
  });
}

async function init() {
  initTargets();
  settings = await VST.loadSettings();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs && tabs[0] ? tabs[0] : null;

  // 如果当前就在被采集的标签页上，直接用运行态
  await refreshState();

  if (runtime.tabId && tab && runtime.tabId !== tab.id) {
    setStatusText(
      "正在为另一个标签页生成字幕（切回去可以看）。当前页要单独开启请先停止。",
      ""
    );
  } else if (!runtime.tabId && tab && BLOCKED.test(tab.url || "")) {
    setStatusText("当前是浏览器内置页面，无法捕获音频", "error");
  }

  renderSettings();
  render();
}

$("toggle").addEventListener("click", toggle);

$("showSource").addEventListener("change", (e) => pushSettings({ showSource: e.target.checked }));

$("fontSize").addEventListener("input", (e) => {
  $("fontSizeVal").textContent = e.target.value;
  settings.fontSize = Number(e.target.value);
});
$("fontSize").addEventListener("change", (e) => pushSettings({ fontSize: Number(e.target.value) }));

$("targetLang").addEventListener("change", (e) => pushSettings({ targetLang: e.target.value }));

$("attachMode").addEventListener("change", (e) => pushSettings({ attachMode: e.target.value }));

$("model").addEventListener("change", async (e) => {
  const model = e.target.value;
  await pushSettings({ model });
  setStatusText(`已切换到 ${model}，正在重新加载识别引擎…`);
});

$("editPos").addEventListener("click", async () => {
  const want = !runtime.editMode;
  const res = await chrome.runtime
    .sendMessage({ to: "bg", type: "editMode", enabled: want })
    .catch((e) => ({ ok: false, error: String(e) }));
  if (res && res.ok) {
    runtime.editMode = res.editMode;
    renderSettings();
    if (res.editMode) setStatusText("在页面上拖动字幕，按 Esc 或点别处完成", "");
  } else {
    setStatusText((res && res.error) || "请先开启实时字幕，再调整位置", "error");
  }
});

$("preview").addEventListener("click", async () => {
  const tid = runtime.tabId || (tab && tab.id);
  if (!tid) return;
  await chrome.tabs.sendMessage(tid, { to: "content", type: "preview" }).catch(() => {});
});

$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ to: "bg", type: "clear" }).catch(() => {});
  runtime.lastLine = null;
  render();
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("openServer").addEventListener("click", () => {
  const url = (settings.serverUrl || "").replace(/^ws/, "http").replace(/\/ws$/, "/");
  if (url) chrome.tabs.create({ url });
});

// 后台推来的状态
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== "ui") return undefined;
  if (msg.type === "state" && msg.state) {
    runtime = msg.state;
    render();
  }
  return undefined;
});

VST.onSettingsChanged((s) => {
  settings = s;
  renderSettings();
});

init();
