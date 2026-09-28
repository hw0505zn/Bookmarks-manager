// Popup 交互逻辑
const $ = (id) => document.getElementById(id);
let currentItems = []; // 最近一次扫描的扁平书签
let currentClass = {}; // id -> categoryId
let currentSubs = {}; // id -> 二级标签（仅 AI 模式）
let currentSubs2 = {}; // id -> 三级标签（仅 AI 模式 + 开启三级子文件夹时）
// 高频书签（基于浏览历史，详见 js/frequency.js）
let currentFreq = new Set(); // 最终生效的集合（自动 + 手动叠加）
let currentFreqAuto = new Set(); // 纯自动评选结果，界面用来区分「自动 N 个」
let currentFreqMeta = null; // resolveFrequent 的完整返回，含「没选出数据」的具体原因
let currentFreqScores = new Map(); // 书签 id -> 使用频率得分，用于同一文件夹内直接书签的排序

// 复用共享默认值（js/config.js），不再本地维护一份
const CONFIG_DEFAULTS = DEFAULTS;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function log(msg, cls) {
  const el = $("log");
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---- 进度条 ----
// 单阶段：showProgress(label) / showProgress(label, done, total)
// 多阶段：beginProgress(plan) → useStage(id) → endProgress() / abortProgress()
//
// 为什么需要「多阶段」：一次整理由若干阶段组成（读树 → 分类 → 复制 → 清理 → 排序）。
// 若每个阶段各自从 0% 跑到 100%，用户看到的是进度条反复回退——等于没有进度。
// beginProgress 按权重把 0~100% 切成互不重叠的区间，各阶段只在自己的区间里推进，
// 于是整条进度**单调递增**，而且反映真实工作量（复制 156 个书签 ≠ 清理空文件夹）。
//
// 铁律：凡是显示过进度条的操作，结束都必须在 finally 里收尾——
// 成功走 endProgress()，中断/报错走 abortProgress()。少收一次，
// 条纹动画就会一直转下去（历史 bug：执行完成后进度条还在动）。
let progressHideTimer = null;
let progressPlan = null; // [{ id, label, base, span, unknown }]
let progressStage = null; // 当前所处阶段

// stripes 模式有两种语义，别混：
//   full=true  整条流动 —— 「独立的一次不确定进度」，总量完全未知（无计划时才会用到）
//   full=false 填充停在 pct，由**轨道**自身流动 —— 多阶段里的未知阶段：
//              已完成的部分推进到 pct 处，同时表示「本阶段还在跑、还要多久不知道」。
//              ⚠ 这里绝不能把填充铺满：那会让进度从 100% 掉回真实值，看起来像重头开始
//              （第一版就是这么写的，被 test-progress 的单调性断言当场抓住）。
// 有明确百分比时**一律不显示条纹**：条纹只表示「总量未知」，不能拿它糊弄真实进度。
function paintProgress(label, pct, stripes, full) {
  const box = $("progress");
  if (!box) return;
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  box.classList.add("show");
  box.classList.toggle("indeterminate", !!(stripes && full));
  box.classList.toggle("seg", !!(stripes && !full));
  $("progressFill").style.width = v + "%";
  $("progressLabel").textContent = label || "处理中…";
  // 不确定进度给「…」而不是空白：让人知道在跑，但又不谎报一个数字
  $("progressPct").textContent = stripes ? "…" : Math.round(v) + "%";
  if (stripes) box.removeAttribute("aria-valuenow");
  else box.setAttribute("aria-valuenow", String(Math.round(v)));
}

// 画某个阶段的「起点」：确定阶段画到 base%，未知阶段同样停在 base%，
// 只是额外加条纹表示「本阶段耗时未知」
function paintStageHead(stage, label) {
  const lb = label || stage.label || "处理中…";
  paintProgress(lb, stage.base, !!stage.unknown, false);
}

// 声明多阶段计划。plan = [{ id, label, weight, unknown }]
//   weight  = 预估工作量占比（相对值即可，缺省 1）
//   unknown = 该阶段无法预估总量（如一次 AI 请求），渲染为条纹
function beginProgress(plan) {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  const items = (plan || []).map((p) => ({
    id: p.id,
    label: p.label || "",
    unknown: !!p.unknown,
    weight: Number(p.weight) > 0 ? Number(p.weight) : 1
  }));
  const sum = items.reduce((s, p) => s + p.weight, 0) || 1;
  let acc = 0;
  progressPlan = items.map((p) => {
    const base = (acc / sum) * 100;
    acc += p.weight;
    return { id: p.id, label: p.label, unknown: p.unknown, base, span: (p.weight / sum) * 100 };
  });
  // 收尾对齐：浮点累加会让最后一段落在 99.999…%，界面上就成了「显示 100%、宽度却差一丝」。
  // 直接把末段拉满到 100，保证最后一步能精确落在终点。
  const last = progressPlan[progressPlan.length - 1];
  if (last) last.span = 100 - last.base;
  progressStage = progressPlan[0] || null;
  if (progressStage) paintStageHead(progressStage);
  else paintProgress("", 0, false, false);
}

// 切换到指定阶段：之后的 showProgress(label, done, total) 都按该阶段的区间换算百分比
function useStage(id, label) {
  const s = progressPlan ? progressPlan.find((x) => x.id === id) : null;
  progressStage = s || null;
  if (s) paintStageHead(s, label);
  return s;
}

function showProgress(label, done, total) {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  const known = typeof total === "number" && total > 0;
  const st = progressStage;
  if (known) {
    const frac = Math.max(0, Math.min(1, done / total));
    const pct = st ? st.base + st.span * frac : frac * 100;
    paintProgress(label, pct, false, false);
  } else if (st) {
    paintStageHead(st, label);
  } else {
    paintProgress(label, 100, true, true);
  }
}

function hideProgressNow() {
  const box = $("progress");
  if (!box) return;
  box.classList.remove("show", "indeterminate", "seg");
  box.removeAttribute("aria-valuenow");
  $("progressFill").style.width = "0%";
  $("progressLabel").textContent = "";
  $("progressPct").textContent = "";
}

// 正常收尾：先补到 100% 让人确实看到「完成了」，稍后再收起（否则一闪而过看不见）
function endProgress(delay) {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  paintProgress("完成", 100, false, false);
  progressHideTimer = setTimeout(() => {
    progressPlan = null;
    progressStage = null;
    hideProgressNow();
  }, delay == null ? 500 : delay);
}

// 中断/报错收尾：不补 100%（那等于假装成功），立即收起
function abortProgress() {
  if (progressHideTimer) { clearTimeout(progressHideTimer); progressHideTimer = null; }
  progressPlan = null;
  progressStage = null;
  hideProgressNow();
}

// ---- 动作按钮状态机：一屏只亮一个 ----
// 流程只有三步（1. 扫描分类 → 2. 生成预览 → 3. 执行整理）。如果三个按钮各带饱和实心底色，
//   · 空闲 —— 只有「下一步该点的那一步」实心高亮，其余退成描边幽灵（仍可点，只是不抢镜）；
//   · 运行 —— 只有「正在跑的那一步」保持高亮并呼吸，其余全部压暗并禁用。
// 顺带堵住一个真问题：旧实现只禁用「发起操作的那一个」按钮，扫描跑到一半照样能点「执行整理」。
const STEP_IDS = ["scan", "preview", "organize"];
const STEP_BTN = { scan: "btnScan", preview: "btnPreview", organize: "btnOrganize" };
let busyStep = null; // 正在执行的步骤 id（null = 空闲）。可以是 STEP_IDS 之外的 "undo"
let previewReady = false; // 当前是否已有一份「有内容、可用于执行」的预览
// 本次打开弹窗后是否已经跑过「扫描分类」。
// 为什么必须有：打开弹窗**不自动分类**（作者要求——点开就调 AI 既烧钱又不可控），
// 于是出现一种新状态：统计数字已经读到了、甚至还残留着上一轮的预览快照，但分类结果还没有。
// 这时若按老规则（有预览 → 高亮「执行整理」），一打开弹窗就高亮那个**会删原书签**的按钮，
// 等于引导用户去点一个他自己还没确认过的操作。未分类时高亮一律回到「扫描分类」。
let hasClassified = false;

function setClassified(v) {
  hasClassified = !!v;
}

// 纯函数：空闲时该高亮哪一步。未分类 → 扫描；扫过但没预览 → 生成预览；有预览 → 执行整理。
// classified 缺省 true：只为了让「还没引入该状态之前」的调用保持原行为，真实调用一律传布尔值。
function suggestedStep(itemCount, hasPreview, classified = true) {
  if (!classified) return "scan"; // 还没扫描分类 → 无论有没有旧快照，第一步永远是扫描
  if (!itemCount) return "scan";
  return hasPreview ? "organize" : "preview";
}

// 纯函数：算出四个动作按钮各自的视觉/可用状态。抽出来是为了可单测 ——
// 「运行中漏禁用某个按钮」这类 bug 在界面上极难被发现，但会造成并发操作。
function actionButtonState(busy, suggest) {
  const out = {};
  for (const id of STEP_IDS) {
    const isBusy = busy === id;
    out[id] = {
      busy: isBusy,
      // 运行期只有 isBusy 那个亮；空闲期只有 suggest 那个亮
      step: isBusy || (!busy && suggest === id),
      disabled: !!busy
    };
  }
  return out;
}

function updateActionState() {
  const busy = busyStep;
  const st = actionButtonState(busy, busy ? null : suggestedStep(currentItems.length, previewReady, hasClassified));
  for (const id of STEP_IDS) {
    const btn = $(STEP_BTN[id]);
    if (!btn) continue;
    btn.classList.toggle("is-busy", st[id].busy);
    btn.classList.toggle("is-step", st[id].step);
    btn.disabled = st[id].disabled;
    if (st[id].busy) btn.setAttribute("aria-current", "step");
    else btn.removeAttribute("aria-current");
  }
  // 运行期连「撤销」一起锁（避免整理与撤销并发）。
  // ⚠ 空闲时**不碰** btnUndo：它的可用性由 refreshUndoButton 按撤销栈长度决定，
  //   在这里统一置 false 会把「没有可撤销操作」的禁用状态抹掉。
  if (busy) {
    const u = $("btnUndo");
    if (u) u.disabled = true;
  }
}

// 标记「某一步开始执行」：锁定全部动作按钮，并把它点亮。
function beginStep(id) {
  busyStep = id;
  updateActionState();
}

// 收尾：解冻全部按钮，并按当前书签/预览状态重新点亮「下一步」。
// 每个入口的 finally 都必须调用（与进度条收尾同一处）——漏一次按钮就永久锁死。
async function endStep() {
  busyStep = null;
  await refreshPreviewReady();
  updateActionState();
}

// 预览是否「就绪」= 快照里确实记着有副本的原书签，**且**根目录策略与当前配置一致。
//   · 只看文件夹存不存在不够：执行整理后预览文件夹还在（分类目录被提升了、容器可能变空），
//     而快照已清空，此时该引导用户回到「生成预览」，而不是骗他去点执行。
//   · 根目录开关一改，旧预览的删除范围就对不上了 —— organize 里那条守卫会拒绝执行。
//     这里必须用**同一个判断**把高亮退回「生成预览」：一处拦、一处引导，说的得是同一件事，
//     否则用户会被引导去点一个注定被拒的按钮。
async function refreshPreviewReady(cfg) {
  const src = await loadPreviewSource();
  if (!src || !src.ids || !src.ids.length) {
    previewReady = false;
    return false;
  }
  if (!cfg) cfg = await getConfig();
  // 与 organize 里那条守卫**逐字同源**的判断（含 typeof 检查），否则老快照（没记 organizeRoot）
  // 会被这里误判成「对不上」，把可执行的预览判成不可执行，让用户白重做一次预览。
  const stale = typeof src.organizeRoot === "boolean" && src.organizeRoot !== !!cfg.organizeRootItems;
  if (stale) { previewReady = false; return false; }
  previewReady = true;
  return previewReady;
}

// ---- 动作按钮状态机结束 ----
function allBookmarks(excludeFolderId) {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const out = [];
      flattenBookmarks(tree, [], [], out);
      if (!excludeFolderId) { resolve(out); return; }
      resolve(out.filter((it) => !it.folderIds.includes(excludeFolderId)));
    });
  });
}

function countFolders(excludeFolderId) {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      let n = 0;
      const walk = (nodes) => {
        for (const nd of nodes) {
          if (nd.url) continue;
          if (excludeFolderId && nd.id === excludeFolderId) continue; // 跳过预览文件夹整棵子树
          n++;
          if (nd.children) walk(nd.children);
        }
      };
      walk(tree);
      resolve(n);
    });
  });
}

// 解析预览文件夹（"智能书签"）的真实 id；不存在返回 null
async function resolvePreviewFolderId(cfg) {
  try {
    const parentId = await resolveTargetParentId(cfg.targetParentId);
    if (!parentId) return null;
    const f = await findFolder(parentId, cfg.targetFolderName);
    return f ? f.id : null;
  } catch (e) {
    return null;
  }
}

// 读取「真实书签」列表——**排除预览文件夹内的副本**。
// 预览文件夹里全是插件自己复制出来的副本，把它们算进来会引发三个问题：
//   ① 书签指纹每次都变 → 生成预览后重开弹窗必然重跑 AI（本函数要解决的核心问题）；
//   ② 总书签数 / 重复数虚高；③ 去重会把刚复制出来的副本当成重复项误删。
// 返回 { items, excluded, previewFolderId }
async function loadItems(cfg) {
  const previewFolderId = await resolvePreviewFolderId(cfg);
  const all = await allBookmarks();
  if (!previewFolderId) return { items: all, excluded: 0, previewFolderId: null };
  const items = all.filter((it) => !it.folderIds.includes(previewFolderId));
  return { items, excluded: all.length - items.length, previewFolderId };
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(CONFIG_DEFAULTS, (cfg) => {
      chrome.storage.local.get({ aiApiKey: "" }, (local) => {
        cfg.aiApiKey = local.aiApiKey || cfg.aiApiKey || "";
        applyLocalFallback(cfg); // 本地兜底：storage 被清空时自动回填 config.js 的值
        resolve(cfg);
      });
    });
  });
}

// 在 parentId 下查找名为 title 的文件夹（不存在返回 null）
async function findFolder(parentId, title) {
  const children = await new Promise((r) => {
    chrome.bookmarks.getChildren(parentId, (nodes) => {
      const err = chrome.runtime.lastError;
      r(err || !nodes ? [] : nodes);
    });
  });
  return children.find((c) => !c.url && c.title === title) || null;
}

async function createFolder(parentId, title) {
  return new Promise((r) => {
    chrome.bookmarks.create({ parentId, title }, (node) => {
      const err = chrome.runtime.lastError;
      if (err) { r({ error: err.message }); return; }
      r({ id: node && node.id });
    });
  });
}

// 移动书签，返回 { ok, error? }
function moveBookmark(id, parentId) {
  return new Promise((resolve) => {
    chrome.bookmarks.move(id, { parentId }, (node) => {
      const err = chrome.runtime.lastError;
      if (err) { resolve({ ok: false, error: err.message }); return; }
      resolve({ ok: true, node });
    });
  });
}

// 移动书签到父目录的指定位置，返回 { ok, error? }
function moveBookmarkTo(id, parentId, index) {
  return new Promise((resolve) => {
    chrome.bookmarks.move(id, { parentId, index }, (node) => {
      const err = chrome.runtime.lastError;
      if (err) { resolve({ ok: false, error: err.message }); return; }
      resolve({ ok: true, node });
    });
  });
}

