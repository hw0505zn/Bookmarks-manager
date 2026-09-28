// UI 预览器：把**真实的** popup/options 页面渲染成可截图的静态 HTML（浅色 / 深色各一份）。
//
// 为什么需要它：
//   1. 这是浏览器扩展，popup/options 必须装进 Chrome 才能打开 —— 改完样式没有"直接看一眼"的办法；
//   2. 主题靠 `@media (prefers-color-scheme: dark)`，而把 PNG 拿去比就知道
//      Chrome 的 `--blink-settings=preferredColorScheme` 开关**实测无效**（两种配色截图像素级相同），
//      所以只能把真实 CSS 读进来、机械改写那条媒体查询后再内联 —— 不复制调色板，永远跟着源码走；
//   3. 弹窗的内容是 JS 渲染的（统计/分类分布/微调列表），空壳截图看不出问题，
//      所以这里配一个假 chrome（书签树 + 浏览历史 + storage），让 popup.js 真的跑一遍 scan()。
//
// 产物：.workbuddy/preview/ui/{popup,options}-{light,dark}.html
// 用法：node ui-shot.js            仅生成 HTML
//       node ui-shot.js --shot     生成后调无头 Chrome 截图（需要本机有 Chrome）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(__dirname, "ui");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

// ── 假书签树（够真就行：有层级、有重复、有根目录平铺） ──
const TREE = [
  {
    id: "0", title: "", children: [
      {
        id: "1", title: "书签栏", children: [
          {
            id: "10", title: "台州项目", children: [
              {
                id: "11", title: "可研报告", children: [
                  { id: "111", title: "黄岩柑橘产业可研 2026", url: "https://tz.gov.cn/hy-orange-2026", dateAdded: 1700000010000 },
                  { id: "112", title: "临海西兰花基地初设", url: "https://tz.gov.cn/lh-broccoli", dateAdded: 1700000020000 },
                  { id: "113", title: "温岭稻田综合种养方案", url: "https://tz.gov.cn/wl-rice", dateAdded: 1700000030000 }
                ]
              },
              {
                id: "12", title: "合同与委托", children: [
                  { id: "121", title: "五洲咨询委托协议", url: "https://wzec.com/contract/2026-07", dateAdded: 1700000040000 },
                  { id: "122", title: "评审意见汇总", url: "https://wzec.com/review/2026", dateAdded: 1700000050000 }
                ]
              },
              { id: "13", title: "台州农科院", url: "https://tzagri.cn", dateAdded: 1700000060000 }
            ]
          },
          {
            id: "20", title: "开发", children: [
              { id: "201", title: "GitHub", url: "https://github.com", dateAdded: 1690000000000 },
              { id: "202", title: "MDN Web 文档", url: "https://developer.mozilla.org", dateAdded: 1690000010000 },
              { id: "203", title: "Chrome 扩展开发文档", url: "https://developer.chrome.com/docs/extensions", dateAdded: 1690000020000 }
            ]
          },
          { id: "101", title: "GitHub", url: "https://github.com", dateAdded: 1680000000000 },
          { id: "102", title: "DeepSeek 对话", url: "https://chat.deepseek.com", dateAdded: 1680000010000 },
          { id: "103", title: "知乎", url: "https://www.zhihu.com", dateAdded: 1680000020000 },
          { id: "104", title: "哔哩哔哩", url: "https://www.bilibili.com", dateAdded: 1680000030000 },
          { id: "105", title: "浙江省农业农村厅", url: "https://nynct.zj.gov.cn", dateAdded: 1680000040000 },
          { id: "106", title: "番茄小说作者后台", url: "https://fanqienovel.com/main/writer", dateAdded: 1680000050000 },
          { id: "107", title: "MSI Afterburner 下载", url: "https://www.msi.com/Landing/afterburner", dateAdded: 1680000060000 }
        ]
      },
      {
        id: "2", title: "其他书签", children: [
          {
            id: "30", title: "网文参考", children: [
              { id: "301", title: "全世界觉醒者都听着", url: "https://fanqienovel.com/page/7100", dateAdded: 1695000000000 },
              { id: "302", title: "异兽迷城", url: "https://fanqienovel.com/page/7200", dateAdded: 1695000010000 }
            ]
          },
          { id: "31", title: "Bloodborne 补丁", url: "https://github.com/shadps4/Bloodborne", dateAdded: 1696000000000 },
          { id: "32", title: "Nova 项目", url: "https://github.com/alfredxw/nova", dateAdded: 1696000010000 }
        ]
      },
      { id: "3", title: "移动设备书签", children: [] }
    ]
  }
];

