// 回归测试：直接抽取 popup.js 中的真实函数/代码段执行，避免"测试抄写版"与源码不一致。
// 覆盖：近义标签合并（P2）、单例标签先并入（P3）、层级结构保留（P4）、
//       ★ 绝不生成兜底子文件夹、太碎标签处置、超限归并、两级索引映射。
// 说明：原有的 P5「待整理」兜底文件夹已按作者要求删除，本文件保留它的**反向断言** ——
//       任何"凭空多出一个容器文件夹"的行为都会在这里被打红。
const fs = require("fs");
const SRC = "E:/AI应用/shuqian整理/popup/popup.js";
const src = fs.readFileSync(SRC, "utf8");

function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("未找到函数: " + name);
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
function extractBlock(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error("未找到代码段: " + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error("未找到代码段结束标记: " + endMark);
  return src.slice(a, b);
}
// 常量必须一起抽：planLayer 依赖 SIM_MERGE_THRESHOLD / SUBS_KEEP_MIN，
// 漏抽会得到 ReferenceError（这本身就是一道防线：常量改名会立刻打红测试）。
function extractConst(name) {
  const m = src.match(new RegExp("^const " + name + " = [^;]+;", "m"));
  if (!m) throw new Error("未找到常量: " + name);
  return m[0];
}

const helpers =
  extractConst("SIM_MERGE_THRESHOLD") + "\n" +
  extractConst("SUBS_KEEP_MIN") + "\n" +
  extractFn("labelSimilarity") + "\n" +
  extractFn("mergeSimilarLabels") + "\n" +
  extractFn("planLayer");
const m = { exports: {} };
new Function("module", helpers + "\nmodule.exports = { planLayer, mergeSimilarLabels, labelSimilarity, SIM_MERGE_THRESHOLD, SUBS_KEEP_MIN };", )(m);
const { planLayer, mergeSimilarLabels, labelSimilarity, SIM_MERGE_THRESHOLD, SUBS_KEEP_MIN } = m.exports;

const convergeBody = extractBlock("    // ---- 逐层收敛", "    const subFolderCache = {};");
// currentFreq 是 buildPreview 里的全局高频书签集合，测试里当参数注入
const converge = new Function(
  "pending", "cfg", "minSubSize", "maxSubs", "planLayer", "currentFreq",
  convergeBody + "\n  return { pending, mergedSubs, aloneSubs, droppedSubs, dissolvedSubs, keptStructSubs, groupedSubs, skippedSubCats, merged3, dropped3, dissolved3, freqFlattened };"
);

let fails = 0, total = 0;
function eq(actual, expected, label) {
  total++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { fails++; console.log(`  ✗ ${label}\n      期望 ${e}\n      实际 ${a}`); }
  else console.log(`  ✓ ${label}`);
}
function ok(cond, label) { total++; if (cond) console.log(`  ✓ ${label}`); else { fails++; console.log(`  ✗ ${label}`); } }
function mk(labels) { return labels.map((l) => ({ label: l })); }
// 把 assign 数成 { 标签: 个数 }，便于断言"谁承载了多少书签"
function tally(assign) {
  const c = {};
  for (const a of assign) c[a] = (c[a] || 0) + 1;
  return c;
}

console.log("\n[1] 太碎标签：不足 minItems 的标签不独立成夹，书签平铺在本级");
{
  const r = planLayer(mk(["A", "A", "A", "A", "A", "B", "C"]), 2, 5);
  eq(r.assign, ["A", "A", "A", "A", "A", "", ""], "5个A建夹；B/C 各1个 → 平铺在分类文件夹本级");
  eq([r.dropped, r.alone, r.dissolved, r.kept], [2, 2, 0, 0], "dropped=2 / alone=2；本层已有平铺 → 规则⑤不介入");
}

console.log("\n[2] 规则④：全被分进子文件夹且子夹 ≥3 → 解散书签数最少的那一个");
{
  const r = planLayer(mk(["A", "A", "A", "B", "B", "B", "C", "C", "C", "C"]), 2, 5);
  const t = tally(r.assign);
  eq(t["A"], undefined, "A（3个，并列时名称序最小）被解散");
  eq([t["B"], t["C"], t[""]], [3, 4, 3], "B/C 保留，A 的 3 个平铺到本级");
  eq([r.dissolved, r.kept], [1, 0], "dissolved=1 / kept=0");
}

console.log("\n[3] P4：子文件夹只有 1~2 个时不解散（那本来就是合理结构）");
{
  const r2 = planLayer(mk(["A", "A", "A", "B", "B", "B"]), 2, 5);
  eq(r2.assign, ["A", "A", "A", "B", "B", "B"], "只有 2 个子夹 → 保留（旧行为会解散 A）");
  eq([r2.dissolved, r2.kept, r2.thin], [0, 1, 1], "dissolved=0 / kept=1 / thin=1（因结构过少）");

  const r1 = planLayer(mk(["AI工具", "AI工具", "AI工具"]), 2, 5);
  eq(r1.assign, ["AI工具", "AI工具", "AI工具"], "只有 1 个子夹 → 保留（旧行为是整层推平）");
  eq([r1.dissolved, r1.kept], [0, 1], "dissolved=0 / kept=1");

  // 真实事故复现：「开发技术」55 个书签全被 AI 打成同一个标签
  const dev = mk(new Array(55).fill("AI工具"));
  const after = planLayer(dev, 2, 5);
  eq(after.assign.filter((x) => x === "AI工具").length, 55, "★ 55 个全部落在二级「AI工具」下（不再整类平铺）");
}

console.log("\n[4] P2：同义标签先合并，不各占名额");
{
  // 真实事故：开发技术 296 个书签被 AI 打成 29 种标签，其中「代码托管」「代码托管平台」互为子串
  const full = {
    "代码托管": 40, "代码托管平台": 30, "前端框架": 25, "容器镜像": 20, "构建工具": 15, "正则工具": 12
  };
  // 对照：不做合并（阈值调到 >1）时，6 个标签各占一个名额
  const g0 = mergeSimilarLabels(new Map(Object.entries(full)), 2);
  eq(g0.groups.size, 6, "对照：不合并时 6 个标签各占一个名额");
  eq(g0.groups.get("代码托管").count, 40, "对照：「代码托管」只有 40 个，那 30 个被当成独立标签");

  const g1 = mergeSimilarLabels(new Map(Object.entries(full)), SIM_MERGE_THRESHOLD);
  eq(g1.groups.size, 5, "★ 合并后只剩 5 个主题组");
  eq(g1.groups.get("代码托管").count, 70, "★「代码托管平台」并入「代码托管」→ 70 个");
  eq(g1.rep.get("代码托管平台"), "代码托管", "★ 成员标签必须能映射回代表（缺这一步这批书签会静默丢归属）");
  ok(g1.groups.has("正则工具"), "★「正则工具」保住了自己的名额（不合并时它会被挤成超限）");

  // 端到端锁死"合并后成员书签不丢"这个不变量
  const rMerge = planLayer(mk([...new Array(8).fill("代码托管"), ...new Array(6).fill("代码托管平台")]), 2, 5);
  eq(tally(rMerge.assign)["代码托管"], 14, "★ 合并后 14 个书签全部落到代表标签");
  eq(tally(rMerge.assign)[""], undefined, "没有书签因为合并而变成无归属");

  // 端到端：再加两个孤例标签 —— 它们平铺，且不能把已归好类的主题挤掉
  const entries = [];
  for (const [k, n] of Object.entries(full)) for (let i = 0; i < n; i++) entries.push(k);
  entries.push("马场", "菜谱");
  const r = planLayer(mk(entries), 2, 5);
  const t = tally(r.assign);
  eq(r.grouped, 1, "grouped=1（合并掉 1 个同义标签）");
  eq(t["代码托管"], 70, "★ 合并后「代码托管」承载 70 个");
  eq([t["前端框架"], t["容器镜像"], t["构建工具"], t["正则工具"]], [25, 20, 15, 12], "★ 5 个名额真的留给了 5 个不同主题");
  eq(t[""], 2, "两个孤例书签平铺在本级");
  // 注意：eq 会对实际值 .sort()，默认按 UTF-16 码点排（代U+4EE3 < 前U+524D），期望值也须按此序书写
  eq(Object.keys(t).sort(), ["", "代码托管", "前端框架", "容器镜像", "构建工具", "正则工具"],
    "★ 产生的容器名只有这 5 个主题 —— 没有任何兜底文件夹");
}

console.log("\n[5] P3：单例标签先尝试并入，而不是直接扔");
{
  // 互为子串 → 在①合并阶段就并成一组
  const r = planLayer(mk([...new Array(28).fill("前端框架"), "前端框架库"]), 2, 5);
  eq(r.grouped, 1, "★ 单例「前端框架库」并入「前端框架」（互为子串）");
  eq(tally(r.assign)["前端框架"], 29, "并成 29 个");
  eq(r.alone, 0, "没有标签变成孤例");

  // 非子串但共享字（相似度 0.4）→ 在③归并阶段并入已选主题，而不是平铺
  const r2 = planLayer(mk([...new Array(20).fill("前端开发"), "前端工程师"]), 2, 5);
  ok(labelSimilarity("前端工程师", "前端开发") > 0.3 && labelSimilarity("前端工程师", "前端开发") < 0.75, "（前提：「前端工程师」与「前端开发」相似但不构成子串）");
  eq(r2.merged, 1, "★ 单例按相似度并入已选主题（旧行为：直接平铺）");
  eq(tally(r2.assign)["前端开发"], 21, "并成 21 个");
  eq(r2.alone, 0, "没有标签变成孤例");
}

console.log("\n[6] ★ 不生成任何兜底文件夹：归不进任何标签的一律平铺在本级");
{
  // 10 个全单例 → 没有任何主题组 → 全平铺
  const r = planLayer(mk(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]), 2, 5);
  eq(r.assign, ["", "", "", "", "", "", "", "", "", ""], "全是单例标签 → 全部平铺");
  eq([r.alone, r.dropped, r.merged], [10, 10, 0], "alone=10 / dropped=10 / merged=0");

  // 有主题 + 少量孤例 → 孤例平铺，绝不塞进一个新容器
  const r2 = planLayer(mk([...new Array(20).fill("主题"), "马场", "菜谱"]), 2, 5);
  const t = tally(r2.assign);
  eq([t["主题"], t[""]], [20, 2], "主题成夹，2 个孤例平铺在本级");
  eq(Object.keys(t).sort(), ["", "主题"], "★ 只产生了「主题」这一个文件夹 —— 没有凭空多出来的容器");
  eq([r2.dissolved, r2.kept], [0, 0], "本层已有直接书签 → 规则④不介入");

  // 孤例恰好一半、或超过一半，行为必须一致：都平铺（旧实现会在这条边界上启用兜底）
  const half = planLayer(mk([...new Array(6).fill("主题"), "a", "b", "c", "d", "e", "f"]), 2, 5);
  eq([tally(half.assign)["主题"], tally(half.assign)[""]], [6, 6], "★ 孤例恰好一半 → 照样平铺");
  const over = planLayer(mk([...new Array(5).fill("主题"), "a", "b", "c", "d", "e", "f", "g"]), 2, 5);
  eq([tally(over.assign)["主题"], tally(over.assign)[""]], [5, 7], "★ 孤例超过一半 → 照样平铺");

  // 整层都没标签 → 不建任何夹
  const r4 = planLayer(mk(["", "", "", ""]), 2, 5);
  eq(r4.assign, ["", "", "", ""], "整层都没标签 → 全部平铺");
}

