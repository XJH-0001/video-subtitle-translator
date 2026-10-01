/*
 * 在真实 Edge 里加载扩展，用 CDP 做端到端验证。
 *
 *     node tools/verify_extension.mjs
 *
 * 自己起一个测试网页（含真实 <video>），所以不需要另外跑本地服务。
 * 检查项：
 *   1. 扩展能否加载、Service Worker 有没有报错
 *   2. common.js 有没有被 importScripts 带进来
 *   3. content script 能否注入并收发消息
 *   4. 字幕浮层能否渲染（Shadow DOM + 双语）
 *   5. 是否进了浏览器顶层（全屏能看见）、是否挡住页面点击
 *   6. 编辑模式 + 真实鼠标拖动
 *   7. 【自动贴合视频】字幕是否贴在「画面」底边（含黑边补偿）
 *   8. 【自动跟随】改变视频尺寸后字幕会不会跟着走
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT = resolve(import.meta.dirname, "..", "extension");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\Application\\msedge.exe"),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((p) => p && existsSync(p));

const CDP_PORT = 9333;
const WEB_PORT = 8791;
const PROFILE = mkdtempSync(join(tmpdir(), "vst-verify-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;

const ok = (m) => { console.log(`  \x1b[32m[通过]\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m[失败]\x1b[0m ${m}`); fail++; };
const info = (m) => console.log(`  \x1b[36m[信息]\x1b[0m ${m}`);

// ---------------------------------------------------------------------------
// 测试网页：一个 1280x720 的真实视频流，放进 900x600 的框里 → 上下必然有黑边
// ---------------------------------------------------------------------------
const VIDEO_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>字幕贴合测试</title>
<style>
  html,body{margin:0;background:#0b0d12;color:#333;font-family:sans-serif}
  #wrap{width:900px;height:600px;margin:40px auto;background:#000;position:relative}
  #v{width:100%;height:100%;display:block}
  #hint{text-align:center;color:#889;font-size:13px}
</style></head><body>
<div id="wrap"><video id="v" muted playsinline autoplay></video></div>
<div id="hint">测试页面：视频源 1280×720，显示框 900×600（上下会有黑边）</div>
<script>
  const v = document.getElementById('v');
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const ctx = c.getContext('2d');
  let t = 0;
  setInterval(() => {
    t++;
    ctx.fillStyle = 'hsl(' + (t % 360) + ',55%,42%)';
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = '#fff';
    ctx.font = '48px sans-serif';
    ctx.fillText('frame ' + t, 40, 700);
  }, 100);
  try {
    v.srcObject = c.captureStream(10);
    v.play().catch(() => {});
  } catch (e) {}
  window.__testVideo = v;
  window.__setWrapSize = (w, h) => {
    document.getElementById('wrap').style.width = w + 'px';
    document.getElementById('wrap').style.height = h + 'px';
  };
</script>
</body></html>`;

const PLAIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>普通页面</title><style>body{margin:0;font-family:sans-serif}th,td{padding:8px}</style></head>
<body><h1>普通页面</h1><table><tr><th>列</th></tr><tr><td>行</td></tr></table></body></html>`;

function startTestServer() {
  const server = createServer((req, res) => {
    const isVideo = String(req.url).startsWith("/video");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(isVideo ? VIDEO_PAGE : PLAIN_PAGE);
  });
  return new Promise((r) => server.listen(WEB_PORT, "127.0.0.1", () => r(server)));
}

const PLAIN_URL = `http://127.0.0.1:${WEB_PORT}/plain`;
const VIDEO_URL = `http://127.0.0.1:${WEB_PORT}/video`;

// ---------------------------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("CDP 连接失败"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, timeoutMs);
    });
  }
  async evalIn(expression, awaitPromise = true, timeoutMs = 30000) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "JS 执行出错");
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

const getJson = async (url) => (await fetch(url)).json();

/** 在扩展的 Service Worker 里跑一段代码（可以直接用 chrome.* API）
 *
 *  MV3 的 Service Worker 空闲会被浏览器回收，唤醒偶尔要几秒，
 *  所以超时（通常是 SW 在休眠）就重试一次，别让偶发失败污染回归结果。
 *
 *  timeoutMs 用于「本地启动器」那种真的会慢的调用：
 *  它会拉起一个新服务，而默认模型是 large-v3-turbo（2.5GB），
 *  如果此时回归自己的服务也占着显存，加载会明显变慢，30 秒不够。
 */
async function swEval(cdp, body, timeoutMs = 30000) {
  const expr = `(async () => { ${body} })()`;
  try {
    return await cdp.evalIn(expr, true, timeoutMs);
  } catch (e) {
    if (!/超时/.test(String(e))) throw e;
    // 敲一下 SW 把它叫醒，再试一次
    try {
      await cdp.evalIn(`chrome.runtime.getManifest().version`);
    } catch {}
    return await cdp.evalIn(expr, true, timeoutMs);
  }
}

/** 找到某个 URL 对应的标签页并确保 content script 已注入 */
async function ensureContent(cdp, urlPrefix) {
  return swEval(cdp, `
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(urlPrefix)}));
    if (!tab) return JSON.stringify({ ok: false, reason: "没有找到标签页", urls: tabs.map(t => t.url) });
    const diag = { tabId: tab.id, url: tab.url, status: tab.status };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["common.js", "content.js"] });
      diag.injected = true;
    } catch (e) {
      diag.injected = false;
      diag.injectError = String(e);
    }
    await new Promise(r => setTimeout(r, 400));
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { to: "content", type: "ping" });
      diag.ping = res === undefined ? "(undefined)" : JSON.stringify(res);
      return JSON.stringify(Object.assign({ ok: !!(res && res.ok) }, diag));
    } catch (e) {
      diag.pingError = String(e);
      return JSON.stringify(Object.assign({ ok: false, reason: String(e) }, diag));
    }
  `);
}

