# 衣橱关系小程序 P0 客户端切片

本目录是《衣橱关系》的原生微信小程序源码。当前 `config.js` 已配置真实 uniCloud HTTP 地址并使用真实接口；本地代码是否已上线必须以 `/api/health` 返回的 `buildId` 为准。

## 当前可演示的流程

1. 登录、邀请码注册，以及通过私密搭配链接注册受邀好友。
2. 云端衣橱、图片上传、AI 候选标签确认、衣物编辑/软删除和穿着记录。
3. 用户手动选择地区后的高德实时天气、今日穿搭和候选新衣的标签规则分析；不申请定位权限。
4. 私密好友帮搭：分享 1 至 5 件衣物，最多 5 位登录好友、7 天有效、可提前关闭；不开放完整衣橱和公开社区。
5. 用户协议、隐私说明、投诉反馈，以及账号停用和个人数据删除申请。

## 对齐的 uniCloud 接口

| 能力 | 接口 | 当前状态 |
| --- | --- | --- |
| 登录/会话 | `POST /api/auth/login`、`GET /api/auth/me` | 已接入真实云端；停用后旧令牌立即失效。 |
| 衣橱 | `GET /api/items` | 已接入真实云端。 |
| 穿着记录 | `POST /api/items/:id/wear-logs` | 已接入真实云端。 |
| 候选新衣分析 | `POST /api/candidates/:id/analyze`、`POST /api/candidates/:id/decision` | 已接入真实云端；使用标签规则。 |
| 上传/识别 | `/api/uploads/presign`、`/api/recognize`、`/api/tasks/:id/retry` | 已接入真实云端；以线上 health buildId 为准。 |
| 实时天气 | `/api/weather?adcode=` | 云函数读取 `AMAP_WEATHER_KEY` 后调用高德，客户端不保存密钥。 |
| AI 预算 | `GET /api/ai-budget` | 50 元、1000 次全局硬上限，模拟模式可演示。 |
| 确认入库 | `POST /api/items`、`POST /api/items/manual` | AI 候选确认或无 AI 手动入库。 |
| 好友帮搭 | `/api/outfit-requests` | `v8` 已部署并完成开发者工具测试；A/B 真机回归待完成。 |
| 投诉与账号停用 | `POST /api/complaints`、`POST /api/auth/delete-request` | `v9` 已部署；停用操作暂未真机执行。 |

## 当前测试云环境

1. `config.js` 已填写真实 uniCloud 地址，且 `USE_MOCK: false`。
2. 在微信公众平台配置合法请求域名；不要把云端密钥、COS 密钥或 AI Key 写进小程序源码。
3. 微信开发者工具已使用当前小程序 AppID 完成开发者工具回归。
4. COS 私有直传、商品抠图、千问 VL 和预算台账均已真实接通。
5. 每次云函数部署后必须以 `/api/health` 的 `buildId` 验证线上版本。

## 未完成边界

天气仍是本地演示数据；标签相似度不是图片同款识别。支付、交易、租赁、公开社区、人物照片和虚拟试穿均未接入。真实接口返回失败时，页面显示错误和重试，不得把模拟数据当作真实结果。
