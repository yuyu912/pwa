function createBatch(paths) {
  return (Array.isArray(paths) ? paths : []).slice(0, 9).map((sourcePath, index) => ({
    id: `batch-${Date.now()}-${index}`,
    sourcePath,
    imagePath: "",
    mimeType: "image/jpeg",
    fileSize: 0,
    taskId: "",
    draftId: "",
    status: "pending",
    errorText: ""
  }));
}

function updateBatchItem(items, index, changes) {
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item);
}

function nextBatchIndex(items, currentIndex) {
  for (let index = currentIndex + 1; index < items.length; index += 1) {
    if (!['saved', 'skipped'].includes(items[index].status)) return index;
  }
  return -1;
}

function batchSummary(items) {
  return (Array.isArray(items) ? items : []).reduce((summary, item) => {
    if (item.status === "saved") summary.saved += 1;
    if (item.status === "skipped") summary.skipped += 1;
    return summary;
  }, { total: items.length, saved: 0, skipped: 0 });
}

module.exports = { createBatch, updateBatchItem, nextBatchIndex, batchSummary };
