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
    inc: (value) => ({ operation: "inc", value }),
    set: (value) => ({ operation: "set", value }),
    gte: (value) => ({ operation: "gte", value, and(other) { return { operation: "and", conditions: [this, other] }; } }),
    lt: (value) => ({ operation: "lt", value })
  };
  const matches = (document, where) => Object.entries(where || {}).every(([field, expected]) => {
    if (expected?.operation === "in") return expected.values.includes(document[field]);
    if (expected?.operation === "gte") return document[field] >= expected.value;
    if (expected?.operation === "lt") return document[field] < expected.value;
    if (expected?.operation === "and") return expected.conditions.every((condition) => matches({ value: document[field] }, { value: condition }));
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
              document[field] = value?.operation === "inc"
                ? Number(document[field] || 0) + value.value
                : value?.operation === "set"
                  ? structuredClone(value.value)
                  : structuredClone(value);
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

const makeEvent = (path, method = "GET", body = null, headers = {}) => {
  const url = new URL(path, "https://wardrobe.test");
  return {
  path: url.pathname,
  httpMethod: method,
  headers,
  queryStringParameters: Object.fromEntries(url.searchParams),
  body: body == null ? "" : JSON.stringify(body),
  isBase64Encoded: false
  };
};
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

  const cloudServices = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/lib/cloud-services.js");
  cloudServices.createUpload = (userId, mimeType, taskId) => ({
    taskId,
    sourceKey: `uploads/${userId}/${taskId}.${mimeType === "image/png" ? "png" : "jpg"}`,
    uploadUrl: `https://upload.test/${taskId}`,
    expiresIn: 300
  });
  cloudServices.signedUrl = (key) => `https://images.test/${encodeURIComponent(key)}`;
  cloudServices.sourceHash = async () => "b".repeat(64);
  cloudServices.extractGarment = async () => "cutouts/new-item.png";
  cloudServices.recognizeImage = async () => ({
    valid: true,
    reason: "",
    tags: {
      name: "浅紫针织上衣",
      category: "上衣",
      color: "浅紫",
      season: "春夏",
      thickness: "薄",
      pattern: "纯色",
      material: "针织感",
      styles: ["温柔"],
      scenes: ["休闲"],
      needsConfirmation: ["请确认材质"]
    },
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
    provider: "dashscope",
    model: "qwen3-vl-plus"
  });
  cloudServices.deleteObject = async () => {};

  const { main } = require("../uniCloud-aliyun/cloudfunctions/wardrobe-api/index.js");
  const health = readResponse(await main(makeEvent("/api/health")));
  assert.equal(health.status, 200);
  assert.equal(health.body.buildId, "2026-08-03-p1-calendar-v1");
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
      season: index === 0 ? "春秋" : null,
      thickness: index === 0 ? "适中" : null,
      pattern: index === 0 ? "纯色" : null,
      material: index === 0 ? "棉混纺" : null,
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
  const budget = readResponse(await main(makeEvent("/api/ai-budget", "GET", null, authorization)));
  assert.equal(budget.status, 200);
  assert.equal(budget.body.remainingTasks, 1000);
  assert.equal(budget.body.remainingYuan, 50);

  const items = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(items.status, 200);
  assert.equal(items.body.length, 5);
  assert.match(items.body[0].imageUrl, /^https:\/\//);
  // 列表接口必须把确认后的完整属性交给小程序，展示层不能只收到场景标签。
  const migratedItem = items.body.find((item) => item.id === "1");
  assert.equal(migratedItem.season, "春秋");
  assert.equal(migratedItem.thickness, "适中");
  assert.equal(migratedItem.pattern, "纯色");
  assert.equal(migratedItem.material, "棉混纺");
  assert.deepEqual(migratedItem.styles, ["简约"]);
  assert.deepEqual(migratedItem.scenes, ["休闲"]);

  // 好友帮搭必须是登录后的点对点分享：令牌本身不返回完整衣橱，受邀新用户注册后只加入本次请求。
  const unauthenticatedRequest = readResponse(await main(makeEvent("/api/outfit-requests/not-a-real-token", "GET")));
  assert.equal(unauthenticatedRequest.status, 401);
  const outfitRequest = readResponse(await main(makeEvent("/api/outfit-requests", "POST", {
    itemIds: ["1"], question: "这件上衣适合周末见朋友吗？"
  }, authorization)));
  assert.equal(outfitRequest.status, 201);
  assert.ok(outfitRequest.body.token.length >= 20);
  assert.equal(outfitRequest.body.items[0].name, "衣物1");
  const guestRegistration = readResponse(await main(makeEvent("/api/auth/outfit-guest-register", "POST", {
    token: outfitRequest.body.token, username: "friend-one", password: "password123"
  })));
  assert.equal(guestRegistration.status, 201);
  const friendAuthorization = { authorization: `Bearer ${guestRegistration.body.token}` };
  const sharedView = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.token}`, "GET", null, friendAuthorization)));
  assert.equal(sharedView.status, 200);
  assert.equal(sharedView.body.items.length, 1);
  assert.equal(sharedView.body.items[0].price, undefined);
  const friendReply = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.token}/responses`, "POST", {
    verdict: "like", comment: "颜色很适合周末，搭配浅色鞋子会更轻松。"
  }, friendAuthorization)));
  assert.equal(friendReply.status, 201);
  const ownerResults = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.id}/results`, "GET", null, authorization)));
  assert.equal(ownerResults.status, 200);
  assert.equal(ownerResults.body.summary.like, 1);
  const report = readResponse(await main(makeEvent(`/api/outfit-responses/${ownerResults.body.responses[0].id}/report`, "POST", { reason: "测试举报" }, authorization)));
  assert.equal(report.status, 200);
  const reportedResults = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.id}/results`, "GET", null, authorization)));
  assert.equal(reportedResults.body.responses[0].hidden, true);
  const closedRequest = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.id}/close`, "POST", {}, authorization)));
  assert.equal(closedRequest.status, 200);
  const replyAfterClose = readResponse(await main(makeEvent(`/api/outfit-requests/${outfitRequest.body.token}/responses/me`, "PATCH", {
    verdict: "neutral", comment: "关闭后不能再修改。"
  }, friendAuthorization)));
  assert.equal(replyAfterClose.status, 403);

  const deletionRequest = readResponse(await main(makeEvent("/api/outfit-requests", "POST", {
    itemIds: ["2"], question: "移出衣橱后应关闭分享。"
  }, authorization)));
  assert.equal(deletionRequest.status, 201);
  const deletedSharedItem = readResponse(await main(makeEvent("/api/items/2", "DELETE", {}, authorization)));
  assert.equal(deletedSharedItem.status, 200);
  const closedAfterItemDelete = readResponse(await main(makeEvent(`/api/outfit-requests/${deletionRequest.body.id}/results`, "GET", null, authorization)));
  assert.equal(closedAfterItemDelete.body.request.status, "closed");

  const wear = readResponse(await main(makeEvent("/api/items/1/wear-logs", "POST", { scene: "日常", comfort: "舒适" }, authorization)));
  assert.equal(wear.status, 201);

  const wearHistory = readResponse(await main(makeEvent("/api/items/1/wear-logs", "GET", null, authorization)));
  assert.equal(wearHistory.status, 200);
  assert.equal(wearHistory.body.length, 7);
  assert.equal(wearHistory.body[0].scene, "日常");
  assert.equal(wearHistory.body[0].comfort, "舒适");
  assert.match(wearHistory.body[0].wornAt, /^\d{4}-\d{2}-\d{2}T/);

  const februaryCalendar = readResponse(await main(makeEvent(
    "/api/wear-logs?start=2026-02-01T00%3A00%3A00.000Z&end=2026-03-01T00%3A00%3A00.000Z",
    "GET",
    null,
    authorization
  )));
  assert.equal(februaryCalendar.status, 200);
  assert.equal(februaryCalendar.body.length, 6);
  assert.equal(februaryCalendar.body[0].item.name, "衣物1");
  assert.equal(februaryCalendar.body[0].item.active, true);

  const invalidCalendarRange = readResponse(await main(makeEvent("/api/wear-logs?start=bad&end=also-bad", "GET", null, authorization)));
  assert.equal(invalidCalendarRange.status, 400);

  const updatedItems = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(updatedItems.body.find((item) => item.id === "1").wear_count, 7);

  const upload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "closet",
    idempotencyKey: "test-upload-1"
  }, authorization)));
  assert.equal(upload.status, 201);

  const recognition = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: upload.body.taskId
  }, authorization)));
  assert.equal(recognition.status, 201);
  assert.equal(recognition.body.tags.category, "上衣");
  assert.equal(recognition.body.tags.season, "春夏");
  assert.equal(recognition.body.budget.successfulTasks, 1);

  const replay = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: upload.body.taskId
  }, authorization)));
  assert.equal(replay.status, 201);
  assert.equal(replay.body.draftId, recognition.body.draftId);
  assert.equal(replay.body.budget.successfulTasks, 1);

  // 测试环境只暴露安全阶段、错误码、HTTP 状态和请求号，绝不返回密钥或供应商完整响应。
  cloudServices.sourceHash = async () => {
    throw Object.assign(new Error("fixture access denied"), { code: "AccessDenied", statusCode: 403 });
  };
  const failedUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "closet",
    idempotencyKey: "test-upload-access-denied"
  }, authorization)));
  const failedRecognition = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: failedUpload.body.taskId
  }, authorization)));
  assert.equal(failedRecognition.status, 500);
  assert.equal(failedRecognition.body.aiTaskStage, "read_source");
  assert.equal(failedRecognition.body.providerCode, "AccessDenied");
  assert.equal(failedRecognition.body.providerStatus, 403);
  assert.equal(failedRecognition.body.providerMessage, "fixture access denied");
  assert.equal(failedRecognition.body.buildId, "2026-08-03-p1-calendar-v1");
  assert.match(failedRecognition.body.requestId, /^[a-f0-9]{8}$/);
  cloudServices.sourceHash = async () => "c".repeat(64);
  const retriedRecognition = readResponse(await main(makeEvent(`/api/tasks/${failedUpload.body.taskId}/retry`, "POST", {}, authorization)));
  assert.equal(retriedRecognition.status, 200);
  assert.equal(retriedRecognition.body.tags.category, "上衣");
  assert.equal(retriedRecognition.body.provider, "dashscope");

  const saved = readResponse(await main(makeEvent("/api/items", "POST", {
    draftId: recognition.body.draftId,
    name: "用户确认后的上衣",
    category: "上衣",
    color: "浅紫",
    season: "春夏",
    thickness: "薄",
    pattern: "纯色",
    material: "棉混纺",
    styles: ["温柔"],
    scenes: ["休闲"]
  }, authorization)));
  assert.equal(saved.status, 201);
  assert.equal(saved.body.name, "用户确认后的上衣");
  assert.equal(saved.body.material, "棉混纺");

  const candidateUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "candidate",
    idempotencyKey: "test-candidate-upload-1"
  }, authorization)));
  const candidateRecognition = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: candidateUpload.body.taskId
  }, authorization)));
  assert.equal(candidateRecognition.status, 201);

  const candidateCreated = readResponse(await main(makeEvent("/api/candidates", "POST", {
    draftId: candidateRecognition.body.draftId,
    name: "候选浅紫衬衫",
    category: "上衣",
    color: "浅紫",
    season: "春夏",
    thickness: "薄",
    pattern: "纯色",
    material: "棉混纺",
    styles: ["温柔"],
    scenes: ["休闲"],
    price: 199
  }, authorization)));
  assert.equal(candidateCreated.status, 201);
  assert.equal(candidateCreated.body.material, "棉混纺");
  assert.match(candidateCreated.body.imageUrl, /^https:\/\//);

  const candidateRead = readResponse(await main(makeEvent(`/api/candidates/${candidateCreated.body.id}`, "GET", null, authorization)));
  assert.equal(candidateRead.status, 200);
  assert.equal(candidateRead.body.name, "候选浅紫衬衫");

  const candidateAnalysis = readResponse(await main(makeEvent(`/api/candidates/${candidateCreated.body.id}/analyze`, "POST", {}, authorization)));
  assert.equal(candidateAnalysis.status, 200);
  assert.ok(Array.isArray(candidateAnalysis.body.similar));
  assert.ok(Array.isArray(candidateAnalysis.body.compatible));
  assert.match(candidateAnalysis.body.reasons[3], /用户确认的标签/);

  // 单件达到高标签重复阈值时，必须明确不建议购买，不能因“只有一件”误判为补缺型。
  const duplicateUpload = readResponse(await main(makeEvent("/api/uploads/presign", "POST", {
    mimeType: "image/jpeg",
    size: 500000,
    mode: "candidate",
    idempotencyKey: "test-candidate-upload-duplicate"
  }, authorization)));
  assert.equal(duplicateUpload.status, 201);
  const duplicateRecognition = readResponse(await main(makeEvent("/api/recognize", "POST", {
    taskId: duplicateUpload.body.taskId
  }, authorization)));
  assert.equal(duplicateRecognition.status, 201);
  const duplicateCandidate = readResponse(await main(makeEvent("/api/candidates", "POST", {
    draftId: duplicateRecognition.body.draftId,
    name: "重复候选上衣",
    category: "上衣",
    color: "灰色",
    scenes: ["休闲"]
  }, authorization)));
  assert.equal(duplicateCandidate.status, 201);
  const duplicateAnalysis = readResponse(await main(makeEvent(`/api/candidates/${duplicateCandidate.body.id}/analyze`, "POST", {}, authorization)));
  assert.equal(duplicateAnalysis.status, 200);
  assert.equal(duplicateAnalysis.body.conclusion, "高度重复，不建议购买");
  assert.equal(duplicateAnalysis.body.similar[0].score, 90);
  assert.match(duplicateAnalysis.body.similar[0].matchSummary, /同品类 \+55/);
  assert.match(duplicateAnalysis.body.similar[0].matchSummary, /同颜色 \+25/);
  assert.match(duplicateAnalysis.body.similar[0].matchSummary, /共同场景（休闲）\+10/);

  const candidateDecision = readResponse(await main(makeEvent(`/api/candidates/${candidateCreated.body.id}/decision`, "POST", {
    decision: "purchased"
  }, authorization)));
  assert.equal(candidateDecision.status, 200);
  assert.equal(candidateDecision.body.addedToWardrobe, true);

  const afterPurchase = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  const purchasedItem = afterPurchase.body.find((item) => item.name === "候选浅紫衬衫");
  assert.equal(purchasedItem.material, "棉混纺");
  assert.equal(purchasedItem.season, "春夏");

  // 编辑只能改变用户确认字段，不能覆盖图片、归属或穿着次数。
  const updatedItem = readResponse(await main(makeEvent(`/api/items/${purchasedItem.id}`, "PATCH", {
    name: "修改后的浅紫衬衫",
    category: "上衣",
    color: "浅紫",
    season: "春秋",
    thickness: "适中",
    pattern: "纯色",
    material: "棉混纺",
    styles: ["通勤"],
    scenes: ["通勤", "休闲"],
    price: 188
  }, authorization)));
  assert.equal(updatedItem.status, 200);
  assert.equal(updatedItem.body.name, "修改后的浅紫衬衫");
  assert.equal(updatedItem.body.image_key, purchasedItem.image_key);
  assert.equal(updatedItem.body.wear_count, purchasedItem.wear_count);

  // 删除采用软删除：列表立即排除，数据库记录和穿着历史仍可保留。
  const deletedItem = readResponse(await main(makeEvent(`/api/items/${purchasedItem.id}`, "DELETE", {}, authorization)));
  assert.equal(deletedItem.status, 200);
  const itemsAfterDelete = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(itemsAfterDelete.body.some((item) => item.id === purchasedItem.id), false);
  const deletedStoredResult = await memoryDatabase.collection("wr_clothing_items").doc(purchasedItem.id).get();
  assert.equal(deletedStoredResult.data[0].status, "inactive");

  // 投诉必须登录、限制类型和长度，并由云函数写入只读集合。
  const unauthenticatedComplaint = readResponse(await main(makeEvent("/api/complaints", "POST", {
    category: "功能问题", detail: "无法正常使用好友帮搭。"
  })));
  assert.equal(unauthenticatedComplaint.status, 401);
  const invalidComplaint = readResponse(await main(makeEvent("/api/complaints", "POST", {
    category: "未知类型", detail: "短"
  }, authorization)));
  assert.equal(invalidComplaint.status, 400);
  const complaint = readResponse(await main(makeEvent("/api/complaints", "POST", {
    category: "功能问题", detail: "无法正常使用好友帮搭。", contact: "test@example.com"
  }, authorization)));
  assert.equal(complaint.status, 201);
  assert.equal(complaint.body.status, "submitted");

  // 注销后旧 JWT 也必须立即失效，不能只阻止下一次登录。
  const accountDeletion = readResponse(await main(makeEvent("/api/auth/delete-request", "POST", {}, authorization)));
  assert.equal(accountDeletion.status, 202);
  const accessAfterDeletion = readResponse(await main(makeEvent("/api/items", "GET", null, authorization)));
  assert.equal(accessAfterDeletion.status, 401);
  const loginAfterDeletion = readResponse(await main(makeEvent("/api/auth/login", "POST", {
    username: "tester", password: "password123"
  })));
  assert.equal(loginAfterDeletion.status, 401);
});