/** 在页面主世界里取字幕层的几何信息 */
async function probePage(cdp, urlPrefix, funcBody) {
  const raw = await swEval(cdp, `
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(urlPrefix)}));
    if (!tab) return JSON.stringify({ ok: false, reason: "no tab" });
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const host = document.getElementById("vst-subtitle-host");
      if (!host) return { ok: false, reason: "没有 host" };
      ${funcBody}
    }});
    return JSON.stringify(res[0].result);
  `);
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(66));
  console.log("  Edge 扩展加载验证");
  console.log("=".repeat(66));

  if (!EDGE) {
    console.log("  找不到 Edge / Chrome，跳过。");
    return 0;
  }
  info(`浏览器：${EDGE}`);
  info(`扩展目录：${EXT}`);

  const web = await startTestServer();
  const proc = spawn(EDGE, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-extensions-except=" + EXT,
    "--load-extension=" + EXT,
    "--user-data-dir=" + PROFILE,
    "--remote-debugging-port=" + CDP_PORT,
    "--remote-allow-origins=*",
    "about:blank",
  ], { stdio: "ignore" });

  let cdp = null;
  try {
    let version = null;
    for (let i = 0; i < 60; i++) {
      try { version = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch { await sleep(500); }
    }
    if (!version) { bad("调试端口没起来（可能是 --load-extension 被浏览器禁用了）"); return 1; }
    info(`浏览器版本：${version.Browser}`);

    // --- 找我们自己的 Service Worker（Edge 自带一堆内置扩展，别认错）---------
    const targets = [];
    for (let i = 0; i < 40; i++) {
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => []);
      targets.length = 0;
      targets.push(...list.filter((t) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://")));
      if (targets.length > 1) break;
      await sleep(400);
    }
    if (!targets.length) { bad("没有发现任何扩展的 Service Worker"); return 1; }

    const EXPECTED = "视频实时字幕翻译";
    let ours = null;
    const names = [];
    for (const t of targets) {
      const probe = new CDP(t.webSocketDebuggerUrl);
      try {
        await probe.ready;
        let name = null;
        for (let a = 0; a < 6 && name === null; a++) {
          try { name = await probe.evalIn(`chrome.runtime.getManifest().name`); } catch { await sleep(400); }
        }
        names.push(`${t.url} -> ${name === null ? "(读取失败)" : JSON.stringify(name)}`);
        if (name === EXPECTED) { ours = { target: t, cdp: probe }; break; }
        probe.close();
      } catch (e) {
        names.push(`${t.url} -> (连接失败 ${e.message})`);
        probe.close();
      }
    }
    if (!ours) {
      bad(`没有找到我们的扩展（期望 name = "${EXPECTED}"）`);
      names.forEach((n) => console.log(`      ${n}`));
      return 1;
    }
    cdp = ours.cdp;
    ok(`扩展已加载，Service Worker 已注册 (id=${new URL(ours.target.url).host.slice(0, 12)}…)`);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable").catch(() => {});

    const m = JSON.parse(await cdp.evalIn(
      `JSON.stringify({name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version})`
    ));
    ok(`manifest 可读：${m.name} v${m.version}`);

    const v = JSON.parse(await cdp.evalIn(
      `JSON.stringify({hasVST: typeof VST !== "undefined", url: typeof VST !== "undefined" ? VST.DEFAULTS.serverUrl : null, attach: typeof VST !== "undefined" ? VST.DEFAULTS.attachMode : null})`
    ));
    if (v.hasVST && v.url) ok(`common.js 已注入（服务地址 ${v.url}，默认贴合模式 ${v.attach})`);
    else bad("common.js 没生效，VST 未定义");

    // --- 打开普通页面，测注入 / 渲染 / 顶层 --------------------------------
    await cdp.send("Target.createTarget", { url: PLAIN_URL });
    await sleep(2200);
    const inj = JSON.parse(await ensureContent(cdp, PLAIN_URL));
    if (inj.ok) ok("content script 已注入页面，能收发消息");
    else bad(`content script 注入失败：${inj.reason || "未知"} ${inj.urls ? JSON.stringify(inj.urls) : ""}`);

    if (inj.ok) {
      // 先发一条字幕，再把浮层状态取回来
      await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(PLAIN_URL)}));
        await chrome.tabs.sendMessage(tab.id, { to: "content", type: "line", line: {
          id: 1, final: false, source: "Verification line.", translated: "验证字幕。", lang: "en" }});
        await chrome.tabs.sendMessage(tab.id, { to: "content", type: "state", state: { status: "running" } });
        await new Promise(r => setTimeout(r, 400));
        return "ok";
      `);
      const o = await probePage(cdp, PLAIN_URL, `
        const txt = host.shadowRoot.textContent || "";
        const box = host.shadowRoot.querySelector(".vst-box");
        const dst = host.shadowRoot.querySelector(".vst-dst");
        const probe = (x, y) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return "null(被顶层挡住)";
          if (el.id === "vst-subtitle-host") return "vst-host(被字幕挡住)";
          return el.tagName.toLowerCase();
        };
        const boxBg = box ? getComputedStyle(box).backgroundColor : "";
        return {
          ok: true,
          hasSrc: txt.includes("Verification line."),
          hasDst: txt.includes("验证字幕。"),
          popover: host.getAttribute("popover"),
          isOpen: (() => { try { return host.matches(":popover-open"); } catch (e) { return "unknown"; } })(),
          pointerEvents: getComputedStyle(host).pointerEvents,
          zIndex: getComputedStyle(host).zIndex,
          backdropRule: !!document.getElementById("vst-backdrop-style"),
          hitCenter: probe(innerWidth / 2, innerHeight / 2),
          hitCorner: probe(12, 12),
          boxVisible: box ? box.getAttribute("data-empty") === "0" : false,
          // 底色透明相关：默认应该「没有底板」，靠文字描边保证可读
          dataBg: host.getAttribute("data-bg"),
          boxBg,
          boxBlur: box ? getComputedStyle(box).backdropFilter : "",
          dstShadow: dst ? getComputedStyle(dst).textShadow : "",
        };
      `);
      if (o.ok && o.hasSrc && o.hasDst) ok("字幕浮层渲染成功（Shadow DOM，原文+译文都在）");
      else bad(`字幕浮层渲染不出来：${JSON.stringify(o)}`);

      // --- 字幕底色默认全透明（不挡画面）-------------------------------------
      // 原生字幕就是「无底板 + 文字描边」。有黑色底板会明显影响观感。
      info(`底色: data-bg=${o.dataBg} background=${o.boxBg} blur=${o.boxBlur}`);
      const bgTransparent = /^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(String(o.boxBg).replace(/\s+/g, " "));
      if (o.dataBg === "0" && bgTransparent) ok("字幕底色默认全透明（没有黑色底板）");
      else bad(`字幕底色不是透明的：data-bg=${o.dataBg} background=${o.boxBg}`);
      // 注意：浏览器会把 transparent 归一化成 rgba(0, 0, 0, 0) ——
      // 别看到 rgba 就以为有底色，要看 alpha 是不是 0。
      const am = String(o.boxBg).match(/rgba\([^)]*,\s*([\d.]+)\)/);
      if (am && Number(am[1]) > 0.01) bad(`透明模式下却有不透明底板：alpha=${am[1]}`);
      else ok("底色 alpha 为 0（确实完全透出画面）");
      if (o.boxBlur && o.boxBlur !== "none") bad(`透明模式还在用毛玻璃，会留一圈「空气墙」：${o.boxBlur}`);
      else ok("透明模式已关掉毛玻璃（不会留一圈模糊底板）");
      // 没底色就必须有描边，否则亮画面上看不清
      if (/rgba?\(0,\s*0,\s*0/.test(String(o.dstShadow)) && String(o.dstShadow).split(",").length >= 8) {
        ok("文字有八方向描边（无底色也看得清）");
      } else {
        bad(`文字描边不足，亮画面上会看不清：${String(o.dstShadow).slice(0, 80)}`);
      }

      // --- 中间字幕的「平滑显现」（解决一顿一顿）------------------------
      // 中间字幕是整行替换的，如果直接 setTextContent 就会一顿一顿地跳。
      // 期望：文本延长时，先短暂显示旧文本，再在 ~300ms 内补齐到新文本。
      // 无头浏览器默认 prefers-reduced-motion=reduce，会把动画关掉（真机跟随系统设置），
      // 所以先用 CDP 模拟成 no-preference。
      const pageForMedia = (await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(
        (t) => t.type === "page" && String(t.url).startsWith(PLAIN_URL)
      );
      if (pageForMedia) {
        const mcdp = new CDP(pageForMedia.webSocketDebuggerUrl);
        try {
          await mcdp.ready;
          await mcdp.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
          });
        } catch (e) {
          info(`模拟媒体特性失败（不影响其他检查）：${e.message}`);
        }
        mcdp.close();
      }

      const smoothTest = await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(PLAIN_URL)}));
        const send = (line) => chrome.tabs.sendMessage(tab.id, { to: "content", type: "line", line });

        // 无头浏览器默认 prefers-reduced-motion=reduce，会把平滑显现关掉。
        // CDP 的 Emulation.setEmulatedMedia 对隔离世界不生效，所以直接在这里覆盖 matchMedia——
        // executeScript({func}) 和 content script 跑在同一个隔离世界，改的是同一个全局。
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          const orig = window.matchMedia.bind(window);
          window.matchMedia = (q) => (String(q).includes("prefers-reduced-motion")
            ? { matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }
            : orig(q));
        }});

        const read = async () => {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
            const h = document.getElementById("vst-subtitle-host");
            const all = h.shadowRoot.querySelectorAll(".vst-src");
            const src = all[all.length - 1];
            return {
              text: src ? src.textContent : null,
              reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
              visibility: document.visibilityState,
            };
          }});
          return r[0].result;
        };

        await send({ id: 99, final: false, source: "The quick brown", translated: null });
        await new Promise(r => setTimeout(r, 150));
        const before = await read();
        await send({ id: 99, final: false, source: "The quick brown fox jumps over the lazy dog", translated: null });
        const samples = [];
        for (const wait of [40, 60, 100, 200, 500]) {
          await new Promise(r => setTimeout(r, wait));
          const s = await read();
          samples.push({ t: wait, len: s.text ? s.text.length : -1, reduced: s.reduced, vis: s.visibility });
        }
        return JSON.stringify({ before, samples });
      `);
      const st = JSON.parse(smoothTest);
      const FULL = "The quick brown fox jumps over the lazy dog";
      const lens = st.samples.map((s) => s.len);
      const settledLen = lens[lens.length - 1];
      const animated = lens.some((l) => l > 0 && l < FULL.length);
      info(`平滑显现采样：起始 ${st.before.text}（${st.before.text ? st.before.text.length : 0} 字）→ 长度序列 [${lens.join(", ")}]`);
      info(`  页面可见性=${st.before.visibility} prefers-reduced-motion=${st.before.reduced}`);
      if (settledLen === FULL.length && animated) {
        ok(`中间字幕平滑显现生效（长度逐步 ${lens.join(" → ")}）`);
      } else if (settledLen === FULL.length && !animated) {
        bad(`中间字幕是瞬间替换的（长度一直是 ${settledLen}），平滑显现没生效`);
      } else {
        bad(`平滑显现结果异常：${smoothTest}`);
      }

      // --- 音频回放路径（不能因为一次改动把声音弄坏）--------------------------
      // 标签页音频被 tabCapture 拿走之后必须由扩展放回去。以前接回 AudioContext，
      // 那会让声音按上下文采样率再渲染一遍（重采样后送设备），高频发闷。
      // 现在优先用 <audio srcObject> 走原生媒体管线，失败才回退。
      // 这里验证两件事：组合用途能不能建 offscreen，以及 offscreen 里 <audio> 能不能播。
      const audioTest = await swEval(cdp, `
        const out = { create: null, playable: null, err: null };
        try {
          const has = await chrome.offscreen.hasDocument();
          if (has) await chrome.offscreen.closeDocument();
          await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
            justification: "验证组合用途",
          });
          out.create = "both";
        } catch (e) {
          out.create = "failed";
          out.err = String(e).slice(0, 120);
          try {
            await chrome.offscreen.createDocument({
              url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "退回验证",
            });
            out.create = "user-media-only";
          } catch (e2) { out.create = "none"; }
        }
        return JSON.stringify(out);
      `);
      const at = JSON.parse(audioTest);
      if (at.create === "both") {
        ok("offscreen 接受 [USER_MEDIA, AUDIO_PLAYBACK] 组合用途（<audio> 回放可用）");
      } else if (at.create === "user-media-only") {
        info(`组合用途被拒（${at.err}），退回仅 USER_MEDIA —— 与服务端代码里的回退一致`);
      } else {
        bad(`offscreen 文档建不起来：${at.err}`);
      }
      // 不论走哪条，只要创建成功就说明回退链路是通的
      if (at.create !== "none") ok("offscreen 文档创建成功（音频回放不会因此失效）");

      // --- 同屏只显示一条字幕（默认 maxLines=1）------------------------------
      // 默认显示 2 条时，连续说话会让上一句留在画面上，看着像「两行字幕」。
      const oneLineTest = await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(PLAIN_URL)}));
        const send = (line) => chrome.tabs.sendMessage(tab.id, { to: "content", type: "line", line });
        const count = async () => {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
            const h = document.getElementById("vst-subtitle-host");
            return h ? h.shadowRoot.querySelectorAll(".vst-line").length : -1;
          }});
          return r[0].result;
        };
        await send({ id: 300, final: true, source: "First line of dialogue.", translated: "第一句台词。" });
        await new Promise(r => setTimeout(r, 250));
        const afterFirst = await count();
        await send({ id: 301, final: true, source: "Second line of dialogue.", translated: "第二句台词。" });
        await new Promise(r => setTimeout(r, 250));
        const afterSecond = await count();
        await send({ id: 302, final: true, source: "Third line of dialogue.", translated: "第三句台词。" });
        await new Promise(r => setTimeout(r, 250));
        const afterThird = await count();
        return JSON.stringify({ afterFirst, afterSecond, afterThird });
      `);
      const ol = JSON.parse(oneLineTest);
      info(`同屏条数：第1句后=${ol.afterFirst} 第2句后=${ol.afterSecond} 第3句后=${ol.afterThird}`);
      if (ol.afterSecond === 1 && ol.afterThird === 1) {
        ok("同屏只显示 1 条字幕（新的顶掉旧的，不会叠成两行）");
      } else {
        bad(`同屏出现了多条字幕：${oneLineTest}`);
      }

      // --- 原文和译文一样时只显示一行（语气词场景）------------------------------
      // 服务端判定「啊」「哈哈」「uh」这类语气词不值得翻译，直接把原文当译文发过来。
      // 前端必须把重复的那行合并掉，否则会显示两遍「啊」。
      //
      // 注意：这里要**显式打开「显示原文」**，因为默认值是 false（只显示译文）。
      // 不打开的话「原文==译文才合并」这条逻辑根本测不到 —— 原文本来就不显示。
      const sameTest = await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(PLAIN_URL)}));
        const send = (line) => chrome.tabs.sendMessage(tab.id, { to: "content", type: "line", line });
        const set = (s) => chrome.tabs.sendMessage(tab.id, { to: "content", type: "settings", settings: s });
        const read = async () => {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
            const h = document.getElementById("vst-subtitle-host");
            if (!h) return null;
            const lines = [...h.shadowRoot.querySelectorAll(".vst-line")];
            const last = lines[lines.length - 1];
            if (!last) return null;
            const s = last.querySelector(".vst-src");
            const d = last.querySelector(".vst-dst");
            const vis = (el) => el && getComputedStyle(el).display !== "none" && el.textContent.trim() !== "";
            return { srcShown: vis(s), dstShown: vis(d), src: s ? s.textContent : "", dst: d ? d.textContent : "" };
          }});
          return r[0].result;
        };

        await set({ showSource: true, showTarget: true });   // 双语模式，才能测到「重复才合并」
        await new Promise(r => setTimeout(r, 300));

        // 语气词：原文 == 译文 → 应合并成一行
        await send({ id: 400, final: true, source: "啊", translated: "啊" });
        await new Promise(r => setTimeout(r, 300));
        const filler = await read();
        // 正常句子：两行都该显示（别误伤双语字幕）
        await send({ id: 401, final: true, source: "Hello there.", translated: "你好。" });
        await new Promise(r => setTimeout(r, 300));
        const normal = await read();
        return JSON.stringify({ filler, normal });
      `);
      const sm = JSON.parse(sameTest);
      info(`语气词：src显示=${sm.filler && sm.filler.srcShown} dst显示=${sm.filler && sm.filler.dstShown} 内容=${JSON.stringify(sm.filler && sm.filler.dst)}`);
      if (sm.filler && sm.filler.dstShown && !sm.filler.srcShown) {
        ok("语气词原文=译文时合并成一行（不会显示两遍「啊」）");
      } else {
        bad(`语气词没合并：${sameTest}`);
      }
      if (sm.normal && sm.normal.srcShown && sm.normal.dstShown) {
        ok("正常句子仍然显示原文+译文两行（没误伤双语字幕）");
      } else {
        bad(`正常句子被误合并了：${JSON.stringify(sm.normal)}`);
      }

      // --- 只显示译文时，原文不该先冒出来 --------------------------------------
      // 服务端是分两条消息发的：先发只有原文的，再发带译文的。
      // 如果「显示原文」关着，第一条必须整行隐藏 —— 否则用户会看到
      // 「先闪一下原文，译文才补上」，感觉像先显示原文再显示译文。
      const monoTest = await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(PLAIN_URL)}));
        const send = (line) => chrome.tabs.sendMessage(tab.id, { to: "content", type: "line", line });
        const set = (s) => chrome.tabs.sendMessage(tab.id, { to: "content", type: "settings", settings: s });
        const read = async () => {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
            const h = document.getElementById("vst-subtitle-host");
            if (!h) return null;
            const lines = [...h.shadowRoot.querySelectorAll(".vst-line")]
              .filter(el => !el.classList.contains("vst-placeholder"));
            const last = lines[lines.length - 1];
            if (!last) return null;
            const s = last.querySelector(".vst-src");
            const d = last.querySelector(".vst-dst");
            const vis = (el) => !!(el && getComputedStyle(el).display !== "none" &&
              el.textContent.trim() !== "" && getComputedStyle(last).display !== "none");
            return { lineShown: getComputedStyle(last).display !== "none", srcShown: vis(s), dstShown: vis(d) };
          }});
          return r[0].result;
        };

        await set({ showSource: false, showTarget: true });
        await new Promise(r => setTimeout(r, 350));

        // 第一条：只有原文（译文还没翻出来）
        await send({ id: 500, final: true, source: "Only the original text here.", translated: null });
        await new Promise(r => setTimeout(r, 350));
        const during = await read();

        // 第二条：译文到了
        await send({ id: 500, final: true, source: null, translated: "只有译文。" });
        await new Promise(r => setTimeout(r, 350));
        const after = await read();

        await set({ showSource: true, showTarget: true });   // 还原，别影响后面的检查
        return JSON.stringify({ during, after });
      `);
      const mo = JSON.parse(monoTest);
      info(`只显示译文时：原文到达后 整行显示=${mo.during && mo.during.lineShown} 原文=${mo.during && mo.during.srcShown}；译文到达后 译文=${mo.after && mo.after.dstShown}`);
      if (mo.during && !mo.during.srcShown && !mo.during.lineShown) {
        ok("关掉「显示原文」后，原文不会先冒出来（直接等译文）");
      } else {
        bad(`原文提前冒出来了：${monoTest}`);
      }
      if (mo.after && mo.after.dstShown && !mo.after.srcShown) {
        ok("译文到达后直接显示译文（没有多余的原文行）");
      } else {
        bad(`译文显示不对：${JSON.stringify(mo.after)}`);
      }

      // --- 有人开始说新一句 → 旧字幕要立刻撤掉 -------------------------------
      // 识别天生有半秒到一秒延迟。等新字幕出来时说话的人往往已经换了，
      // 旧字幕还挂着就会被误当成「下一个人在说的内容」。
      // 服务端在 VAD 刚开新一段时就发 speech 信号，客户端据此立刻淡掉旧字幕。
      const staleTest = await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(PLAIN_URL)}));
        const send = (m) => chrome.tabs.sendMessage(tab.id, m);
        const read = async () => {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
            const h = document.getElementById("vst-subtitle-host");
            if (!h) return { stale: null, lines: -1, opacity: null };
            const box = h.shadowRoot.querySelector(".vst-box");
            return {
              stale: h.getAttribute("data-stale") === "1",
              lines: h.shadowRoot.querySelectorAll(".vst-line").length,
              opacity: box ? getComputedStyle(box).opacity : null,
            };
          }});
          return r[0].result;
        };

        // 先放一条最终字幕
        await send({ to: "content", type: "line", line: { id: 200, final: true, source: "The previous speaker finished a sentence here.", translated: "上一位说话人说完了一句。" } });
        await new Promise(r => setTimeout(r, 300));
        const before = await read();

        // 再模拟「有人开始说话了」
        await send({ to: "content", type: "speech", state: "start" });
        await new Promise(r => setTimeout(r, 60));
        const during = await read();
        await new Promise(r => setTimeout(r, 400));
        const after = await read();
        return JSON.stringify({ before, during, after });
      `);
      const stl = JSON.parse(staleTest);
      info(`旧字幕撤回：说话前 行数=${stl.before.lines} / 信号后 0.06s 行数=${stl.during.lines} 透明度=${stl.during.opacity} / 0.46s 后 行数=${stl.after.lines}`);
      if (stl.before.lines > 0 && stl.after.lines === 0) {
        ok("有人开始说新一句时，上一句字幕会被撤掉（不会错挂在下一个人身上）");
      } else {
        bad(`旧字幕没有及时撤掉：${staleTest}`);
      }
      if (stl.during.stale === true || Number(stl.during.opacity) < 1) {
        ok("旧字幕是先淡出再撤（不是硬闪一下）");
      } else {
        bad(`旧字幕没有淡出过渡：stale=${stl.during.stale} opacity=${stl.during.opacity}`);
      }

      // --- 说完没人接话要自动消失（不然字幕一直挂着影响观感）------------------
      const hideTest = await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(PLAIN_URL)}));
        const send = (line) => chrome.tabs.sendMessage(tab.id, { to: "content", type: "line", line });
        const read = async () => {
          const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
            const h = document.getElementById("vst-subtitle-host");
            if (!h) return { hidden: null, lines: -1 };
            return {
              hidden: h.getAttribute("data-hidden") === "1",
              lines: h.shadowRoot.querySelectorAll(".vst-line").length,
              text: (h.shadowRoot.textContent || "").trim().slice(0, 40),
            };
          }});
          return r[0].result;
        };
        // 一句 2 秒的短句
        await send({ id: 120, final: true, source: "Auto hide test.", translated: "自动隐藏测试。", t0: 10, t1: 12 });
        await new Promise(r => setTimeout(r, 1200));
        const during = await read();
        // 按内容算出来大约 3.6 秒停留 + 0.6 秒淡出，等 7 秒足够
        await new Promise(r => setTimeout(r, 6400));
        const after = await read();
        return JSON.stringify({ during, after });
      `);
      const ht = JSON.parse(hideTest);
      info(`停留检查：1.2s 时 隐藏=${ht.during.hidden} 行数=${ht.during.lines}；7.6s 时 隐藏=${ht.after.hidden} 行数=${ht.after.lines}`);
      if (ht.during.hidden === false && ht.after.hidden === true && ht.after.lines === 0) {
        ok("说完没人接话后字幕会自动淡出并清掉（不再一直挂在画面上）");
      } else if (ht.after.hidden !== true) {
        bad(`字幕不会自动消失（7.6 秒后仍未隐藏）：${hideTest}`);
      } else {
        bad(`自动消失行为异常：${hideTest}`);
      }
      info(`popover=${o.popover} 已入顶层=${o.isOpen} pointer-events=${o.pointerEvents} z-index=${o.zIndex}`);
      if (o.pointerEvents === "none") ok("默认不拦截鼠标事件（不会挡住视频点击）");
      else bad(`pointer-events 是 ${o.pointerEvents}`);
      if (o.backdropRule) ok("已注入 ::backdrop 屏蔽规则");
      else bad("缺少 ::backdrop 屏蔽规则");
      if (!String(o.hitCenter).startsWith("null") && !String(o.hitCenter).startsWith("vst-host")) {
        ok(`页面点击未被遮挡（屏幕中心命中 ${o.hitCenter}）`);
      } else {
        bad(`页面点击被遮挡：center=${o.hitCenter}`);
      }
    }

    // --- 视频自动贴合（核心新功能）-----------------------------------------
    console.log("");
    info("打开含真实 <video> 的测试页，检查自动贴合");
    await cdp.send("Target.createTarget", { url: VIDEO_URL });
    await sleep(3500);
    const vp = JSON.parse(await ensureContent(cdp, VIDEO_URL));
    if (!vp.ok) {
      bad(`视频页注入失败：${vp.reason || vp.pingError || vp.injectError || JSON.stringify(vp)}`);
    } else {
      // 让视频先播起来，并且把字幕显示出来
      await swEval(cdp, `
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(t => t.url && t.url.startsWith(${JSON.stringify(VIDEO_URL)}));
        await chrome.tabs.sendMessage(tab.id, { to: "content", type: "settings", settings: { attachMode: "auto", bottomPct: 8, hAlignPct: 50, showSource: true, showTarget: true } });
        await chrome.tabs.sendMessage(tab.id, { to: "content", type: "line", line: { id: 7, final: true, source: "Auto attach test.", translated: "自动贴合测试。", lang: "en" } });
        await chrome.tabs.sendMessage(tab.id, { to: "content", type: "state", state: { status: "running" } });
        await new Promise(r => setTimeout(r, 1200));
        return "ok";
      `);

      const geo = await probePage(cdp, VIDEO_URL, `
        const v = window.__testVideo || document.querySelector("video");
        const wrap = document.getElementById("wrap");
        const hr = host.getBoundingClientRect();
        const vr = v.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        const vw = v.videoWidth, vh = v.videoHeight;
        // 期望：画面区域（contain 适配，居中）
        let pic = { left: vr.left, top: vr.top, width: vr.width, height: vr.height };
        if (vw && vh) {
          const ar = vw / vh, boxAr = vr.width / vr.height;
          if (boxAr > ar) { const w = vr.height * ar; pic = { left: vr.left + (vr.width - w)/2, top: vr.top, width: w, height: vr.height }; }
          else { const h = vr.width / ar; pic = { left: vr.left, top: vr.top + (vr.height - h)/2, width: vr.width, height: h }; }
        }
        const wantX = pic.left + pic.width * 0.5;
        const wantY = pic.top + pic.height * (1 - 0.08);
        return {
          ok: true,
          videoW: vw, videoH: vh,
          paused: v.paused,
          videoRect: { left: Math.round(vr.left), top: Math.round(vr.top), width: Math.round(vr.width), height: Math.round(vr.height) },
          videoBottom: Math.round(vr.bottom),
          pic: { left: Math.round(pic.left), top: Math.round(pic.top), width: Math.round(pic.width), height: Math.round(pic.height) },
          host: { left: Math.round(hr.left), top: Math.round(hr.top), right: Math.round(hr.right), bottom: Math.round(hr.bottom), w: Math.round(hr.width), h: Math.round(hr.height) },
          hostCenterX: Math.round(hr.left + hr.width / 2),
          hostBottom: Math.round(hr.bottom),
          wantX: Math.round(wantX),
          wantY: Math.round(wantY),
        };
      `);

      if (!geo.ok) {
        bad(`取不到页面几何信息：${geo.reason}`);
      } else {
        info(`视频源 ${geo.videoW}×${geo.videoH}（paused=${geo.paused}），元素框 ${geo.videoRect.width}×${geo.videoRect.height}`);
        info(`画面区域：${geo.pic.width}×${geo.pic.height}，上下黑边各 ${Math.round((geo.videoRect.height - geo.pic.height) / 2)}px`);
        info(`字幕底边 y=${geo.hostBottom}，画面底边 y=${geo.pic.top + geo.pic.height}，期望位置 y=${geo.wantY}`);

        if (geo.videoW > 0) ok(`真实视频流已就绪（${geo.videoW}×${geo.videoH}）`);
        else bad("视频没播起来，videoWidth 为 0 —— 测不了黑边补偿");

        const dy = Math.abs(geo.hostBottom - geo.wantY);
        const dx = Math.abs(geo.hostCenterX - geo.wantX);
        if (geo.videoW > 0 && dy <= 3 && dx <= 3) {
          ok(`字幕精确贴在画面底部（水平偏差 ${dx}px，垂直偏差 ${dy}px）`);
        } else {
          bad(`贴合位置不对：水平偏差 ${dx}px，垂直偏差 ${dy}px（应 ≤3px）`);
        }

        const gapToElementBottom = geo.videoBottom - geo.hostBottom;
        const bar = Math.round((geo.videoRect.height - geo.pic.height) / 2);
        if (geo.videoW > 0 && bar > 10 && gapToElementBottom > bar) {
          ok(`黑边补偿生效：字幕在元素底边上方 ${gapToElementBottom}px（黑边高 ${bar}px，没有落进黑边里）`);
        } else if (bar <= 10) {
          bad(`测试页没有产生黑边（bar=${bar}px），这轮没验证到补偿逻辑`);
        } else {
          bad(`字幕掉进黑边里了：距元素底边只有 ${gapToElementBottom}px，黑边高 ${bar}px`);
        }

        // --- 自动跟随：改尺寸后字幕要跟着走 ---
        // 注意：不能调用页面主世界定义的 window.__setWrapSize —— executeScript 跑在
        // 隔离世界里，看不到主世界的全局变量。直接改 DOM 才有效。
        // 这次换成「扁」的框（1000×420），会触发另一种黑边：左右黑边。
        const before = { x: geo.hostCenterX, y: geo.hostBottom };
        await probePage(cdp, VIDEO_URL, `
          const wrap = document.getElementById("wrap");
          wrap.style.width = "1000px";
          wrap.style.height = "420px";
          return { ok: true };
        `);
        await sleep(1500);
        const geo2 = await probePage(cdp, VIDEO_URL, `
          const v = window.__testVideo || document.querySelector("video");
          const hr = host.getBoundingClientRect();
          const vr = v.getBoundingClientRect();
          const vw = v.videoWidth, vh = v.videoHeight;
          let pic = { left: vr.left, top: vr.top, width: vr.width, height: vr.height };
          if (vw && vh) {
            const ar = vw / vh, boxAr = vr.width / vr.height;
            if (boxAr > ar) { const w = vr.height * ar; pic = { left: vr.left + (vr.width - w)/2, top: vr.top, width: w, height: vr.height }; }
            else { const h = vr.width / ar; pic = { left: vr.left, top: vr.top + (vr.height - h)/2, width: vr.width, height: h }; }
          }
          return { ok: true, hostBottom: Math.round(hr.bottom), hostCenterX: Math.round(hr.left + hr.width/2),
                   wantY: Math.round(pic.top + pic.height * 0.92), wantX: Math.round(pic.left + pic.width/2),
                   picH: Math.round(pic.height), picW: Math.round(pic.width),
                   elemW: Math.round(vr.width), elemH: Math.round(vr.height),
                   styleTop: host.style.top, styleLeft: host.style.left };
        `);
        info(`改尺寸后：元素 ${geo2.elemW}×${geo2.elemH}，画面 ${geo2.picW}×${geo2.picH}（原 ${geo.pic.width}×${geo.pic.height}）`);
        const changed = geo2.hostBottom !== before.y || geo2.hostCenterX !== before.x;
        const accurate =
          Math.abs(geo2.hostBottom - geo2.wantY) <= 3 && Math.abs(geo2.hostCenterX - geo2.wantX) <= 3;
        if (changed && accurate) {
          ok(`改尺寸后自动跟随成功（底部 ${before.y} → ${geo2.hostBottom}，期望 ${geo2.wantY}；换了另一种黑边也准）`);
        } else if (!changed) {
          bad(`视频尺寸变了但字幕没跟着动（底边仍是 ${geo2.hostBottom}，期望 ${geo2.wantY}）`);
        } else {
          bad(`跟随了但位置不准：底边 ${geo2.hostBottom}/期望 ${geo2.wantY}，中线 ${geo2.hostCenterX}/期望 ${geo2.wantX}`);
        }
      }
    }

    // --- 自动启动本地服务（Native Messaging）--------------------------------
    // 扩展不能直接启动进程，只能调注册表里那个本地程序。
    // 这里做一次真实端到端：确保 8765 没人监听 → 让扩展去拉 → 验证真的起来了。
    console.log("");
    info("检查「打开插件自动启动本地服务」");
    // 用独立的端口，免得和回归脚本/用户自己开着的 8765 撞车
    const BOOT_PORT = 8766;
    let portFree = true;
    try {
      await fetch(`http://127.0.0.1:${BOOT_PORT}/health`, { signal: AbortSignal.timeout(1500) });
      portFree = false;
    } catch {
      portFree = true;
    }

    if (!portFree) {
      info(`端口 ${BOOT_PORT} 已经有服务在跑，跳过启动测试（这属于正常情况）`);
    } else {
      // 注意：这一步会真的拉起第二个本地服务，而默认模型是 large-v3-turbo（约 2.5GB）。
      // 如果回归自己那个服务此时也占着显存，第二次加载会明显变慢。
      // 所以给足超时；真超时也只算「跳过」而不是失败 —— 它依赖外部进程和显存状况，
      // 拿它判产品对错不公平。
      let raw = null;
      try {
        raw = await swEval(cdp, `
          try {
            const res = await chrome.runtime.sendNativeMessage("com.vst.server_launcher",
              { action: "ensure", port: ${BOOT_PORT} });
            return JSON.stringify({ ok: true, res });
          } catch (e) {
            return JSON.stringify({ ok: false, error: String(e) });
          }
        `, 90000);
      } catch (e) {
        info(`本地启动器调用超时，跳过这一段（显存/进程竞争下属正常）：${e.message}`);
      }

      const nr = raw ? JSON.parse(raw) : { ok: false, timeout: true };
      if (nr.timeout) {
        info("已跳过自动启动验证 —— 不影响其余检查");
      } else if (nr.ok) ok(`本地启动器可用（返回 ${JSON.stringify(nr.res)}）`);
      else if (String(nr.error).includes("not found") || String(nr.error).includes("not registered")) {
        bad(`本地启动器没注册：${nr.error}`);
        console.log("       → 运行 scripts\\register-native-host.ps1 即可");
      } else {
        bad(`调用本地启动器失败：${nr.error}`);
      }

      // 等服务真的监听端口
      let up = false;
      let waited = 0;
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${BOOT_PORT}/health`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) {
            up = true;
            waited = i;
            break;
          }
        } catch {
          /* 还没起来 */
        }
        await sleep(1000);
      }
      if (up) ok(`本地服务被成功自动拉起（等待 ${waited}s 后 /health 可用）`);
      else if (nr.timeout) info("服务没能确认起来（上面已跳过，不算失败）");
      else bad("调用成功但服务 60 秒内没起来");

      // 顺手验证接口形状，然后把它关掉，别在用户机器上留个进程
      if (up) {
        try {
          const j = await (await fetch(`http://127.0.0.1:${BOOT_PORT}/health`)).json();
          info(`服务自报：v${j.version} 模型 ${j.model}`);
        } catch {}
        const { execSync } = await import("node:child_process");
        try {
          execSync(
            `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${BOOT_PORT} -State Listen -EA SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }"`,
            { stdio: "ignore" }
          );
          info("测试用的服务已关闭");
        } catch {}
      }
    }

    // --- 弹窗的模型快捷切换 -------------------------------------------------
    // 以前弹窗里的选项是写死在 HTML 里的（base/small/medium），
    // 但默认值后来改成了 auto —— value 找不到对应 option 会静默退成第一项，
    // 于是「显示 base、实际跑 large-v3-turbo」，而且根本没得选。
    // 现在选项从 VST.MODELS 动态生成，并加了一排快捷按钮。
    const extId = String(ours.target.url).split("/")[2];
    const POPUP_URL = `chrome-extension://${extId}/popup.html`;
    let popupInfo = null;
    try {
      await cdp.send("Target.createTarget", { url: POPUP_URL });
      // 等 popup 把设置读完并渲染出来
      for (let i = 0; i < 30 && !popupInfo; i++) {
        await sleep(300);
        const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => []);
        const pt = list.find((t) => t.type === "page" && String(t.url).startsWith(POPUP_URL));
        if (!pt) continue;
        const pcdp = new CDP(pt.webSocketDebuggerUrl);
        try {
          await pcdp.ready;
          const raw = await pcdp.evalIn(`(() => {
            const sel = document.getElementById("model");
            const chips = [...document.querySelectorAll("#modelChips button")];
            return JSON.stringify({
              optionCount: sel ? sel.options.length : 0,
              options: sel ? [...sel.options].map(o => o.value) : [],
              value: sel ? sel.value : null,
              chips: chips.map(b => ({ m: b.getAttribute("data-model"), on: b.getAttribute("data-on") })),
            });
          })()`);
          const parsed = JSON.parse(raw);
          if (parsed.optionCount > 0) popupInfo = parsed;
        } catch (e) { /* 还没渲染好，继续等 */ }
        pcdp.close();
      }
    } catch (e) {
      info(`打开弹窗页失败（不影响其他检查）：${e.message}`);
    }

    if (popupInfo) {
      info(`弹窗模型选项：${popupInfo.options.join(", ")}`);
      info(`  当前值=${popupInfo.value}　快捷按钮=${popupInfo.chips.map((c) => c.m + (c.on === "1" ? "(选中)" : "")).join(" ")}`);
      // 必须包含 auto 和 large-v3-turbo —— 之前正好缺这两个
      const opts = popupInfo.options;
      if (opts.includes("auto") && opts.includes("large-v3-turbo")) {
        ok(`弹窗模型选项完整（${opts.length} 项，含 auto 和 large-v3-turbo）`);
      } else {
        bad(`弹窗模型选项不全，缺 ${!opts.includes("auto") ? "auto " : ""}${!opts.includes("large-v3-turbo") ? "large-v3-turbo" : ""}`);
      }
      // 当前值必须能在选项里找到（否则就是「显示的和实际跑的不一致」那个 bug）
      if (popupInfo.value && opts.includes(popupInfo.value)) {
        ok(`弹窗当前模型显示正确（${popupInfo.value}）`);
      } else {
        bad(`弹窗当前模型显示不对：value=${popupInfo.value}，不在选项里 → 会静默显示成第一项`);
      }
      const on = popupInfo.chips.filter((c) => c.on === "1");
      if (popupInfo.chips.length >= 3 && on.length === 1) {
        ok(`有 ${popupInfo.chips.length} 个快捷切换按钮，且只有当前那个是高亮的`);
      } else {
        bad(`快捷按钮状态异常：${JSON.stringify(popupInfo.chips)}`);
      }
    } else {
      info("没能读到弹窗内容，跳过模型选择器检查");
    }

    // --- Service Worker 有没有报错 -----------------------------------------
    const errs = cdp.events.filter(
      (e) => e.method === "Runtime.exceptionThrown" ||
        (e.method === "Log.entryAdded" && e.params?.entry?.level === "error")
    );
    const extErrs = errs.filter((e) => JSON.stringify(e).includes("chrome-extension://"));
    if (extErrs.length === 0) ok("Service Worker 没有抛出异常");
    else {
      bad(`Service Worker 有 ${extErrs.length} 条错误：`);
      extErrs.slice(0, 4).forEach((e) => console.log("      " + JSON.stringify(e).slice(0, 240)));
    }
  } finally {
    cdp?.close();
    try { proc.kill(); } catch {}
    try { web.close(); } catch {}
    await sleep(700);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }

  console.log("\n" + "=".repeat(66));
  if (fail === 0) console.log(`  \x1b[32m全部通过 ✅  (${pass} 项)\x1b[0m`);
  else console.log(`  \x1b[31m${fail} 项未通过 ❌  (通过 ${pass} 项)\x1b[0m`);
  return fail === 0 ? 0 : 1;
}

process.exit(await main());
