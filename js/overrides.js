// 手动微调分类的持久化：以「归一化 URL」为键，记录用户纠正后的分类 id。
// 存放在 storage.local（不上云、避免敏感 URL 同步与配额问题）。
const OVERRIDE_KEY = "manualOverrides";

function loadOverrides() {
  return new Promise((resolve) => {
    chrome.storage.local.get(OVERRIDE_KEY, (o) => resolve(o[OVERRIDE_KEY] || {}));
  });
}

function saveOverrides(map) {
  return new Promise((resolve) => chrome.storage.local.set({ [OVERRIDE_KEY]: map }, resolve));
}

// 设置/清除某 URL 的手动分类。catId 为空或 "clear" 表示清除。
async function setOverride(url, catId) {
  const map = await loadOverrides();
  const key = normalizeUrl(url);
  if (!catId || catId === "clear") delete map[key];
  else map[key] = catId;
  await saveOverrides(map);
  return map;
}

async function clearAllOverrides() {
  await saveOverrides({});
}

// 将手动调整覆盖到分类结果上，返回新的 classMap（id -> categoryId）。
//
// ⚠ 只认「仍然存在」的分类 id（hasCategoryId，不是 getCategoryById）。
//   旧写法 getCategoryById(catId) 找不到时会**回退到「其他」并照样返回真值**，于是一旦用户在设置页
//   把某个分类删掉，所有指向它的手动调整就静默把书签塞进「其他」——用户以为自己标过的分类还生效。
//   现在这种「孤儿调整」直接忽略，书签回落到正常分类结果。
//   故意**不删除**存储里的记录：用户日后点「恢复默认分类」把同名 id 加回来时，这些调整会自动复活。
async function applyOverrides(classMap, items) {
  const map = await loadOverrides();
  const out = Object.assign({}, classMap);
  for (const it of items) {
    const k = normalizeUrl(it.url);
    const catId = map[k];
    if (catId && hasCategoryId(catId)) out[it.id] = catId;
  }
  return out;
}

// 统计有多少条手动调整指向了**已被删除**的分类（扫描时提示用户）。
// 为什么单独给一个函数：忽略是静默的，而"我明明标过"的心理预期不会自己消失，
// 必须能在界面上告诉用户"有 N 条调整因为分类被删而失效了"。
async function countOrphanOverrides() {
  const map = await loadOverrides();
  let n = 0;
  for (const id of Object.values(map)) if (id && !hasCategoryId(id)) n++;
  return n;
}
