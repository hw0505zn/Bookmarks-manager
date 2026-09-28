// 后台 Service Worker：AI 分类、右键菜单、消息路由。
importScripts("js/config.js", "js/categories.js", "js/bookmarks.js", "js/classifier.js", "js/overrides.js");

// 在指定父节点下查找同名子文件夹（返回 null 表示不存在）。
function findFolder(parentId, title) {
  return new Promise((resolve) => {
    chrome.bookmarks.getChildren(parentId, (children) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(children.find((c) => !c.url && c.title === title) || null);
    });
  });
}

function createFolder(parentId, title) {
  return new Promise((resolve) => {
    chrome.bookmarks.create({ parentId, title }, (node) => resolve(node && node.id));
  });
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (cfg) => {
      chrome.storage.local.get({ aiApiKey: "" }, (local) => {
        cfg.aiApiKey = local.aiApiKey || cfg.aiApiKey || "";
        applyLocalFallback(cfg); // 本地兜底：storage 被清空时自动回填 config.js 的值
        resolve(cfg);
      });
    });
  });
}

// 读取全部书签并扁平化
function getAllBookmarks() {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const out = [];
      flattenBookmarks(tree, [], [], out);
      resolve(out);
    });
  });
}

// 确保目标文件夹存在，返回其 id
async function ensureTargetFolder(cfg) {
  // 从书签树动态解析根文件夹真实 id（避免硬编码 id 失配）
  const tree = await new Promise((r) => chrome.bookmarks.getTree(r));
  const parentId = resolveRootFolderId(cfg.targetParentId, tree);
  if (!parentId) throw new Error("无法定位书签根目录");
  // 直接查目标父节点下的同名子文件夹（勿用 flattenBookmarks，它只压平书签、不含文件夹）
  const existing = await findFolder(parentId, cfg.targetFolderName);
  if (existing) return existing;
  try {
    const created = await new Promise((r) =>
      chrome.bookmarks.create({ parentId, title: cfg.targetFolderName }, r)
    );
    return created.id;
  } catch (e) {
    // 并发创建时可能已被其它调用抢先建好，重查一次
    const again = await findFolder(parentId, cfg.targetFolderName);
    if (again) return again;
    throw e;
  }
}

// 注意：部分中转站（如 tokenrhythm）的 WAF 会对「带浏览器会话 Cookie」的请求
// 启用 CSRF 校验并返回 403 CSRF_INVALID，而对无 Cookie 的纯 API 请求直接放行到鉴权层。
// 因此必须显式 credentials: "omit"，绝不附带 Cookie。

