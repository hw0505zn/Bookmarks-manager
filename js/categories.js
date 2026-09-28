// 分类定义与运行期管理：被 popup 与 service-worker 共用。
// DEFAULT_CATEGORIES 为出厂内置；用户可在设置中编辑，编辑后存入 storage.sync.userCategories，
// 运行期通过 setActiveCategories / getActiveCategories 使用「当前生效」的分类。

const DEFAULT_CATEGORIES = [
  {
    id: "dev",
    name: "开发技术",
    color: "#3b82f6",
    system: false,
    keywords: [
      "github.com", "gitlab.com", "stackoverflow.com", "developer", "dev.to",
      "npmjs.com", "docker", "kubernetes", "mdn", "w3schools", "leetcode",
      "coding", "code", "编程", "代码", "开发", "前端", "后端", "程序", "源码",
      "api", "python", "java", "javascript", "typescript", "go语言", "rust",
      ".io", "ci/cd", "云原生", "算法", "开源"
    ]
  },
  {
    id: "design",
    name: "设计创意",
    color: "#ec4899",
    system: false,
    keywords: [
      "figma.com", "sketch", "dribbble.com", "behance.net", "canva", "photoshop",
      "ui", "ux", "设计", "配色", "字体", "素材", "图标", "插画", "原型", "视觉", "创意"
    ]
  },
  {
    id: "news",
    name: "新闻资讯",
    color: "#f59e0b",
    keywords: [
      "news", "新闻", "资讯", "日报", "头条", "bbc", "cnn", "凤凰", "新浪", "网易",
      "腾讯新闻", "知乎日报", "36氪", "虎嗅", "钛媒体", "澎湃", "环球"
    ]
  },
  {
    id: "edu",
    name: "学习教育",
    color: "#10b981",
    keywords: [
      "course", "mooc", "coursera", "edx", "khan", "学堂", "课程", "学习", "教育",
      "大学", "教程", "培训", "考研", "考试", "题库", "慕课", "网课"
    ]
  },
  {
    id: "shop",
    name: "购物消费",
    color: "#ef4444",
    keywords: [
      "taobao.com", "tmall.com", "jd.com", "pinduoduo", "amazon", "shop", "store",
      "购物", "淘宝", "京东", "天猫", "商城", "买", "电商", "优惠", "折扣"
    ]
  },
  {
    id: "media",
    name: "影音娱乐",
    color: "#8b5cf6",
    keywords: [
      "bilibili.com", "youtube.com", "youku", "iqiyi", "v.qq.com", "netflix",
      "music", "网易云", "qq音乐", "虾米", "视频", "电影", "音乐", "听歌", "直播", "综艺", "动漫"
    ]
  },
  {
    id: "social",
    name: "社交媒体",
    color: "#06b6d4",
    keywords: [
      "weibo.com", "weixin", "zhihu.com", "douban.com", "facebook", "twitter",
      "x.com", "instagram", "reddit", "t.me", "微博", "微信", "知乎", "豆瓣",
      "社区", "论坛", "贴吧", "群", "社交"
    ]
  },
  {
    id: "tool",
    name: "工具效率",
    color: "#64748b",
    keywords: [
      "tool", "online", "转换", "convert", "截图", "笔记", "notion", "文档", "云盘",
      "邮箱", "calendar", "日历", "翻译", "ocr", "pdf", "表格", "协作", "效率", "工具", "在线"
    ]
  },
  {
    id: "finance",
    name: "金融财经",
    color: "#0ea5e9",
    keywords: [
      "finance", "stock", "fund", "bank", "财经", "股票", "基金", "银行", "理财",
      "比特币", "crypto", "保险", "外汇", "期货", "证券", "投资"
    ]
  },
  {
    id: "life",
    name: "健康生活",
    color: "#22c55e",
    keywords: [
      "health", "医疗", "健身", "美食", "旅游", "旅行", "养生", "减肥", "健康",
      "菜谱", "食谱", "运动", "瑜伽", "医院", "挂号", "亲子", "宠物"
    ]
  },
  {
    id: "other",
    name: "其他",
    color: "#94a3b8",
    system: true, // 兜底分类，不可删除
    keywords: []
  }
];

// 新分类的备选颜色（取自出厂分类，保证一屏内的色感统一）
const CAT_PALETTE = [
  "#3b82f6", "#ec4899", "#f59e0b", "#10b981", "#ef4444",
  "#8b5cf6", "#06b6d4", "#64748b", "#0ea5e9", "#22c55e"
];

