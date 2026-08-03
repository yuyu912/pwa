# 衣橱关系 uniCloud 阿里云免费版部署

更新日期：2026-08-03

## 1. 费用边界

- 选择 **uniCloud 阿里云免费服务空间**，不购买 uniCloud 月套餐。
- 腾讯 COS、腾讯数据万象和阿里云百炼采用按实际用量后付费；本项目不购买任何识别次数包或模型包。
- 免费空间默认有效期一个月，到期前 15 天内需要手动免费续期。
- 免费额度耗尽后接受服务暂停，下个月恢复；不以自动扣费换取继续运行。
- uniCloud 免费不等于腾讯云 COS、数据万象或阿里云百炼免费。每件衣物识别会产生商品抠图次数和千问输入/输出 Token 费用；COS 还可能产生少量存储、请求和流量费用。
- 项目代码设置 50 元、1000 次硬上限；仍需在腾讯云和阿里云控制台设置余额提醒。不要购买包月套餐或资源包，但按量后付费必须保持可用，否则无法调用 AI。

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
   ├─ wr_image_drafts.*
   ├─ wr_ai_usage_events.*
   ├─ wr_ai_budget.*
   ├─ wr_outfit_requests.*
   ├─ wr_outfit_responses.*
   └─ wr_complaints.*
```

关键设计：

- 云函数 HTTP 路径固定为 `/wardrobe-api`，业务 API 仍保持 `/api/...`。
- 阿里云 URL 化请求体限制 2MB，因此手机不把图片上传给云函数。
- 登录后先向云函数申请 5 分钟有效的单对象 COS PUT 地址，再由手机直传私有 COS。
- 云函数验证上传对象、计算 SHA-256、执行腾讯商品抠图和通义千问 VL 标签识别。
- 每次 AI 任务先预留 0.05 元；成功后按抠图次数和模型 Token 结算，失败释放未使用部分。用户放弃入库不会退回已发生的 AI 调用费用。
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
3. 确认创建 11 个集合：`wr_users`、`wr_invites`、`wr_clothing_items`、`wr_wear_logs`、`wr_candidates`、`wr_image_drafts`、`wr_ai_usage_events`、`wr_ai_budget`、`wr_outfit_requests`、`wr_outfit_responses`、`wr_complaints`。
4. 上传同目录的索引文件。
5. 确认 `username_unique`、`invite_code_unique`、`source_hash_unique` 为唯一索引。

所有 Schema 的客户端权限均为 `false`，不要改成公开读写。

好友帮搭的两张新表必须先上传 Schema 和索引，再部署 `wardrobe-api`。分享令牌只在创建响应中返回一次，数据库仅保存哈希；不得把原始令牌写入日志。

阿里云索引名称最多 30 个字符。好友帮搭使用 `wr_req_token_uq`、`wr_req_owner_created`、`wr_resp_req_user_uq`、`wr_resp_req_created` 四个短名称；不要改动对应字段顺序和唯一性。

投诉集合使用 `wr_complaint_user_created`、`wr_complaint_status_created` 两个非唯一索引；客户端无权直接读取或写入投诉集合。

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
DASHSCOPE_API_KEY
DASHSCOPE_BASE_URL
QWEN_VL_MODEL
QWEN_INPUT_YUAN_PER_MILLION
QWEN_OUTPUT_YUAN_PER_MILLION
AI_BUDGET_TOTAL_MICROS
AI_BUDGET_TASK_LIMIT
AI_TASK_RESERVATION_MICROS
AI_MATTING_COST_MICROS
ALLOWED_ORIGINS
```

约束：

- `JWT_SECRET` 和 `ADMIN_BOOTSTRAP_TOKEN` 使用新生成的长随机值。
- `COS_BUCKET` 为现有私有桶名。
- `COS_REGION=ap-guangzhou`
- `COS_CI_ENABLED=true`
- `DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`
- `QWEN_VL_MODEL=qwen3-vl-plus`
- 价格变量必须按百炼控制台当前模型价格填写；预算台账记录的是估算成本，最终账单以供应商为准。
- `AI_BUDGET_TOTAL_MICROS=50000000`、`AI_BUDGET_TASK_LIMIT=1000`、`AI_TASK_RESERVATION_MICROS=50000`。
- `AI_MATTING_COST_MICROS` 必须填写腾讯云控制台当天展示的单次商品抠图价格 × 1,000,000；价格变化时先更新配置再开放调用。
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
{"ok":true,"service":"wardrobe","database":"ready","buildId":"2026-08-03-compliance-v9"}
```

## 6. 配置微信小程序

在微信开发者工具中打开 `miniprogram/config.js`，只在完成云函数 HTTPS 地址和微信合法域名配置后修改：

```js
module.exports = {
  USE_MOCK: false,
  API_BASE_URL: "https://<云函数默认域名>/wardrobe-api"
};
```

然后在微信公众平台“小程序后台 → 开发管理 → 开发设置 → 服务器域名”中，将云函数 HTTPS 域名加入 `request` 合法域名；将 COS 上传域名加入 `uploadFile` 或对应网络请求合法域名。开发阶段可在微信开发者工具勾选“不校验合法域名”，但上线前必须恢复校验。

## 7. COS 私有桶与小程序网络域名

1. 在腾讯云创建标准存储私有桶，并把数据万象绑定到该桶；不要开启公有读写。
2. 在微信公众平台将实际 COS 域名加入 `request` 合法域名。本项目使用 `wx.request` 的 PUT 请求直传文件，不使用 `wx.uploadFile`。
3. 不需要为了小程序额外配置浏览器 CORS；若还维护网页 PWA，再按下一节配置 CORS。
4. 为 COS、数据万象和百炼分别设置预算提醒。代码中的 50 元是应用层保护，供应商账单仍以实际调用为准。

预签名地址只允许上传到云函数随机生成的单个对象键，5 分钟后失效。

## 8. 旧网页托管（仅在继续维护 PWA 时）

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

## 9. 配置 COS 浏览器直传跨域（仅 PWA）

在现有 COS 桶的“安全管理 → 跨域访问 CORS”新增一条严格规则：

- 来源 Origin：uniCloud 前端网页托管的完整 Origin
- 允许方法：`PUT`
- Allow-Headers：`*`
- Expose-Headers：`ETag`
- Max-Age：`600`

不要把 COS 桶改成公有读或公有写。预签名地址只允许上传到云函数随机生成的单个对象键，5 分钟后失效。

## 10. 迁移真实数据

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

## 11. 验收

1. 原用户名和密码登录。
2. 衣橱显示 5 件衣物，点击衣物能打开详情。
3. 已有穿着次数正确，新增一次穿着后数量加 1。
4. 手机上传图片，看到去背景主图和千问候选标签。
5. 确认保存后只创建一件衣物。
6. 千问失败后可复用抠图结果重试，不重复产生抠图调用。
7. 达到 40 元显示预警，45 元显示强提醒，50 元或 1000 次时只允许手动录入。
8. 退出、重新登录正常。
9. 电脑关机后分别使用 Wi-Fi 和蜂窝网络打开 HTTPS 地址。
10. Safari 清理旧 PWA 缓存后不再请求 `192.168.96.240`。

云端验收通过前不修改或删除本地 `data/wardrobe.sqlite`，不删除本机 `WardrobePwaServer` 计划任务，也不运行旧衣物批量索引脚本。验收通过后只停止本机计划任务，暂不删除，保留短期回退。
