/*
 * 检查扩展有没有真的装进 Edge（读 profile 的 Secure Preferences）。
 *
 *     node tools/check_installed.mjs
 *
 * Edge 正在运行时会定期写盘，所以结果通常是准的；
 * 如果刚点完「加载解压缩的扩展」，建议等 3~5 秒再跑。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EXT_ID = "cklgbajekihboflmllhodmndoemkgpmj";
const EXT_PATH_HINT = "video-subtitle-translator";
const UD = join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\User Data");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// Chromium Manifest::Location 枚举
const LOCATIONS = {
  0: "INVALID",
  1: "INTERNAL（商店/内置）",
  2: "EXTERNAL_PREF",
  3: "EXTERNAL_REGISTRY",
  4: "UNPACKED（用户手动加载解压缩）",
  5: "COMPONENT（浏览器组件）",
  6: "EXTERNAL_PREF_DOWNLOAD",
  7: "EXTERNAL_POLICY_DOWNLOAD",
  8: "COMMAND_LINE（--load-extension 临时加载）",
  9: "EXTERNAL_POLICY",
  10: "EXTERNAL_COMPONENT",
};

function describeState(e) {
  // Chromium 只在「被禁用/终止」时才写 state；字段不存在就是启用中
  if (e.state === undefined || e.state === null) return "启用中（字段缺省）";
  if (e.state === 0) return "已禁用";
  if (e.state === 1) return "启用中";
  return `state=${e.state}`;
}

if (!existsSync(UD)) {
  console.log(`${RED}找不到 Edge 用户数据目录：${UD}${RESET}`);
  process.exit(1);
}

const profiles = readdirSync(UD, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name))
  .map((d) => d.name);

let found = null;
const scanned = [];

for (const prof of profiles) {
  for (const fname of ["Secure Preferences", "Preferences"]) {
    const f = join(UD, prof, fname);
    if (!existsSync(f)) continue;
    let pref;
    try {
      pref = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const settings = pref?.extensions?.settings || {};
    for (const [id, e] of Object.entries(settings)) {
      const p = String(e.path || "");
      const isOurs = id === EXT_ID || (p.includes(EXT_PATH_HINT) && !p.startsWith("C:\\Program Files"));
      if (isOurs) {
        scanned.push({ prof, fname, id, e });
        if (!found) found = { prof, fname, id, e };
      }
    }
  }
}

console.log("=".repeat(66));
console.log("  检查扩展是否已安装到 Edge");
console.log("=".repeat(66));
console.log(`  用户数据目录: ${UD}`);
console.log(`  配置目录: ${profiles.join(", ") || "(无)"}\n`);

if (found) {
  console.log(`${GREEN}✅ 已安装${RESET}`);
  console.log(`   位置    : ${found.prof} / ${found.fname}`);
  console.log(`   扩展 ID : ${found.id}`);
  console.log(`   路径    : ${found.e.path || "(未记录)"}`);
  console.log(`   location: ${found.e.location}  ${LOCATIONS[found.e.location] || "?"}`);
  console.log(`   状态    : ${describeState(found.e)}`);
  if (found.e.manifest?.name) console.log(`   名称    : ${found.e.manifest.name}`);
  if (found.e.manifest?.version) console.log(`   版本    : ${found.e.manifest.version}`);

  // 扩展的存储目录是否存在，能证明它的 Service Worker 真的跑过
  const udRoot = join(UD, found.prof);
  for (const [tag, sub] of [
    ["storage.sync 数据", "Sync Extension Settings"],
    ["storage.local 数据", "Local Extension Settings"],
  ]) {
    const d = join(udRoot, sub, found.id);
    const has = existsSync(d);
    console.log(`   ${tag.padEnd(18)}: ${has ? GREEN + "已生成 ✅" + RESET : DIM + "未生成" + RESET}`);
  }
  console.log(`\n${DIM}提示：改过扩展代码后，在 edge://extensions 里点一下「重新加载」即可。${RESET}`);
  process.exit(0);
}

console.log(`${RED}❌ 还没安装${RESET}`);
console.log("\n   在 Edge 里操作：");
console.log("     1. 地址栏输入 edge://extensions 回车");
console.log("     2. 打开左下角「开发人员模式」");
console.log("     3. 点「加载解压缩的扩展」");
console.log("     4. 文件选择框里按 Ctrl+V 粘贴路径，回车\n");
process.exit(2);