console.log("\n[7] 结构保留：本层全是子文件夹但有 3 个以上 → 解散最小的");
{
  const two = [...new Array(20).fill("A"), ...new Array(15).fill("B")];
  const r = planLayer(mk(two), 2, 5);
  eq([tally(r.assign)["A"], tally(r.assign)["B"]], [20, 15], "2 个主题完好");
  eq([r.dissolved, r.kept, r.thin], [0, 1, 1], "★ 2 个子夹 → 保留结构（thin=1）");

  const three = [...new Array(20).fill("A"), ...new Array(15).fill("B"), ...new Array(10).fill("C")];
  const r2 = planLayer(mk(three), 2, 5);
  const t2 = tally(r2.assign);
  eq([t2["A"], t2["B"], t2["C"]], [20, 15, undefined], "3 个子夹 → 解散书签数最少的 C");
  eq(t2[""], 10, "C 的 10 个平铺到本级（保证本级能直接点到东西）");
  eq([r2.dissolved, r2.kept], [1, 0], "dissolved=1 / kept=0");
}

console.log("\n[8] 高频书签：强制平铺在分类一级目录，覆盖 planLayer 给出的二级归属");
{
  const mkPending = () => [
    { bm: { id: "x1" }, catId: "c1", subLabel: "A", subSubLabel: "" },
    { bm: { id: "x2" }, catId: "c1", subLabel: "A", subSubLabel: "" },
    { bm: { id: "x3" }, catId: "c1", subLabel: "A", subSubLabel: "" },
    { bm: { id: "x4" }, catId: "c1", subLabel: "", subSubLabel: "" }
  ];
  // 本组只检验"高频覆盖二级归属"这一件事，与分类规则无关
  const cfg = { method: "ai", enableThirdLevel: false, minSubFolderItems: 2 };

  const base = converge(mkPending(), cfg, 0, 5, planLayer, new Set());
  eq(base.pending.map((p) => p.subLabel), ["A", "A", "A", ""], "对照组：无高频时 x1~x3 进二级 A");
  eq(base.freqFlattened, 0, "对照组 freqFlattened=0");

  const out = converge(mkPending(), cfg, 0, 5, planLayer, new Set(["x1"]));
  eq(out.pending.map((p) => p.subLabel), ["", "A", "A", ""], "高频 x1 被平铺到分类一级");
  eq(out.freqFlattened, 1, "freqFlattened=1");
  eq(out.pending.length, 4, "条目数不变（无索引错位）");
}

