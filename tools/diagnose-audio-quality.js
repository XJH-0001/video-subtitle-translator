/* ============================================================================
 *  音频「发闷」诊断 —— 判断到底糊在源头，还是糊在系统输出
 *
 *  用法：
 *    1. 打开那个视频，点播放，确认有声音
 *    2. 按 F12 打开开发者工具，切到「控制台 / Console」
 *    3. 把下面**全部内容**粘进去，回车
 *    4. 等 3 秒左右，把输出结果发给我
 *
 *  原理：
 *    用 video.captureStream() 把**解码之后、送到扬声器之前**的音频抓出来做 FFT。
 *    这一段完全没有经过系统混音器、也没经过插件，所以：
 *      · 高频缺失  → 糊在源头（片源本身、或播放器/解码器），浏览器和插件都救不了
 *      · 高频正常  → 糊在输出侧（Windows 音频增强、蓝牙耳机切到了通话模式、插件等）
 *    这样就能一句话锁定方向，不用猜。
 * ==========================================================================*/

(async () => {
  const log = (...a) => console.log("%c[音频诊断]", "color:#0a0;font-weight:bold", ...a);
  const warn = (...a) => console.log("%c[音频诊断]", "color:#c60;font-weight:bold", ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. 找正在播放的视频 -------------------------------------------------
  const vids = [...document.querySelectorAll("video")].filter((v) => v.videoWidth > 0);
  if (!vids.length) {
    warn("页面上没有正在播放的 <video>，请先点播放再运行");
    return;
  }
  vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
  const v = vids[0];

  log("视频元素：", {
    分辨率: `${v.videoWidth}×${v.videoHeight}`,
    时长: Number.isFinite(v.duration) ? `${v.duration.toFixed(1)}s` : "未知",
    音量: v.volume,
    静音: v.muted,
    播放中: !v.paused,
    源: String(v.currentSrc || v.src || "").slice(0, 120),
    用了MSE: String(v.src || v.currentSrc || "").startsWith("blob:"),
  });

  // ---- 2. 页面里有没有 HLS 播放器 ------------------------------------------
  const hints = [];
  for (const key of ["hls", "player", "plyr", "videojs", "jwplayer", "dplayer", "art"]) {
    if (window[key]) hints.push(key);
  }
  if (hints.length) log("检测到播放器对象：", hints.join(", "));

  // 试着从 hls.js 里读出音轨信息
  try {
    const h = window.hls;
    if (h && h.levels && h.levels.length) {
      log("HLS 画质档位：", h.levels.map((L, i) => ({
        档位: i,
        // eslint-disable-next-line no-underscore-dangle
        分辨率: L.width ? `${L.width}×${L.height}` : "?",
        码率kbps: L.bitrate ? Math.round(L.bitrate / 1000) : "?",
        音频: L.audioCodec || "无标注",
      })));
      log("当前档位：", h.currentLevel);
    }
  } catch (e) { /* 忽略 */ }

  // ---- 3. 抓解码后的音频做频谱分析 -----------------------------------------
  if (!v.captureStream) {
    warn("这个浏览器不支持 video.captureStream()，无法做频谱分析");
    return;
  }

  let stream;
  try {
    stream = v.captureStream();
  } catch (e) {
    warn("captureStream 失败：", e.message);
    return;
  }
  const audioTracks = stream.getAudioTracks();
  log("抓到的音频轨：", audioTracks.length, audioTracks.map((t) => t.getSettings && t.getSettings()));

  if (!audioTracks.length) {
    warn("⚠ 这个视频**没有音频轨**（或已被抓走）—— 如果此时你仍能听到声音，说明是别的元素在出声");
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  try { await actx.resume(); } catch (e) { /* 忽略 */ }

  let analyser = null;
  let src = null;
  if (audioTracks.length) {
    try {
      src = actx.createMediaStreamSource(new MediaStream(audioTracks));
      analyser = actx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.3;
      src.connect(analyser);
      // 不接 destination —— 避免和分析器形成第二路播放
    } catch (e) {
      warn("建立分析节点失败：", e.message);
    }
  }

  log("AudioContext 采样率：", actx.sampleRate, "Hz  （设备/图谱的渲染采样率）");

  if (!analyser) {
    warn("拿不到音频样本，只能报告以上信息");
    try { actx.close(); } catch (e) { /* 忽略 */ }
    return;
  }

  // ---- 4. 采样 3 秒，取各频段能量 ------------------------------------------
  const bins = analyser.frequencyBinCount;
  const nyquist = actx.sampleRate / 2;
  const hzPerBin = nyquist / bins;
  const acc = new Float64Array(bins);
  const time = new Uint8Array(analyser.fftSize);
  let frames = 0;
  let peakTime = 0;

  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const spec = new Uint8Array(bins);
    analyser.getByteFrequencyData(spec);
    for (let i = 0; i < bins; i++) acc[i] += spec[i];
    analyser.getByteTimeDomainData(time);
    for (let i = 0; i < time.length; i++) peakTime = Math.max(peakTime, Math.abs(time[i] - 128) / 128);
    frames++;
    await sleep(50);
  }

  const avg = Array.from(acc, (x) => x / Math.max(1, frames));
  const band = (lo, hi) => {
    const a = Math.max(0, Math.floor(lo / hzPerBin));
    const b = Math.min(bins - 1, Math.ceil(hi / hzPerBin));
    let s = 0;
    for (let i = a; i <= b; i++) s += avg[i];
    return s / Math.max(1, b - a + 1);
  };

  const bands = {
    "低频 60-250Hz": band(60, 250),
    "中低 250-1kHz": band(250, 1000),
    "中频 1-4kHz（人声清晰度）": band(1000, 4000),
    "高频 4-8kHz": band(4000, 8000),
    "极高频 8-16kHz（空气感/齿音）": band(8000, 16000),
  };
  const maxBand = Math.max(...Object.values(bands));

  log("各频段平均能量（0-255，越高越强）：");
  for (const [k, val] of Object.entries(bands)) {
    const bars = "█".repeat(Math.round((val / Math.max(1, maxBand)) * 40));
    console.log(`   ${k.padEnd(26)} ${val.toFixed(1).padStart(6)}  ${bars}`);
  }

  const high = (band(4000, 8000) + band(8000, 16000)) / 2;
  const mid = band(250, 4000);
  const ratio = mid > 0.5 ? high / mid : 0;

  log("波形峰值：", peakTime.toFixed(3), peakTime < 0.02 ? "⚠ 几乎没有信号（是不是静音/没在放）" : "");
  log("高频/中频 比值：", ratio.toFixed(3));

  // ---- 5. 下结论 -----------------------------------------------------------
  if (peakTime < 0.02) {
    warn("基本没抓到信号，请确认视频在播放且不是静音，再重跑一次");
  } else if (ratio < 0.12) {
    warn("❌ 结论：**糊在源头**。解码出来的音频本身高频就很少 ——");
    console.log("   这是片源/播放器的问题，浏览器设置、系统音效、插件都改变不了。");
    console.log("   常见原因：网站把音频重新压成了低码率单声道（比如 64kbps 甚至更低）。");
  } else if (ratio < 0.35) {
    warn("⚠ 偏高但偏暗：源头音频质量一般，但不算「糊到家」");
    console.log("   如果你听感明显比这个更糊，问题更可能在系统输出侧（见下面检查项）。");
  } else {
    console.log("%c✅ 结论：解码出来的音频高频正常 —— 糊在**输出侧**，不是片源。", "color:#0a0;font-weight:bold");
    console.log("   请检查：Windows 音频增强 / 空间音效、蓝牙耳机是否切到了通话模式(Hands-Free)、");
    console.log("   以及 Edge 里是否有别的扩展在处理音频。");
  }

  console.log("");
  console.log("%c── 另外也请贴给我这些信息 ──", "color:#06c;font-weight:bold");
  console.log("输出设备：", await (async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === "audiooutput").map((d) => d.label || "(无标签)");
    } catch (e) { return "拿不到"; }
  })());

  try { src && src.disconnect(); } catch (e) { /* 忽略 */ }
  try { await actx.close(); } catch (e) { /* 忽略 */ }
  log("诊断结束。把上面全部输出复制给我。");
})();
