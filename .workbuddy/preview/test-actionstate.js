// 动作按钮状态机回归测试
//   抽 popup.js 里「动作按钮状态机」那一段源码，注入假 DOM / 假 storage 后执行。
//   要钉死的是三件事：
//     ① 「一屏只亮一个」——空闲时只有下一步亮，运行中只有正在跑的那一步亮
//        （历史 UI 问题：「生成预览」和「执行整理」同时亮着，看不出流程走到哪）
//     ② 运行期全部锁定 —— 旧实现只禁用了发起操作的那一个按钮，
//        扫描跑到一半照样能点「执行整理」，这是并发风险
//     ③ 预览就绪的判定必须与 organize 里那条守卫**同源**，
//        否则会出现「高亮引导用户去点一个注定被拒的按钮」
const fs = require("fs");
const path = require("path");

const POPUP = path.join(__dirname, "..", "..", "popup", "popup.js");
const src = fs.readFileSync(POPUP, "utf8");

function extractBlock(a, b) {
  const i = src.indexOf(a);
  if (i < 0) throw new Error("找不到起始标记：" + a);
  const j = src.indexOf(b, i);
  if (j < 0) throw new Error("找不到结束标记：" + b);
  return src.slice(i, j);
}
const body = extractBlock("// ---- 动作按钮状态机：一屏只亮一个 ----", "// ---- 动作按钮状态机结束 ----");

let total = 0, fails = 0;
function eq(actual, expected, msg) {
  total++;
  if (String(actual) !== String(expected)) {
    fails++;
    console.log(`  ✗ ${msg}\n      期望 ${expected}，实际 ${actual}`);
  }
}
function ok(cond, msg) {
  total++;
  if (!cond) { fails++; console.log("  ✗ " + msg); }
}

// ---- 假 DOM ----
class El {
  constructor(id) {
    this.id = id;
    this.disabled = false;
    this.attrs = {};
    this._cls = new Set();
  }
  get classList() {
    const s = this._cls;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      has: (c) => s.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !s.has(c) : !!on;
        if (want) s.add(c); else s.delete(c);
      }
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
}

const BTN_IDS = ["btnScan", "btnPreview", "btnOrganize", "btnUndo"];

// 每次调用造一套全新的环境：状态机内部有 busyStep / previewReady 两个闭包变量，
// 复用同一套会让用例之间互相污染，出问题时极难定位。
function make(opts) {
  opts = opts || {};
  const els = {};
  for (const id of BTN_IDS) els[id] = new El(id);
  const $ = (id) => els[id] || null;
  const stub = { src: opts.src || null, cfg: opts.cfg || {}, previewCalls: 0 };
  const loadPreviewSource = async () => { stub.previewCalls++; return stub.src; };
  const getConfig = async () => stub.cfg;
  const currentItems = new Array(opts.items || 0).fill(0).map((_, i) => ({ id: String(i) }));

  const mod = new Function(
    "$", "loadPreviewSource", "getConfig", "currentItems",
    body +
      "\n return { STEP_IDS, suggestedStep, actionButtonState, updateActionState, beginStep, endStep, refreshPreviewReady," +
      " shouldAssumeClassified," +
      " setClassified," +
      " getBusy: () => busyStep, getPreviewReady: () => previewReady, getHasClassified: () => hasClassified };"
  )($, loadPreviewSource, getConfig, currentItems);

  return {
    els,
    mod,
    stub,
    has(id, cls) { return els[id]._cls.has(cls); },
    stepCount() { return BTN_IDS.filter((id) => els[id]._cls.has("is-step")).length; },
    states() { return BTN_IDS.map((id) => (els[id]._cls.has("is-step") ? "L" : "-") + (els[id].disabled ? "X" : "o")).join(" "); }
  };
}

