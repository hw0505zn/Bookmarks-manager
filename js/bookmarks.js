// 书签树工具：扁平化、URL 归一化、重复检测。

// 将书签树扁平化为叶子（书签）列表。
// 每个条目：{ id, title, url, parentId, parentTitle, folderIds:[], folderPath:[] }
function flattenBookmarks(nodes, parentIds, parentPath, out) {
  for (const node of nodes) {
    if (node.url) {
      out.push({
        id: node.id,
        title: node.title || node.url,
        url: node.url,
        parentId: node.parentId,
        parentTitle: parentPath.length ? parentPath[parentPath.length - 1] : "",
        folderIds: parentIds.slice(),
        folderPath: parentPath.slice(),
        dateAdded: node.dateAdded || 0
      });
    } else if (node.children) {
      flattenBookmarks(
        node.children,
        parentIds.concat(node.id),
        parentPath.concat(node.title),
        out
      );
    }
  }
  return out;
}

// 归一化 URL 用于重复判定：去协议、去末尾斜杠、去 fragment、小写 host。
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let host = u.host.toLowerCase();
    let path = u.pathname.replace(/\/+$/, "");
    let search = u.search || "";
    // 去掉常见的追踪参数
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "spm"];
    if (search) {
      const params = new URLSearchParams(search);
      let changed = false;
      for (const k of drop) {
        if (params.has(k)) { params.delete(k); changed = true; }
      }
      search = changed ? params.toString() : search.replace(/^\?/, "");
      if (search) search = "?" + search;
    }
    return host + path + search;
  } catch (e) {
    return url.trim().toLowerCase();
  }
}

