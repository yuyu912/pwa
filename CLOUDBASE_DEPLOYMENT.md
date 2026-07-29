# 衣橱关系 CloudBase 部署手册

## 1. 费用确认边界

创建资源前，在腾讯云控制台确认 CloudBase 环境、云托管计算、Serverless MySQL、NAT/公网流量的实际计费方式和账户余额。未得到用户明确确认，不点击开通或购买。

首轮配置：

- 地域：广州。
- 云托管：低成本模式，1 核 1 GB，最小副本 0，最大副本 1。
- 服务端口：3000。
- 数据库：CloudBase MySQL，开启连续 10 分钟无访问自动暂停。
- 访问：先使用系统默认 HTTPS 域名，仅用于 10 人以内测试。

## 2. 创建与部署

1. 创建 CloudBase 环境和 MySQL，确保云托管与 MySQL 位于同一环境/网络。
2. 新建云托管服务 `wardrobe-pwa`，使用本目录代码和 `Dockerfile` 构建。
3. 开启公网访问，端口填写 `3000`；流量先保持 0%。
4. 按 `.env.cloud.example` 填写环境变量。真实值只进入 CloudBase 控制台：
   - `COOKIE_SECURE=true`
   - `DB_DRIVER=mysql`
   - `DB_*`
   - `JWT_SECRET`、`ADMIN_BOOTSTRAP_TOKEN`
   - `COS_*`、`COS_CI_ENABLED`
   - `TIIA_*`
   - `VITA_*`
5. 构建成功后，访问 `/api/health`。必须返回：

```json
{"ok":true,"service":"wardrobe","database":"ready"}
```

## 3. 正式数据迁移

迁移前停止本地新增数据，并保留 `data/wardrobe.sqlite` 原件。

迁移脚本只接受空的云端业务表，且本地数据必须符合已确认基线：

- users：1
- invites：1
- clothing_items：5
- wear_logs：6
- candidates：0
- image_drafts：不迁移

在安全的本地终端临时提供 `DB_*` 环境变量后运行：

```powershell
npm run migrate:cloudbase
npm run verify:cloudbase
```

脚本使用参数化 SQL 和单个事务，不生成包含密码哈希的中间导出文件。任何数量不匹配、云端非空或孤立穿着记录都会中止并回滚。

## 4. 发布与验收

1. 先给新版本 0% 流量，通过健康检查和数据计数。
2. 使用原账号正常登录，不伪造 Cookie 或 JWT。
3. 验证衣橱 5 件衣物、6 条穿着记录、图片可读。
4. 切换 100% 流量后，用手机在 Wi-Fi 和蜂窝网络分别验证：
   - 冷启动显示“正在唤醒云端衣橱”；
   - 上传、抠图、识别、确认、保存；
   - TIIA 失败时衣物仍保存并显示降级说明；
   - 衣物详情和穿着记录正常；
   - 电脑关机后仍可使用。
5. 验收通过后停止本机 `WardrobePwaServer` 计划任务，但暂不删除；原 SQLite 保留用于短期回退。

## 5. 回滚

- 云端发布失败：流量切回上一云托管版本。
- 数据迁移失败：事务自动回滚，修复原因后重新迁移；不覆盖本地 SQLite。
- 云端整体不可用：短期恢复本机任务与局域网地址，仅作为应急，不作为正式入口。
