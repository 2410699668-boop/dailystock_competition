# Supabase 设置步骤

Supabase 官网：https://supabase.com/

## 1. 创建项目

1. 打开 Supabase 官网并登录。
2. 点击 `New project`。
3. 选择组织，填写项目名称，例如 `stock-competition`。
4. 设置数据库密码并妥善保存。
5. 选择离主要用户较近的 Region。
6. 点击创建项目，等待初始化完成。

## 2. 创建数据表和权限

1. 打开项目左侧的 `SQL Editor`。
2. 点击 `New query`。
3. 打开本项目的 `supabase/schema.sql`。
4. 复制全部SQL到编辑器。
5. 点击 `Run`。

执行成功后，会出现：

- `competition_state`
- `competition_state_history`

SQL还会自动完成：

- Row Level Security
- 公开读写策略
- revision自动递增
- 历史版本记录
- Realtime publication

## 3. 获取前端参数

在 Supabase Dashboard 中打开项目的 API 设置页面，复制：

```text
Project URL
Publishable key
```

部分旧项目界面可能显示：

```text
anon public key
```

该 key 也可以作为 `SUPABASE_PUBLISHABLE_KEY` 使用。

不要使用：

```text
service_role key
secret key
数据库密码
```

## 4. 在 Netlify 配置

进入 Netlify 网站项目：

```text
Project configuration
→ Environment variables
→ Add a variable
```

添加：

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

保存后执行一次重新部署：

```text
Deploys
→ Trigger deploy
→ Deploy site
```

## 5. 验证

打开网站后检查顶部状态：

```text
在线 · Supabase 实时同步
```

再打开另一个浏览器窗口：

1. 添加一个测试参赛者；
2. 观察另一个窗口是否自动出现；
3. 修改参赛者名字；
4. 确认两个窗口同步。

## 常见错误

### 尚未配置 Supabase

检查Netlify环境变量是否填写，并重新部署。

### 数据表尚未创建

在 Supabase SQL Editor 重新运行 `supabase/schema.sql`。

### RLS权限错误

说明SQL没有完整执行。重新运行 `supabase/schema.sql`。

### 修改没有实时出现

1. 等待15秒备用轮询；
2. 检查SQL是否把 `competition_state` 加入 `supabase_realtime` publication；
3. 点击页面顶部“立即同步”。

### 网站可以读取但不能写入

检查使用的是 Publishable key/anon key，并确认三条RLS policy存在：

- `competition_state_public_read`
- `competition_state_public_insert`
- `competition_state_public_update`
