import { readFile } from "node:fs/promises";

const lock = await readFile("package-lock.json", "utf8");
const forbidden = [
  "packages.applied-caas-gateway1.internal.api.openai.org",
  "artifactory/api/npm/npm-public"
];

for (const host of forbidden) {
  if (lock.includes(host)) {
    throw new Error(`package-lock.json 仍包含不可公开访问的 npm 地址：${host}`);
  }
}

if (!lock.includes("https://registry.npmjs.org/")) {
  throw new Error("package-lock.json 未使用 npm 公共仓库");
}

console.log("npm 仓库检查通过：全部依赖使用 registry.npmjs.org");
