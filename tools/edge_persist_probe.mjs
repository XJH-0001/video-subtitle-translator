/*
 * 持久化复测（修正版）。
 *
 * 上一版只读了 Default/Preferences，但 Chromium 的扩展记录其实存在
 * Default/Secure Preferences 里 —— 所以那一版的「不持久」结论可能是错的。
 * 这一版两个文件都读，并且用【有头】浏览器（headless 的扩展行为可能不同）。
 *
 *     node tools/edge_persist_probe.mjs [--headed]
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT = resolve(import.meta.dirname, "..", "extension");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync);
const HEADED = process.argv.includes("--headed");

const PROFILE = mkdtempSync(join(tmpdir(), "edge-probe2-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUR_SW = "/background.js";
let port = 9500;

function launch(extraArgs) {
  port++;
  const args = [
    ...(HEADED ? [] : ["--headless=new", "--disable-gpu"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--user-data-dir=" + PROFILE,
    "--remote-debugging-port=" + port,
    "--remote-allow-origins=*",
    ...extraArgs,
    "about:blank",
  ];
  return { proc: spawn(EDGE, args, { stdio: "ignore" }), port };
}

async function findOurs(p) {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json();
      const ours = list.find((t) => String(t.url).endsWith(OUR_SW));
      if (ours) return ours;
    } catch {}
    await sleep(500);
  }
  return null;
}

async function stop(proc) {
  proc.kill();
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      process.kill(proc.pid, 0);
    } catch {
      break;
    }
  }
  await sleep(1500); // 等配置真正落盘
}

async function run(label, extraArgs) {
  const { proc, port: p } = launch(extraArgs);
  const t = await findOurs(p);
  console.log(`  ${label}`);
  console.log(`    扩展加载: ${t ? "✅ " + t.url : "❌ 没有"}`);
  await stop(proc);
  return t ? new URL(t.url).host : null;
}

function dumpExtPrefs(tag) {
  const dir = join(PROFILE, "Default");
  if (!existsSync(dir)) {
    console.log(`    [${tag}] Default 目录不存在`);
    return;
  }
  for (const fname of ["Preferences", "Secure Preferences"]) {
    const f = join(dir, fname);
    if (!existsSync(f)) {
      console.log(`    [${tag}] ${fname}: 不存在`);
      continue;
    }
    let pref;
    try {
      pref = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      console.log(`    [${tag}] ${fname}: 解析失败 ${e.message}`);
      continue;
    }
    const settings = pref?.extensions?.settings || {};
    const ids = Object.keys(settings);
    console.log(`    [${tag}] ${fname}: ${ids.length} 个扩展记录`);
    for (const id of ids) {
      const e = settings[id];
      console.log(`         ${id} location=${e.location} state=${e.state}`);
      if (e.path) console.log(`             path=${e.path}`);
      if (e.manifest?.name) console.log(`             name=${e.manifest.name}`);
    }
    const arrays = Object.entries(pref?.extensions || {})
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k}=[${v.length}]`);
    if (arrays.length) console.log(`         数组: ${arrays.join(" ")}`);
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log(`  扩展持久化复测（${HEADED ? "有头" : "无头"}，临时 profile）`);
  console.log("=".repeat(70));
  console.log(`  扩展目录: ${EXT}\n  临时配置: ${PROFILE}\n`);

  console.log("[1/3] 带 --load-extension 首次启动");
  const id1 = await run("第一次", [`--load-extension=${EXT}`]);
  dumpExtPrefs("第一次后");

  console.log("\n[2/3] 重启，不带 --load-extension");
  const id2 = await run("第二次", []);
  dumpExtPrefs("第二次后");

  console.log("\n[3/3] 再重启一次（确认不是偶然）");
  const id3 = await run("第三次", []);

  console.log("\n" + "=".repeat(70));
  if (id1 && id2 && id3) {
    console.log("  结论：持久化成功 ✅");
    console.log("  可以用「关闭 Edge → 带参数启动一次 → 之后再正常开」的方式永久装上。");
  } else if (id1 && !id2 && !id3) {
    console.log("  结论：不持久 ❌  --load-extension 只在当次启动有效");
    console.log("  → 持久安装只能人工点一次「加载解压缩的扩展」");
  } else {
    console.log(`  结论：异常（第一次=${id1 ? "有" : "无"} 第二次=${id2 ? "有" : "无"} 第三次=${id3 ? "有" : "无"}）`);
  }
  console.log("=".repeat(70));

  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
  return id2 ? 0 : 2;
}

process.exit(await main());