// 生成一个不与现有分类冲突的 id。带上 existing 是为了防同一批新增里出现重复 id。
function newCatId(existing, seed) {
  const used = new Set((existing || []).map((c) => c.id));
  const base = "cat_" + (seed != null ? seed : Date.now());
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(base + "_" + i)) i++;
  return base + "_" + i;
}

// 需要新增分类时挑一个颜色：取当前用得最少的调色板颜色，避免一片同色
function pickCatColor(list) {
  const counts = {};
  for (const c of list || []) if (c && c.color) counts[c.color] = (counts[c.color] || 0) + 1;
  let best = CAT_PALETTE[0], bestN = Infinity;
  for (const col of CAT_PALETTE) {
    const n = counts[col] || 0;
    if (n < bestN) { bestN = n; best = col; }
  }
  return best;
}

// ---- 分类表「自适应维护」：按用户真实的书签，给一级大类做增 / 减 ----
// 为什么要这套东西：本插件的目标用户是浏览器重度用户（书签成百上千、结构混乱）。
//   出厂预置的 11 个大类覆盖不了所有人的领域；反过来，用户自己加的大类也可能长期只有两三个书签、
//   变成永久空目录。所以「默认给一套大类」+「能在用户改过的表上按实际书签增删」两者都要有。
//   ⚠ 增删永远以**用户手动调整后的表**为基准：只在上面加 / 减，绝不推翻重来。

// 统计各一级大类的书签数，并单独汇总「兜底分类里的高频站点」——那是现有大类没覆盖住的内容，
// 也是"该新增哪个大类"最硬的线索。
// classMap: { 书签id -> 分类id }，来自上一次扫描的分类缓存；为 null 表示还没扫描过。
// 返回 { total, perCat, other, otherDomains, hasCounts }
function buildCatSuggestStats(items, classMap, cats) {
  items = items || [];
  const other = getFallbackCategory(cats);
  const perCat = {};
  const domains = new Map();
  let counted = 0;
  for (const it of items) {
    const cid = classMap ? classMap[it.id] : null;
    if (cid) { perCat[cid] = (perCat[cid] || 0) + 1; counted++; }
    if (cid !== other.id) continue;
    const d = domainOf(it.url) || "(无域名)";
    if (!domains.has(d)) domains.set(d, { domain: d, n: 0, samples: [] });
    const g = domains.get(d);
    g.n++;
    if (g.samples.length < 2 && it.title) g.samples.push(String(it.title).slice(0, 40));
  }
  const otherDomains = [...domains.values()].sort(
    (a, b) => b.n - a.n || (a.domain < b.domain ? -1 : 1) // 次级键保证结果稳定可复现
  );
  return {
    total: items.length,
    perCat,
    other: { id: other.id, name: other.name, count: perCat[other.id] || 0 },
    otherDomains,
    hasCounts: counted > 0
  };
}

