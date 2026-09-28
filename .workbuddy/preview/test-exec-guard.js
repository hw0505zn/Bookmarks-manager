// 回归测试：执行整理前的「现状复检」（popup/popup.js 的 selectDeletable）与清单写入语义
// （savePreviewSource 覆盖式写入）。
//
// 为什么必须有这套用例：这是唯一会把用户的**真实书签删掉**的地方。
// 预览生成到用户点执行之间，用户可以任意增删 / 移动 / 钉根目录书签，而清单（previewSourceIds）
// 只记 id、不记现状。复检少一条分支的后果不是「结果难看」，而是「内容没了」。
// 所以每条过滤规则都要有断言，尤其是「两个条件同时成立」和「全被过滤掉」的边界。
const fs = require("fs");
const DIR = "E:/AI应用/shuqian整理/";
const bmSrc = fs.readFileSync(DIR + "js/bookmarks.js", "utf8");
const popupSrc = fs.readFileSync(DIR + "popup/popup.js", "utf8");

// 抽取函数源码。⚠ 必须先找 `async function`：async 函数的 `await` 一旦丢掉 async 关键字
// 就是语法错误，而 `indexOf("function name(")` 会正好切在 "async " 之后。
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

const keyConst = (popupSrc.match(/const PREVIEW_SRC_KEY = [^;]+;/) || [])[0];
if (!keyConst) throw new Error("未找到 PREVIEW_SRC_KEY");

const code =
  keyConst + "\n" +
  extractFn(bmSrc, "normalizeUrl") + "\n" +
  extractFn(popupSrc, "hashString") + "\n" +
  extractFn(popupSrc, "briefList") + "\n" +
  extractFn(popupSrc, "selectDeletable") + "\n" +
  extractFn(popupSrc, "loadPreviewSource") + "\n" +
  extractFn(popupSrc, "savePreviewSource") + "\n" +
  "module.exports = { normalizeUrl, briefList, selectDeletable, loadPreviewSource, savePreviewSource };";