// 算出一个文件夹内部应有的顺序：**子文件夹统一置顶**（按名称升序），
// 其后的直接书签按「使用频率」降序 —— 最常点的排在最容易点到的位置，
// 不必在一堆冷门书签里翻找。（子文件夹不参与频率排序：它是容器，永远在最上。）
//
// 抽成纯函数是为了能脱离 chrome API 单测（排序规则最怕"看着对、边界错"）。
// scoreMap: { 书签id -> 使用频率得分 }，来自 js/frequency.js 的 buildFreqScores（Map 或普通对象都可）。
//   得分全为 0（未授权浏览记录 / 没有历史数据）时**自然退化为按加入时间升序**，
//   与引入频率排序之前的表现完全一致，不会因为没授权就把目录打乱。
function orderChildren(children, timeMap, scoreMap) {
  const byName = (a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh-Hans-CN");
  const timeOf = (c) => (timeMap && timeMap[c.id] != null ? timeMap[c.id] : c.dateAdded || 0);
  // ⚠ 必须同时兼容 Map 和普通对象：打分模块 buildFreqScores 返回的是 Map，
  //   而 scoreMap[id] 这种方括号取值对 Map 永远返回 undefined —— 不会报错，只会**静默不排序**。
  //   这种"不报错的错"最难查，所以在取值处一次性兜住。
  const scoreOf = (c) => {
    if (!scoreMap) return 0;
    const v = typeof scoreMap.get === "function" ? scoreMap.get(c.id) : scoreMap[c.id];
    return v == null ? 0 : v;
  };

  const folders = children.filter((c) => !c.url).sort(byName);
  const marks = children
    .filter((c) => c.url)
    .sort(
      (a, b) =>
        scoreOf(b) - scoreOf(a) || // ① 使用频率高的在前
        timeOf(a) - timeOf(b) ||   // ② 同频率则按加入时间（早的在前）
        byName(a, b)               // ③ 再相同则按标题，保证结果稳定可复现
    );
  return folders.concat(marks);
}

// 规范化一个文件夹内部的顺序（子文件夹置顶 + 直接书签按使用频率降序）。
// timeMap:  { 书签id -> 原加入时间 }，因为复制出来的新书签 dateAdded 全是当前时刻，
//           必须用「原书签」的加入时间做次级排序键，否则同批复制出来的是一堆乱序。
// scoreMap: { 书签id -> 使用频率得分 }，键同样是**新书签** id（复制时逐个映射过来）。
// 返回实际执行的重排次数（顺序已正确则返回 0）。
async function normalizeFolderOrder(parentId, timeMap, scoreMap) {
  const children = await getChildren(parentId);
  if (children.length < 2) return 0;

  const desired = orderChildren(children, timeMap, scoreMap);

  // 顺序已正确则不做任何写操作
  if (children.every((c, i) => desired[i] && desired[i].id === c.id)) return 0;

  // 用本地数组精确模拟 Chrome 的插入/移动语义，只在「不在目标位」时才发 move 请求。
  // 不能用 getChildren 快照里的 index 做跳过判断——前面的 move 会把后续元素挤走，快照 index 会失真。
  const cur = children.slice();
  let moved = 0;
  for (let i = 0; i < desired.length; i++) {
    const wantId = desired[i].id;
    if (cur[i] && cur[i].id === wantId) continue; // 已在正确位置
    const from = cur.findIndex((c) => c.id === wantId);
    if (from < 0) continue;
    const r = await moveBookmarkTo(wantId, parentId, i);
    if (!r.ok) continue; // 移动失败：不同步本地顺序，跳过该位
    const [node] = cur.splice(from, 1);
    cur.splice(i, 0, node);
    moved++;
  }
  return moved;
}

function getBookmark(id) {
  return new Promise((r) => chrome.bookmarks.get(id, (n) => r(n && n[0] ? n[0] : null)));
}

// 复制书签到指定文件夹，返回 { id, error? }
function createBookmark(parentId, title, url) {
  return new Promise((r) => {
    chrome.bookmarks.create({ parentId, title, url }, (node) => {
      const err = chrome.runtime.lastError;
      if (err) { r({ error: err.message }); return; }
      r({ id: node && node.id });
    });
  });
}

// 删除单个书签，返回 { ok, error? }
// 注意：必须把失败原因带出来——`chrome.bookmarks.remove` 失败的常见原因有
//   ① Can't find bookmark for id（书签已不存在/已被删）
//   ② Can't modify managed bookmarks（企业策略下发的受管书签，扩展无权改动）
// 只返回布尔值会让这两种完全不同的故障看起来一模一样，无法定位。
function removeBookmark(id) {
  return new Promise((resolve) => {
    chrome.bookmarks.remove(id, () => {
      const err = chrome.runtime.lastError;
      if (err) { resolve({ ok: false, error: err.message || String(err) }); return; }
      resolve({ ok: true });
    });
  });
}

// 删除整棵子树，返回是否成功
function removeTree(id) {
  return new Promise((resolve) => {
    chrome.bookmarks.removeTree(id, () => {
      const err = chrome.runtime.lastError;
      resolve(!err);
    });
  });
}

function getChildren(id) {
  return new Promise((resolve) => {
    chrome.bookmarks.getChildren(id, (nodes) => {
      const err = chrome.runtime.lastError;
      resolve(err || !nodes ? [] : nodes);
    });
  });
}

// 读取某文件夹子树内所有书签的归一化 URL 集合（用于复制前去重，避免重复生成）
async function collectExistingUrls(folderId) {
  const set = new Set();
  const subtree = await new Promise((resolve) => {
    chrome.bookmarks.getSubTree(folderId, (nodes) => {
      const err = chrome.runtime.lastError;
      resolve(err || !nodes ? [] : nodes);
    });
  });
  const flat = [];
  if (subtree.length) flattenBookmarks(subtree, [], [], flat);
  for (const it of flat) {
    if (it.url) set.add(normalizeUrl(it.url));
  }
  return set;
}

// 简短列出若干条目标题，供日志使用；超过 max 个则省略计数
function briefList(items, max = 5) {
  const names = items.slice(0, max).map((it) => it.title || it.url || it.id);
  return names.join("、") + (items.length > max ? ` 等${items.length}个` : "");
}

// 判定「哪些原书签可以安全删除」——纯函数，便于回归测试。
// 背景：预览生成 → 用户点执行，中间用户可以任意增删 / 移动 / 钉根目录书签，
// 而清单（previewSourceIds）只记 id，不记「它现在在哪」「预览里那份副本还在不在」，
// 所以执行前必须按**当前现状**再核对一轮，否则会错删：
//   ① 现已被钉在根目录 → 不删（用户明确要它留在一键可达的位置）
//   ② 预览里找不到同 URL 的副本 → 不删（删了就真没了，没有副本可留存）
// 两条都是「安全侧失败」：宁可少删，绝不错删。
//   candidates   —— 命中清单、且当前仍存在于书签树中的原书签
//   rootParentId —— 目标根目录 id（书签栏 / 其他书签 / 移动设备书签）
//   previewUrlSet —— 预览子树内现存的归一化 URL 集合
//   protectRoot  —— 是否保护「现钉在根目录」的书签。
//     默认 true（设置里未开启「根目录书签也参与整理」）。
//     用户一旦开启该选项，根目录书签就是**本轮整理的目标本身**，
//     此时若仍按 ① 剔除，等于勾了选项却一个都不删——整理静默失效。
//     所以这条保护必须跟着配置走，不能写死。
function selectDeletable(candidates, rootParentId, previewUrlSet, normalize, protectRoot = true) {
  const isPinned = (it) => !!(protectRoot && rootParentId && it.parentId === rootParentId);
  const hasCopy = (it) => previewUrlSet.has(normalize(it.url || ""));
  const pinnedItems = candidates.filter(isPinned);
  const lostItems = candidates.filter((it) => !isPinned(it) && !hasCopy(it));
  const toDelete = candidates.filter((it) => !isPinned(it) && hasCopy(it));
  return { toDelete, pinnedItems, lostItems };
}

// ---- 撤销支持：记录每次整理的移动历史 ----
const UNDO_KEY = "undoStack";

async function loadUndoStack() {
  return new Promise((resolve) => {
    chrome.storage.local.get(UNDO_KEY, (o) => resolve(o[UNDO_KEY] || []));
  });
}

async function pushUndo(entry) {
  const stack = await loadUndoStack();
  stack.push(entry);
  await new Promise((r) => chrome.storage.local.set({ [UNDO_KEY]: stack }, r));
}

async function refreshUndoButton() {
  const stack = await loadUndoStack();
  $("btnUndo").disabled = stack.length === 0;
  $("btnUndo").textContent = stack.length ? `↶ 撤销上一步操作（${stack.length}）` : "↶ 撤销上一步操作";
}

// 构造发给 AI 的书签数组。
// useFolderHint 关闭时（或用户在设置页关掉）不带 folder 字段 —— 提示词里也不会有相关规则，
// 两处必须同源判断，否则会出现"提示词要求读 folder、请求里却没有这个字段"的尴尬（AI 会瞎猜）。
function buildAiPayload(items, cfg) {
  if (cfg.useFolderHint === false) {
    return {
      items: items.map((it) => ({ id: it.id, title: it.title, url: it.url })),
      hinted: 0,
      total: items.length
    };
  }
  // excludeNames 传预览容器名：容器内的副本早就被 loadItems 排除了，这里再兜一层，
  // 防止用户手工把书签放进「智能书签」文件夹时把插件产物当成线索喂回去。
  return attachFolderHints(items, { excludeNames: [cfg.targetFolderName] });
}

// 分类：根据配置走关键词或 AI。统一返回 { cats: {id:categoryId}, subs: {id:二级标签} }
async function classifyAll(items, cfg) {
  if (cfg.method === "ai") {
    const built = buildAiPayload(items, cfg);
    const payload = built.items;
    if (built.total) {
      // 如实报告线索覆盖情况：用户看到"只有 3/500 条带线索"就知道自己几乎没有目录结构可沿用，
      // 而不是去怀疑 AI 分类质量。
      let tail;
      if (cfg.useFolderHint === false) tail = "。设置里已关闭「参考现有文件夹」。";
      else if (built.hinted === 0) tail = "。当前书签几乎都平铺在根目录、或所在文件夹名没有信息量，AI 只能按标题与网址判断。";
      else tail = "。";
      log(`已发送 ${built.total} 个书签给 AI（其中 ${built.hinted} 个带了「现有文件夹」线索）${tail}`);
    }
    // 加超时兜底，避免后台无响应时弹窗卡死
    const res = await Promise.race([
      new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "AI_CLASSIFY", items: payload }, resolve)
      ),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "后台响应超时" }), 180000))
    ]);
    if (res && res.ok && res.result) {
      // 兼容旧返回（纯 map）与新返回（{cats, subs, subs2}）
      if (res.result.cats) {
        const adopted = await adoptNewCategories(res.result.newCats);
        if (adopted.length) {
          log(
            `AI 按你现有的文件夹路径新建了 ${adopted.length} 个大类：${adopted.map((c) => c.name).join("、")}` +
            `（已加入分类表，下次扫描会继续沿用；不想要就在设置页取消勾选「分类时参考书签现有的文件夹路径」，到「分类标签管理」里删掉）`
          );
        }
        // 未勾选「参考文件夹路径」时，表外大类一律不新建（大类只能从表里选）。
        // 但必须把被拒的名字说出来 —— 否则用户只看到"有些书签进了其他"，查不出原因。
        const rejected = res.result.rejectedCats || [];
        if (rejected.length) {
          log(
            `AI 给出了 ${rejected.length} 个分类表里没有的大类（${rejected.slice(0, 8).join("、")}` +
            `${rejected.length > 8 ? " 等" : ""}）。因为未勾选「分类时参考书签现有的文件夹路径」，` +
            `本次一律归入了兜底分类。想让它们独立成类，就把这些名字加进「分类标签管理」再扫一次，` +
            `或勾上那个开关让 AI 按你的文件夹结构自己建类。`,
            "warn"
          );
        }
        return { cats: res.result.cats, subs: res.result.subs || {}, subs2: res.result.subs2 || {}, used: "ai" };
      }
      return { cats: res.result, subs: {}, subs2: {}, used: "ai" };
    }
    log("AI 分类失败：" + (res?.error || "未知错误") + "，回退关键词", "err");
  }
  return { cats: classifyBatchKeyword(items), subs: {}, subs2: {}, used: "keyword" };
}

// AI 在「参考现有文件夹路径」模式下可以沿用用户自己的文件夹名直接新建大类
// （见 service-worker 的 resolveOrCreateCategory）。这里把它们真正落到
// **运行期分类表 + storage.sync.userCategories**：
//   · 只加运行期不落盘 → 下次刷新分类表就没了，用户会看到"每整理一次大类就变一遍"；
//   · 落盘 → 下次扫描能继续沿用；在设置页取消勾选「参考书签现有的文件夹路径」（或切到关键词模式）
//     就能看到、改、删。
// 只**追加**，绝不覆盖用户已有分类；已被近义匹配命中的一律跳过（避免「网文创作」/「网络小说」并存）。
// 返回真正新增的列表（用于日志）。
async function adoptNewCategories(newCats) {
  if (!newCats || !newCats.length) return [];
  const list = getActiveCategories();
  const fb = getFallbackCategory();
  const added = [];
  for (const nc of newCats) {
    const name = String((nc && nc.name) || "").trim();
    if (!name) continue;
    if (list.some((c) => c.id === nc.id || c.name === name)) continue;
    if (matchCategoryName(name, list)) continue; // 已有近义大类，不重复加
    const c = { id: nc.id, name, color: nc.color || fb.color, keywords: [], system: false };
    list.push(c);
    added.push(c);
  }
  if (!added.length) return [];
  await new Promise((resolve) => {
    chrome.storage.sync.get({ userCategories: null }, (o) => {
      const cur =
        Array.isArray(o.userCategories) && o.userCategories.length
          ? o.userCategories
          : JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
      for (const c of added) if (!cur.some((x) => x.id === c.id || x.name === c.name)) cur.push(c);
      chrome.storage.sync.set({ userCategories: cur }, resolve);
    });
  });
  return added;
}