// 等间隔抽样：保证样本覆盖"最老的收藏"到"最近的收藏"，且不用随机数 ——
// 同样的输入永远给出同样的样本，出问题能复现。不用随机数的另一层原因：
// 每次点「AI 建议」看到的依据都不同，用户会以为 AI 在乱跳。
function spreadSample(list, n) {
  if (n <= 0 || !list || !list.length) return [];
  if (list.length <= n) return list.slice();
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

// 给 AI 看的书签样本。**优先取兜底分类里的书签**：那是现有大类没覆盖住的内容，也是新增大类的唯一来源；
// 剩下名额再对全部书签做等间隔抽样。为什么不直接切前 N 条：书签树基本按加入时间排，
// 切前 N 条只会看到最老的一批收藏，而"最近堆进兜底"的那批恰恰最值得看。
function sampleItemsForSuggest(items, classMap, cats, max) {
  const cap = Number.isFinite(max) ? max : 80;
  const other = getFallbackCategory(cats);
  const otherItems = [], rest = [];
  for (const it of items || []) {
    if (classMap && classMap[it.id] === other.id) otherItems.push(it);
    else rest.push(it);
  }
  const quota = Math.min(otherItems.length, Math.ceil(cap / 2));
  const picked = otherItems.slice(0, quota);
  return picked.concat(spreadSample(rest, cap - picked.length));
}

// 把 AI 的建议合并进当前分类表，返回新表 + 逐条处置结果。
// **只信可验证的部分**（AI 的话只当"候选"，通过本地硬规则才算数）：
//   · 新增必须有名称 + 至少 1 个关键词 —— 没有关键词的大类等于回到"AI 只能按名字字面猜"的老 bug；
//   · 删除只允许删「书签数 ≤ maxRemoveSize」的大类，且绝不删兜底类 —— AI 说要删一个有 300 条书签的大类，
//     那是它在自作主张，一律驳回；
//   · 没有统计（还没扫描过）时不做任何删除，避免"凭感觉删"；
//   · 一切以用户当前的表为基准：同名不重复加、表里没有的不删、顺序是"原表在前，新增追加在后"。
// 返回 { cats, added, removed, rejected }（cats 是新数组，不改入参）
function mergeCategorySuggestions(cats, suggestions, opts) {
  opts = opts || {};
  const maxRemoveSize = Number.isFinite(opts.maxRemoveSize) ? opts.maxRemoveSize : 2;
  const perCat = opts.perCat || null;
  const seed = opts.seed; // 仅测试用，保证 id 可预期
  const add = (suggestions && suggestions.add) || [];
  const del = (suggestions && suggestions.remove) || [];

  const next = (cats || []).map((c) => Object.assign({}, c));
  const added = [], removed = [], rejected = [];
  const findByName = (n) => next.find((c) => c.name === String(n == null ? "" : n).trim());

  for (const s of add) {
    const name = String((s && s.name) || "").trim();
    const kw = normalizeKeywords((s && s.keywords) || []);
    if (!name) { rejected.push({ name: "(未命名)", why: "建议里没有分类名，已忽略" }); continue; }
    if (findByName(name)) { rejected.push({ name, why: "已经有同名分类，跳过" }); continue; }
    if (!kw.length) {
      rejected.push({ name, why: "AI 没给关键词 —— 它自己都无从判断这一类收什么，已忽略（请手动添加并填关键词）" });
      continue;
    }
    // id 用 next（已含本批先前新增的项）去重：同一批里 AI 提了多个新类也不会撞 id
    const c = { id: newCatId(next, seed), name, color: pickCatColor(next), keywords: kw };
    next.push(c);
    added.push({ name, keywords: kw, reason: (s && s.reason) || "" });
  }

  for (const s of del) {
    const name = String((s && s.name) || "").trim();
    const target = findByName(name);
    if (!target) { rejected.push({ name: name || "(未命名)", why: "这个分类已经不在表里了" }); continue; }
    if (target.system) { rejected.push({ name, why: "兜底分类不可删除" }); continue; }
    if (!perCat) {
      rejected.push({ name, why: "还没扫描过，无法确认这一类有多少书签；先扫描一次再来建议删除" });
      continue;
    }
    const size = perCat[target.id] || 0;
    if (size > maxRemoveSize) {
      rejected.push({ name, why: `这一类现有 ${size} 个书签，不该删` });
      continue;
    }
    next.splice(next.indexOf(target), 1);
    removed.push({ name, count: size, reason: (s && s.reason) || "" });
  }

  return { cats: next, added, removed, rejected };
}

// 运行期生效的分类（默认与 DEFAULT 相同，可被用户设置覆盖）
let ACTIVE_CATEGORIES = DEFAULT_CATEGORIES.slice();

function setActiveCategories(list) {
  if (Array.isArray(list) && list.length) ACTIVE_CATEGORIES = list;
}

function getActiveCategories() {
  return ACTIVE_CATEGORIES;
}

// 从 storage.sync 加载用户自定义分类；无则回退默认
function refreshActiveCategories() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ userCategories: null }, (o) => {
      if (o.userCategories && Array.isArray(o.userCategories) && o.userCategories.length) {
        setActiveCategories(o.userCategories);
      } else {
        setActiveCategories(DEFAULT_CATEGORIES);
      }
      resolve(ACTIVE_CATEGORIES);
    });
  });
}

// 兜底分类：按 system:true 定位（出厂内置的「其他」），不依赖「最后一个」这一脆弱假设。
function getFallbackCategory(list) {
  list = list || ACTIVE_CATEGORIES;
  return list.find((c) => c.system) || list[list.length - 1] || list[0];
}

function getCategoryById(id, list) {
  list = list || ACTIVE_CATEGORIES;
  return list.find((c) => c.id === id) || getFallbackCategory(list);
}

function getCategoryByName(name, list) {
  list = list || ACTIVE_CATEGORIES;
  return list.find((c) => c.name === name) || getFallbackCategory(list);
}

// 该 id 是否**真实存在**于分类表里（区别于 getCategoryById —— 后者找不到时会回退到「其他」，因此
// 「这个 id 还有效吗」用它判断永远为真）。用于识别「用户手动调整指向的分类已经被删掉了」这种孤儿数据。
function hasCategoryId(id, list) {
  list = list || ACTIVE_CATEGORIES;
  return list.some((c) => c.id === id);
}