// 检测重复书签：返回 [{ key, items:[...] }]，每组含 2 个及以上。
function findDuplicates(items) {
  const map = new Map();
  for (const it of items) {
    if (!it.url) continue;
    const key = normalizeUrl(it.url);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  const dups = [];
  for (const [key, group] of map.entries()) {
    if (group.length > 1) dups.push({ key, items: group });
  }
  return dups;
}

// 提取域名（用于子分类）。
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

// ---- 把「书签当前所在的文件夹路径」变成给 AI 的参考线索 ----
//
// 为什么要给 AI 看书签现在放在哪：用户自己起的分类名（「网文创作」「台州项目」「给排水规范」）
// 光看书签标题和网址是**猜不到**的 —— AI 只能往它认识的通用类别里塞。现有文件夹路径是用户
// 亲手维护的归类依据，是目前唯一能让 AI 认出这类私人领域的信号。
//
// 为什么不能无脑全给（三个坑，都在下面的过滤里堵住）：
//   ① 路径前两层是「虚拟根 + 书签根」（书签栏 / 其他书签 / 移动设备书签），所有书签都有、
//      毫无信息量，还会白占层数；界面语言不同名字还不一样，所以按名字剔除而非按层级下标。
//   ② 目标用户恰恰是"书签管理混乱"的人，他们的文件夹名大量是「新建文件夹」「111」「aa」
//      这类占位名。这种线索比没有更糟（会诱导 AI 往无意义的名字上靠），必须丢掉。
//   ③ 路径可能是**本插件上一轮的产物**（预览容器里的副本、执行整理后提升到根目录的分类文件夹）。
//      容器内的线索一律作废；至于"上轮提升出来的分类文件夹"，无法与用户手工建的区分，
//      因此不做名字匹配（那会误杀用户真实的同名文件夹），改为在提示词里明确告知 AI
//      "这路径可能是上次自动整理的结果，与内容矛盾时以内容为准"——见 js/config.js。

// 书签根的名称（中英文都列，Chrome 按界面语言命名）。这些层是所有书签共有的容器，剔除。
const ROOT_FOLDER_NAMES = [
  "书签栏", "其他书签", "移动设备书签", "已同步的书签",
  "Bookmarks bar", "Bookmarks Bar", "Other bookmarks", "Other Bookmarks",
  "Mobile bookmarks", "Mobile Bookmarks"
];

// 明显没有信息量的文件夹名（占位名）。只认最明确的那几种，宁可漏判也绝不误伤真实分类名 ——
// 「这名字到底有没有意义」最终由 AI 结合书签内容判断，本地不越权替它做决定。
function isNoiseFolderName(name) {
  const s = String(name == null ? "" : name).trim();
  if (!s) return true;
  if (/^[\d\s\-_.·、，,。]+$/.test(s)) return true;            // 纯数字 / 纯半角符号
  // 纯 emoji / 全角符号等「一个文字都没有」的名字（📁、★★、……）。
  // ⚠ 必须放行中文与其它文字：\w 只含 [A-Za-z0-9_]，不认中文，
  //   所以先放行 CJK / 假名 / 谚文区段，再判定"剩下的全是符号"。
  if (/^[^\w\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/.test(s)) return true;
  if (s.length > 1 && /^(.)\1+$/.test(s)) return true;        // 重复字符：aa / 11 / 。。。
  if (/^(新建文件夹|新建|未命名|未分类|无标题|临时|待整理|待办|杂|乱七八糟|收|aaa+|untitled|new folder|no name|test|temp|tmp|xxx+)$/i.test(s)) {
    return true;
  }
  return false;
}

// 把一条书签的 folderPath 渲染成线索字符串；没有可用线索返回 ""。
// 返回 "" 而不是 null：调用方只需要判断"有没有"，而且这个值会直接进 JSON 请求体。
// opts.excludeNames —— 插件自己的容器名（预览文件夹）：命中则**整条作废**。
//   为什么是整条而不是只去掉那一层：容器内部的每一层都是本插件生成的（分类名 + 标签名），
//   去掉容器层剩下的全是插件产物，当线索用等于让 AI 自我强化上一轮的结果。
function buildFolderHint(folderPath, opts) {
  opts = opts || {};
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 3;
  const maxLen = Number.isFinite(opts.maxLen) ? opts.maxLen : 32;
  const exclude = (opts.excludeNames || [])
    .map((n) => String(n == null ? "" : n).trim())
    .filter(Boolean);
  const raw = (folderPath || []).map((n) => String(n == null ? "" : n).trim());
  if (exclude.some((n) => raw.includes(n))) return "";

  const layers = [];
  for (const n of raw) {
    if (isNoiseFolderName(n)) continue;
    if (ROOT_FOLDER_NAMES.includes(n)) continue;
    if (layers.length && layers[layers.length - 1] === n) continue; // 相邻同名（A/A）只留一层
    layers.push(n);
  }
  if (!layers.length) return ""; // 直接平铺在书签栏上：没有线索可用
  let s = layers.slice(0, maxDepth).map((n) => n.slice(0, 20)).join(" / ");
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s;
}

// 给一批书签构造 AI 请求体：{ id, title, url }（可选 folder 线索）。
// 返回 { items, hinted, total }，hinted 用于在界面上如实说明"这一轮有多少条带了线索"。
// 不修改入参对象 —— 原始 items 还要拿去复检删除判定，不能顺手加字段。
function attachFolderHints(items, opts) {
  let hinted = 0;
  const out = (items || []).map((it) => {
    const hint = buildFolderHint(it.folderPath, opts);
    const row = { id: it.id, title: it.title, url: it.url };
    if (hint) {
      row.folder = hint;
      hinted++;
    }
    return row;
  });
  return { items: out, hinted, total: out.length };
}

// 解析根书签文件夹的真实 id。
// value 支持配置里的 "1"/"2"/"3"（书签栏/其他书签/移动设备书签），
// 也兼容直接传真实 id。返回当前书签树中真实存在的根文件夹 id；找不到返回 null。
function resolveRootFolderId(value, tree) {
  const roots = (tree && tree[0] && tree[0].children) || [];
  if (!roots.length) return null;
  // 约定顺序：index 0=书签栏, 1=其他书签, 2=移动设备书签（Chrome/Edge 一致）
  const map = { "1": 0, "2": 1, "3": 2 };
  if (value != null && map[value] !== undefined && roots[map[value]]) {
    return roots[map[value]].id;
  }
  // 兜底：value 本身就可能是真实 id
  const asId = String(value);
  if (roots.some((r) => r.id === asId)) return asId;
  // 最后兜底：返回第一个根（书签栏）
  return roots[0].id;
}
