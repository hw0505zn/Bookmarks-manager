// 复用共享默认值（js/config.js），不再本地声明 DEFAULTS
const $ = (id) => document.getElementById(id);
let cats = []; // 当前编辑中的分类数组（内存态）

// 解析「每个分类下二级子文件夹上限」：非法/空值回退到默认值（0 是合法值，表示不做二级细分）
function readMaxSubFolders(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS.maxSubFolders;
}

// 解析「分类内书签少于几个时不细分」：非法/空值回退到默认值（0/1 均表示不限制）
function readMinSubFolderSize(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS.minSubFolderSize;
}

// 解析「子文件夹最少几个书签」：小于 1 无意义（子文件夹不可能为空），故下限为 1
function readMinSubFolderItems(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULTS.minSubFolderItems;
}

// 解析「全库取前几个高频书签」：0 是合法值，表示不做全局评选、只靠每分类保底
function readFreqTopN(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS.freqTopN;
}

// 解析「每个分类保底补几个高频书签」：0 是合法值，表示不保底
function readFreqPerCat(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS.freqPerCat;
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
}

function load() {
  chrome.storage.sync.get({ ...DEFAULTS, userCategories: null }, (cfg) => {
    // AI 接口配置（地址/Key/模型）单独存于本地（storage.local），不同步到云端；
    // mergeAiLocalConfig 顺带把旧版残留在 sync 里的副本迁移到 local 并清理。
    mergeAiLocalConfig(cfg).then((cfgM) => {
      cfg = cfgM;
      document.querySelector(`input[name="method"][value="${cfg.method}"]`).checked = true;
      $("aiBaseUrl").value = cfg.aiBaseUrl || "";
      $("aiApiKey").value = cfg.aiApiKey || "";
      $("aiModel").value = cfg.aiModel || "";
      $("targetFolderName").value = cfg.targetFolderName || "智能书签";
      $("targetParentId").value = String(cfg.targetParentId);
      $("autoDedupe").checked = cfg.autoDedupe !== false; // 默认开启
      $("organizeRootItems").checked = cfg.organizeRootItems !== false; // 默认开启
      $("subByDomain").checked = !!cfg.subByDomain;
      $("maxSubFolders").value = readMaxSubFolders(cfg.maxSubFolders);
      $("minSubFolderSize").value = readMinSubFolderSize(cfg.minSubFolderSize);
      $("minSubFolderItems").value = readMinSubFolderItems(cfg.minSubFolderItems);
      $("enableThirdLevel").checked = !!cfg.enableThirdLevel;
      $("useFolderHint").checked = cfg.useFolderHint !== false; // 默认开启
      $("freqEnabled").checked = cfg.freqEnabled !== false; // 默认开启
      $("freqTopN").value = readFreqTopN(cfg.freqTopN);
      $("freqPerCat").value = readFreqPerCat(cfg.freqPerCat);
      toggleMethodCards();
      refreshFreqPermTip(); // 检查「浏览记录」是否已授权（只读检查，不弹框）
      // 分类标签：用户自定义优先，否则默认
      cats = cfg.userCategories && cfg.userCategories.length ? JSON.parse(JSON.stringify(cfg.userCategories)) : cloneDefault();
      // 自动修掉历史脏数据：早期版本按英文逗号切分，用户用顿号/中文逗号输入的关键词会被整串存下来，
      // 那种关键词永远匹配不上任何书签。这里只在内存里拆开，用户点「保存设置」才会落盘。
      for (const c of cats) if (c.keywords && c.keywords.length) c.keywords = normalizeKeywords(c.keywords);
      renderCats();
      refreshUndoSuggestBtn(); // 上次「应用建议」的快照还在的话，把撤销入口露出来
    });
  });
}