// 分类表体检：返回 { error }（必须拦下）或 { warn }（能跑但要提醒）或 {}（正常）。
// 为什么抽成函数：扫描与生成预览两个入口都要用，只加一个会出现"拦得住扫描、拦不住预览"的漏洞。
// 为什么必须拦：分类表被删到只剩兜底的「其他」时，AI 与关键词分类器都只能把**全部**书签塞进「其他」，
//   而执行整理会删掉原书签、把这个「其他」文件夹提升到根目录 —— 用户会以为"整理过了"，
//   实际只是把书签全搬了个家。
function checkCategories(cfg) {
  const aiMode = !!(cfg && cfg.method === "ai");
  const eff = getActiveCategories().filter((c) => !c.system && String(c.name || "").trim());
  if (!eff.length) {
    // AI 模式下分类表的位置随「参考文件夹路径」这个开关变：
    //   · 勾选（默认）→ 表只是参考，大类主要由 AI 按文件夹结构决定，空表也能跑出合理结果 → 警告即可，不能拦。
    //   · 未勾选      → 表就是唯一依据（大类只能从表里选），空表时虽然提示词会让 AI 自行归纳，
    //                   但用户得知道这时候该去设置页把表补上 —— 而且那张表在本模式下**会显示出来**。
    if (aiMode) {
      const hint = !(cfg && cfg.useFolderHint === false);
      return {
        warn: hint
          ? "分类表里没有任何可归类的分类（只剩兜底的「其他」）。AI 模式下会按你书签现有的文件夹结构自行归纳、" +
            "必要时新建大类，所以仍可继续；但若书签几乎都平铺在根目录、没有文件夹结构可利用，" +
            "结果会大面积落进「其他」。建议到设置页点「恢复默认分类」。"
          : "分类表里没有任何可归类的分类（只剩兜底的「其他」），而你已取消「参考书签现有的文件夹路径」——" +
            "这张表就是 AI 唯一的归类依据，虽然此时会退让 AI 自行归纳，但结果未必合你意。" +
            "建议到设置页「分类标签管理」（本模式下它会显示出来）点「恢复默认分类」，或点「AI 建议大类（按我的书签）」直接提一套。"
      };
    }
    return {
      error:
        "当前分类里只剩兜底的「其他」，没有任何可归类的分类 —— 关键词模式下所有书签都会被塞进「其他」，等于没整理。" +
        "请先到设置页「分类标签管理」里添加分类：可以点「恢复默认分类」找回出厂分类，" +
        "也可以点「AI 建议大类（按我的书签）」让 AI 按你的书签直接提一套大类；或改用 AI 智能分类。"
    };
  }
  if (eff.length === 1) {
    return {
      warn:
        `当前只有 1 个分类「${eff[0].name}」，所有书签只能在它和「其他」之间二选一，分类质量会很差。` +
        "建议至少保留 3 个以上分类，或点「恢复默认分类」找回出厂分类。"
    };
  }
  return {};
}

function buildCatOptions(selectedId) {
  return getActiveCategories()
    .map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === selectedId ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    .join("");
}

function renderDistribution(classMap) {
  const cats = getActiveCategories();
  const counts = {};
  for (const id of Object.values(classMap)) counts[id] = (counts[id] || 0) + 1;
  const rows = cats.map((c) => ({ cat: c, n: counts[c.id] || 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  const max = rows.length ? rows[0].n : 1;
  const dist = $("dist");
  if (!rows.length) {
    dist.innerHTML = '<div class="hint">未发现可分类的书签。</div>';
    return;
  }
  dist.innerHTML = "";
  for (const { cat, n } of rows) {
    const row = document.createElement("div");
    row.className = "cat-row";
    row.innerHTML =
      `<span class="dot" style="background:${escapeHtml(cat.color)}"></span>` +
      `<span class="cat-name">${escapeHtml(cat.name)}</span>` +
      `<span class="cat-bar"><span class="cat-fill" style="width:${(n / max) * 100}%;background:${escapeHtml(cat.color)}"></span></span>` +
      `<span class="cat-count">${n}</span>`;
    dist.appendChild(row);
  }
}

// 手动微调列表：搜索 + 每行一个分类下拉框
function renderTweak() {
  const q = ($("search").value || "").toLowerCase().trim();
  const list = $("tweakList");
  // 没有分类结果时整块收起：空搜索框 + "没有匹配的书签" 只是噪声（默认就是收起态，见 popup.html）
  const sec = document.querySelector(".tweak");
  if (sec) sec.hidden = !currentItems.length;
  list.innerHTML = "";
  let matches = currentItems;
  if (q) matches = currentItems.filter((it) => (it.title + it.url).toLowerCase().includes(q));
  matches = matches.slice(0, q ? 200 : 60);
  if (!matches.length) {
    list.innerHTML = '<div class="hint">没有匹配的书签。</div>';
    return;
  }
  for (const it of matches) {
    const row = document.createElement("div");
    const isFreq = currentFreq.has(it.id);
    row.className = "tweak-row" + (isFreq ? " is-freq" : "");
    const sel =
      `<select data-id="${escapeHtml(it.id)}" data-url="${encodeURIComponent(it.url)}">` +
      buildCatOptions(currentClass[it.id] || getFallbackCategory().id) +
      `</select>`;
    const enc = encodeURIComponent(it.url);
    const tip = isFreq
      ? "高频书签：整理时平铺在所属分类的一级目录。点一下取消"
      : "点一下标为高频书签（整理时平铺在所属分类的一级目录）";
    const star =
      `<button type="button" class="star${isFreq ? " on" : ""}"` +
      ` data-id="${escapeHtml(it.id)}" data-url="${enc}" title="${tip}">` +
      `${isFreq ? "★" : "☆"}</button>`;
    row.innerHTML = star + `<div class="t-name" title="${escapeHtml(it.title)}">${escapeHtml(it.title)}</div>${sel}`;
    list.appendChild(row);
  }
  list.querySelectorAll("select").forEach((s) => s.addEventListener("change", onTweakChange));
  list.querySelectorAll(".star").forEach((b) => b.addEventListener("click", onFreqToggle));
}

// 切换某个书签的高频标记。写完 storage 立刻按新标记重算集合并重绘——
// 标星是纯本地操作，不重新扫描、不重新调 AI，必须一点就变。
async function onFreqToggle(e) {
  const btn = e.currentTarget;
  const id = btn.dataset.id;
  const url = decodeURIComponent(btn.dataset.url);
  const want = !currentFreq.has(id); // 点一下翻转
  const manual = await setFreqMark(url, want);
  currentFreq = applyFreqManual(currentFreqAuto, currentItems, manual);
  if (currentFreqMeta) currentFreqMeta.manual = manual;
  renderTweak();
  renderFreqInfo();
  const name = btn.parentElement.querySelector(".t-name");
  log(`已${want ? "标为" : "取消"}高频书签：${name ? name.textContent : url}`, "ok");
}

// 统计条文案。没选出结果时给出**具体原因**而不是静默显示 0——
// 「一个都没选出来」可能是没授权、历史为空、或书签压根没被访问过，处理方式完全不同。
function renderFreqInfo() {
  const el = $("freqInfo");
  if (!el) return;
  const meta = currentFreqMeta;
  // 「开启」入口只在「功能开着、但没授权」时露出来；授权后自动消失，不占视线
  const permLink = $("freqPerm");
  if (permLink) permLink.hidden = !(meta && meta.enabled && meta.needPermission);
  if (!meta || !meta.enabled) { el.textContent = "★ 高频：未启用"; return; }
  if (meta.needPermission) {
    el.textContent = currentFreq.size
      ? `★ 高频 ${currentFreq.size} 个（手动标记，未授权）`
      : "★ 高频：未授权浏览记录 → 点「开启高频」";
    el.title = "高频书签依赖浏览记录打分。点「开启高频」授权后即可自动识别常用书签；不授权也能在列表里手动点星。";
    return;
  }
  if (meta.reason) { el.textContent = `★ 高频：—（${meta.reason}）`; return; }
  const manual = meta.manual || {};
  const on = Object.keys(manual.on || {}).length;
  const off = Object.keys(manual.off || {}).length;
  const bits = [`自动 ${meta.auto ? meta.auto.size : 0}`];
  if (on) bits.push(`手动 +${on}`);
  if (off) bits.push(`手动 −${off}`);
  el.textContent = `★ 高频 ${currentFreq.size} 个（${bits.join("，")}）`;
}

// 「根目录上平铺的书签」提示条：只在**确实存在平铺书签、且设置为不参与整理**时出现。
// 为什么不直接替用户把这个开关打开：那是他的书签栏，有人就是刻意把常用入口钉在一键可达
//   的位置上。但**默认值必须给"参与"** —— 本插件的目标用户恰恰是书签大量平铺在根目录的
//   重度用户，对他们来说"一律跳过"等于插件什么都没做。这个提示条负责把"你有 N 个书签
//   根本没被整理"这件事说清楚，并给一个一键参与的入口，选择权仍在用户。
async function renderRootHint(cfg) {
  const bar = $("rootBar");
  if (!bar) return;
  const c = cfg || (await getConfig());
  if (c.organizeRootItems || !currentItems.length) { bar.hidden = true; return; }
  let rootParentId = null;
  try {
    rootParentId = await resolveTargetParentId(c.targetParentId);
  } catch (e) {
    bar.hidden = true;
    return;
  }
  if (!rootParentId) { bar.hidden = true; return; }
  // currentItems 已经排除了预览子树，这里的数字就是"真实平铺在根目录上的书签"
  const n = currentItems.filter((it) => it.parentId === rootParentId).length;
  if (!n) { bar.hidden = true; return; }
  const info = $("rootInfo");
  info.textContent = `⚠ ${n} 个书签在根目录，未参与整理`;
  info.title =
    "让它们参与整理：与其它书签完全同规则（分类、排序，执行整理时原书签被删除）。" +
    "如果它们是你特意钉在一键可达位置的常用入口，保持现状即可。" +
    "改变这项设置后需要重新点「生成预览」。";
  bar.hidden = false;
}

// 算出本次的高频书签集合。依赖 currentClass（每分类保底要用分类结果），
// 所以必须在分类就绪之后调用。只读浏览历史，不发网络请求，很快。
async function computeFrequent(cfg) {
  try {
    currentFreqMeta = await resolveFrequent(cfg, currentItems, currentClass);
    currentFreqAuto = currentFreqMeta.auto;
    currentFreq = currentFreqMeta.ids;
    currentFreqScores = currentFreqMeta.scores || new Map();
  } catch (e) {
    // enabled 保持 true 并带上 reason：否则界面会显示成「未启用」，把真实报错盖掉
    currentFreqMeta = {
      enabled: true, ids: new Set(), auto: new Set(),
      manual: { on: {}, off: {} },
      needPermission: false, granted: false, hasHistory: false, historySize: 0,
      reason: "计算失败：" + (e && e.message ? e.message : e)
    };
    currentFreqAuto = new Set();
    currentFreq = new Set();
    currentFreqScores = new Map();
  }
  renderFreqInfo();
  return currentFreqMeta;
}

async function onTweakChange(e) {
  const id = e.target.dataset.id;
  const url = decodeURIComponent(e.target.dataset.url);
  const catId = e.target.value;
  await setOverride(url, catId);
  currentClass[id] = catId;
  renderDistribution(currentClass);
  log(`已记忆调整：${url} → ${getCategoryById(catId).name}`, "ok");
}

// 确保分类结果已就绪
async function ensureClassified(cfg) {
  if (currentItems.length === 0) {
    const { items } = await loadItems(cfg);
    currentItems = items;
  }
  if (Object.keys(currentClass).length === 0) {
    const r = await classifyAll(currentItems, cfg);
    currentClass = await applyOverrides(r.cats, currentItems);
    currentSubs = r.subs || {};
    currentSubs2 = r.subs2 || {};
  }
  // 「生成预览 / 执行整理」会在这里兜底触发分类（用户没先点扫描就点了它们）。
  // 既然分类结果已经就绪，按钮高亮就跟着前进，别再退回「扫描分类」。
  setClassified(true);
}

async function scan(force) {
  beginStep("scan"); // 点亮「扫描并分类」（同时锁住其它动作按钮）
  // ⚠ 必须在这里就把「已分类」置上：scan 中途任何一处 return/抛错都会走到 finally，
  //   而 finally 里的 endStep → updateActionState 会按这个状态重新点亮按钮。
  //   不置上就会出现「扫完了，高亮却还停在扫描」或者「扫了一半失败，高亮跑去点执行整理」。
  setClassified(true);
  let completed = false;
  // 阶段权重按「预估耗时」分配：AI 分类是大头，读树/统计/渲染都是本地操作。
  // 命中缓存时分类阶段被跳过，进度会向前跳一段——这是真实情况（那部分工作确实没做），
  // 但整体保证**只增不减**。
  beginProgress([
    { id: "read", label: "读取书签树…", weight: 10, unknown: true },
    { id: "dedupe", label: "清理重复书签…", weight: 10 },
    { id: "classify", label: "分类中…", weight: 45, unknown: true },
    { id: "freq", label: "计算高频书签…", weight: 8, unknown: true },
    { id: "render", label: "渲染结果…", weight: 5 }
  ]);
  try {
    useStage("read");
    log("正在扫描书签树…");
    const cfg = await getConfig();
    const cc = checkCategories(cfg);
    if (cc.error) throw new Error(cc.error); // 兜底分类兜不住全部书签，直接拦下
    if (cc.warn) log(cc.warn, "warn");
    const { items, excluded, previewFolderId } = await loadItems(cfg);
    currentItems = items;

    // ---- 自动去重（默认步骤，排在分类前；由 cfg.autoDedupe 控制）----
    // 同一个网址存了多份会污染分类结果和最终目录，所以在 AI 分类前先清掉。
    // 每组保留「最早添加」的那份，其余删除；删除全部记入撤销栈，可一键恢复。
    // 关掉开关时**一个都不删**——重复项会一路带到最后的结构里（同一网址出现在多个分类夹），
    // 这是用户在设置里明确选的：他宁可留着重复，也不要插件删他的书签。
    const dedupeOn = cfg.autoDedupe !== false; // 未存过该键的老用户按「开启」处理
    const dd = dedupeOn ? await autoDedupe(currentItems, cfg) : { removedIds: new Set() };
    if (dedupeOn && dd.removedIds.size) {
      currentItems = currentItems.filter((it) => !dd.removedIds.has(it.id));
      log(
        `已自动去重：删除 ${dd.removedIds.size} 个重复书签（每组保留最早添加的一个）。误删可点「撤销上一步操作」恢复。`,
        "ok"
      );
    }

    showProgress("统计文件夹…");
    const folders = await countFolders(previewFolderId);

    $("statTotal").textContent = currentItems.length;
    $("statFolders").textContent = folders;
    $("statDup").textContent = dd.removedIds.size; // 本次扫描自动删掉的重复书签数（未去重就是 0）
    $("methodTag").textContent = cfg.method === "ai" ? "AI 智能" : "关键词规则"; // 页头小标签，越短越好
    if (!dedupeOn) {
      // 不去重也得让人知道「有多少重复留在了那里、为什么结构里会有同一个网址」，
      // 否则用户只会觉得插件漏了一半。改开关的地方在设置页。
      const dupCount = findDuplicates(currentItems).reduce((n, d) => n + d.items.length - 1, 0);
      log(
        dupCount
          ? `未在本次去重（设置里已关闭自动去重）：现有 ${dupCount} 个重复书签原样保留，同一个网址可能出现在多个分类文件夹中。`
          : "未在本次去重（设置里已关闭自动去重）：未发现重复书签。",
        dupCount ? "warn" : "ok"
      );
    }
    log(
      "扫描完成，共 " + currentItems.length + " 个书签" +
      (dedupeOn ? (dd.removedIds.size ? `，已自动去重 ${dd.removedIds.size} 个` : "，无重复") : "") +
      (excluded ? `。（已排除「${cfg.targetFolderName}」内的 ${excluded} 个预览副本，不计入统计与分类）` : "")
    );

    // 书签集 / 分类配置未变化时，直接复用上次分类结果，跳过 AI 调用
    const sig = classifySignature(currentItems, cfg);
    let r = null;
    if (!force) {
      const cache = await loadClassCache();
      if (cache && cache.sig === sig && cache.cats && Object.keys(cache.cats).length) {
        r = { cats: cache.cats, subs: cache.subs || {}, subs2: cache.subs2 || {} };
        log(`书签未变化，复用 ${new Date(cache.ts).toLocaleString()} 的分类结果（本次未调用 AI）。按住 Shift 点「扫描并分类」可强制重新分类。`);
      }
    }

    if (!r) {
      useStage("classify");
      showProgress(cfg.method === "ai" ? `AI 分类中…（共 ${currentItems.length} 个书签）` : "关键词分类中…");
      log("开始分类…");
      const res = await classifyAll(currentItems, cfg);
      r = { cats: res.cats || {}, subs: res.subs || {}, subs2: res.subs2 || {} };
      // 仅在「实际使用方法 == 配置方法」且结果非空时写缓存，避免把 AI 失败回退/空结果缓存下来
      if (res.used === cfg.method && Object.keys(r.cats).length) await saveClassCache(sig, r.cats, r.subs, r.subs2);
    }

    currentClass = await applyOverrides(r.cats, currentItems); // 叠加手动调整
    currentSubs = r.subs || {};
    currentSubs2 = r.subs2 || {};
    // 孤儿调整提示：手动标过的分类被删掉后，那些调整会静默失效（见 js/overrides.js）。
    // 静默失效最伤人 —— 用户会一直以为"我标过的书签还在我指定的分类里"，必须说出来。
    const orphans = await countOrphanOverrides();
    if (orphans) {
      log(
        `有 ${orphans} 条「手动调整」指向已被删除的分类，本次已忽略（这些书签按分类结果归类）。` +
          "到设置页点「恢复默认分类」把该分类加回来，这些调整就会重新生效。",
        "warn"
      );
    }
    // 「其他」占比过高 = 现有大类盖不住用户的书签。这是"该增删大类"的信号，
    // 在扫描结果里说出来，用户才知道设置页里有「AI 建议大类」这个入口。
    const otherId = getFallbackCategory().id;
    const otherCount = Object.values(currentClass).filter((id) => id === otherId).length;
    if (currentItems.length >= 20 && otherCount >= 20 && otherCount / currentItems.length >= 0.25) {
      log(
        `有 ${otherCount} 个书签（${Math.round((otherCount / currentItems.length) * 100)}%）落进了兜底的「其他」` +
          "——说明现在的大类盖不住你的书签。可到设置页「分类标签管理」点「AI 建议大类（按我的书签）」，" +
          "让 AI 按你的书签补几个大类（会先给你看建议、勾选后才生效）。",
        "warn"
      );
    }
    useStage("freq");
    showProgress("计算高频书签…");
    // 每分类保底要用到分类结果，所以必须在 currentClass 就绪之后才算
    await computeFrequent(cfg);
    useStage("render");
    showProgress("渲染结果…");
    renderDistribution(currentClass);
    renderTweak();
    await renderRootHint(cfg);
    await refreshUndoButton();
    log("分类完成，可在上方微调，然后点击「执行整理」。", "ok");
    const fm = currentFreqMeta;
    if (fm && fm.enabled && fm.needPermission) {
      log(
        "未自动识别高频书签：未授权「浏览记录」。点统计条右侧的「开启」授权即可自动识别；不授权也能在列表里点行首的 ☆ 手动标记。",
        "warn"
      );
    } else if (fm && fm.enabled && fm.reason) {
      log(`未选出高频书签：${fm.reason}。`, "warn");
    } else if (fm && fm.enabled) {
      log(`高频书签 ${currentFreq.size} 个：整理时平铺在所属分类的一级目录，不塞进二级子文件夹。点每行开头的星星可增减。`);
    }
    completed = true;
  } catch (e) {
    log("扫描出错：" + (e && e.message ? e.message : e), "err");
  } finally {
    // 收尾是硬要求：不收起的话条纹动画会一直转，看起来像「还在跑」
    if (completed) endProgress(600);
    else abortProgress();
    await endStep();
  }
}

// 轻量刷新：只重读书签树、更新统计数字，**不重新分类**（避免重复触发 AI 调用）
// 用于扫描之外的所有操作收尾——这些操作的分类结果没变，重扫只会白等一次 AI。
async function refreshStats() {
  const cfg = await getConfig();
  const { items, previewFolderId } = await loadItems(cfg);
  currentItems = items;
  const folders = await countFolders(previewFolderId);
  $("statTotal").textContent = currentItems.length;
  $("statFolders").textContent = folders;
  // ⚠ 不碰 statDup：那格是「本次扫描清理了多少重复」，由 scan 写。
  //   refreshStats 从不去重，让它去覆盖只会出现「显示已去重 5、其实一个没删」的假数字。
  $("methodTag").textContent = cfg.method === "ai" ? "AI 智能" : "关键词规则"; // 与 scan 同源，打开即有
  await refreshUndoButton();
  await renderRootHint(cfg);
  // 书签数可能变了（比如刚执行完整理），「下一步该点哪一步」跟着变，这里同步一次高亮
  await refreshPreviewReady(cfg);
  updateActionState();
}

// ---- 分类结果缓存：书签集未变化时跳过 AI 调用 ----
const CLASS_CACHE_KEY = "classifyCache";

// FNV-1a 32 位哈希，够快够用（非加密用途）
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + "-" + s.length.toString(36);
}

// 指纹涵盖：分类方法 / 接口地址 / 模型 / 分类表 / AI 提示词正文 / 是否用文件夹线索 + 全部书签的 id|url|title
// 注意：不含 parentId，所以「移动书签」不会导致无谓重算；书签按 id 排序，保证顺序无关。
//   由此带来的取舍：文件夹线索变了（用户把书签挪了位置）**不会**自动重算分类 —— 那属于
//   用户高频操作，每次都重跑 AI 太贵。想让新线索生效，按住 Shift 点「扫描并分类」强制重算。
//   但「是否启用线索」这个开关必须进指纹：它改变的是 AI 读到的规则本身，不是线索内容。
function classifySignature(items, cfg) {
  const useFolderHint = cfg.useFolderHint !== false;
  // 提示词正文取自 js/config.js（唯一真源），哈希它 = 改提示词自动失效旧缓存。
  // 否则会出现「改了提示词 → 指纹没变 → 命中旧缓存 → 界面还是坏结果」的假修复。
  const promptText = buildAiInstructions(
    "", // 类别清单已单独入指纹，这里占位即可
    parseInt(cfg.maxSubFolders, 10) || 0,
    !!cfg.enableThirdLevel,
    "",
    "",
    {
      folderHint: useFolderHint, // 传真实开关值，保证哈希的就是实际要发出去的那段文本
      folderFirst: useFolderHint // 与 service-worker 完全同源：勾了「参考现有文件夹路径」= 路径为主要依据
    }
  );
  const head = [
    cfg.method || "",
    cfg.aiBaseUrl || "",
    cfg.aiModel || "",
    String(cfg.maxSubFolders ?? ""), // 该值会写进 AI 提示词（每类标签数上限），改动必须重算
    cfg.enableThirdLevel ? "3" : "2", // 是否要求 AI 产出三级标签，改动必须重算
    useFolderHint ? "fh" : "nfh", // 是否把「现有文件夹路径」当线索：影响归依据，改动必须重算
    hashString(promptText), // AI 提示词版本（文本哈希）
    // 分类表：**名称与关键词都要入指纹**。关键词现在是喂给 AI 的归类依据（buildCategoryList），
    // 改了关键词 = 分类依据变了 → 必须重算。漏掉关键词会出现「改了关键词、AI 还是按旧依据分」的假修复。
    getActiveCategories()
      .map((c) => c.id + ":" + c.name + ":" + (c.keywords || []).join("/"))
      .join(",")
  ].join("\u0001");
  const body = items
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((it) => it.id + "|" + (it.url || "") + "|" + (it.title || ""))
    .join("\n");
  return hashString(head + "\u0002" + body);
}

function loadClassCache() {
  return new Promise((r) => {
    chrome.storage.local.get(CLASS_CACHE_KEY, (o) => r(o[CLASS_CACHE_KEY] || null));
  });
}

function saveClassCache(sig, cats, subs, subs2) {
  return new Promise((r) => {
    chrome.storage.local.set({ [CLASS_CACHE_KEY]: { sig, cats, subs, subs2, ts: Date.now() } }, r);
  });
}

// 解析目标父文件夹的真实 id（从书签树动态解析，避免硬编码 id 失配）
async function resolveTargetParentId(value) {
  const tree = await new Promise((r) => chrome.bookmarks.getTree(r));
  return resolveRootFolderId(value, tree);
}

// 三个书签根目录在界面上的名字（日志与提示用；顺序约定同 resolveRootFolderId）
const ROOT_LABELS = { "1": "书签栏", "2": "其他书签", "3": "移动设备书签" };
function rootLabelOf(value) {
  return ROOT_LABELS[String(value)] || "根目录";
}

// 确保目标文件夹存在，返回其 id
async function ensureTarget(cfg) {
  const parentId = await resolveTargetParentId(cfg.targetParentId);
  if (!parentId) throw new Error("无法定位书签根目录，请检查浏览器书签");
  const existing = await findFolder(parentId, cfg.targetFolderName);
  if (existing) return existing.id;
  const created = await createFolder(parentId, cfg.targetFolderName);
  if (created.error) throw new Error(`无法创建目标文件夹「${cfg.targetFolderName}」：${created.error}`);
  return created.id;
}

// 当前已生成的预览文件夹 id（若有）
let previewTargetId = null;
// 当前预览里「存有副本」的原书签 id 列表（执行整理时只删这些，绝不误删未参与的书签）
const PREVIEW_SRC_KEY = "previewSourceIds";

// 覆盖写入，**不是**取并集。
// 配合 buildPreview 的「全量重建」，清单的语义 = 本次预览里确实有副本的原书签。
// 旧写法取并集（merged）会留下失效 id：用户生成预览后把某书签钉到根目录，重新生成预览时
// 它被跳过、没被复制，但上一轮的 id 还在清单里 → 执行整理时被误删（用户明明要它留在根上）。
// organizeRoot 一并记下来：执行时要拿它和当前配置比对——两者不一致说明「清单是按另一种
// 根目录策略生成的」，此时删/不删的判断标准已经变了，必须先提示用户重新生成预览。
async function savePreviewSource(targetId, ids, organizeRoot) {
  const uniq = [...new Set(ids)];
  await new Promise((r) =>
    chrome.storage.local.set(
      { [PREVIEW_SRC_KEY]: { targetId, ids: uniq, organizeRoot: !!organizeRoot } },
      r
    )
  );
}

async function loadPreviewSource() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PREVIEW_SRC_KEY, (o) => resolve(o[PREVIEW_SRC_KEY] || null));
  });
}

