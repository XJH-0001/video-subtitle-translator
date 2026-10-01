/*
 * 全局共享配置。被 background / popup / options / content / offscreen 一起加载。
 * 不依赖任何构建工具，直接是普通脚本，挂在 globalThis.VST 上。
 */
(function (root) {
  "use strict";

  const DEFAULTS = {
    // ---- 后端 ----
    serverUrl: "ws://127.0.0.1:8765/ws",
    // auto = 服务端按设备挑：显卡用 large-v3-turbo（解码 300ms，仍被 400ms 的静音等待盖住，
    //        等于准确率白拿），CPU 用 small（大模型在 CPU 上会慢到没法看）
    model: "auto",
    sourceLang: "",              // "" = 自动检测
    targetLang: "zh",
    translate: true,
    translatePartials: true,
    // ---- 翻译 ----
    // 默认走 DeepSeek：免费机器翻译接口没法接收上下文，
    // 而带上文能把代词和指代翻准（实测 "she loves it" 在有上文时译成「这辆车」，
    // 无上文只能译成「它」）。一部两小时电影大约两毛到四毛钱。
    translator: "openai",        // auto / bing / google / youdao / tencent / mymemory / deepl / openai / none
    deeplApiKey: "",
    // ★ 这里**故意留空**：API Key 存在服务端本地的 server/config.json 里，
    //   不走 chrome.storage.sync（那会同步到云端账号）。
    //   扩展发空值时，服务端会回退用自己配置里的 key。
    //   想改用别的 key，在设置页填这里，或者改 server/config.json。
    openaiApiKey: "",
    openaiBaseUrl: "https://api.deepseek.com/v1",
    openaiModel: "deepseek-flash",   // 旧名 deepseek-chat 仍可用，但已按新模型计价
    openaiThinking: false,           // 翻译不需要「思考模式」，开着会慢 2~3 倍且更贵

    // ---- 字幕外观 ----
    showSource: true,            // 是否显示原文
    showTarget: true,            // 是否显示译文
    fontSize: 22,                // 译文基准字号 px
    fontFamily: "",              // "" = 用系统默认
    maxLines: 1,                 // 同时显示几条字幕。1 = 只显示当前这一条（画面最干净）
    bgOpacity: 0,                // 字幕底色不透明度。0 = 全透明（像原生字幕，只靠文字描边保证可读）
    textColor: "#ffffff",
    sourceColor: "#dbe4f0",
    fadeAfterMs: 8000,           // 一条字幕最长停留多久（真正停留时间按句子时长和字数算）
    showStats: true,             // 是否显示识别速度

    // ---- 位置（自动贴合视频）----
    // auto   = 自动找到页面上的 <video>，把字幕贴到它画面的底部（像原生字幕）
    // window = 固定在浏览器窗口底部
    attachMode: "auto",
    bottomPct: 8,                // 离锚点底部的距离，占锚点高度的百分比
    hAlignPct: 50,               // 水平位置，占锚点宽度的百分比（50 = 居中）

    // ---- 行为 ----
    autoStartServer: true,       // 打开字幕时自动把本地服务拉起来（需要装过自动启动组件）
  };

  // 这些是「临时 UI 状态」，绝对不能持久化：
  //   editMode 一旦被存下来，用户下次打开视频就会直接卡在编辑模式 ——
  //   字幕层一直抢鼠标事件，点视频会被它抓住并跟着鼠标跑，视频本身也点不动。
  const TRANSIENT_KEYS = ["editMode", "position"];

  // 设置结构的版本号，用来做「默认值升级」的迁移（见 loadSettings）。
  //   1 → 2：翻译默认改成 DeepSeek，模型名 deepseek-chat → deepseek-flash，识别模型改成 auto
  //   2 → 3：字幕底色默认从半透明黑改成全透明（像原生字幕）
  //   3 → 4：同时显示条数默认从 2 改成 1（只显示当前这一条，画面更干净）
  const SETTINGS_VERSION = 4;

  const TARGETS = [
    { value: "zh", label: "中文（简体）" },
    { value: "zh-TW", label: "中文（繁體）" },
    { value: "en", label: "English" },
    { value: "ja", label: "日本語" },
    { value: "ko", label: "한국어" },
    { value: "ru", label: "Русский" },
    { value: "fr", label: "Français" },
    { value: "de", label: "Deutsch" },
    { value: "es", label: "Español" },
    { value: "pt", label: "Português" },
    { value: "it", label: "Italiano" },
    { value: "ar", label: "العربية" },
  ];

  const SOURCES = [
    { value: "", label: "自动检测" },
    { value: "en", label: "English 英语" },
    { value: "ja", label: "日本語 日语" },
    { value: "ko", label: "한국어 韩语" },
    { value: "zh", label: "中文" },
    { value: "ru", label: "Русский 俄语" },
    { value: "fr", label: "Français 法语" },
    { value: "de", label: "Deutsch 德语" },
    { value: "es", label: "Español 西班牙语" },
    { value: "pt", label: "Português 葡萄牙语" },
    { value: "it", label: "Italiano 意大利语" },
    { value: "th", label: "ไทย 泰语" },
    { value: "vi", label: "Tiếng Việt 越南语" },
  ];

  const MODELS = [
    { value: "auto", label: "自动 · 有显卡用 large-v3-turbo，否则用 small（推荐）" },
    { value: "tiny", label: "tiny · 最快，准确率一般（约 40MB）" },
    { value: "base", label: "base · 速度快（约 75MB）" },
    { value: "small", label: "small · 速度与准确率平衡（约 250MB）" },
    { value: "medium", label: "medium · 更准，但比 large-v3-turbo 还慢（约 750MB）" },
    { value: "large-v3-turbo", label: "large-v3-turbo · 又快又准，建议有 N 卡（约 1.6GB）" },
    { value: "large-v3", label: "large-v3 · 最准，最慢（约 1.5GB）" },
  ];

  function storageArea() {
    return (chrome.storage && chrome.storage.sync) || chrome.storage.local;
  }

  async function loadSettings() {
    try {
      const got = await storageArea().get("vst_settings");
      const stored = (got && got.vst_settings) || {};
      const merged = Object.assign({}, DEFAULTS, stored);
      // 老版本把 editMode 存下来过，这里清掉，避免升级后一开视频就卡在编辑模式
      for (const k of TRANSIENT_KEYS) delete merged[k];
      // 默认值升级：v1 的翻译默认是「免费接口竞速(auto)」，v2 改成 DeepSeek。
      // 只有当存下来的值还是老默认值时才跟着升 —— 用户主动选过别的就不动。
      // 不这么做的话，改 DEFAULTS 对已经用过的用户完全没效果（存的值会盖住默认值），
      // 用户会觉得「说好改成 DeepSeek 了怎么还是免费接口」。
      if ((stored.settingsVersion || 1) < SETTINGS_VERSION) {
        if ((stored.translator || "auto") === "auto") merged.translator = DEFAULTS.translator;
        if ((stored.openaiModel || "deepseek-chat") === "deepseek-chat") {
          merged.openaiModel = DEFAULTS.openaiModel;
        }
        // v2: 识别模型默认从写死的 small 改成 auto（服务端按设备挑）
        if ((stored.model || "small") === "small") merged.model = DEFAULTS.model;
        // v3: 字幕底色默认从半透明黑改成全透明。
        //     0.6 是老默认值，用户没主动调过就跟着升；调过的（其它数值）保持不动。
        if (stored.bgOpacity === undefined || stored.bgOpacity === 0.6) {
          merged.bgOpacity = DEFAULTS.bgOpacity;
        }
        // v4: 同时显示条数默认从 2 改成 1。
        //     2 是老默认值，没主动调过就跟着升；调成 3/4 的保持不动。
        if (stored.maxLines === undefined || stored.maxLines === 2) {
          merged.maxLines = DEFAULTS.maxLines;
        }
        merged.settingsVersion = SETTINGS_VERSION;
        // ★ 直接写存储，**不能**调 saveSettings()：
        //   saveSettings 内部会 await loadSettings()，而 loadSettings 又触发迁移，
        //   两个函数互相调用会无限递归。这个坑是被 tools\test_settings_migration.mjs 抓出来的。
        try {
          await storageArea().set({ vst_settings: merged });
        } catch (e) {
          /* 写不进去也不影响本次返回值，下次启动再迁移 */
        }
      }
      return merged;
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  async function saveSettings(patch) {
    const cur = await loadSettings();
    const next = Object.assign({}, cur, patch || {});
    for (const k of TRANSIENT_KEYS) delete next[k];
    await storageArea().set({ vst_settings: next });
    return next;
  }

  /** 只把和后端有关的字段打包，用于发给 offscreen / 本地服务 */
  function serverConfig(s) {
    return {
      serverUrl: s.serverUrl,
      model: s.model,
      sourceLang: s.sourceLang || null,
      targetLang: s.targetLang,
      translate: !!s.translate,
      translatePartials: !!s.translatePartials,
      translator: s.translator || "auto",
      deepl_api_key: s.deeplApiKey || "",
      openai_api_key: s.openaiApiKey || "",
      openai_base_url: s.openaiBaseUrl || "",
      openai_model: s.openaiModel || "",
    };
  }

  function onSettingsChanged(cb) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if ((area === "sync" || area === "local") && changes.vst_settings) {
        cb(Object.assign({}, DEFAULTS, changes.vst_settings.newValue || {}));
      }
    });
  }

  root.VST = {
    DEFAULTS: DEFAULTS,
    TARGETS: TARGETS,
    SOURCES: SOURCES,
    MODELS: MODELS,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    onSettingsChanged: onSettingsChanged,
    serverConfig: serverConfig,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