// AI 分类：把 items 分批请求 LLM，返回 { cats: {id: categoryId}, subs: {id: 二级标签} }
//
// 关键设计：分批（CHUNK=50）会让每批「各自发明一套标签」，同一主题在不同批次被起成
// 不同名字（「前端框架」/「前端开发」/「Web 前端」），结果标签总数爆炸 → 触发本地
// Top-N 限额 → 大批书签被平铺到分类文件夹，二级文件夹失去归类意义。
// 因此这里维护一份**跨批次累积的标签词汇表**，并在 prompt 里强制：
//   ① 每个类别下的标签数不超过 maxSubFolders（与「生成预览」的限额同源）；
//   ② 已有标签语义合适时必须复用，不要另造同义新标签；
//   ③ 每个书签都必须有标签，不允许留空。
async function classifyWithAI(items, cfg) {
  const CHUNK = 50; // 每批书签数量，避免单次请求过大
  // 类别清单必须带关键词（buildCategoryList）——见 js/config.js 里的说明：
  // 只给 AI 一堆类别名，它只能凭名字字面猜，用户删改过分类后分类质量会崩。
  const catList = buildCategoryList(getActiveCategories());
  const maxSubs = Math.max(1, parseInt(cfg.maxSubFolders, 10) || 5);
  const thirdLevel = !!cfg.enableThirdLevel; // 三级子文件夹（可选）
  const cats = {};
  const subs = {};
  const subs2 = {}; // id -> 三级标签（仅开启三级时）
  const vocab = new Map(); // 类别名 -> Set(已用二级标签)
  const newCats = []; // AI 提出的、分类表里没有的新大类（路径优先时会出现），回传给 popup 落盘
  const rejectedCats = []; // 未勾选路径时被拒的表外大类名：回传给 popup 提示（不静默）
  // 三级标签词汇表：键为「类别名\u0001二级标签」，因为三级标签只在对应二级标签下才有意义
  const vocab3 = new Map();
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    const list = batch.map((it) => ({ id: it.id, title: it.title, url: it.url }));
    // 已有词汇表按类别汇总；每类只回传前 maxSubs 个，避免把「已经超限的清单」喂回去反向激励 AI 多造标签
    const known = vocab.size
      ? [...vocab.entries()]
          .filter(([, s]) => s.size)
          .map(([c, s]) => `${c}：${[...s].slice(0, maxSubs).join("、")}`)
          .join("；")
      : "";
    // 三级词汇表同理，按「类别 / 二级标签」回传
    const known3 = thirdLevel && vocab3.size
      ? [...vocab3.entries()]
          .filter(([, s]) => s.size)
          .map(([k, s]) => `${k.replace("\u0001", " / ")}：${[...s].slice(0, maxSubs).join("、")}`)
          .join("；")
      : "";
    const part = await classifyChunk(list, catList, cfg, { maxSubs, known, thirdLevel, known3 });
    Object.assign(cats, part.cats);
    Object.assign(subs, part.subs);
    Object.assign(subs2, part.subs2 || {});
    // 跨批次去重：classifyChunk 内部已用 state 去过重，这里防不同批次各自新建出同名类
    for (const c of part.newCats || []) if (!newCats.some((x) => x.id === c.id)) newCats.push(c);
    for (const n of part.rejectedCats || []) if (!rejectedCats.includes(n)) rejectedCats.push(n);
    for (const [id, catId] of Object.entries(part.cats)) {
      const label = part.subs[id];
      if (!label) continue;
      const cname = getCategoryById(catId).name;
      if (!vocab.has(cname)) vocab.set(cname, new Set());
      vocab.get(cname).add(label);
      const l3 = (part.subs2 || {})[id];
      if (l3) {
        const key = cname + "\u0001" + label;
        if (!vocab3.has(key)) vocab3.set(key, new Set());
        vocab3.get(key).add(l3);
      }
    }
  }
  for (const it of items) if (!cats[it.id]) cats[it.id] = getFallbackCategory().id;
  // 叠加用户手动调整（仅作用于一级分类）
  return { cats: await applyOverrides(cats, items), subs, subs2, newCats, rejectedCats };
}

// 从模型返回中提取 JSON 数组（兼容代码块、前后说明文字等）
function extractJsonArray(text) {
  const s = String(text || "").replace(/```json|```/gi, "");
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("AI 未返回可解析的 JSON 数组：" + String(text).slice(0, 120));
  return JSON.parse(m[0]);
}

// 从模型返回中提取 JSON 对象（建议分类表用）
function extractJsonObject(text) {
  const s = String(text || "").replace(/```json|```/gi, "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI 未返回可解析的 JSON 对象：" + String(text).slice(0, 120));
  return JSON.parse(m[0]);
}

// 容错：用户可能只填了域名或 base，自动补全为完整 Chat Completions 路径
function toChatUrl(u) {
  u = (u || "").trim();
  if (!u) return u;
  if (/\/chat\/completions\/?$/i.test(u)) return u;
  return u.replace(/\/+$/, "") + "/chat/completions";
}