async function clearPreviewSource() {
  previewTargetId = null;
  await new Promise((r) => chrome.storage.local.remove(PREVIEW_SRC_KEY, r));
}

// 取三个书签根目录的真实 id（书签栏 / 其他书签 / 移动设备书签）——根目录永不删除
async function getRootFolderIds() {
  const tree = await new Promise((r) => {
    chrome.bookmarks.getTree((t) => {
      const err = chrome.runtime.lastError;
      r(err || !t ? [] : t);
    });
  });
  const roots = (tree && tree[0] && tree[0].children) || [];
  return new Set(roots.map((x) => x.id));
}

// 把预览容器下的分类文件夹「提升」到目标根目录：
//   - 根目录下没有同名文件夹 → 整个文件夹移过去（内部结构与顺序原样保留）
//   - 已有同名文件夹 → 合并：把源文件夹内的子项逐个移进已有文件夹（不产生重复文件夹）
// 用不带 index 的 move（追加到末尾），避免动到根目录上用户原有书签的位置。
// 返回 { moves, promoted, merged }；moves 记录每个被移动节点的原位置，供撤销回滚。
// onStep(done, total) 可选：把「提升到第几个文件夹」上报给进度条
async function promotePreviewChildren(cfg, containerId, onStep) {
  const parentId = await resolveTargetParentId(cfg.targetParentId);
  if (!parentId) return { moves: [], promoted: 0, merged: 0, emptied: [] };
  const kids = await getChildren(containerId);
  const folders = kids.filter((c) => !c.url);
  if (!folders.length) return { moves: [], promoted: 0, merged: 0, emptied: [] };

  const existing = await getChildren(parentId);
  const byTitle = new Map();
  for (const c of existing) if (!c.url) byTitle.set(c.title, c);

  const moves = [];
  const emptied = []; // 合并后自己变空的源文件夹（防御性收集，交给 cleanupEmptyFolders 删）
  let promoted = 0;
  let merged = 0;
  for (let fi = 0; fi < folders.length; fi++) {
    const f = folders[fi];
    if (onStep) onStep(fi, folders.length);
    const twin = byTitle.get(f.title);
    if (!twin) {
      const r = await moveBookmark(f.id, parentId);
      if (r.ok) {
        moves.push({ id: f.id, fromParentId: containerId, fromIndex: f.index || 0 });
        promoted++;
      }
      continue;
    }
    if (twin.id === f.id) continue; // 防御：同层不可能自指
    // 合并到已有的同名文件夹
    const sub = await getChildren(f.id);
    for (const c of sub) {
      const r = await moveBookmark(c.id, twin.id);
      if (r.ok) moves.push({ id: c.id, fromParentId: f.id, fromIndex: c.index || 0 });
    }
    // 源夹本来就没有子项（或全搬走了）→ 它现在是个空壳，记下来一并清理
    if (!(await getChildren(f.id)).length) emptied.push(f.id);
    merged++;
  }
  if (onStep) onStep(folders.length, folders.length);
  return { moves, promoted, merged, emptied };
}

// 自底向上清理「因本次整理而变空」的文件夹。
// seeds = 可能变空的目录 id（被删书签的原父目录、预览容器、被合并的源文件夹）。
// 规则：根目录永不删；只删空目录；删掉后继续向上检查其父目录。
// onStep(done, total) 可选：上报已检查目录数（队列会向上生长，故 total 取「已知与已检查」的较大者——
//   分子分母同步增长可保证比例单调不减、又不会超过 100%）。
// 返回被删文件夹的快照 [{id, title, parentId, index}]，顺序为「深→浅」（撤销时逆序重建）。
async function cleanupEmptyFolders(seeds, onStep) {
  const rootIds = await getRootFolderIds();
  const removed = [];
  const queue = [...seeds];
  const seen = new Set();
  // 进度用独立的只增计数器：seen 会因为「父目录需要重查」而被删元素，
  // 若直接拿 seen.size 当分子，进度会倒退（违反「进度只增不减」）。
  let checked = 0;
  while (queue.length) {
    const fid = queue.shift();
    if (!fid || seen.has(fid)) continue;
    seen.add(fid);
    checked++;
    if (onStep) onStep(checked, Math.max(seeds.length, checked));
    if (rootIds.has(fid)) continue; // 根目录不动
    const node = await getBookmark(fid);
    if (!node || node.url) continue; // 不存在或不是文件夹
    const children = await getChildren(fid);
    if (children.length) continue; // 非空：保留
    const parentId = node.parentId;
    const sibs = await getChildren(parentId);
    const index = sibs.findIndex((c) => c.id === fid);
    if (!(await removeTree(fid))) continue;
    removed.push({ id: fid, title: node.title, parentId, index: index >= 0 ? index : 0 });
    // ★ 必须让父目录**可被重查**：种子顺序是「父先于子」（collectFolderIds 如此），
    //   父目录第一次被检查时孩子还在 → 判成「非空」跳过；等孩子删掉、父目录重新入队时，
    //   若被 seen 一票否决，父目录就永远留成空壳 —— 这正是"整理完还冒出一堆空文件夹"的根因。
    //   从 seen 摘掉即可重查；每次摘掉都由一次真实删除触发，删除数有上界，故不会死循环。
    seen.delete(parentId);
    queue.push(parentId); // 父目录可能因此也空了，继续向上
  }
  if (onStep) onStep(1, 1);
  return removed;
}

