const INITIAL_ITEMS = [
  { id: "item-001", name: "奶油白针织开衫", category: "外套", color: "奶油白", styles: ["温柔", "通勤"], scenes: ["通勤", "约会"], price: 299, wearCount: 8, createdAt: "2026-07-18" },
  { id: "item-002", name: "深蓝直筒牛仔裤", category: "裤子", color: "深蓝", styles: ["简约"], scenes: ["休闲", "通勤", "旅行"], price: 229, wearCount: 3, createdAt: "2026-07-11" },
  { id: "item-003", name: "淡紫连衣裙", category: "连衣裙", color: "淡紫", styles: ["甜酷", "约会"], scenes: ["约会", "聚会"], price: 369, wearCount: 1, createdAt: "2026-06-28" }
];

function items() {
  const stored = wx.getStorageSync("wardrobe_mock_items");
  if (stored) return stored;
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

function analysis() {
  const wardrobe = items();
  return {
    conclusion: "建议谨慎",
    similarityStatus: "未计算",
    similar: [],
    compatible: wardrobe.filter((item) => item.category !== "上衣").slice(0, 2),
    reasons: [
      "相似度模型尚未接入测试云环境，因此不展示伪造分数。",
      `可与 ${wardrobe.filter((item) => item.category !== "上衣").length} 件已有衣物形成候选搭配。`,
      "建议确认版型舒适度，以及是否能搭配已有鞋履后再决定。"
    ],
    needsTryOn: ["版型是否舒适", "坐下和走动是否受限", "是否能搭配现有鞋子"]
  };
}

module.exports = {
  login(username) { return { user: { ...user(), username: username || user().username }, token: "demo-token" }; },
  getMe() { return { user: user() }; },
  listItems() { return items(); },
  getItem(id) { return items().find((item) => item.id === id); },
  addWearLog(id) {
    const next = items().map((item) => item.id === id ? { ...item, wearCount: item.wearCount + 1 } : item);
    saveItems(next);
    return { ok: true };
  },
  createCandidate() { return candidate(); },
  analyzeCandidate() { return analysis(); },
  recordDecision() { return { ok: true, addedToWardrobe: false }; }
};
