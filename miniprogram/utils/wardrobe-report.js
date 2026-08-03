function buildWardrobeReport(items, logs) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeLogs = (Array.isArray(logs) ? logs : []).filter((log) => log?.item?.id);
  const countsByItem = {};
  const categories = {};

  safeLogs.forEach((log) => {
    const itemId = String(log.item.id);
    const category = log.item.category || "未分类";
    countsByItem[itemId] = (countsByItem[itemId] || 0) + 1;
    categories[category] = (categories[category] || 0) + 1;
  });

  const frequencies = safeItems.map((item) => ({
    id: String(item.id),
    name: item.name || "未命名衣物",
    category: item.category || "未分类",
    color: item.color || "",
    imageUrl: item.imageUrl || "",
    count: countsByItem[String(item.id)] || 0
  }));
  const wornFrequencies = frequencies.filter((item) => item.count > 0);
  const highestCount = wornFrequencies.length ? Math.max(...wornFrequencies.map((item) => item.count)) : 0;
  const lowestCount = frequencies.length ? Math.min(...frequencies.map((item) => item.count)) : 0;
  const totalCount = safeLogs.length;

  return {
    hasData: totalCount > 0,
    totalCount,
    distinctItemCount: new Set(safeLogs.map((log) => String(log.item.id))).size,
    highFrequency: wornFrequencies.filter((item) => item.count === highestCount).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    lowFrequency: frequencies.filter((item) => item.count === lowestCount).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    categories: Object.entries(categories)
      .map(([name, count]) => ({ name, count, percent: totalCount ? Math.round(count / totalCount * 100) : 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"))
  };
}

module.exports = { buildWardrobeReport };
