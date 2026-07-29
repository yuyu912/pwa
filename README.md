# 衣橱关系 PWA（真实数据首轮）

这是独立于原型文件的真实数据测试应用。它包含邀请码注册、用户名密码登录、真实衣物上传、COS 私有图片、商品抠图、AI 标签识别、相似衣物判断和规则型新衣分析。

## uniCloud 国内免费部署

- `uniCloud-aliyun/cloudfunctions/wardrobe-api`：兼容现有 `/api/...` 的 HTTP 云函数。
- `uniCloud-aliyun/database`：6 个集合的 Schema 和索引。
- `scripts/migrate-sqlite-to-unicloud.js`：不生成中间明文文件的数据迁移。
- `public/runtime-config.js`：本地 Express 与 uniCloud API 地址切换。
- 完整步骤见 `UNICLOUD_DEPLOYMENT.md`。

## 本地运行

1. 复制 `.env.example` 为 `.env`，填写 `JWT_SECRET` 和 `ADMIN_BOOTSTRAP_TOKEN`。
2. 安装依赖后运行 `npm run dev`。
3. 电脑浏览器打开 `http://localhost:3000`；同一 Wi-Fi 的手机使用服务器输出的局域网地址预览。
4. 使用 `npm run create-invite -- 测试邀请码` 创建首个邀请码。

局域网 HTTP 只用于界面和上传预览。iPhone 的“添加到主屏幕”和离线缓存必须在完成域名备案、DNS、HTTPS 与腾讯云部署后验证。

## CloudBase 生产部署

- 生产容器使用 `Dockerfile`，CloudBase 服务端口设为 `3000`。
- 生产数据库必须设置 `DB_DRIVER=mysql`，不使用容器本地文件保存正式数据。
- 云端环境变量参考 `.env.cloud.example`；真实密钥只填在 CloudBase 控制台，绝不写入代码或上传 `.env`。
- 首次部署和正式数据迁移步骤见 `CLOUDBASE_DEPLOYMENT.md`。
- 旧衣物不直接运行 `npm run reindex-image-search`；早期原图需先完成主体图迁移。
