# Netlify 发布步骤

## 推荐：GitHub连接部署

1. 在 GitHub 新建空仓库。
2. 把项目中的全部文件上传到仓库根目录。
3. 登录 Netlify。
4. 选择 `Add new project → Import an existing project`。
5. 连接 GitHub 并选择仓库。
6. Netlify会自动读取 `netlify.toml`：

```text
Build command: npm run build
Publish directory: public
Functions directory: netlify/functions
Node: 20
```

7. 部署前设置环境变量：

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

8. 点击 Deploy。

## Netlify CLI部署

```bash
npm install
npx netlify login
npx netlify init
npx netlify env:set SUPABASE_URL "https://你的项目.supabase.co"
npx netlify env:set SUPABASE_PUBLISHABLE_KEY "你的key"
npx netlify deploy --build --prod
```

## 发布后的地址

```text
网站：https://你的项目名.netlify.app/
健康检查：https://你的项目名.netlify.app/api/health
```

共享数据不再经过 Netlify Function，而是由浏览器通过 Supabase Data API 和 Realtime 访问。

行情仍经过 Netlify Functions：

```text
/api/quote
/api/history
```

## 不建议只拖入 public 文件夹

`public/config.js`需要通过构建读取Netlify环境变量，`public/app.js`也需要打包Supabase客户端。因此请使用GitHub导入或带 `--build` 的Netlify CLI部署。


## 构建环境要求

本项目固定使用 Node 22，并通过 `.npmrc` 和修正后的 `package-lock.json` 使用 npm 公共仓库。重新部署时建议选择 `Clear cache and deploy site`。
