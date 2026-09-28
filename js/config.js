// 共享配置默认值：被 service-worker / popup / options 三处复用，避免多处漂移。
// 注意：文件内仅声明顶层 const，兼容 importScripts（SW）与 <script>（页面）两种加载方式。
const DEFAULTS = {
  method: "keyword", // keyword | ai
  aiBaseUrl: "https://api.openai.com/v1/chat/completions",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  targetParentId: "1", // 书签栏
  targetFolderName: "智能书签",
  // 根目录（书签栏 / 其他书签 / 移动设备书签）上「平铺的直接书签」是否参与整理。
  //   true（默认）：与其他书签完全同规则——会被复制进预览、参与 AI 分类、按频率排序，
  //     执行时原书签被删除。理由：本插件的目标用户就是"书签很多、管理混乱"的重度用户，
  //     他们的书签**大量平铺在根目录**（没有文件夹结构）。默认跳过等于插件什么都不做。
  //   false：一律跳过、保持原位——视为用户特意放在一键可达的位置，不动它。
  // 为什么保留开关：确实有用户刻意把常用入口钉在书签栏上、不希望被收进文件夹。
  //   注意这是个"动了就必须重做预览"的设置：预览快照里记着生成时的本项目，执行时对不上直接拒绝。
  organizeRootItems: true,
  subByDomain: false,
  maxSubFolders: 5, // 每个分类文件夹下最多几个二级子文件夹（超出的二级标签并入分类文件夹本级）
  minSubFolderSize: 10, // 分类内书签数少于该值时不做二级细分（直接平铺在分类文件夹本级）；0/1 = 不限制
  minSubFolderItems: 2, // 子文件夹最少书签数：少于该值说明归类过碎，该子文件夹不建、书签上浮到上一级；1 = 不限制
  // ⚠ 这里曾经有过一个 fallbackSubFolder（兜底子文件夹「待整理」），已按作者要求删除：
  //   宁可让归不进任何标签的书签直接躺在分类文件夹本级（用户一眼看得见、知道要微调），
  //   也不要凭空多出一个「待整理」文件夹——那既让结构变脏，也把问题藏了起来。
  enableThirdLevel: false, // 是否生成三级子文件夹（AI 三级标签；逐层套用上面的「最少书签数」与「每层必须有直接书签」规则）
  // AI 分类时，是否把「书签当前所在的文件夹路径」作为参考线索发给 AI（仅 AI 模式生效）。
  //   true（默认）：AI 能看到每个书签现在放在哪（如「台州项目 / 可研报告」）。此时分类的
  //     **主要依据就是这些现有文件夹**——AI 可以直接沿用路径里的名字作为一级大类（见下方
  //     buildCategoryRule 的 folderFirst 分支）。用户自己起的私人分类（「网文创作」「台州项目」）
  //     光看书签标题和网址是**猜不到**的，只有这条线索能让 AI 认出来。
  //   false：完全不发路径，AI 改为以「分类标签管理」里那张表为主要归类依据。
  // 为什么给开关：本插件的目标用户恰恰是"书签管理混乱"的人，他们的文件夹名可能大量是
  //   「新建文件夹」「111」这类占位名（本地已过滤掉最明显的一部分），剩下的噪声只能由用户
  //   自己判断要不要发。这也是排查分类质量问题时的对照手段（关掉对比一轮）。
  // 隐私：文件夹名是你自己的文本，但可能含私人信息（如"辞职计划"），因此必须和标题、网址
  //   一样在隐私政策里如实披露，别让文档写"只发标题与网址"而实现多发一份。
  useFolderHint: true,
  // ⚠ 提示词**不开放用户编辑**（作者明确要求，2026-09-28）：设置页不提供任何入口，
  //   也没有 aiPromptTemplate 这个配置项 —— 提示词一律取内置的 DEFAULT_AI_PROMPT_TEMPLATE。
  //   曾经做成可编辑（textarea + 占位符清单 + 写错名字的警告），已按作者要求撤回。
  // 但「模板（怎么说）+ 数据段（说什么）」这层结构**保留**：它是提示词的唯一真源
  //   （service-worker 拼请求与 popup 算缓存指纹都读这一段），分段函数让三口径切换
  //   （路径优先 / 标签表优先 / 表空时自行归纳）只改数据段、不复制整段文案。
  // 想改提示词 = 改 DEFAULT_AI_PROMPT_TEMPLATE（或它引用的 build* 段函数），
  //   改完指纹自然变化、旧缓存自动失效。
  // ---- 高频书签（基于浏览器访问历史，需要 history「可选权限」）----
  // history 在 manifest 里声明为 optional_permissions：默认不申请，用户开启本功能时才弹授权框。
  // 不授权也能用——直接手动点星标记（手动标记存在 storage.local，不需要任何权限）。
  // 作用：把「真正在用的」书签强制平铺在所属分类的一级目录，不塞进二级子文件夹里多点一次。
  // 与 organizeRootItems 是两回事：那条管的是**书签栏上平铺的书签**是否被整理，
  // 这条管的是**分类文件夹内部**哪些书签不进二级子文件夹。两条互不影响。
  freqEnabled: true, // 总开关：关闭后完全按 AI 标签归类，不做高频置顶
  freqTopN: 10, // 全库按访问热度取前几个作为高频书签
  freqPerCat: 1, // 每个分类至少保留几个高频书签（保底到 N 个，不是额外加 N 个；0 = 不保底）
  // 扫描时是否自动删除重复书签（同一网址存了多份，只留最早添加的那份）。
  //   true（默认）：重复项会在 AI 分类**之前**被清掉 —— 留着重复会污染分类结果和最终目录
  //     （同一书签被分到两个类、生成预览时复制两份）。删除全部记入撤销栈，可一键恢复。
  //   false：一次也不删。扫描不管、生成预览不管、执行整理也不管，重复项原样保留在最终结构里。
  // 为什么给开关：去重会**删除用户的书签**，而有些人事先知道自己的重复是刻意的
  //   （同一个网址特意放在两个文件夹里当快捷入口）。这类用户宁可忍受重复也不要插件动他的书签。
  autoDedupe: true
};

