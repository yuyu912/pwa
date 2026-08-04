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
  getEntitlement() {
    let startedAt = wx.getStorageSync("wardrobe_mock_trial_started_at");
    if (!startedAt) {
      startedAt = new Date().toISOString();
      wx.setStorageSync("wardrobe_mock_trial_started_at", startedAt);
    }
    const trialEndsAt = new Date(Date.parse(startedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
    const status = Date.parse(trialEndsAt) > Date.now() ? "trialing" : "expired";
    const limits = status === "trialing" ? { recognition: 20, hangerRemoval: 5 } : { recognition: 3, hangerRemoval: 1 };
    const recognitionUsed = usage().successfulTasks;
    const hangerRemovalUsed = Number(wx.getStorageSync("wardrobe_mock_hanger_removal_used") || 0);
    return {
      status, trialStartedAt: startedAt, trialEndsAt, subscriptionEndsAt: null, serverTime: new Date().toISOString(), purchaseEnabled: false,
      quota: {
        mode: status === "trialing" ? "trial" : "free", enforcement: "observe_only", windowType: status === "trialing" ? "trial" : "rolling_30_days", windowDays: status === "trialing" ? 7 : 30,
        recognition: { limit: limits.recognition, used: recognitionUsed, remaining: Math.max(0, limits.recognition - recognitionUsed), exceeded: recognitionUsed >= limits.recognition },
        hangerRemoval: { limit: limits.hangerRemoval, used: hangerRemovalUsed, remaining: Math.max(0, limits.hangerRemoval - hangerRemovalUsed), exceeded: hangerRemovalUsed >= limits.hangerRemoval },
        action: "当前仅统计和提醒，暂不限制功能"
      }
    };
  },
  getPlans() {
    return { purchaseEnabled: false, plans: [
      { id: "weekly", name: "周付体验", durationDays: 7, featured: true, price: 8.9, quota: { recognitionLimit: 20, hangerRemovalLimit: 5, windowType: "rolling_30_days" }, purchaseEnabled: false },
      { id: "monthly", name: "月付会员", durationDays: 30, featured: false, price: 48.9, quota: { recognitionLimit: 20, hangerRemovalLimit: 5, windowType: "rolling_30_days" }, purchaseEnabled: false },
      { id: "yearly", name: "年付会员", durationDays: 365, featured: false, price: 448.9, quota: { recognitionLimit: 20, hangerRemovalLimit: 5, windowType: "rolling_30_days" }, purchaseEnabled: false }
    ] };
  },
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
  mattingItem(taskId) {
    const task = wx.getStorageSync(`wardrobe_mock_task_${taskId}`) || {};
    return { taskId, status: "matting_completed", stage: task.mode === "manual" ? "awaiting_manual_fields" : "awaiting_recognition", providerName: "腾讯数据万象", modelName: "商品抠图", actionText: "已完成衣物背景去除", cutoutUrl: task.filePath, originalCutoutUrl: task.filePath, hangerEditUrl: task.hangerEditUrl || "", selectedImage: task.selectedImage || "original" };
  },
  removeHanger(taskId) {
    const task = wx.getStorageSync(`wardrobe_mock_task_${taskId}`) || {};
    if (!task.hangerEditUrl) wx.setStorageSync("wardrobe_mock_hanger_removal_used", Number(wx.getStorageSync("wardrobe_mock_hanger_removal_used") || 0) + 1);
    const next = { ...task, hangerEditUrl: task.hangerEditUrl || task.filePath, selectedImage: "hanger_edit" };
    wx.setStorageSync(`wardrobe_mock_task_${taskId}`, next);
    return { taskId, status: "hanger_edit_completed", stage: "awaiting_image_selection", providerName: "阿里云百炼", modelName: "qwen-image-2.0", actionText: "已移除衣架并保留原抠图", cutoutUrl: next.hangerEditUrl, originalCutoutUrl: task.filePath, hangerEditUrl: next.hangerEditUrl, selectedImage: "hanger_edit" };
  },
  selectTaskImage(taskId, choice) {
    const task = wx.getStorageSync(`wardrobe_mock_task_${taskId}`) || {};
    const selectedImage = choice === "hanger_edit" && task.hangerEditUrl ? "hanger_edit" : "original";
    const next = { ...task, selectedImage };
    wx.setStorageSync(`wardrobe_mock_task_${taskId}`, next);
    return { taskId, selectedImage, cutoutUrl: selectedImage === "hanger_edit" ? task.hangerEditUrl : task.filePath, originalCutoutUrl: task.filePath, hangerEditUrl: task.hangerEditUrl || "" };
  },
  recognizeItem(taskId) {
    const current = usage();
    const next = { successfulTasks: current.successfulTasks + 1, spentYuan: Number((current.spentYuan + 0.03).toFixed(2)) };
    wx.setStorageSync("wardrobe_mock_ai_usage", next);
    const task = wx.getStorageSync(`wardrobe_mock_task_${taskId}`) || {};
    return {
      taskId,
      draftId: `draft-${taskId}`,
      cutoutUrl: task.selectedImage === "hanger_edit" && task.hangerEditUrl ? task.hangerEditUrl : task.filePath,
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
    return saveMockItem(data, task.selectedImage === "hanger_edit" && task.hangerEditUrl ? task.hangerEditUrl : task.filePath);
  },
  createManualItem(data) {
    const task = wx.getStorageSync(`wardrobe_mock_task_${data.taskId}`) || {};
    return saveMockItem(data, task.selectedImage === "hanger_edit" && task.hangerEditUrl ? task.hangerEditUrl : task.filePath);
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
  getRewards() {
    const account = wx.getStorageSync("wardrobe_mock_star_account") || {};
    return {
      balance: Number(account.balance || 0), totalEarned: Number(account.totalEarned || 0),
      currentStreak: Number(account.currentStreak || 0), longestStreak: Number(account.longestStreak || 0),
      monthCheckinDays: Number(account.monthCheckinDays || 0), monthEarned: Number(account.monthEarned || 0), monthlyLimit: 35,
      badges: [
        { id: "first", name: "衣橱起步", unlocked: Number(account.totalEarned || 0) >= 1, note: "完成首次真实穿着记录" },
        { id: "seven", name: "七日坚持", unlocked: Number(account.longestStreak || 0) >= 7, note: "连续记录 7 天" },
        { id: "thirty", name: "成长记录者", unlocked: Number(account.totalEarned || 0) >= 30, note: "累计获得 30 颗星" }
      ],
      rewards: [
        { id: "capsule_slot", name: "额外胶囊计划槽位", stars: 8, kind: "feature", exchangeEnabled: false },
        { id: "growth_badge", name: "月度成长徽章", stars: 10, kind: "feature", exchangeEnabled: false },
        { id: "outfit_summary", name: "个人穿搭总结卡", stars: 10, kind: "feature", exchangeEnabled: false },
        { id: "smart_entry", name: "AI 智能录入 1 次", stars: 20, kind: "ai", exchangeEnabled: false },
        { id: "hanger_removal", name: "AI 移除衣架 1 次", stars: 35, kind: "ai", exchangeEnabled: false }
      ],
      exchangeEnabled: false, events: wx.getStorageSync("wardrobe_mock_star_events") || []
    };
  },
  addWearLog(id, data) {
    const wornAt = new Date().toISOString();
    const next = items().map((item) => item.id === id ? { ...item, wearCount: item.wearCount + 1, last_worn_at: wornAt } : item);
    saveItems(next);
    // 模拟模式也保存完整记录，保证页面流程与真实云端一致。
    const key = `wardrobe_mock_wear_logs_${id}`;
    const logs = wx.getStorageSync(key) || [];
    logs.unshift({
      id: `wear-${Date.now()}`,
      scene: data.scene || "",
      comfort: data.comfort || "",
      note: data.note || "",
      wornAt
    });
    wx.setStorageSync(key, logs.slice(0, 50));
    const dayKey = wornAt.slice(0, 10);
    const rewardKey = `wardrobe_mock_star_day_${dayKey}`;
    const account = wx.getStorageSync("wardrobe_mock_star_account") || { balance: 0, totalEarned: 0, currentStreak: 0, longestStreak: 0, monthCheckinDays: 0, monthEarned: 0 };
    if (!wx.getStorageSync(rewardKey)) {
      wx.setStorageSync(rewardKey, true);
      const next = { ...account, balance: account.balance + 1, totalEarned: account.totalEarned + 1, currentStreak: Math.max(1, account.currentStreak), longestStreak: Math.max(1, account.longestStreak), monthCheckinDays: account.monthCheckinDays + 1, monthEarned: account.monthEarned + 1 };
      wx.setStorageSync("wardrobe_mock_star_account", next);
      const events = wx.getStorageSync("wardrobe_mock_star_events") || [];
      events.unshift({ id: `star-${dayKey}`, label: "当天首次记录穿着", points: 1, balanceAfter: next.balance, dayKey, createdAt: wornAt });
      wx.setStorageSync("wardrobe_mock_star_events", events.slice(0, 50));
      return { ok: true, reward: { awardedPoints: 1, balance: next.balance, duplicateDay: false } };
    }
    return { ok: true, reward: { awardedPoints: 0, balance: account.balance, duplicateDay: true } };
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