// 模糊匹配模型返回的分类名（去掉标点/空格后比较，支持“开发技术类”这类返回）
function matchCategoryName(name, list) {
  list = list || ACTIVE_CATEGORIES;
  const norm = (s) => String(s || "").replace(/[\s，,。.、:：;；"'「」【】()（）]/g, "").toLowerCase();
  const target = norm(name);
  if (!target) return null;
  return (
    list.find((c) => norm(c.name) === target) ||
    list.find((c) => norm(c.name).includes(target) || target.includes(norm(c.name))) ||
    null
  );
}

// ---- AI 提出的「表外大类」如何落成一个真实分类 ----
// 触发场景：开启「分类时参考书签现有的文件夹路径」后，提示词允许 AI 直接沿用用户自己的
//   文件夹名当一级大类（例：路径里有「网文创作」，而分类表里没有这一类）。
//
// 为什么必须真的建一个分类对象，而不是只记住名字：
//   分类结果全程按 **id** 索引（classMap、subLabel、ensureCatFolder 都吃 id），
//   AI 只给了名字。若只把名字留个印象，后续 getCategoryById 会一律回退到「其他」——
//   用户看到的现象就是"AI 明明照着我的文件夹分，结果全进了其他"。
//
// 三条护栏（缺一就会出现"每轮整理都多出几个近义大类、旧大类变空"的失控）：
//   ① 先做近义匹配（matchCategoryName 支持子串），命中已有类就复用 ——
//      「网文创作」与「网络小说」不该并存成两个大类；
//   ② 一次最多新增 limit 个（默认 8）—— AI 抽风也不能把分类表刷爆；
//   ③ 名字必须像个人话：2-10 字、不含句子级标点，且不能是兜底类名 ——
//      否则会把「请把上述书签归类」这种整句话建成一个分类夹。
//
// list 会被**就地修改**（新分类 push 进去），因此调用方应传入运行期分类数组。
// state = { created: [], limit } 由调用方在一次扫描内复用，用于跨批次去重与限流。
// allowCreate === false：调用方明确要求「大类只能来自表里」（= 设置页取消了「参考书签现有的
//   文件夹路径」）。此时表外名字**不新建分类**，退回兜底，并把名字记进 state.rejected 让界面提示——
//   既不静默违反用户的设置，也不静默丢弃（否则用户只看到"书签莫名进了其他"，查不出原因）。
//   唯一例外见 service-worker：分类表里一个可用大类都没有时，提示词本身已要求 AI 自行归纳，
//   那种情况下必须允许新建（否则全部书签被逼进兜底 —— 线上真实症状）。
// 返回 { cat, created }：cat 是最终归属的分类对象；created=true 表示这次新建了分类。
function isUsableCategoryName(name, list) {
  const s = String(name == null ? "" : name).trim();
  if (s.length < 2 || s.length > 10) return false;
  if (/[\n\r\t]/.test(s)) return false;
  // 句子级标点 = AI 把一句话当成了类名（正常类名不会出现这些）
  if (/[，,。.；;：:！!？?、（）()【】\[\]{}<>《》"']/.test(s)) return false;
  if (s === "/" || s === "\\") return false;
  const sysNames = (list || []).filter((c) => c.system).map((c) => c.name);
  return !sysNames.includes(s);
}

function resolveOrCreateCategory(name, list, state, allowCreate) {
  list = list || ACTIVE_CATEGORIES;
  state = state || {};
  const mayCreate = allowCreate !== false;
  const raw = String(name == null ? "" : name).trim();
  if (!raw) return { cat: getFallbackCategory(list), created: false };
  const hit = matchCategoryName(raw, list);
  if (hit) return { cat: hit, created: false };
  if (!isUsableCategoryName(raw, list)) return { cat: getFallbackCategory(list), created: false };

  const limit = Number.isFinite(state.limit) ? state.limit : 8;
  const created = state.created || (state.created = []);
  const made = created.find((c) => c.name === raw); // 同一轮里跨批次复用，不重复建
  if (made) return { cat: made, created: false };
  if (!mayCreate || created.length >= limit) {
    // 不许新建时记下被拒的名字：界面据此提示「AI 给了表外大类 X，已按你的设置归入兜底」
    if (!mayCreate) {
      const rej = state.rejected || (state.rejected = []);
      if (!rej.includes(raw)) rej.push(raw);
    }
    return { cat: getFallbackCategory(list), created: false };
  }

  const all = list.concat(created);
  const c = { id: newCatId(all), name: raw, color: pickCatColor(all), keywords: [], system: false };
  list.push(c);
  created.push(c);
  return { cat: c, created: true };
}
