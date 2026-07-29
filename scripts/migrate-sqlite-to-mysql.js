import "dotenv/config";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import initSqlJs from "sql.js";

const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`缺少云端数据库配置：${missing.join(", ")}`);

process.env.DB_DRIVER = "mysql";
const { closeDatabase, initializeDatabase } = await import("../db.js");
await initializeDatabase();

const SQL = await initSqlJs({ locateFile: (file) => fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url)) });
const sourcePath = new URL("../data/wardrobe.sqlite", import.meta.url);
const source = new SQL.Database(fs.readFileSync(sourcePath));
const sourceRows = (sql) => {
  const result = source.exec(sql)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
};

const tables = {
  users: ["id", "username", "password_hash", "recovery_hash", "created_at"],
  invites: ["id", "code", "used_by", "used_at", "created_at"],
  clothing_items: ["id", "user_id", "image_key", "name", "category", "color", "styles", "scenes", "price", "wear_count", "status", "created_at", "source_hash", "search_entity_id"],
  wear_logs: ["id", "user_id", "item_id", "scene", "comfort", "note", "worn_at"],
  candidates: ["id", "user_id", "image_key", "name", "category", "color", "styles", "scenes", "price", "decision", "analysis_json", "created_at"]
};
const expected = { users: 1, invites: 1, clothing_items: 5, wear_logs: 6, candidates: 0 };
const sourceData = Object.fromEntries(Object.entries(tables).map(([table, columns]) => [table, sourceRows(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`)]));
const actual = Object.fromEntries(Object.entries(sourceData).map(([table, rows]) => [table, rows.length]));
for (const [table, count] of Object.entries(expected)) {
  if (actual[table] !== count) throw new Error(`迁移已停止：本地 ${table} 当前为 ${actual[table]} 条，计划基线为 ${count} 条。请先重新确认迁移范围。`);
}

const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  charset: "utf8mb4",
  timezone: "Z"
});

try {
  for (const table of Object.keys(tables)) {
    const [[{ count }]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    if (Number(count) !== 0) throw new Error(`迁移已停止：云端 ${table} 不是空表。`);
  }
  await connection.beginTransaction();
  for (const [table, columns] of Object.entries(tables)) {
    for (const row of sourceData[table]) {
      const placeholders = columns.map(() => "?").join(", ");
      await connection.execute(`INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(", ")}) VALUES (${placeholders})`, columns.map((column) => row[column]));
    }
  }
  const [[orphan]] = await connection.query("SELECT COUNT(*) AS count FROM wear_logs w LEFT JOIN clothing_items c ON c.id = w.item_id WHERE c.id IS NULL");
  if (Number(orphan.count) !== 0) throw new Error("迁移校验失败：存在无对应衣物的穿着记录。");
  await connection.commit();
  console.log(JSON.stringify({ migrated: actual, image_drafts: 0, orphanWearLogs: 0 }));
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  await connection.end();
  await closeDatabase();
}