console.log("\n[9] 两级收敛的索引映射（真实 buildPreview 代码段）");
{
  const pending = [
    { catId: "c1", subLabel: "A", subSubLabel: "x" },
    { catId: "c1", subLabel: "A", subSubLabel: "x" },
    { catId: "c1", subLabel: "A", subSubLabel: "y" },
    { catId: "c1", subLabel: "B", subSubLabel: "p" },
    { catId: "c1", subLabel: "B", subSubLabel: "p" },
    { catId: "c1", subLabel: "B", subSubLabel: "q" }
  ];
  const cfg = { method: "ai", enableThirdLevel: true, minSubFolderItems: 2 };
  const out = converge(pending, cfg, 0, 5, planLayer, new Set());
  // 二级：A/B 各 3 个 → 全被分进子夹，但只有 2 个子夹 → P4 保留
  eq(out.pending.map((p) => p.subLabel), ["A", "A", "A", "B", "B", "B"], "二级：A/B 都保留（2 个子夹不解散）");
  eq([out.dissolvedSubs, out.keptStructSubs], [0, 1], "二级 dissolved=0 / keptStructSubs=1");
  // 三级：A 组（x/x/y）与 B 组（p/p/q）各自细分；y 与 q 都只有 1 个书签 → 规则①不建
  // 注意 A 组在 P4 下不再被解散，所以三级细分这次也会在 A 组内跑 —— 这正是新行为的正确结果
  eq(out.pending.map((p) => p.subSubLabel), ["x", "x", "", "p", "p", ""], "三级：x/p 保留，单例的 y/q 平铺");
  eq(out.dropped3, 2, "三级 dropped=2（y 和 q 各只有 1 个书签）");
  eq(out.dissolved3, 0, "三级已有直接书签，规则④未触发");
  eq(out.pending.length, 6, "两级处理后条目数不变（索引映射无错位）");
  const bad = out.pending.filter((p) => !p.subLabel && p.subSubLabel).length;
  eq(bad, 0, "上浮到分类文件夹的条目已清空三级标签");
}