function renderCats() {
  const wrap = $("catList");
  wrap.innerHTML = "";
  // 兜底「其他」（system:true）永远排在最后；其余分类保持原有相对顺序。
  // 不能直接 sort（那会把非兜底类的顺序也打乱），而是把非兜底、兜底各归一堆再拼接。
  const normal = [];
  const sys = [];
  cats.forEach((c, i) => (c.system ? sys : normal).push({ c, i }));
  const ordered = [...normal, ...sys];
  ordered.forEach(({ c, i: idx }) => {
    const row = document.createElement("div");
    row.className = "cat-edit";
    row.innerHTML =
      `<div class="cat-line">` +
      `<input type="color" class="c-color" value="${c.color || "#64748b"}" data-i="${idx}" title="颜色" />` +
      `<input type="text" class="c-name" value="${escapeHtml(c.name)}" data-i="${idx}" placeholder="分类名称" />` +
      (c.system
        ? `<span class="c-sys">兜底</span>`
        : `<button class="c-del" data-i="${idx}" type="button">删除</button>`) +
      `</div>` +
      `<textarea class="c-kw" data-i="${idx}" placeholder="关键词，逗号分隔，如：github,代码,开发">${(c.keywords || []).join(", ")}</textarea>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll(".c-name").forEach((el) =>
    el.addEventListener("input", (e) => (cats[+e.target.dataset.i].name = e.target.value))
  );
  wrap.querySelectorAll(".c-color").forEach((el) =>
    el.addEventListener("input", (e) => (cats[+e.target.dataset.i].color = e.target.value))
  );
  wrap.querySelectorAll(".c-kw").forEach((el) =>
    el.addEventListener("input", (e) => {
      // 分隔符解析统一走 config.js 的 splitKeywords（中英文逗号/顿号/分号/换行都算），
      // 否则用户按中文习惯输入「考试、职业、工作」会被整串存成一个关键词，永远匹配不上，且看不出来。
      cats[+e.target.dataset.i].keywords = splitKeywords(e.target.value);
    })
  );
  wrap.querySelectorAll(".c-del").forEach((el) =>
    el.addEventListener("click", (e) => {
      const i = +e.target.dataset.i;
      if (cats[i].system) return;
      const c = cats[i];
      const left = cats.filter((x) => !x.system).length - 1;
      const msg =
        `确定删除分类「${c.name}」？\n\n` +
        `· 该分类下的书签不会被删除，但下次整理时会被重新分配到其它分类里——` +
        `删掉的分类名 AI 再也看不到，它只能把这些书签塞进"听起来最像"的其余分类（或兜底分类「其他」）。\n` +
        `· 如果只是想去掉某些关键词，请清空右侧文本框而不是删掉整个分类。\n` +
        (left <= 0
          ? `\n⚠ 这是最后一个分类，删掉后只剩兜底的「其他」：扫描会被直接拦下（因为所有书签只会被塞进「其他」）。\n`
          : "") +
        `\n删除后仍可点下方「恢复默认分类」找回出厂分类（需再点「保存设置」才生效）。`;
      if (!confirm(msg)) return;
      cats.splice(i, 1);
      renderCats();
    })
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// 按分类方法切换两块卡片（AI 卡片只在 AI 模式下有意义：关键词模式不联网）。
// 「分类标签管理」什么时候该出现 —— 判据只有一条：**这张表此刻是不是归类依据**。
//   · 关键词模式        → 完全按表归类                        → 显示
//   · AI + 未勾选路径   → 表就是 AI 的归类依据（大类只能从表里选）→ 显示
//   · AI + 勾选路径     → 以文件夹结构为主、表只当参考          → 隐藏
// 为什么不做成「AI 模式一律隐藏」（第一版就是这么写的）：在「未勾选」这条路径上，
//   表是唯一依据，而它一旦被删到只剩兜底分类，AI 就无处可抄、只能把书签全塞进「其他」
//   （线上出过的真实症状）。此时把编辑入口一并藏掉，等于用户看着坏结果却无从自救。
function toggleMethodCards() {
  const method = document.querySelector('input[name="method"]:checked').value;
  const hint = $("useFolderHint");
  const folderHint = !!(hint && hint.checked);
  $("aiCard").style.display = method === "ai" ? "block" : "none";
  const catCard = $("catCard");
  if (catCard) catCard.style.display = method === "keyword" || !folderHint ? "block" : "none";
}

// ---- 高频书签的「浏览记录」可选权限 ----
// history 声明在 manifest 的 optional_permissions 里，所以要主动申请。
// 设计上把「功能开关」和「权限授予」拆成两个控件，而不是让勾选开关顺带申请权限：
//   勾选/取消是**意图**（要不要用这个功能），授权是**许可**（能不能读历史）。
//   混在一个复选框上会出现「已勾选但没权限 → 想授权得先取消再勾」的别扭操作。
// ⚠ 申请必须发生在用户手势里，所以只能由按钮点击触发，
//   绝不能在 load() 里自动弹框——那样 Chrome 直接拒绝，用户还不知道自己"被拒绝"了。
async function refreshFreqPermTip() {
  const el = $("freqPermTip");
  const btn = $("freqPermBtn");
  if (!el) return;
  if (!$("freqEnabled").checked) {
    if (btn) btn.hidden = true;
    el.textContent = "已关闭：整理时不识别高频书签，完全按分类标签归类。";
    el.className = "tip";
    return;
  }
  const granted = await hasHistoryPermission();
  if (granted) {
    if (btn) btn.hidden = true;
    el.textContent =
      "已授权「浏览记录」，可自动识别高频书签。访问记录只在本地参与打分，不上传；可在浏览器扩展页随时收回。";
    el.className = "tip ok";
    return;
  }
  if (btn) btn.hidden = false;
  el.textContent =
    "尚未授权「浏览记录」——点上方按钮授权即可自动识别；也可以在插件弹窗里点统计条右侧的「开启」。不授权也能用：直接在弹窗列表里点行首的 ☆ 手动标记（手动标记不需要任何权限）。";
  el.className = "tip warn";
}

$("freqPermBtn").addEventListener("click", async () => {
  const granted = await requestHistoryPermission();
  if (!granted) {
    const el = $("freqPermTip");
    el.textContent =
      "未获得「浏览记录」授权。仍可在插件弹窗里手动点 ☆ 标记高频书签（手动标记不需要任何权限）。";
    el.className = "tip warn";
    return;
  }
  await refreshFreqPermTip(); // 授权成功后按钮自己消失，状态行转绿
});

// 开关只改「要不要用」，不触发授权——避免把意图和许可绑在一起
$("freqEnabled").addEventListener("change", refreshFreqPermTip);

document.querySelectorAll('input[name="method"]').forEach((r) =>
  r.addEventListener("change", toggleMethodCards)
);

// 「参考书签现有的文件夹路径」既是归类依据的开关，也决定「分类标签管理」要不要露脸 → 勾选变化就重排卡片
$("useFolderHint").addEventListener("change", toggleMethodCards);

$("addCat").addEventListener("click", () => {
  cats.push({ id: "cat_" + Date.now(), name: "新分类", color: "#64748b", keywords: [] });
  renderCats();
});

$("resetCat").addEventListener("click", () => {
  cats = cloneDefault();
  renderCats();
});

async function requestHostPermission(baseUrl) {
  if (!baseUrl) return true;
  try {
    const origin = new URL(baseUrl).origin;
    return await chrome.permissions.request({ origins: [origin + "/*"] });
  } catch (e) {
    return false;
  }
}

// ==================== AI 建议大类：按真实书签在一级大类上增 / 减 ====================
// 产品动机（目标用户是浏览器重度用户，书签成百上千、结构混乱）：
//   出厂预置的大类只是冷启动基线，覆盖不了所有人的领域；用户自己加的大类也可能长期只有两三个书签。
//   所以允许 AI **在用户已经手动调整过的那张表上**做增 / 减 —— 但绝不推翻重来，也不自动落地：
//   一切建议都要先摆出依据（各类现有多少书签、兜底里哪些站点最多）→ 用户勾选 → 才生效，且可撤销。
const SUGGEST_UNDO_KEY = "suggestUndo"; // 应用建议前的分类表快照（storage.local，跨会话保留）
// 允许建议删除的上限：一类的书签数超过它就一律驳回。AI 说要删一个有几十条书签的大类，那是它在自作主张。
const SUGGEST_MAX_REMOVE_SIZE = 2;
const SUGGEST_MAX_SAMPLES = 80;

let suggestState = null; // { stats, rejected }

function setSugStatus(msg, cls) {
  const el = $("suggestStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = cls || "";
}

// 读取真实书签（排除插件自己的预览夹，那些是副本，不是用户的书签）
function loadBookmarkItems() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ targetFolderName: DEFAULTS.targetFolderName }, (cfg) => {
      chrome.bookmarks.getTree((tree) => {
        const all = flattenBookmarks(tree, [], [], []);
        const name = cfg.targetFolderName || "智能书签";
        resolve(all.filter((it) => !it.folderPath.includes(name)));
      });
    });
  });
}

// 上一次扫描留下的分类结果（用于"各类现有多少书签"）。没有它就只能做"新增"建议。
function loadClassCache() {
  return new Promise((r) =>
    chrome.storage.local.get("classifyCache", (o) => r((o && o.classifyCache) || null))
  );
}

function loadSuggestUndo() {
  return new Promise((r) =>
    chrome.storage.local.get(SUGGEST_UNDO_KEY, (o) => r((o && o[SUGGEST_UNDO_KEY]) || null))
  );
}

function saveSuggestUndo(snapshot) {
  return new Promise((r) => {
    if (!snapshot) chrome.storage.local.remove(SUGGEST_UNDO_KEY, r);
    else chrome.storage.local.set({ [SUGGEST_UNDO_KEY]: snapshot }, r);
  });
}

async function refreshUndoSuggestBtn() {
  const snap = await loadSuggestUndo();
  $("undoSuggest").hidden = !(snap && Array.isArray(snap.cats) && snap.cats.length);
}

$("suggestCat").addEventListener("click", async () => {
  const btn = $("suggestCat");
  const method = document.querySelector('input[name="method"]:checked').value;
  const url = $("aiBaseUrl").value.trim();
  const key = $("aiApiKey").value.trim();
  // 前置条件先讲清楚，别让用户点了按钮只看到一句"失败"
  if (method !== "ai") {
    setSugStatus("请先把上方「分类方法」切到「AI 智能分类」—— 建议大类需要 AI 读你的书签。", "err");
    return;
  }
  if (!url || !key) {
    setSugStatus("请先在「AI 接口配置」里填好接口地址与 API Key。", "err");
    return;
  }
  btn.disabled = true;
  $("suggestBox").hidden = true;
  suggestState = null;
  try {
    setSugStatus("正在读取书签…");
    await requestHostPermission(url);
    const items = await loadBookmarkItems();
    if (!items.length) throw new Error("没有读到书签（或书签全在预览文件夹里）");

    // 分类缓存里可能还留着用户已经删掉的分类 id —— 那些一律当"未分类"，
    // 否则「其他」的书签数会被算错，AI 会据此提出错误的删除建议。
    const cache = await loadClassCache();
    const catIds = new Set(cats.map((c) => c.id));
    const classMap =
      cache && cache.cats
        ? Object.fromEntries(Object.entries(cache.cats).filter(([, id]) => catIds.has(id)))
        : null;
    const stats = buildCatSuggestStats(items, classMap, cats);
    const sample = sampleItemsForSuggest(items, classMap, cats, SUGGEST_MAX_SAMPLES);

    setSugStatus(
      `正在让 AI 分析 ${items.length} 个书签` +
        (stats.hasCounts ? `（含各类现有书签数）` : `（还没扫描过，本次只会建议"新增"）`) +
        "…"
    );
    const res = await new Promise((resolve) =>
      chrome.runtime.sendMessage(
        {
          type: "AI_SUGGEST_CATS",
          catList: buildCategoryList(cats),
          // 带上每个书签「现有的文件夹路径」：用户自己起的私人领域名（「网文创作」）光看标题网址
          // 是猜不到的，但这恰恰是「该新增哪个大类」最可靠的依据 —— 直接沿用他自己的叫法。
          statsText: buildCatSuggestStatsText(stats, sample, {
            folderHint: $("useFolderHint").checked,
            excludeNames: [$("targetFolderName").value.trim() || DEFAULTS.targetFolderName]
          })
        },
        resolve
      )
    ).catch(() => null);
    if (!res) throw new Error("后台无响应，请先在扩展页重新加载本扩展");
    if (!res.ok) throw new Error(res.error || "AI 返回异常");

    suggestState = { stats };
    renderSuggestions(res.result, stats, items.length);
    setSugStatus("");
  } catch (e) {
    setSugStatus("建议失败：" + ((e && e.message) || e), "err");
  } finally {
    btn.disabled = false;
  }
});

// 渲染建议面板。**所有建议默认勾选，但删除项会额外标红 + 写明"这 N 个书签会被重新分配"**，
// 让用户在点「应用」之前就知道代价。
function renderSuggestions(result, stats, totalItems) {
  const box = $("suggestBox");
  const add = (result && result.add) || [];
  const remove = (result && result.remove) || [];
  box.innerHTML = "";

  if (!add.length && !remove.length) {
    box.innerHTML =
      `<p class="sug-head">AI 认为当前的大类清单已经够用，没有要增删的。</p>` +
      (stats.hasCounts ? "" : `<p class="sug-rejected">提示：本次没有扫描过分类结果，所以只允许"新增"。先回弹窗点一次「扫描并分类」，就能让 AI 判断哪些大类该删。</p>`);
    box.hidden = false;
    return;
  }

  const head = document.createElement("p");
  head.className = "sug-head";
  head.innerHTML =
    `AI 在你当前这张表（共 ${cats.length} 个大类）的基础上，分析了 ${totalItems} 个书签` +
    (stats.hasCounts ? `、各类现有书签数、以及兜底「${escapeHtml(stats.other.name)}」里 ${stats.other.count} 个书签的站点分布` : "") +
    `，给出以下建议。<b>勾选后点「应用选中项」才会生效</b>，应用后可一键撤销。`;
  box.appendChild(head);

  const appendGroup = (title, list, kind) => {
    if (!list.length) return;
    const h = document.createElement("div");
    h.className = "sug-group-title";
    h.textContent = title;
    box.appendChild(h);
    list.forEach((s, i) => {
      const name = String((s && s.name) || "").trim();
      const kw = splitKeywords((s && s.keywords) || []);
      const label = document.createElement("label");
      label.className = "sug-row " + kind;
      label.innerHTML =
        `<input type="checkbox" data-kind="${kind}" data-i="${i}" checked />` +
        `<span class="sug-body">` +
        `<span class="sug-name">${escapeHtml(name || "(未命名)")}</span>` +
        (kw.length ? `<div class="sug-kw">关键词：${escapeHtml(kw.join("、"))}</div>` : "") +
        (s && s.reason ? `<div class="sug-reason">理由：${escapeHtml(String(s.reason))}</div>` : "") +
        (kind === "add"
          ? ""
          : `<div class="sug-warn">删除后，这一类里的书签会被重新分配到其它大类（${
              stats.hasCounts ? "现有 " + (stats.perCat[findCatIdByName(name)] || 0) + " 个" : "书签数未知"
            }）。</div>`) +
        `</span>`;
      // 把原始建议挂到 checkbox 上，应用时直接取用（避免再绕一圈索引）
      label.querySelector("input").dataset.payload = encodeURIComponent(JSON.stringify(s || {}));
      box.appendChild(label);
    });
  };
  appendGroup(`建议新增 ${add.length} 个大类`, add, "add");
  appendGroup(`建议删除 ${remove.length} 个大类`, remove, "del");

  const row = document.createElement("div");
  row.className = "sug-actions";
  row.innerHTML =
    `<button id="sugApply" class="ghost-btn primary-ghost" type="button">应用选中项</button>` +
    `<button id="sugCancel" class="ghost-btn" type="button">取消</button>`;
  box.appendChild(row);
  row.querySelector("#sugApply").addEventListener("click", applySuggestions);
  row.querySelector("#sugCancel").addEventListener("click", () => {
    box.hidden = true;
    setSugStatus("");
  });
  box.hidden = false;
}

function findCatIdByName(name) {
  const c = cats.find((x) => x.name === String(name || "").trim());
  return c ? c.id : "";
}

async function applySuggestions() {
  const box = $("suggestBox");
  const add = [], remove = [];
  box.querySelectorAll("input[type=checkbox][data-kind]").forEach((el) => {
    if (!el.checked) return;
    let payload = {};
    try {
      payload = JSON.parse(decodeURIComponent(el.dataset.payload || "%7B%7D"));
    } catch (e) {
      payload = {};
    }
    (el.dataset.kind === "add" ? add : remove).push(payload);
  });
  if (!add.length && !remove.length) {
    setSugStatus("没有勾选任何建议。", "err");
    return;
  }
  // 快照要在改之前存下来，否则"撤销"无处可回
  await saveSuggestUndo({ cats: JSON.parse(JSON.stringify(cats)), ts: Date.now() });
  const m = mergeCategorySuggestions(
    cats,
    { add, remove },
    { perCat: suggestState ? suggestState.stats.perCat : null, maxRemoveSize: SUGGEST_MAX_REMOVE_SIZE }
  );
  cats = m.cats;
  renderCats();
  await save(); // 用户已经确认过了，直接落盘，不让他再记得点「保存设置」
  await refreshUndoSuggestBtn();

  const parts = [];
  if (m.added.length) parts.push(`新增 ${m.added.length} 个（${m.added.map((a) => a.name).join("、")}）`);
  if (m.removed.length) parts.push(`删除 ${m.removed.length} 个（${m.removed.map((a) => a.name).join("、")}）`);
  box.hidden = true;
  setSugStatus(
    (parts.length ? "已应用并保存：" + parts.join("；") + "。" : "没有任何改动。") +
      (m.rejected.length ? ` 被安全规则挡下 ${m.rejected.length} 条：` + m.rejected.map((r) => `${r.name}（${r.why}）`).join("；") : ""),
    parts.length ? "ok" : "err"
  );
}

$("undoSuggest").addEventListener("click", async () => {
  const snap = await loadSuggestUndo();
  if (!snap || !Array.isArray(snap.cats) || !snap.cats.length) return;
  cats = JSON.parse(JSON.stringify(snap.cats));
  renderCats();
  await saveSuggestUndo(null);
  await save();
  await refreshUndoSuggestBtn();
  setSugStatus("已撤销上次建议，分类表已恢复到建议之前（并已保存）。", "ok");
});

function save() {
  const status = $("status");
  const cfg = {
    method: document.querySelector('input[name="method"]:checked').value,
    aiBaseUrl: $("aiBaseUrl").value.trim(),
    aiApiKey: $("aiApiKey").value.trim(),
    aiModel: $("aiModel").value.trim() || "gpt-4o-mini",
    targetFolderName: $("targetFolderName").value.trim() || "智能书签",
    targetParentId: $("targetParentId").value,
    autoDedupe: $("autoDedupe").checked,
    organizeRootItems: $("organizeRootItems").checked,
    subByDomain: $("subByDomain").checked,
    maxSubFolders: readMaxSubFolders($("maxSubFolders").value),
    minSubFolderSize: readMinSubFolderSize($("minSubFolderSize").value),
    minSubFolderItems: readMinSubFolderItems($("minSubFolderItems").value),
    enableThirdLevel: $("enableThirdLevel").checked,
    useFolderHint: $("useFolderHint").checked,
    freqEnabled: $("freqEnabled").checked,
    freqTopN: readFreqTopN($("freqTopN").value),
    freqPerCat: readFreqPerCat($("freqPerCat").value),
    userCategories: cats
  };

  // 返回 Promise：供「应用建议」「撤销建议」await，确保界面提示在真正落盘之后才显示
  const done = () =>
    new Promise((resolve) => {
      // AI 接口配置（地址/Key/模型）单独写入本地存储，不上云；其余配置写入 sync
      const syncCfg = Object.assign({}, cfg);
      for (const k of AI_CONFIG_KEYS) delete syncCfg[k];
      chrome.storage.sync.set(syncCfg, () => {
        const localAi = {};
        for (const k of AI_CONFIG_KEYS) localAi[k] = cfg[k] || "";
        chrome.storage.local.set(localAi, () => {
          chrome.storage.sync.remove(AI_CONFIG_KEYS); // 清理旧版本可能留在云上的副本
          status.textContent = "已保存 ✓";
          status.className = "";
          setTimeout(() => (status.textContent = ""), 2000);
          resolve();
        });
      });
    });

  if (cfg.method === "ai" && cfg.aiApiKey) {
    return requestHostPermission(cfg.aiBaseUrl).then((granted) => {
      if (!granted) {
        status.textContent = "未授予接口域名权限，AI 分类可能失败";
        status.className = "err";
      }
      return done();
    });
  }
  return done();
}

// 收集当前页面表单里的完整配置（含 Key），用于导出
function collectCurrentCfg() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    method: document.querySelector('input[name="method"]:checked').value,
    aiBaseUrl: $("aiBaseUrl").value.trim(),
    aiApiKey: $("aiApiKey").value.trim(),
    aiModel: $("aiModel").value.trim() || "gpt-4o-mini",
    targetFolderName: $("targetFolderName").value.trim() || "智能书签",
    targetParentId: $("targetParentId").value,
    autoDedupe: $("autoDedupe").checked,
    organizeRootItems: $("organizeRootItems").checked,
    subByDomain: $("subByDomain").checked,
    maxSubFolders: readMaxSubFolders($("maxSubFolders").value),
    minSubFolderSize: readMinSubFolderSize($("minSubFolderSize").value),
    minSubFolderItems: readMinSubFolderItems($("minSubFolderItems").value),
    enableThirdLevel: $("enableThirdLevel").checked,
    useFolderHint: $("useFolderHint").checked,
    freqEnabled: $("freqEnabled").checked,
    freqTopN: readFreqTopN($("freqTopN").value),
    freqPerCat: readFreqPerCat($("freqPerCat").value),
    userCategories: cats
  };
}

// 导出配置为 JSON 文件下载
$("exportCfg").addEventListener("click", () => {
  const cfg = collectCurrentCfg();
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "书签智能整理-配置.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setCfgStatus("已导出，文件默认存到下载目录。", "ok");
});

// 触发文件选择
$("importCfg").addEventListener("click", () => $("importFile").click());

// 导入配置：读文件 → 校验 → 写回表单与 storage
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // 允许重复选同一文件
  if (!file) return;
  try {
    const text = await file.text();
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== "object") throw new Error("文件内容不是有效配置");
    if (!cfg.aiBaseUrl || !cfg.aiModel) throw new Error("缺少 aiBaseUrl 或 aiModel 字段");
    // 回填表单
    document.querySelector(`input[name="method"][value="${cfg.method || "keyword"}"]`).checked = true;
    $("aiBaseUrl").value = cfg.aiBaseUrl || "";
    $("aiApiKey").value = cfg.aiApiKey || "";
    $("aiModel").value = cfg.aiModel || "";
    $("targetFolderName").value = cfg.targetFolderName || "智能书签";
    $("targetParentId").value = String(cfg.targetParentId || "1");
    $("autoDedupe").checked = cfg.autoDedupe !== false; // 默认开启
    $("organizeRootItems").checked = cfg.organizeRootItems !== false; // 默认开启
    $("subByDomain").checked = !!cfg.subByDomain;
    $("maxSubFolders").value = readMaxSubFolders(cfg.maxSubFolders);
    $("minSubFolderSize").value = readMinSubFolderSize(cfg.minSubFolderSize);
    $("minSubFolderItems").value = readMinSubFolderItems(cfg.minSubFolderItems);
    $("enableThirdLevel").checked = !!cfg.enableThirdLevel;
    $("useFolderHint").checked = cfg.useFolderHint !== false;
    $("freqEnabled").checked = cfg.freqEnabled !== false;
    $("freqTopN").value = readFreqTopN(cfg.freqTopN);
    $("freqPerCat").value = readFreqPerCat(cfg.freqPerCat);
    toggleMethodCards();
    refreshFreqPermTip();
    if (cfg.userCategories && cfg.userCategories.length) {
      cats = JSON.parse(JSON.stringify(cfg.userCategories));
      renderCats();
    }
    setCfgStatus("导入成功，请点击「保存设置」落盘。", "ok");
  } catch (err) {
    setCfgStatus("导入失败：" + (err && err.message ? err.message : err), "err");
  }
});

function setCfgStatus(msg, cls) {
  const el = $("cfgStatus");
  el.textContent = msg;
  el.className = cls || "";
}

$("testConn").addEventListener("click", async () => {
  const out = $("testResult");
  const url = $("aiBaseUrl").value.trim();
  const key = $("aiApiKey").value.trim();
  const model = $("aiModel").value.trim() || "gpt-4o-mini";
  if (!url || !key) {
    out.textContent = "请先填写接口地址和 API Key";
    out.className = "err";
    return;
  }
  out.textContent = "测试中…";
  out.className = "";
  await requestHostPermission(url);
  const res = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: "AI_TEST", url, key, model }, resolve)
  ).catch(() => null);
  if (!res) {
    out.textContent = "后台无响应，请先在扩展页重新加载本扩展";
    out.className = "err";
    return;
  }
  if (res.ok) {
    out.textContent = `连接成功（${res.status}）${res.text || ""}`;
    out.className = "ok";
    return;
  }
  // 失败时附带诊断信息与常见状态码提示
  const fp = key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}（共 ${key.length} 字符）` : `长度 ${key.length}（疑似不完整）`;
  const HINTS = {
    400: "请求参数错误（常见：模型名不对或消息体超限）",
    401: "Key 无效/未生效/已过期，或 Key 不属于此域名",
    402: "余额不足或额度用尽",
    403: "服务器拒绝访问。常见成因：① 中转站 WAF 拦截（Origin 为 chrome-extension://）；② IP 地区被限制；③ 未开 host_permissions；④ Key 无该接口权限。请开启「开发者模式」→ 扩展 Service Worker 控制台查看 Network 面板的响应头（server / cf-ray / traceid）",
    404: "接口路径不对，请核对平台文档",
    413: "请求体过大",
    422: "参数不被接受（常见为模型名错误）",
    429: "限流，稍后重试",
    500: "服务端错误", 502: "上游故障", 503: "上游故障", 504: "上游超时"
  };
  const hint = HINTS[res.status] ? `\n提示：${HINTS[res.status]}` : "";
  let diag = "";
  if (res.headers && Object.keys(res.headers).length) {
    diag = "\n响应头诊断：" + Object.entries(res.headers).map(([k, v]) => `${k}=${v}`).join("；");
  }
  out.textContent = `失败 ${res.status || ""}：${res.text}${hint}${diag}\n本次发送的 Key：${fp}`;
  out.className = "err";
});

// API Key 显隐切换
$("toggleKey").addEventListener("click", () => {
  const el = $("aiApiKey");
  const show = el.type === "password";
  el.type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "🙈" : "👁";
});

$("save").addEventListener("click", save);
load();