// 清理预览容器「子树内部」的空文件夹（从深到浅）。
// 用途：改成按需建夹后，本次不会再有空夹；但历史生成可能在容器里留下空的分类/二级文件夹，
//       它们不会被后续逻辑复用，攒着只会让预览越来越乱。
// 安全边界：只作用于容器子树内部、且只删空目录——都是插件自己的产物，不碰用户原有数据。
// onStep(done, total) 可选：上报「已检查的空夹候选」进度
async function pruneEmptyInPreview(containerId, onStep) {
  const folders = []; // 后序遍历 push → 天然「深→浅」顺序
  const collect = async (id) => {
    const kids = await getChildren(id);
    for (const k of kids) {
      if (k.url) continue;
      await collect(k.id);
      folders.push({ id: k.id, title: k.title });
    }
  };
  await collect(containerId);
  let n = 0;
  const total = Math.max(1, folders.length); // 候选为空时也给个总量，避免退回「不确定进度」
  for (let i = 0; i < folders.length; i++) {
    if (onStep) onStep(i, total);
    const left = await getChildren(folders[i].id);
    if (left.length) continue; // 有内容：保留
    if (await removeTree(folders[i].id)) n++;
  }
  if (onStep) onStep(1, 1);
  return n;
}

// ---- 空文件夹治理 ----
// 现象：整理完一段时间后，书签栏上会冒出若干空文件夹（尤其是分类夹变成了空壳）。
// 成因有三条，各有对策：
//   ① 预览容器被清空后没人删它 → buildPreview 里"空容器自清"（见该处）；
//   ② 执行整理把分类夹提升到根目录后，之后里面的书签被删/被改分类，夹子就空了
//      → 记录本轮产物的 id，下次生成预览时回收（下面两函数）；
//   ③ 合并同名分类夹时，源夹里的子项搬走、源夹变空 → 由 cleanupEmptyFolders 兜底。
// 安全边界：**只动插件自己产出过的 id**（名单存在 storage.local）。用户自己建的空文件夹一律不碰。

// 收集容器子树里的所有文件夹 id（不含容器自身）。顺序为「浅→深」，便于逐个判定。
async function collectFolderIds(containerId) {
  const out = [];
  const walk = async (id) => {
    const kids = await getChildren(id);
    for (const k of kids) {
      if (k.url) continue;
      out.push(k.id);
      await walk(k.id);
    }
  };
  await walk(containerId);
  return out;
}

function saveOutputFolderIds(ids) {
  return new Promise((r) => chrome.storage.local.set({ lastOutputFolderIds: ids || [] }, r));
}

function loadOutputFolderIds() {
  return new Promise((r) =>
    chrome.storage.local.get({ lastOutputFolderIds: [] }, (o) =>
      r(Array.isArray(o.lastOutputFolderIds) ? o.lastOutputFolderIds : [])
    )
  );
}

// 回收上一次整理留下的、如今已经变空的产物文件夹。返回清理个数。
// 只按名单来（见上方说明），因此不会误删用户自己的空文件夹。
async function reclaimEmptyOutputFolders() {
  const ids = await loadOutputFolderIds();
  if (!ids.length) return 0;
  const removed = await cleanupEmptyFolders(ids);
  // 名单里仍存在且非空的留着下次再查；删掉的与被合并掉的（id 已不存在）从名单移除
  const keep = [];
  for (const id of ids) {
    const node = await getBookmark(id);
    if (node && !node.url) keep.push(id);
  }
  await saveOutputFolderIds(keep);
  return removed.length;
}

// 取某书签的「二级细分标签」：AI 模式用二级标签；没有标签时回退域名（若开启）；都没有则返回空串
function subLabelOf(bm, cfg) {
  if (cfg.method === "ai") {
    const label = String(currentSubs[bm.id] || "").trim();
    if (label) return label;
  }
  if (cfg.subByDomain) return domainOf(bm.url) || "";
  return "";
}

// 取某书签的「三级细分标签」：只在 AI 模式 + 开启三级子文件夹时有效。
// 三级必须有二级才有归属（没有二级标签 = 上浮到分类文件夹，也就谈不上三级），
// 这一点在 service-worker 解析时已经保证，这里再兜一次。
function subSubLabelOf(bm, cfg) {
  if (cfg.method !== "ai" || !cfg.enableThirdLevel) return "";
  if (!String(currentSubs[bm.id] || "").trim()) return "";
  return String(currentSubs2[bm.id] || "").trim();
}

// 两个二级标签的相似度（0~1），用于把超限标签并入最接近的已选标签。
// 中文短语很短，单一指标都不可靠，这里做三段式：
//   ① 完全相同 → 1；
//   ② 互为子串（「前端」⊂「前端框架」）→ 0.75，强信号；
//   ③ 否则取 bigram Dice 系数与「共用单字比例」的较大值（后者兜底：短词 bigram 常全不匹配）。
function labelSimilarity(a, b) {
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.75;
  const grams = (s) => {
    const g = new Set();
    for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2));
    if (s.length === 1) g.add(s);
    return g;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  const dice = (2 * inter) / (ga.size + gb.size);
  const ca = new Set([...a]);
  const cb = new Set([...b]);
  let ci = 0;
  for (const x of ca) if (cb.has(x)) ci++;
  const chr = (2 * ci) / (ca.size + cb.size);
  return Math.max(dice, chr * 0.85);
}

// 近义标签的合并阈值：0.75 正好对应 labelSimilarity 的「互为子串」强信号档
// （「代码托管」↔「代码托管平台」= 0.75）。低于此值的不合并 —— 例如共享一两个字的
// 「前端框架」↔「前端开发」只有 0.43，它们是**不同主题**，合并等于消灭差异。
const SIM_MERGE_THRESHOLD = 0.75;

// 本层「子文件夹过少」的下限：子文件夹数 ≤ 该值时，即使本层一个直接书签都没有也不解散。
// 为什么：1~2 个子文件夹本来就是合理结构（点开分类看到两三个文件夹很正常），而解散最小的
//   那个只是把书签推回一级目录，换来"一级能直接点"，代价是用户的结构被破坏。
//   3 个及以上才认为"层层点进去才见到内容"确实是问题，此时才解散。
const SUBS_KEEP_MIN = 2;

// 把「互为子串 / 高度相似」的标签先并成一个个「主题组」，避免同义标签各占一个名额。
// 为什么必须先合并：maxSubs=5 时，「代码托管」和「代码托管平台」会各占掉一个名额，
//   真正独立的主题（前端框架 / 正则工具 / 容器镜像 / 构建工具）一个位置都分不到，
//   随后被当成"超限标签"——而超限处置要求"必须与已选标签有相似度才能并入"，
//   独立主题恰恰没有相似度，于是只能上浮到一级目录。用户的观感就是"归类不全"。
// 合并规则：按书签数降序依次认领；与已有代表相似度 ≥ threshold 的并入该书签数最多的
//   那个代表（= 名字最主流的那个）。于是 5 个名额真的留给 5 个不同主题。
// 输入 counts: Map<标签, 书签数>；
// 返回 { groups: Map<代表标签, { count, members: [原标签…] }>,
//        rep:    Map<原标签, 代表标签> }
// ⚠ rep 不能省：**成员标签的书签必须靠它才能落回代表**。少了这一步，被合并掉的标签
//   （如「代码托管平台」）在 assign 时既不在 pickedSet 里、也不在 remap 里，
//   结果整批书签静默变成"无归属"上浮 —— 合并反而把内容弄丢了。
function mergeSimilarLabels(counts, threshold) {
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  const groups = new Map();
  const rep = new Map();
  for (const [label, c] of sorted) {
    let hit = null;
    for (const r of groups.keys()) {
      if (labelSimilarity(label, r) >= threshold) { hit = r; break; }
    }
    if (hit) {
      const g = groups.get(hit);
      g.count += c;
      g.members.push(label);
      rep.set(label, hit);
    } else {
      groups.set(label, { count: c, members: [label] });
      rep.set(label, label);
    }
  }
  return { groups, rep };
}

