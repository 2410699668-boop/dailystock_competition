# 每日选股擂台｜Netlify + Supabase 在线共创版

这是基于现有炒股比赛软件改造的在线共创版本：

```text
访问者浏览器
    ↓
Netlify 网站与行情 Functions
    ↓
Supabase Postgres + Realtime
```

所有访问同一网站的人读取和修改同一份比赛数据。

## Supabase 官网

- 官网：https://supabase.com/
- 控制台：https://supabase.com/dashboard
- 官方文档：https://supabase.com/docs
- 价格：https://supabase.com/pricing

## 已实现

- Supabase Postgres 保存共享比赛数据
- Supabase Realtime 接收其他用户的修改
- 15秒定时检查作为实时连接的备用机制
- 数据库 revision 乐观锁，检测多人同时修改
- 冲突后按记录 `updatedAt` 合并参赛者、比赛日和选股
- 删除墓碑，防止旧客户端恢复已删除记录
- 每次保存自动写入 `competition_state_history` 历史表
- 浏览器本地缓存，断网时仍可查看和继续编辑
- Netlify Functions 获取实时行情和历史日线
- 东方财富、腾讯和新浪多源行情回退
- 原有每日排名、总排名、选手总结、技术分析和图表功能全部保留

## 最短部署流程

1. 注册并登录 Supabase。
2. 创建一个免费项目。
3. 在 Supabase 的 SQL Editor 运行 `supabase/schema.sql`。
4. 在 Supabase 项目设置中复制：
   - Project URL
   - Publishable key；旧项目界面显示 anon key 也可以使用
5. 把整个项目上传到 GitHub。
6. 在 Netlify 中导入这个 GitHub 仓库。
7. 在 Netlify 环境变量中添加：

```text
SUPABASE_URL=https://你的项目编号.supabase.co
SUPABASE_PUBLISHABLE_KEY=你的PublishableKey
```

8. 重新部署。
9. 打开 Netlify 网站，顶部显示“Supabase 已同步”即完成。

详细步骤见：

- `SETUP_SUPABASE.md`
- `DEPLOY_NETLIFY.md`

## 权限模式

当前 `supabase/schema.sql` 按你的要求设置为：

> 任何知道网站地址的人都能读取和修改比赛数据，无需注册账号。

这最简单，但网站地址泄露后，陌生人也能修改数据。建议：

- 不公开传播网址；
- 定期导出 JSON；
- 在 Netlify 设置访问密码或站点保护；
- 正式运营时再改为 Supabase Auth 登录模式。

前端只能使用 Publishable key 或 anon key。**绝对不要把 service_role key 放进 Netlify 前端环境变量。**

## 数据库结构

只使用一份主状态，改造成本最低：

```text
competition_state
  id = main
  revision
  payload JSONB
  updated_at
  updated_by
```

每次保存的历史版本写入：

```text
competition_state_history
```

多人同时保存时，网页只更新与当前 `revision` 一致的记录；如果版本不一致，会重新读取并合并后重试。

## 从旧版迁移

1. 在旧版“数据管理”中导出 JSON。
2. 打开部署后的 Supabase 版本。
3. 进入“数据管理”。
4. 点击“导入 JSON”。
5. 导入后会自动保存到 Supabase，其他访问者会同步看到。

## 本地开发

要求 Node.js 20 或更高版本。

```bash
npm install
```

复制环境变量：

```bash
cp .env.example .env
```

填写 `.env` 后运行：

```bash
npx netlify dev
```

也可以先构建：

```bash
npm run build
```

## 文件结构

```text
public/
  index.html
  styles.css
  config.js              # 构建时自动生成
src/
  app.js
supabase/
  schema.sql             # 必须在 Supabase SQL Editor 运行
  restore_latest.sql     # 历史版本恢复示例
netlify/
  functions/
    quote.mjs
    history.mjs
    health.mjs
  lib/
    market.mjs
scripts/
  generate-config.mjs
  build-app.mjs
  validate.mjs
netlify.toml
package.json
```

## 恢复历史版本

在 Supabase Table Editor 中查看 `competition_state_history`，找到需要恢复的 `history_id`，然后参考 `supabase/restore_latest.sql` 执行恢复。

恢复操作本身也会生成新 revision，不会删除原历史。
