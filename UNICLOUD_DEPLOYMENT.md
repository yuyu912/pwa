# 衣橱关系 uniCloud 阿里云免费版部署

更新日期：2026-07-27

## 1. 费用边界

- 选择 **uniCloud 阿里云免费服务空间**，售价 0 元/月。
- 不转换为按量计费，不升级套餐，不开启任何“超限按量”。
- 免费空间默认有效期一个月，到期前 15 天内需要手动免费续期。
- 免费额度耗尽后接受服务暂停，下个月恢复；不以自动扣费换取继续运行。
- uniCloud 免费不等于腾讯云 COS、数据万象、VITA、TIIA 免费。现有图片和 AI 服务仍按腾讯云自身规则计量。

官方额度说明：

https://doc.dcloud.net.cn/uniCloud/price.html

## 2. 本项目的免费版适配

目录：

```text
uniCloud-aliyun/
├─ cloudfunctions/
│  └─ wardrobe-api/
│     ├─ index.js
│     ├─ lib/
│     ├─ package.json
│     └─ package-lock.json
└─ database/
   ├─ wr_users.*
   ├─ wr_invites.*
   ├─ wr_clothing_items.*
   ├─ wr_wear_logs.*
   ├─ wr_candidates.*
   └─ wr_image_drafts.*
```

关键设计：

- 云函数 HTTP 路径固定为 `/wardrobe-api`，业务 API 仍保持 `/api/...`。
- 阿里云 URL 化请求体限制 2MB，因此手机不把图片上传给云函数。
- 登录后先向云函数申请 5 分钟有效的单对象 COS PUT 地址，再由手机直传私有 COS。
- 云函数验证上传对象、计算 SHA-256、执行商品抠图、VITA 标签和 TIIA 相似检查。
- 登录使用 7 天 JWT；本地 Express 版本仍使用原 Cookie，两种模式互不影响。
- 数据库集合禁止客户端直接读写，所有权限判断都在云函数完成。

## 3. 创建免费服务空间

需要安装并登录 HBuilderX：

1. 打开 `pwa` 文件夹。
2. 在项目中找到 `uniCloud-aliyun`。
3. 关联服务空间时选择“新建服务空间”。
4. 服务商选择“阿里云”，套餐选择“免费版”。
5. 确认页面金额为 0 元。
6. 不选择按量计费，不预存余额，不开启超限。

如果页面出现任何非 0 元订单，停止操作并重新核对套餐。

## 4. 初始化数据库

在 HBuilderX 中：

1. 右键 `uniCloud-aliyun/database`。
2. 选择初始化/上传数据库 Schema。
3. 确认创建 6 个集合：`wr_users`、`wr_invites`、`wr_clothing_items`、`wr_wear_logs`、`wr_candidates`、`wr_image_drafts`。
4. 上传同目录的索引文件。
5. 确认 `username_unique`、`invite_code_unique`、`source_hash_unique` 为唯一索引。

所有 Schema 的客户端权限均为 `false`，不要改成公开读写。

## 5. 配置云函数

上传 `wardrobe-api` 前，在 uniCloud 控制台为该云函数配置环境变量：

```text
JWT_SECRET
ADMIN_BOOTSTRAP_TOKEN
COS_SECRET_ID
COS_SECRET_KEY
COS_BUCKET
COS_REGION
COS_CI_ENABLED
VITA_API_KEY
VITA_MODEL
TIIA_GROUP_ID
TIIA_REGION
ALLOWED_ORIGINS
```

约束：

- `JWT_SECRET` 和 `ADMIN_BOOTSTRAP_TOKEN` 使用新生成的长随机值。
- `COS_BUCKET` 为现有私有桶名。
- `COS_REGION=ap-guangzhou`
- `COS_CI_ENABLED=true`
- `TIIA_GROUP_ID=wardrobe_items`
- `TIIA_REGION=ap-guangzhou`
- `VITA_MODEL` 可保持现有模型名。
- 首次联调可暂时省略 `ALLOWED_ORIGINS`；网页托管地址确定后立即填写其完整 Origin。
- 不把这些值写入项目文件，不在日志、截图或聊天中展示。

`package.json` 已配置 512MB 内存、120 秒超时和 URL 化路径 `/wardrobe-api`。

上传后记录完整 HTTPS 地址，形式类似：

```text
https://<云函数默认域名>/wardrobe-api
```

健康检查：

```text
GET <上述地址>/api/health
```

应返回：

```json
{"ok":true,"service":"wardrobe","database":"ready"}
```

## 6. 配置前端和网页托管

将 `public/runtime-config.js` 的 `apiBase` 改为云函数 URL 化地址，结尾不要加 `/`：

```js
window.WARDROBE_CONFIG = Object.freeze({
  apiBase: "https://<云函数默认域名>/wardrobe-api"
});
```

然后把 `public` 目录内容上传至当前免费服务空间的前端网页托管根目录。

网页 HTTPS 地址确定后：

1. 把完整 Origin 写入云函数 `ALLOWED_ORIGINS`，例如 `https://example.bspapp.com`。
2. 重新保存云函数环境变量。
3. 不要填写路径，只填写 `协议 + 域名`。

## 7. 配置 COS 浏览器直传跨域

在现有 COS 桶的“安全管理 → 跨域访问 CORS”新增一条严格规则：

- 来源 Origin：uniCloud 前端网页托管的完整 Origin
- 允许方法：`PUT`
- Allow-Headers：`*`
- Expose-Headers：`ETag`
- Max-Age：`600`

不要把 COS 桶改成公有读或公有写。预签名地址只允许上传到云函数随机生成的单个对象键，5 分钟后失效。

## 8. 迁移真实数据

迁移前只读检查：

```powershell
npm run migrate:unicloud:check
```

必须确认：users=1、invites=1、clothing_items=5、wear_logs=6、candidates=0、excludedImageDrafts=10、orphanWearLogs=0。

正式迁移时，先在当前终端临时设置变量，再运行：

```powershell
$env:UNICLOUD_API_URL="<云函数 URL 化地址>"
$env:ADMIN_BOOTSTRAP_TOKEN="<云函数中相同的管理员令牌>"
npm run migrate:unicloud
npm run verify:unicloud
```

迁移脚本：

- 不生成中间数据文件；
- 保留密码哈希和原 ID；
- 迁移 1 个账号、1 个已用邀请码、5 件衣物、6 条穿着记录；
- 不迁移 10 条失败草稿；
- 云端任一业务集合非空时拒绝迁移；
- 使用数据库事务，失败时回滚；
- 终端只输出数量，不输出密码哈希、邀请码、签名 URL 或图片。

## 9. 验收

1. 原用户名和密码登录。
2. 衣橱显示 5 件衣物，点击衣物能打开详情。
3. 已有穿着次数正确，新增一次穿着后数量加 1。
4. 手机上传图片，看到识别标签。
5. 确认保存后只创建一件衣物。
6. 图像索引失败时衣物仍保存，并显示中文警告。
7. 退出、重新登录正常。
8. 电脑关机后分别使用 Wi-Fi 和蜂窝网络打开 HTTPS 地址。
9. Safari 清理旧 PWA 缓存后不再请求 `192.168.96.240`。

云端验收通过前不修改或删除本地 `data/wardrobe.sqlite`，不删除本机 `WardrobePwaServer` 计划任务，也不运行旧衣物批量索引脚本。验收通过后只停止本机计划任务，暂不删除，保留短期回退。
