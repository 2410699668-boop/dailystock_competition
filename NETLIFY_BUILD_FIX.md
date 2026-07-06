# Netlify 构建失败修复说明

## 本次失败的直接原因

原 `package-lock.json` 在开发环境生成时，把依赖包的 `resolved` 地址写成了 OpenAI 内部 Artifactory：

```text
packages.applied-caas-gateway1.internal.api.openai.org
```

Netlify 无法访问该内部地址，因此 `npm install` 在下载 `iceberg-js` 时超时。仓库原先并没有 `.npmrc`，真正需要修复的是锁文件中的完整下载地址。

此外，原 `netlify.toml` 固定使用 Node 20，而当前锁定的 Supabase JS 2.110.0 要求 Node 22。

## 已完成的修复

- `package-lock.json`：全部 `resolved` 地址改为 `https://registry.npmjs.org/`；
- `.npmrc`：明确指定 npm 公共仓库；
- `.nvmrc`：指定 Node 22；
- `netlify.toml`：`NODE_VERSION` 改为22；
- `package.json`：Node要求改为22，并固定 Supabase和esbuild版本；
- 构建前增加内部仓库地址检查，避免同类问题再次出现。

## 重新部署

将本修复包内的所有文件覆盖上传到GitHub仓库根目录，然后提交。Netlify会自动触发新部署。

如果没有自动触发，在Netlify进入：

```text
Deploys → Trigger deploy → Clear cache and deploy site
```

建议选择 **Clear cache and deploy site**，防止旧依赖缓存继续被使用。

## Netlify环境变量

确认仍然存在：

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

不要设置 `NPM_CONFIG_REGISTRY` 为其他地址。如果Netlify环境变量里存在该项，请删除。
