/* 设置页：所有改动即时写入 chrome.storage，并立即推给已打开的视频页面。 */

const $ = (id) => document.getElementById(id);
let settings = Object.assign({}, VST.DEFAULTS);
let toastTimer = null;

// ---------------------------------------------------------------------------
function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  items.forEach((it) => {
    const o = document.createElement("option");
    o.value = it.value;
    o.textContent = it.label;
    sel.appendChild(o);
  });
  sel.value = value;
}

function toast(text) {
  const el = $("toast");
  el.textContent = text || "已保存";
  el.setAttribute("data-show", "1");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.setAttribute("data-show", "0"), 1500);
}

function renderPreview() {
  const box = $("pvBox");
  const fs = Number(settings.fontSize) || 22;
  // 预览要跟真实渲染一致：透明度为 0 时不用毛玻璃、不留内边距，
  // 纯靠文字描边 —— 否则预览里看着像有一块浅色底板，实际却不是。
  const bg = Math.max(0, Math.min(1, Number(settings.bgOpacity) || 0));
  const solid = bg > 0.01;
  box.style.background = solid ? `rgba(8, 10, 14, ${bg})` : "transparent";
  box.style.backdropFilter = solid ? "blur(6px)" : "none";
  box.style.padding = solid ? "8px 18px" : "2px 4px";
  box.style.borderRadius = solid ? "10px" : "0";
  box.style.fontFamily = settings.fontFamily || "inherit";
  const outline =
    "-1px -1px 0 rgba(0,0,0,.85), 1px -1px 0 rgba(0,0,0,.85), " +
    "-1px 1px 0 rgba(0,0,0,.85), 1px 1px 0 rgba(0,0,0,.85), " +
    "0 -1px 0 rgba(0,0,0,.85), 0 1px 0 rgba(0,0,0,.85), " +
    "-1px 0 0 rgba(0,0,0,.85), 1px 0 0 rgba(0,0,0,.85), " +
    "0 0 8px rgba(0,0,0,.75), 0 2px 5px rgba(0,0,0,.85)";
  $("pvDst").style.textShadow = outline;
  $("pvSrc").style.textShadow = outline;
  $("pvDst").style.fontSize = fs + "px";
  $("pvDst").style.color = settings.textColor;
  $("pvSrc").style.fontSize = Math.max(11, Math.round(fs * 0.78)) + "px";
  $("pvSrc").style.color = settings.sourceColor;
  $("pvSrc").style.display = settings.showSource ? "" : "none";
  $("pvDst").style.display = settings.showTarget ? "" : "none";
  box.style.display = settings.showSource || settings.showTarget ? "" : "none";
}

function render() {
  $("serverUrl").value = settings.serverUrl;
  $("model").value = settings.model;
  $("sourceLang").value = settings.sourceLang || "";
  $("targetLang").value = settings.targetLang;
  $("translator").value = settings.translator;
  $("attachMode").value = settings.attachMode || "auto";
  $("autoStartServer").checked = settings.autoStartServer !== false;
  $("translatePartials").checked = !!settings.translatePartials;
  $("deeplKey").value = settings.deeplApiKey || "";
  $("openaiBase").value = settings.openaiBaseUrl || "";
  $("openaiModel").value = settings.openaiModel || "";
  $("openaiKey").value = settings.openaiApiKey || "";

  $("showSource").checked = !!settings.showSource;
  $("showTarget").checked = !!settings.showTarget;
  $("showStats").checked = !!settings.showStats;
  $("fontSize").value = settings.fontSize;
  $("fontSizeVal").textContent = settings.fontSize + " px";
  $("fontFamily").value = settings.fontFamily || "";
  $("maxLines").value = settings.maxLines;
  $("maxLinesVal").textContent = settings.maxLines + " 条";
  $("bottomPct").value = settings.bottomPct;
  $("bottomPctVal").textContent = settings.bottomPct + " %";
  $("hAlignPct").value = settings.hAlignPct;
  $("hAlignPctVal").textContent = settings.hAlignPct + " %";
  $("bgOpacity").value = Math.round((settings.bgOpacity || 0) * 100);
  $("bgOpacityVal").textContent = Math.round((settings.bgOpacity || 0) * 100) + " %";
  $("textColor").value = settings.textColor || "#ffffff";
  $("sourceColor").value = settings.sourceColor || "#dbe4f0";
  $("fadeAfterMs").value = settings.fadeAfterMs;
  $("fadeAfterMsVal").textContent = Math.round(settings.fadeAfterMs / 1000) + " s";

  renderPreview();
}

