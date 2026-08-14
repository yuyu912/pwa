const pad = (value) => String(value).padStart(2, "0");

const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

function dateFromKey(key) {
  const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateKey(date) === key ? date : null;
}

function monthRange(year, month) {
  return {
    start: new Date(year, month, 1).toISOString(),
    end: new Date(year, month + 1, 1).toISOString()
  };
}

function normalizeWearLogs(logs) {
  return (Array.isArray(logs) ? logs : []).filter((log) => log.item).map((log) => ({
    ...log,
    dateKey: dateKey(new Date(log.wornAt)),
    timeText: new Date(log.wornAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  }));
}

function groupWearLogs(logs) {
  const groups = new Map();
  logs.forEach((log) => {
    const key = log.outfitRecordId ? `outfit:${log.outfitRecordId}` : `single:${log.id}`;
    if (!groups.has(key)) groups.set(key, {
      id: key,
      outfitRecordId: log.outfitRecordId || "",
      title: log.outfitTitle || log.item?.name || "单件穿着",
      wornAt: log.wornAt,
      dateKey: log.dateKey,
      timeText: log.timeText,
      scene: log.scene || "",
      note: log.note || "",
      items: []
    });
    if (log.item) groups.get(key).items.push({ ...log.item, logId: log.id });
  });
  return [...groups.values()];
}

function previewClass(count) {
  if (count <= 1) return "preview-one";
  if (count === 2) return "preview-two";
  if (count <= 4) return "preview-four";
  return "preview-many";
}

function buildDaySummaries(groups, idPrefix = "day") {
  const summaries = {};
  groups.forEach((group) => {
    if (!summaries[group.dateKey]) summaries[group.dateKey] = { count: 0, previewItems: [], itemIds: new Set() };
    const summary = summaries[group.dateKey];
    summary.count += 1;
    group.items.forEach((item) => {
      const itemId = String(item.id || item.logId || "");
      if (!itemId || summary.itemIds.has(itemId)) return;
      summary.itemIds.add(itemId);
      summary.previewItems.push({
        ...item,
        id: itemId,
        name: item.name || "衣物",
        imageUrl: item.imageUrl || "",
        previewId: `${idPrefix}-${group.dateKey}-${String(item.logId || itemId)}`
      });
    });
  });
  Object.values(summaries).forEach((summary) => {
    summary.previewClass = previewClass(summary.previewItems.length);
    delete summary.itemIds;
  });
  return summaries;
}

function buildHistorySummary(groups, idPrefix = "history") {
  const stats = new Map();
  groups.forEach((group) => {
    const seen = new Set();
    group.items.forEach((item) => {
      const itemId = String(item.id || "");
      if (!itemId || seen.has(itemId)) return;
      seen.add(itemId);
      const current = stats.get(itemId) || { ...item, id: itemId, wearCount: 0, lastWornAt: "" };
      current.wearCount += 1;
      if (!current.lastWornAt || Date.parse(group.wornAt) > Date.parse(current.lastWornAt)) current.lastWornAt = group.wornAt;
      current.previewId = `${idPrefix}-${itemId}`;
      stats.set(itemId, current);
    });
  });
  const items = [...stats.values()].sort((left, right) => (
    right.wearCount - left.wearCount
    || Date.parse(right.lastWornAt) - Date.parse(left.lastWornAt)
    || left.id.localeCompare(right.id)
  ));
  return {
    totalCount: groups.length,
    distinctItemCount: items.length,
    items,
    favorite: items[0] || null
  };
}

function calendarDays(year, month, selectedKey, daySummaries = {}) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday }, (_, index) => ({ key: `blank-${index}`, empty: true, className: "calendar-day empty-day" }));
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = dateKey(new Date(year, month, day));
    const summary = daySummaries[key] || { count: 0, previewItems: [], previewClass: "preview-one" };
    cells.push({
      key,
      day,
      count: summary.count,
      hasOutfit: summary.previewItems.length > 0,
      previewItems: summary.previewItems,
      previewClass: summary.previewClass,
      className: key === selectedKey ? "calendar-day selected" : "calendar-day"
    });
  }
  while (cells.length % 7) cells.push({ key: `blank-end-${cells.length}`, empty: true, className: "calendar-day empty-day trailing-empty" });
  return cells;
}

function defaultSelectedKey(year, month, groups, now = new Date()) {
  if (year === now.getFullYear() && month === now.getMonth()) return dateKey(now);
  return groups[0]?.dateKey || dateKey(new Date(year, month, 1));
}

function selectedDateCopy(key, now = new Date()) {
  const date = dateFromKey(key);
  if (!date) return { title: "选择日期", subtitle: "" };
  const isToday = key === dateKey(now);
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return {
    title: isToday ? "今天" : `${date.getMonth() + 1}月${date.getDate()}日`,
    subtitle: `${weekdays[date.getDay()]} · ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  };
}

function weekRange(key) {
  const selected = dateFromKey(key);
  if (!selected) return null;
  const startDate = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - selected.getDay());
  const endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 6);
  const exclusiveEnd = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7);
  return {
    startDate,
    endDate,
    start: startDate.toISOString(),
    end: exclusiveEnd.toISOString(),
    days: Array.from({ length: 7 }, (_, index) => {
      const date = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + index);
      return { key: dateKey(date), day: date.getDate(), weekday: ["日", "一", "二", "三", "四", "五", "六"][date.getDay()] };
    })
  };
}

function weekTitle(range) {
  if (!range) return { title: "本周", yearText: "" };
  const start = range.startDate;
  const end = range.endDate;
  if (start.getFullYear() !== end.getFullYear()) {
    return {
      title: `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日—${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`,
      yearText: ""
    };
  }
  const startText = `${start.getMonth() + 1}月${start.getDate()}日`;
  const endText = start.getMonth() === end.getMonth() ? `${end.getDate()}日` : `${end.getMonth() + 1}月${end.getDate()}日`;
  return { title: `${startText}—${endText}`, yearText: String(start.getFullYear()) };
}

module.exports = {
  buildDaySummaries,
  buildHistorySummary,
  calendarDays,
  dateFromKey,
  dateKey,
  defaultSelectedKey,
  groupWearLogs,
  monthRange,
  normalizeWearLogs,
  selectedDateCopy,
  weekRange,
  weekTitle
};
