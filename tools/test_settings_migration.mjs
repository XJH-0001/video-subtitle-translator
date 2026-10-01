/**
 * 验证「设置迁移」能否把老配置纠正成 DeepSeek。
 *
 *   node tools/test_settings_migration.mjs
 *
 * 背景：扩展发过来的 translator 会**覆盖**服务端配置。
 * 老版本存的是 "auto"（免费接口竞速），如果不迁移，
 * 用户重载扩展后依然走免费接口 —— 服务端明明配了 DeepSeek 也没用。
 *
 * 这个测试用**用户机器上实际读到的存储值**跑一遍真实的 loadSettings()。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ── 用户 Edge 里实际存的那组值（用 tools/read_ext_settings.py 读出来的）──
// 额外带上老版本的 bgOpacity=0.6，验证底色也会一起迁移到「全透明」
const STORED = {
  translator: "auto",
  openaiModel: "deepseek-chat",
  openaiBaseUrl: "https://api.deepseek.com/v1",
  model: "small",
  bgOpacity: 0.6,
  maxLines: 2,
  showSource: true,
  targetLang: "zh",
  translate: true,
  translatePartials: true,
};

function runLoadSettings(stored) {
  const src = readFileSync(join(ROOT, "extension", "common.js"), "utf8");

  const written = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    chrome: {
      storage: {
        sync: {
          get: async () => ({ vst_settings: structuredClone(stored) }),
          set: async (obj) => {
            written.push(structuredClone(obj.vst_settings));
          },
        },
        local: {
          get: async () => ({}),
          set: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      runtime: { sendMessage: async () => ({}) },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "common.js" });
  return { VST: sandbox.VST, written };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? "  → " + detail : ""}`);
}

console.log("");
console.log("=".repeat(62));
console.log("  设置迁移验证（用你机器上真实的存储值）");
console.log("=".repeat(62));
console.log("");
console.log("  迁移前的存储：");
for (const [k, v] of Object.entries(STORED)) console.log(`     ${k} = ${JSON.stringify(v)}`);
console.log("");

const { VST, written } = runLoadSettings(STORED);
const merged = await VST.loadSettings();

console.log("  迁移后 loadSettings() 返回：");
for (const k of ["translator", "openaiModel", "model", "bgOpacity", "maxLines", "showSource", "settingsVersion"]) {
  console.log(`     ${k} = ${JSON.stringify(merged[k])}`);
}
console.log("");

check("翻译服务切到 openai（DeepSeek）", merged.translator === "openai", merged.translator);
check("翻译模型切到 deepseek-flash", merged.openaiModel === "deepseek-flash", merged.openaiModel);
check("识别模型切到 auto", merged.model === "auto", merged.model);
check("字幕底色改成全透明（0）", merged.bgOpacity === 0, String(merged.bgOpacity));
check("同屏条数改成 1", merged.maxLines === 1, String(merged.maxLines));
check("默认只显示译文（不再先冒原文）", merged.showSource === false, String(merged.showSource));
// 版本号写成 >= 2 而不是写死具体数字 —— 以后再加迁移就不用改测试了
check("打上版本号（只迁移一次）", Number(merged.settingsVersion) >= 2, String(merged.settingsVersion));
check("迁移结果被写回存储", written.length > 0, `${written.length} 次写入`);
check("其他设置没被误改", merged.targetLang === "zh" && merged.translatePartials === true);

// --- 幂等性：再跑一次不应该再变 ---
console.log("");
console.log("  ── 再跑一次（幂等性）──");
const second = await VST.loadSettings();
const stable = JSON.stringify(second) === JSON.stringify(merged);
check("第二次结果与第一次完全一致（幂等）", stable);
if (!stable) {
  for (const k of Object.keys(second)) {
    if (JSON.stringify(second[k]) !== JSON.stringify(merged[k])) {
      console.log(`       差异: ${k}  ${JSON.stringify(merged[k])} → ${JSON.stringify(second[k])}`);
    }
  }
}

// --- 用户主动选过别的，就不该被覆盖 ---
console.log("");
console.log("  ── 用户主动选过别的（不该被覆盖）──");
const { VST: V2 } = runLoadSettings({
  translator: "youdao",
  openaiModel: "gpt-4o-mini",
  model: "medium",
  bgOpacity: 0.35,          // 自己调过底色 → 不该被迁移改掉
  maxLines: 3,              // 自己调过条数 → 也不该被改掉
  settingsVersion: 9,       // 比当前版本还新 → 任何迁移都不该跑
});
const keep = await V2.loadSettings();
check("已选 youdao 保持不变", keep.translator === "youdao", keep.translator);
check("已选 gpt-4o-mini 保持不变", keep.openaiModel === "gpt-4o-mini", keep.openaiModel);
check("已选 medium 保持不变", keep.model === "medium", keep.model);
check("自己调过的底色保持不变", keep.bgOpacity === 0.35, String(keep.bgOpacity));
check("自己调过的条数保持不变", keep.maxLines === 3, String(keep.maxLines));

// --- serverConfig 会发什么给服务端 ---
console.log("");
console.log("  ── 迁移后扩展会发给服务端的字段 ──");
const cfg = VST.serverConfig(merged);
console.log(`     translator      = ${JSON.stringify(cfg.translator)}`);
console.log(`     openai_model    = ${JSON.stringify(cfg.openai_model)}`);
console.log(`     openai_api_key  = ${cfg.openai_api_key ? "(空 → 用服务端那份)" : "(空)"}`);
check("发给服务端的是 openai", cfg.translator === "openai");

const failed = results.filter((r) => !r.ok);
console.log("");
console.log("=".repeat(62));
if (failed.length === 0) {
  console.log("  ✅ 全部通过 —— 重载扩展后就会走 DeepSeek");
} else {
  console.log(`  ❌ ${failed.length} 项未通过`);
}
console.log("=".repeat(62));
console.log("");
process.exit(failed.length === 0 ? 0 : 1);
