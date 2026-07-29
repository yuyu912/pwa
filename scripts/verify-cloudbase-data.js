import "dotenv/config";
import mysql from "mysql2/promise";

const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`缺少云端数据库配置：${missing.join(", ")}`);

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
  const tables = ["users", "invites", "clothing_items", "wear_logs", "candidates", "image_drafts"];
  const counts = {};
  for (const table of tables) {
    const [[{ count }]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    counts[table] = Number(count);
  }
  const [[orphan]] = await connection.query("SELECT COUNT(*) AS count FROM wear_logs w LEFT JOIN clothing_items c ON c.id = w.item_id WHERE c.id IS NULL");
  console.log(JSON.stringify({ counts, orphanWearLogs: Number(orphan.count) }));
  if (counts.users !== 1 || counts.clothing_items !== 5 || counts.wear_logs !== 6 || counts.image_drafts !== 0 || Number(orphan.count) !== 0) process.exitCode = 1;
} finally {
  await connection.end();
}