const fake = {
  __store: {},
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
const { normalizeUrl, briefList, selectDeletable, loadPreviewSource, savePreviewSource } = m.exports;

// ---- 断言工具 ----
let total = 0, fails = 0;
function eq(actual, expected, label) {
  total++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ✓ " + label); return; }
  fails++;
  console.log("  ✗ " + label + "\n      期望 " + e + "\n      实际 " + a);
}
function ok(cond, label) { eq(!!cond, true, label); }

// ---- 造数据 ----
const ROOT_ID = "1";     // 书签栏根目录
const FOLDER = "100";    // 某个分类文件夹
const B = (id, url, parentId) => ({ id, title: "书签" + id, url, parentId });
const ids = (list) => list.map((x) => x.id);
const urls = (...list) => new Set(list.map((u) => normalizeUrl(u)));

console.log("\n[1] 正常情形：在文件夹里 + 预览里有副本 → 全部可删");
{
  const c = [B("a", "https://a.com/", FOLDER), B("b", "https://b.com/", "101")];
  const r = selectDeletable(c, ROOT_ID, urls("https://a.com/", "https://b.com/"), normalizeUrl);
  eq(ids(r.toDelete), ["a", "b"], "两个都可删");
  eq(ids(r.pinnedItems), [], "无跳过");
  eq(ids(r.lostItems), [], "无副本缺失");
}

console.log("\n[2] 预览后被钉到根目录 → 不删（用户明确要它一键可达）");
{
  const c = [B("a", "https://a.com/", ROOT_ID), B("b", "https://b.com/", FOLDER)];
  const r = selectDeletable(c, ROOT_ID, urls("https://a.com/", "https://b.com/"), normalizeUrl);
  eq(ids(r.toDelete), ["b"], "只删没被钉住的那个……");
  eq(ids(r.pinnedItems), ["a"], "……被钉住的那个进 pinnedItems");
}

console.log("\n[3] 预览里副本已被删掉 → 不删（删了就真没了）");
{
  const c = [B("a", "https://a.com/", FOLDER), B("b", "https://b.com/", FOLDER)];
  const r = selectDeletable(c, ROOT_ID, urls("https://a.com/"), normalizeUrl);
  eq(ids(r.toDelete), ["a"], "只删副本还在的那个……");
  eq(ids(r.lostItems), ["b"], "……副本缺失的进 lostItems");
}

console.log("\n[4] 两个条件同时成立（钉根目录 且 副本缺失）→ 只归 pinned，不重复计数");
{
  const c = [B("a", "https://a.com/", ROOT_ID)];
  const r = selectDeletable(c, ROOT_ID, urls(), normalizeUrl);
  eq(ids(r.toDelete), [], "不可删");
  eq(ids(r.pinnedItems), ["a"], "归于 pinnedItems");
  eq(ids(r.lostItems), [], "不会被两个集合同时收录（否则日志会重复计数）");
}

console.log("\n[5] 全被过滤 → toDelete 为空（调用方据此拒绝执行，避免结构重复/内容丢失）");
{
  const c = [B("a", "https://a.com/", ROOT_ID), B("b", "https://b.com/", FOLDER)];
  const r = selectDeletable(c, ROOT_ID, urls(), normalizeUrl);
  eq(ids(r.toDelete), [], "没有任何可安全删除的项");
  eq(r.pinnedItems.length + r.lostItems.length, c.length, "candidates 全部被归入两个跳过集合");
}

console.log("\n[6] URL 归一化：带斜杠 / 大写主机 / 追踪参数也能匹配上副本");
{
  const c = [
    B("a", "https://A.com/page/?utm_source=x", FOLDER),
    B("b", "https://b.com/page", FOLDER)
  ];
  const r = selectDeletable(c, ROOT_ID, urls("https://a.com/page", "https://b.com/page/"), normalizeUrl);
  eq(ids(r.toDelete), ["a", "b"], "归一化后两边可匹配（否则会误判成「副本缺失」而不敢删）");
}

console.log("\n[7] 重复书签：同 URL 两个 id，预览里只有一份副本 → 两个都可删（只留一份）");
{
  const c = [B("a1", "https://x.com/", FOLDER), B("a2", "https://x.com/", "102")];
  const r = selectDeletable(c, ROOT_ID, urls("https://x.com/"), normalizeUrl);
  eq(ids(r.toDelete), ["a1", "a2"], "同 URL 的两条都被视为「有副本」");
}

console.log("\n[8] 解析不到根目录（rootParentId 为 null）→ 不做 pinned 判定，只看副本");
{
  const c = [B("a", "https://a.com/", ROOT_ID)];
  const r = selectDeletable(c, null, urls("https://a.com/"), normalizeUrl);
  eq(ids(r.toDelete), ["a"], "不因「在根目录」而误判为不可删（退化为旧行为，不凭空加规则）");
}

console.log("\n[9] briefList：日志里的标题清单，超过上限要折叠计数");
{
  eq(briefList([{ title: "甲" }, { title: "乙" }]), "甲、乙", "两个直接列出");
  eq(briefList([{ title: "1" }, { title: "2" }, { title: "3" }, { title: "4" }, { title: "5" }, { title: "6" }]),
    "1、2、3、4、5 等6个", "超过 5 个折叠计数");
  eq(briefList([{ id: "x9" }]), "x9", "没有 title/url 时退回 id");
}

console.log("\n[10] 开启「根目录书签也参与整理」→ 不再保护根目录（protectRoot=false）");
{
  const c = [B("a", "https://a.com/", ROOT_ID), B("b", "https://b.com/", FOLDER)];
  const r = selectDeletable(c, ROOT_ID, urls("https://a.com/", "https://b.com/"), normalizeUrl, false);
  eq(ids(r.toDelete), ["a", "b"], "根目录上的那个也照删（用户主动选择让它参与整理）");
  eq(ids(r.pinnedItems), [], "保护关闭时 pinned 恒为空——否则会出现「勾了选项却一个根目录书签都不删」的静默失效");
  eq(ids(r.lostItems), [], "副本都在");
}

console.log("\n[11] 保护关闭时，「副本缺失不删」这条必须仍然生效（两条保护不能一起关）");
{
  const c = [B("a", "https://a.com/", ROOT_ID), B("b", "https://b.com/", ROOT_ID)];
  const r = selectDeletable(c, ROOT_ID, urls("https://a.com/"), normalizeUrl, false);
  eq(ids(r.toDelete), ["a"], "预览里仍有副本的可删");
  eq(ids(r.lostItems), ["b"], "副本已被用户删掉的不删——这条与根目录无关，纯粹是防丢数据");
}

console.log("\n[12] protectRoot 默认 true：旧调用方式（不传该参数）行为完全不变");
{
  const c = [B("a", "https://a.com/", ROOT_ID)];
  const r = selectDeletable(c, ROOT_ID, urls("https://a.com/"), normalizeUrl);
  eq(ids(r.pinnedItems), ["a"], "默认仍保护根目录");
  eq(ids(r.toDelete), [], "默认不删它");
}

console.log("\n[13] savePreviewSource 是覆盖写入，不是取并集（并记录 organizeRoot）");
(async () => {
  await savePreviewSource("t1", [1, 2]);
  let s = await loadPreviewSource();
  eq(s.ids.join(","), "1,2", "首次写入原样保存");
  eq(s.organizeRoot, false, "不传第三参时 organizeRoot 落为 false（默认不整理根目录）");

  await savePreviewSource("t1", [3]);
  s = await loadPreviewSource();
  eq(s.ids.join(","), "3", "第二次写入覆盖上一次（累加会让失效 id 残留 → 误删）");

  await savePreviewSource("t1", [1, 1, 2]);
  s = await loadPreviewSource();
  eq(s.ids.join(","), "1,2", "同一批内的重复 id 去重");

  eq(s.targetId, "t1", "targetId 一并写入");

  await savePreviewSource("t1", [1], true);
  s = await loadPreviewSource();
  eq(s.organizeRoot, true, "开启参与时记录 true——执行阶段据此决定是否保护根目录");

  await savePreviewSource("t2", [1], false);
  s = await loadPreviewSource();
  eq(s.organizeRoot, false, "再次关闭后记录 false（覆盖，不会残留上一轮的 true）");

  eq("fp" in s, false,
    "★ 快照不再存预览指纹：2026-09-28 起改为「执行前弹确认面板把清单摊开给用户」，" +
    "不再静默拦截——拦下来却不说明哪里不对，等于逼用户猜");

  console.log("\n[14] selectDeletable 的分组结果 = 确认面板要展示的三类");
  {
    // 确认面板靠这三组数字告诉用户「删哪些、留哪些、哪些会变两份」，
    // 所以分组必须互斥且无遗漏：任何一条候选只能落进其中一组。
    const ROOT = "0";
    const c = [
      { id: "del", url: "https://a.com/", parentId: "f1" },   // 有副本、不在根 → 删
      { id: "pin", url: "https://b.com/", parentId: ROOT },   // 钉根目录 → 留
      { id: "lost", url: "https://c.com/", parentId: "f1" }   // 预览里没副本 → 留（且会重复）
    ];
    const r = selectDeletable(c, ROOT, urls("https://a.com/"), normalizeUrl, true);
    eq(ids(r.toDelete), ["del"], "可删的进 toDelete");
    eq(ids(r.pinnedItems), ["pin"], "钉根目录的进 pinnedItems");
    eq(ids(r.lostItems), ["lost"], "★ 找不到副本的进 lostItems（面板会标红提示「整理后会变两份」）");
    eq(r.toDelete.length + r.pinnedItems.length + r.lostItems.length, c.length,
      "★ 三组互斥且覆盖全部候选：确认面板的数字不会重复计或漏计");
  }

  console.log(`\n结果：${total - fails}/${total} 通过，失败 ${fails} 个`);
  if (fails) process.exitCode = 1;
})();