// AI 接口配置（地址 / Key / 模型）属敏感信息：只存 storage.local，绝不同步云端。
// 键集合供 service-worker / popup / options 三处读写复用，避免键名漂移导致漏迁移。
const AI_CONFIG_KEYS = ["aiBaseUrl", "aiApiKey", "aiModel"];
// local 读取时的默认值。用 null 表示「从未在本地存过」——以区分「没存过」与「用户清空为空串」。
const AI_CONFIG_LOCAL_DEFAULTS = { aiBaseUrl: null, aiApiKey: null, aiModel: null };

// 本地兜底配置：可在此预填你的 AI 接口地址与 Key（以及分类方法）。
// 作用：当 chrome.storage 被清空（典型场景：移除扩展再重新「加载已解压」）后，
//       插件启动时会用这里的值自动回填，无需每次重新手工填写。
// 安全提示：本文件随插件源码保存在本地磁盘，卸载插件不会删除它。
//       仅限个人本地使用；不要把含 Key 的 config.js 分享给他人或上传到公开仓库。
const LOCAL_FALLBACK = {
  // method: "ai",
  // aiBaseUrl: "https://api.deepseek.com/chat/completions",
  // aiApiKey: "sk-xxxx",
  // aiModel: "deepseek-flash"
};

// ==================== AI 分类提示词（唯一真源） ====================
// 为什么全部放在这里而不是 service-worker.js：
//   popup 计算「分类结果缓存指纹」时会把**渲染后的提示词文本**一起哈希进去
//   （见 popup.js 的 classifySignature）。于是 ——
//     改提示词 / 切换「参考现有文件夹路径」开关 → 文本变化 → 指纹变化 → 旧缓存自动失效。
//   否则会出现：改了提示词、指纹没变、命中上一版缓存、界面显示的还是坏结果，让人误以为修复没生效。
//
// 两段结构：
//   ① 模板（DEFAULT_AI_PROMPT_TEMPLATE）—— 决定"怎么说"；
//   ② 数据段（类别清单、标签上限、已用标签…）—— 由下面的 段构造函数 生成，决定"说什么"。
//   模板里用 {{key}} 引用数据段。
//
// ⚠ 提示词**不开放用户编辑**（作者明确要求）。这层模板结构是为**改代码的人**准备的：
//   要调提示词就改 DEFAULT_AI_PROMPT_TEMPLATE 或它引用的 build* 段函数，一个地方改完，
//   拼请求（service-worker）与算指纹（popup）同时跟上。设置页没有任何入口、配置里也没有这一项。
//   （曾经做成用户可编辑：textarea + 占位符清单 + 写错名字的警告。已撤回，连配置项一起删。）

