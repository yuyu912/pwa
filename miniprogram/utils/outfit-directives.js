const cleanIds = (values) => (values || []).map((value) => String(value)).filter(Boolean);

function applyItemDirectives(text, currentItems = [], lockedItemIds = [], excludedItemIds = []) {
  const locked = new Set(cleanIds(lockedItemIds));
  const excluded = new Set(cleanIds(excludedItemIds));
  const replacementCategories = new Set();
  const items = (currentItems || []).filter((item) => item && item.id && item.category);
  const inputText = String(text || "").trim();
  const resetSelection = /(从衣柜.*完整.*一套|完整(?:地)?(?:重新)?(?:找|选|搭|推荐).*一套|整套重新(?:找|选|搭|推荐)|全部(?:重新)?(?:找|选|搭|推荐)|解除(?:保留|锁定)|不保留.*了)/.test(inputText);
  if (resetSelection) {
    return { lockedItemIds: [], excludedItemIds: [], replacementCategories: [], selectionAction: "reset_selection" };
  }
  const replaceAll = /(换一套|再来一套|下一套|换个搭配|整套换掉|全部换掉)/.test(inputText);
  if (replaceAll) {
    return {
      lockedItemIds: [],
      excludedItemIds: items.map((item) => String(item.id)),
      replacementCategories: [],
      selectionAction: "replace_all"
    };
  }

  let selectionAction = "";
  const clauses = inputText.split(/[，,。；;、]/).map((part) => part.trim()).filter(Boolean);

  for (const clause of clauses) {
    const referenced = items.filter((item) => clause.includes(item.category) || (item.name && clause.includes(item.name)));
    if (!referenced.length) continue;
    const keepRequested = /(保留|留下|不要换)/.test(clause);
    const localReplacement = !/不要换/.test(clause) && (/(换|替换)/.test(clause) || /(别的|其他)/.test(clause));

    if (keepRequested) {
      if (!selectionAction) selectionAction = "keep_items";
      referenced.forEach((item) => {
        locked.add(String(item.id));
        excluded.delete(String(item.id));
      });
    }

    if (localReplacement) {
      selectionAction = "replace_category";
      const categories = new Set(referenced.map((item) => item.category));
      categories.forEach((category) => replacementCategories.add(category));
      referenced.forEach((item) => {
        excluded.add(String(item.id));
        locked.delete(String(item.id));
      });
      // “换一条裤子”默认只替换目标品类，其余当前衣物都必须保留。
      items.filter((item) => !categories.has(item.category)).forEach((item) => {
        locked.add(String(item.id));
        excluded.delete(String(item.id));
      });
    } else if (/(换掉|替换|不要|不喜欢)/.test(clause) && !/不要换/.test(clause)) {
      if (!selectionAction) selectionAction = "exclude_items";
      referenced.forEach((item) => {
        excluded.add(String(item.id));
        locked.delete(String(item.id));
      });
    }
  }

  return {
    lockedItemIds: [...locked],
    excludedItemIds: [...excluded],
    replacementCategories: [...replacementCategories],
    selectionAction
  };
}

function settleItemSelection(stable = {}, pending = {}, recommendedItems = [], complete = false) {
  const committed = Boolean(complete && Array.isArray(recommendedItems) && recommendedItems.length);
  return {
    committed,
    currentItems: committed ? recommendedItems : (stable.currentItems || []),
    lockedItemIds: committed ? cleanIds(pending.lockedItemIds) : cleanIds(stable.lockedItemIds),
    excludedItemIds: committed ? cleanIds(pending.excludedItemIds) : cleanIds(stable.excludedItemIds)
  };
}

module.exports = { applyItemDirectives, settleItemSelection };
