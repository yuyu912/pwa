import fs from "node:fs";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const dryRun = process.argv.includes("--dry-run");
const SQL = await initSqlJs({ locateFile: (file) => fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url)) });
const sourcePath = new URL("../data/wardrobe.sqlite", import.meta.url);
const source = new SQL.Database(fs.readFileSync(sourcePath));

const rows = (sql) => {
  const result = source.exec(sql)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
};

const columns = {
  users: ["id", "username", "password_hash", "recovery_hash", "created_at"],
  invites: ["id", "code", "used_by", "used_at", "created_at"],
  clothing_items: ["id", "user_id", "image_key", "name", "category", "color", "styles", "scenes", "price", "wear_count", "status", "created_at", "source_hash", "search_entity_id"],
  wear_logs: ["id", "user_id", "item_id", "scene", "comfort", "note", "worn_at"],
  candidates: ["id", "user_id", "image_key", "name", "category", "color", "styles", "scenes", "price", "decision", "analysis_json", "created_at"]
};
const expected = { users: 1, invites: 1, clothing_items: 5, wear_logs: 6, candidates: 0 };
const tables = Object.fromEntries(Object.entries(columns).map(([name, fields]) => [
  name,
  rows(`SELECT ${fields.join(", ")} FROM ${name} ORDER BY id`)
]));
const actual = Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, data.length]));
const draftCount = rows("SELECT COUNT(*) AS count FROM image_drafts")[0]?.count || 0;
for (const [name, count] of Object.entries(expected)) {
  if (actual[name] !== count) throw new Error(`迁移已停止：本地 ${name} 当前为 ${actual[name]} 条，计划基线为 ${count} 条。`);
}
if (draftCount !== 10) throw new Error(`迁移已停止：本地 image_drafts 当前为 ${draftCount} 条，计划排除基线为 10 条。`);
const itemIds = new Set(tables.clothing_items.map((row) => row.id));
const orphanWearLogs = tables.wear_logs.filter((row) => !itemIds.has(row.item_id)).length;
if (orphanWearLogs) throw new Error(`迁移已停止：本地存在 ${orphanWearLogs} 条孤立穿着记录。`);

const summary = { source: actual, excludedImageDrafts: draftCount, orphanWearLogs };
if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, ...summary }));
} else {
  const apiBase = String(process.env.UNICLOUD_API_URL || "").replace(/\/+$/, "");
  const adminToken = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (!apiBase || !adminToken) throw new Error("缺少 UNICLOUD_API_URL 或 ADMIN_BOOTSTRAP_TOKEN。");
  if (!apiBase.startsWith("https://") && !apiBase.startsWith("http://127.0.0.1")) throw new Error("UNICLOUD_API_URL 必须使用 HTTPS。");

  const response = await fetch(`${apiBase}/api/admin/migrate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify({ tables })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `云端迁移失败（状态 ${response.status}）。`);
  console.log(JSON.stringify({ ...body, excludedImageDrafts: draftCount }));
}
