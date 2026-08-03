const INITIAL_ITEMS = [
  { id: "item-001", name: "奶油白针织开衫", category: "外套", color: "奶油白", season: "春秋", thickness: "适中", styles: ["温柔", "通勤"], scenes: ["通勤", "约会"], price: 299, wearCount: 8, createdAt: "2026-07-18" },
  { id: "item-002", name: "深蓝直筒牛仔裤", category: "裤子", color: "深蓝", season: "多季", thickness: "适中", styles: ["简约"], scenes: ["休闲", "通勤", "旅行"], price: 229, wearCount: 3, createdAt: "2026-07-11" },
  { id: "item-003", name: "淡紫连衣裙", category: "连衣裙", color: "淡紫", season: "春夏", thickness: "薄", styles: ["甜酷", "约会"], scenes: ["约会", "聚会"], price: 369, wearCount: 1, createdAt: "2026-06-28" }
];

function items() {
  const stored = wx.getStorageSync("wardrobe_mock_items");
  if (stored) {
    const migrated = stored.map((item) => ({ ...(INITIAL_ITEMS.find((seed) => seed.id === item.id) || {}), ...item }));
    wx.setStorageSync("wardrobe_mock_items", migrated);
    return migrated;
  }
  wx.setStorageSync("wardrobe_mock_items", INITIAL_ITEMS);
  return INITIAL_ITEMS;
}

function saveItems(next) { wx.setStorageSync("wardrobe_mock_items", next); }

function user() { return { id: "demo-user", username: "演示用户", createdAt: "2026-07-30" }; }

function candidate() {
  return {
    id: "candidate-demo-001",
    name: "雾蓝短款衬衫",
    category: "上衣",
    color: "雾蓝",
    styles: ["简约", "通勤"],
    scenes: ["通勤", "约会"],
    price: 269,
    recognitionStatus: "待确认"
  };
}

function analysis(candidateId) {
  const wardrobe = items();
  const selected = wx.getStorageSync(`wardrobe_mock_candidate_${candidateId}`) || candidate();
  const similar = wardrobe.map((item) => {
    let score = item.category === selected.category ? 55 : 0;
    if (item.color && selected.color && item.color === selected.color) score += 25;
    score += (item.scenes || []).filter((scene) => (selected.scenes || []).includes(scene)).length * 10;
    return { ...item, wear_count: item.wearCount || 0, score };
  }).filter((item) => item.score >= 55).sort((a, b) => b.score - a.score).slice(0, 3);
  const compatible = wardrobe.filter((item) => item.category !== selected.category && (item.scenes || []).some((scene) => (selected.scenes || []).includes(scene))).slice(0, 6);
  const lowFrequencySimilar = similar.filter((item) => Number(item.wearCount || 0) < 3).length;
  return {
    conclusion: lowFrequencySimilar >= 2 ? "重复风险较高" : compatible.length >= 5 ? "值得考虑" : compatible.length >= 2 ? "建议谨慎" : "补缺型",
    similar,
    compatible,
    reasons: [
      `可与 ${compatible.length} 件已有衣物形成候选搭配`,
      lowFrequencySimilar ? `发现 ${lowFrequencySimilar} 件低频相似旧衣` : "未发现多件低频相似旧衣",
      "结论仅依据用户确认的标签与真实穿着记录"
    ],
    needsTryOn: ["版型是否舒适", "坐下和走动是否受限", "是否能搭配现有鞋子"]
  };
}

function usage() {
  return wx.getStorageSync("wardrobe_mock_ai_usage") || { successfulTasks: 0, spentYuan: 0 };
}

function budget() {
  const current = usage();
  return {
    status: current.spentYuan >= 50 || current.successfulTasks >= 1000 ? "blocked" : current.spentYuan >= 45 ? "critical" : current.spentYuan >= 40 ? "warning" : "available",
    successfulTasks: current.successfulTasks,
    taskLimit: 1000,
    remainingTasks: Math.max(0, 1000 - current.successfulTasks),
    spentYuan: current.spentYuan,
    remainingYuan: Number(Math.max(0, 50 - current.spentYuan).toFixed(2)),
    percent: Math.round((current.spentYuan / 50) * 100)
  };
}

function saveMockItem(data, imageUrl) {
  const next = {
    id: `item-${Date.now()}`,
    name: data.name || "待确认衣物",
    category: data.category,
    color: data.color || "",
    season: data.season || "",
    thickness: data.thickness || "",
    pattern: data.pattern || "",
    material: data.material || "",
    styles: data.styles || [],
    scenes: data.scenes || [],
    price: data.price || null,
    imageUrl,
    wearCount: 0,
    createdAt: new Date().toISOString().slice(0, 10)
  };
  saveItems([next, ...items()]);
  return next;
}