// 逐层收敛：决定「同一个父文件夹下的一批书签」各自该落到哪个子文件夹。
// 入参 entries: [{ label }]，label = 该书签在本层的标签（空串 = 本层无标签）
//   minItems：子文件夹最少书签数（不足说明归类过碎 → 不建子文件夹）
//   max：本层最多建几个子文件夹（<=0 = 不做本层细分）
// 返回 { assign: string[]（与 entries 等长，空串 = 放在父文件夹本级）,
//        merged, alone, dropped, dissolved, kept, grouped, thin }
//
// 处理顺序（缺一不可）：
//   ① 近义标签先并成主题组——同义标签不能各占一个名额（见 mergeSimilarLabels）；
//   ② 书签数少于 minItems 的组不进候选——只含 1 个书签的子文件夹没有意义；
//   ③ 余下的按书签数降序取前 max 个；超出上限的组**不丢弃**，而是按名称相似度并入
//      最接近的已选组（子文件夹数仍严格 ≤ max）。同数量按标签名升序，保证结果可复现；
//   ④ 没拿到名额的组里，与所有已选组零相似的那些**平铺在本级**，不硬塞进某个文件夹。
//      为什么不给它们一个「待整理」桶（曾经有过，作者要求删掉）：把毫无关联的书签塞进
//      一个文件夹，造成的分类错误比平铺更难被发现；而且那个桶本身就是个几乎没意义的
//      文件夹，每层挂一个只会让结构变脏。宁可让用户一眼看见"这几个没归好"。
//   ⑤ 若本层一个直接书签都没有（全被分进子文件夹），一般解散书签数最少的那一个，
//      保证每一层都有可直接点击的书签。例外：本层子文件夹 ≤ SUBS_KEEP_MIN 个时不解散
//      —— 1~2 个文件夹本来就是合理结构（也覆盖"整类塌缩成一个标签"的 AI 塌缩场景）。
function planLayer(entries, minItems, max, opts) {
  const n = entries.length;
  const assign = new Array(n).fill("");
  const zero = { assign, merged: 0, alone: 0, dropped: 0, dissolved: 0, kept: 0, grouped: 0, thin: 0 };
  if (max <= 0 || n === 0) return zero;

  const counts = new Map(); // label -> 书签数
  for (const e of entries) {
    const l = String(e.label || "").trim();
    if (l) counts.set(l, (counts.get(l) || 0) + 1);
  }
  // 整层都没有标签 → 全部平铺在本级（诚实行为：没有依据就不硬分）
  if (!counts.size) return zero;

  // ① 近义标签并成主题组
  const { groups, rep } = mergeSimilarLabels(counts, SIM_MERGE_THRESHOLD);
  let grouped = 0;
  for (const g of groups.values()) grouped += g.members.length - 1;

  // ② 主题组按书签数降序；不足 minItems 的不进候选
  const sorted = [...groups.entries()].sort(
    (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  const big = minItems > 1 ? sorted.filter(([, g]) => g.count >= minItems) : sorted;
  const dropped = sorted.length - big.length;
  const leftovers = big.slice(max).concat(sorted.slice(big.length)); // 超限的 + 太碎的

  // ③ 取前 max 个主题组作为子文件夹
  const picked = big.slice(0, max).map(([l]) => l);
  const pickedSet = new Set(picked);

  // ④ 没拿到名额的组：按语义并入最相近的已选组；确实无相似度的一律平铺在本级
  const remap = new Map();
  let merged = 0;
  let alone = 0;
  for (const [l] of leftovers) {
    let best = null;
    let bestScore = 0;
    for (const p of picked) {
      const s = labelSimilarity(l, p);
      if (s > bestScore || (s === bestScore && best && groups.get(p).count > groups.get(best).count)) {
        bestScore = s;
        best = p;
      }
    }
    if (best && bestScore > 0) { remap.set(l, best); merged++; }
    else alone++;
  }

  for (let i = 0; i < n; i++) {
    const raw = String(entries[i].label || "").trim();
    if (!raw) continue; // 本层没有标签：留在本级
    // 先归到所在主题组的**代表标签**：被合并掉的标签（「代码托管平台」）本身不在
    // picked/remap 里，只有经过 rep 这一步才能跟着代表一起落位。
    const l = rep.get(raw) || raw;
    if (pickedSet.has(l)) assign[i] = l;
    else if (remap.has(l)) assign[i] = remap.get(l);
    // 其余（零相似的 / 太碎的）保持空串：平铺在本级
  }

  // ⑤ 本层没有直接书签时的补救
  let dissolved = 0;
  let kept = 0;
  let thin = 0;
  if (assign.every((a) => a)) {
    const cnt = new Map();
    for (const a of assign) cnt.set(a, (cnt.get(a) || 0) + 1);
    if (cnt.size <= SUBS_KEEP_MIN) {
      kept = 1;
      thin = 1;
    } else {
      let victim = null;
      let vc = Infinity;
      for (const [l, c] of cnt) {
        if (c < vc || (c === vc && victim !== null && l < victim)) { vc = c; victim = l; }
      }
      if (victim !== null) {
        for (let i = 0; i < n; i++) if (assign[i] === victim) assign[i] = "";
        dissolved = 1;
      }
    }
  }
  return { assign, merged, alone, dropped, dissolved, kept, grouped, thin };
}

// 阶段一：生成预览——把书签「复制」进智能整理文件夹（不动原书签）
async function buildPreview() {
  const cfg = await getConfig();
  // 与 scan 同一道守门：用户可能先扫描、再去设置页把分类删光、然后回来直接点「生成预览」，
  // 此时 currentClass 里还揣着已被删掉的分类 id（getCategoryById 会回退成「其他」）→ 同样要拦。
  const cc = checkCategories(cfg);
  if (cc.error) {
    log("生成预览出错：" + cc.error, "err");
    return;
  }
  beginStep("preview"); // 点亮「生成预览」（同时锁住其它动作按钮）
  let copied = 0;
  let failed = 0;
  let completed = false;
  // 阶段权重按预估耗时分配：复制书签是大头，两次遍历（筛选 + 复制）合计约 57%。
  beginProgress([
    { id: "prepare", label: "读取分类结果…", weight: 10, unknown: true },
    { id: "reset", label: "清理上一次的预览内容…", weight: 8 },
    { id: "filter", label: "筛选书签…", weight: 12 },
    { id: "copy", label: "生成预览…", weight: 45 },
    { id: "prune", label: "清理空文件夹…", weight: 5 },
    { id: "sort", label: "整理目录顺序…", weight: 15 },
    { id: "save", label: "保存预览快照…", weight: 5 }
  ]);
  try {
    useStage("prepare");
    await ensureClassified(cfg);
    // 高频书签每次重新算：浏览记录每天都在变，吃缓存会让「高频」名不副实。
    // 这一步只读本地历史、不发网络请求，开销可忽略。
    useStage("prepare", "计算高频书签…");
    await computeFrequent(cfg);
    const targetId = await ensureTarget(cfg);
    previewTargetId = targetId;
    // 目标根目录的真实 id（默认书签栏），用于识别「直接平铺在根目录上的书签」
    const rootParentId = await resolveTargetParentId(cfg.targetParentId);
    // 根目录上的直接书签是否参与整理。默认 false = 保持原位不动；
    // 开启后它们与普通书签同规则（分类 / 排序 / 执行时删除）。
    const organizeRoot = !!cfg.organizeRootItems;
    // 根目录上直接平铺的书签数量（仅用于日志说明；currentItems 已排除预览子树）
    const rootCount = organizeRoot && rootParentId
      ? currentItems.filter((it) => it.parentId === rootParentId).length
      : 0;

    // 分类文件夹「按需创建」——只建本次真的有书签落进去的分类。
    // 旧实现在这里为**所有**分类预建文件夹（含本次一个书签都没有的分类），直接产生空文件夹。
    const catFolderIds = {}; // catId -> folderId（首次真正用到时才创建）
    const ensureCatFolder = async (catId) => {
      if (catFolderIds[catId]) return catFolderIds[catId];
      const c = getCategoryById(catId);
      if (!c) return null;
      let f = await findFolder(targetId, c.name);
      if (!f) {
        const created = await createFolder(targetId, c.name);
        if (created.error) { log(`创建分类文件夹「${c.name}」失败：${created.error}`, "err"); return null; }
        f = { id: created.id };
      }
      catFolderIds[catId] = f.id;
      return f.id;
    };

    const total = currentItems.length;
    const copiedSourceIds = []; // 记录复制成功的原书签 id，供执行阶段精确删除
    let skippedPinned = 0; // 统计被跳过（不整理）的根目录书签
    // ---- 清空上一次的预览内容：预览必须是「当前书签树」的完整函数 ----
    // 为什么必须重建而不是增量：增量（同 URL 已存在就跳过复制）会让预览里留着**过期副本**——
    //   ① 用户删掉原书签 A，A 的副本仍躺在预览里，执行时被提升上来，等于「删了又复活」；
    //   ② 用户改了原书签标题，最终留下的是旧标题（副本照旧数据复制）；
    //   ③ 预览里攒下早先配置产生的废弃分类夹。
    // 代价：每次生成都要重新复制一遍（有进度条）。换来「预览 == 当前树」这个可断言的不变式。
    useStage("reset");
    // ---- 清空之前，先把「不是本轮副本」的书签抢救出去 ----
    // 用户可以往「智能书签」里拖东西（把某个书签直接放进预览、或把原件整个拖进来）。
    // 这些条目不在 currentItems 里（loadItems 会排除整个预览子树），因此下面的重建删掉它们之后
    // **没有任何一步会再把它们复制回来** —— 用户看着是"整理了一下，书签少了几个"，无从回溯。
    // 判定只有一条：容器里某个书签的 URL，在当前真实书签树（已排除容器）里找不到同款 →
    //   它不是任何现有书签的副本（可能是用户手工放进去的，也可能是原件已被删掉的旧副本）。
    // 处理方式：先移到目标根目录再重建，绝不直接删。宁可在根目录多出几条，也不能静默丢数据。
    const allNow = await allBookmarks();
    const realUrls = new Set(
      allNow
        .filter((it) => !it.folderIds.includes(targetId))
        .map((it) => normalizeUrl(it.url || ""))
    );
    const stray = []; // { id, title, url }
    const collectStray = async (id) => {
      for (const c of await getChildren(id)) {
        if (c.url) {
          if (!realUrls.has(normalizeUrl(c.url || ""))) stray.push(c);
        } else {
          await collectStray(c.id);
        }
      }
    };
    await collectStray(targetId);
    if (stray.length && rootParentId) {
      for (const s of stray) await moveBookmark(s.id, rootParentId);
      log(
        `「${cfg.targetFolderName}」里有 ${stray.length} 个在当前书签树中找不到来源的书签` +
          `（你手工放进去的，或原件已被删掉的旧副本），已先移到「${rootLabelOf(cfg.targetParentId)}」根目录，` +
          `不会被本次重建清掉：${briefList(stray)}`,
        "warn"
      );
    }
    const staleChildren = await getChildren(targetId);
    let cleaned = 0;
    const staleTotal = Math.max(1, staleChildren.length);
    for (let i = 0; i < staleChildren.length; i++) {
      showProgress(`清理上一次的预览内容… ${i + 1}/${staleChildren.length}`, i + 1, staleTotal);
      if (await removeTree(staleChildren[i].id)) cleaned++;
    }
    if (staleChildren.length > cleaned) {
      log(`清理上一次的预览内容时失败 ${staleChildren.length - cleaned} 项，可能会有旧内容残留。`, "warn");
    }

    // 清空后本应为空；仍然读一次作为兜底——万一上面清理失败，它能挡住重复复制
    const existingUrls = await collectExistingUrls(targetId);
    // 关闭自动去重 = **彻底不去重**：existingUrls 只用于挡住「容器没清干净的残留」，
    // 本轮自己复制出去的书签不再登记（见下方进 classify 分支前的 push 处），
    // 于是同一个网址存了 N 份，这里就复制 N 份、最终结构里也保留 N 份。
    const dedupeOn = cfg.autoDedupe !== false;
    // 顺手回收上一次整理留在书签栏上的空壳文件夹（只清理插件自己产出过的 id，见 reclaimEmptyOutputFolders）
    const reclaimed = await reclaimEmptyOutputFolders();
    if (reclaimed) log(`顺带清理了上一次整理留下的 ${reclaimed} 个空文件夹。`);
    // 每个分类下最多建几个二级子文件夹（0 = 不做二级细分）
    const maxSubs = Math.max(0, parseInt(cfg.maxSubFolders, 10) || 0);
    // 分类内书签少于此数则不细分（0/1 = 不限制）
    const minSubSize = Math.max(0, parseInt(cfg.minSubFolderSize, 10) || 0);

    // ---- 第一遍：先筛出真正要复制的书签，并统计各分类下的二级标签数量 ----
    const pending = []; // { bm, catId, subLabel }
    for (let i = 0; i < total; i++) {
      const bm = currentItems[i];
      if (i === 0) useStage("filter");
      showProgress(`筛选书签中… ${i + 1}/${total}`, i + 1, total);
      if (bm.folderIds.includes(targetId)) continue; // 已在预览内，跳过
      // 用户主动放在根目录（书签栏等）上的书签：默认视为「方便点击」不整理；
      // 设置里开启「根目录上平铺的书签也参与整理」后，它们按普通书签同等处理。
      if (!organizeRoot && rootParentId && bm.parentId === rootParentId) { skippedPinned++; continue; }
      if (existingUrls.has(normalizeUrl(bm.url))) {
        // 预览容器里已经有这个网址（正常情况下这里只会是上面清理失败的残留）。
        // 不重复复制，但**仍要计入清单**——副本已经存在，删掉这个原书签不会丢内容。
        // 注：开启自动去重时，「同一轮里出现的重复书签」也是走这条路合并掉的。
        copiedSourceIds.push(bm.id);
        continue;
      }
      const catId = currentClass[bm.id] || getFallbackCategory().id;
      if (!getCategoryById(catId)) { failed++; continue; }
      pending.push({ bm, catId, subLabel: subLabelOf(bm, cfg), subSubLabel: subSubLabelOf(bm, cfg) });
    }

    // ---- 逐层收敛：决定每个书签最终落在哪一层 ----
    // 规则（每一层统一套用）：
    //   ① 子文件夹至少 minItems 个书签，否则不建（归类过碎，书签上浮到父文件夹）；
    //   ② 每层都要有直接可点的书签——若全被分进子文件夹，就解散书签数最少的那一个；
    //   ③ 每层最多 maxSubs 个子文件夹，超出上限的标签按语义并入最相近的已选标签；
    //   ④ 分类内书签少于 minSubSize 时整个分类不做细分（二级、三级一并取消）。
    const minItems = Math.max(1, parseInt(cfg.minSubFolderItems, 10) || 1);
    const thirdLevel = cfg.method === "ai" && !!cfg.enableThirdLevel;
    const byCat = new Map(); // catId -> pending 下标数组
    pending.forEach((p, i) => {
      if (!byCat.has(p.catId)) byCat.set(p.catId, []);
      byCat.get(p.catId).push(i);
    });
    let mergedSubs = 0, aloneSubs = 0, droppedSubs = 0, dissolvedSubs = 0, skippedSubCats = 0;
    let keptStructSubs = 0; // 因「本层子文件夹本来就 ≤ SUBS_KEEP_MIN 个」而未解散、保留结构的分类数
    let groupedSubs = 0; // 被合并掉的同义标签数（如「代码托管平台」并入「代码托管」）
    let merged3 = 0, dropped3 = 0, dissolved3 = 0;

    // 第一层细分：分类文件夹 -> 二级标签文件夹
    for (const [catId, idxs] of byCat) {
      if (minSubSize > 1 && idxs.length < minSubSize) {
        for (const i of idxs) { pending[i].subLabel = ""; pending[i].subSubLabel = ""; }
        skippedSubCats++;
        continue;
      }
      const r = planLayer(idxs.map((i) => ({ label: pending[i].subLabel })), minItems, maxSubs);
      idxs.forEach((pi, k) => {
        pending[pi].subLabel = r.assign[k];
        if (!r.assign[k]) pending[pi].subSubLabel = ""; // 上浮到分类文件夹的条目不再做三级细分
      });
      mergedSubs += r.merged;
      aloneSubs += r.alone;
      droppedSubs += r.dropped;
      dissolvedSubs += r.dissolved;
      keptStructSubs += r.kept;
      groupedSubs += r.grouped;
    }

    // 第二层细分（可选）：二级标签文件夹 -> 三级标签文件夹，规则完全一致
    if (thirdLevel && maxSubs > 0) {
      const groups3 = new Map(); // `catId\u0001二级标签` -> pending 下标数组
      pending.forEach((p, i) => {
        if (!p.subLabel) return;
        const key = p.catId + "\u0001" + p.subLabel;
        if (!groups3.has(key)) groups3.set(key, []);
        groups3.get(key).push(i);
      });
      for (const idxs of groups3.values()) {
        const r = planLayer(idxs.map((i) => ({ label: pending[i].subSubLabel })), minItems, maxSubs);
        idxs.forEach((pi, k) => { pending[pi].subSubLabel = r.assign[k]; });
        merged3 += r.merged;
        dropped3 += r.dropped;
        dissolved3 += r.dissolved;
      }
    } else {
      for (const p of pending) p.subSubLabel = "";
    }

    // ---- 高频书签：强制平铺在所属分类的一级目录 ----
    // 必须放在「逐层收敛」**之后**：planLayer 会重新赋值 subLabel，先设会被它覆盖掉。
    // 语义：最常用的入口不该被塞进二级文件夹里多点一层，直接摆在一级目录上。
    // 副作用是好的——顺带让「每层都要有直接书签」这条规则更容易满足。
    let freqFlattened = 0;
    if (currentFreq.size) {
      for (const p of pending) {
        if (!currentFreq.has(p.bm.id)) continue;
        if (p.subLabel || p.subSubLabel) freqFlattened++;
        p.subLabel = "";
        p.subSubLabel = "";
      }
    }

    const subFolderCache = {}; // `${parentId}\u0001${label}` -> folderId，避免重复查/建
    // 取/建子文件夹（带缓存）；失败返回 null，由调用方计入失败数
    const ensureSubFolder = async (parentId, label) => {
      const key = parentId + "\u0001" + label;
      if (subFolderCache[key]) return subFolderCache[key];
      let f = await findFolder(parentId, label);
      if (!f) {
        const created = await createFolder(parentId, label);
        if (created.error) { log(`创建子文件夹「${label}」失败：${created.error}`, "err"); return null; }
        f = { id: created.id };
      }
      subFolderCache[key] = f.id;
      return f.id;
    };
    const addedAt = {}; // 新书签 id -> 原书签加入时间（复制出的新书签 dateAdded 全同，排序必须用原时间）
    const addedRank = new Map(); // 新书签 id -> 原书签的使用频率得分（同级直接书签按它降序排）
    // 用 Map 而不是普通对象：与 js/frequency.js 的 buildFreqScores 保持同一种容器，
    // 免得两边一个 Map 一个对象、取值方式不匹配还静默不报错（orderChildren 已做兼容兜底）

    // ---- 第二遍：真正复制 ----
    // total 用 max(1, …) 兜底：pending 为空时 showProgress 会退回「总量未知」，
    // 会让这一权重最大的阶段显示成条纹而不是推进到本阶段终点，看着像卡住。
    const copyTotal = Math.max(1, pending.length);
    for (let i = 0; i < pending.length; i++) {
      const { bm, catId, subLabel, subSubLabel } = pending[i];
      if (i === 0) useStage("copy");
      showProgress(`生成预览中… ${i + 1}/${pending.length}（已复制 ${copied}）`, i + 1, copyTotal);
      const parentFolderId = await ensureCatFolder(catId);
      if (!parentFolderId) { failed++; continue; }
      // 标签已在「逐层收敛」阶段算好最终值（含超限归并、上浮），这里只按图纸建夹
      let dest = parentFolderId;
      if (subLabel) {
        const d2 = await ensureSubFolder(dest, subLabel);
        if (!d2) { failed++; continue; }
        dest = d2;
        if (subSubLabel) {
          const d3 = await ensureSubFolder(dest, subSubLabel);
          if (!d3) { failed++; continue; }
          dest = d3;
        }
      }
      const r = await createBookmark(dest, bm.title, bm.url);
      if (r.error) {
        failed++;
        if (failed <= 5) log(`复制失败：${bm.title} → ${r.error}`, "err");
        continue;
      }
      if (r.id) {
        addedAt[r.id] = bm.dateAdded || 0;
        // 得分按「原书签 id」取，映射到复制出来的新 id 上——新书签的 id 是另一个值
        addedRank.set(r.id, currentFreqScores.has(bm.id) ? currentFreqScores.get(bm.id) : 0);
      }
      copiedSourceIds.push(bm.id);
      // 登记已复制 —— 同一轮的第二个重复由此合并掉（不再复制第二份）。
      // ⚠ 关闭自动去重时不登记：同一个网址有几份就复制几份，这是用户在设置里明确选的。
      if (dedupeOn) existingUrls.add(normalizeUrl(bm.url));
      copied++;
    }

    // ---- 清理容器内遗留的空文件夹（本次按需建夹后不会新增，但上次生成的空壳要清掉）----
    useStage("prune");
    const prunedEmpty = await pruneEmptyInPreview(targetId, (d, t) =>
      showProgress(`清理空文件夹… ${d}/${t}`, d, t)
    );

    // 一个书签都没复制进来时，容器此刻就是空的（书签全在预览内、或全被跳过）——
    // 把容器本身也删掉，别在书签栏上留一个空的「智能书签」。用户看到的"生成很多空文件夹"里，
    // 这一条是最典型的：点一次生成预览、中途什么也没复制成功，就在根目录留一个空壳。
    if (!copied && !(await getChildren(targetId)).length) {
      await removeTree(targetId);
      previewTargetId = null;
      completed = true;
      log("没有可整理的书签，预览文件夹已清理（未留下空文件夹）。请检查筛选条件与分类设置。", "warn");
      return;
    }

    // ---- 第三遍：规范化目录顺序（子文件夹置顶 + 直接书签按使用频率降序）----
    // 覆盖预览结构的所有层：根 → 各分类文件夹 → 各二级子文件夹 → 各三级子文件夹
    const sortDirs = [
      targetId,
      ...Object.values(catFolderIds),
      ...Object.values(subFolderCache)
    ].filter((v, i, arr) => v && arr.indexOf(v) === i); // 去重
    let reordered = 0;
    for (let i = 0; i < sortDirs.length; i++) {
      if (i === 0) useStage("sort");
      showProgress(`整理目录顺序中… ${i + 1}/${sortDirs.length}`, i + 1, sortDirs.length);
      reordered += await normalizeFolderOrder(sortDirs[i], addedAt, addedRank);
    }

    useStage("save");
    // 指纹必须按**复制完成后**的预览现状来算（此刻容器里躺着的就是最终要提升的那批副本），
    // 用中途的 existingUrls 会漏掉「同 URL 已存在而被跳过复制」的那部分。
    await savePreviewSource(targetId, copiedSourceIds, organizeRoot);
    completed = true; // 走到这里实质工作已完成，剩下只是写日志与刷新统计

    log(
      `预览已生成：共复制 ${copied} 个书签到「${cfg.targetFolderName}」${failed ? `，失败 ${failed} 个` : ""}` +
      `${cleaned ? `，已重建（清理上一次的预览内容 ${cleaned} 项）` : ""}` +
      `${organizeRoot
        ? `，根目录上平铺的书签 ${rootCount} 个已一并纳入整理`
        : skippedPinned
        ? `，跳过根目录书签 ${skippedPinned} 个（按设置保持原位）`
        : ""}；` +
      `分类文件夹 ${Object.keys(catFolderIds).length} 个（只建有书签的分类，无空文件夹）` +
      (freqFlattened ? `，高频书签 ${freqFlattened} 个已平铺在分类一级目录` : "") +
      (prunedEmpty ? `，另清理上次遗留的空文件夹 ${prunedEmpty} 个` : "") + "。" +
      (maxSubs > 0
        ? `二级细分：每个分类下最多 ${maxSubs} 个子文件夹` +
          (minSubSize > 1 ? `、书签少于 ${minSubSize} 个的分类不细分` : "") +
          (skippedSubCats ? `（${skippedSubCats} 个分类书签不足，已直接平铺）` : "") +
          (groupedSubs ? `，${groupedSubs} 个同义标签已合并（如「代码托管平台」并入「代码托管」，同义标签不再各占一个名额）` : "") +
          (droppedSubs ? `，${droppedSubs} 个书签数不足 ${minItems} 的标签未独立成夹` : "") +
          (mergedSubs ? `，${mergedSubs} 个标签已按语义并入相近标签（子文件夹数仍 ≤ ${maxSubs}）` : "") +
          (aloneSubs ? `，${aloneSubs} 个标签与已选标签无相似度、其书签已平铺在分类文件夹本级（未归类的书签会一眼可见，可直接在弹窗里手动调整）` : "") +
          (keptStructSubs ? `，${keptStructSubs} 个分类保留了子文件夹结构（子文件夹本就只有 1~${SUBS_KEEP_MIN} 个，解散只会把书签推回一级）` : "") +
          (dissolvedSubs ? `，${dissolvedSubs} 个分类原本全是子文件夹、已解散最小的一个以保留直接书签` : "") + "。"
        : `未做二级细分（上限为 0）。`) +
      (thirdLevel && maxSubs > 0
        ? `三级细分：已开启` +
          (dropped3 ? `，${dropped3} 个书签数不足 ${minItems} 的三级标签已上浮` : "") +
          (merged3 ? `，${merged3} 个超限三级标签已按语义并入相近标签` : "") +
          (dissolved3 ? `，${dissolved3} 个二级文件夹原本全是三级文件夹、已解散最小的一个` : "") + "。"
        : "") +
      `顺序整理：${sortDirs.length} 个目录已规范化（子文件夹置顶，直接书签按使用频率降序）` +
      (reordered ? `，共调整 ${reordered} 项。` : "（原本即符合）。") +
      `检查无误后点击「执行整理」删除原书签。`,
      failed ? "warn" : "ok"
    );
  } catch (e) {
    log("生成预览出错：" + (e && e.message ? e.message : e), "err");
  } finally {
    // 必须收尾：成功补到 100% 再收起，中断/报错则直接收起（不假装完成）
    if (completed) endProgress(600);
    else abortProgress();
    await endStep();
    await refreshStats();
  }
}

// 阶段二：执行整理——删除「预览阶段复制过」的原书签，预览文件夹的分类结果即为最终结果
// force = 按住 Shift 点击：即使有删除失败也继续目录提升（会残留删不掉的原书签，慎用）
// ---- 执行整理前的确认面板 ----
// 删书签不可逆，所以最后一步必须是「用户看得见地同意」。
// 三条清单一起摊开：能删的 / 会留下的 / 预览里来历不明的。
// ⚠ 只展示、不拦截：发现异常就在面板里标红说明后果，由用户决定继续还是回去重生成预览。
//   （此前版本的做法是「发现预览被动过就拒绝执行」，用户只知道被拦了、不知道哪里不对。）
function confirmOrganize(info) {
  const { toDelete, pinnedItems, lostItems, orphanCopies, rootLabel } = info;
  const panel = $("confirmPanel");
  const rows = [];
  const row = (cls, text) => rows.push(`<div class="cf-row ${cls}"><span class="cf-n">${text}</span></div>`);

  row("del", `将删除 <b>${toDelete.length}</b> 条原书签（副本已在预览里）`);
  if (pinnedItems.length) {
    row("keep", `保留 ${pinnedItems.length} 条：现在钉在${rootLabel}根目录，视为常用入口`);
  }
  // 这条是最该被看见的：原件不会被删、而预览/别处已有副本 → 整理完同一书签会变两份。
  if (lostItems.length) {
    row("risk", `${lostItems.length} 条在预览里找不到副本，<b>不会被删</b> —— 整理后可能与副本同时存在（变两份）`);
  }
  if (orphanCopies.length) {
    row("keep", `预览里另有 ${orphanCopies.length} 条找不到来源（你手动放进去的），会原样保留`);
  }

  $("confirmBody").innerHTML = rows.join("");
  // 清单本身：只列将被删除的，最多 60 条，超出折叠成一行计数（几百条全列出来没人看）
  const names = toDelete.slice(0, 60).map((it) => escapeHtml(it.title || it.url || it.id));
  const more = toDelete.length > 60 ? `<div class="cf-more">…还有 ${toDelete.length - 60} 条</div>` : "";
  $("confirmList").innerHTML = names.map((n) => `<div class="cf-item">${n}</div>`).join("") + more;
  $("confirmOk").textContent = `确认删除 ${toDelete.length} 条`;
  panel.hidden = false;
  $("confirmOk").focus();

  return new Promise((resolve) => {
    const done = (v) => {
      panel.hidden = true;
      $("confirmOk").removeEventListener("click", onOk);
      $("confirmCancel").removeEventListener("click", onCancel);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    $("confirmOk").addEventListener("click", onOk);
    $("confirmCancel").addEventListener("click", onCancel);
  });
}

async function organize(force) {
  const cfg = await getConfig();
  const rootLabel = rootLabelOf(cfg.targetParentId);
  beginStep("organize"); // 点亮「执行整理」（同时锁住其它动作按钮）
  let completed = false;
  // 阶段权重：删除原书签是绝对大头（几十上百次 bookmarks.remove，串行且每次都要查 lastError），
  // 目录提升其次，空夹清理与落快照都很快。权重给足差距，进度条才不会"删到一半看着像跑完"。
  beginProgress([
    { id: "prepare", label: "读取分类结果…", weight: 8, unknown: true },
    { id: "delete", label: "执行整理中…", weight: 62 },
    { id: "promote", label: "提升分类文件夹到根目录…", weight: 18 },
    { id: "cleanup", label: "清理空文件夹…", weight: 12 }
  ]);
  try {
    useStage("prepare");
    await ensureClassified(cfg);

    // 删除动作的安全前提：预览目录必须**真实存在且非空**。
    // 否则（例如用户手动清空了预览文件夹，却又点「执行整理」，而 storage 里还留着旧的源 id 记录）
    // 会把原书签删掉却没有副本留存，造成不可逆的数据丢失。
    // 注意这里用 resolvePreviewFolderId（只查不建），绝不在执行阶段凭空创建文件夹。
    const targetId = previewTargetId || await resolvePreviewFolderId(cfg);
    if (!targetId) {
      log(`未找到预览文件夹「${cfg.targetFolderName}」。请先点击「生成预览」并确认分类结果无误，再执行整理。`, "err");
      return;
    }
    if (!(await getChildren(targetId)).length) {
      log(`预览文件夹「${cfg.targetFolderName}」是空的，已拒绝执行（否则会删掉原书签却没有副本留存）。请重新点击「生成预览」。`, "err");
      return;
    }

    // 读取预览阶段记录的原书签源 id（精确删除，绝不删未参与整理的书签）
    const src = await loadPreviewSource();
    const srcIds = new Set(src && src.ids ? src.ids : []);
    if (!srcIds.size) {
      log("尚未生成预览或没有可删除的原书签。请先点击「生成预览」。", "warn");
      return;
    }
    // 根目录是否参与整理，可能与生成预览时不同——必须先卡住。
    // 典型场景：预览时根目录不参与（根目录书签根本没进清单），之后改成参与，
    // 然后点执行：清单里一个根目录书签都没有，插件「成功」跑完却什么都没删，
    // 用户以为整理过了、实际根目录原样不动。与其静默跑一遍，不如直接要求重新生成预览。
    const organizeRoot = !!cfg.organizeRootItems;
    const protectRoot = !organizeRoot; // 根目录参与整理时，就不再有「钉在根上所以不删」这条
    if (src && typeof src.organizeRoot === "boolean" && src.organizeRoot !== organizeRoot) {
      log(
        `当前设置为「根目录书签${organizeRoot ? "参与" : "不参与"}整理」，` +
        `而现有预览是按「${src.organizeRoot ? "参与" : "不参与"}」生成的，删除范围对不上。` +
        `请先重新点「生成预览」，再执行整理。`,
        "err"
      );
      return;
    }

    // ---- 执行前复检（关键）----
    // 预览生成 → 点执行，中间用户可以任意增删 / 移动 / 钉根目录书签，而清单只记 id，
    // 不记「它现在在哪」「预览里那份副本还在不在」，所以必须按**当前现状**再核对一轮。
    // 判定逻辑抽在 selectDeletable（纯函数，有回归测试）；两条都属「安全侧失败」。
    const rootParentId = await resolveTargetParentId(cfg.targetParentId);
    const items = await allBookmarks();
    const candidates = items.filter((it) => srcIds.has(it.id));
    if (!candidates.length) {
      log(`预览记录的 ${srcIds.size} 个原书签在当前书签树中都已不存在（可能已执行过整理，或期间被手动删过）。`, "warn");
      return;
    }
    if (srcIds.size !== candidates.length) {
      log(`预览共记录原书签 ${srcIds.size} 个，其中 ${candidates.length} 个仍在书签树中，${srcIds.size - candidates.length} 个已不存在（自动跳过，不算失败）。`, "warn");
    }

    // 预览子树现状：一次取出，既用于「副本是否还在」的比对，也用于反查遗留副本
    const previewFlat = [];
    const previewSubtree = await new Promise((r) => {
      chrome.bookmarks.getSubTree(targetId, (n) => {
        const err = chrome.runtime.lastError;
        r(err || !n ? [] : n);
      });
    });
    if (previewSubtree.length) flattenBookmarks(previewSubtree, [], [], previewFlat);

    // 记下预览容器里的所有文件夹 id（= 本轮会提升到根目录的那些分类夹/子夹）。
    // 下次生成预览时据此回收"已经变空"的空壳，见 reclaimEmptyOutputFolders。
    const previewFolderIds = await collectFolderIds(targetId);
    const previewUrlSet = new Set(
      previewFlat.map((p) => normalizeUrl(p.url || "")).filter(Boolean)
    );

    const { toDelete, pinnedItems, lostItems } = selectDeletable(
      candidates, rootParentId, previewUrlSet, normalizeUrl, protectRoot
    );
    // 反向检查：预览里有、但当前书签树中找不到同 URL 来源的书签（手动放进去的，或原件已被删）。
    // 它们会被「提升」进最终结构。只提示、不自动删：分不清是"用户要留的"还是"遗留副本"。
    const srcUrlSet = new Set(candidates.map((it) => normalizeUrl(it.url || "")));
    const orphanCopies = previewFlat.filter((p) => p.url && !srcUrlSet.has(normalizeUrl(p.url)));

    if (!toDelete.length) {
      log(
        `没有可删除的原书签（清单命中 ${candidates.length} 个：` +
        (protectRoot ? `其中 ${pinnedItems.length} 个已钉在${rootLabel}根目录、` : "") +
        `${lostItems.length} 个在预览中找不到副本）。本次未执行。`,
        "err"
      );
      return;
    }

    // ---- 执行前把「要删什么、会留下什么」摊开给用户看，由他拍板 ----
    // 这里不替用户做决定。预览被手工改过、有钉根目录的、有找不到副本的 ——
    //   一律列出来让他自己判断是继续还是回去重生成。拦下来却不说明哪里不对，等于逼他猜。
    const go = await confirmOrganize({
      toDelete, pinnedItems, lostItems, orphanCopies,
      folderName: cfg.targetFolderName, rootLabel
    });
    if (!go) {
      log("已取消，未做任何改动。", "warn");
      return;
    }

    // 删除前保存撤销快照：记录每个待删书签的完整信息与顺序以便还原

    // 按 parentId 分组，逐个读取真实 index（flatten 结果不含 index）
    const byParent = new Map();
    for (const it of toDelete) {
      if (!byParent.has(it.parentId)) byParent.set(it.parentId, []);
      byParent.get(it.parentId).push(it);
    }
    const snapshot = [];
    for (const [pid, itemsOfParent] of byParent.entries()) {
      const children = await getChildren(pid);
      for (const it of itemsOfParent) {
        const idx = children.findIndex((c) => c.id === it.id);
        snapshot.push({
          id: it.id, title: it.title, url: it.url,
          parentId: it.parentId, index: idx >= 0 ? idx : 0
        });
      }
    }
    // 稳定排序：按 index 升序删除（避免顺序影响）
    snapshot.sort((a, b) => (a.index || 0) - (b.index || 0));

    let removed = 0;
    let failed = 0;
    const failReasons = new Map(); // 失败原因 -> 次数
    // 只记录「真正删掉」的条目：否则撤销会把没删成功的书签再创建一遍，凭空多出重复书签
    const removedItems = [];
    useStage("delete");
    const delTotal = Math.max(1, snapshot.length);
    showProgress(`执行整理中… 0/${snapshot.length}`, 0, delTotal);
    for (let i = 0; i < snapshot.length; i++) {
      const it = snapshot[i];
      const r = await removeBookmark(it.id);
      if (r.ok) { removed++; removedItems.push(it); }
      else {
        failed++;
        const reason = r.error || "未知原因";
        failReasons.set(reason, (failReasons.get(reason) || 0) + 1);
        if (failed <= 5) log(`删除失败：${it.title} → ${reason}`, "err");
      }
      showProgress(`执行整理中… ${i + 1}/${snapshot.length}（已删除 ${removed}）`, i + 1, delTotal);
    }

    // 失败原因汇总：让「删除失败」不再是无信息的黑盒
    if (failed) {
      const tops = [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      log("失败原因汇总：" + tops.map(([r, n]) => `${r}（${n} 个）`).join("；"), "err");
      const allMsg = [...failReasons.keys()].join(" ");
      if (/managed/i.test(allMsg)) {
        log("提示：失败原因含 managed bookmarks——这类书签由企业策略下发，浏览器禁止任何扩展修改或删除（chrome://policy 可查），插件无法绕过。", "err");
      } else if (/Can't find bookmark/i.test(allMsg)) {
        log("提示：报「找不到书签」说明这些 id 已不在书签树中（多为重复执行整理、或期间手动删过）。", "warn");
      }
    }

    // ---- 有删除失败则中止后续目录提升 ----
    // 否则「没删掉的原书签」与「提升上来的分类副本」会同时存在，结构错乱且难以人工恢复。
    // 保留预览文件夹，用户处理完失败原因后重新点「执行整理」即可（已删掉的下次自动跳过）。
    // 例外：受管书签等「永远删不掉」的情况，允许用户按住 Shift 强制完成。
    if (failed && !force) {
      if (removedItems.length) {
        await pushUndo({
          ts: Date.now(),
          kind: "delete",
          targetId,
          targetFolderName: cfg.targetFolderName,
          snapshot: removedItems,
          moves: [],
          removedFolders: []
        });
      }
      log(
        `已删除 ${removed} 个，失败 ${failed} 个。为避免结构错乱，本次未执行目录提升与空目录清理，预览文件夹保持不变。` +
        `请按上面的失败原因处理后重新点击「执行整理」重试；若确认要跳过这些删不掉的书签并强制完成整理，请按住 Shift 再点一次「执行整理」。`,
        "warn"
      );
      return;
    }

    // ---- ③ 把预览容器下的分类文件夹提升到目标根目录（同名则合并）----
    useStage("promote");
    const promote = await promotePreviewChildren(cfg, targetId, (d, t) =>
      showProgress(`提升分类文件夹到根目录… ${d}/${t}`, d, t)
    );

    // ---- ④ 清理因本次整理而变空的文件夹（含已空的预览容器）----
    useStage("cleanup");
    const removedFolders = await cleanupEmptyFolders([
      ...byParent.keys(), // 被删书签的原父目录
      targetId, // 预览容器（分类文件夹提升后已空）
      ...promote.moves.map((m) => m.fromParentId), // 被合并的源文件夹
      ...(promote.emptied || []) // 合并后自己变空的源文件夹
    ], (d, t) => showProgress(`清理空文件夹… ${d}/${t}`, d, t));

    // 存下本轮产出的文件夹 id：下次生成预览时，这些夹子如果已经空了就回收，
    // 不让它们在书签栏上长期当空壳（"生成很多空文件夹"最常见的来源）。
    await saveOutputFolderIds(previewFolderIds);

    // ---- ⑤ 落撤销快照（书签 + 移动 + 被删文件夹，全部可逆）----
    if (removedItems.length || promote.moves.length || removedFolders.length) {
      await pushUndo({
        ts: Date.now(),
        kind: "delete",
        targetId,
        targetFolderName: cfg.targetFolderName,
        snapshot: removedItems,
        moves: promote.moves,
        removedFolders
      });
    }

    // 结果已落地为最终结构，预览源映射不再需要
    await clearPreviewSource();
    completed = true; // 只有走到这里才算「整理真的完成」；前面任何一处提前 return 都算中断

    log(
      `执行完成：已删除 ${removed} 个原书签` +
      (failed ? `（强制跳过 ${failed} 个删不掉的书签，它们仍留在原位，需手动处理）` : "") + "；" +
      `已提升 ${promote.promoted} 个分类文件夹到「${rootLabel}」` +
      (promote.merged ? `，其中 ${promote.merged} 个与已有同名文件夹合并` : "") +
      (removedFolders.length ? `；清理空文件夹 ${removedFolders.length} 个` : "") +
      `。可点击「撤销」完整还原。`,
      failed ? "warn" : "ok"
    );
  } catch (e) {
    log("执行出错：" + (e && e.message ? e.message : e), "err");
  } finally {
    // 这里就是「执行完成后进度条还在动」的修复点：原来 organize 从头到尾没有收尾调用，
    // 最后一句是 showProgress("清理空文件夹…") 的不确定进度，条纹会一直流动下去。
    if (completed) endProgress(600);
    else abortProgress();
    await endStep();
    await refreshStats();
  }
}

// 撤销最近一次操作：支持两种历史——旧的 move 型（移动），新的 delete 型（删除）
// 这里只负责「起止」，具体回滚逻辑在 undoApply —— 好让 finally 一定跑到，
// 否则中途抛错时进度条会一直停在半路。
async function undo() {
  const stack = await loadUndoStack();
  if (!stack.length) {
    log("没有可撤销的操作。", "err");
    await refreshUndoButton();
    return;
  }
  // "undo" 不在 STEP_IDS 里：它没有自己的高亮按钮，但同样要锁住其它动作按钮
  // （撤销做到一半去点「执行整理」会把回滚事务彻底搞乱）。它自己的可用性仍由 refreshUndoButton 决定。
  beginStep("undo");
  let completed = false;
  try {
    completed = await undoApply(stack);
  } catch (e) {
    log("撤销出错：" + (e && e.message ? e.message : e), "err");
  } finally {
    if (completed) endProgress(600);
    else abortProgress();
    await endStep();
    await refreshStats();
  }
}

// 真正执行撤销。返回 true = 完整回滚成功（决定进度条收尾是「完成」还是「中断」）。
async function undoApply(stack) {
  const entry = stack.pop();
  await new Promise((r) => chrome.storage.local.set({ [UNDO_KEY]: stack }, r));

  let restored = 0;

  // 新流程：delete 型——完整回滚「执行整理」的全部动作。
  // 顺序必须是：① 重建被删的文件夹（浅→深）→ ② 重建被删的书签 → ③ 把提升/合并走的节点移回容器。
  // 被删文件夹重建后 id 会变，所以用 idMap 建立「旧 id → 新 id」映射，后续所有 parentId 都要过一遍。
  if (entry.kind === "delete" && entry.snapshot) {
    const idMap = new Map();
    const resolveId = (id) => idMap.get(id) || id;
    const removedFolders = (entry.removedFolders || []).slice().reverse(); // 原顺序是「深→浅」，逆序成「浅→深」
    const moves = (entry.moves || []).slice().reverse();
    const total = removedFolders.length + entry.snapshot.length + moves.length;
    let done = 0;
    const step = (extra) =>
      showProgress(`撤销中… ${done}/${total}${extra ? `（${extra}）` : ""}`, done, total);

    // ① 重建被删的空文件夹
    let rebuiltFolders = 0;
    step();
    for (const f of removedFolders) {
      const parentId = resolveId(f.parentId);
      if (await getBookmark(parentId)) {
        const r = await createFolder(parentId, f.title);
        if (r.id) { idMap.set(f.id, r.id); rebuiltFolders++; }
      }
      done++;
      step(`已重建目录 ${rebuiltFolders}`);
    }

    // ② 重建被删的书签
    const snapshot = entry.snapshot.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const it of snapshot) {
      const parentId = resolveId(it.parentId);
      if (await getBookmark(parentId)) {
        const r = await createBookmark(parentId, it.title, it.url);
        if (r.id) restored++;
      }
      done++;
      step(`已还原书签 ${restored}`);
    }

    // ③ 把提升到根目录 / 合并进同名文件夹的节点移回容器
    let movedBack = 0;
    for (const mv of moves) {
      const from = resolveId(mv.fromParentId);
      const node = await getBookmark(mv.id);
      if (node && (await getBookmark(from))) {
        const r = await moveBookmark(mv.id, from);
        if (r.ok) movedBack++;
      }
      done++;
      step(`已移回 ${movedBack}`);
    }

    log(
      `已撤销：还原 ${restored} 个书签、重建 ${rebuiltFolders} 个文件夹、移回 ${movedBack} 个目录项。`,
      "ok"
    );
    return true;
  }

  // 旧流程：move 型——把移动的书签移回原位置，并清理已空目录
  const moves = (entry.moves || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  const folders = (entry.createdFolders || []).filter((id) => id !== entry.targetId);
  // 总步数把「移回书签」和「清理空夹」都算进去，否则清理阶段进度条会僵在 100% 不动
  const oldTotal = Math.max(1, moves.length + folders.length + (entry.targetId ? 1 : 0));
  showProgress(`撤销中… 0/${oldTotal}`, 0, oldTotal);
  let mi = 0;
  for (const mv of moves) {
    const node = await getBookmark(mv.id);
    if (!node) continue; // 该书签已被删除，跳过
    const parent = await getBookmark(mv.parentId);
    if (!parent) continue; // 原父目录已不存在，跳过
    const r = await new Promise((resolve) => {
      chrome.bookmarks.move(mv.id, { parentId: mv.parentId, index: mv.index }, (n) => {
        const err = chrome.runtime.lastError;
        resolve({ ok: !err, error: err && err.message });
      });
    });
    if (r.ok) restored++;
    showProgress(`撤销中… ${++mi}/${oldTotal}（已还原 ${restored}）`, mi, oldTotal);
  }

  // 清理整理时创建的、现已为空的文件夹（从深层到浅层）
  folders.reverse();
  for (const fid of folders) {
    const children = await getChildren(fid);
    if (children.length === 0) {
      await removeTree(fid);
    }
    showProgress(`撤销中… ${++mi}/${oldTotal}（已还原 ${restored}）`, mi, oldTotal);
  }
  // 若目标文件夹已空，也一并清理
  if (entry.targetId) {
    const tchildren = await getChildren(entry.targetId);
    if (tchildren.length === 0) {
      await removeTree(entry.targetId);
    }
    showProgress(`撤销中… ${++mi}/${oldTotal}（已还原 ${restored}）`, mi, oldTotal);
  }

  log(`已撤销：恢复 ${restored} 个书签到原位置。`, "ok");
  return true;
}

// 自动去重（scan 的默认步骤）：同一归一化 URL 只保留「最早添加」的一份，其余删除。
// 返回 { removedIds: Set<被删书签id>, snapshot: 撤销快照 }；一条都没删时 snapshot 为 null。
// 删除必须记撤销 —— 这一步现在是扫描流程的一部分，用户点「扫描分类」时并没有
// 「我要删书签」的心理预期，不给撤销等于替他做不可逆的决定。
async function autoDedupe(items, cfg) {
  const dups = findDuplicates(items);
  const removedIds = new Set();
  const snapshot = [];
  const total = Math.max(1, dups.length);
  let gi = 0;
  for (const d of dups) {
    const sorted = d.items.slice().sort((a, b) => a.dateAdded - b.dateAdded);
    for (let i = 1; i < sorted.length; i++) {
      const dup = sorted[i];
      const r = await new Promise((resolve) => {
        chrome.bookmarks.remove(dup.id, () => {
          const err = chrome.runtime.lastError;
          resolve(!err);
        });
      });
      if (r) {
        removedIds.add(dup.id);
        snapshot.push({ id: dup.id, title: dup.title, url: dup.url, parentId: dup.parentId, index: dup.index });
      }
    }
    showProgress(`清理重复书签… ${++gi}/${total}`, gi, total);
  }
  if (removedIds.size) {
    await pushUndo({
      ts: Date.now(),
      kind: "delete", // 与执行整理共用同一条撤销路径：只需重建被删书签，无目录移动
      snapshot,
      moves: [],
      removedFolders: []
    });
  }
  return { removedIds, snapshot: removedIds.size ? snapshot : null };
}

// 一键让「根目录上平铺的书签」参与整理。
// 只写这一个键 —— 绝不把 getConfig() 的合并结果整体写回 sync，那会把兜底配置一并固化，
// 也会把 apiKey 混进云同步（apiKey 只允许存在 storage.local）。
$("rootEnable").addEventListener("click", async () => {
  const err = await new Promise((r) =>
    chrome.storage.sync.set({ organizeRootItems: true }, () => r(chrome.runtime.lastError))
  );
  if (err) {
    log("开启失败：" + (err.message || err) + "。可到设置页手动勾选「根目录上平铺的书签也参与整理」。", "err");
    return;
  }
  $("rootBar").hidden = true;
  log(
    "已开启「根目录书签参与整理」。请重新点「生成预览」—— 这批书签会与其它书签一起被分类复制，" +
      "确认预览无误后再执行整理。",
    "ok"
  );
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btnScan").addEventListener("click", (e) => scan(e.shiftKey)); // 按住 Shift 点击 = 强制重新分类
$("btnPreview").addEventListener("click", buildPreview);
$("btnOrganize").addEventListener("click", (e) => organize(e.shiftKey)); // 按住 Shift = 有删除失败也强制完成
$("btnUndo").addEventListener("click", undo);
$("search").addEventListener("input", renderTweak);
$("clearFreq").addEventListener("click", async () => {
  await clearFreqManual();
  currentFreq = new Set(currentFreqAuto); // 抹掉手动叠加，回到纯自动判定
  if (currentFreqMeta) currentFreqMeta.manual = { on: {}, off: {} };
  renderTweak();
  renderFreqInfo();
  log("已清除全部手动星标（自动判定不受影响）。", "ok");
});

// 按需申请「浏览记录」权限（history 是可选权限，只在这里和设置页申请）。
// ⚠ 必须在真实点击的处理函数里调用——不在用户手势里 Chrome 不弹框、直接返回 false，
//    表现上像「用户拒绝了」，很容易误判。
$("freqPerm").addEventListener("click", async () => {
  const granted = await requestHistoryPermission();
  if (!granted) {
    log("未授权「浏览记录」——无法自动识别常用书签。仍可在上方列表里点行首的 ☆ 手动标记。", "warn");
    return;
  }
  log("已获得「浏览记录」权限，正在重新计算高频书签…", "ok");
  await computeFrequent(await getConfig());
  renderTweak();
  const n = currentFreq.size;
  if (n) {
    log(
      `高频书签 ${n} 个（自动 ${currentFreqAuto.size}）。重新点「生成预览」即可按新的高频结果平铺到分类一级目录。`,
      "ok"
    );
  } else {
    log(`未选出高频书签：${currentFreqMeta ? currentFreqMeta.reason : "未知原因"}。`, "warn");
  }
});

$("clearOverrides").addEventListener("click", async () => {
  await clearAllOverrides();
  log("已清除全部手动调整。", "ok");
  await scan();
});

// 打开弹窗：只做「只读」的初始化，**绝不自动分类**。
// 为什么改成这样（作者要求，2026-09-28）：点开弹窗就直接跑 AI，等于插件一打开就开始花钱、
//   而且用户根本没确认过这一步——他要的可能只是看一眼统计，或者先去设置页改个配置。
//   更糟的是它还会掩盖问题：上一轮生成的预览还在，AI 又重新分了一遍类，两份结果混在一起，
//   用户以为看到的是「自己调过的那份」，实际已经不是了。
// 所以这里只读书签树、更新统计与按钮状态；真正的第一步（扫描分类）交给用户点。
(async function init() {
  await refreshActiveCategories();
  updateActionState(); // 先按初始状态点亮「扫描分类」，别让按钮在 await 期间四个全灰
  await refreshStats(); // 只读：统计数字 / 撤销栈 / 预览是否就绪，不分类、不调 AI
  log("点「扫描分类」开始。书签没变化时会直接复用上次结果，不会重复调用 AI。");
})();
