/*
 * 验证「未打包扩展 ID 由绝对路径推导」的算法。
 * 如果你看到某一行标了 ✅，说明安装脚本可以自己算出 ID，不必等扩展先加载一次。
 */
import { createHash } from "node:crypto";

const EXPECTED = "cklgbajekihboflmllhodmndoemkgpmj";
const RAW = "D:\\DSH-Workspace\\video-subtitle-translator\\extension";

function idFromBuffer(buf) {
  const h = createHash("sha256").update(buf).digest("hex").slice(0, 32);
  return [...h].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const variants = [
  ["原样 UTF-16LE", Buffer.from(RAW, "utf16le")],
  ["原样 UTF-8", Buffer.from(RAW, "utf8")],
  ["末尾带反斜杠 UTF-16LE", Buffer.from(RAW + "\\", "utf16le")],
  ["正斜杠 UTF-16LE", Buffer.from(RAW.replace(/\\/g, "/"), "utf16le")],
  ["正斜杠 UTF-8", Buffer.from(RAW.replace(/\\/g, "/"), "utf8")],
  ["小写盘符 UTF-16LE", Buffer.from(RAW[0].toLowerCase() + RAW.slice(1), "utf16le")],
  ["大写整串 UTF-16LE", Buffer.from(RAW.toUpperCase(), "utf16le")],
  ["末尾带反斜杠 UTF-8", Buffer.from(RAW + "\\", "utf8")],
];

console.log(`期望 ID: ${EXPECTED}\n`);
let hit = null;
for (const [label, buf] of variants) {
  const id = idFromBuffer(buf);
  const ok = id === EXPECTED;
  if (ok) hit = label;
  console.log(`  ${ok ? "✅" : "  "} ${label.padEnd(26)} ${id}`);
}

console.log("");
if (hit) {
  console.log(`推导成功：${hit}`);
} else {
  console.log("全部不匹配 —— 安装脚本改为从 Edge 配置里读真实 ID（更可靠）。");
}
