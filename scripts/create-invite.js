import "dotenv/config";
import crypto from "node:crypto";

const code = process.argv[2] || crypto.randomBytes(5).toString("hex").toUpperCase();
const origin = String(process.env.APP_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
const response = await fetch(`${origin}/api/admin/invites`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-token": process.env.ADMIN_BOOTSTRAP_TOKEN || "" },
  body: JSON.stringify({ code })
});
const body = await response.json();
if (!response.ok) throw new Error(body.error || "邀请码创建失败");
console.log(`邀请码已创建：${body.code}`);
