function filterWardrobe(items, filters = {}) {
  const keyword = String(filters.keyword || "").trim().toLowerCase();
  const category = filters.category || "全部";
  const season = filters.season || "全部";
  const thickness = filters.thickness || "全部";
  const wearStatus = filters.wearStatus || "全部";
  const idleStatus = filters.idleStatus || "全部";

  const filteredItems = (Array.isArray(items) ? items : []).filter((item) => {
    const searchableText = [
      item.name,
      item.category,
      item.color,
      item.season,
      item.thickness,
      item.pattern,
      item.material,
      ...(item.styles || []),
      ...(item.scenes || [])
    ].filter(Boolean).join(" ").toLowerCase();
    const monthlyWearCount = Number(item.monthlyWearCount || 0);
    return (!keyword || searchableText.includes(keyword))
      && (category === "全部" || item.category === category)
      && (season === "全部" || item.season === season)
      && (thickness === "全部" || item.thickness === thickness)
      && (wearStatus === "全部" || (wearStatus === "本月穿过" ? monthlyWearCount > 0 : monthlyWearCount === 0))
      && (idleStatus === "全部" || (idleStatus === "考虑闲置" ? item.idleStatus === "considering" : item.idleStatus !== "considering"));
  });

  return {
    filteredItems,
    matchedCount: filteredItems.length,
    monthlyWearTotal: filteredItems.reduce((sum, item) => sum + Number(item.monthlyWearCount || 0), 0)
  };
}

module.exports = { filterWardrobe };