// ── 假浏览历史：让「高频书签」有东西可选，界面才会显示星标与琥珀色竖线 ──
const DAY = 86400000;
const HISTORY = [
  ["https://github.com", 42, 1],
  ["https://chat.deepseek.com", 31, 1],
  ["https://www.zhihu.com", 18, 3],
  ["https://fanqienovel.com/main/writer", 12, 2],
  ["https://www.bilibili.com", 9, 5],
  ["https://developer.mozilla.org", 6, 8],
  ["https://developer.chrome.com/docs/extensions", 4, 12],
  ["https://tz.gov.cn/hy-orange-2026", 5, 6],
  ["https://tzagri.cn", 3, 20]
].map(([url, visitCount, daysAgo]) => ({
  url, visitCount, lastVisitTime: Date.now() - daysAgo * DAY, title: url
}));

// storage 里预置的配置。organizeRootItems 故意给 false —— 这样「根目录书签未参与整理」提示条
// 会露出来（那是本轮新改的文案），否则它在默认状态下是隐藏的、截图里根本看不到。
const STORE = {
  sync: {
    method: "keyword",
    organizeRootItems: false,
    freqEnabled: true,
    freqTopN: 10,
    freqPerCat: 1,
    targetFolderName: "智能书签",
    targetParentId: "1"
  },
  // ⚠ 这里刻意用占位串而不是形如密钥的样例：GitHub 的 secret scanning 会扫这种前缀并报警，
  //   而预览页根本不需要真 Key（AI 调用在预览模式下被桩打回了）。
  local: { aiApiKey: "PLACEHOLDER_NOT_A_KEY", aiBaseUrl: "https://api.deepseek.com/chat/completions", aiModel: "deepseek-flash" }
};

function stubSource() {
  return `(function () {
  var TREE = ${JSON.stringify(TREE)};
  var HISTORY = ${JSON.stringify(HISTORY)};
  var STORE = ${JSON.stringify(STORE)};
  var byId = new Map();
  (function walk(list, parentId) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i]; n.parentId = parentId; byId.set(n.id, n);
      if (n.children) walk(n.children, n.id);
    }
  })(TREE, "0");
  function clone(n, deep) {
    var o = { id: n.id, title: n.title, parentId: n.parentId };
    if (n.url) o.url = n.url;
    if (n.dateAdded) o.dateAdded = n.dateAdded;
    if (deep && n.children) o.children = n.children.map(function (c) { return clone(c, true); });
    return o;
  }
  function pick(defs, bag) {
    var out = {};
    if (defs == null) { for (var k in bag) out[k] = bag[k]; return out; }
    if (typeof defs === "string") { if (defs in bag) out[defs] = bag[defs]; return out; }
    if (Array.isArray(defs)) { defs.forEach(function (k) { if (k in bag) out[k] = bag[k]; }); return out; }
    for (var d in defs) out[d] = (d in bag) ? bag[d] : defs[d];
    return out;
  }
  function store(area) {
    return {
      get: function (defs, cb) { setTimeout(function () { cb(pick(defs, STORE[area])); }, 0); },
      set: function (obj, cb) { Object.assign(STORE[area], obj); if (cb) setTimeout(cb, 0); },
      remove: function (k, cb) { delete STORE[area][k]; if (cb) setTimeout(cb, 0); },
      clear: function (cb) { STORE[area] = {}; if (cb) setTimeout(cb, 0); }
    };
  }
  window.chrome = {
    runtime: {
      lastError: undefined,
      getURL: function (p) { return p; },
      openOptionsPage: function () {},
      sendMessage: function (msg, cb) { if (cb) setTimeout(function () { cb({ ok: false, error: "预览模式不调用 AI" }); }, 0); },
      onMessage: { addListener: function () {} }
    },
    storage: { sync: store("sync"), local: store("local"), onChanged: { addListener: function () {} } },
    bookmarks: {
      getTree: function (cb) { setTimeout(function () { cb(TREE.map(function (n) { return clone(n, true); })); }, 0); },
      getChildren: function (id, cb) {
        setTimeout(function () { var n = byId.get(id); cb(n && n.children ? n.children.map(function (c) { return clone(c, false); }) : []); }, 0);
      },
      get: function (id, cb) { setTimeout(function () { var n = byId.get(id); cb(n ? [clone(n, false)] : []); }, 0); },
      getSubTree: function (id, cb) { setTimeout(function () { var n = byId.get(id); cb(n ? [clone(n, true)] : []); }, 0); },
      create: function (o, cb) { setTimeout(function () { cb({ id: "new_" + Math.random().toString(36).slice(2, 8) }); }, 0); },
      move: function (id, o, cb) { if (cb) setTimeout(cb, 0); },
      remove: function (id, cb) { if (cb) setTimeout(cb, 0); },
      removeTree: function (id, cb) { if (cb) setTimeout(cb, 0); }
    },
    history: { search: function (q, cb) { setTimeout(function () { cb(HISTORY); }, 0); } },
    permissions: {
      contains: function (p, cb) { setTimeout(function () { cb(true); }, 0); },
      request: function (p, cb) { setTimeout(function () { cb(true); }, 0); }
    }
  };
})();
`;
}

