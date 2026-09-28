// 分类器：规则（关键词）分类与批量分类入口。

// 对单个书签做关键词分类，返回分类 id。
function classifyByKeyword(bm) {
  const cats = getActiveCategories();
  const text = ((bm.title || "") + " " + (bm.url || "")).toLowerCase();
  let best = getFallbackCategory(cats).id; // 默认“其他”
  let bestScore = 0;
  for (const cat of cats) {
    if (!cat.keywords || cat.keywords.length === 0) continue;
    let score = 0;
    for (const kw of cat.keywords) {
      if (text.includes(kw.toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat.id;
    }
  }
  return best;
}

// 批量分类（规则）。items: [{id, title, url}]。返回 { id: categoryId }
function classifyBatchKeyword(items) {
  const result = {};
  for (const it of items) result[it.id] = classifyByKeyword(it);
  return result;
}
