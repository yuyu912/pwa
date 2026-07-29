import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const root = path.dirname(fileURLToPath(import.meta.url));
const useMysql = process.env.DB_DRIVER === "mysql" || Boolean(process.env.DB_HOST);
if (process.env.NODE_ENV === "production" && !useMysql) throw new Error("生产环境必须配置 CloudBase MySQL，禁止使用容器本地 SQLite。");
let pool;
let sqliteDb;
let sqliteFile;

const sqliteMany = (database, sql, params = []) => {
  const statement = database.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
};

const persistSqlite = () => fs.writeFileSync(sqliteFile, Buffer.from(sqliteDb.export()));

const sqliteRun = (database, sql, params = [], persist = true) => {
  database.run(sql, params);
  const insertId = sqliteMany(database, "SELECT last_insert_rowid() AS id")[0]?.id || 0;
  if (persist) persistSqlite();
  return { insertId, affectedRows: database.getRowsModified() };
};

const mysqlSchema = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    recovery_hash VARCHAR(255) NOT NULL,
    created_at VARCHAR(30) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS invites (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(40) NOT NULL UNIQUE,
    used_by INT UNSIGNED NULL,
    used_at VARCHAR(30) NULL,
    created_at VARCHAR(30) NOT NULL,
    CONSTRAINT fk_invites_user FOREIGN KEY (used_by) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS clothing_items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    image_key VARCHAR(512) NOT NULL,
    name VARCHAR(80) NOT NULL,
    category VARCHAR(30) NOT NULL,
    color VARCHAR(30) NULL,
    styles TEXT NOT NULL,
    scenes TEXT NOT NULL,
    price DECIMAL(10,2) NULL,
    wear_count INT UNSIGNED NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at VARCHAR(30) NOT NULL,
    source_hash CHAR(64) NULL,
    search_entity_id VARCHAR(100) NULL,
    UNIQUE KEY clothing_items_user_source_hash (user_id, source_hash),
    CONSTRAINT fk_clothing_items_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS wear_logs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    item_id INT UNSIGNED NOT NULL,
    scene VARCHAR(30) NULL,
    comfort VARCHAR(30) NULL,
    note VARCHAR(200) NULL,
    worn_at VARCHAR(30) NOT NULL,
    CONSTRAINT fk_wear_logs_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_wear_logs_item FOREIGN KEY (item_id) REFERENCES clothing_items(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    image_key VARCHAR(512) NOT NULL,
    name VARCHAR(80) NOT NULL,
    category VARCHAR(30) NOT NULL,
    color VARCHAR(30) NULL,
    styles TEXT NOT NULL,
    scenes TEXT NOT NULL,
    price DECIMAL(10,2) NULL,
    decision VARCHAR(20) NULL,
    analysis_json LONGTEXT NULL,
    created_at VARCHAR(30) NOT NULL,
    CONSTRAINT fk_candidates_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS image_drafts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    image_key VARCHAR(512) NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    source_hash CHAR(64) NULL,
    similarity_json LONGTEXT NOT NULL,
    item_id INT UNSIGNED NULL,
    CONSTRAINT fk_image_drafts_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_image_drafts_item FOREIGN KEY (item_id) REFERENCES clothing_items(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

const initializeSqlite = async () => {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs({ locateFile: (file) => path.join(root, "node_modules", "sql.js", "dist", file) });
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  sqliteFile = process.env.SQLITE_DB_FILE ? path.resolve(process.env.SQLITE_DB_FILE) : path.join(dataDir, "wardrobe.sqlite");
  fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
  sqliteDb = fs.existsSync(sqliteFile) ? new SQL.Database(fs.readFileSync(sqliteFile)) : new SQL.Database();
  const definitions = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, used_by INTEGER, used_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS clothing_items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, image_key TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, color TEXT, styles TEXT NOT NULL, scenes TEXT NOT NULL, price REAL, wear_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS wear_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, scene TEXT, comfort TEXT, note TEXT, worn_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, image_key TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, color TEXT, styles TEXT NOT NULL, scenes TEXT NOT NULL, price REAL, decision TEXT, analysis_json TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS image_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, image_key TEXT NOT NULL, created_at TEXT NOT NULL)`
  ];
  definitions.forEach((sql) => sqliteDb.run(sql));
  const columns = {
    clothing_items: ["source_hash TEXT", "search_entity_id TEXT"],
    image_drafts: ["source_hash TEXT", "similarity_json TEXT NOT NULL DEFAULT '[]'", "item_id INTEGER"]
  };
  for (const [table, additions] of Object.entries(columns)) {
    const existing = new Set(sqliteMany(sqliteDb, `PRAGMA table_info(${table})`).map((column) => column.name));
    for (const definition of additions) {
      const name = definition.split(" ")[0];
      if (!existing.has(name)) sqliteDb.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }
  sqliteDb.run("CREATE UNIQUE INDEX IF NOT EXISTS clothing_items_user_source_hash ON clothing_items(user_id, source_hash) WHERE source_hash IS NOT NULL");
  persistSqlite();
};

export const initializeDatabase = async () => {
  if (!useMysql) return initializeSqlite();
  const required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`缺少 MySQL 配置：${missing.join(", ")}`);
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 4),
    charset: "utf8mb4",
    timezone: "Z",
    enableKeepAlive: true
  });
  for (const sql of mysqlSchema) await pool.execute(sql);
};

export const many = async (sql, params = [], executor = pool) => {
  if (!useMysql) return sqliteMany(sqliteDb, sql, params);
  const [rows] = await executor.execute(sql, params);
  return rows;
};

export const one = async (sql, params = [], executor = pool) => (await many(sql, params, executor))[0] || null;

export const run = async (sql, params = [], executor = pool) => {
  if (!useMysql) return sqliteRun(sqliteDb, sql, params);
  const [result] = await executor.execute(sql, params);
  return { insertId: result.insertId || 0, affectedRows: result.affectedRows || 0 };
};

export const transaction = async (work) => {
  if (!useMysql) {
    sqliteDb.run("BEGIN");
    const tx = {
      many: async (sql, params = []) => sqliteMany(sqliteDb, sql, params),
      one: async (sql, params = []) => sqliteMany(sqliteDb, sql, params)[0] || null,
      run: async (sql, params = []) => sqliteRun(sqliteDb, sql, params, false)
    };
    try {
      const result = await work(tx);
      sqliteDb.run("COMMIT");
      persistSqlite();
      return result;
    } catch (error) {
      sqliteDb.run("ROLLBACK");
      throw error;
    }
  }
  const connection = await pool.getConnection();
  await connection.beginTransaction();
  const tx = {
    many: (sql, params = []) => many(sql, params, connection),
    one: (sql, params = []) => one(sql, params, connection),
    run: (sql, params = []) => run(sql, params, connection)
  };
  try {
    const result = await work(tx);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

export const databaseHealth = async () => {
  const row = await one("SELECT 1 AS ok");
  return row?.ok === 1;
};

export const closeDatabase = async () => {
  if (pool) await pool.end();
};

export const databaseDriver = useMysql ? "mysql" : "sqlite";