module.exports = {
  login(username) { return { user: { ...user(), username: username || user().username }, token: "demo-token" }; },
  getMe() { return { user: user() }; },
  listItems() { return items(); },
  getItem(id) { return items().find((item) => item.id === id); },
  getAiBudget() { return budget(); },
  createUpload(data) {
    const taskId = data.idempotencyKey || `demo-${Date.now()}`;
    wx.setStorageSync(`wardrobe_mock_task_${taskId}`, { mode: data.mode, filePath: "" });
    return { taskId, sourceKey: `demo/${taskId}.jpg`, uploadUrl: "mock://upload", expiresIn: 300 };
  },
  uploadBinary(upload, filePath) {
    const task = wx.getStorageSync(`wardrobe_mock_task_${upload.taskId}`) || {};
    wx.setStorageSync(`wardrobe_mock_task_${upload.taskId}`, { ...task, filePath });
    return { ok: true };
  },
  recognizeItem(taskId) {
    const current = usage();
    const next = { successfulTasks: current.successfulTasks + 1, spentYuan: Number((current.spentYuan + 0.03).toFixed(2)) };
    wx.setStorageSync("wardrobe_mock_ai_usage", next);
    const task = wx.getStorageSync(`wardrobe_mock_task_${taskId}`) || {};
    return {
      taskId,
      draftId: `draft-${taskId}`,
      cutoutUrl: task.filePath,
      isDemo: true,
      tags: {
        name: "演示识别·浅紫上衣",
        category: "上衣",
        color: "浅紫",
        season: "春夏",
        thickness: "薄",
        pattern: "纯色",
        material: "针织感（待确认）",
        styles: ["温柔", "休闲"],
        scenes: ["休闲", "约会"],
        needsConfirmation: ["材质为视觉候选", "请确认季节和厚薄"]
      },
      budget: budget()
    };
  },
  createItem(data) {
    const taskId = String(data.draftId || "").replace(/^draft-/, "");
    const task = wx.getStorageSync(`wardrobe_mock_task_${taskId}`) || {};
    return saveMockItem(data, task.filePath);
  },
  createManualItem(data) {
    const task = wx.getStorageSync(`wardrobe_mock_task_${data.taskId}`) || {};
    return saveMockItem(data, task.filePath);
  },
  updateItem(id, data) {
    // 模拟模式与云端保持相同语义：只更新可编辑字段，不改图片和穿着次数。
    const next = items().map((item) => item.id === id ? { ...item, ...data, id, wearCount: item.wearCount, imageUrl: item.imageUrl } : item);
    saveItems(next);
    return next.find((item) => item.id === id);
  },
  deleteItem(id) {
    // 模拟数据也采用软删除效果：从当前衣橱列表移除，但不清除穿着历史缓存。
    saveItems(items().filter((item) => item.id !== id));
    return { ok: true, itemId: id };
  },
  listIdleItems() {
    return items().filter((item) => item.idle_status === "considering").map((item) => ({
      ...item,
      idleStatus: "considering",
      idleReason: item.idle_reason || "",
      idleNote: item.idle_note || "",
      idleMarkedAt: item.idle_marked_at || "",
      lastWornAt: (wx.getStorageSync(`wardrobe_mock_wear_logs_${item.id}`) || [])[0]?.wornAt || ""
    }));
  },
  markItemIdle(id, data) {
    const next = items().map((item) => item.id === id ? { ...item, idle_status: "considering", idle_reason: data.reason, idle_note: data.note || "", idle_marked_at: new Date().toISOString() } : item);
    saveItems(next);
    return next.find((item) => item.id === id);
  },
  restoreIdleItem(id) {
    const next = items().map((item) => item.id === id ? { ...item, idle_status: "active", idle_reason: "", idle_note: "", idle_marked_at: "" } : item);
    saveItems(next);
    return next.find((item) => item.id === id);
  },
  saveItemListing(id, data) {
    const fields = {
      listing_mode: data.mode, listing_condition: data.condition, listing_sale_price: data.salePrice,
      listing_daily_rent: data.dailyRent, listing_deposit: data.deposit, listing_min_days: data.minDays,
      listing_delivery: data.delivery, listing_note: data.note, listing_platform: data.platform,
      listing_url: data.url, listing_status: data.status, listing_updated_at: new Date().toISOString()
    };
    const next = items().map((item) => item.id === id ? { ...item, ...fields } : item);
    saveItems(next);
    return next.find((item) => item.id === id);
  },
  getWearLogs(id) {
    return wx.getStorageSync(`wardrobe_mock_wear_logs_${id}`) || [];
  },
  getMonthlyWearLogs(start, end) {
    const startTime = Date.parse(start);
    const endTime = Date.parse(end);
    return items().flatMap((item) => (wx.getStorageSync(`wardrobe_mock_wear_logs_${item.id}`) || [])
      .filter((log) => {
        const time = Date.parse(log.wornAt);
        return time >= startTime && time < endTime;
      })
      .map((log) => ({
        ...log,
        item: { id: item.id, name: item.name, category: item.category, color: item.color, active: true, imageUrl: item.imageUrl || "" }
      })));
  },
  addWearLog(id, data) {
    const next = items().map((item) => item.id === id ? { ...item, wearCount: item.wearCount + 1 } : item);
    saveItems(next);
    // 模拟模式也保存完整记录，保证页面流程与真实云端一致。
    const key = `wardrobe_mock_wear_logs_${id}`;
    const logs = wx.getStorageSync(key) || [];
    logs.unshift({
      id: `wear-${Date.now()}`,
      scene: data.scene || "",
      comfort: data.comfort || "",
      note: data.note || "",
      wornAt: new Date().toISOString()
    });
    wx.setStorageSync(key, logs.slice(0, 50));
    return { ok: true };
  },
  createCandidate(data) {
    const id = `candidate-${Date.now()}`;
    const taskId = String(data.draftId || "").replace(/^draft-/, "");
    const task = wx.getStorageSync(`wardrobe_mock_task_${taskId}`) || {};
    const next = { id, ...data, imageUrl: task.filePath, decision: null };
    wx.setStorageSync(`wardrobe_mock_candidate_${id}`, next);
    return next;
  },
  getCandidate(id) { return wx.getStorageSync(`wardrobe_mock_candidate_${id}`) || candidate(); },
  analyzeCandidate(id) { return analysis(id); },
  recordDecision(id, decision) {
    const key = `wardrobe_mock_candidate_${id}`;
    const selected = wx.getStorageSync(key) || candidate();
    wx.setStorageSync(key, { ...selected, decision });
    if (decision === "purchased") saveMockItem(selected, selected.imageUrl);
    return { ok: true, addedToWardrobe: decision === "purchased" };
  }
};
