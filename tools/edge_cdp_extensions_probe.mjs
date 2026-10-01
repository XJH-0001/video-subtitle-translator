/*
 * 测：能否通过 CDP 在 edge://extensions 里调用 chrome.developerPrivate 完成安装。
 *
 *     node tools/edge_cdp_extensions_probe.mjs
 *
 * 结论只用于判断「自动化安装」是否可行。全程临时 profile。
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT = resolve(import.meta.dirname, "..", "extension");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
const PROFILE = mkdtempSync(join(tmpdir(), "edge-cdp2-"));
const PORT = 9610;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("连接失败"));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}, sessionId = null) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " 超时")); }
      }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-sync",
  "--user-data-dir=" + PROFILE,
  "--remote-debugging-port=" + PORT,
  "--remote-allow-origins=*",
  "about:blank",
], { stdio: "ignore" });

let cdp = null;
try {
  let version = null;
  for (let i = 0; i < 50; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(500); }
  }
  if (!version) { console.log("调试端口没起来"); process.exit(1); }
  console.log("浏览器:", version.Browser);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready;

  const { targetId } = await cdp.send("Target.createTarget", { url: "edge://extensions/" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  console.log("已附加到 edge://extensions, sessionId =", sessionId.slice(0, 10) + "…");
  await sleep(2500);

  const ev = async (expr, awaitPromise = false) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise }, sessionId);
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || "JS 异常" };
    return r.result.value;
  };

  console.log("\n[1] 页面上下文");
  console.log("   ", await ev(`JSON.stringify({url: location.href, title: document.title,
      devPrivate: typeof chrome!=='undefined' && !!chrome.developerPrivate,
      mgmt: typeof chrome!=='undefined' && !!chrome.management,
      loadDirectory: typeof chrome!=='undefined' && chrome.developerPrivate ? typeof chrome.developerPrivate.loadDirectory : 'n/a',
      loadUnpacked: typeof chrome!=='undefined' && chrome.developerPrivate ? typeof chrome.developerPrivate.loadUnpacked : 'n/a'})`));

  console.log("\n[2] 页面 DOM 里的关键控件（shadow DOM 穿透查询）");
  console.log("   ", await ev(`(() => {
      const mgr = document.querySelector('extensions-manager');
      if (!mgr || !mgr.shadowRoot) return 'extensions-manager 还没渲染';
      const tb = mgr.shadowRoot.querySelector('extensions-toolbar');
      let out = { devModeToggleFound: false, loadUnpackedBtnFound: false };
      if (tb && tb.shadowRoot) {
        out.devModeToggleFound = !!tb.shadowRoot.querySelector('#devMode');
        out.loadUnpackedBtnFound = !!tb.shadowRoot.querySelector('#loadUnpacked');
      }
      return JSON.stringify(out);
    })()`));

  console.log("\n[3] 尝试 loadDirectory({path})");
  const path = EXT.replace(/\\/g, "\\\\");
  const res = await ev(`new Promise((resolve) => {
      try {
        chrome.developerPrivate.loadDirectory(
          { path: '${path}', failQuietly: false, populateError: false, retryGuid: false },
          (info) => resolve(JSON.stringify({ ok: !chrome.runtime.lastError, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null, id: info && info.id, name: info && info.name })));
      } catch (e) { resolve(JSON.stringify({ ok: false, thrown: String(e) })); }
    })`, true);
  console.log("    返回:", res);

  await sleep(2500);
  console.log("\n[4] 安装后是否出现该扩展的 Service Worker / 页面");
  const all = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const ours = all.filter((t) => String(t.url).includes("cklgbajekihboflmllhodmndoemkgpmj"));
  console.log("    匹配到我们扩展的 target 数:", ours.length);
  ours.forEach((t) => console.log("      ", t.type, t.url));

  console.log("\n[5] 再让它列出已安装扩展");
  console.log("   ", await ev(`new Promise((r)=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},(list)=>{
        r(JSON.stringify((list||[]).map(e=>({id:e.id,name:e.name,location:e.location,state:e.state,path:e.path}))));}))`, true));
} finally {
  cdp?.close();
  proc.kill();
  await sleep(1200);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}
