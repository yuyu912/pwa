import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const apiSource = fs.readFileSync(new URL("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js", import.meta.url), "utf8");
const appConfig = JSON.parse(fs.readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8"));
const privacySource = fs.readFileSync(new URL("../miniprogram/pages/privacy/index.js", import.meta.url), "utf8");

test("灵感广场首版保持人工预审、去重点赞和不自赞边界", () => {
  assert.match(apiSource, /status: "pending"/);
  assert.match(apiSource, /不能给自己的作品点赞/);
  assert.match(apiSource, /communityLikeId/);
  assert.match(apiSource, /status: "approved"/);
});

test("小程序包含广场和发布页面且没有评论私信入口", () => {
  assert.ok(appConfig.pages.includes("pages/community/index"));
  assert.ok(appConfig.pages.includes("pages/community-create/index"));
  assert.ok(appConfig.pages.includes("pages/community-admin/index"));
  const communityMarkup = fs.readFileSync(new URL("../miniprogram/pages/community/index.wxml", import.meta.url), "utf8");
  assert.doesNotMatch(communityMarkup, /评论|私信|关注/);
});

test("社区审核中心使用数据库管理员角色而不是客户端内置密钥", () => {
  const accountMarkup = fs.readFileSync(new URL("../miniprogram/pages/account/index.wxml", import.meta.url), "utf8");
  const adminSource = fs.readFileSync(new URL("../miniprogram/pages/community-admin/index.js", import.meta.url), "utf8");
  assert.match(accountMarkup, /user\.role === 'admin'/);
  assert.match(apiSource, /requireCommunityAdmin/);
  assert.doesNotMatch(adminSource, /ADMIN_BOOTSTRAP_TOKEN|x-admin-token/);
});

test("隐私说明披露公开穿搭所包含与排除的数据", () => {
  assert.match(privacySource, /穿搭灵感广场/);
  assert.match(privacySource, /价格、地区、穿着历史和完整衣橱/);
});
