import { access, readFile } from "node:fs/promises";

const required = [
  "public/index.html",
  "public/app.js",
  "public/config.js",
  "public/styles.css",
  "src/app.js",
  "supabase/schema.sql",
  "netlify/functions/quote.mjs",
  "netlify/functions/history.mjs",
  "netlify/functions/health.mjs",
  "netlify/lib/market.mjs"
];

for (const file of required) await access(file);
const html = await readFile("public/index.html", "utf8");
const app = await readFile("src/app.js", "utf8");
const schema = await readFile("supabase/schema.sql", "utf8");
const lock = await readFile("package-lock.json", "utf8");

if (!html.includes('id="app"') || !html.includes('src="/config.js"') || !html.includes('src="/app.js"')) {
  throw new Error("public/index.html 缺少应用或 Supabase 配置入口");
}
if (!app.includes('from "@supabase/supabase-js"') || !app.includes('competition_state')) {
  throw new Error("Supabase 前端同步模块不完整");
}
if (!schema.includes("enable row level security") || !schema.includes("supabase_realtime")) {
  throw new Error("Supabase SQL 缺少 RLS 或 Realtime 配置");
}
if (lock.includes("applied-caas-gateway") || lock.includes("artifactory/api/npm/npm-public")) {
  throw new Error("package-lock.json 含内部 npm 仓库地址");
}
console.log("Supabase 共创版文件检查通过");
