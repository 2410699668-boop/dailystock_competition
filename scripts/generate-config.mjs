import { writeFile } from "node:fs/promises";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";

const output = `window.APP_CONFIG = ${JSON.stringify({
  supabaseUrl,
  supabasePublishableKey
}, null, 2)};\n`;

await writeFile("public/config.js", output, "utf8");

if (!supabaseUrl || !supabasePublishableKey) {
  console.warn("警告：未检测到 SUPABASE_URL 或 SUPABASE_PUBLISHABLE_KEY。网站可构建，但上线后会显示未配置提示。");
} else {
  console.log("Supabase 前端配置已生成");
}
