/*
 * 页面里的字幕层。
 *
 * 几个关键设计：
 *   1. Shadow DOM —— 页面 CSS 再野也影响不到字幕样式，反之亦然。
 *   2. popover="manual" —— 让字幕进入浏览器「顶层」（top layer），
 *      这样视频全屏时字幕依然浮在最上面。直接 append 到 body 的话全屏就看不见了。
 *   3. 默认 pointer-events:none —— 字幕绝不能挡住视频的点击和拖进度条。
 *      要挪位置时从扩展弹窗打开「调整位置」模式，临时接管指针事件。
 */

(function () {
  "use strict";

  if (window.__vstContentLoaded) return;
  window.__vstContentLoaded = true;

  const VST = globalThis.VST;
  if (!VST) {
    console.warn("[vst] common.js 未加载，字幕层跳过初始化");
    return;
  }

  const HOST_ID = "vst-subtitle-host";
  const DEFAULT_FONT =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif';

  let settings = Object.assign({}, VST.DEFAULTS);
  let host = null;
  let root = null;
  let linesEl = null;
  let badgeEl = null;
  let badgeTextEl = null;
  let statsEl = null;
  let hintEl = null;

  const nodes = new Map(); // id -> { el, src, dst, data }
  let latestId = -1;
  let fadeTimer = null;
  // 「有人开始说新一句」时用来撤旧字幕的计时器，以及最后一条字幕到达的时间
  let staleTimer = null;
  let lastLineAt = 0;
  let editMode = false;
  let dragState = null;
  let placeholderEl = null;
  let popoverOk = false;
  let currentStatus = "idle";
  let currentStats = null;
  let hintTimer = null;

  // 自动跟随视频
  let currentVideo = null;
  let videoScanAt = 0;
  let tracking = false;
  let trackRaf = 0;
  let lastPickAt = 0;
  let lastPosKey = "";
  let resizeObserver = null;
  let outlineEl = null;
  let videoInfoEl = null;

  // -------------------------------------------------------------------------
  // 样式
  // -------------------------------------------------------------------------
  const CSS = `
    :host {
      position: fixed;
      inset: auto;
      left: 50%;
      bottom: 8vh;
      margin: 0;
      border: 0;
      padding: 0;
      width: max-content;
      max-width: 92vw;
      height: auto;
      background: transparent;
      overflow: visible;
      color: var(--vst-color, #fff);
      z-index: 2147483647;
      pointer-events: none;
      font-family: var(--vst-font, ${DEFAULT_FONT});
      opacity: 1;
      transition: opacity 0.35s ease;
    }
    :host([data-hidden="1"]) { opacity: 0; }

    * { box-sizing: border-box; }

    .vst-stack {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      width: max-content;
      max-width: 92vw;
      margin: 0 auto;
    }

    .vst-badge {
      display: none;
      align-items: center;
      gap: 7px;
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(16, 20, 28, 0.86);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #dfe6f0;
      font-size: 12.5px;
      line-height: 1.4;
      white-space: nowrap;
      max-width: 80vw;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
    }
    .vst-badge[data-show="1"] { display: flex; }
    .vst-badge[data-tone="error"] { background: rgba(72, 16, 20, 0.9); border-color: rgba(255, 120, 120, 0.35); }
    .vst-badge[data-tone="busy"] { background: rgba(48, 38, 12, 0.88); border-color: rgba(255, 200, 80, 0.3); }

    .vst-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #8b93a1;
      flex: 0 0 auto;
    }
    .vst-badge[data-tone="busy"] .vst-dot { background: #ffc14d; animation: vst-pulse 1.1s ease-in-out infinite; }
    .vst-badge[data-tone="error"] .vst-dot { background: #ff6b6b; }
    @keyframes vst-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

    .vst-box {
      padding: 8px 18px;
      border-radius: 10px;
      background: var(--vst-bg, transparent);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      text-align: center;
      max-width: 92vw;
    }
    /* 底色全透明时：去掉毛玻璃和大内边距，纯靠文字描边保证可读
       —— 这就是原生字幕/播放器的做法，画面完全不被遮挡。 */
    :host([data-bg="0"]) .vst-box {
      padding: 2px 4px;
      border-radius: 0;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    .vst-box[data-empty="1"] { display: none; }

    /* 「有人开始说新一句了」→ 旧字幕快速淡出。
       识别要半秒到一秒，等新字幕出来时说话的人常常已经换了；
       不撤掉旧字幕的话，它会被误当成下一个人的话。
       只做透明度过渡、不动布局，避免画面抖一下。 */
    .vst-box { transition: opacity 0.15s ease-in; }
    :host([data-stale="1"]) .vst-box {
      opacity: 0;
      transition: opacity 0.15s ease-out;
    }

    .vst-line + .vst-line { margin-top: 4px; }
    .vst-line { max-width: 92vw; }

    .vst-src, .vst-dst {
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      /* 八方向描边 + 柔和投影。
         没有底色时全靠这个把字从画面里「拔」出来，
         比单层 text-shadow 在亮背景上清楚得多。 */
      text-shadow:
        -1px -1px 0 rgba(0, 0, 0, 0.85), 1px -1px 0 rgba(0, 0, 0, 0.85),
        -1px 1px 0 rgba(0, 0, 0, 0.85), 1px 1px 0 rgba(0, 0, 0, 0.85),
        0 -1px 0 rgba(0, 0, 0, 0.85), 0 1px 0 rgba(0, 0, 0, 0.85),
        -1px 0 0 rgba(0, 0, 0, 0.85), 1px 0 0 rgba(0, 0, 0, 0.85),
        0 0 8px rgba(0, 0, 0, 0.75),
        0 2px 5px rgba(0, 0, 0, 0.85);
    }
    .vst-src {
      font-size: var(--vst-src-size, 17px);
      line-height: 1.35;
      color: var(--vst-src-color, #dbe4f0);
      opacity: 0.95;
    }
    .vst-dst {
      font-size: var(--vst-font-size, 22px);
      line-height: 1.4;
      font-weight: 600;
      color: var(--vst-color, #fff);
    }
    .vst-line[data-final="0"] .vst-dst { opacity: 0.88; }

    .vst-stats {
      display: none;
      font-size: 11px;
      color: rgba(220, 228, 240, 0.65);
      background: rgba(12, 16, 22, 0.6);
      border-radius: 6px;
      padding: 2px 8px;
      white-space: nowrap;
      font-family: ui-monospace, Consolas, monospace;
    }
    .vst-stats[data-show="1"] { display: block; }

    .vst-hint {
      display: none;
      font-size: 12px;
      color: #cfe0ff;
      background: rgba(24, 58, 120, 0.92);
      border: 1px solid rgba(120, 170, 255, 0.5);
      border-radius: 6px;
      padding: 3px 10px;
      white-space: nowrap;
    }
    .vst-hint[data-show="1"] { display: block; }

    /* 编辑模式下把识别到的视频画面框出来，让用户知道字幕贴到哪儿了。
       注意别用超大 box-shadow 做压暗 —— 那个元素每帧都在动，
       等于每帧重绘整个屏幕，又卡又容易看着「闪」。 */
    .vst-outline {
      display: none;
      position: absolute;
      border: 2px dashed rgba(90, 150, 255, 0.85);
      border-radius: 6px;
      pointer-events: none;
    }
    .vst-videoinfo {
      display: none;
      font-size: 11.5px;
      padding: 2px 9px;
      border-radius: 6px;
      white-space: nowrap;
      background: rgba(12, 16, 22, 0.72);
      color: #9fd0ff;
      border: 1px solid rgba(90, 150, 255, 0.35);
    }
    .vst-videoinfo[data-tone="warn"] { color: #ffd08a; border-color: rgba(255, 190, 90, 0.35); }
    :host([data-editing="1"]) .vst-videoinfo { display: block; }

    :host([data-editing="1"]) {
      pointer-events: auto;
      cursor: move;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      outline: 2px dashed rgba(90, 150, 255, 0.9);
      outline-offset: 6px;
      border-radius: 8px;
    }
    :host([data-editing="1"]) .vst-box { cursor: move; }
    .vst-placeholder {
      font-size: var(--vst-src-size, 17px);
      line-height: 1.4;
      color: rgba(200, 210, 225, 0.72);
      padding: 1px 0;
    }
  `;

  // -------------------------------------------------------------------------
  // 构建 DOM
  // -------------------------------------------------------------------------
  function ensureHost() {
    if (host && host.isConnected) return;

    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("popover", "manual");
      // popover 的 UA 样式会带上边框/内边距/背景，这里就地覆盖掉
      host.style.cssText =
        "position:fixed;inset:auto;left:50%;bottom:8vh;margin:0;border:0;padding:0;" +
        "background:transparent;overflow:visible;width:max-content;max-width:92vw;height:auto;" +
        "z-index:2147483647;";
      // 注意：pointer-events 千万不能写成行内样式！
      // 行内样式优先级高于 shadow 内的 :host([data-editing="1"]) 规则，
      // 一旦写死 none，编辑模式就永远收不到指针事件，字幕也就拖不动了。
      // 这里统一交给下面的 :host 规则控制。

      root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);

      const stack = document.createElement("div");
      stack.className = "vst-stack";

      badgeEl = document.createElement("div");
      badgeEl.className = "vst-badge";
      const dot = document.createElement("span");
      dot.className = "vst-dot";
      badgeTextEl = document.createElement("span");
      badgeEl.appendChild(dot);
      badgeEl.appendChild(badgeTextEl);

      const box = document.createElement("div");
      box.className = "vst-box";
      box.setAttribute("data-empty", "1");
      linesEl = document.createElement("div");
      linesEl.className = "vst-lines";
      box.appendChild(linesEl);
      box.dataset.role = "box";

      statsEl = document.createElement("div");
      statsEl.className = "vst-stats";

      videoInfoEl = document.createElement("div");
      videoInfoEl.className = "vst-videoinfo";

      hintEl = document.createElement("div");
      hintEl.className = "vst-hint";
      hintEl.textContent = "拖动到合适位置，按 Esc 或再点一次按钮完成";

      outlineEl = document.createElement("div");
      outlineEl.className = "vst-outline";

      // 顺序很关键：字幕框放在最后，配合 translate(-50%,-100%) 锚定，
      // 这样「字幕框的底边」正好落在计算出的位置上，
      // 状态条/提示行浮在上方，不会把字幕顶偏。
      stack.appendChild(videoInfoEl);
      stack.appendChild(hintEl);
      stack.appendChild(statsEl);
      stack.appendChild(badgeEl);
      stack.appendChild(box);
      root.appendChild(stack);
      root.appendChild(outlineEl);

      host.addEventListener("pointerdown", onPointerDown, true);
      host.addEventListener("pointermove", onPointerMove, true);
      host.addEventListener("pointerup", onPointerUp, true);
      host.addEventListener("pointercancel", onPointerUp, true);
    }

    if (!resizeObserver && typeof ResizeObserver === "function") {
      // 播放器改尺寸（影院模式、画中画、换分辨率）时立刻重算
      resizeObserver = new ResizeObserver(() => {
        if (tracking) applyPosition();
      });
    }

    attachHost();
    applyStyles();
    applyPosition();
  }

  /**
   * popover 元素会附带一个隐形 ::backdrop，它属于顶层，默认会参与鼠标命中测试。
   * 不把它关掉的话，字幕虽然「看不见」，却会吃掉整个页面的点击 —— 视频点不动、进度条拖不了。
   * 这条规则必须写在文档级的样式表里（shadow root 里的 :host::backdrop 在部分版本上不生效）。
   */
  function ensureBackdropStyle() {
    if (document.getElementById("vst-backdrop-style")) return;
    const style = document.createElement("style");
    style.id = "vst-backdrop-style";
    style.textContent =
      "#vst-subtitle-host::backdrop{background:transparent !important;pointer-events:none !important;}";
    (document.head || document.documentElement).appendChild(style);
  }

  /** 把字幕层放进「顶层」，全屏时也能盖在视频上 */
  function attachHost() {
    if (!host) return;
    if (host.parentNode !== document.documentElement) {
      document.documentElement.appendChild(host);
    }
    ensureBackdropStyle();
    raiseTopLayer();
  }

  function raiseTopLayer() {
    if (!host) return;
    if (typeof host.showPopover !== "function") {
      popoverOk = false;
      return;
    }
    try {
      if (host.matches(":popover-open")) {
        popoverOk = true;
        return; // 已经在顶层了就别动 —— hide/show 一次整个字幕会闪一下
      }
      host.showPopover();
      popoverOk = true;
    } catch (e) {
      popoverOk = false;
      console.warn("[vst] 顶层弹出失败，降级为普通定位：", e && e.message);
    }
  }

  /**
   * 全屏切换时必须重新入栈：全屏元素是后来加进顶层的，会盖在我们上面。
   * 只有真的进了全屏才重排，避免无谓的闪烁。
   */
  function reRaiseForFullscreen() {
    if (!host || !popoverOk) return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch (e) {
      /* 忽略 */
    }
  }

  // 全屏切换时重新入栈，否则全屏元素会盖在我们上面
  ["fullscreenchange", "webkitfullscreenchange"].forEach((evt) => {
    document.addEventListener(evt, () => {
      setTimeout(() => {
        attachHost();
        reRaiseForFullscreen();
        applyPosition();
      }, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 自动跟随视频
  //
  // 目标：让字幕看起来像视频自带的一样 —— 贴在「画面」底部，而不是浏览器窗口底部。
  //
  // 两个容易踩的坑：
  //   1. video 元素的框 ≠ 画面。宽高比不匹配时会有黑边（letterbox），
  //      字幕必须贴画面底边，不然会悬在黑边里，一眼假。
  //   2. 页面上的 video 可能有好几个（广告、预览、背景视频），
  //      要挑「正在播放 + 面积大 + 可见」的那个。
  // -------------------------------------------------------------------------
  const fitCache = new WeakMap();

  function collectVideos(deep) {
    const out = [];
    const grab = (root) => {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll("video").forEach((v) => out.push(v));
    };
    grab(document);
    if (!deep) return out;
    // 少数播放器把 video 放在 shadow DOM 里。注意这个遍历很贵，
    // 只在浅层一个都没找到、且距离上次超过 5 秒时才做。
    const walk = (root) => {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) {
          grab(el.shadowRoot);
          walk(el.shadowRoot);
        }
      });
    };
    walk(document);
    return out;
  }

  function scoreVideo(v) {
    if (!v || !v.getBoundingClientRect) return -1;
    const r = v.getBoundingClientRect();
    if (r.width < 100 || r.height < 70) return -1;
    let cs;
    try {
      cs = getComputedStyle(v);
    } catch (e) {
      return -1;
    }
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return -1;

    const visW = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
    const visibleFrac = (visW * visH) / (r.width * r.height);
    if (visibleFrac <= 0.05) return -1;

    let s = r.width * r.height * visibleFrac;
    if (!v.paused && !v.ended && v.readyState >= 2) s *= 3; // 正在播放的优先
    else if (v.readyState >= 2) s *= 0.6;
    if (v.muted) s *= 0.8;
    return s;
  }

  function pickVideo() {
    let list = collectVideos(false);
    const now = performance.now();
    if (!list.length && now - videoScanAt > 5000) {
      videoScanAt = now;
      list = collectVideos(true);
    }
    let best = null;
    let bestScore = 0;
    for (const v of list) {
      if (!v.isConnected) continue;
      const s = scoreVideo(v);
      if (s > bestScore) {
        bestScore = s;
        best = v;
      }
    }
    return best;
  }

  /** video 元素的框 → 真正的画面区域（补掉黑边） */
  function pictureRect(v) {
    const r = v.getBoundingClientRect();
    const full = { left: r.left, top: r.top, width: r.width, height: r.height };
    const vw = v.videoWidth || 0;
    const vh = v.videoHeight || 0;
    if (!vw || !vh || !r.width || !r.height) return full;

    let fit = fitCache.get(v);
    if (fit === undefined) {
      try {
        fit = getComputedStyle(v).objectFit || "contain";
      } catch (e) {
        fit = "contain";
      }
      if (fit !== "cover" && fit !== "fill" && fit !== "none") fit = "contain";
      fitCache.set(v, fit);
    }
    if (fit === "fill" || fit === "cover" || fit === "none") return full;

    const ar = vw / vh;
    const boxAr = r.width / r.height;
    if (boxAr > ar) {
      // 元素比画面「宽」→ 左右有黑边，画面垂直方向撑满
      const w = r.height * ar;
      return { left: r.left + (r.width - w) / 2, top: r.top, width: w, height: r.height };
    }
    // 元素比画面「高」→ 上下有黑边
    const h = r.width / ar;
    return { left: r.left, top: r.top + (r.height - h) / 2, width: r.width, height: h };
  }

  /** 字幕该贴在哪块区域上 */
  function anchorRect() {
    if (settings.attachMode !== "window" && currentVideo && currentVideo.isConnected) {
      const p = pictureRect(currentVideo);
      if (p.width > 40 && p.height > 30) return p;
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function updateVideoInfo() {
    if (!videoInfoEl) return;
    const onVideo = settings.attachMode !== "window" && !!currentVideo;
    if (!onVideo) {
      videoInfoEl.textContent = "未找到视频，字幕贴在窗口底部";
      videoInfoEl.setAttribute("data-tone", "warn");
      return;
    }
    const p = pictureRect(currentVideo);
    videoInfoEl.textContent = `已贴合视频画面 ${Math.round(p.width)}×${Math.round(p.height)}`;
    videoInfoEl.setAttribute("data-tone", "ok");
  }

  function updateOutline(t) {
    if (!outlineEl) return;
    const show = editMode && settings.attachMode !== "window" && !!currentVideo && !settings.__previewWindow;
    outlineEl.style.display = show ? "block" : "none";
    if (!show || !host) return;
    const hr = host.getBoundingClientRect();
    outlineEl.style.left = Math.round(t.left - hr.left) + "px";
    outlineEl.style.top = Math.round(t.top - hr.top) + "px";
    outlineEl.style.width = Math.round(t.width) + "px";
    outlineEl.style.height = Math.round(t.height) + "px";
  }

  function startTracking() {
    if (tracking) return;
    tracking = true;
    lastPickAt = 0;
    const tick = () => {
      if (!tracking) return;
      trackRaf = requestAnimationFrame(tick);
      if (!host) return;
      const now = performance.now();
      // 选哪个视频不用每帧算（要查 DOM + 求样式，比较贵）；每秒 4 次足够。
      if (now - lastPickAt > 250) {
        lastPickAt = now;
        const v = pickVideo();
        if (v !== currentVideo) {
          currentVideo = v;
          updateVideoInfo();
          if (resizeObserver) {
            try { resizeObserver.disconnect(); } catch (e) {}
          }
          if (currentVideo && typeof ResizeObserver === "function") {
            resizeObserver.observe(currentVideo);
          }
        }
      }
      applyPosition();
    };
    trackRaf = requestAnimationFrame(tick);
  }

  function stopTracking() {
    tracking = false;
    if (trackRaf) cancelAnimationFrame(trackRaf);
    trackRaf = 0;
  }

  function syncTracking() {
    const need =
      !!host &&
      (editMode ||
        currentStatus === "running" ||
        currentStatus === "loading" ||
        currentStatus === "starting" ||
        nodes.size > 0);
    if (need) startTracking();
    else stopTracking();
  }

  // 滚动/缩放/全屏时立刻重算一次，不用等下一帧，手感更好
  ["scroll", "resize", "orientationchange"].forEach((evt) => {
    window.addEventListener(evt, () => { if (tracking) applyPosition(); }, { passive: true, capture: true });
  });
  function applyStyles() {
    if (!host) return;
    const fs = Number(settings.fontSize) || 22;
    host.style.setProperty("--vst-font-size", fs + "px");
    host.style.setProperty("--vst-src-size", Math.max(11, Math.round(fs * 0.78)) + "px");
    host.style.setProperty("--vst-color", settings.textColor || "#ffffff");
    host.style.setProperty("--vst-src-color", settings.sourceColor || "#dbe4f0");
    // 底色默认全透明（像原生字幕，完全不挡画面）。
    // 透明度为 0 时还要把毛玻璃和内边距也关掉 —— 否则会留一圈模糊的「空气墙」，
    // 看着像有一块没颜色的底板，比纯描边难受。
    const bg = clamp01(settings.bgOpacity, 0);
    const solid = bg > 0.01;
    host.style.setProperty("--vst-bg", solid ? `rgba(8, 10, 14, ${bg})` : "transparent");
    host.setAttribute("data-bg", solid ? "1" : "0");
    host.style.setProperty("--vst-font", settings.fontFamily || DEFAULT_FONT);
  }

  function clamp01(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
  }

  function applyPosition() {
    if (!host) return;
    const t = anchorRect();
    const hAlign = clampNum(settings.hAlignPct, 50, 0, 100);
    const bottom = clampNum(settings.bottomPct, 8, 0, 92);
    const x = Math.round(t.left + (t.width * hAlign) / 100);
    const y = Math.round(t.top + t.height * (1 - bottom / 100));

    // 不编辑的时候，位置没变就别反复写样式 —— 每帧都写会拖慢页面，
    // 而且样式脏标记会让合成器反复重建图层，看起来就像在闪。
    const key = `${x},${y},${Math.round(t.width)},${Math.round(t.height)}`;
    if (!editMode && key === lastPosKey) return;
    lastPosKey = key;

    host.style.left = x + "px";
    host.style.top = y + "px";
    host.style.bottom = "auto";
    // 用 transform 锚定「底边中点」，而不是用 offsetWidth 反算 left/top：
    // transform 不参与布局，不会因为宽度变化引起左右抖动。
    host.style.transform = "translate(-50%, -100%)";
    updateOutline(t);
  }

  function clampNum(v, dflt, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  // -------------------------------------------------------------------------
  // 字幕渲染
  // -------------------------------------------------------------------------
  function createLineEl() {
    const el = document.createElement("div");
    el.className = "vst-line";
    el.setAttribute("data-final", "0");
    const src = document.createElement("div");
    src.className = "vst-src";
    const dst = document.createElement("div");
    dst.className = "vst-dst";
    el.appendChild(src);
    el.appendChild(dst);
    return { el, src, dst, data: {}, shown: { src: "", dst: "" }, rafSrc: 0, rafDst: 0 };
  }

  // -------------------------------------------------------------------------
  // 平滑显示
  //
  // 中间字幕是「每 1.5 秒整行替换一次」，直接 setTextContent 看起来就是一顿一顿地跳。
  // 这里改成：如果新文本是旧文本的延长（Whisper 的中间结果基本都在增长），
  // 就只把新增的那几个字用 ~200ms 平滑显现出来，观感上就像在连续打字。
  // 如果文本被改写（不是延长），就直接替换，免得出现「先删后加」的鬼畜效果。
  // -------------------------------------------------------------------------
  // 每次都读一次，而不是模块加载时算一次：
  // 用户中途改了系统的「减少动效」设置也能立刻生效（顺便也让无头浏览器里能测）。
  function prefersReducedMotion() {
    try {
      return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  }

  function revealLength(suffixLen) {
    // 越长显示得越快，整体控制在 120~280ms，否则长句会拖沓
    return Math.max(120, Math.min(280, 60 + suffixLen * 10));
  }

  function setTextSmooth(rec, which, text, instant) {
    const el = which === "src" ? rec.src : rec.dst;
    const shown = rec.shown || (rec.shown = { src: "", dst: "" });
    const prev = shown[which] || "";
    if (text === prev) return;

    // 取消上一次还没跑完的动画
    const key = which === "src" ? "rafSrc" : "rafDst";
    if (rec[key]) {
      cancelAnimationFrame(rec[key]);
      rec[key] = 0;
    }

    const isExtension = prev && text.startsWith(prev) && text.length > prev.length;
    if (instant || prefersReducedMotion() || !isExtension) {
      el.textContent = text;
      shown[which] = text;
      return;
    }

    const suffix = text.slice(prev.length);
    const dur = revealLength(suffix.length);
    const t0 = performance.now();
    el.textContent = prev;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      // easeOutQuad：尾部慢下来，看着更自然
      const eased = 1 - (1 - p) * (1 - p);
      const n = Math.min(suffix.length, Math.round(suffix.length * eased));
      el.textContent = prev + suffix.slice(0, n);
      if (p < 1) {
        rec[key] = requestAnimationFrame(tick);
      } else {
        el.textContent = text;
        rec[key] = 0;
      }
    };
    rec[key] = requestAnimationFrame(tick);
    shown[which] = text;
  }

  function clearLineAnimations(rec) {
    if (rec.rafSrc) cancelAnimationFrame(rec.rafSrc);
    if (rec.rafDst) cancelAnimationFrame(rec.rafDst);
    rec.rafSrc = 0;
    rec.rafDst = 0;
  }


  function maxLines() {
    return Math.max(1, Math.min(4, Number(settings.maxLines) || 1));
  }

  function upsert(line) {
    ensureHost();
    if (typeof line.id !== "number") line.id = ++latestId;
    if (line.id > latestId) latestId = line.id;

    // 翻译结果比新字幕晚回来时，别把已经滚上去的旧行重新插回底部
    if (line.id <= latestId - maxLines()) return;

    let rec = nodes.get(line.id);
    if (!rec) {
      rec = createLineEl();
      nodes.set(line.id, rec);
      linesEl.appendChild(rec.el);
    }
    const d = rec.data;
    if (line.source != null && line.source !== "") d.source = line.source;
    if (line.translated != null && line.translated !== "") d.translated = line.translated;
    if (line.final != null) d.final = !!line.final;
    if (line.lang) d.lang = line.lang;
    if (line.t0 != null) d.t0 = line.t0;

    lastLineAt = Date.now();
    // 新字幕到了 → 取消「旧字幕正在淡出」的状态（不然会把刚到的新字幕一起淡掉）
    if (host && host.getAttribute("data-stale") === "1") host.removeAttribute("data-stale");
    rec.data = d;
    rec.el.setAttribute("data-final", d.final ? "1" : "0");
    // 最终字幕直接落定（不做动画，避免「定稿了还在慢慢打字」）；
    // 中间字幕用平滑显现，解决「一顿一顿」。
    setTextSmooth(rec, "src", d.source || "", !!d.final);
    setTextSmooth(rec, "dst", d.translated || "", !!d.final);

    // 原文和译文一模一样时只显示一行。
    // 什么时候会一样：语气词 / 笑声（「啊」「哈哈」「uh」）—— 服务端判定这类词不值得翻译，
    // 直接把原文当译文发过来。显示两遍「啊」很蠢，这里合并掉。
    // 顺便也覆盖了「译文就是原文」的正常情况（人名、术语等）。
    const sameText = !!(d.source && d.translated &&
      d.source.trim().toLowerCase() === d.translated.trim().toLowerCase());
    const showSrc = settings.showSource && !!d.source && !sameText;
    const showDst = settings.showTarget && !!d.translated;
    rec.src.style.display = showSrc ? "" : "none";
    rec.dst.style.display = showDst ? "" : "none";
    // 只开原文或只开译文时，别留一个空的占位
    rec.el.style.display = showSrc || showDst ? "" : "none";

    hidePlaceholderIfRealLines();
    trim();
    refreshBoxState();
    wake(rec);
    syncTracking();
  }

  function trim() {
    const keep = maxLines();
    while (nodes.size > keep) {
      const firstKey = nodes.keys().next().value;
      const rec = nodes.get(firstKey);
      if (rec) {
        clearLineAnimations(rec);
        if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      }
      nodes.delete(firstKey);
    }
    // 保证 DOM 顺序与 id 顺序一致
    let prev = null;
    for (const [id, rec] of nodes) {
      if (prev && prev.nextSibling !== rec.el) {
        linesEl.insertBefore(rec.el, prev.nextSibling);
      }
      prev = rec.el;
    }
  }

  function refreshBoxState() {
    if (!linesEl) return;
    const box = linesEl.parentNode;
    if (box) box.setAttribute("data-empty", linesEl.childElementCount ? "0" : "1");
  }

  function clearLines() {
    nodes.forEach((rec) => {
      clearLineAnimations(rec);
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    });
    nodes.clear();
    latestId = -1;
    if (host) host.removeAttribute("data-stale");
    refreshBoxState();
  }

  /**
   * 一条字幕该停留多久。
   *
   * 以前是「固定等 N 秒」（默认 12 秒），结果没人说话时字幕就一直挂在那儿，很影响观感。
   * 现在按两件事算：
   *   · 这句话说了多久（服务端会带上 t0/t1）—— 说得久的多留一会儿
   *   · 一共多少字 —— 阅读需要时间，短句不该杵着，长句也不该来不及看
   * upperBound 是设置里的「最长停留」，兜住极端情况。
   */
  function readingDelay(data) {
    const d = data || {};
    const dur = Math.max(0, (Number(d.t1) || 0) - (Number(d.t0) || 0));
    const chars = ((d.translated || "") + (d.source || "")).length;
    const readTime = 1.2 + chars * 0.11;     // 中文约每字 0.11 秒
    const byDuration = 1.8 + dur * 0.9;
    const upper = Math.max(1500, Number(settings.fadeAfterMs) || 8000);
    return Math.min(upper, Math.max(1600, readTime, byDuration));
  }

  /**
   * 有人开始说新一句 → 立刻把上一句淡掉。
   *
   * 为什么需要：识别天生有半秒到一秒延迟。等新字幕出来时说话的人往往已经换了，
   * 上一句还挂在画面上，就会被误当成「下一个人在说的内容」。
   * 原生字幕靠精确时间轴做到「新 cue 一到旧 cue 就消失」；我们没有时间轴，
   * 但「VAD 刚开了一段新语音」这个时刻是立刻就知道的 —— 用它来撤旧字幕。
   *
   * 先淡出再删（而不是立刻删），避免生硬；如果这期间新字幕已经进来了就跳过删除，
   * 免得把刚到的新字幕误删。
   */
  function onSpeechStart() {
    if (!host || editMode) return;
    if (nodes.size === 0) return;
    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      staleTimer = null;
      if (!host) return;
      host.removeAttribute("data-stale");
      // 只有在这段淡出时间里没有新字幕进来，才真的清掉
      if (nodes.size && Date.now() - lastLineAt >= 150) {
        clearLines();
        syncTracking();
      }
    }, 160);
    host.setAttribute("data-stale", "1");
  }

  /** 有新内容 → 取消淡出，并重新排一次自动隐藏 */
  function wake(rec) {
    if (!host) return;
    host.removeAttribute("data-hidden");
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    // 中间字幕还在滚，用「最长停留」兜底就行；最终字幕才按内容算停留时间
    const isFinal = !!(rec && rec.data && rec.data.final);
    const wait = isFinal
      ? readingDelay(rec.data)
      : Math.max(4000, Number(settings.fadeAfterMs) || 8000);

    fadeTimer = setTimeout(() => {
      if (!host) return;
      host.setAttribute("data-hidden", "1");
      // 淡出动画走完就把内容也清掉：留一层透明元素既占内存，
      // 也会让跟踪循环一直空转。
      fadeTimer = setTimeout(() => {
        if (!host || host.getAttribute("data-hidden") !== "1") return;
        clearLines();
        syncTracking();
      }, 600);
    }, wait);
  }

  // -------------------------------------------------------------------------
  // 状态提示
  // -------------------------------------------------------------------------
  function setStatus(status, message) {
    currentStatus = status || "idle";
    // 启动/加载阶段也要让用户看到反馈，所以这时候就得把浮层建出来
    if (currentStatus !== "idle") ensureHost();
    if (!badgeEl) return;
    const tone =
      status === "error" ? "error" : status === "running" ? "ok" : status === "idle" ? "none" : "busy";
    let text = message || "";
    if (!text) {
      text =
        status === "loading"
          ? "正在加载识别模型…"
          : status === "starting"
          ? "正在启动…"
          : status === "running"
          ? "字幕运行中"
          : "";
    }
    const show = currentStatus !== "idle" && currentStatus !== "running" && !!text;
    badgeEl.setAttribute("data-show", show ? "1" : "0");
    badgeEl.setAttribute("data-tone", tone === "none" ? "ok" : tone);
    badgeTextEl.textContent = text;
    if (currentStatus === "running") wake();
    syncTracking();
  }

  function setStats(stats) {
    currentStats = stats;
    if (!statsEl) return;
    const show = !!(settings.showStats && currentStatus === "running" && stats);
    statsEl.setAttribute("data-show", show ? "1" : "0");
    if (!show) return;
    const bits = [];
    if (stats.language) bits.push("语言 " + stats.language);
    if (Number.isFinite(stats.rtf)) bits.push("实时率 " + Number(stats.rtf).toFixed(2));
    // load = 解码耗时 / 墙上时间。超过 1 就说明识别速度已经跟不上视频，字幕会越来越延迟。
    if (Number.isFinite(stats.load) && stats.load > 0.9) {
      bits.push("⚠ 跟不上，建议换小模型");
    }
    statsEl.textContent = bits.join("  ·  ");
  }

  function showHint(text) {
    if (!hintEl) return;
    hintEl.textContent = text || "拖动到合适位置，按 Esc 完成";
    hintEl.setAttribute("data-show", "1");
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hintEl && hintEl.setAttribute("data-show", "0"), 5000);
  }

  // -------------------------------------------------------------------------
  // 拖动
  // -------------------------------------------------------------------------
  function setEditMode(on) {
    on = !!on;
    if (editMode === on) {
      // 已经是这个状态了就别再折腾 popover，否则每调一次字幕就闪一下
      if (host) host.setAttribute("data-editing", on ? "1" : "0");
      return;
    }
    editMode = on;
    ensureHost();
    host.setAttribute("data-editing", on ? "1" : "0");
    lastPosKey = ""; // 强制下一次重新落位（编辑态和普通态的更新策略不同）
    if (on) {
      // 还没出字幕的时候也要有个东西能抓，否则用户点开「调整位置」看到的是空的
      showPlaceholder(true);
      raiseTopLayer();
      showHint();
      wake();
    } else {
      showPlaceholder(false);
      hideHint();
      if (outlineEl) outlineEl.style.display = "none";
    }
    syncTracking();
    if (on) {
      currentVideo = pickVideo();
      updateVideoInfo();
      applyPosition();
    }
  }

  function notifyEditState(enabled) {
    try {
      chrome.runtime.sendMessage({ to: "bg-relay", type: "editstate", enabled: !!enabled }).catch(() => {});
    } catch (e) {
      /* 忽略 */
    }
  }

  function exitEditMode() {
    if (!editMode) return;
    setEditMode(false);
    notifyEditState(false);
  }

  // 点到字幕以外的地方 = 结束调整。
  // 这条很重要：编辑模式会让字幕层接管鼠标事件，用户如果忘了退出，
  // 之后点视频就会被字幕抓住，看起来像「字幕吸附在鼠标上」。
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!editMode || !host) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.indexOf(host) !== -1) return; // 点在字幕自己身上，交给拖动逻辑
      exitEditMode();
    },
    true
  );

  /** 编辑模式下的占位提示（有真实字幕时自动让位） */
  function showPlaceholder(on) {
    if (!linesEl) return;
    if (!on) {
      if (placeholderEl && placeholderEl.parentNode) placeholderEl.parentNode.removeChild(placeholderEl);
      refreshBoxState();
      return;
    }
    if (!placeholderEl) {
      placeholderEl = document.createElement("div");
      placeholderEl.className = "vst-line vst-placeholder";
      placeholderEl.textContent = "字幕会显示在这里 · 拖动我调整位置";
    }
    if (!placeholderEl.parentNode) linesEl.appendChild(placeholderEl);
    // 已经有真实字幕了就不显示占位
    placeholderEl.style.display = linesEl.querySelector(".vst-line:not(.vst-placeholder)") ? "none" : "";
    refreshBoxState();
  }

  function hidePlaceholderIfRealLines() {
    if (placeholderEl && placeholderEl.parentNode && linesEl.querySelector(".vst-line:not(.vst-placeholder)")) {
      placeholderEl.style.display = "none";
    }
  }

  function hideHint() {
    if (hintEl) hintEl.setAttribute("data-show", "0");
    if (hintTimer) clearTimeout(hintTimer);
  }

  function onPointerDown(e) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = host.getBoundingClientRect();
    dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false, pointerId: e.pointerId };
    try {
      host.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 忽略 */
    }
  }

  function onPointerMove(e) {
    if (!dragState || !editMode) return;
    e.preventDefault();
    e.stopPropagation();
    const w = host.offsetWidth || 320;
    const h = host.offsetHeight || 60;
    // 抓住的是 host 内部某一点；移动后要让这一点仍在鼠标下面
    let nl = e.clientX - dragState.dx;
    let nt = e.clientY - dragState.dy;
    nl = Math.min(Math.max(0, nl), Math.max(0, window.innerWidth - w));
    nt = Math.min(Math.max(0, nt), Math.max(0, window.innerHeight - h));
    dragState.moved = true;
    // 保持 translate(-50%,-100%) 不变，把「底边中点」换算回去，
    // 这样后续按锚点百分比保存时算法是统一的
    host.style.left = Math.round(nl + w / 2) + "px";
    host.style.top = Math.round(nt + h) + "px";
    host.style.bottom = "auto";
    host.style.transform = "translate(-50%, -100%)";
  }

  function onPointerUp(e) {
    if (!dragState) return;
    const { moved, pointerId } = dragState;
    dragState = null;
    try {
      host.releasePointerCapture(pointerId);
    } catch (err) {
      /* 忽略 */
    }
    // 只是点了一下、并没有拖动 → 不能保存位置，
    // 否则一次误触就会把字幕甩到别处去。
    if (!moved) return;
    // 存成「相对锚点（视频画面 / 窗口）的百分比」，
    // 这样换分辨率、换窗口大小、进全屏之后位置依然正确。
    const hr = host.getBoundingClientRect();
    const t = anchorRect();
    const hAlign = ((hr.left + hr.width / 2 - t.left) / Math.max(1, t.width)) * 100;
    const bottom = (1 - (hr.bottom - t.top) / Math.max(1, t.height)) * 100;
    VST.saveSettings({
      hAlignPct: Math.round(clampNum(hAlign, 50, 0, 100)),
      bottomPct: Math.round(clampNum(bottom, 8, 0, 92)),
    }).catch(() => {});
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && editMode) exitEditMode();
    },
    true
  );

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------
  function applySettings(next) {
    const prevMax = maxLines();
    settings = Object.assign({}, settings, next || {});
    // 注意：这里不能因为 host 还没建就 return ——
    // 用户可能先点了「调整位置」再开字幕，提前返回的话编辑模式就永远不会生效。
    if (!host && editMode) setEditMode(false);
    if (!host) {
      // 设置里不包含编辑模式（它是临时状态，不持久化），这里只负责建出浮层
      return;
    }
    applyStyles();
    applyPosition();
    if (maxLines() !== prevMax) trim();
    // 设置变了要重新按新规则渲染一遍可见行
    nodes.forEach((rec, id) => {
      const d = rec.data;
      const showSrc = settings.showSource && !!d.source;
      const showDst = settings.showTarget && !!d.translated;
      rec.src.style.display = showSrc ? "" : "none";
      rec.dst.style.display = showDst ? "" : "none";
      rec.el.style.display = showSrc || showDst ? "" : "none";
    });
    setStats(currentStats);
    updateVideoInfo();
    syncTracking();
  }

  // -------------------------------------------------------------------------
  // 消息
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.to !== "content") return undefined;
    switch (msg.type) {
      case "ping":
        sendResponse({ ok: true, v: 1 });
        return undefined;
      case "line":
        upsert(msg.line || {});
        sendResponse({ ok: true });
        return undefined;
      case "speech":
        // 有人开始说新一句了 → 立刻把上一句淡掉。
        //
        // 为什么不能等新字幕：识别天生要半秒到一秒。等它出来时说话的人往往已经换了，
        // 上一句的字幕还挂在画面上，就会被误当成「下一个人在说的内容」。
        // 原生字幕靠精确时间轴做到「新 cue 一到旧 cue 就消失」；
        // 我们没有时间轴，但「VAD 刚开了一段新语音」这个时刻是立刻就知道的，
        // 用它来撤旧字幕，观感就同步了。
        //
        // 只淡出、不删 DOM：新字幕通常几百毫秒后就到，复用同一个元素不会闪。
        onSpeechStart();
        sendResponse({ ok: true });
        return undefined;
      case "editmode": {
        setEditMode(!!msg.enabled);
        sendResponse({ ok: true, editMode });
        return undefined;
      }
      case "editstate":
        sendResponse({ ok: true, editMode });
        return undefined;
      case "state": {
        const st = (msg.state && msg.state.status) || "idle";
        setStatus(st, msg.state && msg.state.message);
        if (st === "idle") {
          clearLines();
          hideHint();
          setEditMode(false);
        }        syncTracking();
        sendResponse({ ok: true });
        return undefined;
      }
      case "videoinfo": {
        // 诊断用：告诉调用方当前贴合到哪块画面上了
        const p = anchorRect();
        sendResponse({
          ok: true,
          attachMode: settings.attachMode,
          hasVideo: !!currentVideo,
          videoW: currentVideo ? currentVideo.videoWidth : 0,
          videoH: currentVideo ? currentVideo.videoHeight : 0,
          rect: { left: Math.round(p.left), top: Math.round(p.top), width: Math.round(p.width), height: Math.round(p.height) },
        });
        return undefined;
      }
      case "stats":
        setStats(msg.stats);
        sendResponse({ ok: true });
        return undefined;
      case "settings":
        applySettings(msg.settings);
        sendResponse({ ok: true });
        return undefined;
      case "clear":
        clearLines();
        sendResponse({ ok: true });
        return undefined;
      case "preview":
        upsert({
          id: 0,
          final: false,
          source: "This is what the subtitle looks like.",
          translated: "字幕大概就是这个样子。",
        });
        settings.showSource = true;
        settings.showTarget = true;
        applySettings({});
        sendResponse({ ok: true });
        return undefined;
      default:
        return undefined;
    }
  });

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------
  VST.loadSettings().then((s) => {
    settings = s;
    // 只有真的要显示东西时才建 DOM，避免给每个页面都塞一个浮层
  });

  VST.onSettingsChanged((s) => {
    settings = s;
    if (host) applySettings(s);
  });
})();
