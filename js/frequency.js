// 高频书签判定：用浏览器访问历史给书签打分，选出「真正在用」的那几个。
//
// 用途：这些书签在生成预览时被强制平铺在所属分类的一级目录（不进二级子文件夹），
//       保证每个分类里最先看到、最容易点到的是常用入口，
//       而不是「AI 归不进任何二级标签所以被兜底上浮」的那种书签。
//
// 为什么非要 history 权限：Chrome 的书签 API 只给 dateAdded（加入时间），
//   **没有「书签最后点击时间」**（那是 Firefox 才有的 dateLastUsed）。
//   要判断「常用」只能从浏览历史侧取 visitCount + lastVisitTime 反推。
//
// history 是**可选权限**（manifest.json 的 optional_permissions），默认不申请，
//   用户点「开启高频书签」时才弹授权框——见下方 hasHistoryPermission / requestHistoryPermission。
//
// 依赖：normalizeUrl()（js/bookmarks.js）。popup 里加载顺序是 bookmarks.js → frequency.js。
//       这里仍做 typeof 兜底，避免漏引脚本时整个弹窗报错。

const FREQ_WINDOW_DAYS = 180; // 只看最近半年：更早的访问对「现在常用」没有参考价值，也顺带压住数据量
const FREQ_HALF_LIFE_DAYS = 90; // 时间衰减半衰期：90 天前访问的那一次只算半分
const FREQ_MIN_VISITS = 2; // 只点过一两次说明不了「高频」，不进全局评选（分类保底时不受此限）
const FREQ_MANUAL_KEY = "freqManual"; // 手动标记存放位置（storage.local）
// 手动星标对「排序得分」的加成：加一个远大于任何真实得分的常数，而**不是**直接给 Infinity
// —— 这样能保留手动项之间的相对顺序（两个都标了星，更常用的那个仍然排在前面）。
// 标记为「非高频」（off）则减去同一个常数，直接沉到所有非手动项之后。
const FREQ_MANUAL_BOOST = 1e9;

// ---- 权限（history 是「可选权限」）----
// 为什么做成可选：装插件时弹「读取您的浏览记录」会劝退一部分人，而多数人用不到这个功能；
//   更要命的是——把可选权限挪进必需权限集，Chrome 会把存量用户全部置灰要求重新授权。
// 所以：默认不申请，用户第一次点「开启高频书签」时才弹框。
function hasHistoryPermission() {
  return new Promise((resolve) => {
    if (!chrome.permissions || !chrome.permissions.contains) { resolve(false); return; }
    chrome.permissions.contains({ permissions: ["history"] }, (ok) => {
      void chrome.runtime.lastError; // 未授权时 contains 返回 false，不视为错误
      resolve(!!ok);
    });
  });
}

// ⚠ 必须在真实的用户手势（click / change 事件处理函数）里调用，否则 Chrome 直接拒绝且**不弹框**，
//   调用方拿到的只是 false，看起来像「用户拒绝了」——排查时容易误判。
function requestHistoryPermission() {
  return new Promise((resolve) => {
    if (!chrome.permissions || !chrome.permissions.request) { resolve(false); return; }
    chrome.permissions.request({ permissions: ["history"] }, (ok) => {
      void chrome.runtime.lastError;
      resolve(!!ok);
    });
  });
}

// 没选出高频书签时给一句可读的原因。抽成纯函数是为了能脱离 chrome API 单测。
// 三种原因的处理方式完全不同：没授权要去授权、没历史只能等、没匹配说明书签本身不常点。
function freqReason(granted, historyLoaded, historySize, autoSize) {
  if (!granted) return "未授权「浏览记录」";
  if (!historyLoaded) return "读取浏览记录失败";
  if (!historySize) return "最近半年没有浏览记录";
  if (!autoSize) return "没有书签匹配到足够的访问记录";
  return "";
}

// 历史记录与书签的匹配键：在 normalizeUrl 基础上再去掉 www. 前缀。
// 书签存 www.x.com、历史记 x.com 的情况很常见，不抹平就对不上。
function freqKey(url) {
  const base =
    typeof normalizeUrl === "function"
      ? normalizeUrl(url)
      : String(url || "").trim().toLowerCase();
  return base.replace(/^www\./, "");
}