// 把真实的 `@media (prefers-color-scheme: dark)` 机械改写成"恒生效"或"永不生效"。
// 只替换媒体查询本身，块内内容一字不改 —— 所以预览里的配色就是源码里的配色。
function lockTheme(css, theme) {
  const re = /@media \(prefers-color-scheme: dark\)/;
  if (!re.test(css)) throw new Error("CSS 里找不到 prefers-color-scheme 媒体查询，预览器需要同步更新");
  return css.replace(re, theme === "dark" ? "@media all" : "@media (min-width: 99999px)");
}

function build(page, theme) {
  const dir = page === "popup" ? "popup" : "options";
  let html = fs.readFileSync(path.join(ROOT, dir, `${dir}.html`), "utf8");
  const css = lockTheme(fs.readFileSync(path.join(ROOT, dir, `${dir}.css`), "utf8"), theme);

  // 样式表 → 内联（主题已锁定）
  html = html.replace(/<link rel="stylesheet" href="[^"]+"\s*\/?>/, `<style>\n${css}\n</style>`);

  // 脚本 → 按原顺序内联，保证依赖顺序与真实页面完全一致
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
    const p = path.resolve(ROOT, dir, src);
    return `<script>\n/* ==== ${path.relative(ROOT, p).replace(/\\/g, "/")} ==== */\n${fs.readFileSync(p, "utf8")}\n</script>`;
  });

  // 假 chrome 必须早于所有业务脚本
  html = html.replace("<body>", `<body>\n<script>\n${stubSource()}</script>`);
  // 弹窗改成「打开只做只读初始化、不再自动分类」之后，直接截图只会拍到未扫描的空态。
  // 预览器要看的是**有分类结果**的完整界面，所以补一次点击「扫描分类」的等效调用。
  if (page === "popup") {
    html = html.replace(
      "</body>",
      `<script>setTimeout(function(){ if (typeof scan === "function") scan(); }, 100);</script>\n</body>`
    );
  }
  html = html.replace("<head>", `<head>\n<!-- 由 .workbuddy/preview/ui-shot.js 生成：真实源码 + 锁定的 ${theme} 主题 -->`);
  return html;
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [];
for (const page of ["popup", "options"]) {
  for (const theme of ["light", "dark"]) {
    const file = path.join(OUT, `${page}-${theme}.html`);
    fs.writeFileSync(file, build(page, theme));
    jobs.push({ file, page, theme });
    console.log("生成 " + path.relative(ROOT, file).replace(/\\/g, "/"));
  }
}

if (process.argv.includes("--shot")) {
  if (!fs.existsSync(CHROME)) { console.error("找不到 Chrome：" + CHROME); process.exit(1); }
  const tmp = path.join(require("os").tmpdir(), "ui-shot-profile");
  for (const j of jobs) {
    const png = j.file.replace(/\.html$/, ".png");
    // 弹窗是 360px 宽的固定面板，给 400 宽留点边；设置页用桌面宽度
    const size = j.page === "popup" ? "400,740" : "760,1400";
    execFileSync(CHROME, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox", "--hide-scrollbars",
      // 弹窗的内容是 JS 异步渲染的（读树 → 分类 → 渲染），不等它跑完只会截到中间态
      "--virtual-time-budget=8000",
      // 2x：截图要能看清边框/字重这类细节，1x 下按钮文案糊成一团没法核对
      "--force-device-scale-factor=2",
      "--user-data-dir=" + tmp, "--window-size=" + size,
      "--screenshot=" + png.replace(/\\/g, "/"), "file:///" + j.file.replace(/\\/g, "/")
    ], { stdio: "ignore" });
    console.log("截图 " + path.relative(ROOT, png).replace(/\\/g, "/"));
  }
}
