const apiBase = String(process.env.UNICLOUD_API_URL || "").replace(/\/+$/, "");
const adminToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
if (!apiBase || !adminToken) throw new Error("缺少 UNICLOUD_API_URL 或 ADMIN_BOOTSTRAP_TOKEN。");
if (!apiBase.startsWith("https://") && !apiBase.startsWith("http://127.0.0.1")) throw new Error("UNICLOUD_API_URL 必须使用 HTTPS。");

const response = await fetch(`${apiBase}/api/admin/verify`, {
  headers: { "x-admin-token": adminToken }
});
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(body.error || `云端校验失败（状态 ${response.status}）。`);
const expected = { users: 1, invites: 1, clothing_items: 5, wear_logs: 6, candidates: 0, image_drafts: 0 };
for (const [name, count] of Object.entries(expected)) {
  if (Number(body.counts?.[name]) !== count) throw new Error(`云端 ${name} 为 ${body.counts?.[name]} 条，预期 ${count} 条。`);
}
if (Number(body.orphanWearLogs) !== 0) throw new Error(`云端存在 ${body.orphanWearLogs} 条孤立穿着记录。`);
console.log(JSON.stringify({ verified: true, ...body }));
