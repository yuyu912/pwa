import "dotenv/config";
import initSqlJs from "sql.js";
import fs from "node:fs";
import COS from "cos-nodejs-sdk-v5";
import * as tiiaSdk from "tencentcloud-sdk-nodejs-tiia";

const required = ["COS_BUCKET", "COS_REGION", "COS_SECRET_ID", "COS_SECRET_KEY", "TIIA_GROUP_ID", "TIIA_REGION"];
if (required.some((name) => !process.env[name])) throw new Error("请先在 .env 配好 COS 与图像搜索配置，再运行此脚本。");
const SQL = await initSqlJs();
const databasePath = new URL("../data/wardrobe.sqlite", import.meta.url);
const db = new SQL.Database(fs.readFileSync(databasePath));
const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY });
const client = new tiiaSdk.tiia.v20190529.Client({ credential: { secretId: process.env.COS_SECRET_ID, secretKey: process.env.COS_SECRET_KEY }, region: process.env.TIIA_REGION });
const signedUrl = (key) => cos.getObjectUrl({ Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: key, Sign: true, Expires: 600 });

try { await client.CreateGroup({ GroupId: process.env.TIIA_GROUP_ID, GroupName: "衣橱关系衣物库", MaxCapacity: 1000, GroupType: 8, Brief: "仅用于私有衣橱重复识别" }); }
catch (error) { if (!String(error?.code || "").includes("AlreadyExist")) throw error; }

const rows = db.exec("SELECT id, user_id, image_key FROM clothing_items WHERE search_entity_id IS NULL")[0]?.values || [];
for (const [id, userId, imageKey] of rows) {
  const entityId = `u${userId}_i${id}`;
  await client.CreateImage({ GroupId: process.env.TIIA_GROUP_ID, EntityId: entityId, PicName: `item_${id}`, ImageUrl: signedUrl(imageKey), CustomContent: JSON.stringify({ userId, itemId: id }) });
  db.run("UPDATE clothing_items SET search_entity_id = ? WHERE id = ?", [entityId, id]);
  console.log(`已建立衣物 ${id} 的搜索索引`);
}
fs.writeFileSync(databasePath, Buffer.from(db.export()));
console.log(`完成，共补建 ${rows.length} 条索引。`);