(async () => {
  console.log("=== A. 空闲时该高亮哪一步（纯函数）===");
  const S = make().mod.suggestedStep;
  eq(S(0, false), "scan", "没书签 → 先扫描");
  eq(S(0, true), "scan", "书签数为 0 时即使有旧快照也先扫描（快照多半是过期残留）");
  eq(S(5, false), "preview", "扫过但没预览 → 生成预览");
  eq(S(5, true), "organize", "有预览 → 执行整理");

  // 「还没扫描分类」这条是 2026-09-28 加的：弹窗改成打开不自动分类之后，
  // 会出现「统计数字已读到、甚至残留着上一轮预览快照，但分类结果还没有」的状态。
  // 此时若按老规则高亮「执行整理」，等于一打开弹窗就引导用户去点那个**会删原书签**的按钮。
  eq(S(5, true, false), "scan", "★ 未扫描分类 → 即使有旧预览快照，也高亮「扫描分类」");
  eq(S(5, false, false), "scan", "★ 未扫描分类且没预览 → 同样是「扫描分类」");
  eq(S(0, true, false), "scan", "未扫描分类且没书签 → 扫描");
  eq(S(5, true, true), "organize", "已分类 + 有预览 → 执行整理（显式传 true 与缺省一致）");
  eq(S(5, false, true), "preview", "已分类 + 无预览 → 生成预览");

  console.log("=== B. 按钮状态的纯计算 ===");
  const A = make().mod.actionButtonState;

  const idle = A(null, "preview");
  eq(idle.preview.step, true, "空闲：建议的那一步高亮");
  eq(idle.scan.step, false, "空闲：其它步骤不高亮");
  eq(Object.keys(idle).sort().join(","), "organize,preview,scan", "★ 只有三个主线步骤（去重已并入扫描流程，不再是独立步骤）");
  eq([idle.scan.disabled, idle.preview.disabled, idle.organize.disabled].join(","), "false,false,false", "空闲：三个按钮都可点");

  const running = A("organize", null);
  const lit = Object.keys(running).filter((k) => running[k].step);
  eq(lit.length, 1, "★ 运行中高亮按钮**恰好 1 个**（这就是「一屏只亮一个」的核心断言）");
  eq(lit[0], "organize", "高亮的正是正在跑的那一步");
  eq(running.organize.busy, true, "正在跑的那一步带 busy 标记（CSS 据此呼吸）");
  eq(running.scan.disabled, true, "运行中：其它按钮全部禁用");

  const undoing = A("undo", null);
  eq(Object.keys(undoing).filter((k) => undoing[k].step).length, 0, "撤销运行中：没有按钮高亮（undo 不在 STEP_IDS 里）");
  eq(undoing.organize.disabled, true, "★ 撤销运行中，动作按钮仍全部禁用（禁止整理与撤销并发）");

  const none = A(null, null);
  eq(Object.keys(none).filter((k) => none[k].step).length, 0, "建议为 null 时不误亮任何一个");

  console.log("=== C. 真实 DOM：空闲态 ===");
  const c1 = make({ items: 5, src: { ids: ["a"], organizeRoot: false }, cfg: { organizeRootItems: false } });
  c1.mod.setClassified(true); // 模拟「已经点过扫描分类」（下面这些用例描述的是扫描之后的状态）
  await c1.mod.refreshPreviewReady();
  c1.mod.updateActionState();
  eq(c1.has("btnOrganize", "is-step"), true, "★ 有预览 → 高亮「执行整理」");
  eq(c1.has("btnPreview", "is-step"), false, "此时「生成预览」退回描边幽灵");
  eq(c1.stepCount(), 1, "★ 空闲时全屏只有 1 个高亮按钮");
  eq(c1.els.btnScan.disabled, false, "空闲：扫描可点");
  eq(c1.els.btnOrganize.disabled, false, "空闲：执行整理可点（高亮但它本就可点）");
  eq(c1.has("btnOrganize", "is-busy"), false, "空闲：没有任何按钮处于运行态");

  console.log("=== D. 真实 DOM：运行态 ===");
  const c2 = make({ items: 5, src: { ids: ["a"] } });
  c2.mod.beginStep("scan");
  eq(c2.has("btnScan", "is-step"), true, "正在跑的那一步保持高亮");
  eq(c2.has("btnScan", "is-busy"), true, "并带 is-busy（CSS 据此加呼吸）");
  eq(c2.stepCount(), 1, "★ 运行中也只有 1 个高亮按钮");
  eq(c2.els.btnScan.disabled, true, "运行中：正在跑的那一步也禁用（防重复点击）");
  eq([c2.els.btnPreview.disabled, c2.els.btnOrganize.disabled].join(","), "true,true", "★ 运行中：其余按钮全部禁用（旧实现漏了这条）");
  eq(c2.els.btnScan.attrs["aria-current"], "step", "正在跑的那一步带 aria-current=step");
  eq(c2.els.btnUndo.disabled, true, "★ 运行期连「撤销」一起锁（禁止整理与撤销并发）");

  await c2.mod.endStep();
  eq(c2.mod.getBusy(), null, "收尾后 busyStep 清空");
  ok(!("aria-current" in c2.els.btnScan.attrs), "★ 跑完后 aria-current 必须清掉（残留会让读屏软件以为它还在跑）");
  eq(c2.has("btnScan", "is-busy"), false, "跑完后呼吸态移除");
  eq(c2.els.btnPreview.disabled, false, "收尾后按钮解冻");

  console.log("=== E. 空闲时不得覆盖撤销按钮的可用性 ===");
  const c3 = make({ items: 5 });
  c3.els.btnUndo.disabled = true; // 模拟「撤销栈为空」由 refreshUndoButton 设下的禁用
  c3.mod.updateActionState();
  eq(c3.els.btnUndo.disabled, true, "★ 空闲时 updateActionState 不碰 btnUndo（否则会把「没有可撤销操作」的禁用抹掉）");

  console.log("=== F. undo 作为 busy 的表现 ===");
  const c4 = make({ items: 5 });
  c4.mod.beginStep("undo");
  eq(c4.stepCount(), 0, "撤销没有自己的高亮按钮");
  eq(c4.els.btnOrganize.disabled, true, "★ 撤销运行中锁住动作按钮");
  eq(c4.els.btnUndo.disabled, true, "撤销自己也被锁");

  console.log("=== G. 预览是否「就绪」：与 organize 守卫同源 ===");
  const cases = [
    [{ src: null, cfg: {} }, false, "没有预览快照 → 未就绪"],
    [{ src: { ids: [], organizeRoot: false }, cfg: {} }, false, "★ 快照在但清单为空（执行整理后会清空）→ 未就绪"],
    [{ src: { ids: ["a"], organizeRoot: false }, cfg: { organizeRootItems: false } }, true, "清单有内容且根目录策略一致 → 就绪"],
    [{ src: { ids: ["a"], organizeRoot: true }, cfg: { organizeRootItems: true } }, true, "根目录参与整理时同理 → 就绪"],
    [
      { src: { ids: ["a"], organizeRoot: false }, cfg: { organizeRootItems: true } },
      false,
      "★ 生成预览后改了根目录开关 → 未就绪（organize 也会拒，引导与拦截必须说同一件事）"
    ],
    [
      { src: { ids: ["a"] }, cfg: { organizeRootItems: true } },
      true,
      "★ 老快照没记 organizeRoot → 不得误判成未就绪（organize 那条守卫有 typeof 检查，口径逐字同源）"
    ],
    // 2026-09-28 起不再做「预览内容指纹校验」：预览被手工改动过也照常就绪，
    // 改由执行前的确认面板把「哪些会变两份」摊开给用户，由他自己决定。
    // 这里钉死的是：预览被改过**不会**让按钮变灰（否则又是"拦了但不说为什么"）。
    [
      { src: { ids: ["a"], targetId: "t1", organizeRoot: false }, cfg: {} },
      true,
      "★ 预览被手工改动过 → 仍算就绪（不再静默拦截，交给确认面板说明后果）"
    ],
    [
      { src: { ids: ["a"], targetId: "t1", organizeRoot: false, fp: "x-1" }, cfg: {} },
      true,
      "★ 老快照里残留 fp 字段 → 不影响就绪判定（升级后旧预览不会被判失效）"
    ]
  ];
  for (const [opt, want, msg] of cases) {
    const r = make(opt);
    const got = await r.mod.refreshPreviewReady();
    eq(got, want, msg);
    eq(r.mod.getPreviewReady(), want, msg + "（previewReady 同步更新）");
  }

  console.log("=== H. 端到端：高亮随流程自动前移 / 回退 ===");
  const e1 = make({ items: 5, src: { ids: ["a"], organizeRoot: false }, cfg: { organizeRootItems: false } });
  e1.mod.setClassified(true);
  e1.mod.beginStep("preview");
  eq(e1.mod.getBusy(), "preview", "开始生成预览 → busyStep = preview");
  eq(e1.stepCount(), 1, "运行中只有 1 个高亮");
  await e1.mod.endStep();
  eq(e1.has("btnOrganize", "is-step"), true, "★ 预览成功后高亮自动前移到「执行整理」");

  const e2 = make({ items: 5, src: null, cfg: {} });
  e2.mod.setClassified(true);
  e2.mod.beginStep("preview");
  await e2.mod.endStep();
  eq(e2.has("btnPreview", "is-step"), true, "★ 预览失败/被拦下时高亮退回「生成预览」（不诱导用户去点执行）");
  eq(e2.has("btnOrganize", "is-step"), false, "此时「执行整理」不亮");

  const e3 = make({ items: 0, src: { ids: ["a"], organizeRoot: false }, cfg: { organizeRootItems: false } });
  await e3.mod.endStep();
  eq(e3.has("btnScan", "is-step"), true, "没扫到书签时 → 高亮回到「扫描并分类」");

  console.log("=== I. 纯状态机守卫：classified=false 时一律高亮「扫描分类」===");
  // ⚠ 定位变更（2026-09-29）：下面这段只在**状态机纯逻辑层面**成立 ——
  //   真实 init 现在会从持久化信号恢复 classified（见 J）。因此「有快照 + classified=false」
  //   这个组合已不再由 init 产生，本节退化为「万一恢复逻辑失效时的兜底守卫」。
  //   保留它是因为：suggestedStep 的 `!classified → scan` 仍是最后一道安全网——
  //   宁可把用户引回安全的扫描，也不要误亮那个会删原书签的按钮。
  const i1 = make({ items: 5, src: { ids: ["a"], organizeRoot: false }, cfg: { organizeRootItems: false } });
  eq(i1.mod.getHasClassified(), false, "纯状态机：classified 初始为 false");
  await i1.mod.refreshPreviewReady();
  i1.mod.updateActionState();
  eq(i1.mod.getPreviewReady(), true, "快照确实判定为「就绪」");
  eq(i1.has("btnScan", "is-step"), true, "classified=false 时高亮「扫描分类」（兜底守卫）");
  eq(i1.has("btnOrganize", "is-step"), false, "此时「执行整理」不高亮");
  eq(i1.stepCount(), 1, "仍然只有 1 个高亮");
  eq(i1.els.btnOrganize.disabled, false, "不高亮 ≠ 禁用：用户想直接点仍可点（只是不引导）");

  i1.mod.setClassified(true);
  i1.mod.updateActionState();
  eq(i1.has("btnOrganize", "is-step"), true, "置为已分类后高亮前移到「执行整理」");

  const i2 = make({ items: 5, src: null, cfg: {} });
  i2.mod.updateActionState();
  eq(i2.has("btnScan", "is-step"), true, "没预览且未分类 → 同样是「扫描分类」");

  console.log("=== J. 跨会话恢复「已分类」：重开弹窗不回退到扫描 ===");
  // 2026-09-29 修的 bug：点击「生成预览」后切走、再点开插件，
  // 高亮错误地回到「扫描分类」（应该停在下一步「执行整理」）。
  // 根因：hasClassified 是内存变量，弹窗关闭即清零；而预览快照 / 分类缓存是持久化的。
  const A2 = make().mod.shouldAssumeClassified;
  eq(A2(null, null), false, "没有任何持久化信号 → 不恢复（真·首次打开）");
  eq(A2({ cats: {} }, null), false, "分类缓存存在但为空 → 不算已分类");
  eq(A2(null, { ids: [] }), false, "预览快照存在但清单为空（执行整理后会清空）→ 不算已分类");
  eq(A2({ cats: { a: "c1" } }, null), true, "★ 有分类缓存 → 视为已分类（扫过分类但还没生成预览）");
  eq(A2(null, { ids: ["a"] }), true, "★ 有预览快照 → 视为已分类（生成过预览）");
  eq(A2({ cats: { a: "c1" } }, { ids: ["a"] }), true, "两者都有 → 已分类");

  // 端到端：模拟「生成预览后切走再打开」——持久化了预览快照，重开时应高亮「执行整理」
  const j1 = make({ items: 5, src: { ids: ["a"], organizeRoot: false }, cfg: { organizeRootItems: false } });
  const restored = j1.mod.shouldAssumeClassified({}, { ids: ["a"], organizeRoot: false });
  eq(restored, true, "★ 重开弹窗：从预览快照恢复出「已分类」");
  j1.mod.setClassified(restored);
  await j1.mod.refreshPreviewReady();
  j1.mod.updateActionState();
  eq(j1.has("btnOrganize", "is-step"), true, "★ 重开后高亮停在「执行整理」，不再打回「扫描分类」");
  eq(j1.has("btnScan", "is-step"), false, "「扫描分类」不再高亮");

  // 反例：执行整理后预览快照被清空、且没有分类缓存 → 应回到「扫描分类」（维护既有行为）
  const j2 = make({ items: 5, src: null, cfg: {} });
  const restored2 = j2.mod.shouldAssumeClassified(null, null);
  eq(restored2, false, "整理完成且无缓存 → 不恢复，回到扫描（保持既有行为）");

  console.log(`\n${fails ? "✗" : "✓"} 动作按钮状态机测试：${total - fails}/${total} 通过`);
  if (fails) process.exitCode = 1;
})();
