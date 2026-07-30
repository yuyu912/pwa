# 衣橱关系小程序 P0 客户端切片

本目录是独立的原生微信小程序源码，默认使用模拟数据，目的是先验证页面流与 uniCloud 接口契约。它不替代现有 PWA，也没有接入真实云账号、图片上传或 AI 服务。

## 当前可演示的流程

1. 演示登录。
2. 云端衣橱列表的加载、关键词/品类筛选、空态与失败重试 UI。
3. 衣物详情和一次穿着记录。
4. 候选新衣的解释性报告、观望/购买决定入口；相似度明确显示“未计算”。

## 对齐的 uniCloud 接口

| 能力 | 接口 | 当前状态 |
| --- | --- | --- |
| 登录/会话 | `POST /api/auth/login`、`GET /api/auth/me` | 已在 `services/api.js` 定义；模拟模式可演示。 |
| 衣橱 | `GET /api/items` | 已定义；模拟模式可演示。 |
| 穿着记录 | `POST /api/items/:id/wear-logs` | 已定义；模拟模式可演示。 |
| 候选新衣分析 | `POST /api/candidates/:id/analyze`、`POST /api/candidates/:id/decision` | 已定义；模拟模式可演示。 |
| 上传/识别 | `/api/uploads/presign`、`/api/recognize` | 今天未接入，因其依赖真实对象存储与 AI 服务。 |

## 未来接入测试云环境

1. 在 `config.js` 填写已部署的 uniCloud HTTP 云函数基础地址，并将 `USE_MOCK` 改为 `false`。
2. 在微信公众平台配置合法请求域名；不要把云端密钥、COS 密钥或 AI Key 写进小程序源码。
3. 用微信开发者工具导入本目录的 `project.config.json`，替换 `touristappid` 为测试 AppID。
4. 先联调登录、`GET /api/items` 和穿着记录，再单独接入图片直传、识别和候选新衣创建。

## 未完成边界

没有真机验收、云函数部署、图片上传、AI 识别/去背景、向量检索、Token 额度、支付、交易、好友协作或试穿。真实接口返回失败时，页面应显示错误和重试，不得把模拟数据当作真实结果。
