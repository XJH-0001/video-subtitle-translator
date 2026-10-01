/*
 * 直接测 Native Messaging Host 可执行文件本身：
 * 按协议喂一条消息、读回响应 —— 不经过浏览器。
 *
 *     node tools/test_native_host.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const HOST = resolve(import.meta.dirname, "..", "native", "ServerLauncher.exe");
if (!existsSync(HOST)) {
  console.log("找不到 " + HOST + "，先运行 scripts\\install.ps1");
  process.exit(1);
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

function parseFrames(buf) {
  const out = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const len = buf.readUInt32LE(off);
    if (buf.length - off - 4 < len) break;
    out.push(JSON.parse(buf.slice(off + 4, off + 4 + len).toString("utf8")));
    off += 4 + len;
  }
  return out;
}

const proc = spawn(HOST, [], { stdio: ["pipe", "pipe", "inherit"] });
const chunks = [];
proc.stdout.on("data", (d) => chunks.push(d));

proc.stdin.write(frame({ action: "ensure", port: 8765 }));
proc.stdin.end();

const code = await new Promise((r) => proc.on("close", r));
const buf = Buffer.concat(chunks);
const msgs = parseFrames(buf);

console.log(`退出码: ${code}`);
console.log(`收到 ${msgs.length} 条响应`);
for (const m of msgs) console.log("  " + JSON.stringify(m));

if (msgs.length === 1 && msgs[0].ok) {
  console.log("\n\x1b[32mNative Messaging 协议正常 ✅\x1b[0m");
  process.exit(0);
}
console.log("\n\x1b[31m协议不符合预期 ❌\x1b[0m");
process.exit(1);
