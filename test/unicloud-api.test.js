import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import bcrypt from "bcryptjs";

const require = createRequire(import.meta.url);

const createMemoryDatabase = () => {
  let state = new Map();
  const cloneState = () => new Map([...state].map(([name, documents]) => [
    name,
    new Map([...documents].map(([id, document]) => [id, structuredClone(document)]))
  ]));
  const command = {
    in: (values) => ({ operation: "in", values }),
    inc: (value) => ({ operation: "inc", value })
  };
  const matches = (document, where) => Object.entries(where || {}).every(([field, expected]) => {
    if (expected?.operation === "in") return expected.values.includes(document[field]);
    return document[field] === expected;
  });
  const collectionFor = (store, name, transactionMode = false) => {
    if (!store.has(name)) store.set(name, new Map());
    const documents = store.get(name);
    const query = { where: {}, orderField: null, order: "asc", limit: null };
    const api = {
      where(where) { query.where = where; return api; },
      orderBy(field, order) { query.orderField = field; query.order = order; return api; },
      limit(limit) { query.limit = limit; return api; },
      async get() {
        let values = [...documents.values()].filter((document) => matches(document, query.where)).map((document) => structuredClone(document));
        if (query.orderField) values.sort((a, b) => String(a[query.orderField]).localeCompare(String(b[query.orderField])) * (query.order === "desc" ? -1 : 1));
        if (query.limit) values = values.slice(0, query.limit);
        return { data: values };
      },
      async count() {
        return { total: [...documents.values()].filter((document) => matches(document, query.where)).length };
      },
      async add(document) {
        const id = String(document._id);
        if (documents.has(id)) throw Object.assign(new Error("duplicate _id"), { code: "duplicate" });
        documents.set(id, structuredClone(document));
        return { id };
      },
      doc(id) {
        const documentId = String(id);
        return {
          async get() {
            const document = documents.get(documentId);
            return { data: transactionMode ? (document ? structuredClone(document) : null) : (document ? [structuredClone(document)] : []) };
          },
          async update(changes) {
            const document = documents.get(documentId);
            if (!document) return { updated: 0 };
            for (const [field, value] of Object.entries(changes)) {
              document[field] = value?.operation === "inc" ? Number(document[field] || 0) + value.value : structuredClone(value);
            }
            return { updated: 1 };
          },
          async remove() {
            return { deleted: documents.delete(documentId) ? 1 : 0 };
          }
        };
      }
    };
    return api;
  };
  return {
    command,
    collection: (name) => collectionFor(state, name),
    async startTransaction() {
      const draft = cloneState();
      return {
        collection: (name) => collectionFor(draft, name, true),
        async commit() { state = draft; },
        async rollback() {}
      };
    }
  };
};

const makeEvent = (path, method = "GET", body = null, headers = {}) => ({
  path,
  httpMethod: method,
  headers,
  body: body == null ? "" : JSON.stringify(body),
  isBase64Encoded: false
});
const readResponse = (result) => ({ status: result.statusCode, body: result.body ? JSON.parse(result.body) : null });

test("uniCloud 云函数可迁移、登录、读取衣橱并事务记录穿着", async () => {
  const memoryDatabase = createMemoryDatabase();
  globalThis.uniCloud = {
    database: () => memoryDatabase,
    httpclient: { request: async () => { throw new Error("本测试不应访问外部网络"); } }
  };
  process.env.JWT_SECRET = "test-jwt-secret-at-least-32-characters";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "test-admin-token";
  process.env.COS_SECRET_ID = "test-secret-id";
  process.env.COS_SECRET_KEY = "test-secret-key";
  process.env.COS_BUCKET = "wardrobe-test-1234567890";
  process.env.COS_REGION = "ap-guangzhou";
  process.env.VITA_API_KEY = "test-vita";
  process.env.TIIA_GROUP_ID = "wardrobe_items";
  process.env.TIIA_REGION = "ap-guangzhou";

  const { main } = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js");
  const passwordHash = await bcrypt.hash("password123", 4);
  const tables = {
    users: [{ id: 1, username: "tester", password_hash: passwordHash, recovery_hash: passwordHash, created_at: "2026-01-01T00:00:00.000Z" }],
    invites: [{ id: 1, code: "USED", used_by: 1, used_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" }],
    clothing_items: Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      user_id: 1,
      image_key: `cutouts/item-${index + 1}.png`,
      name: `衣物${index + 1}`,
      category: "上衣",
      color: "灰色",
      styles: '["简约"]',
      scenes: '["休闲"]',
      price: null,
      wear_count: index === 0 ? 6 : 0,
      status: "active",
      created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      source_hash: index === 0 ? "a".repeat(64) : null,
      search_entity_id: index === 0 ? "u1_i1" : null
    })),
    wear_logs: Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      user_id: 1,
      item_id: 1,
      scene: "日常",
      comfort: "舒适",
      note: "",
      worn_at: `2026-02-0${index + 1}T00:00:00.000Z`
    })),
    candidates: []
  };

  const migration = readResponse(await main(makeEvent("/api/admin/migrate", "POST", { tables }, { "x-admin-token": "test-admin-token" })));
  assert.equal(migration.status, 201);
  assert.deepEqual(migration.body.migrated, { users: 1, invites: 1, clothing_items: 5, wear_logs: 6, candidates: 0 });

  const login = readResponse(await main(makeEvent("/api/auth/login", "POST", { username: "tester", password: "password123" })));
  assert.equal(login.status, 200);
  assert.ok(login.body.token);

  const authorization = { authorization: `Bearer ${login.body.token}` };
  const items = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(items.status, 200);
  assert.equal(items.body.length, 5);
  assert.match(items.body[0].imageUrl, /^https:\/\//);

  const wear = readResponse(await main(makeEvent("/api/items/1/wear-logs", "POST", { scene: "日常", comfort: "舒适" }, authorization)));
  assert.equal(wear.status, 201);

  const updatedItems = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(updatedItems.body.find((item) => item.id === "1").wear_count, 7);
});