// 读浏览历史，构建 { 匹配键 -> { score, visits, lastVisitTime } }。
// 得分 = 访问次数 × 时间衰减，等价于「最近半年里用得又多又近」。
// 返回 Map = 读到了；返回 **null** = 压根读不到（没权限 / API 不可用 / lastError）。
//   区分这两者是为了不把「没授权」误报成「最近半年没有浏览记录」——后者会让人以为数据被清了。
function loadHistoryScores() {
  return new Promise((resolve) => {
    if (!chrome.history || !chrome.history.search) { resolve(null); return; }
    const now = Date.now();
    const startTime = now - FREQ_WINDOW_DAYS * 86400000;
    // ⚠ 两个默认值坑，必须显式覆盖，否则等于没数据：
    //   startTime  默认只有「24 小时前」——不传就只查到昨天为止的记录；
    //   maxResults 默认只有 100 ——不传就只能拿到 100 条。
    chrome.history.search({ text: "", startTime, maxResults: 100000 }, (items) => {
      const err = chrome.runtime.lastError;
      if (err || !items) { resolve(null); return; }
      const map = new Map();
      for (const h of items) {
        if (!h.url) continue;
        const key = freqKey(h.url);
        if (!key) continue;
        const visits = h.visitCount || 0;
        const last = h.lastVisitTime || 0;
        const daysAgo = last ? Math.max(0, (now - last) / 86400000) : FREQ_WINDOW_DAYS;
        const score = visits * Math.pow(0.5, daysAgo / FREQ_HALF_LIFE_DAYS);
        const prev = map.get(key);
        // http/https 归一化后会撞到同一个 key，保留分高的那条
        if (!prev || score > prev.score) map.set(key, { score, visits, lastVisitTime: last });
      }
      resolve(map);
    });
  });
}

// 自动评选：全局 topN + 每分类保底。
// 返回书签 id 的 Set（只含自动结果，不含手动标记）。
function pickFrequent(bookmarks, historyMap, classMap, opts) {
  const topN = Math.max(0, (opts && opts.topN) || 0);
  const perCat = Math.max(0, opts && opts.perCat != null ? opts.perCat : 0);
  const picked = new Set();
  if (!historyMap || !historyMap.size || !bookmarks || !bookmarks.length) return picked;

  const all = []; // 有历史记录的书签（含只点过 1 次的）
  const strong = []; // 访问次数够格的
  for (const bm of bookmarks) {
    if (!bm.url || !bm.id) continue;
    const h = historyMap.get(freqKey(bm.url));
    if (!h || !h.visits) continue;
    const rec = {
      id: bm.id,
      catId: classMap ? (classMap[bm.id] || "") : "",
      score: h.score,
      visits: h.visits
    };
    all.push(rec);
    if (h.visits >= FREQ_MIN_VISITS) strong.push(rec);
  }
  if (!all.length) return picked;

  const byScore = (a, b) => b.score - a.score || b.visits - a.visits || (a.id < b.id ? -1 : 1);
  all.sort(byScore);
  strong.sort(byScore);

  // ① 全局 top N —— 全库最常用的那几个，不问分类
  for (const r of strong.slice(0, topN)) picked.add(r.id);

  // ② 每分类保底 —— 有书签、却一个高频都没落进去的分类，补它自己最热的几个。
  //    目的：避免某个分类的一级目录清一色是文件夹，点进去还得再点一层。
  if (perCat > 0) {
    const catOf = new Map();
    for (const r of all) if (r.catId) catOf.set(r.id, r.catId);
    const cats = new Set(catOf.values());
    for (const cat of cats) {
      let have = 0;
      for (const [id, c] of catOf) if (c === cat && picked.has(id)) have++;
      if (have >= perCat) continue;
      for (const r of all) {
        if (have >= perCat) break;
        if (r.catId !== cat || picked.has(r.id)) continue;
        picked.add(r.id);
        have++;
      }
    }
  }
  return picked;
}

// ---- 手动标记 ----
// 存两本账，按「URL 匹配键」而不是书签 id —— 重新生成预览后书签 id 会变，
// 用 URL 才能让标记跨批次存活（和「手动微调分类」的 setOverride 同一套思路）。
//   on  ：不管自动算没算中，强制标为高频
//   off ：不管自动算没算中，强制不标为高频
function loadFreqManual() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [FREQ_MANUAL_KEY]: null }, (o) => {
      const m = o[FREQ_MANUAL_KEY] || {};
      resolve({ on: m.on || {}, off: m.off || {} });
    });
  });
}

function saveFreqManual(m) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [FREQ_MANUAL_KEY]: { on: m.on || {}, off: m.off || {} } }, resolve);
  });
}

// 标记 / 取消一个书签的高频身份。
// want: true = 强制加入，false = 强制排除，null/undefined = 清除标记（回到自动判定）
async function setFreqMark(url, want) {
  const m = await loadFreqManual();
  const k = freqKey(url);
  delete m.on[k];
  delete m.off[k];
  if (want === true) m.on[k] = 1;
  else if (want === false) m.off[k] = 1;
  await saveFreqManual(m);
  return m;
}

async function clearFreqManual() {
  await saveFreqManual({ on: {}, off: {} });
}