// 模板可用的占位符清单。**不暴露给用户**，用途只有两个：① 自查默认模板有没有写错名字；
// ② 测试里断言「DEFAULT_AI_PROMPT_TEMPLATE 用到的每个占位符都在清单里、且都能被 buildAiInstructions 提供」。
const AI_PROMPT_PLACEHOLDERS = [
  { key: "categoryRule", desc: "类别清单 + 归类规则（内容随「参考现有文件夹路径」开关变化）" },
  { key: "categories", desc: "只放类别清单本身（每个类的名称与关键词）" },
  { key: "folderHint", desc: "folder 路径线索的用法说明（未勾选参考路径时为空）" },
  { key: "subRules", desc: "二级标签规则（含每个类别的标签数上限）" },
  { key: "maxSubs", desc: "每个类别的二级标签数上限（一个数字）" },
  { key: "thirdLevel", desc: "三级标签规则（未开启三级时为空）" },
  { key: "known", desc: "本批之前已经用过的标签（可能为空）" },
  { key: "known3", desc: "已经用过的三级标签（可能为空）" },
  { key: "output", desc: "要求的 JSON 输出格式" }
];

const DEFAULT_AI_PROMPT_TEMPLATE = [
  "你是一个书签分类助手。请把下列书签归类，并为每个书签给出一个二级标签（用于在该类别下分子文件夹）。",
  "{{categoryRule}}",
  "{{folderHint}}二级标签规则（务必严格遵守）：",
  "{{subRules}}",
  "{{thirdLevel}}{{known}}{{known3}}仅返回 JSON 数组，格式：{{output}}，不要任何额外文字。"
].join("\n");

// 把类别清单渲染成「- 名称：关键词、关键词…」。
// ⚠ 送进提示词的类别清单**必须**走这里（名称 + 关键词定义），不能只传类别名。
//   历史事故：只传名字时，AI 只能按名字字面猜（「工具效率」收什么？「工作职业」收什么？），
//   用户一旦新增自定义分类、或删掉某个分类，AI 就失去边界依据，只能把书签塞进"听起来最像"的那一类
//   （典型症状：删掉「开发技术」后，GitHub / OpenAI 这类书签全跑进「工具效率」）。
//   关键词就是分类的定义，必须一起给。
// 兜底行在类别清单里的固定措辞。抽成常量是为了让 buildCategoryRule 能可靠判断
// 「这份清单里到底有没有**可用的大类**（而不仅仅是兜底）」——靠正则或中文串硬猜太脆。
const FALLBACK_CAT_MARK = "兜底类别，只有在上面所有类别都不合适时才用它";

function buildCategoryList(cats) {
  const lines = [];
  for (const c of cats || []) {
    const name = String((c && c.name) || "").trim();
    if (!name) continue;
    if (c.system) {
      lines.push(`- ${name}：${FALLBACK_CAT_MARK}`);
      continue;
    }
    const kw = (c.keywords || [])
      .map((k) => String(k).trim())
      .filter(Boolean)
      .slice(0, 20);
    lines.push(kw.length ? `- ${name}：${kw.join("、")}` : `- ${name}：（这一类没填关键词，只能按名称含义判断）`);
  }
  return lines.join("\n");
}