async function update(patch, quiet) {
  settings = await VST.saveSettings(patch);
  render();
  try {
    await chrome.runtime.sendMessage({ to: "bg", type: "settings", settings });
  } catch (e) {
    /* 后台可能没醒，无所谓，storage 变化会广播 */
  }
  if (!quiet) toast();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------
function bindText(id, key) {
  $(id).addEventListener("change", (e) => update({ [key]: e.target.value.trim() }));
}
function bindCheck(id, key) {
  $(id).addEventListener("change", (e) => update({ [key]: e.target.checked }));
}
function bindRange(id, key, transform, labelId, fmt) {
  $(id).addEventListener("input", (e) => {
    const raw = e.target.value;
    settings[key] = transform ? transform(raw) : raw;
    if (labelId) $(labelId).textContent = fmt(raw);
    renderPreview();
  });
  $(id).addEventListener("change", (e) => {
    const raw = e.target.value;
    update({ [key]: transform ? transform(raw) : raw });
  });
}

async function testServer() {
  const el = $("testResult");
  el.innerHTML = "<span class='inline-note'>正在连接…</span>";
  const url = $("serverUrl").value.trim() || VST.DEFAULTS.serverUrl;
  const res = await chrome.runtime.sendMessage({ to: "bg", type: "testServer", url }).catch((e) => ({
    ok: false,
    error: String(e),
  }));

  if (res && res.ok) {
    const t = res.health || {};
    const tr = t.translate || {};
    el.innerHTML =
      "<span class='ok'>✅ 服务正常</span>（v" +
      (t.version || "?") +
      "）<br />识别模型：<code>" +
      (t.model || "?") +
      "</code> ｜ 翻译：<code>" +
      (tr.mode || "?") +
      "</code> → <code>" +
      (tr.target || "?") +
      "</code> ｜ 候选：<code>" +
      ((tr.chain || []).join(" / ") || "未启用") +
      "</code>" +
      (tr.preferred ? " ｜ 已选：<code>" + tr.preferred + "</code>" : "");
  } else {
    el.innerHTML =
      "<span class='bad'>❌ 连不上：</span><code>" +
      escapeHtml((res && res.error) || "未知错误") +
      "</code><br /><span class='inline-note'>请确认本地服务窗口还开着，地址是 <code>" +
      escapeHtml(url) +
      "</code></span>";
  }
}

async function testTranslate() {
  const el = $("translateResult");
  el.innerHTML = "<span class='inline-note'>正在逐个测试翻译服务，最多 15 秒…</span>";
  const res = await chrome.runtime
    .sendMessage({ to: "bg", type: "testTranslate", target: settings.targetLang, settings })
    .catch((e) => ({ ok: false, error: String(e) }));

  if (!res || !res.ok) {
    el.innerHTML = "<span class='bad'>测试失败：</span><code>" + escapeHtml((res && res.error) || "本地服务连不上") + "</code>";
    return;
  }
  const rows = Object.entries(res.data.results || {})
    .map(([name, r]) => {
      const mark = r.ok ? "<span class='ok'>✅</span>" : "<span class='bad'>❌</span>";
      const txt = r.ok ? escapeHtml(r.text || "") : "<code>" + escapeHtml(r.error || "") + "</code>";
      return `<tr><td>${mark} ${name}</td><td>${r.ms} ms</td><td>${txt}</td></tr>`;
    })
    .join("");
  el.innerHTML = `<table class="res"><tr><th>服务</th><th>耗时</th><th>结果</th></tr>${rows}</table>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function init() {
  settings = await VST.loadSettings();

  fillSelect($("model"), VST.MODELS, settings.model);
  fillSelect($("sourceLang"), VST.SOURCES, settings.sourceLang || "");
  fillSelect($("targetLang"), VST.TARGETS, settings.targetLang);
  render();

  bindText("serverUrl", "serverUrl");
  $("model").addEventListener("change", (e) => update({ model: e.target.value }));
  $("sourceLang").addEventListener("change", (e) => update({ sourceLang: e.target.value }));
  $("targetLang").addEventListener("change", (e) => update({ targetLang: e.target.value }));
  $("translator").addEventListener("change", (e) => update({ translator: e.target.value }));
  bindCheck("translatePartials", "translatePartials");
  bindText("deeplKey", "deeplApiKey");
  bindText("openaiBase", "openaiBaseUrl");
  bindText("openaiModel", "openaiModel");
  bindText("openaiKey", "openaiApiKey");

  bindCheck("showSource", "showSource");
  bindCheck("showTarget", "showTarget");
  bindCheck("showStats", "showStats");
  bindText("fontFamily", "fontFamily");
  bindRange("fontSize", "fontSize", Number, "fontSizeVal", (v) => v + " px");
  bindRange("maxLines", "maxLines", Number, "maxLinesVal", (v) => v + " 条");
  bindRange("bottomPct", "bottomPct", Number, "bottomPctVal", (v) => v + " %");
  bindRange("hAlignPct", "hAlignPct", Number, "hAlignPctVal", (v) => v + " %");
  $("attachMode").addEventListener("change", (e) => update({ attachMode: e.target.value }));
  bindRange("bgOpacity", "bgOpacity", (v) => Number(v) / 100, "bgOpacityVal", (v) => v + " %");
  bindRange("fadeAfterMs", "fadeAfterMs", Number, "fadeAfterMsVal", (v) => Math.round(v / 1000) + " s");

  $("textColor").addEventListener("input", (e) => {
    settings.textColor = e.target.value;
    renderPreview();
  });
  $("textColor").addEventListener("change", (e) => update({ textColor: e.target.value }));
  $("sourceColor").addEventListener("input", (e) => {
    settings.sourceColor = e.target.value;
    renderPreview();
  });
  $("sourceColor").addEventListener("change", (e) => update({ sourceColor: e.target.value }));

  $("testServer").addEventListener("click", testServer);
  bindCheck("autoStartServer", "autoStartServer");
  $("testAutoStart").addEventListener("click", async () => {
    const el = $("testResult");
    el.innerHTML = "<span class='inline-note'>正在调用本地启动器（最多等 15 秒）…</span>";
    const res = await chrome.runtime
      .sendMessage({ to: "bg", type: "ensureServer" })
      .catch((e) => ({ ok: false, result: { error: String(e) } }));
    const r = (res && res.result) || {};
    if (res && res.ok) {
      el.innerHTML =
        "<span class='ok'>✅ 自动启动组件正常</span> 状态：<code>" +
        (r.status || "?") +
        "</code>" +
        (r.status === "already-running" ? "（服务本来就在跑）" : "（已拉起服务）");
    } else {
      el.innerHTML =
        "<span class='bad'>❌ 自动启动组件不可用：</span><code>" +
        escapeHtml(r.error || "未知错误") +
        "</code><br /><span class='inline-note'>" +
        escapeHtml(r.hint || "请重新运行 scripts\\install.ps1 注册组件；不注册也不影响使用，手动启动服务即可。") +
        "</span>";
    }
  });
  $("testTranslate").addEventListener("click", testTranslate);
  $("openStatus").addEventListener("click", () => {
    const url = ($("serverUrl").value || "").replace(/^ws/, "http").replace(/\/ws$/, "/");
    if (url) chrome.tabs.create({ url });
  });

  $("reset").addEventListener("click", async () => {
    if (!confirm("确定要把所有设置恢复成默认值吗？")) return;
    settings = await VST.saveSettings(Object.assign({}, VST.DEFAULTS));
    render();
    await chrome.runtime.sendMessage({ to: "bg", type: "settings", settings }).catch(() => {});
    toast("已恢复默认");
  });

  $("exportCfg").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vst-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  });

  $("importCfg").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      settings = await VST.saveSettings(Object.assign({}, VST.DEFAULTS, data));
      render();
      await chrome.runtime.sendMessage({ to: "bg", type: "settings", settings }).catch(() => {});
      toast("导入成功");
    } catch (err) {
      alert("配置文件解析失败：" + err.message);
    }
    e.target.value = "";
  });

  $("openReadme").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
  });

  VST.onSettingsChanged((s) => {
    settings = s;
    render();
  });
}

init();
