import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wardrobe-api-"));
const databaseFile = path.join(tempDir, "test.sqlite");
const emptyEnvFile = path.join(tempDir, ".env");
fs.writeFileSync(emptyEnvFile, "");
const port = 33127;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.js"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DOTENV_CONFIG_PATH: emptyEnvFile,
    SQLITE_DB_FILE: databaseFile,
    UPLOAD_DIR: path.join(tempDir, "uploads"),
    PORT: String(port),
    HOST: "127.0.0.1",
    JWT_SECRET: "test-only-jwt-secret-not-for-production",
    ADMIN_BOOTSTRAP_TOKEN: "test-only-admin-token",
    COS_SECRET_ID: "",
    COS_SECRET_KEY: "",
    COS_BUCKET: "",
    COS_REGION: "",
    VITA_API_KEY: "",
    TIIA_GROUP_ID: "",
    TIIA_REGION: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("测试服务未能启动。");
};

test.before(async () => waitForHealth());
test.after(() => {
  child.kill();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("健康检查不需要登录且不暴露配置", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "wardrobe", database: "ready" });
});

test("邀请码注册、Cookie 登录和空衣橱读取正常", async () => {
  const inviteResponse = await fetch(`${baseUrl}/api/admin/invites`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": "test-only-admin-token" },
    body: JSON.stringify({ code: "TEST-INVITE" })
  });
  assert.equal(inviteResponse.status, 201);

  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteCode: "TEST-INVITE", username: "test-user", password: "test-password-123" })
  });
  assert.equal(registerResponse.status, 201);
  const cookie = registerResponse.headers.get("set-cookie");
  assert.match(cookie, /wardrobe_session=/);

  const itemsResponse = await fetch(`${baseUrl}/api/items`, { headers: { cookie } });
  assert.equal(itemsResponse.status, 200);
  assert.deepEqual(await itemsResponse.json(), []);

  const reusedInvite = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteCode: "TEST-INVITE", username: "another-user", password: "test-password-123" })
  });
  assert.equal(reusedInvite.status, 400);
});

test("缺少草稿和图片时不会创建衣物", async () => {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "test-user", password: "test-password-123" })
  });
  const cookie = loginResponse.headers.get("set-cookie");
  const response = await fetch(`${baseUrl}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "无图片衣物", category: "上衣" })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "未找到刚才的识别结果，请重新识别后再保存。");
});

test("直接上传衣物与穿着次数在事务中正确保存", async () => {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "test-user", password: "test-password-123" })
  });
  const cookie = loginResponse.headers.get("set-cookie");
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "test.png");
  form.set("name", "测试上衣");
  form.set("category", "上衣");
  form.set("styles", JSON.stringify(["简约"]));
  form.set("scenes", JSON.stringify(["通勤"]));
  const createResponse = await fetch(`${baseUrl}/api/items`, { method: "POST", headers: { cookie }, body: form });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.name, "测试上衣");

  const wearResponse = await fetch(`${baseUrl}/api/items/${created.id}/wear-logs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ scene: "通勤", comfort: "舒适" })
  });
  assert.equal(wearResponse.status, 201);

  const itemsResponse = await fetch(`${baseUrl}/api/items`, { headers: { cookie } });
  const items = await itemsResponse.json();
  assert.equal(items.length, 1);
  assert.equal(items[0].wear_count, 1);
});
