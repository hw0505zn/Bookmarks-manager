// 回归测试：空文件夹治理（popup/popup.js 的 collectFolderIds / saveOutputFolderIds /
// loadOutputFolderIds / reclaimEmptyOutputFolders + cleanupEmptyFolders）。
//
// 为什么单独一套用例：这条链路会**真的删文件夹**。而且要删的正是"看起来没用"的空夹 ——
// 一个判定失误，用户自己建的空文件夹就没了。所以除了"该删的删掉了"，更关键的是反向断言：
//   ★ 不在名单里的用户文件夹，哪怕空着也绝不能碰；
//   ★ 名单里的非空夹必须保留（并留在名单里等下次再查）；
//   ★ 名单里已经不存在（被合并/被删）的 id 要被清理出名单，否则名单越滚越长。
//
// 抽取方式与其它测试一致：从源码里 new Function 抽真实实现，配一套假 chrome.bookmarks + storage。
const fs = require("fs");
const DIR = "E:/AI应用/shuqian整理/";
const popupSrc = fs.readFileSync(DIR + "popup/popup.js", "utf8");

function extractFn(src, name) {
  const i1 = src.indexOf("async function " + name + "(");
  const i2 = src.indexOf("function " + name + "(");
  const start = i1 >= 0 && (i2 < 0 || i1 <= i2) ? i1 : i2;
  if (start < 0) throw new Error("未找到函数: " + name);
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const code =
  extractFn(popupSrc, "getBookmark") + "\n" +
  extractFn(popupSrc, "getChildren") + "\n" +
  extractFn(popupSrc, "removeTree") + "\n" +
  extractFn(popupSrc, "getRootFolderIds") + "\n" +
  extractFn(popupSrc, "cleanupEmptyFolders") + "\n" +
  extractFn(popupSrc, "collectFolderIds") + "\n" +
  extractFn(popupSrc, "saveOutputFolderIds") + "\n" +
  extractFn(popupSrc, "loadOutputFolderIds") + "\n" +
  extractFn(popupSrc, "reclaimEmptyOutputFolders") + "\n" +
  "module.exports = { collectFolderIds, saveOutputFolderIds, loadOutputFolderIds," +
  " reclaimEmptyOutputFolders, cleanupEmptyFolders, getBookmark, getChildren };";

// ---- 假书签树 ----
// 结构（刻意把三类"空文件夹"摆在同一个父目录下，一次跑完就能同时验证删对/留对）：
//   书签栏(1)
//     ├─ 开发技术(10)   用户自己建的空文件夹 —— 不在名单 → 绝不能删
//     ├─ 网文创作(20)   上一轮产物，已空 —— 在名单 → 应删
//     ├─ 工具效率(21)   上一轮产物，非空 —— 在名单 → 保留并留在名单
//     └─ 智能书签(30)   预览容器
//          ├─ 分类A(31) ── 子夹(32)
//          └─ 容器内平铺(b3，书签)
const NODE = {
  "0": { id: "0", title: "" },
  "1": { id: "1", title: "书签栏", parentId: "0" },
  "2": { id: "2", title: "其他书签", parentId: "0" },
  "3": { id: "3", title: "移动设备书签", parentId: "0" },
  "10": { id: "10", title: "开发技术", parentId: "1" },
  "20": { id: "20", title: "网文创作", parentId: "1" },
  "21": { id: "21", title: "工具效率", parentId: "1" },
  "30": { id: "30", title: "智能书签", parentId: "1" },
  "31": { id: "31", title: "分类A", parentId: "30" },
  "32": { id: "32", title: "子夹", parentId: "31" },
  // 一条 4 层的空壳链，专供 [7] 的"父先于子也必须回收"回归守卫（其余用例不碰它）
  "40": { id: "40", title: "链1", parentId: "1" },
  "41": { id: "41", title: "链2", parentId: "40" },
  "42": { id: "42", title: "链3", parentId: "41" },
  "43": { id: "43", title: "链4", parentId: "42" },
  "b1": { id: "b1", title: "工具站", url: "https://t.com", parentId: "21" },
  "b3": { id: "b3", title: "容器内平铺", url: "https://c.com", parentId: "30" }
};
let KIDS = {
  "0": ["1", "2", "3"],
  "1": ["10", "20", "21", "30", "40"],
  "21": ["b1"],
  "30": ["31", "b3"],
  "31": ["32"],
  "40": ["41"],
  "41": ["42"],
  "42": ["43"]
};
function snapshot(id) {
  const n = NODE[id];
  if (!n) return null;
  const sibs = KIDS[n.parentId] || [];
  return { id: n.id, title: n.title, url: n.url, parentId: n.parentId, index: sibs.indexOf(id) };
}
function removeSubtree(id) {
  const n = NODE[id];
  if (!n) return;
  if (KIDS[n.parentId]) KIDS[n.parentId] = KIDS[n.parentId].filter((x) => x !== id);
  for (const k of (KIDS[id] || []).slice()) removeSubtree(k);
  delete KIDS[id];
  delete NODE[id];
}

const fake = {
  __store: {},
  bookmarks: {
    get: (id, cb) => { const s = snapshot(id); cb(s ? [s] : []); },
    getChildren: (id, cb) => cb((KIDS[id] || []).map(snapshot)),
    removeTree: (id, cb) => { removeSubtree(id); cb(); },
    getTree: (cb) => cb([{ id: "0", title: "", children: (KIDS["0"] || []).map(snapshot) }])
  },
  storage: {
    local: {
      get: (k, cb) => cb(Object.assign({}, fake.__store)),
      set: (o, cb) => { fake.__store = Object.assign({}, fake.__store, o); if (cb) cb(); },
      remove: (k, cb) => { delete fake.__store[k]; if (cb) cb(); }
    }
  },
  runtime: { get lastError() { return undefined; } }
};

const m = { exports: {} };
new Function("module", "chrome", code)(m, fake);
const S = m.exports;

let total = 0, fails = 0;
function eq(actual, expected, label) {
  total++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ✓ " + label); return; }
  fails++;
  console.log("  ✗ " + label + "\n      期望 " + e + "\n      实际 " + a);
}
function ok(cond, label) { eq(!!cond, true, label); }
function alive(id) { return !!NODE[id]; }
function resetStore() { fake.__store = {}; }

(async () => {
  console.log("\n[1] collectFolderIds：只收文件夹、不收书签，且「浅 → 深」");
  {
    const ids = await S.collectFolderIds("30");
    eq(ids, ["31", "32"], "容器内的文件夹按浅→深列出（跳过容器自身与容器内的书签 b3）");
    eq(await S.collectFolderIds("21"), [], "只有书签（无子文件夹）时返回空数组");
  }

  console.log("\n[2] 名单读写：默认空数组、非数组脏数据安全降级");
  {
    resetStore();
    eq(await S.loadOutputFolderIds(), [], "从未写过 → 空数组（不是 null/undefined）");
    await S.saveOutputFolderIds(["a", "b"]);
    eq(await S.loadOutputFolderIds(), ["a", "b"], "原样往返");
    fake.__store.lastOutputFolderIds = "坏数据";
    eq(await S.loadOutputFolderIds(), [], "★ 存进去的是非数组（历史脏数据）→ 降级为空数组，不抛异常");
    await S.saveOutputFolderIds(null);
    eq(await S.loadOutputFolderIds(), [], "传 null 存成空数组");
  }

  console.log("\n[3] reclaimEmptyOutputFolders：名单里的空夹删掉、非空夹留下、失效 id 出名单");
  {
    resetStore();
    // 名单 = 上一轮容器子树里的全部文件夹（collectFolderIds 是「浅→深」全收）
    //   20 空的旧产物 / 21 非空旧产物 / 22 已不存在（被合并掉的） / 31 里面只剩一个空夹 32
    await S.saveOutputFolderIds(["20", "21", "22", "31", "32"]);
    const removed = await S.reclaimEmptyOutputFolders();
    eq(removed, 3, "★ 删掉 3 个（网文创作 20、最深处的子夹 32、被掏空的分类A 31）");
    ok(!alive("20"), "空的旧产物已被回收");
    ok(!alive("32"), "容器内最深处的空夹被回收");
    ok(!alive("31"), "★ 子夹删掉后父夹也变空 → 由 cleanupEmptyFolders 逐级向上回收（不依赖调用方按深度排序）");
    ok(alive("21"), "★ 非空旧产物保留（里面还有书签）");
    eq(await S.loadOutputFolderIds(), ["21"], "★ 名单收缩为「仍存在且是文件夹」的 id（22 本就不在、20/31/32 已被删）");
  }

  console.log("\n[4] ★ 安全边界：不在名单里的用户空文件夹，绝不触碰");
  {
    ok(alive("10"), "★ 用户自己建的空文件夹「开发技术」依然在（它不在名单里）");
    ok(alive("2") && alive("3"), "★ 三个书签根目录一个没少");
  }

  console.log("\n[5] 向上传播：容器被掏空后，容器本身也要被回收");
  {
    // 承接 [3] 的状态：31 已删，30 里只剩书签 b3 → 容器非空，仍保留
    ok(alive("30"), "容器里还有书签 → 容器保留（不能因为它是空容器就删，里面还有内容）");
    // 把容器里剩下的书签也移走，模拟"清零"后再回收容器自身
    delete NODE["b3"]; KIDS["30"] = [];
    await S.saveOutputFolderIds([]); // 名单空时也要能主动清容器？—— 不能，收回只认名单
    eq(await S.reclaimEmptyOutputFolders(), 0, "★ 名单为空 → 直接返回 0，绝不顺手删掉任何一个空夹");
    ok(alive("30"), "★ 空容器不在名单里 → 不删（安全边界再次验证）");
  }

  console.log("\n[6] 名单里含「根目录 id」时，根目录受到豁免（永不删）");
  {
    resetStore();
    await S.saveOutputFolderIds(["1", "2"]);
    const removed = await S.reclaimEmptyOutputFolders();
    eq(removed, 0, "★ 三个书签根即使被误写进名单，也不会被删");
    ok(alive("1") && alive("2"), "根目录安然无恙");
  }

  console.log("\n[7] 多层嵌套的空壳链：种子顺序「父先于子」也必须整条回收（回归守卫）");
  {
    resetStore();
    // collectFolderIds 的真实输出顺序就是「浅→深」= 父在子之前。
    // 旧实现用 seen 一票否决：父目录第一次检查时孩子还在 → 判「非空」跳过；
    // 孩子删掉后父目录重入队又被 seen 挡掉 → 父目录永远留成空壳（用户报的"一堆空文件夹"）。
    await S.saveOutputFolderIds(["40", "41", "42", "43"]);
    const removed = await S.reclaimEmptyOutputFolders();
    eq(removed, 4, "★ 4 层空壳链被一次全部回收（父目录可被重查的那个分支）");
    eq(["40", "41", "42", "43"].filter(alive), [], "四层全部不复存在（没有留下任何空壳）");
    ok(alive("1"), "根目录不受影响");
    eq(await S.loadOutputFolderIds(), [], "名单被清空（四个 id 都已不存在）");
  }

  console.log(`\n结果：${total - fails}/${total} 通过，失败 ${fails} 个`);
  process.exit(fails ? 1 : 0);
})();