// 关键词输入解析：中英文逗号 / 顿号 / 分号 / 换行都算分隔符。
// 历史事故：旧实现只 split(",")，用户按中文习惯输入「考试、职业、工作」会被存成**一个**关键词
//   （"考试、职业、工作" 这一整串），永远匹配不上任何书签，而界面上看起来完全正常 —— 静默失效。
function splitKeywords(text) {
  return String(text == null ? "" : text)
    .split(/[,，、;；\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 把「关键词里混进了分隔符」的旧数据拆开：例如 ["考试、职业、工作"] → ["考试","职业","工作"]。
// 只在设置页载入时做（不落盘，用户点保存才写回），用于自动修掉上面那种历史脏数据。
function normalizeKeywords(list) {
  const out = [];
  for (const k of list || []) {
    const parts = splitKeywords(k);
    if (!parts.length) continue;
    // 没有分隔符时 splitKeywords 会原样返回一个元素，行为与旧数据一致
    for (const p of parts) if (!out.includes(p)) out.push(p);
  }
  return out;
}

// 占位符替换。未在 vars 里出现的 key 替换成空串（模板里删掉某一段时不该报错）；
// 末尾清理：去掉行尾空格、把 3 个以上连续换行压成一个空行，避免模板里留白留出一堆空行。
function renderAiPromptTemplate(tpl, vars) {
  const out = String(tpl == null ? "" : tpl).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] == null ? "" : vars[k]) : ""
  );
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// 找出模板里写了、但不在 AI_PROMPT_PLACEHOLDERS 里的占位符。
// 为什么需要（提示词已不开放用户编辑，所以这是一道**给改代码的人**的防线）：
//   renderAiPromptTemplate 对**未提供**的 key 一律替换成空串（见上），改模板时把
//   {{subRules}} 手滑写成 {{subrules}} / {{categoryRules}}，那一段就会静默变空 ——
//   AI 收到一份缺了数据段的提示词，界面上却毫无异常（典型的"改了但没生效"）。
//   test-prompt.js 用它断言「默认模板零未知占位符」。返回去重后的未知 key 数组（顺序=出现顺序）。
function findUnknownPlaceholders(tpl) {
  const known = new Set(AI_PROMPT_PLACEHOLDERS.map((p) => p.key));
  const out = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(tpl == null ? "" : tpl)))) {
    if (!known.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// 类别清单 + 归类规则。两种口径（由「参考书签现有的文件夹路径」开关决定）：
//   folderFirst = true  → **路径为主**：优先按书签当前所在文件夹聚成大类，路径名反复出现且表里
//                          没有语义相符的大类时，**允许 AI 直接用路径里的名字当大类名**
//                          （这就是"主要参考现有文件夹路径"的落地方式，也是 B 选项的核心）。
//   folderFirst = false → **标签表为主**：category 必须照抄用户分类表里的名字，一个字都不能改。
// 为什么要分开：只给一张表时，用户删过分类或书签属于私人领域（网文创作）时 AI 无从下手；
//   只给路径时，用户根本没用文件夹、或文件名全是占位符时 AI 又失去依据。两种口径各有适用的库。
// 分类表里是否存在「可用的一级大类」（非兜底、名称非空）。这是决定 AI 口径的同一个判据：
//   没有可用大类时，无论「参考文件夹路径」是否勾选，提示词都必须让 AI 自行归纳
//   （否则「category 只能照抄列表」会把它逼进兜底 —— 线上真实症状）。
// buildCategoryRule 只有渲染好的字符串，用 FALLBACK_CAT_MARK 探测；本函数供持有分类数组的
// 调用方（service-worker）使用。两处判据必须同源，test-prompt.js 有专门的同源断言。
function hasUsableCategories(cats) {
  return (cats || []).some((c) => c && !c.system && String(c.name || "").trim());
}

function buildCategoryRule(catList, folderFirst) {
  const list = String(catList || "").trim();
  // 「有没有可用的大类」= 清单里存在至少一行不是兜底行。判不出来就会出现下面这条静默故障。
  const hasUserCats = list.split("\n").some((l) => l.trim() && l.indexOf(FALLBACK_CAT_MARK) < 0);

  // 情况③：一个可用大类都没有（用户删光了，或只剩兜底）。
  //   此时**两个口径都必须让 AI 自己归纳** —— 否则「category 只能照抄列表」会把它逼进兜底，
  //   用户看到的现象是「整理完，全部书签都跑进了『其他』」（线上真实症状）。
  //   AI 归纳出的大类会经 resolveOrCreateCategory 落成真实分类，下一轮即可沿用。
  if (!hasUserCats) {
    return (
      "（当前没有可用的大类，请你按书签内容自行归纳一级大类）\n" +
      "归类规则（务必严格遵守）：\n" +
      "0) 请根据书签的用途与主题自行归纳一级大类，名称用 2-6 个字的中文短语；\n" +
      "   同一主题必须始终用同一个大类名，不要写成几种说法；也不许为一两条书签就新建一个大类；\n" +
      (folderFirst
        ? "0.1) 归纳时**优先依据每个书签的 folder 字段**（它当前所在的文件夹路径）：同一个文件夹里、\n" +
          "   内容确实同属一类的书签要归到一起；路径里反复出现且贴切的名字（2-8 个字）可直接当大类名。\n"
        : "") +
      "0.2) 只有当确实归纳不出合适的大类时，才归入兜底类别。"
    );
  }

  if (folderFirst) {
    return (
      "用户已有的分类参考（每行一个大类，冒号后是它收录什么内容的判定依据）：\n" +
      list + "\n" +
      "归类规则（务必严格遵守）：\n" +
      "0) 请**优先依据每个书签的 folder 字段**（它当前所在的文件夹路径）来归纳大类：\n" +
      "   同一个文件夹里、内容确实同属一类的书签，必须归到同一个大类；\n" +
      "0.1) 若某个路径名反复出现、而且上面列表里没有语义相符的大类，**可以直接采用该路径名作为 category**\n" +
      "   （从路径里挑最贴切的一段，2-8 个字。例：路径 \"技术 / 网文创作 / 素材\" 可新建大类 \"网文创作\"）。\n" +
      "   同一个名字必须始终保持一致的写法、不要写成几种说法；也不许为了一个两个书签就新建大类。\n" +
      "0.2) 上面列表里的大类仍然可以继续使用；只有当路径与书签内容明显矛盾，或者路径看着像随手起的\n" +
      "   占位名（\"新建文件夹\"\"111\"）时，才忽略路径、按书签内容判断；\n" +
      "0.3) 只有当所有大类与路径线索都不合适时，才归入兜底类别。"
    );
  }
  return (
    "类别列表（每行一个类别，冒号后是该类收录什么内容的关键词/判定依据）：\n" +
    list + "\n" +
    "归类规则（务必严格遵守）：\n" +
    "0) category 只能照抄上面列表里的类别名，一个字都不能改，绝对不允许自己发明或改写类别名；\n" +
    "   判断依据是「这个书签主要是干什么用的」，而不是它叫什么名字；务必对照该类的关键词，不要只看类别名的字面意思；\n" +
    "0.1) 只有当所有具体类别都不合适时，才归入兜底类别。"
  );
}

// folder 字段的用法说明。只在开启「参考现有文件夹路径」时注入 —— 关了就不提这个词，
// 免得 AI 以为自己在看一份被截断的数据。
function buildFolderHintRule() {
  return (
    "每个书签可能带一个 folder 字段，那是它**当前所在的文件夹路径**（例：\"台州项目 / 可研报告\"）。\n" +
    "这是用户的真实整理习惯，**不是噪声**：\n" +
    "· 如果它所示的主题与某个类别相符，优先按用户原有的习惯归类 —— 用户自己起的私人分类名往往只有从这里才看得出来；\n" +
    "· 如果它与书签内容明显矛盾，或者看着像随手起的占位名（\"新建文件夹\"\"111\"），就忽略它，按书签内容判断；\n" +
    "· 这些文件夹也可能是**以前自动分类留下的旧名字**，未必是用户手工核对过的正确归类，所以内容永远优先于路径；\n" +
    "没有 folder 字段的书签，就是直接平铺在书签栏上的，没有线索，按内容判断。"
  );
}

// 二级标签规则。maxSubs 会写进提示词，所以它一改就必须让缓存失效（见 popup.classifySignature）。
function buildSubRules(maxSubs, folderHint) {
  const lines = [
    "1) 标签是 2-6 个字的中文短语，概括主题或用途，不要用网址/域名/“其他”作标签；",
    `2) 每个类别下最多只允许 ${maxSubs} 个不同的标签，请把同主题的书签尽量归到同一个标签下；`,
    "3) 必须为每个书签都给出标签，不允许留空；",
    "4) 宁可粒度粗一点，也不要造出大量只含一两个书签的细碎标签（只含 1 个书签的标签等于白建文件夹）；",
    "5) 【禁止一个标签盖住整类】若某类别下所有书签都只能归入同一个标签，说明这个标签没有区分度、等于没分类。",
    "   此时必须改按「用途 / 形态 / 场景」再拆，例如：平台与模型 / 编程工具 / 学习资料 / 开源社区 / 检测评测 / 文档教程。",
    "   任何书签数 ≥ 10 的类别，都必须给出至少 2 个不同的标签。",
    "6) 禁止把类别本身的泛称当标签（例：在「开发技术」类下用“AI工具”“技术”“开发”；在「影音娱乐」类下用“娱乐”“影音”）。",
    "   标签必须回答“它属于这一类里的哪一小类”，能做到这一点的标签才合格。"
  ];
  if (folderHint) {
    lines.push(
      "7) 给二级标签时，如果 folder 路径里已经有一个合适的小类名（例如路径是 \"开发技术 / 前端框架\"，",
      "   而这批书签确实都是前端框架），可以直接沿用这个名字 —— 用户看着熟悉；不合适就按内容自己起，不要硬套。"
    );
  }
  return lines.join("\n");
}

// 三级标签规则。不开启三级时整段不注入（AI 也就不会返回 subsub 字段）。
function buildThirdLevelRules(maxSubs) {
  return (
    "三级标签规则（用于在二级标签下再分子文件夹）：\n" +
    `1) 只有当该二级标签下的书签确实还能分出多个有意义的小类时才填；每个「类别 + 二级标签」组合下最多 ${maxSubs} 个不同的三级标签；\n` +
    "2) 同样 2-6 个字，宁可粗不可碎，禁止只给 1 个书签单独起一个三级标签；\n" +
    "3) 不需要再细分时必须填空字符串 \"\"，不要为了填而硬凑。"
  );
}

// 要求的 JSON 输出格式（第三段字段只在开启三级时出现）
function buildOutputFormat(thirdLevel) {
  return (
    `[{"id":"<书签id>","category":"<类别名称>","sub":"<二级标签>"` +
    (thirdLevel ? `,"subsub":"<三级标签，无需细分时为空字符串>"` : "") +
    `}]`
  );
}

// 参数：catList 类别清单（必须由 buildCategoryList 渲染，**含每类的关键词定义**）；
//      maxSubs 每个类别下标签数上限；thirdLevel 是否要求三级标签；
//      known / known3 已用标签词汇表（跨批次复用，避免同一主题在各批次被起成不同名字）；
//      opts.folderHint  是否随书签附上「现有文件夹路径」线索（对应配置项 useFolderHint）；
//      opts.folderFirst 是否「以现有文件夹路径为主要依据」（同上开关）；
//      opts.template    提示词模板。配置里没有这一项（作者明确不支持用户自定义），
//                       不传即用 DEFAULT_AI_PROMPT_TEMPLATE；参数保留是为了让测试能验证
//                       模板机制本身（占位符替换、缺段不留空洞），不必为了测它去改内置文案。
function buildAiInstructions(catList, maxSubs, thirdLevel, known, known3, opts) {
  opts = opts || {};
  const folderHint = !!opts.folderHint;
  // 「路径为主」与「是否发路径线索」其实是同一个开关（设置页的「分类时参考书签现有的文件夹路径」）：
  //   勾选 → 发路径线索 + 允许 AI 沿用路径名当一级大类（主要依据 = 现有文件夹结构）；
  //   取消 → 完全不发路径，AI 以「分类标签管理」那张表为主要依据。
  // 因此 folderFirst 默认**跟随** folderHint；只有显式传了才用显式值。否则调用方一旦只设了
  // folderHint 忘了 folderFirst，就会静默退化成「发了路径、却仍按标签表归类」——与勾选框的语义相反。
  const folderFirst = opts.folderFirst === undefined ? folderHint : !!(opts.folderFirst && folderHint);
  const tpl = String(opts.template == null ? "" : opts.template).trim() || DEFAULT_AI_PROMPT_TEMPLATE;
  return renderAiPromptTemplate(tpl, {
    categories: String(catList || ""),
    categoryRule: buildCategoryRule(catList, folderFirst),
    folderHint: folderHint ? buildFolderHintRule() : "",
    subRules: buildSubRules(maxSubs, folderHint),
    maxSubs: String(maxSubs),
    thirdLevel: thirdLevel ? buildThirdLevelRules(maxSubs) : "",
    known: known
      ? `已使用的标签（语义合适时必须复用，不要另造同义新标签；若该类已达到 ${maxSubs} 个上限，则必须从下列标签中选一个最接近的）：${known}`
      : "",
    known3: thirdLevel && known3
      ? `已使用的三级标签（语义合适时必须复用；若某个二级标签下已达 ${maxSubs} 个上限，则从下列中选最接近的）：${known3}`
      : "",
    output: buildOutputFormat(thirdLevel)
  });
}

// ==================== AI 维护分类表的提示词（一级大类的增 / 减） ====================
// 与 buildAiInstructions 同一处理原则：正文只在这里写一份，调用方只传数据。
// 区别：本函数产出的建议不参与 classifySignature 指纹（那是"分类结果缓存"的指纹，
//       而这里只影响设置页的建议面板，改了不影响已经算好的分类结果）。

// 把统计数字渲染成给 AI 的"事实依据"。为什么必须给数字：
//   只说"请建议增删大类"，模型会凭想象造一堆漂亮但没用的类别；
//   把「各分类现有多少书签」「兜底类里哪些站点最多」摆出来，它的建议才受事实约束。
// items 用于抽样（让 AI 看到真实的标题/域名分布）。抽样条数固定，避免大书签库把提示词撑爆。
function buildCatSuggestStatsText(stats, items, opts) {
  opts = opts || {};
  const maxDomains = Number.isFinite(opts.maxDomains) ? opts.maxDomains : 15;
  const maxSamples = Number.isFinite(opts.maxSamples) ? opts.maxSamples : 80;
  const lines = [];
  lines.push(`总书签数：${stats.total}`);
  if (stats.hasCounts) {
    const per = Object.entries(stats.perCat || {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    lines.push(
      "各大类现有书签数（来自上一次分类结果，仅用于判断「这一类是不是已经空了」）：" +
        (per.length ? per.map(([id, n]) => `${id}=${n}`).join(" / ") : "（暂无）")
    );
  } else {
    lines.push(
      "各大类现有书签数：**未知**（还没扫描过）。因此本次**不要建议删除**任何大类，只做「新增」建议。"
    );
  }
  lines.push(`落在兜底的「${stats.other.name}」里的书签数：${stats.other.count}`);
  const doms = (stats.otherDomains || []).slice(0, maxDomains);
  if (doms.length) {
    lines.push("兜底分类里出现最多的站点（现有大类没覆盖住的内容，新增大类的主要依据）：");
    for (const d of doms) {
      lines.push(`  ${d.domain} × ${d.n}${d.samples && d.samples.length ? "（例：" + d.samples[0] + "）" : ""}`);
    }
  }
  const sample = (items || []).slice(0, maxSamples);
  if (sample.length) {
    lines.push(`书签抽样（共 ${(items || []).length} 条，这里取 ${sample.length} 条，格式「标题 | 网址 | 现有文件夹」）：`);
    const useHint = opts.folderHint !== false && typeof buildFolderHint === "function";
    for (const it of sample) {
      const hint = useHint ? buildFolderHint(it.folderPath, { excludeNames: opts.excludeNames }) : "";
      lines.push(
        `  ${String(it.title || "").slice(0, 50)} | ${String(it.url || "").slice(0, 80)}` +
          (hint ? ` | ${hint}` : "")
      );
    }
  }
  return lines.join("\n");
}

function buildCatSuggestInstructions(catList, statsText) {
  return (
    `你在帮一个浏览器重度用户维护他的书签「一级大类」清单。他的书签很多、原本管理混乱。\n` +
    `当前大类（这是用户**已经手动调整过**的清单，请只在此基础上增 / 减，不要推翻重来、不要改名）：\n` +
    `${catList}\n\n` +
    `书签实况：\n${statsText}\n\n` +
    `任务：请判断这份清单是否需要**增加**或**删除**一级大类。\n` +
    `增加（add）的条件，三条全部满足才提：\n` +
    `  1) 有一批内容明显成规模（约 ≥ 30 个书签，或兜底分类里某个主题反复出现）——别为了凑数提只有零星几条的类别；\n` +
    `  2) 现有大类确实覆盖不了它（不要和现有大类语义重叠，例如已有「开发技术」就不要再提「编程」）；\n` +
    `  3) 你能给出 3-8 个「用来判断归类」的关键词，关键词要具体（站点名或明确的中文词），\n` +
    `     不要用"其它""综合""各种"这类没有边界的词。\n` +
    `  另外，上面每条书签后面还会给出它「现有的文件夹路径」——如果某个路径名反复出现、\n` +
    `  而且不在大类的关键词范围里，那通常就是用户已经习惯、而你还没收录的领域\n` +
    `  （例如"网文创作""台州项目"这类你光看标题网址猜不到的名字）。这是「新增」最可靠的依据：\n` +
    `  请直接沿用用户自己的叫法作为新大类名，不要替他改写、合并或换成一个更"标准"的说法。\n` +
    `删除（remove）的条件：某个大类现有书签数极少（≤ 2 个）且没有独立价值。\n` +
    `  书签数未知时一律不要提删除。兜底分类不可删除。\n` +
    `硬性限制：最多新增 5 个、最多删除 5 个；宁可少提甚至不提，绝不凑数；不要建议改名或合并。\n` +
    `仅返回 JSON 对象，格式：\n` +
    `{"add":[{"name":"大类名","keywords":["关键词1","关键词2","关键词3"],"reason":"一句话理由"}],` +
    `"remove":[{"name":"大类名","reason":"一句话理由"}]}\n` +
    `没有建议就返回 {"add":[],"remove":[]}。不要输出任何额外文字。\n`
  );
}

// 把 LOCAL_FALLBACK 中非空字段回填到 cfg 中缺省的字段上（不覆盖用户已有配置）。
function applyLocalFallback(cfg) {
  if (typeof LOCAL_FALLBACK === "undefined" || !LOCAL_FALLBACK) return cfg;
  for (const k of ["method", "aiBaseUrl", "aiApiKey", "aiModel"]) {
    if (!cfg[k] && LOCAL_FALLBACK[k]) cfg[k] = LOCAL_FALLBACK[k];
  }
  return cfg;
}

// 从 storage.local 读 AI 接口配置（地址/Key/模型），优先本地、其次回退 sync 里的旧值（并立即迁移）。
// 返回 Promise<cfg>：在传入 cfg 基础上就地补齐 aiBaseUrl/aiApiKey/aiModel 三个字段。
// 默认值规则：本地从没存过且 sync 也没有 → 保持 cfg 里 DEFAULTS 的默认值（即不覆盖）。
function mergeAiLocalConfig(cfg) {
  return new Promise((resolve) => {
    chrome.storage.local.get(AI_CONFIG_LOCAL_DEFAULTS, (local) => {
      const legacy = {};
      for (const k of AI_CONFIG_KEYS) {
        // 本地有值（含空串）→ 用本地；否则用 sync 里的旧值（升级前还在云上的副本）
        if (local[k] !== null) {
          cfg[k] = local[k];
        } else if (cfg[k] !== undefined) {
          legacy[k] = cfg[k]; // sync 有旧值，待迁移到本地
        }
      }
      const finish = () => resolve(cfg);
      // 有旧值要迁：写入 local 并从 sync 删除（保证云上不残留 AI 配置）
      if (Object.keys(legacy).length) {
        chrome.storage.local.set(legacy, () => {
          chrome.storage.sync.remove(AI_CONFIG_KEYS, finish);
        });
      } else {
        finish();
      }
    });
  });
}