console.log("\n[10] 一级收敛接线：孤例平铺的计数与同义合并的计数确实从 buildPreview 传下去了");
{
  const cfg = { method: "ai", enableThirdLevel: false, minSubFolderItems: 2 };
  const big = new Array(12).fill(0).map(() => ({ bm: {}, catId: "c1", subLabel: "AI工具", subSubLabel: "" }));
  const out = converge(big, cfg, 10, 5, planLayer, new Set());
  eq(out.pending.every((p) => p.subLabel === "AI工具"), true, "12 个书签（≥10）全部保留在二级「AI工具」下");
  eq(out.keptStructSubs, 1, "keptStructSubs=1");
  eq(out.skippedSubCats, 0, "分类书签数够，没走 skip 分支");

  const small = new Array(5).fill(0).map(() => ({ bm: {}, catId: "c2", subLabel: "AI工具", subSubLabel: "" }));
  const out2 = converge(small, cfg, 10, 5, planLayer, new Set());
  eq(out2.pending.every((p) => p.subLabel === ""), true, "5 个书签（<10）直接平铺，细分不介入");
  eq([out2.skippedSubCats, out2.keptStructSubs], [1, 0], "skippedSubCats=1 / keptStructSubs=0");

  // 混入一个孤例标签 → 平铺，且不产生任何新文件夹
  // （必须与前面同一个 catId：分类内书签数不足 minSubSize 时整类不细分，孤例会走另一条分支而不入 planLayer）
  const mix = big.concat([{ bm: {}, catId: "c1", subLabel: "偶发", subSubLabel: "" }]);
  const out3 = converge(mix, cfg, 10, 5, planLayer, new Set());
  eq(out3.pending.filter((p) => p.subLabel === "").length, 1, "★ 孤例标签的书签平铺在本级（不生成兜底文件夹）");
  eq(out3.pending.filter((p) => p.subLabel === "AI工具").length, 12, "12 个正常书签不受影响");
  eq(out3.aloneSubs, 1, "aloneSubs=1（如实上报）");

  // 同义标签在真实路径上也会先合并
  const same = new Array(8).fill(0).map(() => ({ bm: {}, catId: "c7", subLabel: "代码托管", subSubLabel: "" }))
    .concat(new Array(6).fill(0).map(() => ({ bm: {}, catId: "c7", subLabel: "代码托管平台", subSubLabel: "" })));
  const out4 = converge(same, cfg, 10, 5, planLayer, new Set());
  eq(out4.groupedSubs, 1, "★ 同义标签合并的计数传上来了");
  eq(out4.pending.every((p) => p.subLabel === "代码托管"), true, "14 个全部归到「代码托管」");
}

console.log("\n[11] AI 没给标签的书签：平铺在分类文件夹本级");
{
  const r = planLayer(mk([...new Array(12).fill("主题"), "", "", ""]), 2, 5);
  eq([tally(r.assign)["主题"], tally(r.assign)[""]], [12, 3], "★ 12 个有标签的成夹，3 个无标签的平铺");
  eq(r.alone, 0, "无标签不计入 alone（alone 只统计「有标签但没位置」的）");

  const r2 = planLayer(mk([...new Array(5).fill("主题"), "", "", "", "", "", ""]), 2, 5);
  eq(tally(r2.assign)[""], 6, "无标签占多数时照样平铺，让问题一眼可见");
}

console.log(`\n结果：${total - fails}/${total} 通过，失败 ${fails} 个`);
process.exit(fails ? 1 : 0);
