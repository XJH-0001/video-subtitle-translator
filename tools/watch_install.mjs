/*
 * 盯着 Edge 配置，等扩展被装上。
 *
 *     node tools/watch_install.mjs [最长等待秒数]
 *
 * 每 2 秒读一次 Default/Secure Preferences，出现我们的扩展 ID 就退出 0。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EXT_ID = "cklgbajekihboflmllhodmndoemkgpmj";
const PATH_HINT = "video-subtitle-translator";
const UD = join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\User Data");
const TIMEOUT = Number(process.argv[2] || 900) * 1000;

const FILES = [
  join(UD, "Default", "Secure Preferences"),
  join(UD, "Default", "Preferences"),
];

const t0 = Date.now();
let lastNote = 0;

function check() {
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    let pref;
    try {
      pref = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue; // Edge 正在写，读一半会失败，下一轮再试
    }
    const settings = pref?.extensions?.settings || {};
    for (const [id, e] of Object.entries(settings)) {
      const p = String(e.path || "");
      const isOurs = id === EXT_ID || (p.includes(PATH_HINT) && !p.includes("Program Files"));
      if (isOurs) return { id, entry: e, file: f };
    }
  }
  return null;
}

console.log(`开始监听 Edge 配置（最多 ${TIMEOUT / 1000} 秒）…`);
console.log(`  ${FILES[0]}`);

const timer = setInterval(() => {
  const hit = check();
  if (hit) {
    clearInterval(timer);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log("\n" + "=".repeat(60));
    console.log(`  ✅ 检测到扩展已安装！（等待 ${secs}s）`);
    console.log("=".repeat(60));
    console.log(`  扩展 ID : ${hit.id}`);
    console.log(`  路径    : ${hit.entry.path || "(未记录)"}`);
    console.log(`  location: ${hit.entry.location}`);
    console.log(`  state   : ${hit.entry.state}   ${hit.entry.state === 1 ? "(已启用)" : "(注意：不是启用状态)"}`);
    if (hit.entry.manifest?.name) console.log(`  名称    : ${hit.entry.manifest.name}`);
    console.log(`  版本    : ${hit.entry.manifest?.version || "?"}`);
    console.log(`  记录于  : ${hit.file}`);
    process.exit(0);
  }
  const el = (Date.now() - t0) / 1000;
  if (el - lastNote >= 20) {
    lastNote = el;
    console.log(`  … 等待中 (${el.toFixed(0)}s)`);
  }
  if (Date.now() - t0 > TIMEOUT) {
    clearInterval(timer);
    console.log(`\n超时（${TIMEOUT / 1000}s）—— 还没检测到安装。`);
    process.exit(2);
  }
}, 2000);