// 把手动标记叠加到自动结果上（off 先执行，on 后执行 —— 同一 URL 不可能同时在两本账里，这里只是保险）
function applyFreqManual(autoSet, bookmarks, manual) {
  const out = new Set(autoSet || []);
  if (!manual) return out;
  const idByKey = new Map();
  for (const bm of bookmarks || []) {
    if (!bm.url || !bm.id) continue;
    const k = freqKey(bm.url);
    if (!idByKey.has(k)) idByKey.set(k, bm.id); // 重复书签取第一个
  }
  for (const k of Object.keys(manual.off || {})) {
    const id = idByKey.get(k);
    if (id) out.delete(id);
  }
  for (const k of Object.keys(manual.on || {})) {
    const id = idByKey.get(k);
    if (id) out.add(id);
  }
  return out;
}

// 每个书签的「使用频率得分」，用于整理时给同一文件夹里的直接书签排序（高的在前）。
// 与 pickFrequent 的区别：pickFrequent 只回答「**是否**入选高频繁凑」，这里回答「**多高**」——
// 排序需要连续分值，二值集合排不了序。
// 返回 Map：书签 id -> 得分。所有书签都有键（没有历史数据的记 0），方便排序时直接取值。
//   有历史：visits × 时间衰减
//   手动标星：+FREQ_MANUAL_BOOST（置顶但保留彼此相对顺序）
//   手动标非高频：−FREQ_MANUAL_BOOST（沉底）
// historyMap 传 null（未授权 / 读不到）时仍会算：此时只有手动星标能影响顺序。
function buildFreqScores(bookmarks, historyMap, manual) {
  const scores = new Map();
  if (!bookmarks || !bookmarks.length) return scores;
  const on = (manual && manual.on) || {};
  const off = (manual && manual.off) || {};
  for (const bm of bookmarks) {
    if (!bm.url || !bm.id) continue;
    const key = freqKey(bm.url);
    let s = 0;
    const h = historyMap ? historyMap.get(key) : null;
    if (h && h.visits) s = h.score;
    if (off[key]) s -= FREQ_MANUAL_BOOST;
    else if (on[key]) s += FREQ_MANUAL_BOOST;
    // 同一 URL 的多个副本各有各的 id，都要有分（整理时它们各自参与所属文件夹的排序）
    const prev = scores.get(bm.id);
    if (prev == null || s > prev) scores.set(bm.id, s);
  }
  return scores;
}

// 一次性算出本次要用的高频书签集合。
// 返回 { enabled, ids, auto, manual, scores, historySize, hasHistory, granted, needPermission, reason }
//   ids            —— 最终生效的（自动 + 手动叠加），整理时按它平铺
//   auto           —— 纯自动结果，用于界面展示「自动 N 个」
//   scores         —— 书签 id -> 使用频率得分，用于**同一文件夹内直接书签的排序**
//   needPermission —— 没授权「浏览记录」，界面据此显示「开启」入口
//   reason         —— 没选出数据时给用户一句可读的原因，不静默失败
async function resolveFrequent(cfg, bookmarks, classMap) {
  const enabled = !cfg || cfg.freqEnabled !== false;
  const manual = await loadFreqManual();
  if (!enabled) {
    return {
      enabled: false, ids: new Set(), auto: new Set(), manual, scores: new Map(),
      historySize: 0, hasHistory: false, granted: false, needPermission: false,
      reason: "功能已关闭"
    };
  }

  const granted = await hasHistoryPermission();
  if (!granted) {
    // 没授权也把手动星标算上：标星是纯本地操作，不该被权限卡住。
    // 这样用户即使不授权，也能靠手点星星维护高频书签（并影响同文件夹内的排序），
    // 功能不是「要么全有要么全无」。
    return {
      enabled: true, ids: applyFreqManual(new Set(), bookmarks, manual),
      auto: new Set(), manual,
      scores: buildFreqScores(bookmarks, null, manual),
      historySize: 0, hasHistory: false, granted: false, needPermission: true,
      reason: freqReason(false, false, 0, 0)
    };
  }

  const historyMap = await loadHistoryScores();
  const loaded = !!historyMap;
  const auto = pickFrequent(bookmarks, historyMap, classMap, {
    topN: cfg.freqTopN, perCat: cfg.freqPerCat
  });
  const ids = applyFreqManual(auto, bookmarks, manual);
  return {
    enabled: true, ids, auto, manual,
    scores: buildFreqScores(bookmarks, historyMap, manual),
    historySize: loaded ? historyMap.size : 0,
    hasHistory: loaded, granted: true, needPermission: false,
    reason: freqReason(true, loaded, loaded ? historyMap.size : 0, auto.size)
  };
}