// 调一次 Chat Completions，返回模型正文。
// 抽出来给「分类」和「建议大类」共用：两处的鉴权头、credentials、DeepSeek 关思考、
// 错误信息格式必须完全一致，各写一份迟早会漂。
async function callChat(cfg, prompt) {
  const url = toChatUrl(cfg.aiBaseUrl);
  const body = {
    model: cfg.aiModel,
    messages: [{ role: "user", content: prompt }],
    temperature: 0
  };
  // DeepSeek 默认开启思考模式，分类无需推理：关闭可提速并减少正文前后的多余文字
  if (/deepseek/i.test(url)) body.thinking = { type: "disabled" };

  const resp = await fetch(url, {
    method: "POST",
    credentials: "omit", // 不带 Cookie，避免触发平台的 CSRF/会话校验
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.aiApiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`AI 接口错误 ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

// 让 AI 在「用户现有的分类表」基础上建议增 / 减一级大类。
// 入参是设置页已经渲染好的两份文本（类别清单、书签实况），本函数只负责发请求 + 解析 JSON ——
// 拼提示词留在 js/config.js（唯一真源），避免两处各拼一半、越改越不一致。
async function suggestCategories(catList, statsText, cfg) {
  const content = await callChat(cfg, buildCatSuggestInstructions(catList, statsText));
  const obj = extractJsonObject(content);
  // 容错：字段可能是 null / 不是数组，统一成数组，别让畸形返回把设置页弄崩
  return {
    add: Array.isArray(obj.add) ? obj.add : [],
    remove: Array.isArray(obj.remove) ? obj.remove : []
  };
}

async function classifyChunk(list, catList, cfg, opts) {
  const maxSubs = (opts && opts.maxSubs) || 5;
  const known = (opts && opts.known) || "";
  const thirdLevel = !!(opts && opts.thirdLevel);
  const known3 = (opts && opts.known3) || "";
  // 「参考书签现有的文件夹路径」开关同时决定两件事：发不发 folder 字段、以及是否允许
  // AI 直接沿用路径名当一级大类（folderFirst）。两处口径必须一致，所以只在这里判定一次。
  const folderHint = cfg.useFolderHint !== false;
  // 提示词正文来自 js/config.js 的 buildAiInstructions（唯一真源）：
  // popup 的缓存指纹会用**完全相同的参数**渲染同一段文本，因此改提示词、
  // 切换上面那个开关，都会让旧分类缓存自动失效。
  const prompt =
    buildAiInstructions(catList, maxSubs, thirdLevel, known, known3, {
      folderHint,
      folderFirst: folderHint
    }) +
    `书签列表：\n${JSON.stringify(list)}`;

  const content = (await callChat(cfg, prompt)) || "[]";
  const arr = extractJsonArray(content);
  const cats = {};
  const subs = {};
  const subs2 = {};
  // AI 可能给出分类表里没有的大类（路径优先时这是设计内的行为）：落成真实分类对象，
  // 否则后续 getCategoryById 会把它们一律当「其他」，表现为"AI 明明按我的文件夹分了，结果全进其他"。
  // 但**取消勾选「参考文件夹路径」时不允许新建**（用户要的是"大类只能从表里选"）。
  // 例外：表里一个可用大类都没有 —— 此时提示词已明确要求 AI 自行归纳（见 buildCategoryRule
  //   的「情况③」），若还禁止新建就会把全部书签逼进兜底。两处判据（提示词 / 这里）必须一致。
  const mayCreate = folderHint || !hasUsableCategories(getActiveCategories());
  const state = { created: [] };
  for (const row of arr) {
    const id = String(row.id);
    const { cat } = resolveOrCreateCategory(row.category, getActiveCategories(), state, mayCreate);
    cats[id] = cat.id;
    if (row.sub && String(row.sub).trim()) {
      subs[id] = String(row.sub).trim();
      // 三级标签只在「有二级标签」的前提下才成立：没有二级就谈不上三级细分
      if (thirdLevel && row.subsub && String(row.subsub).trim()) {
        subs2[id] = String(row.subsub).trim();
      }
    }
  }
  // 未返回的归入“其他”
  for (const it of list) if (!cats[it.id]) cats[it.id] = getFallbackCategory().id;
  return { cats, subs, subs2, newCats: state.created, rejectedCats: state.rejected || [] };
}

// 右键“智能添加书签”：把当前页分类后直接放入对应分类文件夹
async function smartAddCurrentTab(tab) {
  const cfg = await getConfig();
  await refreshActiveCategories();
  const targetId = await ensureTargetFolder(cfg);
  const bm = { id: "tmp", title: tab.title || tab.url, url: tab.url };
  let catId = classifyByKeyword(bm);
  if (cfg.method === "ai" && cfg.aiApiKey) {
    try {
      const r = await classifyWithAI([bm], cfg);
      catId = (r.cats && r.cats["tmp"]) || catId;
    } catch (e) { /* 回退关键词 */ }
  }
  // 叠加用户对该网址的手动调整
  const ov = await loadOverrides();
  if (ov[normalizeUrl(bm.url)] && getCategoryById(ov[normalizeUrl(bm.url)])) {
    catId = ov[normalizeUrl(bm.url)];
  }
  const cat = getCategoryById(catId);
  let catFolderId = targetId;
  // 直接查分类子文件夹（勿用 flattenBookmarks，它不含文件夹节点）
  const f = await findFolder(targetId, cat.name);
  if (f) catFolderId = f;
  else {
    const created = await new Promise((r) =>
      chrome.bookmarks.create({ parentId: targetId, title: cat.name }, r)
    );
    catFolderId = created.id;
  }
  await new Promise((r) => chrome.bookmarks.create({ parentId: catFolderId, title: bm.title, url: bm.url }, r));
}

const CONTEXT_MENU_ID = "smart-add-bookmark";

chrome.runtime.onInstalled.addListener(() => {
  // 先清空再建，避免更新/重装时二次 create 抛 duplicate id 错误
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "智能添加书签（自动分类）",
      contexts: ["page"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID && tab) {
    smartAddCurrentTab(tab);
  }
});

// 消息路由：popup 请求 AI 分类
// 从响应头提取诊断信息，用于区分 403 的不同成因（WAF/CSRF/IP白名单/额度）
function diagHeaders(resp) {
  const pick = ["server", "cf-ray", "x-trace-id", "traceid", "x-request-id", "www-authenticate", "retry-after"];
  const out = {};
  for (const k of pick) {
    const v = resp.headers.get(k);
    if (v) out[k] = v;
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "AI_CLASSIFY") {
    refreshActiveCategories().then(() =>
      getConfig().then((cfg) =>
        classifyWithAI(msg.items, cfg)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((err) => sendResponse({ ok: false, error: err.message }))
      )
    );
    return true; // 异步响应
  }

  // 设置页「AI 建议大类」：在用户已调整过的分类表上，按真实书签建议增 / 减一级大类
  if (msg.type === "AI_SUGGEST_CATS") {
    (async () => {
      try {
        await refreshActiveCategories();
        const cfg = await getConfig();
        const result = await suggestCategories(msg.catList, msg.statsText, cfg);
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  // 设置页「测试连接」：用最小请求验证地址/密钥/模型是否可用
  if (msg.type === "AI_TEST") {
    (async () => {
      try {
        const testUrl = toChatUrl(msg.url);
        const resp = await fetch(testUrl, {
          method: "POST",
          credentials: "omit", // 不带 Cookie，避免触发平台的 CSRF/会话校验
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${msg.key}`
          },
          body: JSON.stringify({
            model: msg.model,
            messages: [{ role: "user", content: "只回复两个字：OK" }],
            max_tokens: 16,
            temperature: 0
          })
        });
        const txt = await resp.text();
        let brief = txt.slice(0, 200);
        try {
          const d = JSON.parse(txt);
          brief = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) ||
            (d.error && d.error.message) || JSON.stringify(d).slice(0, 200);
        } catch (e) { /* 保持原文 */ }
        sendResponse({ ok: resp.ok, status: resp.status, text: brief, headers: diagHeaders(resp) });
      } catch (e) {
        sendResponse({ ok: false, status: 0, text: e.message });
      }
    })();
    return true;
  }
});
